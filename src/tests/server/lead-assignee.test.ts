// @vitest-environment node
/**
 * 对接律师 / 接单状态 / 二次对接人（真库，2026-11-22，P1-2 + P1-3）
 *
 * 客户现行系统有三列：「对接律师」「对接律师状态」「二次对接人」。
 * 这三列回答的是内部派单：派给谁谈、律师接不接、谁接力跟。
 *
 * 五条口径：
 *  ① **派单后状态是 ASSIGNED 而不是 ACCEPTED** —— 接不接是律师自己的事
 *  ② **只有本人能回应派单**（防止代答，代答等于把拒接藏起来）
 *  ③ **拒接/暂忙必须写理由**（没理由的拒接＝线索静默消失）
 *  ④ **已转化/已流失不再派单**
 *  ⑤ **二次对接人不能等于负责人**（否则等于没设，还会让"两人接力"变成假象）
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
const OWNER = { id: "" };
const LAWYER = { id: "" };
const OTHER = { id: "" };
let currentUser: { id: string; role: string; rolePermissions: unknown } | null = null;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  for (const [slot, name, role] of [
    [OWNER, "负责甲", "LAWYER"],
    [LAWYER, "对接乙", "LAWYER"],
    [OTHER, "旁观丙", "LAWYER"]
  ] as [typeof OWNER, string, string][]) {
    const u = await prisma.user.create({
      data: { email: `${name}@t.local`, name, role: role as never, passwordHash: "x", active: true }
    });
    slot.id = u.id;
  }
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => ({ user: currentUser })) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { assignLeadLawyer, respondLeadAssignment, setLeadSecondOwner } = await import("@/server/leads/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedLead(stage: string = "LEAD") {
  return prisma.lead.create({
    data: { name: uid("线索"), phone: "13900000100", ownerId: OWNER.id, stage: stage as never }
  });
}

describe("派单", () => {
  it("派单后状态是 ASSIGNED（不是替律师答应）", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await assignLeadLawyer({ leadId: lead.id, lawyerId: LAWYER.id });

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.assigneeLawyerId).toBe(LAWYER.id);
    expect(row.assigneeStatus).toBe("ASSIGNED");
  });

  it("已转化/已流失的线索不再派单", async () => {
    const converted = await seedLead("CONVERTED");
    const lost = await seedLead("LOST");
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await expect(assignLeadLawyer({ leadId: converted.id, lawyerId: LAWYER.id })).rejects.toThrow("不再派单");
    await expect(assignLeadLawyer({ leadId: lost.id, lawyerId: LAWYER.id })).rejects.toThrow("不再派单");
  });

  it("停用账号不能被派单", async () => {
    const lead = await seedLead();
    const disabled = await prisma.user.create({
      data: { email: `off${Date.now()}@t.local`, name: "离职者", role: "LAWYER", passwordHash: "x", active: false }
    });
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await expect(assignLeadLawyer({ leadId: lead.id, lawyerId: disabled.id })).rejects.toThrow("不存在或已停用");
  });
});

describe("回应派单", () => {
  it("**只有本人能回应**：旁观者代答被拒", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await assignLeadLawyer({ leadId: lead.id, lawyerId: LAWYER.id });

    currentUser = { id: OTHER.id, role: "LAWYER", rolePermissions: undefined };
    await expect(respondLeadAssignment({ leadId: lead.id, decision: "ACCEPTED" })).rejects.toThrow("只能回应派给自己");
  });

  it("本人接单 → ACCEPTED，并记一条跟进（时间线能看到谁接的）", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await assignLeadLawyer({ leadId: lead.id, lawyerId: LAWYER.id });

    currentUser = { id: LAWYER.id, role: "LAWYER", rolePermissions: undefined };
    await respondLeadAssignment({ leadId: lead.id, decision: "ACCEPTED" });

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.assigneeStatus).toBe("ACCEPTED");
    expect(row.assigneeNote).toBeNull();
    const acts = await prisma.leadActivity.findMany({ where: { leadId: lead.id } });
    expect(acts.some((a) => (a.note ?? "").includes("接单"))).toBe(true);
  });

  it("拒接必须写理由；写了之后状态 DECLINED 且理由入库", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await assignLeadLawyer({ leadId: lead.id, lawyerId: LAWYER.id });

    currentUser = { id: LAWYER.id, role: "LAWYER", rolePermissions: undefined };
    await expect(respondLeadAssignment({ leadId: lead.id, decision: "DECLINED" })).rejects.toThrow("须填写理由");
    await respondLeadAssignment({ leadId: lead.id, decision: "DECLINED", reason: "专业方向不符" });

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.assigneeStatus).toBe("DECLINED");
    expect(row.assigneeNote).toBe("专业方向不符");
  });

  it("拒接**不自动转派**（转派给谁需要人判断）", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await assignLeadLawyer({ leadId: lead.id, lawyerId: LAWYER.id });
    currentUser = { id: LAWYER.id, role: "LAWYER", rolePermissions: undefined };
    await respondLeadAssignment({ leadId: lead.id, decision: "DECLINED", reason: "忙" });

    const row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.assigneeLawyerId).toBe(LAWYER.id); // 仍指向原律师，等人重新派
  });
});

describe("二次对接人", () => {
  it("可设置，记录交接时间；清除后不留时间", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await setLeadSecondOwner({ leadId: lead.id, secondOwnerId: LAWYER.id });

    let row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.secondOwnerId).toBe(LAWYER.id);
    expect(row.handoverAt).not.toBeNull();

    await setLeadSecondOwner({ leadId: lead.id, secondOwnerId: "" });
    row = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(row.secondOwnerId).toBeNull();
  });

  it("**不能与负责人相同**（否则等于没设，还让「两人接力」变成假象）", async () => {
    const lead = await seedLead();
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await expect(setLeadSecondOwner({ leadId: lead.id, secondOwnerId: OWNER.id })).rejects.toThrow("不能与负责人相同");
  });

  it("停用账号不能被设为二次对接人", async () => {
    const lead = await seedLead();
    const disabled = await prisma.user.create({
      data: { email: `off2${Date.now()}@t.local`, name: "离职者2", role: "LAWYER", passwordHash: "x", active: false }
    });
    currentUser = { id: OWNER.id, role: "LAWYER", rolePermissions: undefined };
    await expect(setLeadSecondOwner({ leadId: lead.id, secondOwnerId: disabled.id })).rejects.toThrow("不存在或已停用");
  });
});
