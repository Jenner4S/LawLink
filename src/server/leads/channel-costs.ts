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

/**
 * `YYYY-MM`，按 **+08:00** 取字段（与页面显示、`shMonthStart` 一致）。
 *
 * 容器时区是 UTC（实测 `date` = UTC）。若按本地字段取，
 * 上海 11-01 00:00 这个时刻在 UTC 是 10-31T16:00Z → 会算成 `2026-10`，
 * 与 `shMonthStart` 算出的"本月"错开一个月（投放成本的月份因此对不上，踩过）。
 */
export function monthKey(d: Date = new Date()): string {
  const sh = new Date(d.getTime() + 8 * 3600_000);
  return `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, "0")}`;
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
  // 直接用 UTC 构造再交给 monthKey（它按 +08:00 取字段）——
  // 用本地构造会引入一次时区往返，边界月份会偏。
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return monthKey(d);
}

/** 近 N 个月（含 `month` 自身，最近的在前） */
export function recentMonths(month: string, count = 6): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(month, -i));
}

/**
 * 当月 vs 上月的投放成本对比（2026-11-23）
 *
 * 录入只是手段 —— "这个月投了 3000"要和上月比才知道是该加还是该减。
 *
 * ## 口径
 *
 * · `delta = 本月 − 上月`；`deltaRate = delta / 上月`；
 * · **上月为 0** 时 `deltaRate = null`（不是 0%、也不是 100%）：那不是"增长"，
 *   而是"上个月没投"，比率没有意义 —— 界面显示「新增」；
 * · 两月都为 0 → 两者皆 null/0，界面显示「—」（不显示 0%，那会被读成"持平"）。
 */
export type CostComparison = { current: number; previous: number; delta: number; deltaRate: number | null };

export async function getChannelCostComparison(month: string): Promise<Map<string, CostComparison>> {
  const prev = shiftMonth(month, -1);
  const rows = await prisma.leadChannelCost.findMany({
    where: { month: { in: [month, prev] } },
    select: { channelId: true, month: true, amount: true }
  });

  const cur = new Map<string, number>();
  const old = new Map<string, number>();
  for (const r of rows) {
    (r.month === month ? cur : old).set(r.channelId, Number(r.amount));
  }

  const out = new Map<string, CostComparison>();
  for (const id of new Set([...cur.keys(), ...old.keys()])) {
    const current = cur.get(id) ?? 0;
    const previous = old.get(id) ?? 0;
    const delta = Math.round((current - previous) * 100) / 100;
    out.set(id, {
      current,
      previous,
      delta,
      deltaRate: previous > 0 ? Math.round((delta / previous) * 1000) / 10 : null
    });
  }
  return out;
}
