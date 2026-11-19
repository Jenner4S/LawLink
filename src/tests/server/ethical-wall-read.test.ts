// @vitest-environment node
/**
 * 隔离墙读取摘要单测（P0-3 ⑤ 案件详情标注）。
 *
 * 被测对象：`getWallSummaryForMatter` —— 给「能看这个案子的人」看的知情摘要。
 * 与 `ethical-wall-actions.test.ts`（维护侧：建/解/列表）互补，这里只管读取口径。
 *
 * 覆盖点：
 * - 无墙 → hasWall=false，四字段全空，且不返回残留数据；
 * - 有墙 → 理由与「被隔离对象」中文描述正确，且**输出里不含任何 id**（userId/teamId 都不选不返）；
 * - 已解除（active=false）→ 不统计（即使数据库误返回该行，JS 侧同口径复核也会剔掉）；
 * - 已过期（expiresAt 早于或恰好等于判定时刻）→ 不统计；
 * - 多堵墙 → 理由去重、受限对象合并去重、wallCount 如实计数；
 * - 空 denials 的墙（数据异常）→ 仍计为一堵生效墙，但受限对象为空（不假装「没人受限」也不隐藏记录）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db } = vi.hoisted(() => {
  const db: Record<string, any> = {
    ethicalWall: { findMany: vi.fn() }
  };
  return { db };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));

import { getWallSummaryForMatter } from "@/server/ethical-walls/read";

const MATTER = "cmatterwallread000000000001";
const USER_ID = "cuserli0000000000000000001";
const TEAM_ID = "cteamshangshi00000000000001";
/** 固定判定时刻：过期边界（expiresAt 恰好等于 now）必须每次都落在同一侧 */
const NOW = new Date("2026-11-19T08:00:00.000+08:00");
const REASON = "本所同时为对方公司提供常年法律顾问服务，该团队不得接触本案卷宗。";

/** 造一条隔离墙行：默认生效中、永久有效、无人被挡 */
function wall(overrides: Record<string, unknown> = {}) {
  return {
    reason: REASON,
    active: true,
    expiresAt: null,
    denials: [],
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  db.ethicalWall.findMany.mockResolvedValue([]);
});

describe("隔离墙摘要 · 无墙", () => {
  it("没有任何隔离墙 → hasWall 为 false，四字段为空", async () => {
    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary).toEqual({ hasWall: false, wallCount: 0, reasons: [], deniedSummary: [] });
    expect(db.ethicalWall.findMany).toHaveBeenCalledTimes(1);
  });

  it("查询条件只取生效中的墙：active=true 且（无有效期 或 晚于判定时刻）", async () => {
    await getWallSummaryForMatter(MATTER, { now: NOW });

    const args = db.ethicalWall.findMany.mock.calls[0][0];
    expect(args.where.matterId).toBe(MATTER);
    expect(args.where.active).toBe(true);
    expect(args.where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: NOW } }]);
  });

  it("空 matterId 直接返回空摘要，不查库（防止页面误传空串扫全表）", async () => {
    const summary = await getWallSummaryForMatter("", { now: NOW });

    expect(summary.hasWall).toBe(false);
    expect(db.ethicalWall.findMany).not.toHaveBeenCalled();
  });
});

describe("隔离墙摘要 · 有墙", () => {
  it("人员 + 团队 + 岗位三类对象都转成中文描述，且输出不含任何 id", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({
        denials: [
          { denyType: "USER", role: null, userId: USER_ID, user: { name: "李东豪", active: true }, team: null },
          { denyType: "TEAM", role: null, teamId: TEAM_ID, user: null, team: { name: "商事争议团队", active: true } },
          { denyType: "ROLE", role: "LAWYER", userId: null, teamId: null, user: null, team: null }
        ]
      })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.hasWall).toBe(true);
    expect(summary.wallCount).toBe(1);
    expect(summary.reasons).toEqual([REASON]);
    expect(summary.deniedSummary).toEqual(["李东豪", "商事争议团队（团队）", "全所「授薪律师」"]);

    // 信息面：id 一个都不能出现在返回值里（前端不需要，也不给人肉抄走的线索）
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(USER_ID);
    expect(serialized).not.toContain(TEAM_ID);
  });

  it("select 里根本不选 userId / teamId —— 少给字段比「选了再删」可靠", async () => {
    await getWallSummaryForMatter(MATTER, { now: NOW });

    const select = db.ethicalWall.findMany.mock.calls[0][0].select;
    expect(select.denials.select).not.toHaveProperty("userId");
    expect(select.denials.select).not.toHaveProperty("teamId");
    expect(select.denials.select).not.toHaveProperty("id");
    expect(select).not.toHaveProperty("id");
  });

  it("停用的账号与停用的团队在摘要里带出状态说明", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({
        denials: [
          { denyType: "USER", role: null, userId: USER_ID, user: { name: "倪迎佳", active: false }, team: null },
          { denyType: "TEAM", role: null, teamId: TEAM_ID, user: null, team: { name: "旧团队", active: false } }
        ]
      })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.deniedSummary).toEqual(["倪迎佳（账号停用）", "旧团队（团队停用）"]);
  });
});

describe("隔离墙摘要 · 失效的墙不统计", () => {
  it("已解除（active=false）→ hasWall 为 false（JS 侧与 SQL 条件同口径复核）", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({ active: false, denials: [{ denyType: "USER", role: null, user: { name: "李东豪", active: true } }] })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary).toEqual({ hasWall: false, wallCount: 0, reasons: [], deniedSummary: [] });
  });

  it("已过期（expiresAt 早于判定时刻）→ 不统计", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({ expiresAt: new Date(NOW.getTime() - 1), denials: [{ denyType: "USER", role: null, user: { name: "李东豪", active: true } }] })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.hasWall).toBe(false);
  });

  it("边界：expiresAt 恰好等于判定时刻 → 视为已过期（gt 严格比较，与 SQL 同侧）", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({ expiresAt: new Date(NOW.getTime()), denials: [{ denyType: "USER", role: null, user: { name: "李东豪", active: true } }] })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.hasWall).toBe(false);
  });

  it("未过期的墙（expiresAt 晚于判定时刻）→ 正常统计", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({ expiresAt: new Date(NOW.getTime() + 1), denials: [{ denyType: "USER", role: null, user: { name: "李东豪", active: true } }] })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.hasWall).toBe(true);
    expect(summary.deniedSummary).toEqual(["李东豪"]);
  });
});

describe("隔离墙摘要 · 多堵墙合并", () => {
  it("两堵墙：理由去重、受限对象合并去重、wallCount 如实计数", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({
        reason: REASON,
        denials: [{ denyType: "USER", role: null, user: { name: "李东豪", active: true } }]
      }),
      wall({
        reason: REASON,
        denials: [
          { denyType: "USER", role: null, user: { name: "李东豪", active: true } },
          { denyType: "ROLE", role: "ASSISTANT", user: null, team: null }
        ]
      })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.hasWall).toBe(true);
    expect(summary.wallCount).toBe(2);
    expect(summary.reasons).toEqual([REASON]);
    expect(summary.deniedSummary).toEqual(["李东豪", "全所「律师助理」"]);
  });

  it("两堵墙理由不同 → 两条都返回（页面展示首条 + 「另有 N 条」）", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      wall({ reason: "同一团队代理对方公司，需隔离。" }),
      wall({ reason: "本所顾问单位与本案对方为关联方。" })
    ]);

    const summary = await getWallSummaryForMatter(MATTER, { now: NOW });

    expect(summary.wallCount).toBe(2);
    expect(summary.reasons).toEqual(["同一团队代理对方公司，需隔离。", "本所顾问单位与本案对方为关联方。"]);
    // 没有 denials 的墙不挡人，但仍是生效记录 → 受限对象为空
    expect(summary.deniedSummary).toEqual([]);
  });
});
