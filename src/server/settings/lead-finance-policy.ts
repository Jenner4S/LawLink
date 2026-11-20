/**
 * 获客与财务的两个业务口径（2026-11-22）
 *
 * ## 为什么要做成开关
 *
 * 这两个口径只有业主能定，但**不能因为没定就卡住开发**：
 * 代码里写死一种，等于替业主做了决定；两种都做又要等答复。
 * 处置是：可配置 + 默认有主张（AGENTS §五之二），业主回答后改配置即可，不动代码。
 *
 * ## 口径一：风代计提基数
 *
 * · `RECEIVED`（默认）—— 按**回款**计提。风代是后收费：律师先垫办案，
 *   回款后按比例提成。这是行业惯例，也是唯一"钱到手才有得提"的口径。
 * · `CONTRACT` —— 按**合同额**计提。少数所按签约额挂账（便于预估收入），
 *   代价是可能提了钱却没收到钱。
 *
 * ## 口径二：团购/券金额的归属
 *
 * 客户宽表的「团购金额」到底是谁付的钱，截图看不出来：
 * · `COST`（默认）—— 律所付给平台/团购的成本，用于算渠道 ROI。
 *   默认取它，是因为"团购券"在本地生活平台上的通常含义就是投放成本。
 * · `REVENUE` —— 客户付的券款，属于收入侧的预收。
 * · `IGNORED` —— 不参与计算，只记录。
 *
 * 三种口径下**金额本身都照常保存**，只是聚合时的解读不同；
 * 切换口径不改历史数据，可以随时来回切。
 */
import { prisma } from "@/lib/prisma";

const KEY = "leadFinancePolicy";

export type ContingencyBasis = "RECEIVED" | "CONTRACT";
export type VoucherAmountSide = "COST" | "REVENUE" | "IGNORED";

export interface LeadFinancePolicy {
  contingencyBasis: ContingencyBasis;
  voucherAmountSide: VoucherAmountSide;
}

export const LEAD_FINANCE_POLICY_DEFAULTS: LeadFinancePolicy = {
  contingencyBasis: "RECEIVED",
  voucherAmountSide: "COST"
};

export async function getLeadFinancePolicy(): Promise<LeadFinancePolicy> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  const v = (row?.value as Partial<LeadFinancePolicy> | null) ?? {};
  return {
    contingencyBasis:
      v.contingencyBasis === "CONTRACT" || v.contingencyBasis === "RECEIVED"
        ? v.contingencyBasis
        : LEAD_FINANCE_POLICY_DEFAULTS.contingencyBasis,
    voucherAmountSide:
      v.voucherAmountSide === "COST" || v.voucherAmountSide === "REVENUE" || v.voucherAmountSide === "IGNORED"
        ? v.voucherAmountSide
        : LEAD_FINANCE_POLICY_DEFAULTS.voucherAmountSide
  };
}

export async function saveLeadFinancePolicy(next: LeadFinancePolicy): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: { ...next } },
    update: { value: { ...next } }
  });
}
