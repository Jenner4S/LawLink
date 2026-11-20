/**
 * 风险代理计提（2026-11-22，对标分析 P0-4）
 *
 * ## 客户在算什么
 *
 * 他现行系统有「风代比例 / 风代金额」两列。风代（风险代理）是后收费：
 * 律师先垫办案，回款后按约定比例提成。所以**计提基数必须是回款，不是合同额**。
 *
 * ## 一条关键取舍：只存比例，金额读时派生
 *
 * 若把金额落库，它就必然与实收打架——回款每天在变，而落库金额是某一刻的快照。
 * 财务上最难解释的问题就是「两个数不一致」。所以：
 *   · `Billing.contingencyPercent` 是**事实**（当事人签的比例）
 *   · 计提金额是**推算**，每次按当前实收算出来，并明确标注为估算
 *
 * ## 已知边界（如实声明）
 *
 * · 计提基数是「已确认实收」（`FeeEntry` 两步确认后的净额），不含未确认的登记；
 * · 不扣成本、不扣已付分成——那些是结算环节的事，混进来会让"计提"变成"应付"，
 *   而律师看这一栏想知道的是「按合同我能提多少」；
 * · 比例口径待业主确认（回款 or 合同额）。若确认按合同额，只需改本文件的基数来源，
 *   落库结构不变。
 */

import type { Prisma } from "@prisma/client";

export type ContingencyPlan = {
  billingId: string;
  billingTitle: string;
  /** 约定比例（0–100） */
  percent: number;
  /** 计提基数：已确认净实收 */
  basis: number;
  /** 计提金额 = basis × percent / 100，四舍五入到分 */
  accrued: number;
  /**
   * 已经生效的合同额（供对照）。
   * 风代案件里 contractAmount 往往只是基础办案费，与计提额不是同一件事。
   */
  contractAmount: number;
};

/** 取两位小数，避免浮点误差累积成「差一分钱」 */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * 从案件的 billing 列表与已确认净实收，算出各风代合同的计提。
 *
 * @param billings 仅需 id/title/contractAmount/contingencyPercent/signedAt
 * @param netReceived 该案已确认净实收（与财务页「回款」同源）
 */
export function computeContingencyAccruals(
  billings: {
    id: string;
    title: string;
    contractAmount: Prisma.Decimal | number | string;
    contingencyPercent: Prisma.Decimal | number | string | null;
    signedAt: Date | null;
  }[],
  netReceived: number
): ContingencyPlan[] {
  return billings
    .filter((b) => b.contingencyPercent !== null && b.contingencyPercent !== undefined)
    .map((b) => {
      const percent = Number(b.contingencyPercent);
      // 未签署的合同不参与计提：还没生效的约定不能拿去算钱
      const effective = b.signedAt ? netReceived : 0;
      return {
        billingId: b.id,
        billingTitle: b.title,
        percent: Number.isFinite(percent) ? percent : 0,
        basis: round2(effective),
        accrued: round2((effective * (Number.isFinite(percent) ? percent : 0)) / 100),
        contractAmount: Number(b.contractAmount)
      };
    })
    .sort((a, b) => b.accrued - a.accrued);
}

/** 合计计提（供报表/看板取一个数） */
export function sumContingencyAccruals(plans: ContingencyPlan[]): number {
  return round2(plans.reduce((n, p) => n + p.accrued, 0));
}
