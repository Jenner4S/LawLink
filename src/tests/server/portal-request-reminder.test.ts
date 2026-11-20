// @vitest-environment node
/**
 * 工单到期提醒（真库，2026-11-21）
 *
 * 走的是既有提醒台账（ReminderDelivery），所以测三件事：
 *   ① 提交工单会登记一条 registeredAt = dueAt 的**未来档位**行（不提前打扰）
 *   ② 投递前复核对象现值：已回复的工单，提醒必须 CANCELLED 而不是照发
 *   ③ 回复时作废待发提醒（否则员工回完了还会收到"超期未回复"）
 */
import { beforeEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
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
const auditMock = vi.fn(async () => {});
const notifyMock = vi.fn(async () => {});
const STAFF = { id: "" };
let viewer: { portalUserId: string; clientId: string; clientName: string; name: string; email: string } | null = null;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "owner@rem.local", name: "主办律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: auditMock, auditTx: vi.fn() }));
vi.mock("@/lib/permissions", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/permissions");
  return { ...actual, assertCanHandleMatter: vi.fn(async () => {}) };
});
vi.mock("@/lib/portal/session", () => ({ getPortalViewer: vi.fn(async () => viewer) }));
vi.mock("@/server/notifications/create", () => ({ createNotification: notifyMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { submitPortalRequest, answerPortalRequest } = await import("@/server/portal/requests");
const { deliverPendingReminders } = await import("@/server/reminders/delivery");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedClientWithMatter() {
  const c = await prisma.client.create({ data: { id: uid("c"), name: uid("客户"), type: "COMPANY" } });
  await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "工单提醒案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: c.id, customValues: {}
    }
  });
  const u = await prisma.clientPortalUser.create({
    data: { clientId: c.id, email: `${uid("p")}@client.local`, name: "客户", passwordHash: "!x", isPrimary: true }
  });
  return { client: c, user: u };
}

beforeEach(async () => {
  vi.clearAllMocks();
  viewer = null;
  await prisma.reminderDelivery.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.portalRequest.deleteMany();
});

describe("工单到期提醒", () => {
  it("提交工单登记一条 registeredAt = dueAt 的未来档位行，接收人是在办案件主办", async () => {
    const { client, user } = await seedClientWithMatter();
    viewer = { portalUserId: user.id, clientId: client.id, clientName: client.name, name: "客户", email: user.email };
    const { id } = await submitPortalRequest({ subject: "问进度", body: "想了解进展" });

    const rows = await prisma.reminderDelivery.findMany({ where: { objectType: "PORTAL_REQUEST", objectId: id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(STAFF.id);
    expect(rows[0].status).toBe("PENDING");
    const req = await prisma.portalRequest.findUniqueOrThrow({ where: { id } });
    // 登记时刻 = dueAt（未来），因此不会被立刻 sweep 出去
    expect(rows[0].registeredAt.getTime()).toBe(req.dueAt!.getTime());
  });

  it("未到 dueAt 时 sweep 不会发（台账按 registeredAt 领取）", async () => {
    const { client, user } = await seedClientWithMatter();
    viewer = { portalUserId: user.id, clientId: client.id, clientName: client.name, name: "客户", email: user.email };
    await submitPortalRequest({ subject: "问进度", body: "想了解进展" });

    // 直接 sweep 一次：registeredAt 在未来，台账不会领到它
    const r = await deliverPendingReminders();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });

  it("到 dueAt 后 sweep 会发通知", async () => {
    const { client, user } = await seedClientWithMatter();
    viewer = { portalUserId: user.id, clientId: client.id, clientName: client.name, name: "客户", email: user.email };
    await submitPortalRequest({ subject: "问进度", body: "想了解进展" });

    // 把登记时刻推到过去，模拟「到了 dueAt」——投递器按 registeredAt 领取，
    // 故不需要（也不应该）注入"当前时间"参数
    await prisma.reminderDelivery.updateMany({ data: { registeredAt: new Date(Date.now() - 1000) } });
    const r = await deliverPendingReminders();
    expect(r.sent).toBe(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    const arg = (notifyMock.mock.calls as unknown as [{ title: string; userId: string }][])[0][0];
    expect(arg.title).toBe("客户提问待回复");
    expect(arg.userId).toBe(STAFF.id);
  });

  it("回复后提醒被作废，到期也不再发（回完了不该还收到超期提醒）", async () => {
    const { client, user } = await seedClientWithMatter();
    viewer = { portalUserId: user.id, clientId: client.id, clientName: client.name, name: "客户", email: user.email };
    const { id } = await submitPortalRequest({ subject: "问进度", body: "想了解进展" });
    viewer = null;

    await answerPortalRequest({ requestId: id, answer: "预计下月开庭" });

    const rows = await prisma.reminderDelivery.findMany({ where: { objectType: "PORTAL_REQUEST", objectId: id } });
    expect(rows[0].status).toBe("CANCELLED");

    await prisma.reminderDelivery.updateMany({ data: { registeredAt: new Date(Date.now() - 1000) } });
    await deliverPendingReminders();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("投递时复核对象现值（台账的核心价值）", () => {
  /**
   * 这条**必须绕过 answerPortalRequest** 直接改库：
   * 走动作会顺带 voidPendingDeliveries，行变成 CANCELLED，
   * 投递器里的「已回复则取消」复核就永远走不到——
   * 第一版就是这么写的，做变异（拆掉复核）测试照样绿，等于没测。
   *
   * 真实场景对得上：sweep 拿到这一行的同一瞬间员工点了回复，
   * 或者作废调用失败。这时只能靠投递前的现值复核兜住。
   */
  it("行仍是 PENDING 但工单已回复 → 投递前复核把它 CANCELLED，不发通知", async () => {
    const { client, user } = await seedClientWithMatter();
    viewer = { portalUserId: user.id, clientId: client.id, clientName: client.name, name: "客户", email: user.email };
    const { id } = await submitPortalRequest({ subject: "问进度", body: "想了解进展" });
    viewer = null;

    // 直接改库「已回复」，不经过动作（避免连带作废提醒）
    await prisma.portalRequest.update({
      where: { id },
      data: { status: "ANSWERED", answerBody: "已回复", answeredById: STAFF.id, answeredAt: new Date() }
    });
    await prisma.reminderDelivery.updateMany({ data: { registeredAt: new Date(Date.now() - 1000) } });

    const r = await deliverPendingReminders();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
    expect(r.voided).toBe(1);

    const row = await prisma.reminderDelivery.findFirstOrThrow({ where: { objectType: "PORTAL_REQUEST", objectId: id } });
    expect(row.status).toBe("CANCELLED");
    expect(JSON.stringify(row.detail)).toContain("REQUEST_ANSWERED");
  });
});
