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
