// @vitest-environment node
/**
 * 坏账的逐笔冲抵明细（真库，2026-11-22）
 *
 * ## 补的是什么
 *
 * 此前坏账只记总额（到合同级）。对账时律师问的第一句是
 * 「**这笔坏账冲的是哪几笔应收**」——只记总额回答不了。
 *
 * ## 三条口径
 *
 * ① 明细合计**必须等于**坏账总额（不能凭空多冲、也不能少冲）；
 * ② 每条 ≤ 该应收条目的**未收余额**（已核销的不能再被坏账冲）；
 * ③ 只允许**同案**条目；指定 billingId 时只看该合同。
 *
 * 分摊顺序：最早到期优先（`dueDate` 升序），相同时按创建时间。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "wo@t.local", name: "财务甲", role: "FINANCE", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.receivableWriteOffItem.deleteMany({});
  await prisma.receivableWriteOff.deleteMany({});
  await prisma.allocation.deleteMany({});
  await prisma.receivable.deleteMany({});
  await prisma.billing.deleteMany({});
  await prisma.matter.deleteMany({});
  await prisma.client.deleteMany({});
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "FINANCE", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { requestWriteOff } = await import("@/server/finance/writeoff-actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedMatter() {
  const client = await prisma.client.create({
    data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
  });
  return prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "坏账案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: client.id, customValues: {}
    }
  });
}

async function addReceivable(matterId: string, amount: number, opts: { dueDate?: Date; settled?: number; billingId?: string } = {}) {
  return prisma.receivable.create({
    data: {
      matterId, title: uid("应收"), amount: new Prisma.Decimal(amount),
      settledAmount: new Prisma.Decimal(opts.settled ?? 0),
      moneyKind: "LAWYER_FEE", status: "OPEN",
      ...(opts.dueDate ? { dueDate: opts.dueDate } : {}),
      ...(opts.billingId ? { billingId: opts.billingId } : {})
    }
  });
}

describe("逐笔冲抵", () => {
  it("最早到期优先分摊：3 笔各 100，坏账 250 → 100/100/50", async () => {
    const m = await seedMatter();
    const r1 = await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });
    const r2 = await addReceivable(m.id, 100, { dueDate: new Date("2026-02-01") });
    const r3 = await addReceivable(m.id, 100, { dueDate: new Date("2026-03-01") });

    const res = await requestWriteOff({ matterId: m.id, amount: 250, reason: "INABILITY_TO_PAY" });
    const items = await prisma.receivableWriteOffItem.findMany({
      where: { writeOffId: res.id },
      orderBy: { amount: "desc" }
    });
    expect(items.map((i) => Number(i.amount))).toEqual([100, 100, 50]);
    expect(new Set(items.map((i) => i.receivableId))).toEqual(new Set([r1.id, r2.id, r3.id]));
  });

  it("**明细合计等于坏账总额**（不多冲也不少冲）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 500, { dueDate: new Date("2026-01-01") });
    const res = await requestWriteOff({ matterId: m.id, amount: 180, reason: "WAIVED" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: res.id } });
    const sum = items.reduce((n, i) => n + Number(i.amount), 0);
    expect(sum).toBe(180);
  });

  it("**已核销的条目不再参与坏账**（未收余额为 0）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01"), settled: 100 }); // 已全收
    const open = await addReceivable(m.id, 100, { dueDate: new Date("2026-02-01") });

    const res = await requestWriteOff({ matterId: m.id, amount: 100, reason: "WAIVED" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: res.id } });
    expect(items).toHaveLength(1);
    expect(items[0].receivableId).toBe(open.id);
  });

  it("**超过未收合计被拒**（不能凭空多冲）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });
    await expect(
      requestWriteOff({ matterId: m.id, amount: 300, reason: "WAIVED" })
    ).rejects.toThrow(/超过.*可用未收额度/);
  });

  it("**指定 billingId 时只看该合同的条目**", async () => {
    const m = await seedMatter();
    const b1 = await prisma.billing.create({
      data: { matterId: m.id, title: "合同一", contractAmount: new Prisma.Decimal(1000), status: "ACTIVE", moneyKind: "LAWYER_FEE" }
    });
    // 关键：无合同的那条**更早到期**。若实现忽略 billingId 过滤，
    // FIFO 会先冲它，明细条数与内容都会不同 → 断言才有分辨力。
    // （第一版我把更早到期的写成了合同内条目，结果变异「忽略 billingId」没被抓到，
    //  说明那条测试是假的；这是变异验证抓出来的，不是我想出来的。）
    await addReceivable(m.id, 100, { dueDate: new Date("2025-12-01") }); // 无合同，更早
    const inBilling = await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01"), billingId: b1.id });

    const res = await requestWriteOff({ matterId: m.id, billingId: b1.id, amount: 100, reason: "WAIVED" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: res.id } });
    expect(items).toHaveLength(1);
    expect(items[0].receivableId).toBe(inBilling.id);
  });

  it("**完全无应收条目时允许合同级申报**（明细为空），不为难「先报后补」的场景", async () => {
    // 第一版我对这种情况一律报错，结果打破 8 个既有用例。
    // 真实业务里财务常"先报坏账、后补应收"，一律拒绝等于系统不让报。
    // 定稿：有条目就严格校验，没条目就退化为合同级（不落明细）。
    const m = await seedMatter();
    const res = await requestWriteOff({ matterId: m.id, amount: 50, reason: "OTHER" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: res.id } });
    expect(items).toHaveLength(0);
    const row = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: res.id } });
    expect(Number(row.amount)).toBe(50);
  });

  it("**有条目但金额超未收合计**被拒（无条目才放行，别混为一谈）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });
    await expect(
      requestWriteOff({ matterId: m.id, amount: 300, reason: "WAIVED" })
    ).rejects.toThrow(/超过.*可用未收额度/);
  });

  it("明细随坏账删除级联清理（onDelete: Cascade）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });
    const res = await requestWriteOff({ matterId: m.id, amount: 100, reason: "WAIVED" });
    await prisma.receivableWriteOff.delete({ where: { id: res.id } });
    expect(await prisma.receivableWriteOffItem.count()).toBe(0);
  });

  it("**已有在途坏账占用的额度要扣掉**（两笔各 60，未收 100 → 第二笔被拒）", async () => {
    // 这是并发/重复申报的现实形态：坏账不改 settledAmount，
    // 若不把在途坏账算进占用，两笔各 ≤ 未收合计的申报会合起来超额。
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });

    await requestWriteOff({ matterId: m.id, amount: 60, reason: "WAIVED" });
    await expect(
      requestWriteOff({ matterId: m.id, amount: 60, reason: "WAIVED" })
    ).rejects.toThrow(/超过.*可用未收额度/);

    // 剩余 40 仍然可报
    const ok = await requestWriteOff({ matterId: m.id, amount: 40, reason: "WAIVED" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: ok.id } });
    expect(items.reduce((n, i) => n + Number(i.amount), 0)).toBe(40);
  });

  it("**合同级旧坏账（无明细）也占额度**", async () => {
    const m = await seedMatter();
    const r = await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });
    // 直接写一条无明细的 PENDING 坏账，模拟历史数据
    await prisma.receivableWriteOff.create({
      data: {
        matterId: m.id, amount: new Prisma.Decimal(70), reason: "OTHER",
        requestedById: STAFF.id
      }
    });
    await expect(
      requestWriteOff({ matterId: m.id, amount: 50, reason: "WAIVED" })
    ).rejects.toThrow(/可用未收额度/);
    // 剩 30 可报，且明细只冲该条目
    const ok = await requestWriteOff({ matterId: m.id, amount: 30, reason: "WAIVED" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: ok.id } });
    expect(items).toHaveLength(1);
    expect(items[0].receivableId).toBe(r.id);
  });

  it("**并发两笔各 60（未收 100）→ 只能成功一笔**（行锁 + 在途占用）", async () => {
    // 这条用例是唯一能证明 FOR UPDATE 有作用的：
    // 顺序用例里第二笔能读到第一笔已提交的占用，所以去掉行锁也照样绿；
    // 只有真并发（两个事务都还没提交）才能暴露「双双通过、合计超额」。
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });

    const results = await Promise.allSettled([
      requestWriteOff({ matterId: m.id, amount: 60, reason: "WAIVED" }),
      requestWriteOff({ matterId: m.id, amount: 60, reason: "WAIVED" })
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    expect(ok).toBe(1);

    // 且落库的明细合计不超过未收
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOff: { matterId: m.id } } });
    const sum = items.reduce((n, i) => n + Number(i.amount), 0);
    expect(sum).toBeLessThanOrEqual(100);
  });

  it("**金额最多两位小数**（1.005 被拒，不静默舍入）", async () => {
    // 独立复核实测：Math.round(1.005*100)/100 = 1，若允许三位小数，
    // 会出现「明细合计 1.00、坏账落库 1.01」的跨表不一致。
    const m = await seedMatter();
    await addReceivable(m.id, 2, { dueDate: new Date("2026-01-01") });
    await expect(
      requestWriteOff({ matterId: m.id, amount: 1.005, reason: "WAIVED" })
    ).rejects.toThrow(/两位小数/);
  });

  it("**作废应收不参与**（100 未收 + 200 作废 → 报 300 被拒）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") });
    const cancelled = await addReceivable(m.id, 200, { dueDate: new Date("2025-01-01") });
    await prisma.receivable.update({ where: { id: cancelled.id }, data: { status: "CANCELLED" } });

    await expect(
      requestWriteOff({ matterId: m.id, amount: 300, reason: "WAIVED" })
    ).rejects.toThrow(/可用未收额度/);
    // 100 仍可报，且明细不含作废条目
    const ok = await requestWriteOff({ matterId: m.id, amount: 100, reason: "WAIVED" });
    const items = await prisma.receivableWriteOffItem.findMany({ where: { writeOffId: ok.id } });
    expect(items).toHaveLength(1);
    expect(items[0].receivableId).not.toBe(cancelled.id);
  });

  it("**应收已全部结清时拒绝登记坏账**（不让账目说谎）", async () => {
    const m = await seedMatter();
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01"), settled: 100 });
    await expect(
      requestWriteOff({ matterId: m.id, amount: 10, reason: "WAIVED" })
    ).rejects.toThrow(/已全部结清或作废/);
  });

  it("**指定合同下无未收条目时拒绝**，提示改按整案申报", async () => {
    const m = await seedMatter();
    const b = await prisma.billing.create({
      data: { matterId: m.id, title: "空合同", contractAmount: new Prisma.Decimal(1000), status: "ACTIVE", moneyKind: "LAWYER_FEE" }
    });
    await addReceivable(m.id, 100, { dueDate: new Date("2026-01-01") }); // 不带 billingId

    await expect(
      requestWriteOff({ matterId: m.id, billingId: b.id, amount: 50, reason: "WAIVED" })
    ).rejects.toThrow(/该合同下没有未收应收条目/);
  });
});
