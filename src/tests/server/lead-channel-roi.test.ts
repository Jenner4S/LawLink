// @vitest-environment node
/**
 * 渠道单位成本（真库，2026-11-22）
 *
 * 客户做那张表的初衷是**决定钱往哪投**。有了券金额字段还不够，
 * 得能回答「这个渠道一条线索花多少钱、成一单花多少钱」。
 *
 * 四条口径：
 *  ① **只做成本，不做 ROI 比率**：收入侧没有可信数据，
 *     把成交金额混进渠道口径会把"线索质量"和"客单价"搅在一起
 *  ② **分母 0 → null（显示「—」）**，不是 Infinity 也不是 0
 *  ③ **券金额 0 → null**：0 成本会被误读成"这个渠道不花钱"，
 *     而真相往往是"还没录金额"——比不显示更危险
 *  ④ 只统计期间新增线索（与漏斗同口径，不能拿历史成交除本期成本）
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

const NAME = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "roi@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));

const { getLeadFunnel } = await import("@/server/leads/analytics");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const period = () => ({ start: new Date(Date.now() - 3600_000), end: new Date(Date.now() + 3600_000) });

async function seedChannelAndLeads(count: number, visitedCount: number, convertedCount: number, voucherEach: number) {
  const parent = await prisma.leadChannel.create({ data: { name: uid("投放"), kind: "PAID", sort: 1 } });
  const channel = await prisma.leadChannel.create({ data: { name: uid("平台"), parentId: parent.id, kind: "PAID" } });
  const leads = [];
  for (let i = 0; i < count; i++) {
    const converted = i < convertedCount;
    const visited = i < visitedCount;
    leads.push(
      await prisma.lead.create({
        data: {
          name: uid("线索"),
          phone: `1390000${String(1000 + i)}`,
          ownerId: STAFF.id,
          channelId: channel.id,
          voucherAmount: voucherEach,
          visitOutcome: visited ? "ARRIVED" : "PENDING",
          stage: converted ? "CONVERTED" : "LEAD",
          convertedAt: converted ? new Date() : null,
          createdAt: new Date(),
          updatedAt: new Date()
        }
      })
    );
  }
  return { channel, leads };
}

describe("渠道单位成本", () => {
  it("每条券 900 × 3 条 → 渠道合计 2700：单线索 900、单到店 1350、单成交 2700", async () => {
    // 口径澄清：voucherAmount 是**每条线索的券金额**，渠道合计按条累加。
    // 第一版我把 seed 的 900 当成"渠道总成本"，期望 300/900，跑出来是 900/2700 ——
    // 实际行为才是对的，是测试的假设错了。
    const { channel } = await seedChannelAndLeads(3, 2, 1, 900);
    const f = await getLeadFunnel(period());
    const row = f.byChannel.find((r) => r.key === channel.id)!;
    expect(row.total).toBe(3);
    expect(row.voucherAmount).toBe(2700);
    expect(row.costPerLead).toBe(900);
    expect(row.costPerVisit).toBe(1350);
    expect(row.costPerConverted).toBe(2700);
  });

  it("**分母为 0 → null（显示「—」）**，不是 Infinity 也不是 0", async () => {
    const { channel } = await seedChannelAndLeads(2, 0, 0, 500);
    const f = await getLeadFunnel(period());
    const row = f.byChannel.find((r) => r.key === channel.id)!;
    expect(row.costPerConverted).toBeNull();
    expect(row.costPerVisit).toBeNull();
    // 每条 500 × 2 条 = 1000；线索数非 0，故单线索成本有值 1000/2 = 500
    expect(row.costPerLead).toBe(500);
  });

  it("**券金额为 0 → 三项全 null**（0 成本会被误读成「不花钱」）", async () => {
    const { channel } = await seedChannelAndLeads(4, 4, 2, 0);
    const f = await getLeadFunnel(period());
    const row = f.byChannel.find((r) => r.key === channel.id)!;
    expect(row.voucherAmount).toBe(0);
    expect(row.costPerLead).toBeNull();
    expect(row.costPerVisit).toBeNull();
    expect(row.costPerConverted).toBeNull();
  });

  it("期间外的线索不计入（不能拿历史成交除本期成本）", async () => {
    const parent = await prisma.leadChannel.create({ data: { name: uid("旧投放"), kind: "PAID" } });
    const channel = await prisma.leadChannel.create({ data: { name: uid("旧平台"), parentId: parent.id, kind: "PAID" } });
    const old = new Date("2020-01-01T10:00:00+08:00");
    for (let i = 0; i < 5; i++) {
      await prisma.lead.create({
        data: {
          name: uid("旧线索"), phone: `1380000${String(2000 + i)}`, ownerId: STAFF.id,
          channelId: channel.id, voucherAmount: 1000, stage: "CONVERTED",
          convertedAt: old, createdAt: old, updatedAt: old
        }
      });
    }
    const f = await getLeadFunnel(period());
    const row = f.byChannel.find((r) => r.key === channel.id);
    // 期间内 0 条 → 该渠道不出现在本期聚合里
    expect(row).toBeUndefined();
  });
});
