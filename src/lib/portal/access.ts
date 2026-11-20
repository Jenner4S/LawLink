/**
 * 门户可见性的**唯一判定处**（2026-11-20，门户 S2）
 *
 * 方案 §二 决策 3 要求「分享用员工断言、读取用独立断言」，本文件就是那个独立断言。
 *
 * 三条纪律，任何一条被破坏都等于门户失控：
 *
 * 1. **只看 PortalShare。**
 *    完全不查隔离墙、不查角色、不查 `matterAssociationFilter`——客户不在员工权限体系里。
 *    把两者混在一起，迟早会出现「客户借员工的权限读到东西」。
 *
 * 2. **没有自动可见路径。**
 *    不存在 `if (document.category === '判决书') 可见` 这种规则。要看，就必须有人点过分享。
 *
 * 3. **撤销即失效。**
 *    判定读 `revokedAt IS NULL`，不做任何缓存——撤销后下一次请求就看不到，
 *    不依赖「重新登录」「等缓存过期」这类模糊条件。
 */
import { prisma } from "@/lib/prisma";

export type PortalResource = { clientId: string; resourceId: string };

/** 门户能否看到某份材料：存在一条未撤销、且属于该客户的 DOCUMENT 分享 */
export async function portalCanReadDocument(clientId: string, documentId: string): Promise<boolean> {
  const row = await prisma.portalShare.findFirst({
    where: { clientId, documentId, shareType: "DOCUMENT", revokedAt: null },
    select: { id: true }
  });
  return Boolean(row);
}

/** 门户能否看到某案件的进度摘要 */
export async function portalCanReadMatterSummary(clientId: string, matterId: string): Promise<boolean> {
  const row = await prisma.portalShare.findFirst({
    where: { clientId, matterId, shareType: "MATTER_SUMMARY", revokedAt: null },
    select: { id: true }
  });
  return Boolean(row);
}

/**
 * 门户材料下载前的判定。
 *
 * 这里**不**调用 `canReadDocument`（员工侧那一套）：那套的第一句就是
 * 「你是不是这个案的经办/成员」，客户永远不是。用它会一律拒绝，看似安全，
 * 但下一个人为了"修好"它，很可能直接给客户加个成员身份——那才是真正的洞。
 */
export async function assertPortalCanDownload(clientId: string, documentId: string): Promise<void> {
  const ok = await portalCanReadDocument(clientId, documentId);
  if (!ok) {
    // 不区分「没分享过」与「分享已撤销」：对外一律当作不存在
    const { portalNotFound } = await import("./session");
    portalNotFound();
  }
}
