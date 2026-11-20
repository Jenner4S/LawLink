"use server";

/**
 * 门户侧读取：案件进度摘要（2026-11-20，门户 S2）
 *
 * 数据来源仍只有一条：**该客户名下未撤销的 MATTER_SUMMARY 分享**。
 * 无分享 → 空列表；不查隔离墙、不查角色（客户不在员工权限体系里）。
 *
 * 输出走 `lib/portal/matter-summary.ts` 的白名单投影：
 * 阶段名 + 关键日期，**没有百分比**（方案 §七 Q1 已定并写明理由）。
 */

import { prisma } from "@/lib/prisma";
import { matterStatusLabel } from "@/lib/enums";
import type { MatterCategory } from "@prisma/client";
import { getPortalViewer } from "@/lib/portal/session";
import { projectMatterSummary, type PortalMatterSummary } from "@/lib/portal/matter-summary";
import { computeMatterFinanceFacts } from "@/server/finance/matter-finance-core";

const CATEGORY_CN: Record<string, string> = {
  CIVIL_COMMERCIAL: "民商事",
  CRIMINAL: "刑事",
  ADMINISTRATIVE: "行政",
  NON_LITIGATION: "非诉",
  COUNSEL: "法律顾问"
};

/** 当前客户可看到的案件进度摘要列表 */
export async function listPortalMatterSummaries(): Promise<PortalMatterSummary[]> {
  const viewer = await getPortalViewer();
  if (!viewer) return [];

  const shares = await prisma.portalShare.findMany({
    where: { clientId: viewer.clientId, shareType: "MATTER_SUMMARY", revokedAt: null },
    orderBy: { sharedAt: "desc" },
    select: { matterId: true }
  });
  const matterIds = [...new Set(shares.map((s) => s.matterId).filter((m): m is string => Boolean(m)))];
  if (matterIds.length === 0) return [];

  const matters = await prisma.matter.findMany({
    where: { id: { in: matterIds }, deletedAt: null },
    select: {
      id: true,
      internalCode: true,
      title: true,
      category: true,
      status: true,
      firstAcceptedAt: true,
      closedAt: true,
      owner: { select: { name: true } },
      procedures: {
        // MatterProcedure 没有 deletedAt（删除即物理删），只按创建时间取最近一个程序
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          stages: {
            where: { status: "ACTIVE" },
            orderBy: { order: "asc" },
            take: 1,
            select: { name: true, startedAt: true }
          }
        }
      }
    }
  });

  // 保持分享顺序（最近分享的在前），而不是数据库返回顺序
  const order = new Map(matterIds.map((id, i) => [id, i]));
  return matters
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((m) => {
      const stage = m.procedures[0]?.stages[0];
      return projectMatterSummary({
        id: m.id,
        internalCode: m.internalCode,
        title: m.title,
        categoryLabel: CATEGORY_CN[m.category as MatterCategory] ?? String(m.category),
        statusLabel: matterStatusLabel[m.status] ?? String(m.status),
        stageName: stage?.name ?? null,
        stageStartedAt: stage?.startedAt ?? null,
        acceptedAt: m.firstAcceptedAt,
        closedAt: m.closedAt,
        leadLawyer: m.owner?.name ?? null
      });
    });
}

/** 门户可见的账单摘要（**金额来自财务模块同一段计算**） */
export type PortalBillingSummary = {
  matterId: string;
  internalCode: string;
  title: string;
  /** 合同额 / 应收 / 已收 / 待收 / 已开票 —— 全部取自 computeMatterFinanceFacts */
  contractAmount: number;
  receivable: number;
  received: number;
  outstanding: number;
  invoiced: number;
  invoices: { id: string; invoiceNo: string | null; amount: number; issuedAt: Date | null }[];
};

/**
 * 读取该客户可看到的账单摘要。
 *
 * **Q2 硬约束怎么落地的（重要）**：金额不在这里算。
 * 这里只做两件事——查「有哪些案件被分享给了这个客户」，然后**调用财务模块自己的**
 * `computeMatterFinanceFacts(matterId)` 取数。也就是说门户上的金额与 `/finance`
 * 页面上的金额由**同一段代码**产出，而不是两段长得像的代码。
 *
 * 客户拿门户截图来对账时，两处不一致是信任崩塌的头号原因；
 * 「看起来一样的第二套算法」迟早会漂移（改了一处忘了另一处）。
 *
 * 刻意**不返回**：成本、律师分成、工时明细、待确认实收（内部口径）。
 */
export async function listPortalBillings(): Promise<PortalBillingSummary[]> {
  const viewer = await getPortalViewer();
  if (!viewer) return [];

  const shares = await prisma.portalShare.findMany({
    where: { clientId: viewer.clientId, shareType: "BILLING", revokedAt: null },
    orderBy: { sharedAt: "desc" },
    select: { matterId: true }
  });
  const matterIds = [...new Set(shares.map((s) => s.matterId).filter((m): m is string => Boolean(m)))];
  if (matterIds.length === 0) return [];

  const matters = await prisma.matter.findMany({
    where: { id: { in: matterIds }, deletedAt: null },
    select: { id: true, internalCode: true, title: true }
  });
  const matterOf = new Map(matters.map((m) => [m.id, m]));

  const rows = await Promise.all(
    matterIds
      .filter((id) => matterOf.has(id))
      .map(async (matterId) => {
        const finance = await computeMatterFinanceFacts(matterId);
        const m = matterOf.get(matterId)!;
        return {
          matterId,
          internalCode: m.internalCode,
          title: m.title,
          contractAmount: finance.stats.contractAmount,
          receivable: finance.stats.receivable,
          received: finance.stats.received,
          outstanding: finance.stats.outstanding,
          invoiced: finance.stats.invoiced,
          invoices: finance.invoices.map((i) => ({
            id: i.id,
            invoiceNo: i.invoiceNo ?? null,
            amount: Number(i.amount),
            issuedAt: i.issuedAt ?? null
          }))
        } satisfies PortalBillingSummary;
      })
  );
  return rows;
}
