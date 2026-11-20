// @vitest-environment node
/**
 * 邀约提醒（真库，2026-11-21，获客全链路 阶段五）
 *
 * 「约了时间没来」是获客里最伤转化又最容易漏的环节：线索停在 INVITED
 * 不会报错、不会变红、不出现在任何待办里，只是安静躺着。
 *
 * 钉住四件事：
 *  ① 只在**逾期第 1/3/7 天**提醒（之后停——一直提醒会让人直接屏蔽通知）
 *  ② 只提醒 `INVITED`；已到店/已谈案/已转化/已流失都不提醒
 *  ③ 投递前**复核现值**：登记后客户到了店，这条必须作废而不是照发
 *  ④ 跟进人已停用 → 不发也不乱投别人（邀约是个人跟进事项，转派应由人决定）
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

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "leadrem@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  OWNER.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/server/notifications/create", () => ({ createNotification: vi.fn(async () => ({ id: "n1" })) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));

const { scanLeadInviteReminders, retireLeadReminders, LEAD_REMINDER_DAYS, LEAD_REMINDER_AHEAD_DAYS } =
  await import("@/server/leads/reminders");
const { deliverPendingReminders } = await import("@/server/reminders/delivery");
const { createNotification } = await import("@/server/notifications/create");
const { audit } = await import("@/server/audit");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const NOW = new Date("2026-12-20T10:00:00+08:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function seedLead(args: { stage: "LEAD" | "INVITED" | "VISITED" | "CONSULTED" | "CONVERTED" | "LOST"; invitedDaysAgo?: number; active?: boolean }) {
  const owner = args.active === false
    ? await prisma.user.create({ data: { email: `${uid("e")}@t.local`, name: "停用律师", role: "LAWYER", passwordHash: "x", active: false } })
    : { id: OWNER.id };
  return prisma.lead.create({
    data: {
      name: uid("线索"),
      phone: "13800000000",
      stage: args.stage,
      ownerId: owner.id,
      invitedAt: args.invitedDaysAgo === undefined ? null : daysAgo(args.invitedDaysAgo)
    }
  });
}

describe("邀约提醒扫描", () => {
  it("逾期第 1 天 → 登记一条", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 1 });
    await scanLeadInviteReminders(NOW);
    const rows = await prisma.reminderDelivery.findMany({ where: { objectType: "LEAD", objectId: lead.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].offset).toBe(1);
  });

  it("第 2 天不提醒（只提醒 1/3/7）", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 2 });
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(0);
  });

  it("第 3 天与第 7 天各提醒一次", async () => {
    const d3 = await seedLead({ stage: "INVITED", invitedDaysAgo: 3 });
    const d7 = await seedLead({ stage: "INVITED", invitedDaysAgo: 7 });
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: d3.id } })).toBe(1);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: d7.id } })).toBe(1);
    expect(LEAD_REMINDER_DAYS).toEqual([1, 3, 7]);
  });

  it("第 8 天不再提醒（一直提醒会让人直接屏蔽通知）", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 8 });
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(0);
  });

  it("已到店/已谈案/已转化/流失/仅线索 都不提醒", async () => {
    const stages = ["VISITED", "CONSULTED", "CONVERTED", "LOST", "LEAD"] as const;
    const leads = [];
    for (const stage of stages) leads.push(await seedLead({ stage, invitedDaysAgo: 1 }));
    await scanLeadInviteReminders(NOW);
    for (const lead of leads) {
      expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } }), `${lead.stage} 不该提醒`).toBe(0);
    }
  });

  it("跟进人已停用 → 不登记（也不改投别人）", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 1, active: false });
    const res = await scanLeadInviteReminders(NOW);
    expect(res.skippedDisabled).toBeGreaterThanOrEqual(1);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(0);
  });

  it("同一天重复扫描是幂等的（台账去重）", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 1 });
    await scanLeadInviteReminders(NOW);
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(1);
  });
});

describe("投递前复核现值", () => {
  it("登记后客户到店 → 这条提醒作废，不发通知", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 1 });
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(1);

    // 客户到店（模拟 addLeadActivity 的推进；此处直接改库模拟状态已变）
    await prisma.lead.update({ where: { id: lead.id }, data: { stage: "VISITED" } });

    vi.mocked(createNotification).mockClear();
    await deliverPendingReminders(20);
    const row = await prisma.reminderDelivery.findFirst({ where: { objectType: "LEAD", objectId: lead.id } });
    expect(row?.status).toBe("CANCELLED");
    // 按 refId 过滤，不要断言全局调用次数——投递器会 sweep 掉同库里
    // 其它用例仍留在 PENDING 的 LEAD 行（第一版就栽在这上面：global 4 次）
    const callsForThisLead = vi.mocked(createNotification).mock.calls
      .map((c) => c[0] as { refId?: string })
      .filter((a) => a.refId === lead.id);
    expect(callsForThisLead).toHaveLength(0);
  });

  it("仍在 INVITED → 正常发通知", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 1 });
    await scanLeadInviteReminders(NOW);
    vi.mocked(createNotification).mockClear();
    await deliverPendingReminders(20);
    const row = await prisma.reminderDelivery.findFirst({ where: { objectType: "LEAD", objectId: lead.id } });
    expect(row?.status).toBe("SENT");
    const mine = vi.mocked(createNotification).mock.calls
      .map((c) => c[0] as { title: string; href: string; refId?: string })
      .filter((a) => a.refId === lead.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("邀约客户未到店");
    expect(mine[0].href).toBe("/leads");
  });

  it("retireLeadReminders 能作废未发出的行（到店后手动调用）", async () => {
    const lead = await seedLead({ stage: "INVITED", invitedDaysAgo: 1 });
    await scanLeadInviteReminders(NOW);
    const n = await retireLeadReminders([lead.id], "CANCELLED", "LEAD_VISIT");
    expect(n).toBe(1);
    const row = await prisma.reminderDelivery.findFirst({ where: { objectType: "LEAD", objectId: lead.id } });
    expect(row?.status).toBe("CANCELLED");
  });
});

describe("事前提醒（提前 1 天 / 当天）", () => {
  /**
   * 只有逾期提醒是半个闭环：客户明天要来，跟进人今天不知道；当天要来了也没有提示。
   * **事前提醒比事后追责有用**：到店这件事，提醒得早能改期，提醒得晚只能算账。
   */
  const inDays = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

  async function seedFuture(args: { invitedAt: Date; active?: boolean }) {
    const owner = args.active === false
      ? await prisma.user.create({ data: { email: `${uid("e")}@t.local`, name: "停用", role: "LAWYER", passwordHash: "x", active: false } })
      : { id: OWNER.id };
    return prisma.lead.create({
      data: { name: uid("线索"), phone: "13800000000", stage: "INVITED", invitedAt: args.invitedAt, ownerId: owner.id }
    });
  }

  it("约定在明天 → 登记提前 1 天提醒（offset = -1）", async () => {
    const lead = await seedFuture({ invitedAt: inDays(1) });
    await scanLeadInviteReminders(NOW);
    const rows = await prisma.reminderDelivery.findMany({ where: { objectType: "LEAD", objectId: lead.id }, select: { offset: true } });
    expect(rows.map((r) => r.offset)).toEqual([-1]);
  });

  it("约定在今天且时刻未到 → 登记当天提醒（offset = 0）", async () => {
    const lead = await seedFuture({ invitedAt: new Date(NOW.getTime() + 3 * 3600_000) });
    await scanLeadInviteReminders(NOW);
    const rows = await prisma.reminderDelivery.findMany({ where: { objectType: "LEAD", objectId: lead.id }, select: { offset: true } });
    expect(rows.map((r) => r.offset)).toEqual([0]);
  });

  it("约定在今天但时刻已过 → 不按「当天」提醒（避免和逾期口径重复）", async () => {
    const lead = await seedFuture({ invitedAt: new Date(NOW.getTime() - 2 * 3600_000) });
    await scanLeadInviteReminders(NOW);
    const rows = await prisma.reminderDelivery.findMany({ where: { objectType: "LEAD", objectId: lead.id }, select: { offset: true } });
    expect(rows).toHaveLength(0);
  });

  it("约定在后天 → 不提醒（只提前 1 天）", async () => {
    const lead = await seedFuture({ invitedAt: inDays(2) });
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(0);
  });

  it("跟进人停用 → 事前提醒也不登记", async () => {
    const lead = await seedFuture({ invitedAt: inDays(1), active: false });
    await scanLeadInviteReminders(NOW);
    expect(await prisma.reminderDelivery.count({ where: { objectType: "LEAD", objectId: lead.id } })).toBe(0);
  });

  it("registeredAhead 只计事前两类", async () => {
    await seedFuture({ invitedAt: inDays(1) });
    await seedLead({ stage: "INVITED", invitedDaysAgo: 1 });
    const res = await scanLeadInviteReminders(NOW);
    expect(res.registeredAhead).toBeGreaterThanOrEqual(1);
    expect(res.registeredAhead).toBeLessThanOrEqual(res.registered);
    expect(LEAD_REMINDER_AHEAD_DAYS).toEqual([1, 0]);
  });

  it("事前提醒发的是「明天/今天有到店邀约」，且优先级不是 HIGH", async () => {
    const lead = await seedFuture({ invitedAt: inDays(1) });
    await scanLeadInviteReminders(NOW);
    vi.mocked(createNotification).mockClear();
    await deliverPendingReminders(50);
    const mine = vi.mocked(createNotification).mock.calls
      .map((c) => c[0] as { title: string; priority?: string; refId?: string })
      .filter((a) => a.refId === lead.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("明天有到店邀约");
    expect(mine[0].priority).toBe("NORMAL");
  });

  it("**改期检测**：登记后把约定时间改了 → 这条作废，不按旧时间提醒", async () => {
    const lead = await seedFuture({ invitedAt: inDays(1) });
    await scanLeadInviteReminders(NOW);

    // 客户改到下周三（模拟跟进人改期）
    await prisma.lead.update({ where: { id: lead.id }, data: { invitedAt: inDays(7) } });

    vi.mocked(createNotification).mockClear();
    await deliverPendingReminders(50);
    const row = await prisma.reminderDelivery.findFirst({ where: { objectType: "LEAD", objectId: lead.id } });
    expect(row?.status).toBe("SUPERSEDED");
    const mine = vi.mocked(createNotification).mock.calls
      .map((c) => c[0] as { refId?: string })
      .filter((a) => a.refId === lead.id);
    expect(mine).toHaveLength(0);
  });
});

describe("收口审查：跳过的停用负责人必须留痕", () => {
  /**
   * 这条防的是「没做成会有人知道吗」这一问的反例：
   * 停用负责人的线索此前只是**悄悄跳过**，除了一次函数返回值没人知道——
   * 而那批客户就是静静流失。系统不替人转派（会误投给不相干的人），
   * 但必须留痕迹，与保全提醒的 PRESERVATION_RECIPIENT_MISSING 同口径。
   */
  it("有停用负责人被跳过时，写一条汇总审计", async () => {
    await seedFutureForAudit();
    vi.mocked(audit).mockClear();
    const res = await scanLeadInviteReminders(NOW);
    expect(res.skippedDisabled).toBeGreaterThanOrEqual(1);
    const calls = vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; detail?: { skippedDisabled?: number } });
    const hit = calls.find((c) => c.action === "LEAD_REMINDER_RECIPIENT_DISABLED");
    expect(hit).toBeTruthy();
    expect(hit!.detail?.skippedDisabled).toBeGreaterThanOrEqual(1);
  });

  it("没有跳过时不写（避免空审计噪音）", async () => {
    // 只造在途且负责人有效的线索：存量里可能还有停用负责人的数据，
    // 故这里只断言「当天第一次扫描以外」不重复写——用一个不含停用线索的窗口无法构造，
    // 改为断言：skippedDisabled 为 0 时不写。
    vi.mocked(audit).mockClear();
    // 先把所有停用负责人的在途线索清掉
    const disabledUsers = await prisma.user.findMany({ where: { active: false }, select: { id: true } });
    if (disabledUsers.length) {
      await prisma.lead.deleteMany({ where: { ownerId: { in: disabledUsers.map((u) => u.id) }, stage: "INVITED" } });
    }
    const res = await scanLeadInviteReminders(NOW);
    expect(res.skippedDisabled).toBe(0);
    const calls = vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string });
    expect(calls.some((c) => c.action === "LEAD_REMINDER_RECIPIENT_DISABLED")).toBe(false);
  });
});

/** 造一条「约定在明天、负责人已停用」的线索 */
async function seedFutureForAudit() {
  const owner = await prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name: "停用甲", role: "LAWYER", passwordHash: "x", active: false }
  });
  await prisma.lead.create({
    data: {
      name: uid("线索"), phone: "13800000000", stage: "INVITED",
      invitedAt: new Date(NOW.getTime() + 86_400_000), ownerId: owner.id
    }
  });
}
