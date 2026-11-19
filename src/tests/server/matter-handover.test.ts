// @vitest-environment node
/**
 * 主办移交单测（MatterHandover）。
 *
 * 覆盖 `src/server/matters/handover.ts` 三条写路径——发起（requestHandoverTx）、
 * 确认/退回（decideHandoverTx）、刷新清单（refreshHandoverTx）——的业务防线：
 * - 发起：目标非在职 / 目标即当前主办 / 同一案件已有待接收单 / 非主办且无应急权限 /
 *   归档案件 / 理由必填，全部拒绝；
 * - 确认：只有接收人可确认；已取消或已处理的单不可再确认；固定清单指纹变化须先刷新；
 * - 成功确认后：Matter.ownerId 换人、原主办 LEAD→CO_LEAD、新主办 LEAD、程序与保全责任同步；
 * - 退回：发起人或接收人填写原因后 CANCELLED，主办不变；
 * - 每次状态变化都写审计（MATTER_HANDOVER_REQUEST / _ACCEPTED / _CANCELLED / _REFRESH /
 *   MATTER_EMERGENCY_TRANSFER），并通知对端。
 *
 * 权限解析（resolveRoleUser / scopeFor）与提醒台账按模块打桩，其余（含指纹算法、
 * 责任人在职校验、子表同步）走真实实现——mock 只替换事务外的边界，不替换被验证的逻辑。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  roles: {} as Record<string, { role: string; enabled: boolean; rolePermissions?: { permissionKey: string; scope: string }[] }>,
  audit: vi.fn(),
  ready: true
}));

vi.mock("@/lib/roles/service", () => ({
  resolveRoleUser: async (userId: string) =>
    h.roles[userId] ?? { role: "LAWYER", enabled: true }
}));
vi.mock("@/lib/roles/catalog", () => ({
  scopeFor: (user: { rolePermissions?: { permissionKey: string; scope: string }[] }, key: string) =>
    user?.rolePermissions?.find((p) => p.permissionKey === key)?.scope
}));
vi.mock("@/server/reminders/responsibility", () => ({
  responsibilityReady: async () => h.ready,
  readWorkRows: async () => []
}));
vi.mock("@/server/reminders/schedule", () => ({ retireScheduleReminders: async () => null }));
vi.mock("@/server/audit", () => ({ auditTx: (...args: unknown[]) => h.audit(...args) }));

import { requestHandoverTx, decideHandoverTx, refreshHandoverTx } from "@/server/matters/handover";

const MATTER = "cmatter00000000000000001";
const OWNER = "cowner000000000000000001";
const RECEIVER = "creceiver000000000000001";
const THIRD = "cthird0000000000000000001";
const INACTIVE = "cinactive000000000000001";
const TRANSFER_HOLDER = "ctransfer000000000000001";
const NO_GRANT_CUSTOM = "cnogrant0000000000000001";

type Ctx = ReturnType<typeof makeCtx>;

function makeCtx(overrides: {
  status?: string;
  deletedAt?: Date | null;
  users?: Record<string, { id: string; active: boolean; role: string }>;
} = {}) {
  const state = {
    matter: {
      id: MATTER,
      title: "借款合同纠纷",
      ownerId: OWNER,
      status: overrides.status ?? "ACTIVE",
      deletedAt: overrides.deletedAt ?? null
    },
    users: overrides.users ?? {
      [OWNER]: { id: OWNER, active: true, role: "LAWYER" },
      [RECEIVER]: { id: RECEIVER, active: true, role: "LAWYER" },
      [THIRD]: { id: THIRD, active: true, role: "LAWYER" },
      [INACTIVE]: { id: INACTIVE, active: false, role: "LAWYER" },
      [TRANSFER_HOLDER]: { id: TRANSFER_HOLDER, active: true, role: "CUSTOM" },
      [NO_GRANT_CUSTOM]: { id: NO_GRANT_CUSTOM, active: true, role: "CUSTOM" }
    },
    pending: 0,
    handover: null as null | {
      id: string; matterId: string; fromUserId: string; toUserId: string; initiatedById: string;
      emergency: boolean; reason: string; fingerprint: string; status: string; revision: number;
    },
    ownerHistory: [] as { from: string; to: string }[],
    memberUpdates: [] as unknown[],
    memberUpserts: [] as unknown[],
    procedureUpdates: [] as unknown[],
    preservationUpdates: [] as unknown[],
    notifications: [] as unknown[],
    execs: [] as { sql: string; values: unknown[] }[]
  };

  const db = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?");
      if (sql.includes("pg_advisory_xact_lock")) return [{ locked: 1 }];
      if (sql.includes("COUNT(*)") && sql.includes('"MatterHandover"')) return [{ count: BigInt(state.pending) }];
      if (sql.includes('SELECT * FROM "MatterHandover"')) return state.handover ? [{ ...state.handover }] : [];
      return values.length ? [] : [];
    }),
    $executeRaw: vi.fn(async (first: TemplateStringsArray | unknown, ...rest: unknown[]) => {
      const strings = first as TemplateStringsArray;
      const values = rest;
      const sql = Array.isArray(strings) ? strings.join("?") : String(first);
      state.execs.push({ sql, values });
      if (sql.includes('INSERT INTO "MatterHandover"')) {
        const [id, matterId, fromUserId, toUserId, initiatedById, emergency, reason, , fingerprint] = values as string[];
        state.handover = {
          id, matterId, fromUserId, toUserId, initiatedById,
          emergency: Boolean(emergency), reason, fingerprint,
          status: "PENDING", revision: 0
        };
      }
      if (sql.includes('SET status=')) {
        const [status] = values as string[];
        if (state.handover) state.handover.status = status;
      }
      return 1;
    }),
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => state.users[where.id] ?? null)
    },
    matter: {
      findUniqueOrThrow: vi.fn(async () => ({ ...state.matter })),
      update: vi.fn(async ({ where, data }: { where: { id: string; ownerId?: string }; data: { ownerId: string } }) => {
        if (where.id !== state.matter.id) throw new Error("P2025 记录不存在");
        if (where.ownerId && where.ownerId !== state.matter.ownerId) throw new Error("P2025 主办已变化");
        state.ownerHistory.push({ from: state.matter.ownerId, to: data.ownerId });
        state.matter.ownerId = data.ownerId;
        return { ...state.matter };
      })
    },
    matterMember: {
      updateMany: vi.fn(async (args: unknown) => { state.memberUpdates.push(args); return { count: 1 }; }),
      upsert: vi.fn(async (args: unknown) => { state.memberUpserts.push(args); return {}; })
    },
    matterProcedure: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (args: unknown) => { state.procedureUpdates.push(args); return { count: 1 }; })
    },
    preservationCase: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (args: unknown) => { state.preservationUpdates.push(args); return { count: 1 }; })
    },
    feeEntry: { findMany: vi.fn(async () => []) },
    invoiceRequest: { findMany: vi.fn(async () => []) },
    sealRequest: { findMany: vi.fn(async () => []) },
    notification: { create: vi.fn(async (args: { data: Record<string, unknown> }) => { state.notifications.push(args.data); return {}; }) }
  };

  return { db: db as never as Parameters<typeof requestHandoverTx>[0], raw: db, state };
}

/** 发起一张待接收单，返回单据 id 与发起时指纹。 */
async function openHandover(ctx: Ctx, overrides: { toUserId?: string; reason?: string } = {}) {
  const result = await requestHandoverTx(ctx.db, OWNER, {
    matterId: MATTER,
    toUserId: overrides.toUserId ?? RECEIVER,
    reason: overrides.reason ?? "主办调岗，移交承办"
  });
  return result;
}

beforeEach(() => {
  h.roles = {
    [OWNER]: { role: "LAWYER", enabled: true },
    [RECEIVER]: { role: "LAWYER", enabled: true },
    [THIRD]: { role: "LAWYER", enabled: true },
    [INACTIVE]: { role: "LAWYER", enabled: true },
    [TRANSFER_HOLDER]: { role: "CUSTOM", enabled: true, rolePermissions: [{ permissionKey: "matters.transfer", scope: "ALL" }] },
    [NO_GRANT_CUSTOM]: { role: "CUSTOM", enabled: true, rolePermissions: [] }
  };
  h.audit.mockReset();
  h.ready = true;
});

describe("发起移交", () => {
  it("成功发起：写 PENDING 单、原主办不变、审计与通知落地", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);

    expect(ctx.state.handover).toMatchObject({
      matterId: MATTER,
      fromUserId: OWNER,
      toUserId: RECEIVER,
      initiatedById: OWNER,
      emergency: false,
      status: "PENDING"
    });
    expect(ctx.state.handover!.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    // 接收前责任仍在原主办：不得提前改负责人
    expect(ctx.state.matter.ownerId).toBe(OWNER);
    expect(ctx.state.ownerHistory).toEqual([]);

    expect(h.audit).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      userId: OWNER,
      action: "MATTER_HANDOVER_REQUEST",
      targetType: "MatterHandover",
      targetId: id,
      detail: expect.objectContaining({ matterId: MATTER, fromUserId: OWNER, toUserId: RECEIVER })
    }));
    expect(ctx.state.notifications).toEqual([
      expect.objectContaining({ userId: RECEIVER, priority: "URGENT", refType: "MatterHandover", refId: id })
    ]);
  });

  it("目标账号已停用：拒绝，且不产生移交单", async () => {
    const ctx = makeCtx();
    await expect(openHandover(ctx, { toUserId: INACTIVE }))
      .rejects.toThrow(/停用|不存在/);
    expect(ctx.state.handover).toBeNull();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("目标是当前主办：拒绝", async () => {
    const ctx = makeCtx();
    await expect(openHandover(ctx, { toUserId: OWNER })).rejects.toThrow(/已经是本案主办/);
    expect(ctx.state.handover).toBeNull();
  });

  it("同一案件已有待接收单：拒绝并发第二张", async () => {
    const ctx = makeCtx();
    await openHandover(ctx);
    ctx.state.pending = 1;
    await expect(openHandover(ctx, { toUserId: THIRD })).rejects.toThrow(/已有待接收交接/);
  });

  it("非当前主办且无应急接管权限：拒绝代为发起", async () => {
    const ctx = makeCtx();
    await expect(
      requestHandoverTx(ctx.db, THIRD, { matterId: MATTER, toUserId: RECEIVER, reason: "代为移交" })
    ).rejects.toThrow(/只能由当前主办发起/);
    expect(ctx.state.handover).toBeNull();
  });

  it("理由为空：zod 拒绝（原因必须留痕）", async () => {
    const ctx = makeCtx();
    await expect(openHandover(ctx, { reason: "   " })).rejects.toThrow(/请填写交接原因/);
    expect(ctx.state.handover).toBeNull();
  });

  it("归档或删除案件：拒绝更换主办", async () => {
    const archived = makeCtx({ status: "ARCHIVED" });
    await expect(openHandover(archived)).rejects.toThrow(/归档或删除案件不可更换主办/);
    const deleted = makeCtx({ deletedAt: new Date() });
    await expect(openHandover(deleted)).rejects.toThrow(/归档或删除案件不可更换主办/);
  });

  it("应急接管须独立的全所责任交接权限；持权人可立即明确新责任", async () => {
    const noGrant = makeCtx();
    await expect(
      requestHandoverTx(noGrant.db, NO_GRANT_CUSTOM, { matterId: MATTER, toUserId: RECEIVER, emergency: true, reason: "停用接管" })
    ).rejects.toThrow(/应急接管须独立/);

    const holder = makeCtx();
    await requestHandoverTx(holder.db, TRANSFER_HOLDER, {
      matterId: MATTER, toUserId: RECEIVER, emergency: true, reason: "原主办账号停用，防止期限无人负责"
    });
    expect(holder.state.matter.ownerId).toBe(RECEIVER);
    expect(holder.state.handover).toMatchObject({ emergency: true, fromUserId: OWNER, toUserId: RECEIVER });
    expect(h.audit).toHaveBeenCalledWith(holder.db, expect.objectContaining({ action: "MATTER_EMERGENCY_TRANSFER" }));
  });
});

describe("确认移交", () => {
  it("非接收人确认：拒绝", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    await expect(decideHandoverTx(ctx.db, THIRD, id, 0, "ACCEPTED", "我是第三方"))
      .rejects.toThrow(/只能由接收人确认/);
    expect(ctx.state.matter.ownerId).toBe(OWNER);
  });

  it("成功确认：主办换人、原主办转 CO_LEAD、新主办 LEAD、程序与保全责任同步", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    await decideHandoverTx(ctx.db, RECEIVER, id, 0, "ACCEPTED", "已核对交接清单");

    expect(ctx.state.ownerHistory).toEqual([{ from: OWNER, to: RECEIVER }]);
    expect(ctx.state.matter.ownerId).toBe(RECEIVER);
    expect(ctx.state.memberUpdates).toEqual([
      { where: { matterId: MATTER, userId: OWNER, role: "LEAD" }, data: { role: "CO_LEAD" } }
    ]);
    expect(ctx.state.memberUpserts).toEqual([
      {
        where: { matterId_userId: { matterId: MATTER, userId: RECEIVER } },
        create: { matterId: MATTER, userId: RECEIVER, role: "LEAD" },
        update: { role: "LEAD" }
      }
    ]);
    expect(ctx.state.procedureUpdates).toEqual([
      { where: { matterId: MATTER, leadLawyerId: OWNER, status: { not: "CONCLUDED" } }, data: { leadLawyerId: RECEIVER } }
    ]);
    expect(ctx.state.preservationUpdates).toEqual([
      { where: { matterId: MATTER, ownerId: OWNER, status: { in: ["ACTIVE", "RENEWED"] } }, data: { ownerId: RECEIVER } }
    ]);
    expect(ctx.state.handover!.status).toBe("ACCEPTED");
    expect(h.audit).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      userId: RECEIVER, action: "MATTER_HANDOVER_ACCEPTED", targetId: id
    }));
    expect(ctx.state.notifications).toContainEqual(
      expect.objectContaining({ userId: OWNER, title: "案件交接已确认" })
    );
  });

  it("固定清单已变化（指纹不符）：拒绝并要求先刷新", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    ctx.state.matter.title = "借款合同纠纷（新增反诉）"; // 请求后案件实质信息变化
    await expect(decideHandoverTx(ctx.db, RECEIVER, id, 0, "ACCEPTED", "按旧清单承接"))
      .rejects.toThrow(/清单已变化/);
    expect(ctx.state.matter.ownerId).toBe(OWNER);

    // 发起人刷新后，同一张单可以正常承接
    await refreshHandoverTx(ctx.db, OWNER, id, 0);
    expect(h.audit).toHaveBeenCalledWith(ctx.db, expect.objectContaining({ action: "MATTER_HANDOVER_REFRESH" }));
    expect(ctx.state.execs.some((e) => e.sql.includes("SET snapshot="))).toBe(true);
  });

  it("已取消的单不可再确认", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    await decideHandoverTx(ctx.db, OWNER, id, 0, "CANCELLED", "计划调整，撤销移交");
    expect(ctx.state.handover!.status).toBe("CANCELLED");
    await expect(decideHandoverTx(ctx.db, RECEIVER, id, 0, "ACCEPTED", "我同意"))
      .rejects.toThrow(/已处理或发生变化/);
    expect(ctx.state.matter.ownerId).toBe(OWNER);
  });
});

describe("退回 / 取消移交", () => {
  it("发起人填写原因后取消：状态 CANCELLED，主办不变，写审计", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    await decideHandoverTx(ctx.db, OWNER, id, 0, "CANCELLED", "计划调整，撤销移交");

    expect(ctx.state.handover!.status).toBe("CANCELLED");
    expect(ctx.state.matter.ownerId).toBe(OWNER);
    expect(ctx.state.ownerHistory).toEqual([]);
    expect(h.audit).toHaveBeenCalledWith(ctx.db, expect.objectContaining({
      userId: OWNER, action: "MATTER_HANDOVER_CANCELLED", targetId: id
    }));
    expect(ctx.state.notifications).toContainEqual(
      expect.objectContaining({ userId: OWNER, title: "案件交接已退回" })
    );
  });

  it("取消不填原因，或由无关人员取消：拒绝", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    await expect(decideHandoverTx(ctx.db, OWNER, id, 0, "CANCELLED", "  "))
      .rejects.toThrow(/请填写撤销或退回原因/);
    await expect(decideHandoverTx(ctx.db, THIRD, id, 0, "CANCELLED", "我来撤回"))
      .rejects.toThrow(/仅发起人或接收人/);
    expect(ctx.state.handover!.status).toBe("PENDING");
  });

  it("仅发起人可刷新清单", async () => {
    const ctx = makeCtx();
    const { id } = await openHandover(ctx);
    await expect(refreshHandoverTx(ctx.db, RECEIVER, id, 0)).rejects.toThrow(/仅发起人可更新交接清单/);
  });
});
