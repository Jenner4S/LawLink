// @vitest-environment node
/**
 * 获客到回款全链路金线（真库，2026-11-22）
 *
 * ## 这条测试要证明什么
 *
 * 不是"某个函数能跑"，而是**一条线索能走完整条业务链**：
 *   登记 → 派单 → 接单 → 邀约 → 到店 → 谈案 → 转收案
 *
 * 中途每一步都断言**数据真的变了**（阶段、时间戳、到店结果、收案记录），
 * 而不是只看返回值 ok。任何一环断掉，这条链就红。
 *
 * ## 为什么放在一个测试里而不是拆开
 *
 * 拆开只能证明"每步单独能跑"，证明不了"串起来能跑"——
 * 而业务方关心的是后者。这也是本项目一再强调的金线：
 * **单元测试绿不等于用户能走通。**
 *
 * 财务侧（合同/收款/回款核销）已由 finance-* 与 golden-thread-write.mjs 覆盖，
 * 本文件聚焦在**委托之前**这一段（也正是客户现行宽表的前半段）。
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
const LAWYER = { id: "" };
let currentUser: { id: string; role: string; rolePermissions: unknown } | null = null;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const a = await prisma.user.create({
    data: { email: "chain-a@t.local", name: "接待甲", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = a.id;
  const b = await prisma.user.create({
    data: { email: "chain-b@t.local", name: "对接乙", role: "LAWYER", passwordHash: "x", active: true }
  });
  LAWYER.id = b.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => ({ user: currentUser })) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const {
  createLead, addLeadActivity, assignLeadLawyer, respondLeadAssignment, convertLeadToIntake, listLeadTimeline
} = await import("@/server/leads/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

describe("一条线索走完全链", () => {
  it("登记 → 派单 → 接单 → 邀约 → 到店 → 谈案 → 转收案", async () => {
    currentUser = { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined };

    // ① 登记（带职业与渠道）
    const name = uid("金线客户");
    const { id } = await createLead({
      name,
      phone: "13900000300",
      occupation: "餐饮",
      source: "ONLINE",
      notes: "小额借贷纠纷咨询"
    });
    let lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("LEAD");
    expect(lead.occupation).toBe("餐饮");

    // ② 派单给律师（状态 ASSIGNED，不是替律师答应）
    const { listLeadChannels } = await import("@/server/leads/channels");
    void listLeadChannels;
    await assignLeadLawyer({ leadId: id, lawyerId: LAWYER.id });
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.assigneeLawyerId).toBe(LAWYER.id);
    expect(lead.assigneeStatus).toBe("ASSIGNED");

    // ③ 律师本人接单
    currentUser = { id: LAWYER.id, role: "LAWYER", rolePermissions: undefined };
    await respondLeadAssignment({ leadId: id, decision: "ACCEPTED" });
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.assigneeStatus).toBe("ACCEPTED");

    // ④ 邀约到店
    currentUser = { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined };
    const inviteAt = new Date(Date.now() + 86_400_000);
    await addLeadActivity({ leadId: id, type: "INVITE", happenedAt: inviteAt, note: "约明天下午到店" });
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("INVITED");
    expect(lead.visitOutcome).toBe("PENDING");

    // ⑤ 到店（置 ARRIVED，阶段推进）
    await addLeadActivity({ leadId: id, type: "VISIT", note: "已到店，携带借条" });
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("VISITED");
    expect(lead.visitOutcome).toBe("ARRIVED");
    expect(lead.visitedAt).not.toBeNull();

    // ⑥ 谈案完成（只有 CONSULTED 才能转收案）
    await addLeadActivity({ leadId: id, type: "CONSULT" });
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("CONSULTED");
    expect(lead.consultedAt).not.toBeNull();

    // ⑦ 转收案
    const res = await convertLeadToIntake({ leadId: id });
    lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("CONVERTED");
    expect(lead.convertedIntakeId).toBe(res.intakeId);
    expect(lead.convertedAt).not.toBeNull();

    const intake = await prisma.intake.findUniqueOrThrow({ where: { id: res.intakeId } });
    expect(intake.contactName).toBe(name);

    // ⑧ 全过程可回看：时间线里每一步都在
    const timeline = await listLeadTimeline(id);
    const types = timeline.activities.map((a) => a.type);
    expect(types).toContain("INVITE");
    expect(types).toContain("VISIT");
    expect(types).toContain("CONSULT");
    // 接单也留了痕（当时按 NOTE 记录）
    expect(timeline.activities.some((a) => (a.note ?? "").includes("接单"))).toBe(true);
  });

  it("反例：没谈案就转收案被拒（不能跳过环节）", async () => {
    currentUser = { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined };
    const { id } = await createLead({ name: uid("跳过谈案"), phone: "13900000301" });
    await addLeadActivity({ leadId: id, type: "INVITE" });
    await addLeadActivity({ leadId: id, type: "VISIT" });

    await expect(convertLeadToIntake({ leadId: id })).rejects.toThrow();
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("VISITED");
  });
});
