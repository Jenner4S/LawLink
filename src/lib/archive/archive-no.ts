/**
 * v0.9.4 归档编号生成
 *
 * 格式：YYYY-类别-NNNN
 *   - YYYY = 归档年份（archivedAt 当年）
 *   - 类别简称 = 1 个汉字
 *   - NNNN = 年内同类别归档序号（零填 4 位，从 0001 起）
 *
 * 示例：2026-民-0017
 *
 * 并发：依赖 @@unique(archiveNo) 兜底。取号在事务外（封皮/目录渲染先行）。
 *
 * 2026-11-21 更正：这里原本写「撞号由调用方捕获 P2002 提示重提」——
 * **调用方当时并没有捕获**，`archiveMatter` 直接 `throw error`，
 * 用户看到的是 Prisma 原文（含服务器文件路径与行号）。
 * 现已在 `server/archive/actions.ts` 的 catch 里把 archiveNo 的 P2002
 * 翻成「请直接再提交一次，系统会取新号」。
 *
 * 如需彻底消除撞号：把取号挪进持锁事务（`pg_advisory_xact_lock` + 事务内取号），
 * 但渲染封皮/目录必须在事务外（涉及文件系统），所以要两者拆开——
 * 代价明显，当前选择「翻译错误 + 让用户重试」。表单不会丢，重试成本很低。
 */
import type { MatterCategory } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { shParts } from "@/lib/ui/sh-time";

const CATEGORY_SHORT: Record<MatterCategory, string> = {
  CIVIL_COMMERCIAL: "民",
  LABOR_ARBITRATION: "劳",
  COMMERCIAL_ARBITRATION: "商",
  CRIMINAL: "刑",
  ADMINISTRATIVE: "行",
  NON_LITIGATION: "非",
  LEGAL_COUNSEL: "顾",
  SPECIAL_PROJECT: "专"
};

export function categoryShort(category: MatterCategory): string {
  return CATEGORY_SHORT[category] ?? "案";
}

export async function nextArchiveNo(
  tx: Pick<PrismaClient, "archiveRecord">,
  category: MatterCategory,
  archivedAt: Date = new Date()
): Promise<string> {
  // 2026-09-20 第五轮审计时区修复：归档号年份按上海（真瞬间本地取年在 UTC 容器元旦 0-8 点取去年）
  const year = shParts(archivedAt).y;
  const short = categoryShort(category);
  const prefix = `${year}-${short}-`;

  // 取年内同前缀的最大 archiveNo
  const existing = await tx.archiveRecord.findMany({
    where: { archiveNo: { startsWith: prefix } },
    select: { archiveNo: true },
    orderBy: { archiveNo: "desc" },
    take: 1
  });

  let next = 1;
  if (existing.length > 0) {
    const m = existing[0].archiveNo.match(/-(\d{4})$/);
    if (m) next = parseInt(m[1], 10) + 1;
  }

  return `${prefix}${String(next).padStart(4, "0")}`;
}
