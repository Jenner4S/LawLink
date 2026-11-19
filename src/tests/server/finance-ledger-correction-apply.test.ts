// @vitest-environment node
/**
 * applyCorrectionPlan（账务更正计划应用）的真库测试。
 *
 * 为什么用真库：它靠**唯一约束**防重复应用（`FinanceCorrectionEffect` 上
 * `(correctionId, paymentId/receivableId/allocationId/invoiceAllocationId/commissionEntryId/expenseEntryId)`
 * 各一条），靠 `status=CASE WHEN …` 迁移 Payment/Receivable 状态，靠数据库余额约束
 * (`Payment_balance_check` / `Receivable_balance_check` / `Allocation_balance_check`)
 * 兜住越界。mock 掉这些就是把「钱怎么动」换成「我 mock 了什么」。
 *
 * 计划本身由生产线 `correctionPlan` 在同一个事务里算出（与 decideCorrectionTx 同序），
 * 只有「事务内无幂等键」「refundTarget 与计划不一致」两类边界用手工构造计划验证——
 * 因为生产路径构造不出它们，那不改变函数行为，只说明边界在哪。
 *
 * 隔离：临时库 `lawlink_fincorr_test_*`（lawlink-db:55432）→ `prisma migrate deploy`
 * → 结束 `DROP DATABASE … WITH (FORCE)`。**绝不写主库 lawlink。**
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_fincorr_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url, original };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { applyCorrectionPlan, correctionPlan } from "@/server/finance/ledger-corrections";
import { correctionInput } from "@/lib/finance/corrections";

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let admin: PrismaClient;
let prisma: PrismaClient;

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
  } catch (err) {
    throw new Error(`临时库创建失败，需先启动 lawlink-db（${HOLDER.host}）：${String(err)}`);
  }
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: HOLDER.url },
    stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  console.info(`[finance-ledger-correction-apply] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[finance-ledger-correction-apply] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const dec = (v: Prisma.Decimal | string | number | null | undefined) => (v === null || v === undefined ? null : new Prisma.Decimal(v).toFixed(2));

const OCCURRED = new Date("2026-11-01T10:00:00+08:00");
const LATER = new Date("2026-11-05T10:00:00+08:00");

async function seedBase() {
  const user = await prisma.user.create({
    data: { id: uid("u"), name: "更正测试财务", email: `${uid("mail")}@example.test`, passwordHash: "x", role: "FINANCE" }
  });
  const client = await prisma.client.create({ data: { id: uid("c"), name: `更正当事人${uid("N")}`, type: "INDIVIDUAL" } });
  const matter = await prisma.matter.create({
    data: { id: uid("m"), internalCode: uid("MS"), title: "更正测试案件", ownerId: user.id, primaryClientId: client.id }
  });
  return { user, matter };
}

/** 一笔已确认实收（FeeEntry RECEIVED CONFIRMED + Payment），来源必须一致 */
async function seedReceipt(matterId: string, userId: string, amount: string, moneyKind: "LAWYER_FEE" | "CLIENT_FUNDS" = "LAWYER_FEE") {
  const entry = await prisma.feeEntry.create({
    data: {
      id: uid("fe"), matterId, type: "RECEIVED", amount: D(amount), moneyKind, occurredAt: OCCURRED,
      recordedById: userId, confirmState: "CONFIRMED", confirmedById: userId, confirmedAt: OCCURRED
    }
  });
  const payment = await prisma.payment.create({
    data: { id: uid("p"), matterId, feeEntryId: entry.id, amount: D(amount), moneyKind, occurredAt: OCCURRED, recordedById: userId }
  });
  return { entry, payment };
}

async function seedReceivable(matterId: string, amount: string, settledAmount = "0") {
  return prisma.receivable.create({
    data: {
      id: uid("ar"), matterId, title: "一审代理费", amount: D(amount), settledAmount: D(settledAmount),
      moneyKind: "LAWYER_FEE", status: "OPEN"
    }
  });
}

/** 核销关系 + 双侧冗余余额（Allocation 明细合计必须等于 Payment.allocatedAmount、Receivable.settledAmount） */
async function seedAllocation(paymentId: string, receivableId: string, amount: string, userId: string) {
  const allocation = await prisma.allocation.create({
    data: { id: uid("al"), paymentId, receivableId, amount: D(amount), allocatedById: userId }
  });
  await prisma.payment.update({ where: { id: paymentId }, data: { allocatedAmount: D(amount), status: "FULLY_ALLOCATED" } });
  await prisma.receivable.update({ where: { id: receivableId }, data: { settledAmount: D(amount), status: "SETTLED" } });
  return allocation;
}

async function seedInvoiceLink(matterId: string, paymentId: string, invoiceAmount: string, linked: string, userId: string) {
  const invoice = await prisma.invoiceRequest.create({
    data: { id: uid("inv"), matterId, amount: D(invoiceAmount), status: "ISSUED", requestedById: userId }
  });
  const link = await prisma.invoicePaymentAllocation.create({
    data: { id: uid("ipa"), matterId, invoiceId: invoice.id, paymentId, amount: D(linked), recordedById: userId }
  });
  return { invoice, link };
}

/**
 * 一条待确认更正记录（applyCorrectionPlan 的效果行有外键指向它，
 * 且 `FinanceCorrection_subject_check` 要求 targetType 与三选一列一致）。
 */
async function seedCorrection(params: {
  matterId: string; userId: string; type: "REFUND" | "DISCOUNT" | "REVERSAL"; amount: string;
  targetId: string; target: "Payment" | "Receivable" | "FeeEntry";
}) {
  const column = params.target === "Payment" ? "paymentId" : params.target === "Receivable" ? "receivableId" : "feeEntryId";
  return prisma.financeCorrection.create({
    data: {
      id: uid("fc"), matterId: params.matterId, targetType: params.target, targetId: params.targetId,
      type: params.type, amount: D(params.amount), reason: "更正测试", createdById: params.userId,
      requestPayload: {}, occurredAt: LATER, [column]: params.targetId
    }
  });
}

type Plan = Awaited<ReturnType<typeof correctionPlan>>;
type Effect = Plan["effects"][number];

/** 与 decideCorrectionTx 同序：同一事务里算计划 → 应用计划 */
function planAndApply(
  matterId: string,
  correctionId: string,
  raw: Record<string, unknown>,
  refundTarget?: { id: string; amount: Prisma.Decimal }
) {
  return prisma.$transaction(async tx => {
    const data = correctionInput.parse(raw);
    const plan = await correctionPlan(tx, matterId, data);
    await applyCorrectionPlan(tx, correctionId, plan, refundTarget);
    return plan;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 });
}

const readPayment = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const readAr = (id: string) => prisma.receivable.findUniqueOrThrow({ where: { id } });
const readEntry = (id: string) => prisma.feeEntry.findUniqueOrThrow({ where: { id } });
const effectsOf = (correctionId: string) =>
  prisma.financeCorrectionEffect.findMany({ where: { correctionId }, orderBy: { effectKind: "asc" } });

/** 手工构造计划（生产路径构造不出的边界） */
const manualPlan = (overrides: Partial<Plan>): Plan => ({
  snapshot: "manual", effects: [], arReversed: new Map(), arAdjusted: new Map(),
  paymentReversed: new Map(), touchedPayments: new Set(), ...overrides
} as Plan);
const effect = (e: Partial<Effect>): Effect => ({ kind: "PAYMENT_REFUND", column: "paymentId", id: "", delta: D(0), ...e } as Effect);

describe("applyCorrectionPlan · 退款（REFUND）", () => {
  it("部分退款：核销撤回、票款撤回、实收退款额与状态、应收余额与状态、效果行全部落库", async () => {
    const { user, matter } = await seedBase();
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    const allocation = await seedAllocation(payment.id, ar.id, "1000.00", user.id);
    const { link } = await seedInvoiceLink(matter.id, payment.id, "1000.00", "400.00", user.id);
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REFUND", amount: "200.00", targetId: payment.id, target: "Payment" });

    const plan = await planAndApply(matter.id, correction.id, {
      targetId: payment.id, revision: 0, type: "REFUND", amount: "200.00", occurredAt: LATER,
      reason: "客户退费", voucherReference: "退-001",
      allocationReversals: [{ targetId: allocation.id, amount: "200.00" }],
      invoiceReversals: [{ targetId: link.id, amount: "100.00" }]
    }, { id: payment.id, amount: D("200.00") });

    // 计划本身的三项效果（退款 + 两类撤回）
    expect(plan.effects.map(e => e.kind).sort()).toEqual([
      "ALLOCATION_REVERSAL", "INVOICE_ALLOCATION_REVERSAL", "PAYMENT_REFUND"
    ]);
    expect(plan.touchedPayments.has(payment.id)).toBe(true);

    const effects = await effectsOf(correction.id);
    expect(effects).toHaveLength(3);
    const byKind = new Map(effects.map(e => [e.effectKind, e]));
    expect(dec(byKind.get("ALLOCATION_REVERSAL")!.delta)).toBe("200.00");
    expect(byKind.get("ALLOCATION_REVERSAL")!.allocationId).toBe(allocation.id);
    expect(dec(byKind.get("INVOICE_ALLOCATION_REVERSAL")!.delta)).toBe("100.00");
    expect(byKind.get("INVOICE_ALLOCATION_REVERSAL")!.invoiceAllocationId).toBe(link.id);
    expect(dec(byKind.get("PAYMENT_REFUND")!.delta)).toBe("200.00");
    expect(byKind.get("PAYMENT_REFUND")!.paymentId).toBe(payment.id);

    // 撤回落到关联表
    const allocationAfter = await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } });
    expect(dec(allocationAfter.reversedAmount)).toBe("200.00");
    const linkAfter = await prisma.invoicePaymentAllocation.findUniqueOrThrow({ where: { id: link.id } });
    expect(dec(linkAfter.reversedAmount)).toBe("100.00");
    expect(linkAfter.revision).toBe(1);

    // 实收：已核销 −200、已退 +200，800 = 1000 − 0 − 200 → 全额核销
    const paymentAfter = await readPayment(payment.id);
    expect(dec(paymentAfter.allocatedAmount)).toBe("800.00");
    expect(dec(paymentAfter.refundedAmount)).toBe("200.00");
    expect(paymentAfter.status).toBe("FULLY_ALLOCATED");
    expect(paymentAfter.revision).toBe(1);

    // 应收：已核销 −200，有效额仍 1000 → 未结清
    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("800.00");
    expect(dec(arAfter.adjustmentAmount)).toBe("0.00");
    expect(arAfter.status).toBe("OPEN");
    expect(arAfter.revision).toBe(1);
  });

  it("全额冲销（REVERSAL）：实收变为未核销、应收回到未结清（口径记录：无 REFUNDED 状态）", async () => {
    const { user, matter } = await seedBase();
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    const allocation = await seedAllocation(payment.id, ar.id, "1000.00", user.id);
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REVERSAL", amount: "1000.00", targetId: payment.id, target: "Payment" });

    await planAndApply(matter.id, correction.id, {
      targetId: payment.id, revision: 0, type: "REVERSAL", amount: "1000.00", occurredAt: LATER,
      reason: "误录冲销", voucherReference: "冲-001",
      allocationReversals: [{ targetId: allocation.id, amount: "1000.00" }]
    }, { id: payment.id, amount: D("1000.00") });

    const paymentAfter = await readPayment(payment.id);
    // CASE：allocated − reversal = 0 → UNALLOCATED（枚举里没有「已退款」态，靠 refundedAmount 表达）
    expect(paymentAfter.status).toBe("UNALLOCATED");
    expect(dec(paymentAfter.allocatedAmount)).toBe("0.00");
    expect(dec(paymentAfter.refundedAmount)).toBe("1000.00");

    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("0.00");
    expect(arAfter.status).toBe("OPEN");
  });

  it("分成调整：退款按分成基数比例生成负向调整，并 bump 分成计提 revision", async () => {
    const { user, matter } = await seedBase();
    const { entry, payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    const allocation = await seedAllocation(payment.id, ar.id, "1000.00", user.id);
    const commission = await prisma.feeEntry.create({
      data: {
        id: uid("cm"), matterId: matter.id, type: "COMMISSION", amount: D("100.00"), moneyKind: "LAWYER_FEE",
        occurredAt: OCCURRED, parentFeeEntryId: entry.id, beneficiaryUserId: user.id, recordedById: user.id,
        commissionRateSnapshot: D("10.00"), commissionBaseSnapshot: D("1000.00"), confirmState: "CONFIRMED"
      }
    });
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REFUND", amount: "300.00", targetId: payment.id, target: "Payment" });

    const plan = await planAndApply(matter.id, correction.id, {
      targetId: payment.id, revision: 0, type: "REFUND", amount: "300.00", occurredAt: LATER,
      reason: "部分退费", voucherReference: "退-002",
      allocationReversals: [{ targetId: allocation.id, amount: "300.00" }]
    }, { id: payment.id, amount: D("300.00") });

    const commissionEffect = plan.effects.find(e => e.kind === "COMMISSION_ADJUSTMENT");
    expect(commissionEffect).toBeDefined();
    // 100 × 300/1000 = 30，调整额记负数（要冲回的分成）
    expect(dec(commissionEffect!.delta)).toBe("-30.00");
    expect(commissionEffect!.id).toBe(commission.id);

    const stored = (await effectsOf(correction.id)).find(e => e.effectKind === "COMMISSION_ADJUSTMENT")!;
    expect(dec(stored.delta)).toBe("-30.00");
    expect(stored.commissionEntryId).toBe(commission.id);
    // 计提行的 revision 递增，供后续结算的乐观锁比对
    expect((await readEntry(commission.id)).revision).toBe(1);
  });

  it("重复提交同一条更正（走生产入口）：被 revision 挡在计划阶段，账目不会二次扣减", async () => {
    const { user, matter } = await seedBase();
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    const allocation = await seedAllocation(payment.id, ar.id, "1000.00", user.id);
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REFUND", amount: "200.00", targetId: payment.id, target: "Payment" });
    const raw = {
      targetId: payment.id, revision: 0, type: "REFUND", amount: "200.00", occurredAt: LATER,
      reason: "客户退费", voucherReference: "退-003",
      allocationReversals: [{ targetId: allocation.id, amount: "200.00" }]
    };

    await planAndApply(matter.id, correction.id, raw, { id: payment.id, amount: D("200.00") });
    // 第二次：实收已因第一次应用 revision+1，correctionPlan 的乐观锁先把它拦下
    await expect(
      planAndApply(matter.id, correction.id, raw, { id: payment.id, amount: D("200.00") })
    ).rejects.toThrow("目标账务已变化，请刷新后重新申请");

    expect(dec((await readPayment(payment.id)).refundedAmount)).toBe("200.00");
    expect(dec((await readPayment(payment.id)).allocatedAmount)).toBe("800.00");
    expect(dec((await readAr(ar.id)).settledAmount)).toBe("800.00");
    // 一次退款计划写两条效果行：核销撤回 + 退款
    expect(await effectsOf(correction.id)).toHaveLength(2);
  });

  it("直接对同一份计划二次应用：效果行唯一约束拒绝，余额不被二次扣减", async () => {
    const { user, matter } = await seedBase();
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    const allocation = await seedAllocation(payment.id, ar.id, "1000.00", user.id);
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REFUND", amount: "200.00", targetId: payment.id, target: "Payment" });

    // 一次性算出计划（模拟「同一份计划被应用两次」——绕过 correctionPlan 的 revision 复核）
    const plan = await prisma.$transaction(tx => correctionPlan(tx, matter.id, correctionInput.parse({
      targetId: payment.id, revision: 0, type: "REFUND", amount: "200.00", occurredAt: LATER,
      reason: "客户退费", voucherReference: "退-006",
      allocationReversals: [{ targetId: allocation.id, amount: "200.00" }]
    })), { isolationLevel: "Serializable" });

    await prisma.$transaction(tx => applyCorrectionPlan(tx, correction.id, plan, { id: payment.id, amount: D("200.00") }), { isolationLevel: "Serializable" });
    const err = await prisma.$transaction(tx => applyCorrectionPlan(tx, correction.id, plan, { id: payment.id, amount: D("200.00") }), { isolationLevel: "Serializable" })
      .then(() => null, (e: unknown) => e);

    // FinanceCorrectionEffect 的 (correctionId, allocationId) 唯一索引是这里唯一的幂等键
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Error).message).toMatch(/23505|Unique constraint/i);

    expect(dec((await readPayment(payment.id)).refundedAmount)).toBe("200.00");
    expect(dec((await readPayment(payment.id)).allocatedAmount)).toBe("800.00");
    expect(dec((await readAr(ar.id)).settledAmount)).toBe("800.00");
    expect(dec((await prisma.allocation.findUniqueOrThrow({ where: { id: allocation.id } })).reversedAmount)).toBe("200.00");
    expect(await effectsOf(correction.id)).toHaveLength(2);
  });
});

describe("applyCorrectionPlan · 折让（DISCOUNT）与支出冲销", () => {
  it("折让：只调整应收有效额，把应收推进到已结清，不碰实收", async () => {
    const { user, matter } = await seedBase();
    const { payment } = await seedReceipt(matter.id, user.id, "700.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    await seedAllocation(payment.id, ar.id, "700.00", user.id);
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "DISCOUNT", amount: "300.00", targetId: ar.id, target: "Receivable" });

    const plan = await planAndApply(matter.id, correction.id, {
      targetId: ar.id, revision: 0, type: "DISCOUNT", amount: "300.00", occurredAt: LATER,
      reason: "结案折让", voucherReference: "折-001"
    });

    expect(plan.touchedPayments.size).toBe(0);
    expect(plan.effects.map(e => e.kind)).toEqual(["RECEIVABLE_ADJUSTMENT"]);
    expect(dec(plan.effects[0].delta)).toBe("-300.00");

    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.adjustmentAmount)).toBe("-300.00");
    expect(dec(arAfter.settledAmount)).toBe("700.00");
    expect(arAfter.status).toBe("SETTLED");
    expect(arAfter.revision).toBe(1);

    const paymentAfter = await readPayment(payment.id);
    expect(dec(paymentAfter.refundedAmount)).toBe("0.00");
    expect(paymentAfter.revision).toBe(0); // 折让不动实收
  });

  it("支出冲销：记效果行并 bump 支出 revision", async () => {
    const { user, matter } = await seedBase();
    const expense = await prisma.feeEntry.create({
      data: {
        id: uid("fe-cost"), matterId: matter.id, type: "COST", amount: D("500.00"), moneyKind: "EXPENSE_RECOVERY",
        occurredAt: OCCURRED, recordedById: user.id, confirmState: "CONFIRMED"
      }
    });
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REVERSAL", amount: "500.00", targetId: expense.id, target: "FeeEntry" });

    await planAndApply(matter.id, correction.id, {
      targetKind: "EXPENSE", targetId: expense.id, revision: 0, type: "REVERSAL", amount: "500.00",
      occurredAt: LATER, reason: "支出录错", voucherReference: "冲-002"
    });

    const effects = await effectsOf(correction.id);
    expect(effects).toHaveLength(1);
    expect(effects[0].effectKind).toBe("EXPENSE_REVERSAL");
    expect(dec(effects[0].delta)).toBe("500.00");
    expect(effects[0].expenseEntryId).toBe(expense.id);
    expect((await readEntry(expense.id)).revision).toBe(1);
  });
});

describe("applyCorrectionPlan · 边界（计划层面的缺口）", () => {
  it("refundTarget 金额与计划 delta 不一致：以 refundTarget 写退款额，效果行仍记计划金额", async () => {
    const { user, matter } = await seedBase();
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REFUND", amount: "200.00", targetId: payment.id, target: "Payment" });

    // 计划说退 200，调用方传 150（两者都能通过数据库余额约束，所以不会报错）
    await planAndApply(matter.id, correction.id, {
      targetId: payment.id, revision: 0, type: "REFUND", amount: "200.00", occurredAt: LATER,
      reason: "退费", voucherReference: "退-004"
    }, { id: payment.id, amount: D("150.00") });

    const paymentAfter = await readPayment(payment.id);
    const effect = (await effectsOf(correction.id)).find(e => e.effectKind === "PAYMENT_REFUND")!;
    expect(dec(paymentAfter.refundedAmount)).toBe("150.00"); // 实收按 refundTarget
    expect(dec(effect.delta)).toBe("200.00");                // 效果行按计划
    // 两者不一致不会被函数拦下（见报告「可疑逻辑」第 3 条：applyCorrectionPlan 不校验一致性）
  });

  it("refundTarget 指向未被计划触碰的实收：退款被静默丢弃，效果行仍然记了退款", async () => {
    const { user, matter } = await seedBase();
    const { payment: a } = await seedReceipt(matter.id, user.id, "500.00");
    const { payment: b } = await seedReceipt(matter.id, user.id, "800.00");
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "REFUND", amount: "200.00", targetId: a.id, target: "Payment" });

    await planAndApply(matter.id, correction.id, {
      targetId: a.id, revision: 0, type: "REFUND", amount: "200.00", occurredAt: LATER,
      reason: "退费", voucherReference: "退-005"
    }, { id: b.id, amount: D("200.00") });

    expect(dec((await readPayment(a.id)).refundedAmount)).toBe("0.00");
    expect(dec((await readPayment(b.id)).refundedAmount)).toBe("0.00");
    const effect = (await effectsOf(correction.id)).find(e => e.effectKind === "PAYMENT_REFUND")!;
    expect(dec(effect.delta)).toBe("200.00");
    expect(effect.paymentId).toBe(a.id);
  });

  it("计划越界（应收调整额超有效额）不被函数拦下，由数据库余额约束兜底回滚", async () => {
    const { user, matter } = await seedBase();
    const ar = await seedReceivable(matter.id, "1000.00");
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "DISCOUNT", amount: "5000.00", targetId: ar.id, target: "Receivable" });

    const plan = manualPlan({
      effects: [effect({ kind: "RECEIVABLE_ADJUSTMENT", column: "receivableId", id: ar.id, delta: D("-5000.00") })],
      arAdjusted: new Map([[ar.id, D("-5000.00")]])
    });
    const err = await prisma.$transaction(tx => applyCorrectionPlan(tx, correction.id, plan), { isolationLevel: "Serializable" })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as Error).message).toContain("Receivable_balance_check");
    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.adjustmentAmount)).toBe("0.00");
    expect(await effectsOf(correction.id)).toHaveLength(0);
  });

  it("计划没有效果行时没有幂等键：连调两次会重复叠加调整额", async () => {
    const { user, matter } = await seedBase();
    const ar = await seedReceivable(matter.id, "1000.00");
    const correction = await seedCorrection({ matterId: matter.id, userId: user.id, type: "DISCOUNT", amount: "300.00", targetId: ar.id, target: "Receivable" });
    const plan = manualPlan({ arAdjusted: new Map([[ar.id, D("-300.00")]]) }); // effects 为空

    for (let round = 0; round < 2; round++) {
      await prisma.$transaction(tx => applyCorrectionPlan(tx, correction.id, plan), { isolationLevel: "Serializable" });
    }

    // 第一次 -300，第二次再叠 -300（没有效果行 → 唯一约束帮不上忙）
    expect(dec((await readAr(ar.id)).adjustmentAmount)).toBe("-600.00");
    expect(await effectsOf(correction.id)).toHaveLength(0);
    // 注：生产路径（decideCorrectionTx）算出的计划 effects 恒非空，故当前不可达；
    // 这是硬化缺口，见报告「可疑逻辑」第 2 条。
  });
});
