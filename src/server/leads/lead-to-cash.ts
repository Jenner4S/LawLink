/**
 * 线索到回款的闭环指标（2026-11-22）
 *
 * ## 补的是「最后一段连接」
 *
 * 获客漏斗只到「转收案」；钱的环节在财务侧。于是业主看到两个孤立的数：
 * 「这个月来了 40 条线索、成交 3 单」和「这个月回款 12 万」——
 * **两者之间没有关系**，没人能回答「这 12 万里有多少是本月线索带来的」。
 *
 * 这个函数把链路接起来：
 *   期间新增线索 → 转收案 → 有已签合同 → 已有回款
 *
 * ## 三条口径（都是"宁可少算，不可多算"）
 *
 * ① **只统计期间新增的线索**（`Lead.createdAt` 落在期间内）。
 *    否则"本期回款"里会混进去年线索的钱，回款率被历史抬价。
 * ② **签约只认已签署合同**（`Billing.signedAt` 非空）；
 *    只建了合同没签的，不算签约。
 * ③ **回款＝已确认实收减退款**，与财务页「已收」同源；
 *    不把"待确认到账"算进来——那是登记，不是到账。
 *
 * ## 明确不做什么
 *
 * · 不做「线索级 ROI」：一条线索可能转成一案多合同，逐条摊分只会制造争议；
 * · 不与财务台账对账替代：这里是**派生视图**，权威数仍在财务页与台账。
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type LeadToCash = {
  /** 期间新增线索数 */
  leadCount: number;
  /** 其中已转收案 */
  convertedCount: number;
  /** 其中已转收案且案件有**已签署**合同 */
  signedMatterCount: number;
  /** 其中已有已确认实收（回款） */
  paidMatterCount: number;
  /** 上述案件的已签合同额合计（律师费口径） */
  contractAmount: number;
  /** 上述案件的已确认净实收（实收 − 退款） */
  receivedAmount: number;
  /** 回款率 = 实收 / 签约额；签约额为 0 时为 null（不显示 0%） */
  collectionRate: number | null;
  /** 线索→回款转化率 = 已有回款的线索数 / 线索数；线索数为 0 时为 null */
  leadToCashRate: number | null;
};

const rate = (num: number, den: number): number | null =>
  den === 0 ? null : Math.round((num / den) * 1000) / 10;

export async function getLeadToCash(input: { start: Date; end: Date }): Promise<LeadToCash> {
  const { start, end } = input;

  const leads = await prisma.lead.findMany({
    where: { createdAt: { gte: start, lt: end } },
    select: { id: true, convertedIntakeId: true }
  });
  const leadCount = leads.length;
  const intakeIds = leads.map((l) => l.convertedIntakeId).filter((v): v is string => Boolean(v));
  const convertedCount = intakeIds.length;

  if (convertedCount === 0) {
    return {
      leadCount,
      convertedCount: 0,
      signedMatterCount: 0,
      paidMatterCount: 0,
      contractAmount: 0,
      receivedAmount: 0,
      collectionRate: null,
      leadToCashRate: null
    };
  }

  const matters = await prisma.matter.findMany({
    where: { intakeId: { in: intakeIds }, deletedAt: null },
    select: { id: true }
  });
  const matterIds = matters.map((m) => m.id);

  if (matterIds.length === 0) {
    return {
      leadCount,
      convertedCount,
      signedMatterCount: 0,
      paidMatterCount: 0,
      contractAmount: 0,
      receivedAmount: 0,
      collectionRate: null,
      leadToCashRate: null
    };
  }

  const [billingRows, feeRows] = await Promise.all([
    prisma.billing.findMany({
      where: { matterId: { in: matterIds }, signedAt: { not: null }, moneyKind: "LAWYER_FEE" },
      select: { matterId: true, contractAmount: true }
    }),
    prisma.feeEntry.findMany({
      where: {
        matterId: { in: matterIds },
        moneyKind: "LAWYER_FEE",
        confirmState: "CONFIRMED",
        type: { in: ["RECEIVED", "REFUND"] }
      },
      select: { matterId: true, type: true, amount: true }
    })
  ]);

  const signedMatterIds = new Set(billingRows.map((b) => b.matterId));
  const contractAmount = billingRows.reduce((n, b) => n + Number(b.contractAmount), 0);

  // 实收 − 退款，按案件汇总，便于判断"哪些线索真的收到钱"
  const netByMatter = new Map<string, number>();
  for (const f of feeRows) {
    const delta = f.type === "RECEIVED" ? Number(f.amount) : -Number(f.amount);
    netByMatter.set(f.matterId, (netByMatter.get(f.matterId) ?? 0) + delta);
  }
  const paidMatterIds = [...netByMatter.entries()].filter(([, v]) => v > 0).map(([k]) => k);
  const receivedAmount = [...netByMatter.values()].reduce((n, v) => n + Math.max(0, v), 0);

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    leadCount,
    convertedCount,
    signedMatterCount: signedMatterIds.size,
    paidMatterCount: paidMatterIds.length,
    contractAmount: round2(contractAmount),
    receivedAmount: round2(receivedAmount),
    collectionRate: rate(receivedAmount, contractAmount),
    leadToCashRate: rate(paidMatterIds.length, leadCount)
  };
}

/** 供测试与调用方复用的空值形态，避免各处各写一份 0/null */
export const EMPTY_LEAD_TO_CASH: LeadToCash = {
  leadCount: 0,
  convertedCount: 0,
  signedMatterCount: 0,
  paidMatterCount: 0,
  contractAmount: 0,
  receivedAmount: 0,
  collectionRate: null,
  leadToCashRate: null
};

export type { Prisma };
