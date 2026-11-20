/**
 * 案件财务的**无会话核心计算**（2026-11-20）
 *
 * 为什么单独成文件：门户要显示账单金额，而方案 §七 Q2 有一条硬约束——
 * **金额必须与财务模块同一数据源**。客户拿门户截图来对账，两处不一致就是信任崩塌的开始。
 *
 * 但 `getMatterFinance` 第一句就是 `requireSession("finance.read")`，
 * 门户侧（外部客户、无员工会话）根本调不了它。若门户另写一套 FeeEntry 求和，
 * 就是"两个地方各算一遍"——那正是 Q2 要避免的。
 *
 * 所以把**计算**与**权限**拆开：
 *   · 本文件只算，不判权限；
 *   · `getMatterFinance` 判完权限后调用它（行为与拆分前完全一致）；
 *   · 门户侧判完 `PortalShare` 后也调用它。
 * 于是「同一个金额」由同一段代码产出，而不是两段看起来一样的代码。
 *
 * ⚠️ 本函数不做任何权限判断。调用方必须先完成自己的鉴权。
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getFinanceFacts, sumAmounts } from "@/server/finance/facts";
import { serializeDecimals } from "@/lib/decimal";
import { computeContingencyAccruals, sumContingencyAccruals } from "./contingency";

export async function computeMatterFinanceFacts(matterId: string) {
  const [billings, entries, plans, issuedInvoices, writeOffs] = await Promise.all([
    prisma.billing.findMany({
      where: { matterId },
      orderBy: { createdAt: "desc" }
    }),
    prisma.feeEntry.findMany({
      where: { matterId },
      orderBy: { occurredAt: "desc" },
      include: {
        beneficiaryUser: { select: { id: true, name: true } },
        parentFeeEntry: { select: { id: true, type: true } }
      }
    }),
    prisma.commissionPlan.findMany({
      where: { matterId },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { createdAt: "asc" }
    }),
    // 开票金额：已开具发票合计（净额口径——扣减红冲/折让/换开调整，与对账页一致）
    prisma.invoiceRequest.findMany({
      where: { matterId, status: "ISSUED" },
      // 票据展示字段一并取出：门户账单要列表（号/金额/开票日），
      // 让两侧拿同一份数据，而不是门户再查一遍（那正是 Q2 要避免的）
      select: { id: true, amount: true, invoiceNo: true, issuedAt: true }
    }),
    // 2026-11-22 P0-5：已批准坏账（只有 APPROVED 才扣减未收余额）
    prisma.receivableWriteOff.findMany({
      where: { matterId, status: "APPROVED" },
      select: { id: true, amount: true, reason: true, note: true, decidedAt: true }
    })
  ]);

  // 2026-11-20（A10 修复）：金额累加一律走 Decimal。
  //
  // 原实现是 `acc + Number(e.amount)` —— 每项先转 IEEE-754 双精度再累加。
  // 实测 100 笔 1234.56 会得到 123455.99999999984（Decimal 累加是 123456）。
  // 误差虽小，但同一系统里「有的地方用 Decimal 累加、有的地方用 float 累加」
  // 本身就是不一致：合计值与明细之和对不上时，没人能一眼判断哪个对。
  // 这里改为与 sumAmounts 相同的做法——Decimal 累加，最后才 toNumber()。
  const sum = (filter: (e: (typeof entries)[number]) => boolean) =>
    entries.filter(filter).reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0)).toNumber();

  let invoiceAdjustmentTotal = 0;
  try {
    const rows = await prisma.invoiceAdjustment.groupBy({
      by: ["invoiceId"],
      _sum: { amount: true },
      where: { invoice: { matterId } }
    });
    invoiceAdjustmentTotal = rows.reduce((acc, r) => acc.plus(r._sum.amount ?? 0), new Prisma.Decimal(0)).toNumber();
  } catch {
    // InvoiceAdjustment 表尚未迁移的库：无红冲能力，净额即票面
    invoiceAdjustmentTotal = 0;
  }
  const facts = await getFinanceFacts({id:matterId});
  // 旧口径（未升级库）：应收/实收均来自 FeeEntry，无独立「已核销」口径；
  // 回款进度分子退回已确认实收合计（与 received 同源），使进度 = 已收/应收，与升级前展示一致
  const legacyReceivable = sum((e) => e.type === "RECEIVABLE");
  const legacyReceived = sum((e) => e.type === "RECEIVED" && e.confirmState === "CONFIRMED");
  const stats = {
    outstanding: facts ? Number(facts.lawyerSummary.outstanding) : Math.max(0,legacyReceivable-legacyReceived),
    allocated: facts ? Number(facts.lawyerSummary.receivable)-Number(facts.lawyerSummary.outstanding) : legacyReceived,
    clientFunds: facts ? Number(facts.summary.clientFundsReceived) : 0,
    contractAmount: facts ? sumAmounts(facts.billings.filter(b=>b.signedAt&&b.moneyKind==='LAWYER_FEE').map(b=>({amount:b.contractAmount}))) : billings.filter(b=>b.signedAt).reduce((acc, b) => acc.plus(b.contractAmount), new Prisma.Decimal(0)).toNumber(),
    receivable: facts ? Number(facts.lawyerSummary.receivable) : legacyReceivable,
    received: facts ? Number(facts.lawyerSummary.netReceived) : legacyReceived,
    pendingReceived: sum((e) => e.type === "RECEIVED" && e.confirmState === "PENDING"),
    refund: facts ? sumAmounts(facts.refunds) : sum((e) => e.type === "REFUND"),
    cost: facts ? sumAmounts(facts.expenses.map(e=>({amount:e.amount.minus(e.reversed)}))) : sum((e) => e.type === "COST"),
    commission: facts ? sumAmounts(facts.commissions.map(c=>({amount:c.accrued}))) : sum((e) => e.type === "COMMISSION"),
    invoiced: issuedInvoices.reduce((acc, i) => acc.plus(i.amount), new Prisma.Decimal(0)).toNumber() - invoiceAdjustmentTotal,
    /**
     * 已批准坏账合计（2026-11-22 P0-5）。
     * **不减应收发生额**——应收是历史事实（合同签了多少），坏账是对事实的处置；
     * 混在一起就分不清「当初应收多少」与「后来免了多少」。
     */
    writeOff: writeOffs.reduce((n, w) => n + Number(w.amount), 0),
    /** 扣掉坏账后的未收余额（律师真正还能收的钱） */
    outstandingNet: Math.max(0, (facts ? Number(facts.lawyerSummary.outstanding) : Math.max(0, legacyReceivable - legacyReceived)) - writeOffs.reduce((n, w) => n + Number(w.amount), 0))
  };

  // 2026-11-22 P0-4：风险代理计提。金额不落库、按当前实收派生，
  // 并明确标注为估算（见 contingency.ts 文件头）。
  const contingencyPlans = computeContingencyAccruals(billings, stats.received);
  const contingency = { plans: contingencyPlans, total: sumContingencyAccruals(contingencyPlans) };

  return serializeDecimals({ billings, entries, plans, stats, invoices: issuedInvoices, contingency, writeOffs, ledgerReady:Boolean(facts) });
}
