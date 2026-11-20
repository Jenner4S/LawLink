// @vitest-environment node
/**
 * 财务核销核心事务的真库测试（allocateLedgerTx）。实收确认/退回见
 * `finance-ledger-receipt.test.ts`（同类真库隔离，互不干扰）。
 *
 * 为什么用真库而不是 mock：价值全在 SQL 行为上——`FOR UPDATE` 的锁顺序、
 * `ON CONFLICT DO UPDATE` 的累加、`status=CASE WHEN` 的状态迁移、余额约束的最终把关。
 * 逐条 mock `$queryRaw` 只能证明「我 mock 的 SQL 被我断言到了」，证明不了钱怎么分。
 *
 * 隔离：每次运行建独立临时库 `lawlink_fin_test_*`（lawlink-db:55432），只跑
 * `prisma migrate deploy` 建结构，结束 DROP。**绝不写主库 lawlink。**
 * 前置条件：lawlink-db 容器可用（docker compose 的 55432 端口），否则本文件显式失败。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allocateLedgerTx } from "@/server/finance/ledger-mutations";
import { financeLedgerReady } from "@/server/finance/ledger-storage";

const PG_HOST = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
const PG_USER = process.env.FIN_TEST_PG_USER ?? "lawlink";
const PG_PASSWORD = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
const DB_NAME = `lawlink_fin_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const urlFor = (database: string) =>
  `postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}/${database}?schema=public`;

let admin: PrismaClient;
let prisma: PrismaClient;

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  // 并发 CREATE DATABASE 会撞模板库占用（「source database is being accessed by
  // other users」），表现为「重跑就过」的偶发红。这里退避重试；
  // 与 src/tests/helpers/temp-db.ts 同一处理（那 19 个文件已迁到 helper）。
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${DB_NAME}"`);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (/already exists/i.test(String(err))) { lastErr = undefined; break; }
      if (!/being accessed by other users|template/i.test(String(err))) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (lastErr) throw new Error(`临时库创建失败，需先启动 lawlink-db：${String(lastErr)}`);
  // 只建结构：0_init 基线 + 增量迁移，与全新安装同一路径（含财务余额约束与审计触发器）
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: urlFor(DB_NAME) },
    stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: urlFor(DB_NAME) });
  console.info(`[finance-ledger-allocation] 临时库：${DB_NAME}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[finance-ledger-allocation] 已 DROP 临时库：${DB_NAME}`);
  }
}, 60_000);

/* ------------------------------------------------------------------ *
 * 夹具：每条用例自建案件/用户/流水，不做全表清空（互不干扰，失败可复现）
 * ------------------------------------------------------------------ */
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

type Role = "FINANCE" | "LAWYER";

async function seedUser(role: Role = "FINANCE", active = true) {
  return prisma.user.create({
    data: { id: uid("u"), name: `测试${role}`, email: `${uid("mail")}@example.test`, passwordHash: "x", role, active }
  });
}

async function seedMatter(ownerId: string) {
  return prisma.matter.create({ data: { id: uid("m"), internalCode: uid("MS"), title: "核销测试案件", ownerId } });
}

/** 一笔已确认实收 = FeeEntry(RECEIVED, CONFIRMED) + Payment（两步制的产物，来源必须一致） */
async function seedReceipt(
  matterId: string,
  recordedById: string,
  amount: string,
  moneyKind: "LAWYER_FEE" | "CLIENT_FUNDS" | "EXPENSE_RECOVERY" | "OTHER" = "LAWYER_FEE",
  options: { entryConfirmed?: boolean; entryAmount?: string; entryMoneyKind?: typeof moneyKind } = {}
) {
  const confirmed = options.entryConfirmed !== false;
  const occurredAt = new Date("2026-11-01T10:00:00+08:00");
  const entry = await prisma.feeEntry.create({
    data: {
      id: uid("fe"), matterId, type: "RECEIVED", amount: new Prisma.Decimal(options.entryAmount ?? amount),
      moneyKind: options.entryMoneyKind ?? moneyKind, occurredAt, recordedById,
      confirmState: confirmed ? "CONFIRMED" : "PENDING",
      confirmedById: confirmed ? recordedById : null,
      confirmedAt: confirmed ? new Date("2026-11-01T11:00:00+08:00") : null
    }
  });
  const payment = await prisma.payment.create({ data: { id: uid("p"), matterId, feeEntryId: entry.id, amount: new Prisma.Decimal(amount), moneyKind, occurredAt, recordedById } });
  return { entry, payment };
}

async function seedReceivable(
  matterId: string,
  amount: string,
  options: { moneyKind?: "LAWYER_FEE" | "CLIENT_FUNDS"; status?: "OPEN" | "SETTLED" | "CANCELLED"; settledAmount?: string; title?: string } = {}
) {
  return prisma.receivable.create({
    data: {
      id: uid("ar"), matterId, title: options.title ?? "一审代理费", amount: new Prisma.Decimal(amount),
      settledAmount: new Prisma.Decimal(options.settledAmount ?? "0"),
      moneyKind: options.moneyKind ?? "LAWYER_FEE", status: options.status ?? "OPEN"
    }
  });
}

async function seedInvoice(
  matterId: string,
  requestedById: string,
  amount: string,
  status: "PENDING" | "APPROVED" | "ISSUED" | "REJECTED" = "ISSUED"
) {
  return prisma.invoiceRequest.create({ data: { id: uid("inv"), matterId, amount: new Prisma.Decimal(amount), status, requestedById } });
}

/** 与生产同一入口：事务内调用（Serializable 由调用方给，这里按 allocateLedger 的做法给上） */
function allocate(userId: string, input: Parameters<typeof allocateLedgerTx>[2]) {
  return prisma.$transaction(tx => allocateLedgerTx(tx, userId, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable
  });
}

const dec = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value).toFixed(2);
/** 读回当前落库状态（核销断言几乎都要看这三张表） */
const readPay = (id: string) => prisma.payment.findUniqueOrThrow({ where: { id } });
const readAr = (id: string) => prisma.receivable.findUniqueOrThrow({ where: { id } });
const allocationCount = (paymentId: string) => prisma.allocation.count({ where: { paymentId } });

describe("allocateLedgerTx · 拒绝路径（真库）", () => {
  it("revision 不匹配：拒绝且不留任何部分写入", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: payment.revision + 1, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("此笔实收已变化或请求已处理，请刷新后重试");

    const after = await readPay(payment.id);
    expect(after.revision).toBe(0);
    expect(dec(after.allocatedAmount)).toBe("0.00");
    expect(await allocationCount(payment.id)).toBe(0);
    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("0.00");
  });

  it("分配合计超过实收未核销余额：多项合计越界即拒绝（不是逐项判断）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar1 = await seedReceivable(matter.id, "5000.00", { title: "一审代理费" });
    const ar2 = await seedReceivable(matter.id, "5000.00", { title: "二审代理费" });

    await expect(
      allocate(user.id, {
        paymentId: payment.id,
        revision: 0,
        kind: "RECEIVABLE",
        // 每项都在各自余额内，合计 1200 超过实收余额 1000——只有合计校验能拦住
        items: [{ targetId: ar1.id, amount: "600" }, { targetId: ar2.id, amount: "600" }]
      })
    ).rejects.toThrow("分配合计超过实收未核销余额");

    expect(await allocationCount(payment.id)).toBe(0);
  });

  it("应收与实收不同案：同所不同案的应收不能被本案实收核销", async () => {
    const user = await seedUser();
    const mine = await seedMatter(user.id);
    const other = await seedMatter(user.id);
    const { payment } = await seedReceipt(mine.id, user.id, "1000.00");
    const foreign = await seedReceivable(other.id, "1000.00");

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: foreign.id, amount: "100" }] })
    ).rejects.toThrow("应收与实收不属于同一案件");

    const ar = await readAr(foreign.id);
    expect(dec(ar.settledAmount)).toBe("0.00");
  });

  it("款项性质不同：律师费实收不能核销代收款应收", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00", "LAWYER_FEE");
    const fund = await seedReceivable(matter.id, "1000.00", { moneyKind: "CLIENT_FUNDS", title: "代收诉讼费" });

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: fund.id, amount: "100" }] })
    ).rejects.toThrow("应收与实收须款项性质相同");

    expect(dec((await readAr(fund.id)).settledAmount)).toBe("0.00");
  });

  it("应收已作废：CANCELLED 应收不可再核销", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00", { status: "CANCELLED" });

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("应收已作废");
  });

  it("分配金额超过应收剩余余额：按 adjustmentAmount 后的剩余额判断，且边界两侧都能区分", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "5000.00");
    const ar = await seedReceivable(matter.id, "1000.00", { settledAmount: "300.00" });
    // 先补一笔历史核销，使「已核销余额」与「明细」两侧自洽（否则先撞一致性校验）
    await prisma.allocation.create({
      data: { id: uid("al"), paymentId: payment.id, receivableId: ar.id, amount: new Prisma.Decimal("300.00"), allocatedById: user.id }
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { allocatedAmount: new Prisma.Decimal("300.00") } });

    // 剩余 700：分 701 必拒
    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "701" }] })
    ).rejects.toThrow("分配金额超过应收剩余余额");
    expect(dec((await readAr(ar.id)).settledAmount)).toBe("300.00");

    // 恰好 700 通过（边界值不放行也不误拒），应收转 SETTLED
    await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "700" }] });
    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("1000.00");
    expect(arAfter.status).toBe("SETTLED");
  });

  it("来源流水未确认：Payment 与 FeeEntry 不一致时不得分配", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00", "LAWYER_FEE", { entryConfirmed: false });
    const ar = await seedReceivable(matter.id, "1000.00");

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("实收与已确认来源流水不一致，不能分配");
  });

  it("实收核销明细与余额不符：Payment.allocatedAmount 与 Allocation 合计背离时先拒绝", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    // 直接造一条 Allocation，但不回写 Payment.allocatedAmount（模拟历史脏数据）
    await prisma.allocation.create({
      data: { id: uid("al"), paymentId: payment.id, receivableId: ar.id, amount: new Prisma.Decimal("100.00"), allocatedById: user.id }
    });

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("实收核销明细与余额不符，请先核对");
  });

  it("应收核销明细与余额不符：Allocation 合计与 settledAmount 背离时先拒绝", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    await prisma.allocation.create({
      data: { id: uid("al"), paymentId: payment.id, receivableId: ar.id, amount: new Prisma.Decimal("100.00"), allocatedById: user.id }
    });
    // 让实收侧自洽（allocatedAmount=100），应收侧背离（settledAmount 仍为 0）
    await prisma.payment.update({ where: { id: payment.id }, data: { allocatedAmount: new Prisma.Decimal("100.00") } });

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("应收核销明细与余额不符，请先核对");
  });

  it("非本案关联人且非全所财务：案件级授权拦在余额判断之前", async () => {
    const finance = await seedUser("FINANCE");
    const outsider = await seedUser("LAWYER");
    const matter = await seedMatter(finance.id); // 主办是别人
    const { payment } = await seedReceipt(matter.id, finance.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");

    await expect(
      allocate(outsider.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("案件不存在或无权处理");
  });

  it("账号已停用：停用后即使持有财务岗也不能分配", async () => {
    const user = await seedUser("FINANCE");
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    await prisma.user.update({ where: { id: user.id }, data: { active: false } });

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] })
    ).rejects.toThrow("账号已停用或不存在");
  });
});

describe("allocateLedgerTx · 成功路径（真库）", () => {
  it("部分核销：应收保持 OPEN、实收转 PARTIAL、revision 各 +1、Allocation 落一条、审计同事务", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "2000.00");

    const result = await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "400" }] });
    expect(result).toEqual({ matterId: matter.id });

    const payAfter = await readPay(payment.id);
    expect(dec(payAfter.allocatedAmount)).toBe("400.00");
    expect(payAfter.status).toBe("PARTIAL");
    expect(payAfter.revision).toBe(1);

    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("400.00");
    expect(arAfter.status).toBe("OPEN");
    expect(arAfter.revision).toBe(1);

    const rows = await prisma.allocation.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1);
    expect(dec(rows[0].amount)).toBe("400.00");
    expect(rows[0].receivableId).toBe(ar.id);
    expect(rows[0].allocatedById).toBe(user.id);

    const audits = await prisma.auditLog.findMany({ where: { targetType: "Payment", targetId: payment.id, action: "FINANCE_ALLOCATION" } });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(user.id);
  });

  it("核销到满额：应收 → SETTLED、实收 → FULLY_ALLOCATED", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1500.00");
    const ar = await seedReceivable(matter.id, "1500.00");

    await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "1500.00" }] });

    const payAfter = await readPay(payment.id);
    expect(dec(payAfter.allocatedAmount)).toBe("1500.00");
    expect(payAfter.status).toBe("FULLY_ALLOCATED");

    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("1500.00");
    expect(arAfter.status).toBe("SETTLED");
  });

  it("一次分配多项应收：逐项落 Allocation、实收合计只加一次、revision 只 +1", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar1 = await seedReceivable(matter.id, "600.00", { title: "一审代理费" });
    const ar2 = await seedReceivable(matter.id, "600.00", { title: "差旅垫付" });

    await allocate(user.id, {
      paymentId: payment.id,
      revision: 0,
      kind: "RECEIVABLE",
      items: [{ targetId: ar1.id, amount: "600" }, { targetId: ar2.id, amount: "300" }]
    });

    expect(dec((await readAr(ar1.id)).settledAmount)).toBe("600.00");
    expect((await readAr(ar1.id)).status).toBe("SETTLED");
    expect(dec((await readAr(ar2.id)).settledAmount)).toBe("300.00");
    expect((await readAr(ar2.id)).status).toBe("OPEN");

    const payAfter = await readPay(payment.id);
    expect(dec(payAfter.allocatedAmount)).toBe("900.00");
    expect(payAfter.status).toBe("PARTIAL");
    expect(payAfter.revision).toBe(1);
    expect(await allocationCount(payment.id)).toBe(2);
  });

  it("同一对实收/应收分两次核销：Allocation 单行累加（ON CONFLICT），revision 逐次递增", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");

    await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "300" }] });
    await allocate(user.id, { paymentId: payment.id, revision: 1, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "300" }] });

    const rows = await prisma.allocation.findMany({ where: { paymentId: payment.id } });
    expect(rows).toHaveLength(1); // 唯一键 (paymentId, receivableId) 合并为一行
    expect(dec(rows[0].amount)).toBe("600.00");

    const payAfter = await readPay(payment.id);
    expect(payAfter.revision).toBe(2);
    expect(dec(payAfter.allocatedAmount)).toBe("600.00");
    expect(dec((await readAr(ar.id)).settledAmount)).toBe("600.00");
  });

  it("带调整额的应收：按 amount+adjustmentAmount 判定 SETTLED", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "800.00");
    const ar = await seedReceivable(matter.id, "1000.00");
    await prisma.receivable.update({ where: { id: ar.id }, data: { adjustmentAmount: new Prisma.Decimal("-200.00") } });

    await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "800" }] });

    const arAfter = await readAr(ar.id);
    expect(dec(arAfter.settledAmount)).toBe("800.00");
    expect(arAfter.status).toBe("SETTLED"); // 800 = 1000 + (-200)
  });
});

describe("allocateLedgerTx · 票据关联分支（kind=INVOICE，真库）", () => {
  it("非律师费实收不能关联票据", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00", "CLIENT_FUNDS");
    const invoice = await seedInvoice(matter.id, user.id, "1000.00");

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "INVOICE", items: [{ targetId: invoice.id, amount: "100" }] })
    ).rejects.toThrow("目前票款关联仅支持律师费实收");
  });

  it("发票状态非 ISSUED 不能关联实收（APPROVED 仍未开具）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const invoice = await seedInvoice(matter.id, user.id, "1000.00", "APPROVED");

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "INVOICE", items: [{ targetId: invoice.id, amount: "100" }] })
    ).rejects.toThrow("只有已开具发票可以关联实收");
  });

  it("分配金额超过发票未关联金额：按已关联额扣减后判断", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const invoice = await seedInvoice(matter.id, user.id, "500.00");

    await expect(
      allocate(user.id, { paymentId: payment.id, revision: 0, kind: "INVOICE", items: [{ targetId: invoice.id, amount: "500.01" }] })
    ).rejects.toThrow("分配金额超过发票未关联金额");
  });

  it("成功关联：InvoicePaymentAllocation 落一条、Payment 只涨 revision 不涨 allocatedAmount", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const invoice = await seedInvoice(matter.id, user.id, "600.00");

    await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "INVOICE", items: [{ targetId: invoice.id, amount: "600.00" }] });

    const links = await prisma.invoicePaymentAllocation.findMany({ where: { paymentId: payment.id } });
    expect(links).toHaveLength(1);
    expect(dec(links[0].amount)).toBe("600.00");
    expect(links[0].invoiceId).toBe(invoice.id);
    expect(links[0].matterId).toBe(matter.id);
    expect(links[0].recordedById).toBe(user.id);

    const payAfter = await readPay(payment.id);
    expect(payAfter.revision).toBe(1);
    expect(dec(payAfter.allocatedAmount)).toBe("0.00");
    expect(await allocationCount(payment.id)).toBe(0);

    const audits = await prisma.auditLog.findMany({ where: { targetId: payment.id, action: "FINANCE_INVOICE_ALLOCATION" } });
    expect(audits).toHaveLength(1);
  });
});

describe("allocateLedgerTx · 并发与锁顺序（真库）", () => {
  /**
   * 轮询 pg_locks，等**本次 holder** 真正拿到授权锁。
   *
   * 2026-11-20 修 flaky：原实现只判「库里有这个 advisory lock 且 granted」，
   * 而锁键 72606101 是模块共用常量 —— `setCommissionPlan` 等**其他测试文件**
   * 也取同一把锁。全量并行时若别处正持锁，本函数会**误判为 holder 已就绪**
   * 而提前返回，随后 attempt 可能真的拿到锁 → `rejects.toThrow` 间歇性失败。
   *
   * 现在按 holder 自己的 backend pid 过滤，只认「我这一个连接拿到了锁」。
   */
  async function waitForAdvisoryLock(holderPid: () => number, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pid = holderPid();
      if (pid > 0) {
        const [row] = await prisma.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted AND objid = 72606101 AND pid = ${pid}`;
        if (row.n > 0) return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("等待授权锁超时：并发夹具未能取得 pg_advisory_xact_lock");
  }

  it("授权锁互斥：另一事务持锁时本轮核销排队等待，超时整体回滚（不留半笔核销）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // holder 的 backend pid：用来确认「是这条连接拿到了锁」，而不是别处
    let holderBackendPid = 0;
    const holder = prisma.$transaction(async tx => {
      const [me] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
      holderBackendPid = me.pid;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(72606101)`;
      await gate; // 持锁不放，模拟另一笔核销正在进行
    });

    try {
      await waitForAdvisoryLock(() => holderBackendPid);
      const attempt = prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL lock_timeout = 300`;
        return allocateLedgerTx(tx, user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] });
      });
      await expect(attempt).rejects.toThrow(/lock timeout/i);
    } finally {
      release();
      await holder;
    }

    // 排队失败的那笔不得留下任何痕迹：锁未取到就不该有余额变动
    const payAfter = await readPay(payment.id);
    expect(payAfter.revision).toBe(0);
    expect(dec(payAfter.allocatedAmount)).toBe("0.00");
    expect(await allocationCount(payment.id)).toBe(0);
    expect(dec((await readAr(ar.id)).settledAmount)).toBe("0.00");
  });

  it("锁释放后同一请求正常完成：证明失败原因是锁等待而非业务拒绝", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const { payment } = await seedReceipt(matter.id, user.id, "1000.00");
    const ar = await seedReceivable(matter.id, "1000.00");

    await allocate(user.id, { paymentId: payment.id, revision: 0, kind: "RECEIVABLE", items: [{ targetId: ar.id, amount: "100" }] });
    expect((await readPay(payment.id)).revision).toBe(1);
  });
});

describe("真库夹具自检", () => {
  it("临时库通过 financeLedgerReady：表/约束/列三项就绪条件全满足", async () => {
    // 若 0_init 缺表、缺命名约束或缺列，allocateLedgerTx 会在第一步抛
    // 「应收与收款分配尚未启用」，上面所有用例都会以错误文案失败。这里显式断言
    // 就绪判定，避免把环境问题误读成业务实现问题。
    expect(await financeLedgerReady(prisma)).toBe(true);
  });
});
