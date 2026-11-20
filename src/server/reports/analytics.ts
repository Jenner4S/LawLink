/**
 * v0.22: 报表深入分析
 *
 * - 办案周期：本期已结案件的 closedAt - createdAt 天数，按 category 统计
 * - AI 审查 top issues：本期 ReviewRecord.itemsJson 聚合，找高频 title
 */
import type { ReportAccess } from "@/lib/roles/report-scope";
import { prisma } from "@/lib/prisma";
import type { MatterCategory } from "@prisma/client";
import type { ReportPeriod } from "./queries";
import type { ReviewItem, ReviewType, ReviewSeverity } from "@/lib/ai/review-parser";

export type CycleStats = {
  category: MatterCategory;
  count: number;
  avgDays: number;
  medianDays: number;
  minDays: number;
  maxDays: number;
};

/**
 * 计算"收案→结案"周期。本期 closedAt 落入的案件为口径。
 * 用 JS 端排序算中位数（prisma groupBy 不支持中位数）。
 */
export async function getCaseCycleAnalysis(period: ReportPeriod, access: ReportAccess = { matters: {}, finance: {} }): Promise<CycleStats[]> {
  const closed = await prisma.matter.findMany({
    where: {
      closedAt: { gte: period.start, lt: period.end },
      deletedAt: null, AND: [access.matters],
      createdAt: { lt: period.end } // 防御性：createdAt 应当 <= closedAt
    },
    select: { category: true, createdAt: true, closedAt: true }
  });

  // 按 category 聚合 days 数组
  const byCat = new Map<MatterCategory, number[]>();
  for (const m of closed) {
    if (!m.closedAt) continue;
    const days = Math.round((m.closedAt.getTime() - m.createdAt.getTime()) / 86400_000);
    if (days < 0) continue;
    if (!byCat.has(m.category)) byCat.set(m.category, []);
    byCat.get(m.category)!.push(days);
  }

  const out: CycleStats[] = [];
  for (const [cat, arr] of byCat) {
    arr.sort((a, b) => a - b);
    const sum = arr.reduce((s, v) => s + v, 0);
    const avg = arr.length > 0 ? sum / arr.length : 0;
    const median =
      arr.length === 0
        ? 0
        : arr.length % 2 === 1
          ? arr[(arr.length - 1) / 2]
          : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2;
    out.push({
      category: cat,
      count: arr.length,
      avgDays: Math.round(avg * 10) / 10,
      medianDays: Math.round(median * 10) / 10,
      minDays: arr[0],
      maxDays: arr[arr.length - 1]
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

export type ReviewTopIssue = {
  title: string;
  type: ReviewType;
  occurrences: number;
  severityCounts: Record<ReviewSeverity, number>;
};

export type ReviewIssueAnalysis = {
  recordCount: number;
  documentCount: number;
  totalItems: number;
  bySeverity: Record<ReviewSeverity, number>;
  byType: Record<ReviewType, number>;
  topIssues: ReviewTopIssue[]; // 出现频率 top 10 的 title
};

/**
 * 本期 AI 审查的跨案件聚合统计。
 * 从 ReviewRecord.itemsJson 拉出来 JS 聚合（PG jsonb 函数路径 prisma 不友好）。
 */
export async function getReviewIssueAnalysis(period: ReportPeriod, access: ReportAccess = { matters: {}, finance: {} }): Promise<ReviewIssueAnalysis> {
  const records = await prisma.reviewRecord.findMany({
    where: { reviewedAt: { gte: period.start, lt: period.end }, document: { matter: { deletedAt: null, AND: [access.matters] } } },
    select: { id: true, documentId: true, itemsJson: true }
  });

  const docSet = new Set<string>();
  const bySev: Record<ReviewSeverity, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byType: Record<ReviewType, number> = {
    MISSING: 0,
    RISK: 0,
    ISSUE: 0,
    SUGGESTION: 0
  };
  // title → 累加
  const titleMap = new Map<
    string,
    { type: ReviewType; occurrences: number; severityCounts: Record<ReviewSeverity, number> }
  >();
  let totalItems = 0;

  for (const r of records) {
    docSet.add(r.documentId);
    const items = (Array.isArray(r.itemsJson) ? r.itemsJson : []) as ReviewItem[];
    for (const it of items) {
      totalItems++;
      if (it.severity in bySev) bySev[it.severity]++;
      if (it.type in byType) byType[it.type]++;
      const key = it.title.trim();
      if (!key) continue;
      if (!titleMap.has(key)) {
        titleMap.set(key, {
          type: it.type,
          occurrences: 0,
          severityCounts: { HIGH: 0, MEDIUM: 0, LOW: 0 }
        });
      }
      const entry = titleMap.get(key)!;
      entry.occurrences++;
      if (it.severity in entry.severityCounts) entry.severityCounts[it.severity]++;
    }
  }

  const topIssues: ReviewTopIssue[] = Array.from(titleMap.entries())
    .map(([title, v]) => ({
      title,
      type: v.type,
      occurrences: v.occurrences,
      severityCounts: v.severityCounts
    }))
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 10);

  return {
    recordCount: records.length,
    documentCount: docSet.size,
    totalItems,
    bySeverity: bySev,
    byType,
    topIssues
  };
}

/**
 * 客户满意度分析（2026-11-21，门户 S3 验收判据「满意度看板：员工侧只读看板」）
 *
 * 三个口径决定（都会影响解读，所以写在这里）：
 *   ① **匿名评价的 clientId 仍计入客户维度**——匿名只是不暴露"哪个人"，
 *      不是不暴露"哪家客户"；否则客户级统计会出现无法归因的空洞。
 *   ② **NPS 只统计有 npsScore 的评价**，分母是"填了 NPS 的条数"，
 *      不是"全部评价条数"。把没填的当 0 分算会把 NPS 系统性压低。
 *   ③ **平均分按 score 计权**，不按 NPS——两者量纲不同，混算没有意义。
 *
 * 只读：本函数不做任何写入，也不返回可点击跳转到客户门户的标识。
 */
export type SatisfactionAnalysis = {
  count: number;
  averageScore: number | null;
  /** 1..5 分布，索引 0 对应 1 分 */
  distribution: number[];
  /** 推荐者(9-10) / 被动者(7-8) / 贬损者(0-6) 人数 */
  nps: { promoters: number; passives: number; detractors: number; score: number | null; responses: number };
  anonymousCount: number;
  /** 最近的评价明细（只读展示；匿名行不显示提交人） */
  recent: {
    matterTitle: string;
    clientName: string;
    score: number;
    npsScore: number | null;
    comment: string | null;
    anonymous: boolean;
    createdAt: Date;
  }[];
};

export async function getSatisfactionAnalysis(
  period: ReportPeriod,
  access: ReportAccess = { matters: {}, finance: {} }
): Promise<SatisfactionAnalysis> {
  const full = await prisma.portalSatisfaction.findMany({
    where: {
      createdAt: { gte: period.start, lt: period.end },
      // 与报表同口径：被隔离墙挡住案件的评价不应出现在看板上。
      // 这里能直接在 where 里叠加，靠的是 PortalSatisfaction.matter 关系带外键
      // （迁移 20261121000002）——没有关系字段就只能拉内存过滤，量大时是全表扫描。
      matter: { deletedAt: null, AND: [access.matters] }
    },
    orderBy: { createdAt: "desc" },
    select: {
      score: true,
      npsScore: true,
      comment: true,
      anonymous: true,
      createdAt: true,
      clientId: true,
      client: { select: { name: true } },
      matter: { select: { title: true } }
    }
  });

  const distribution = [0, 0, 0, 0, 0];
  for (const r of full) {
    const i = Math.min(4, Math.max(0, r.score - 1));
    distribution[i] += 1;
  }

  const npsRows = full.filter((r) => typeof r.npsScore === "number");
  const promoters = npsRows.filter((r) => (r.npsScore ?? 0) >= 9).length;
  const passives = npsRows.filter((r) => (r.npsScore ?? 0) >= 7 && (r.npsScore ?? 0) <= 8).length;
  const detractors = npsRows.filter((r) => (r.npsScore ?? 0) <= 6).length;
  const npsScore =
    npsRows.length === 0
      ? null
      : Math.round(((promoters - detractors) / npsRows.length) * 100);

  return {
    count: full.length,
    averageScore: full.length ? full.reduce((a, r) => a + r.score, 0) / full.length : null,
    distribution,
    nps: { promoters, passives, detractors, score: npsScore, responses: npsRows.length },
    anonymousCount: full.filter((r) => r.anonymous).length,
    recent: full.slice(0, 8).map((r) => ({
      matterTitle: r.matter.title,
      clientName: r.client.name,
      score: r.score,
      npsScore: r.npsScore,
      comment: r.comment,
      anonymous: r.anonymous,
      createdAt: r.createdAt
    }))
  };
}
