/**
 * 渠道转化质量环比（2026-11-23）
 *
 * 成本环比回答"这个月多花了多少"，但它答不了"多花的钱有没有换来更好的客"。
 * 这一块补另一半：同一渠道的**到店率 / 成交率**与上月比。
 *
 * ## 口径（三条，与漏斗严格一致）
 *
 * ① **分母只用当期新增线索**（与 `getLeadFunnel` 同口径）——
 *    否则"上月的老线索这个月到店"会把本月的到店率抬高，看着像变好；
 * ② 到店按 `visitOutcome = ARRIVED`；成交按 `stage = CONVERTED`（与漏斗同）；
 * ③ 上月该渠道**没有线索**时，比率为 null（不是 0%）——"上个月没投"不构成对比基线。
 *
 * 用一条聚合 SQL 而不是拉全量行：环比只算两个月，但线索量会随时间涨。
 */
import { prisma } from "@/lib/prisma";

export type QualityRow = {
  total: number;
  visited: number;
  converted: number;
  visitRate: number | null;
  conversionRate: number | null;
};

export type QualityComparison = {
  current: QualityRow;
  previous: QualityRow;
  /** 到店率变化（百分点，保留一位小数）；任一期无基线则为 null */
  visitRateDelta: number | null;
  /** 成交率变化（百分点） */
  conversionRateDelta: number | null;
};

const pct = (n: number, d: number): number | null =>
  d > 0 ? Math.round((n / d) * 1000) / 10 : null;

function toRow(total: number, visited: number, converted: number): QualityRow {
  return {
    total,
    visited,
    converted,
    visitRate: pct(visited, total),
    conversionRate: pct(converted, total)
  };
}

type Agg = { channelId: string; total: bigint; visited: bigint; converted: bigint };

async function aggregate(start: Date, end: Date): Promise<Map<string, QualityRow>> {
  const rows = await prisma.$queryRaw<Agg[]>`
    SELECT "channelId",
           count(*)::bigint AS total,
           count(*) FILTER (WHERE "visitOutcome" = 'ARRIVED')::bigint AS visited,
           count(*) FILTER (WHERE stage = 'CONVERTED')::bigint AS converted
    FROM "Lead"
    WHERE "channelId" IS NOT NULL
      AND "createdAt" >= ${start}
      AND "createdAt" < ${end}
    GROUP BY "channelId"
  `;
  const map = new Map<string, QualityRow>();
  for (const r of rows) {
    map.set(r.channelId, toRow(Number(r.total), Number(r.visited), Number(r.converted)));
  }
  return map;
}

const EMPTY: QualityRow = { total: 0, visited: 0, converted: 0, visitRate: null, conversionRate: null };

export async function getChannelQualityComparison(
  currentStart: Date,
  currentEnd: Date,
  previousStart: Date,
  previousEnd: Date
): Promise<Map<string, QualityComparison>> {
  const [cur, prev] = await Promise.all([
    aggregate(currentStart, currentEnd),
    aggregate(previousStart, previousEnd)
  ]);

  const out = new Map<string, QualityComparison>();
  for (const id of new Set([...cur.keys(), ...prev.keys()])) {
    const c = cur.get(id) ?? EMPTY;
    const p = prev.get(id) ?? EMPTY;
    out.set(id, {
      current: c,
      previous: p,
      visitRateDelta:
        c.visitRate === null || p.visitRate === null
          ? null
          : Math.round((c.visitRate - p.visitRate) * 10) / 10,
      conversionRateDelta:
        c.conversionRate === null || p.conversionRate === null
          ? null
          : Math.round((c.conversionRate - p.conversionRate) * 10) / 10
    });
  }
  return out;
}
