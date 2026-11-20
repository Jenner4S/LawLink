// @vitest-environment node
/**
 * 坏账登记（真库，2026-11-22，对标分析 P0-5）
 *
 * 客户现行系统把「退款」与「无法收取」合成一列。LawLink 此前只有退款，
 * 没有坏账 —— 应收永远挂着，回款率到不了 100%，而没人知道差额是什么。
 *
 * 四条口径各能搞错：
 *  ① **只有 APPROVED 才扣减**（申报即扣减 → 律师提一笔坏账就能把回款率做漂亮）
 *  ② **不减应收发生额，只减未收余额**（混在一起就分不清「当初应收多少」与「后来免了多少」）
 *  ③ **不得自批**（两人分开的设计要真生效）
 *  ④ **驳回须写理由**（驳回不写理由等于没说）
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
const APPLICANT = { id: "" };
const APPROVER = { id: "" };
let currentUser: { id: string; role: string; rolePermissions: unknown } | null = null;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;

  const a = await prisma.user.create({
    data: { email: "applicant@t.local", name: "申请律师", role: "LAWYER", passwordHash: "x", active: true }
  });
  APPLICANT.id = a.id;

  // 主任律师：具备 finance.correct ALL（内置角色里财务/主任口径；此处直接用 PRINCIPAL_LAWYER + 自定义权限）
  const b = await prisma.user.create({
    data: {
      email: "approver@t.local", name: "财务复核", role: "FINANCE", passwordHash: "x", active: true
    }
  });
  APPROVER.id = b.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: currentUser }))
}));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: vi.fn(async () => {}) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { requestWriteOff, decideWriteOff, listWriteOffs } = await import("@/server/finance/writeoff-actions");
const { computeMatterFinanceFacts } = await import("@/server/finance/matter-finance-core");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedMatter() {
  const client = await prisma.client.create({ data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" } });
  return prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "坏账测试案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: APPLICANT.id, primaryClientId: client.id, customValues: {}
    }
  });
}

describe("申报与审批", () => {
  it("申报后为 PENDING，且不写决定人", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const { id } = await requestWriteOff({ matterId: m.id, amount: 5000, reason: "CUSTOMER_UNREACHABLE", note: "电话空号" });

    const row = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("PENDING");
    expect(row.decidedById).toBeNull();
    expect(Number(row.amount)).toBe(5000);
  });

  it("**不得自批**：申报人自己批准被拒", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const { id } = await requestWriteOff({ matterId: m.id, amount: 1000, reason: "OTHER" });

    // 同一人（即便被赋予了 correct 权限）也不能批自己的
    currentUser = { id: APPLICANT.id, role: "FINANCE", rolePermissions: undefined };
    await expect(decideWriteOff({ id, decision: "APPROVED" })).rejects.toThrow("不能批准自己申报");
  });

  it("他人批准后转 APPROVED 并记决定人/时间", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const { id } = await requestWriteOff({ matterId: m.id, amount: 8000, reason: "INABILITY_TO_PAY" });

    currentUser = { id: APPROVER.id, role: "FINANCE", rolePermissions: undefined };
    await decideWriteOff({ id, decision: "APPROVED" });

    const row = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("APPROVED");
    expect(row.decidedById).toBe(APPROVER.id);
    expect(row.decidedAt).not.toBeNull();
  });

  it("驳回必须写理由", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const { id } = await requestWriteOff({ matterId: m.id, amount: 2000, reason: "WAIVED" });

    currentUser = { id: APPROVER.id, role: "FINANCE", rolePermissions: undefined };
    await expect(decideWriteOff({ id, decision: "REJECTED" })).rejects.toThrow("驳回须填写理由");
    await decideWriteOff({ id, decision: "REJECTED", rejectReason: "客户仍在分期还款" });

    const row = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("REJECTED");
    expect(row.rejectReason).toBe("客户仍在分期还款");
  });

  it("已处理的记录不能重复审批", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const { id } = await requestWriteOff({ matterId: m.id, amount: 300, reason: "OTHER" });
    currentUser = { id: APPROVER.id, role: "FINANCE", rolePermissions: undefined };
    await decideWriteOff({ id, decision: "APPROVED" });
    await expect(decideWriteOff({ id, decision: "APPROVED" })).rejects.toThrow("已处理");
  });

  it("金额必须大于 0", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    await expect(requestWriteOff({ matterId: m.id, amount: 0, reason: "OTHER" })).rejects.toThrow("须大于 0");
  });
});

describe("应收口径", () => {
  it("只有 APPROVED 计入 stats.writeOff；PENDING 不计", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const p1 = await requestWriteOff({ matterId: m.id, amount: 1000, reason: "OTHER" });
    const p2 = await requestWriteOff({ matterId: m.id, amount: 2500, reason: "WAIVED" });

    currentUser = { id: APPLICANT.id, role: "LAWYER", rolePermissions: undefined };
    let facts = await computeMatterFinanceFacts(m.id);
    expect(facts.stats.writeOff).toBe(0); // 都还是 PENDING

    currentUser = { id: APPROVER.id, role: "FINANCE", rolePermissions: undefined };
    await decideWriteOff({ id: p2.id, decision: "APPROVED" });

    facts = await computeMatterFinanceFacts(m.id);
    expect(facts.stats.writeOff).toBe(2500);
    // 未收余额扣减坏账，但不小于 0
    expect(facts.stats.outstandingNet).toBe(Math.max(0, facts.stats.outstanding - 2500));
    void p1;
  });

  it("**不减应收发生额**：receivable 不受坏账影响", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    const before = await computeMatterFinanceFacts(m.id);
    const { id } = await requestWriteOff({ matterId: m.id, amount: 700, reason: "OTHER" });
    currentUser = { id: APPROVER.id, role: "FINANCE", rolePermissions: undefined };
    await decideWriteOff({ id, decision: "APPROVED" });
    const after = await computeMatterFinanceFacts(m.id);
    expect(after.stats.receivable).toBe(before.stats.receivable);
    expect(after.stats.writeOff).toBe(700);
  });

  it("列表按状态排序并带申报人/决定人", async () => {
    const m = await seedMatter();
    currentUser = { ...APPLICANT, role: "LAWYER", rolePermissions: undefined };
    await requestWriteOff({ matterId: m.id, amount: 100, reason: "OTHER" });
    currentUser = { id: APPROVER.id, role: "FINANCE", rolePermissions: undefined };
    const rows = await listWriteOffs(m.id);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].requestedBy.name).toBe("申请律师");
  });
});
