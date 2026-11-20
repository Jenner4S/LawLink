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

const { createLead, listLeads, addLeadActivity, markLeadLost, convertLeadToIntake, listLeadTimeline, listLeadOwners } =
  await import("@/server/leads/actions");
const { getLeadFunnel } = await import("@/server/leads/analytics");

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

describe("跟进时间线", () => {
  it("按发生时间倒序返回，带记录人与类型", async () => {
    const { id } = await createLead({ name: uid("时间线"), phone: "13900000020" });
    await addLeadActivity({ leadId: id, type: "CONTACT", note: "第一次电话", happenedAt: new Date("2026-12-01T10:00:00+08:00") });
    await addLeadActivity({ leadId: id, type: "INVITE", note: "约周三", happenedAt: new Date("2026-12-02T10:00:00+08:00") });
    await addLeadActivity({ leadId: id, type: "NOTE", note: "补录备注", happenedAt: new Date("2026-11-30T10:00:00+08:00") });

    const tl = await listLeadTimeline(id);
    // 最近的排最上（与人的回忆顺序一致）
    expect(tl.activities.map((a) => a.type)).toEqual(["INVITE", "CONTACT", "NOTE"]);
    expect(tl.activities[0].note).toBe("约周三");
    expect(tl.activities[0].createdBy.name).toBe("张律师");
  });

  it("带出线索基本信息（阶段、跟进人、联系方式、登记时间）", async () => {
    const { id } = await createLead({ name: uid("信息"), phone: "13900000021", expectedAmount: 12000 });
    const tl = await listLeadTimeline(id);
    expect(tl.lead.stage).toBe("LEAD");
    expect(tl.lead.owner.name).toBe("张律师");
    expect(tl.lead.phone).toBe("13900000021");
    expect(tl.lead.expectedAmount).toBe(12000);
    expect(tl.lead.createdAt).toBeInstanceOf(Date);
  });

  it("转收案后时间线仍可读，并带出收案关联", async () => {
    const { id } = await createLead({ name: uid("已转化"), phone: "13900000022" });
    await addLeadActivity({ leadId: id, type: "VISIT" });
    await addLeadActivity({ leadId: id, type: "CONSULT" });
    const { intakeId } = await convertLeadToIntake({ leadId: id });
    const tl = await listLeadTimeline(id);
    expect(tl.lead.stage).toBe("CONVERTED");
    expect(tl.lead.convertedIntakeId).toBe(intakeId);
    expect(tl.activities).toHaveLength(2);
  });

  it("线索不存在 → 明确报错（不是静默空时间线）", async () => {
    await expect(listLeadTimeline("nonexistent-cuid")).rejects.toThrow("线索不存在");
  });

  it("缺少标识 → 报错", async () => {
    await expect(listLeadTimeline("")).rejects.toThrow("缺少线索标识");
  });

  it("只返回本线索的动作，不串到别的线索", async () => {
    const a = await createLead({ name: uid("甲"), phone: "13900000023" });
    const b = await createLead({ name: uid("乙"), phone: "13900000024" });
    await addLeadActivity({ leadId: a.id, type: "CONTACT", note: "甲的记录" });
    await addLeadActivity({ leadId: b.id, type: "CONTACT", note: "乙的记录" });

    const tlA = await listLeadTimeline(a.id);
    expect(tlA.activities).toHaveLength(1);
    expect(tlA.activities[0].note).toBe("甲的记录");
  });
});

describe("负责人筛选", () => {
  it("listLeads(ownerId) 只返回该负责人的线索", async () => {
    const other = await prisma.user.create({
      data: { email: `${uid("e")}@t.local`, name: "李律师", role: "LAWYER", passwordHash: "x", active: true }
    });
    const mine = await createLead({ name: uid("我的线索"), phone: "13900000030" });

    // 造一条属于别人的线索（直接写库，模拟他人登记）
    const theirs = await prisma.lead.create({
      data: { name: uid("他人线索"), phone: "13900000031", ownerId: other.id }
    });

    const myRows = await listLeads({ stage: "ALL", ownerId: STAFF.id });
    expect(myRows.some((r) => r.id === mine.id)).toBe(true);
    expect(myRows.some((r) => r.id === theirs.id)).toBe(false);

    const theirRows = await listLeads({ stage: "ALL", ownerId: other.id });
    expect(theirRows.some((r) => r.id === theirs.id)).toBe(true);
    expect(theirRows.some((r) => r.id === mine.id)).toBe(false);
  });

  it("listLeadOwners 只统计在途线索（与列表默认口径一致）", async () => {
    const other = await prisma.user.create({
      data: { email: `${uid("e")}@t.local`, name: "王律师", role: "LAWYER", passwordHash: "x", active: true }
    });
    // 在途 1 条 + 流失 1 条
    await prisma.lead.create({ data: { name: uid("在途"), phone: "13900000032", ownerId: other.id, stage: "LEAD" } });
    await prisma.lead.create({
      data: { name: uid("流失"), phone: "13900000033", ownerId: other.id, stage: "LOST", lostReason: "比价" }
    });

    const owners = await listLeadOwners();
    const row = owners.find((o) => o.ownerId === other.id);
    // 若把流失也算进来会得到 2 —— 那会让人看到「名下 2 条、点进去只剩 1 条」
    expect(row?.count).toBe(1);
  });

  it("停用账号的线索仍显示负责人名字（不变成空字符串）", async () => {
    const disabled = await prisma.user.create({
      data: { email: `${uid("e")}@t.local`, name: "离职律师", role: "LAWYER", passwordHash: "x", active: false }
    });
    await prisma.lead.create({ data: { name: uid("遗留线索"), phone: "13900000034", ownerId: disabled.id } });

    const owners = await listLeadOwners();
    const row = owners.find((o) => o.ownerId === disabled.id);
    expect(row?.ownerName).toBe("离职律师");
  });
});

describe("收口审查：作废提醒必须走失败隔离封装", () => {
  /**
   * 三次作废都发生在写事务**之后**：到店/谈案已落库、流失已落库、转收案已落库。
   * 若作废抛错并冒泡，用户会看到「操作失败」但数据其实已写入 —— 他会重试，
   * 于是又多一条记录。**已成功的事不该因为后续清理失败而报失败。**
   *
   * 为什么用结构检查而不是注入失败：
   * Prisma 的模型委托是 Proxy，`spyOn(prisma.reminderDelivery, ...)` 打不中
   * 实际调用点（第一次写这条测试就是这样失败的）。结构守卫能达成同样的防回归目的，
   * 且不会假装自己在测运行时行为。
   */
  it("actions.ts 里不再直接调用 retireLeadReminders（一律走 Safely 封装）", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../server/leads/actions.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    // 裸调用只允许出现在安全封装内部（封装是第 69 行那个 async function 本身），
    // 也就是全文件恰好 1 处；若有人在三处调用点直接写裸调用，会增加。
    const naked = src.match(/await\s+retireLeadReminders\(/g) ?? [];
    expect(naked, "裸调用只应存在于封装内部").toHaveLength(1);
    // 封装本身必须存在且被三处使用
    expect(src).toContain("retireLeadRemindersSafely");
    expect((src.match(/await\s+retireLeadRemindersSafely\(/g) ?? []).length).toBe(3);
  });
});

describe("到店三态（P0-3）", () => {
  /**
   * 客户现行系统里「到店来访」是状态单选（多行为「未曾来访」）。
   * 他区分「没约」与「约了没来」——没约是跟进没推进，爽约是邀约质量或客户意愿问题。
   * 现在只有 stage=INVITED，两者分不开。
   */
  it("邀约 → visitOutcome=PENDING；到店 → ARRIVED 且阶段 VISITED", async () => {
    const { id } = await createLead({ name: uid("到店三态"), phone: "13900000050" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).visitOutcome).toBe("PENDING");

    await addLeadActivity({ leadId: id, type: "INVITE" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).visitOutcome).toBe("PENDING");

    await addLeadActivity({ leadId: id, type: "VISIT" });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(after.visitOutcome).toBe("ARRIVED");
    expect(after.stage).toBe("VISITED");
  });

  it("**爽约不改阶段**（改了会让漏斗倒挂，且爽约后仍可再约）", async () => {
    const { id } = await createLead({ name: uid("爽约"), phone: "13900000051" });
    await addLeadActivity({ leadId: id, type: "INVITE" });

    const res = await addLeadActivity({ leadId: id, type: "NO_SHOW" });
    const after = await prisma.lead.findUniqueOrThrow({ where: { id } });
    expect(after.stage).toBe("INVITED");
    expect(after.visitOutcome).toBe("NO_SHOW");
    expect(res.stage).toBe("INVITED");
    // invitedAt 必须保留——1/3/7 天追问要靠它算逾期
    expect(after.invitedAt).not.toBeNull();
  });

  it("爽约后再次邀约 → visitOutcome 回到 PENDING（可以再约）", async () => {
    const { id } = await createLead({ name: uid("再约"), phone: "13900000052" });
    await addLeadActivity({ leadId: id, type: "INVITE" });
    await addLeadActivity({ leadId: id, type: "NO_SHOW" });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).visitOutcome).toBe("NO_SHOW");

    await addLeadActivity({ leadId: id, type: "INVITE", happenedAt: new Date() });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id } })).visitOutcome).toBe("PENDING");
  });

  it("漏斗统计爽约数，爽约率分母是「到过邀约环节的人」（不是总线索数）", async () => {
    const own = new Date("2029-02-10T10:00:00+08:00");
    const start = new Date("2029-02-01T00:00:00+08:00");
    const end = new Date("2029-02-28T23:59:59+08:00");
    // 2 条爽约 + 1 条到店 + 1 条纯线索（没约）
    for (const [outcome, acts] of [
      ["NO_SHOW", ["INVITE", "NO_SHOW"]],
      ["NO_SHOW", ["INVITE", "NO_SHOW"]],
      ["ARRIVED", ["INVITE", "VISIT"]]
    ] as [string, ("INVITE" | "NO_SHOW" | "VISIT")[]][]) {
      const lead = await prisma.lead.create({
        data: { name: uid("漏斗"), phone: "13900000060", ownerId: STAFF.id, createdAt: own, invitedAt: own }
      });
      for (const t of acts) {
        await prisma.leadActivity.create({ data: { leadId: lead.id, type: t, happenedAt: own, createdById: STAFF.id } });
      }
      await prisma.lead.update({ where: { id: lead.id }, data: { visitOutcome: outcome as never, stage: outcome === "ARRIVED" ? "VISITED" : "INVITED" } });
    }
    await prisma.lead.create({ data: { name: uid("没约"), phone: "13900000061", ownerId: STAFF.id, createdAt: own } });

    const f = await getLeadFunnel({ start, end });
    expect(f.total).toBe(4);
    expect(f.noShow).toBe(2);
    // 2 爽约 / (2 爽约 + 1 到店) = 66.7%；若误用总线索数会是 50%
    expect(f.noShowRate).toBe(66.7);
  });
});
