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
