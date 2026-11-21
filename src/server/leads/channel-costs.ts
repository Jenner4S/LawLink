/**
 * 渠道月度投放成本（2026-11-23）
 *
 * 线索上的 `voucherAmount` 是**每条线索**的券金额，不等于"这个月在大众点评投了 3000"。
 * 没有渠道级投放成本，漏斗里那几列（单线索/单到店/单成交成本）就没有可信来源。
 *
 * ## 口径
 *
 * · 按「渠道 × 月」唯一，重复录入是**覆盖**不是累加（同月改数是常态，累加会算错）；
 * · 只存金额与备注，**不存分摊规则**——分摊在分析层决定，表只存事实；
 * · 月份用 `YYYY-MM` 字符串：跨时区不会漂，也便于直接按前缀查区间。
 */
import { prisma } from "@/lib/prisma";

/** `YYYY-MM`（本地时区，与页面显示一致） */
export function monthKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export type ChannelCostRow = { channelId: string; month: string; amount: number; note: string | null };

/** 某月的渠道成本（按渠道 id 索引，供分析层直接查） */
export async function getChannelCostsForMonth(month: string): Promise<Map<string, number>> {
  const rows = await prisma.leadChannelCost.findMany({
    where: { month },
    select: { channelId: true, amount: true }
  });
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.channelId, Number(r.amount));
  return map;
}

/** 列出某月全部成本记录（管理界面用） */
export async function listChannelCosts(month: string): Promise<ChannelCostRow[]> {
  const rows = await prisma.leadChannelCost.findMany({
    where: { month },
    select: { channelId: true, month: true, amount: true, note: true }
  });
  return rows.map((r) => ({ channelId: r.channelId, month: r.month, amount: Number(r.amount), note: r.note }));
}

/** `2026-11` ± n 个月（用于月份选择器与环比） */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthKey(d);
}

/** 近 N 个月（含 `month` 自身，最近的在前） */
export function recentMonths(month: string, count = 6): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(month, -i));
}

/**
 * 某渠道近 N 月的投放成本序列（2026-11-23）
 *
 * 只编辑本月看不出趋势——"这个月投了 3000"要和上月比才有意义。
 * 返回按月份从新到旧，缺失的月份补 0（0 = 该月没投）。
 */
export async function getChannelCostTrend(
  channelId: string,
  months: string[]
): Promise<{ month: string; amount: number }[]> {
  const rows = await prisma.leadChannelCost.findMany({
    where: { channelId, month: { in: months } },
    select: { month: true, amount: true }
  });
  const map = new Map(rows.map((r) => [r.month, Number(r.amount)]));
  return months.map((m) => ({ month: m, amount: map.get(m) ?? 0 }));
}
