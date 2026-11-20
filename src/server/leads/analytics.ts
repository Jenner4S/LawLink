/**
 * 获客漏斗分析（2026-11-21，全链路数字化 阶段二）
 *
 * ## 唯一重要的口径决定：分母是「期间新增的线索」
 *
 * 转化率有两种算法，差别很大：
 *   · `期间新增线索里最终转化的数量 / 期间新增线索数` ← 本文件采用
 *   · `期间转化的数量 / 期间线索数`                    ← 错误，会超过 100%
 *
 * 后者的错在于把**跨期成交**（上月线索本月转化）算进了本月的分子，
 * 分母却是本月线索。这会让比率出现 120% 这种不可能的数字，
 * 而看板上一旦出现不可能的数字，整块看板就没人信了。
 *
 * ## 「曾到过某阶段」以动作记录为准，不看当前 stage
 *
 * 线索当前可能已到 CONSULTED，但「是否曾被邀约过」必须看有没有 INVITE 动作。
 * 用 stage 反推会得出「所有谈过案的都被邀约过」——听起来合理，
 * 但数据上无法区分「跳过邀约直接来所里」的情形，而后者恰恰是流程漏洞。
 *
 * ## 已知边界（如实声明）
 *
 * · 转化天数用**中位数**而不是平均值：样本少时平均值会被一两个极端值带偏。
 * · 只统计期间内**新增**的线索；期间之前的老线索给谁跟进、多久转化，不在本表。
 * · 不含获客成本（需要渠道费用登记，属阶段三）。
 */

import { prisma } from "@/lib/prisma";
import { getLeadFinancePolicy } from "@/server/settings/lead-finance-policy";
import type { LeadStage, LeadSource } from "@prisma/client";
import { shMonthStart } from "@/server/finance/facts";

export type LeadFunnel = {
  /** 期间（上海口径） */
  periodStart: Date;
  periodEnd: Date;
  /** 期间新增线索数（所有比率的分母） */
  total: number;
  /** 曾发生该动作的线索数 */
  invited: number;
  visited: number;
  consulted: number;
  /** 期间新增线索中已转收案的 */
  converted: number;
  lost: number;
  /** 期间内发生爽约的线索数（2026-11-22 P0-3） */
  noShow: number;
  /** 比率（分母为 0 时为 null，不显示 0%——0% 会被误读成「一个都没成」） */
  inviteRate: number | null;
  visitRate: number | null;
  consultRate: number | null;
  conversionRate: number | null;
  /** 爽约率 = 爽约 / 到过邀约的（含爽约）。分母为 0 时为 null */
  noShowRate: number | null;
  /** 转化天数中位数（天）；无可算样本为 null */
  medianDaysToConvert: number | null;
  /** 期间新增线索的预计金额合计 */
  expectedAmount: number;
  /** 已转收案的线索的预计金额合计 */
  convertedAmount: number;
  bySource: { source: LeadSource; total: number; converted: number; conversionRate: number | null }[];
  /**
   * 按**渠道**聚合（2026-11-22 P0-1）。这是客户做那张表的初衷：决定钱往哪投。
   * 优先用 channelId（一级渠道名，二级用「一级 / 二级」表示）；为空回退 source 枚举文案。
   * voucherAmount 为该渠道本期券金额合计（口径待业主确认，只展示不参与比率）。
   */
  /**
   * 券金额归属口径（2026-11-22 可配置）：COST 成本侧 / REVENUE 收入侧 / IGNORED 只记录。
   * 界面据此把那一列标成「券成本」还是「券收入」，避免同一列被两种解读混用。
   */
  voucherSide: "COST" | "REVENUE" | "IGNORED";
  byChannel: {
    key: string;
    label: string;
    total: number;
    visited: number;
    converted: number;
    voucherAmount: number;
    conversionRate: number | null;
    /**
     * 单位成本（2026-11-22 渠道 ROI）：券金额 ÷ 线索数 / 到店数 / 成交数。
     * **只做成本，不做 ROI 比率**——收入侧没有可信数据（成交金额虽有，但它是
     * 案件标的或收费，混进渠道口径会把"线索质量"和"客单价"搅在一起）。
     * 分母为 0 或券金额为 0 时为 null，界面显示「—」：
     * 0 成本会被误读成"这个渠道不花钱"，那比不显示更危险。
     */
    costPerLead: number | null;
    costPerVisit: number | null;
    costPerConverted: number | null;
  }[];
  byOwner: { ownerId: string; ownerName: string; total: number; converted: number; conversionRate: number | null }[];
  lostReasons: { reason: string; count: number }[];
};

const rate = (num: number, den: number): number | null => (den === 0 ? null : Math.round((num / den) * 1000) / 10);

/**
 * 单位成本：券金额 ÷ 分母。分母或金额为 0 时返回 null（界面显示「—」）。
 * 返回 0 会有害：读者会以为"这个渠道零成本"，而真相往往是"还没录金额"。
 */
const unitCost = (amount: number, denominator: number): number | null =>
  amount > 0 && denominator > 0 ? Math.round((amount / denominator) * 100) / 100 : null;

export async function getLeadFunnel(period: { start?: Date; end?: Date } = {}): Promise<LeadFunnel> {
  const periodStart = period.start ?? shMonthStart();
  const periodEnd = period.end ?? new Date();

  const leads = await prisma.lead.findMany({
    where: { createdAt: { gte: periodStart, lt: periodEnd } },
    select: {
      id: true, stage: true, source: true, ownerId: true,
      owner: { select: { name: true } },
      expectedAmount: true, convertedAt: true, createdAt: true, lostReason: true, visitOutcome: true,
      channelId: true, voucherAmount: true,
      channel: { select: { name: true, parent: { select: { name: true } } } },
      activities: { select: { type: true } }
    }
  });

  const total = leads.length;
  // 券金额归属口径（2026-11-22 可配置）：界面据此标注那一列是成本还是收入
  const { voucherAmountSide } = await getLeadFinancePolicy();
  let invited = 0;
  let visited = 0;
  let consulted = 0;
  let converted = 0;
  let lost = 0;
  let noShow = 0;
  let expectedAmount = 0;
  let convertedAmount = 0;
  const daysToConvert: number[] = [];

  const sourceAgg = new Map<LeadSource, { total: number; converted: number }>();
  const channelAgg = new Map<string, { label: string; total: number; visited: number; converted: number; voucherAmount: number }>();
  const ownerAgg = new Map<string, { ownerName: string; total: number; converted: number }>();
  const lostAgg = new Map<string, number>();

  for (const lead of leads) {
    const types = new Set(lead.activities.map((a) => a.type));
    if (types.has("INVITE")) invited += 1;
    if (types.has("VISIT")) visited += 1;
    if (types.has("CONSULT")) consulted += 1;
    if (lead.expectedAmount !== null) expectedAmount += Number(lead.expectedAmount);

    const isConverted = lead.stage === "CONVERTED" || Boolean(lead.convertedAt);
    if (isConverted) {
      converted += 1;
      if (lead.expectedAmount !== null) convertedAmount += Number(lead.expectedAmount);
      if (lead.convertedAt) {
        daysToConvert.push((lead.convertedAt.getTime() - lead.createdAt.getTime()) / 86_400_000);
      }
    }
    // 爽约：以结果字段为准（不靠 stage 反推——爽约后仍可能是 INVITED）
    if (lead.visitOutcome === "NO_SHOW") noShow += 1;
    if (lead.stage === "LOST") {
      lost += 1;
      const reason = lead.lostReason?.trim() || "（未填写）";
      lostAgg.set(reason, (lostAgg.get(reason) ?? 0) + 1);
    }

    const s = sourceAgg.get(lead.source) ?? { total: 0, converted: 0 };
    s.total += 1;
    if (isConverted) s.converted += 1;
    sourceAgg.set(lead.source, s);

    // 渠道聚合：有 channelId 用它（更细），否则回退 source 枚举（存量数据）
    const chKey = lead.channelId ?? `SRC:${lead.source}`;
    const chLabel = lead.channel
      ? (lead.channel.parent ? `${lead.channel.parent.name} / ${lead.channel.name}` : lead.channel.name)
      : `（未指定渠道·来源 ${lead.source}）`;
    const ch = channelAgg.get(chKey) ?? { label: chLabel, total: 0, visited: 0, converted: 0, voucherAmount: 0 };
    ch.total += 1;
    if (lead.visitOutcome === "ARRIVED") ch.visited += 1;
    if (isConverted) ch.converted += 1;
    if (lead.voucherAmount !== null) ch.voucherAmount += Number(lead.voucherAmount);
    channelAgg.set(chKey, ch);

    const o = ownerAgg.get(lead.ownerId) ?? { ownerName: lead.owner.name, total: 0, converted: 0 };
    o.total += 1;
    if (isConverted) o.converted += 1;
    ownerAgg.set(lead.ownerId, o);
  }

  daysToConvert.sort((a, b) => a - b);
  const medianDaysToConvert =
    daysToConvert.length === 0
      ? null
      : Math.round(
          (daysToConvert.length % 2 === 1
            ? daysToConvert[(daysToConvert.length - 1) / 2]
            : (daysToConvert[daysToConvert.length / 2 - 1] + daysToConvert[daysToConvert.length / 2]) / 2) * 10
        ) / 10;

  return {
    periodStart,
    periodEnd,
    voucherSide: voucherAmountSide,
    total,
    invited,
    visited,
    consulted,
    converted,
    lost,
    noShow,
    inviteRate: rate(invited, total),
    visitRate: rate(visited, invited),
    consultRate: rate(converted, consulted),
    conversionRate: rate(converted, total),
    // 爽约率的分母是「曾到过邀约环节的人」（到过 INVITE = 邀约过），
    // 用它才能回答「约了的人里有多少没来」；用总线索数会把没约的也算成分母，
    // 会让爽约率看起来很低，掩盖真实的邀约质量问题。
    noShowRate: rate(noShow, noShow + visited),
    medianDaysToConvert,
    expectedAmount: Math.round(expectedAmount * 100) / 100,
    convertedAmount: Math.round(convertedAmount * 100) / 100,
    bySource: [...sourceAgg.entries()]
      .map(([source, v]) => ({ source, total: v.total, converted: v.converted, conversionRate: rate(v.converted, v.total) }))
      .sort((a, b) => b.total - a.total),
    byChannel: [...channelAgg.entries()]
      .map(([key, v]) => ({
        key,
        label: v.label,
        total: v.total,
        visited: v.visited,
        converted: v.converted,
        voucherAmount: Math.round(v.voucherAmount * 100) / 100,
        conversionRate: rate(v.converted, v.total),
        costPerLead: unitCost(v.voucherAmount, v.total),
        costPerVisit: unitCost(v.voucherAmount, v.visited),
        costPerConverted: unitCost(v.voucherAmount, v.converted)
      }))
      .sort((a, b) => b.total - a.total),
    byOwner: [...ownerAgg.entries()]
      .map(([ownerId, v]) => ({ ownerId, ownerName: v.ownerName, total: v.total, converted: v.converted, conversionRate: rate(v.converted, v.total) }))
      .sort((a, b) => b.total - a.total),
    lostReasons: [...lostAgg.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  };
}

/** 阶段分布（当前在途，不分期间——用于看「现在手上压着多少」，不是漏斗比率） */
export async function getLeadStageBuckets(): Promise<{ stage: LeadStage; count: number }[]> {
  const rows = await prisma.lead.groupBy({ by: ["stage"], _count: { _all: true } });
  const order: LeadStage[] = ["LEAD", "INVITED", "VISITED", "CONSULTED", "CONVERTED", "LOST"];
  return order.map((stage) => ({
    stage,
    count: rows.find((r) => r.stage === stage)?._count._all ?? 0
  }));
}
