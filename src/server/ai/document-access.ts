/**
 * AI 入口的文档归属断言。
 *
 * AI 审查会把库内文档解密后全文发送外部服务，是比下载更敏感的出口，
 * 资格必须与材料归属一致（2026-09-20 A 批 P1-2 收敛）：
 *   - 合伙人岗位（PRINCIPAL_LAWYER）直通全所材料；
 *   - 案件材料：主办或案件成员；
 *   - 收案材料：创建人 / 主办 / 协办（与上传路径同口径）；
 *   - 无归属材料：仅上传者本人；
 *   - 业务管理权（managerAuthorized）与审批临时阅读资格（用章/开票/文书审批的
 *     当次附件访问）都不取得全文外发资格——管理权只放大「可见」，审批权只覆盖
 *     当次申请附件的下载，不覆盖 AI 全文外发。
 * 发起资格（documents.write）由各入口 requireSession 把关；本断言只管对象归属。
 *
 * 注意：本模块不标 "use server"——断言 helper 一旦进入 action 模块导出就成了可伪造参数的 RPC 端点。
 */
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { isManager } from "@/lib/permissions";
import { resolveRoleUser } from "@/lib/roles/service";
import { ActionError } from "@/lib/action-error";

type AppSession = Awaited<ReturnType<typeof requireSession>>;

export async function canReviewDocument(
  userId: string,
  doc: { id: string; uploadedById: string | null; matterId: string | null; intakeId: string | null }
): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
  if (!user?.active) return false;
  const access = await resolveRoleUser(userId, user.role);
  if (!access.enabled) return false;

  // 隔离墙必须先于一切放行判断（2026-11-20 补）。
  //
  // 这是「外发」出口，比下载更敏感：正文会被解密后发给外部模型服务商。
  // 此前这里没有墙检查，且下一行 `isManager` 直接让合伙人直通全所案件 ——
  // 而读取侧 matterReadVisibilityFilter 的注释明写「隔离墙对全所生效
  // （含合伙人/管理员），这是执业合规要求，不是权限设置」。
  //
  // 后果：被墙隔离的主办/成员能看到自己案件的 AI 入口，被墙隔离的合伙人更是
  // 全所直通；读取侧拦住了「看」，AI 侧却没拦住「发」。外发之后无法收回。
  //
  // 放在 isManager 之前是刻意的：墙对合伙人同样生效，不能被管理权短路。
  if (doc.matterId) {
    const { isMatterWalledFor } = await import("@/lib/permissions/ethical-wall");
    if (await isMatterWalledFor(prisma, { matterId: doc.matterId, userId, role: user.role })) {
      return false;
    }
  }

  if (isManager(access.role)) return true;
  if (doc.matterId && await prisma.matter.count({
    where: { id: doc.matterId, deletedAt: null, OR: [{ ownerId: userId }, { members: { some: { userId } } }] }
  })) return true;
  if (doc.intakeId) {
    const intake = await prisma.intake.findUnique({
      where: { id: doc.intakeId },
      select: { createdById: true, ownerUserId: true, coUserIds: true }
    });
    if (intake && (intake.createdById === userId || intake.ownerUserId === userId || intake.coUserIds.includes(userId))) return true;
  }
  if (doc.uploadedById === userId && !doc.matterId && !doc.intakeId) return true;
  return false;
}

export async function assertCanReviewDocument(
  session: AppSession,
  docRef: { id: string; matterId?: string | null; intakeId?: string | null }
): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: docRef.id },
    select: { id: true, uploadedById: true, matterId: true, intakeId: true, deletedAt: true }
  });
  if (!doc || doc.deletedAt) throw new ActionError("材料不存在");
  if (doc.matterId !== (docRef.matterId ?? null) || doc.intakeId !== (docRef.intakeId ?? null)) {
    throw new ActionError("材料归属已变化，请刷新后重试");
  }
  if (!(await canReviewDocument(session.user.id, doc))) throw new ActionError("无权审查该材料");
}
