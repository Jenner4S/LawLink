// @vitest-environment node
/**
 * 获客 → 邀约 → 到店谈案 → 转收案（真库，2026-11-21）
 *
 * 钉住四件事，每件都能被做错且看不出来：
 *   ① **阶段只能向前**：先记「到店」再补记「联系」不能把阶段拉回去
 *      （补录是常态，回退会让漏斗统计倒挂）
 *   ② **转化只能从 CONSULTED**：否则「到店谈案」整段被跳过，
 *      漏斗永远漂亮但不可信
 *   ③ **流失必须写原因**：没原因的流失等于没有信息
 *   ④ **转化连带落库**：Intake 建出来、线索标记 CONVERTED 并回填 convertedIntakeId，
 *      且同一个线索不能转两次
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
const STAFF = { id: "", role: "PRINCIPAL_LAWYER", rolePermissions: undefined as unknown };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "leads@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { createLead, listLeads, addLeadActivity, markLeadLost, convertLeadToIntake } =
  await import("@/server/leads/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

describe("线索登记", () => {
  it("电话与微信都空 → 拒绝（后面无法邀约）", async () => {
    await expect(createLead({ name: "李四" })).rejects.toThrow("至少填写电话或微信");
  });

  it("正常登记：默认阶段 LEAD、负责人是当前用户、可在列表查到", async () => {
    const name = uid("王五");
    const { id } = await createLead({ name, phone: "13800000000", source: "REFERRAL" });
    const row = (await listLeads()).find((r) => r.id === id);
    expect(row).toBeTruthy();
    expect(row!.stage).toBe("LEAD");
    expect(row!.ownerId).toBe(STAFF.id);
    expect(row!.source).toBe("REFERRAL");
  });
});

describe("阶段推进（只向前）", () => {
  it("INVITE→VISIT→CONSULT 逐段推进，并落对应时间戳", async () => {
    const { id } = await createLead({ name: uid("赵六"), phone: "13900000001" });

    await addLeadActivity({ leadId: id, type: "INVITE", note: "约周三下午" });
    let row = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(row.stage).toBe("INVITED");
    expect(row.invitedAt).not.toBeNull();

    await addLeadActivity({ leadId: id, type: "VISIT", note: "已到店" });
    row = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(row.stage).toBe("VISITED");
    expect(row.visitedAt).not.toBeNull();

    await addLeadActivity({ leadId: id, type: "CONSULT", note: "面谈 1 小时，报 3 万" });
    row = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(row.stage).toBe("CONSULTED");
    expect(row.consultedAt).not.toBeNull();
  });

  it("补录更早阶段的动作不会把阶段拉回去", async () => {
    const { id } = await createLead({ name: uid("孙七"), phone: "13900000002" });
    await addLeadActivity({ leadId: id, type: "VISIT" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).stage).toBe("VISITED");

    // 关键：补录的是**会推进阶段的类型**（INVITE → INVITED，序号 1 < VISITED 的 2）。
    // 第一版这里用的是 CONTACT（不推进阶段），根本走不到 order 守卫——
    // 把守卫去掉测试照样全绿，等于没测。变异验证才暴露出这一点。
    await addLeadActivity({ leadId: id, type: "INVITE", note: "补录：其实上周就约过" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).stage).toBe("VISITED");
  });

  it("CONTACT/NOTE 不改变阶段", async () => {
    const { id } = await createLead({ name: uid("周八"), phone: "13900000003" });
    await addLeadActivity({ leadId: id, type: "CONTACT" });
    await addLeadActivity({ leadId: id, type: "NOTE", note: "客户说要考虑" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).stage).toBe("LEAD");
  });
});

describe("转化口径", () => {
  it("未到 CONSULTED 不能转收案（否则「到店谈案」这一段永远没有数据）", async () => {
    const { id } = await createLead({ name: uid("吴九"), phone: "13900000004" });
    await addLeadActivity({ leadId: id, type: "VISIT" });
    await expect(convertLeadToIntake({ leadId: id })).rejects.toThrow("请先完成「到店谈案」");
  });

  it("CONSULTED 后转收案：建 Intake、线索转 CONVERTED、回填 convertedIntakeId", async () => {
    const { id } = await createLead({ name: uid("郑十"), phone: "13900000005", expectedAmount: 30000 });
    await addLeadActivity({ leadId: id, type: "INVITE" });
    await addLeadActivity({ leadId: id, type: "VISIT" });
    await addLeadActivity({ leadId: id, type: "CONSULT" });

    const { intakeId } = await convertLeadToIntake({ leadId: id });
    const intake = await prisma.intake.findUniqueOrThrow({ where: { id: intakeId }, select: { contactName: true, contactPhone: true } });
    expect(intake.contactPhone).toBe("13900000005");

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(lead.stage).toBe("CONVERTED");
    expect(lead.convertedIntakeId).toBe(intakeId);
    expect(lead.convertedAt).not.toBeNull();
  });

  it("同一线索不能转两次", async () => {
    const { id } = await createLead({ name: uid("钱十一"), phone: "13900000006" });
    await addLeadActivity({ leadId: id, type: "VISIT" });
    await addLeadActivity({ leadId: id, type: "CONSULT" });
    await convertLeadToIntake({ leadId: id });
    await expect(convertLeadToIntake({ leadId: id })).rejects.toThrow("已转过收案");
  });

  it("已转收案的线索不能再记跟进（后续记录应在收案里）", async () => {
    const { id } = await createLead({ name: uid("冯十二"), phone: "13900000007" });
    await addLeadActivity({ leadId: id, type: "VISIT" });
    await addLeadActivity({ leadId: id, type: "CONSULT" });
    await convertLeadToIntake({ leadId: id });
    await expect(addLeadActivity({ leadId: id, type: "NOTE", note: "x" })).rejects.toThrow("已转为收案");
  });
});

describe("流失", () => {
  it("必须写原因；写后不再记跟进", async () => {
    const { id } = await createLead({ name: uid("陈十三"), phone: "13900000008" });
    await expect(markLeadLost({ leadId: id, reason: "短" })).rejects.toThrow("至少 2 字");
    await markLeadLost({ leadId: id, reason: "比价后选了别家" });

    const row = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(row.stage).toBe("LOST");
    expect(row.lostReason).toBe("比价后选了别家");
    expect(row.lostAt).not.toBeNull();

    await expect(addLeadActivity({ leadId: id, type: "NOTE", note: "x" })).rejects.toThrow("已标记流失");
  });
});

describe("列表口径", () => {
  it("默认只返回在途线索（不含流失与已转化），ALL 才全返", async () => {
    const open = await createLead({ name: uid("褚十四"), phone: "13900000009" });
    const lost = await createLead({ name: uid("卫十五"), phone: "13900000010" });
    await markLeadLost({ leadId: lost.id, reason: "没有委托意向" });

    const opened = await listLeads();
    expect(opened.some((r) => r.id === open.id)).toBe(true);
    expect(opened.some((r) => r.id === lost.id)).toBe(false);

    const all = await listLeads({ stage: "ALL" });
    expect(all.some((r) => r.id === lost.id)).toBe(true);
  });
});
