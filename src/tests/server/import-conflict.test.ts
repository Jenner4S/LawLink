/**
 * P1-1：案件批量导入触发利益冲突检索。
 *
 * 断言的是「导入路径真的跑了检索并把命中落库」，而不是重测算法本身：
 *   - 检索主体来自本案当事人（委托方 + 相对方），复用 buildIntakeConflictQueries；
 *   - 写入复用 recordMatterReviewTx（与收案转正式案件同一函数），落 ConflictCheck +
 *     ConflictHit，未命中自动 DIFFERENT、命中停 PENDING；
 *   - 检索失败整行回滚（不留「案件已建但从未检索」）；
 *   - 老库未启用动态复核时跳过但不阻断导入。
 *
 * 数据库以内存 fake 提供「历史案件当事人」行，严重度判定（BLOCKING）由真实算法计算。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    /** 冲突检索「历史案件当事人」查询要返回的行；按查询姓名过滤 */
    conflictRows: [] as Record<string, unknown>[],
    /** 检索结果写入失败（模拟真实故障，验证整行回滚） */
    conflictWriteFails: false,
    /** 数据库是否已启用 2026-09-20 收案工作流（IntakeRevision 建表） */
    workflowReady: true,
    checks: [] as { id: string; data: Record<string, unknown> }[],
    audits: [] as { action?: string; detail?: unknown }[],
    timelines: [] as Record<string, unknown>[],
    executeRawValues: [] as unknown[][],
    matterCreates: [] as Record<string, unknown>[]
  };

  const createCheck = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    if (state.conflictWriteFails) throw new Error("ConflictCheck 写入失败");
    const id = `check-${state.checks.length + 1}`;
    state.checks.push({ id, data });
    return { id };
  });

  const client = {
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "client-new" }))
  };
  const party = {
    findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      // 在办收案分支 / 模糊分支（带 NOT）不返回历史案件当事人
      if (where.intakeId || where.NOT) return [];
      const names = ((where.OR ?? []) as { name?: string }[]).map((o) => o.name).filter(Boolean);
      return state.conflictRows.filter((row) => names.includes(row.name as string));
    })
  };
  const matter = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      state.matterCreates.push(data);
      return {
        id: "matter-new",
        internalCode: "LL20260001",
        firmCaseNo: "（2026）沪0115民初1号",
        title: "王小明 与 张伟"
      };
    }),
    /** 动态复核读本案主体：委托方 + 相对方各一条（与 createOneMatter 写入的当事人一致） */
    findUniqueOrThrow: vi.fn(async () => ({
      id: "matter-new",
      category: "CIVIL_COMMERCIAL",
      serviceScope: null,
      intakeId: null,
      primaryClient: { name: "王小明", idNumber: null },
      parties: [
        { id: "p1", role: "CLIENT_PARTY", name: "王小明", idNumber: null, enterpriseSocialCode: null, standing: null, ordinal: 1 },
        { id: "p2", role: "OPPOSING_PARTY", name: "张伟", idNumber: null, enterpriseSocialCode: null, standing: null, ordinal: 1 }
      ],
      procedures: []
    }))
  };
  const conflictCheck = {
    create: createCheck,
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
      const check = state.checks.find((c) => c.id === where.id);
      if (!check) throw new Error("ConflictCheck 不存在");
      const hits = ((check.data.hits as { create?: { severity: string }[] })?.create ?? []);
      return { id: check.id, conclusion: check.data.conclusion, hits: hits.map((x) => ({ severity: x.severity })) };
    })
  };

  const tx = {
    client,
    party,
    matter,
    conflictCheck,
    intake: { findMany: vi.fn(async () => []) },
    user: { findFirst: vi.fn(async () => null) },
    causeOfAction: { findFirst: vi.fn(async () => null) },
    timelineEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => void state.timelines.push(data)) },
    auditLog: {
      create: vi.fn(async ({ data }: { data: { action?: string; detail?: unknown } }) => void state.audits.push(data))
    },
    // 标签模板：IntakeRevision 建表探针 / BillingProcedureScope 范围查询
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("IntakeRevision")) return [{ ready: state.workflowReady }];
      return [];
    }),
    // recordMatterReviewTx 以 raw UPDATE 写 matterId + subjectFingerprint
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      state.executeRawValues.push(values);
      return 1;
    })
  };

  const prisma = { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { state, tx, prisma };
});

const { state } = h;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: h.prisma }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({
    user: { id: "import-admin", role: "LAWYER", systemRole: "SUPER_ADMIN", name: "导入管理员" }
  }))
}));
vi.mock("@/lib/approvals/service", () => ({
  approvalSettings: vi.fn(async () => ({ enabled: false }))
}));
vi.mock("@/lib/default-folders", () => ({ seedDefaultFolders: vi.fn(async () => undefined) }));
vi.mock("@/server/matters/code-generator", () => ({
  generateInternalCode: vi.fn(async () => "LL20260001"),
  generateFirmCaseNo: vi.fn(async () => "（2026）沪0115民初1号")
}));
vi.mock("@/server/clients/code-generator", () => ({ generateClientCode: vi.fn(async () => "C2026001") }));

import { commitMatterImportAction } from "@/server/imports/actions";
import type { RawRow } from "@/lib/imports/matter-import";

function importRow(clientName: string, opposingName: string): RawRow {
  return {
    clientName,
    clientIdNumber: "",
    clientType: "个人",
    opposingName,
    opposingIdNumber: "",
    opposingType: "个人",
    category: "民商诉讼",
    status: "办理中",
    ownerEmail: "",
    intakeDate: "2026-01-05",
    cause: "",
    claimAmount: "",
    clientPhone: "",
    jurisdiction: "",
    caseNumber: ""
  };
}

/** 历史案件：张伟曾是我所案件的委托方；导入行的相对方也叫张伟 → 阻塞级冲突 */
function historicalClientParty(name = "张伟") {
  return {
    id: "old-party-1",
    name,
    idNumber: null,
    enterpriseSocialCode: null,
    role: "CLIENT_PARTY",
    standing: null,
    matter: {
      id: "matter-old",
      internalCode: "LL20250007",
      title: `${name} 与 某公司 合同纠纷`,
      category: "CIVIL_COMMERCIAL",
      status: "CLOSED",
      intakeDate: null,
      cause: null,
      causeFreeText: "合同纠纷",
      owner: { name: "李律师" }
    }
  };
}

beforeEach(() => {
  state.conflictRows = [];
  state.conflictWriteFails = false;
  state.workflowReady = true;
  state.checks = [];
  state.audits = [];
  state.timelines = [];
  state.executeRawValues = [];
  state.matterCreates = [];
});

describe("批量导入触发利益冲突检索（P1-1）", () => {
  it("相对方是历史案件当事人 → 写入 BLOCKING 冲突命中，结论停 PENDING", async () => {
    state.conflictRows = [historicalClientParty("张伟")];

    const res = await commitMatterImportAction({ rows: [{ rowNo: 2, raw: importRow("王小明", "张伟") }] });

    expect(res.failed).toEqual([]);
    expect(res.succeeded).toHaveLength(1);

    // ConflictCheck：一条，挂在本案上，检索主体＝委托方 + 相对方
    expect(state.checks).toHaveLength(1);
    const data = state.checks[0].data;
    const payload = data.queryPayload as { queries: { role: string; name: string }[] };
    expect(payload.queries.map((q) => [q.role, q.name])).toEqual([
      ["CLIENT_PARTY", "王小明"],
      ["OPPOSING_PARTY", "张伟"]
    ]);

    // ConflictHit：真实算法把「候选对方 × 历史委托方」判为 BLOCKING
    const hits = (data.hits as { create: Record<string, unknown>[] }).create;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      hitType: "HISTORICAL_PARTY",
      targetType: "Matter",
      targetId: "matter-old",
      matchedName: "张伟",
      matchedField: "name",
      matchedValue: "张伟",
      severity: "BLOCKING"
    });

    // 有命中不得自动给结论（导入没有前置审批可继承）
    expect(data.conclusion).toBe("PENDING");
    expect(data.decidedById).toBeNull();

    // 主体指纹随案件落库（动态复核门禁 assertMatterReviewCurrent 依赖它）
    expect(state.executeRawValues).toHaveLength(1);
    expect(state.executeRawValues[0][0]).toBe("matter-new");
    expect(String(state.executeRawValues[0][1])).toMatch(/^[0-9a-f]{64}$/);

    // 导入结果里标出命中
    expect(res.succeeded[0]).toMatchObject({
      internalCode: "LL20260001",
      conflictCheckId: "check-1",
      conflictHitCount: 1,
      conflictMaxSeverity: "BLOCKING",
      conflictConclusion: "PENDING"
    });
    expect(res.succeeded[0].conflictSummary).toContain("命中 1 条冲突");
    expect(res.conflictTotals).toEqual({ checked: 1, hitRows: 1, hitCount: 1, skipped: 0 });

    // 逐件 MATTER_CONFLICT_RUN + 顶层 MATTER_IMPORT 都写审计
    expect(state.audits.filter((a) => a.action === "MATTER_CONFLICT_RUN")).toHaveLength(1);
    const importAudit = state.audits.find((a) => a.action === "MATTER_IMPORT");
    expect(importAudit?.detail).toMatchObject({
      succeeded: 1,
      conflictChecked: 1,
      conflictHitRows: 1,
      conflictHitCount: 1,
      conflictSkipped: 0
    });
  });

  it("无冲突 → 结论自动 DIFFERENT（未命中，系统自动提示），结果标注 0 条命中", async () => {
    const res = await commitMatterImportAction({ rows: [{ rowNo: 2, raw: importRow("王小明", "赵六") }] });

    expect(res.failed).toEqual([]);
    expect(state.checks).toHaveLength(1);
    const data = state.checks[0].data;
    expect((data.hits as { create: unknown[] }).create).toHaveLength(0);
    expect(data.conclusion).toBe("DIFFERENT");
    expect(data.decidedById).toBe("import-admin");
    expect(res.succeeded[0]).toMatchObject({ conflictHitCount: 0, conflictConclusion: "DIFFERENT" });
    expect(res.succeeded[0].conflictMaxSeverity).toBeUndefined();
    expect(res.succeeded[0].conflictSummary).toContain("未命中");
    expect(res.conflictTotals).toEqual({ checked: 1, hitRows: 0, hitCount: 0, skipped: 0 });
  });

  it("导入 7 行 → ConflictCheck 落 7 条（每行一条，全部挂 matterId）", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      rowNo: i + 2,
      raw: importRow(`客户${i + 1}`, `相对方${i + 1}`)
    }));

    const res = await commitMatterImportAction({ rows });

    expect(res.failed).toEqual([]);
    expect(res.succeeded).toHaveLength(7);
    expect(state.checks).toHaveLength(7);
    expect(state.matterCreates).toHaveLength(7);
    expect(res.conflictTotals).toEqual({ checked: 7, hitRows: 0, hitCount: 0, skipped: 0 });
    // 检索失败不是静默跳过：未命中也要有结论
    expect(state.checks.every((c) => c.data.conclusion === "DIFFERENT")).toBe(true);
  });

  it("检索写入失败 → 整行回滚并报错，不留「案件已建但从未检索」", async () => {
    state.conflictWriteFails = true;

    const res = await commitMatterImportAction({ rows: [{ rowNo: 2, raw: importRow("王小明", "张伟") }] });

    expect(res.succeeded).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toContain("利益冲突检索失败");
    expect(res.failed[0].error).toContain("本行已回滚");
    expect(res.conflictTotals).toEqual({ checked: 0, hitRows: 0, hitCount: 0, skipped: 0 });
  });

  it("老库未启用动态复核 → 跳过检索但不阻断导入（结果标注 skipped）", async () => {
    state.workflowReady = false;

    const res = await commitMatterImportAction({ rows: [{ rowNo: 2, raw: importRow("王小明", "张伟") }] });

    expect(res.failed).toEqual([]);
    expect(res.succeeded).toHaveLength(1);
    expect(state.checks).toHaveLength(0);
    expect(res.succeeded[0].conflictCheckId).toBeUndefined();
    expect(res.succeeded[0].conflictHitCount).toBeUndefined();
    expect(res.conflictTotals).toEqual({ checked: 0, hitRows: 0, hitCount: 0, skipped: 1 });
  });
});
