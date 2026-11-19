// @vitest-environment node
/**
 * 隔离墙管理服务层单测（P0-3 隔离墙 · 管理 UI 批次）。
 *
 * 覆盖点：
 * - 写库前拒绝：理由不足 10 字、denials 为空、denyType 与目标 id 不匹配（缺/多都拦）、
 *   失效日期不存在或已过、案件不存在、被隔离人员不存在；
 * - 权限：非管理员非合伙人一律拒绝；被墙挡住的合伙人不能解除自己的墙；
 * - 留痕：建墙写 ETHICAL_WALL_CREATE、解除写 ETHICAL_WALL_LIFT，均与业务变更同事务；
 * - 解除语义：重复解除拒绝（不覆盖首次解除理由），条件更新防并发双击；
 * - 列表：状态由 active/expiresAt 推导（生效中 / 已过期 / 已解除），
 *   被隔离的管理者看不到该墙（系统管理员例外）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, requireSessionMock, revalidateMatterMock, auditTxMock } = vi.hoisted(() => {
  const db: Record<string, any> = {
    $transaction: vi.fn(),
    ethicalWall: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    matter: { findFirst: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
    team: { findMany: vi.fn() },
    teamMember: { findMany: vi.fn() }
  };
  return {
    db,
    requireSessionMock: vi.fn(),
    revalidateMatterMock: vi.fn(async () => {}),
    auditTxMock: vi.fn<(tx: unknown, params: Record<string, any>) => Promise<void>>()
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ requireSession: requireSessionMock }));
vi.mock("@/server/matters/route", () => ({ revalidateMatter: revalidateMatterMock }));
vi.mock("@/server/audit", () => ({ auditTx: auditTxMock, audit: vi.fn() }));

import { createEthicalWall, liftEthicalWall, listEthicalWalls } from "@/server/ethical-walls/actions";

const MATTER = "cmatterwall000000000000001";
const WALL = "cwall00000000000000000001";
const USER_A = "cuserwall00000000000000001";
const TEAM_A = "cteamwall00000000000000001";

const adminSession = {
  user: { id: "cadminwall000000000000001", role: "LAWYER", systemRole: "SUPER_ADMIN" }
};
const partnerSession = {
  user: { id: "cpartnerwall000000000001", role: "PRINCIPAL_LAWYER", systemRole: "NONE", managerAuthorized: false }
};
const lawyerSession = {
  user: { id: "clawyerwall00000000000001", role: "LAWYER", systemRole: "NONE", managerAuthorized: false }
};

const baseInput = {
  matterId: MATTER,
  reason: "本所同时为对方公司提供常年法律顾问服务，该团队不得接触本案卷宗。",
  denials: [{ denyType: "USER" as const, userId: USER_A }]
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  requireSessionMock.mockResolvedValue(adminSession);
  db.matter.findFirst.mockResolvedValue({ id: MATTER, internalCode: "LL-2026-001", title: "甲公司诉乙公司买卖合同纠纷" });
  db.user.findMany.mockResolvedValue([{ id: USER_A, name: "倪迎佳", active: true }]);
  db.team.findMany.mockResolvedValue([{ id: TEAM_A, name: "商事争议团队", active: true }]);
  db.teamMember.findMany.mockResolvedValue([]);
  db.ethicalWall.create.mockResolvedValue({ id: WALL });
  db.ethicalWall.findMany.mockResolvedValue([]);
});

describe("隔离墙 · 新建校验", () => {
  it("隔离理由不足 10 字被拒，且不写库", async () => {
    await expect(createEthicalWall({ ...baseInput, reason: "利益冲突" })).rejects.toThrow("至少 10 个字");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("没有选择任何被隔离对象被拒", async () => {
    await expect(createEthicalWall({ ...baseInput, denials: [] })).rejects.toThrow("至少选择一个被隔离对象");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("denyType=USER 但没有给 userId 被拒（缺对应 id）", async () => {
    await expect(
      createEthicalWall({ ...baseInput, denials: [{ denyType: "USER", teamId: TEAM_A }] })
    ).rejects.toThrow("按人员隔离时必须选择具体人员");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("denyType=USER 同时给了 role 被拒（多给 id）", async () => {
    await expect(
      createEthicalWall({ ...baseInput, denials: [{ denyType: "USER", userId: USER_A, role: "LAWYER" }] })
    ).rejects.toThrow("按人员隔离时不能同时指定团队或角色");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("denyType=ROLE 但没有给 role 被拒", async () => {
    await expect(createEthicalWall({ ...baseInput, denials: [{ denyType: "ROLE" }] })).rejects.toThrow(
      "按角色隔离时必须选择具体岗位"
    );
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("失效日期已过被拒", async () => {
    await expect(createEthicalWall({ ...baseInput, expiresAt: "2020-01-01" })).rejects.toThrow("必须晚于当前时间");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("案件不存在被拒", async () => {
    db.matter.findFirst.mockResolvedValue(null);
    await expect(createEthicalWall(baseInput)).rejects.toThrow("案件不存在或已删除");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("被隔离人员不存在被拒（不允许写出永不命中的隔离条目）", async () => {
    db.user.findMany.mockResolvedValue([]);
    await expect(createEthicalWall(baseInput)).rejects.toThrow("被隔离人员不存在");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });
});

describe("隔离墙 · 权限", () => {
  it("非管理员非合伙人不能建墙", async () => {
    requireSessionMock.mockResolvedValue(lawyerSession);
    await expect(createEthicalWall(baseInput)).rejects.toThrow("仅系统管理员或合伙人");
    expect(db.ethicalWall.create).not.toHaveBeenCalled();
  });

  it("非管理员非合伙人不能解除", async () => {
    requireSessionMock.mockResolvedValue(lawyerSession);
    await expect(liftEthicalWall({ id: WALL, liftReason: "事由消失" })).rejects.toThrow("仅系统管理员或合伙人");
    expect(db.ethicalWall.updateMany).not.toHaveBeenCalled();
  });

  it("合伙人（业务管理权）可以建墙", async () => {
    requireSessionMock.mockResolvedValue(partnerSession);
    await expect(createEthicalWall(baseInput)).resolves.toEqual({ id: WALL });
    expect(db.ethicalWall.create).toHaveBeenCalledTimes(1);
  });
});

describe("隔离墙 · 建墙落库与留痕", () => {
  it("denials 按类型写库并写 ETHICAL_WALL_CREATE 审计", async () => {
    await createEthicalWall({
      ...baseInput,
      expiresAt: "2099-12-31",
      denials: [
        { denyType: "USER", userId: USER_A },
        { denyType: "TEAM", teamId: TEAM_A },
        { denyType: "ROLE", role: "FINANCE" }
      ]
    });

    const createArgs = db.ethicalWall.create.mock.calls[0][0];
    expect(createArgs.data.matterId).toBe(MATTER);
    expect(createArgs.data.createdById).toBe(adminSession.user.id);
    expect(createArgs.data.denials.create).toEqual([
      { denyType: "USER", userId: USER_A, teamId: null, role: null },
      { denyType: "TEAM", userId: null, teamId: TEAM_A, role: null },
      { denyType: "ROLE", userId: null, teamId: null, role: "FINANCE" }
    ]);
    // 失效日期按上海当天 23:59:59.999 落库，与运行时区无关
    expect(createArgs.data.expiresAt.toISOString()).toBe("2099-12-31T15:59:59.999Z");

    const auditArgs = auditTxMock.mock.calls[0][1];
    expect(auditArgs).toMatchObject({
      userId: adminSession.user.id,
      action: "ETHICAL_WALL_CREATE",
      targetType: "EthicalWall",
      targetId: WALL
    });
    expect(auditArgs.detail.reason).toContain("常年法律顾问");
    expect(auditArgs.detail.denials).toEqual([
      { denyType: "USER", targetId: USER_A, targetName: "倪迎佳" },
      { denyType: "TEAM", targetId: TEAM_A, targetName: "商事争议团队" },
      { denyType: "ROLE", targetId: "FINANCE", targetName: "财务" }
    ]);
    expect(revalidateMatterMock).toHaveBeenCalledWith(MATTER);
  });

  it("同一对象重复提交只落一条隔离条目", async () => {
    await createEthicalWall({
      ...baseInput,
      denials: [
        { denyType: "USER", userId: USER_A },
        { denyType: "USER", userId: USER_A }
      ]
    });
    expect(db.ethicalWall.create.mock.calls[0][0].data.denials.create).toHaveLength(1);
  });
});

describe("隔离墙 · 解除", () => {
  const activeWall = {
    id: WALL,
    matterId: MATTER,
    active: true,
    reason: "本所同时为对方公司提供常年法律顾问服务。",
    expiresAt: null,
    matter: { internalCode: "LL-2026-001", title: "甲公司诉乙公司买卖合同纠纷" },
    denials: [{ denyType: "USER", userId: "someoneelse", teamId: null, role: null }]
  };

  it("解除写 active=false + 解除理由，并写 ETHICAL_WALL_LIFT 审计", async () => {
    db.ethicalWall.findUnique.mockResolvedValue(activeWall);
    db.ethicalWall.updateMany.mockResolvedValue({ count: 1 });

    await expect(liftEthicalWall({ id: WALL, liftReason: "对方已解除合作，隔离事由消失" })).resolves.toEqual({ id: WALL });

    const updateArgs = db.ethicalWall.updateMany.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: WALL, active: true });
    expect(updateArgs.data).toMatchObject({
      active: false,
      liftedById: adminSession.user.id,
      liftReason: "对方已解除合作，隔离事由消失"
    });
    expect(updateArgs.data.liftedAt).toBeInstanceOf(Date);

    const auditArgs = auditTxMock.mock.calls[0][1];
    expect(auditArgs).toMatchObject({ action: "ETHICAL_WALL_LIFT", targetType: "EthicalWall", targetId: WALL });
    expect(auditArgs.detail).toMatchObject({
      wallReason: activeWall.reason,
      liftReason: "对方已解除合作，隔离事由消失"
    });
    expect(revalidateMatterMock).toHaveBeenCalledWith(MATTER);
  });

  it("已解除的墙再解除被拒（避免覆盖首次解除理由）", async () => {
    db.ethicalWall.findUnique.mockResolvedValue({ ...activeWall, active: false });
    await expect(liftEthicalWall({ id: WALL, liftReason: "再解一次试试" })).rejects.toThrow("已解除");
    expect(db.ethicalWall.updateMany).not.toHaveBeenCalled();
  });

  it("并发双击时条件更新命中 0 行，第二次被拒", async () => {
    db.ethicalWall.findUnique.mockResolvedValue(activeWall);
    db.ethicalWall.updateMany.mockResolvedValue({ count: 0 });
    await expect(liftEthicalWall({ id: WALL, liftReason: "并发解除" })).rejects.toThrow("已被其他管理员解除");
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it("被该墙隔离的合伙人不能解除自己的墙，系统管理员可以", async () => {
    const selfDenied = {
      ...activeWall,
      denials: [{ denyType: "ROLE", userId: null, teamId: null, role: "PRINCIPAL_LAWYER" }]
    };
    db.ethicalWall.findUnique.mockResolvedValue(selfDenied);
    db.ethicalWall.updateMany.mockResolvedValue({ count: 1 });

    requireSessionMock.mockResolvedValue(partnerSession);
    await expect(liftEthicalWall({ id: WALL, liftReason: "自行解封" })).rejects.toThrow("涉及你本人");
    expect(db.ethicalWall.updateMany).not.toHaveBeenCalled();

    requireSessionMock.mockResolvedValue(adminSession);
    await expect(liftEthicalWall({ id: WALL, liftReason: "经合伙会议确认，由管理员解封" })).resolves.toEqual({ id: WALL });
  });
});

describe("隔离墙 · 列表", () => {
  const now = Date.now();
  const base = {
    matterId: MATTER,
    reason: "隔离理由示例文字",
    createdAt: new Date(now - 86_400_000),
    liftedAt: null,
    liftReason: null,
    createdBy: { name: "主任" },
    liftedBy: null,
    matter: { internalCode: "LL-2026-001", title: "甲公司诉乙公司买卖合同纠纷" },
    denials: [
      {
        denyType: "USER",
        userId: "someoneelse",
        teamId: null,
        role: null,
        user: { name: "倪迎佳", active: true },
        team: null
      }
    ]
  };

  it("状态由 active 与 expiresAt 推导：生效中 / 已过期 / 已解除", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      { ...base, id: "w1", active: true, expiresAt: new Date(now + 86_400_000) },
      { ...base, id: "w2", active: true, expiresAt: new Date(now - 86_400_000) },
      { ...base, id: "w3", active: false, expiresAt: null, liftedAt: new Date(now), liftedBy: { name: "主任" } }
    ]);

    const rows = await listEthicalWalls();
    expect(rows.map((row) => row.status)).toEqual(["ACTIVE", "EXPIRED", "LIFTED"]);
    expect(rows[0].matterTitle).toBe("甲公司诉乙公司买卖合同纠纷");
    // 被隔离对象解析成中文名，而不是回传 id
    expect(rows[0].targets).toEqual([
      { key: "USER:someoneelse", denyType: "USER", typeLabel: "人员", label: "倪迎佳" }
    ]);
    expect(rows[2].liftedByName).toBe("主任");
  });

  it("被墙挡住的合伙人看不到这堵墙，系统管理员能看到", async () => {
    db.ethicalWall.findMany.mockResolvedValue([
      {
        ...base,
        id: WALL,
        active: true,
        expiresAt: null,
        denials: [{ denyType: "ROLE", userId: null, teamId: null, role: "PRINCIPAL_LAWYER", user: null, team: null }]
      }
    ]);

    requireSessionMock.mockResolvedValue(partnerSession);
    expect(await listEthicalWalls()).toHaveLength(0);

    requireSessionMock.mockResolvedValue(adminSession);
    expect(await listEthicalWalls()).toHaveLength(1);
  });

  it("可按案件与生效状态过滤", async () => {
    db.ethicalWall.findMany.mockResolvedValue([]);
    await listEthicalWalls({ matterId: MATTER, active: true });
    expect(db.ethicalWall.findMany.mock.calls[0][0].where).toEqual({ matterId: MATTER, active: true });
  });
});
