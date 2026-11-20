// @vitest-environment node
/**
 * 提醒投递的租约与退避（真库，2026-11-21）
 *
 * 这两项是第七轮审计遗留的「待审批：需 Schema 迁移」项，现已迁移到位。
 * 它们各自对应一个**具体的**故障，不是理论风险：
 *
 *   ① **多实例重复投递**：sweep 原先没有领取动作，行在处理期间仍是 PENDING。
 *      进程内守卫 sweepInFlight 只防同一个进程；两个副本会同时捞到同一行各发一次。
 *      唯一约束挡不住——它防的是「同键重复行」，不是「同一行重复发送」。
 *
 *   ② **失败退避缺失**：失败行 status 回 PENDING 且 registeredAt 不变（永远最早），
 *      下一轮仍优先捞取，占满 take 窗口，把「今天到期」的正常提醒挤到几小时后。
 *
 * 租约的正确性只能靠**并发**验证：顺序调用两次永远不冲突，测不出互斥。
 */
import { beforeEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
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
const notifyMock = vi.fn(async () => {});
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "owner@lease.local", name: "主办", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/server/notifications/create", () => ({ createNotification: notifyMock }));

const { deliverPendingReminders } = await import("@/server/reminders/delivery");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 造一条"到点、未退避"的工单提醒行；对象用不存在的 id 让处理器走 OBJECT_GONE 分支 */
async function seedRow(opts: { objectType?: "PORTAL_REQUEST"; } = {}) {
  const objectId = uid("prq");
  return prisma.reminderDelivery.create({
    data: {
      objectType: opts.objectType ?? "PORTAL_REQUEST",
      objectId,
      kind: "OFFSET",
      offset: 0,
      channel: "IN_APP",
      dayKey: "2026-11-21",
      userId: STAFF.id,
      status: "PENDING",
      registeredAt: new Date(Date.now() - 60_000)
    }
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await prisma.reminderDelivery.deleteMany();
});

describe("数据库级租约（多实例不重复投递）", () => {
  it("并用两个并发 sweep：同一行只会被其中一个领到", async () => {
    await seedRow();

    // 注意：进程内 sweepInFlight 会让第二次调用直接返回 reentrantSkipped，
    // 所以这里**不能**用 deliverPendingReminders 测并发——那测的是进程内守卫。
    // 直接调用底层 sweepOnce 两次模拟两个实例（同一进程内的两次独立调用，
    // 各自拿不同的 leaseOwner 做不到，故改用「两次 updateMany 抢同一行」验证互斥语义）。
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 120_000);
    const [a, b] = await Promise.all([
      prisma.reminderDelivery.updateMany({
        where: { status: "PENDING", OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        data: { leaseOwner: "instance-A", leaseUntil }
      }),
      prisma.reminderDelivery.updateMany({
        where: { status: "PENDING", OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        data: { leaseOwner: "instance-B", leaseUntil }
      })
    ]);
    // Postgres 行锁保证只有一条 update 命中，另一条看到 updated 后的 leaseUntil
    expect(a.count + b.count).toBe(1);
  });

  it("租约未过期时，候选查询把它排除（另一个实例不会重复处理）", async () => {
    const row = await seedRow();
    const now = new Date();
    await prisma.reminderDelivery.update({
      where: { id: row.id },
      data: { leaseOwner: "other-instance", leaseUntil: new Date(now.getTime() + 60_000) }
    });

    // 处理器的对象不存在 → 若被捞到会 finalize 成 CANCELLED（status 变化即证明被处理过）
    const r = await deliverPendingReminders();
    expect(r.processed).toBe(0);
    expect(r.leaseMissed).toBe(true);
    const after = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe("PENDING");
    expect(after.leaseOwner).toBe("other-instance");
  });

  it("租约已过期可被接手（崩溃恢复）", async () => {
    const row = await seedRow();
    await prisma.reminderDelivery.update({
      where: { id: row.id },
      data: { leaseOwner: "dead-instance", leaseUntil: new Date(Date.now() - 1000) }
    });

    const r = await deliverPendingReminders();
    expect(r.processed).toBe(1);
    const after = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: row.id } });
    // 对象不存在 → CANCELLED；关键是它被**接手处理**了，而不是卡死在租约里
    expect(after.status).toBe("CANCELLED");
    expect(after.leaseOwner).toBeNull(); // 终态释放租约
  });

  it("终态释放租约，不留下占用", async () => {
    const row = await seedRow();
    await deliverPendingReminders();
    const after = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.leaseOwner).toBeNull();
    expect(after.leaseUntil).toBeNull();
  });
});

describe("失败退避（正常行不被失败行挤掉）", () => {
  it("失败后写 nextAttemptAt 并释放租约；立即再 sweep 不会重试它", async () => {
    // 用一个必然失败的场景：处理器里 createNotification 抛错
    notifyMock.mockRejectedValueOnce(new Error("SMTP 挂了"));

    // 需要一个会走到创建通知的行：用 ARCHIVE_BORROW 太复杂，
    // 这里改用 PORTAL_REQUEST 但让对象存在（否则走 OBJECT_GONE 不会发通知）
    const client = await prisma.client.create({ data: { id: uid("c"), name: "客户", type: "COMPANY" } });
    const req = await prisma.portalRequest.create({
      data: { portalUserId: (await prisma.clientPortalUser.create({
        data: { clientId: client.id, email: `${uid("p")}@x.local`, name: "客户", passwordHash: "!x" }
      })).id, clientId: client.id, subject: "问进度", body: "想了解", dueAt: new Date(Date.now() - 60_000) }
    });
    const row = await prisma.reminderDelivery.create({
      data: {
        objectType: "PORTAL_REQUEST", objectId: req.id, kind: "OFFSET", offset: 0,
        channel: "IN_APP", dayKey: "2026-11-21", userId: STAFF.id,
        status: "PENDING", registeredAt: new Date(Date.now() - 60_000)
      }
    });

    const first = await deliverPendingReminders();
    expect(first.failed).toBe(1);

    const afterFail = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(afterFail.status).toBe("PENDING");
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.nextAttemptAt).not.toBeNull();
    expect(afterFail.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(afterFail.leaseOwner).toBeNull(); // 失败即释放，不必等租约到期

    // 退避窗口内再 sweep：候选查询排除它
    notifyMock.mockClear();
    const second = await deliverPendingReminders();
    expect(second.processed).toBe(0);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("退避到期后可再次尝试，且 attempts 累加", async () => {
    const client = await prisma.client.create({ data: { id: uid("c"), name: "客户", type: "COMPANY" } });
    const req = await prisma.portalRequest.create({
      data: { portalUserId: (await prisma.clientPortalUser.create({
        data: { clientId: client.id, email: `${uid("p")}@x.local`, name: "客户", passwordHash: "!x" }
      })).id, clientId: client.id, subject: "再问", body: "想了解", dueAt: new Date(Date.now() - 60_000) }
    });
    const row = await prisma.reminderDelivery.create({
      data: {
        objectType: "PORTAL_REQUEST", objectId: req.id, kind: "OFFSET", offset: 0,
        channel: "IN_APP", dayKey: "2026-11-21", userId: STAFF.id,
        status: "PENDING", registeredAt: new Date(Date.now() - 60_000),
        attempts: 1, nextAttemptAt: new Date(Date.now() - 1000)
      }
    });

    notifyMock.mockRejectedValueOnce(new Error("还是挂了"));
    const r = await deliverPendingReminders();
    expect(r.failed).toBe(1);
    const after = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.attempts).toBe(2);
    // 指数退避：第二次的等待比第一次（1 分钟）更久
    expect(after.nextAttemptAt!.getTime() - Date.now()).toBeGreaterThan(60_000);
  });
});
