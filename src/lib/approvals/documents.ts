import { resolveRoleUser } from "@/lib/roles/service";
import {financeLedgerReady} from "@/server/finance/ledger-storage";
import { hasCustomPermission,scopeFor } from "@/lib/roles/catalog";
import { isManager } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { canApproveItem, canExecuteInvoice } from "./service";
import { hasHandledApproval } from "./history-access";
/**
 * 批量场景的预取上下文（2026-11-21 加，性能 P1-2）。
 *
 * 背景：全局搜索对最多 200 个候选**逐条**调 `canReadDocument`，而它每次都
 * 重查 `user`（1 次）+ `sealRequest`（1 次）+ 可能的隔离墙与归属查询。
 * 200 份材料 = 至少 400 次往返，而其中前两项对同一用户/同一批文档是重复的。
 *
 * 传 ctx 时这两项走预取，不传则行为完全不变（27 个既有调用点不用改）。
 * 语义严格等价：预取的数据就是那些查询会返回的东西，不做任何放宽。
 */
export type DocumentReadContext = {
  /** 预取的 user 行；undefined = 没预取（照旧查库） */
  user?: { role: string; active: boolean } | null;
  /** 预取的 sealRequest（按 docId 索引）；undefined = 没预取 */
  sealsByDocId?: Map<string, { id: string; requestedById: string | null; approvedById: string | null; stampedById: string | null; status: string } | null>;
  /** 预取的 resolveRoleUser 结果；undefined = 没预取 */
  access?: Awaited<ReturnType<typeof resolveRoleUser>>;
  /** 预取的「被隔离墙挡住」的 matterId 集合；undefined = 没预取 */
  walledMatterIds?: Set<string>;
  /** 预取的「该用户是 owner 或 member 且案件未软删」的 matterId 集合；undefined = 没预取 */
  accessibleMatterIds?: Set<string>;
};

/**
 * 一次性预取 `canReadDocument` 会用到的全部共享数据（2026-11-21，性能 P1-2 第二步）。
 *
 * 为什么做成一个函数而不是让调用方自己拼：`canReadDocument` 的预取项已经到五项
 * （user / access / seals / 墙 / 归属），散着拼很容易漏一项 —— 漏了就静默退回逐条查，
 * 而结果仍然正确，于是性能问题不会被任何测试发现。集中在这里，漏项是编译期的事。
 *
 * 语义严格等价：预取的就是那些查询会返回的数据，不做任何放宽或收紧。
 * 调用方只有在「同一批文档 + 同一用户」时才该用它；单次调用不必预取。
 */
export async function prefetchDocumentReadContext(
  userId: string,
  docs: { id: string; matterId: string | null }[]
): Promise<DocumentReadContext> {
  const docIds = docs.map((d) => d.id);
  const matterIds = [...new Set(docs.map((d) => d.matterId).filter((x): x is string => !!x))];

  const [user, seals] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } }),
    docIds.length
      ? prisma.sealRequest.findMany({
          where: { OR: [{ draftDocId: { in: docIds } }, { stampedDocId: { in: docIds } }] },
          select: { id: true, draftDocId: true, stampedDocId: true, requestedById: true, approvedById: true, stampedById: true, status: true }
        })
      : Promise.resolve([] as { id: string; draftDocId: string | null; stampedDocId: string | null; requestedById: string | null; approvedById: string | null; stampedById: string | null; status: string }[])
  ]);

  const sealsByDocId = new Map<string, (typeof seals)[number] | null>();
  for (const row of seals) {
    // findFirst 的语义是「取一条」：同一材料可能既是某单 draft 又是另一单 stamped，
    // 逐条 findFirst 只会返回其中一条，所以这里也「先到先留」。
    for (const id of new Set([row.draftDocId, row.stampedDocId])) {
      if (id && !sealsByDocId.has(id)) sealsByDocId.set(id, row);
    }
  }

  // user 不存在或已停用：后续分支都会早退，不必再查 access / 墙 / 归属。
  if (!user || !user.active) {
    return { user, sealsByDocId, access: undefined, walledMatterIds: new Set(), accessibleMatterIds: new Set() };
  }

  const access = await resolveRoleUser(userId, user.role);

  // 墙：一次查出「该用户被点名的墙」对应的 matterId。
  // 与 isMatterWalledFor 条件一致（USER / TEAM / ROLE + 时效），只是从「逐案 findFirst」
  // 换成「一次 findMany 再取 matterId」。
  let walledMatterIds = new Set<string>();
  if (matterIds.length) {
    const walls = await prisma.ethicalWall.findMany({
      where: {
        matterId: { in: matterIds },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          {
            denials: {
              some: {
                OR: [
                  { denyType: "USER", userId },
                  { denyType: "TEAM", team: { members: { some: { userId, active: true } } } },
                  ...(user.role ? [{ denyType: "ROLE" as const, role: user.role as never }] : [])
                ]
              }
            }
          }
        ]
      },
      select: { matterId: true }
    });
    walledMatterIds = new Set(walls.map((w) => w.matterId));
  }

  // 归属：一次查出「该用户是 owner 或 member 且未软删」的 matterId。
  // 对应 :76 那条 matter.count。
  let accessibleMatterIds = new Set<string>();
  if (matterIds.length) {
    const rows = await prisma.matter.findMany({
      where: { id: { in: matterIds }, deletedAt: null, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      select: { id: true }
    });
    accessibleMatterIds = new Set(rows.map((r) => r.id));
  }

  return { user, sealsByDocId, access, walledMatterIds, accessibleMatterIds };
};

export async function canReadDocument(
  userId: string,
  doc: { id: string; uploadedById: string; matterId: string | null; intakeId: string | null; deletedAt?: Date | null },
  ctx?: DocumentReadContext
) {
  const user = ctx?.user !== undefined
    ? ctx.user
    : await prisma.user.findUnique({ where: { id: userId }, select: { role: true, active: true } });
  if (!user?.active || doc.deletedAt) return false;
  const access = ctx?.access !== undefined ? ctx.access : await resolveRoleUser(userId, user.role);
  if (!access.enabled) return false;

  // 隔离墙（2026-11-20 补）：这是**下载/预览**的统一判定，22 处调用点覆盖
  // /api/documents/[id]/download、/preview、桌面端签出、全局搜索逐条过滤等。
  // 此前全仓只有读取列表用了墙（matterReadVisibilityFilter），单份材料的下载判定
  // 只查成员关系 —— 于是被墙隔离的人在看板上看不到该案件，却能直接下载它的材料全文。
  // 读取侧注释明写「隔离墙对全所生效（含合伙人/管理员）……执业合规要求」。
  // 墙检查放在一切放行分支之前，顺序与 canReviewDocument 一致。
  if (doc.matterId) {
    if (ctx?.walledMatterIds !== undefined) {
      if (ctx.walledMatterIds.has(doc.matterId)) return false;
    } else {
      const { isMatterWalledFor } = await import("@/lib/permissions/ethical-wall");
      if (await isMatterWalledFor(prisma, { matterId: doc.matterId, userId, role: user.role })) return false;
    }
  }
  if(scopeFor(access,'finance.correct')==='ALL'&&await financeLedgerReady(prisma)){
    const [basis]=await prisma.$queryRaw<{n:bigint}[]>`SELECT COUNT(*) AS n FROM "BillingAttachment" a JOIN "Billing" b ON b.id=a."billingId" WHERE a."documentId"=${doc.id} AND b.status IN ('DRAFT','ACTIVE')`;
    if(Number(basis.n))return true;
    const [adjustment]=await prisma.$queryRaw<{n:bigint}[]>`SELECT COUNT(*) AS n FROM "InvoiceAdjustment" WHERE "documentId"=${doc.id}`;
    if(Number(adjustment.n))return true;
  }
  const canReadBusiness = hasCustomPermission(access, "documents.download") && hasCustomPermission(access, "matters.read");
  // 仅合伙人岗位直通全所材料；managerAuthorized 按契约只开放「可见」，附件下载不随管理权放大（AGENTS 业务管理权决议）
  if (isManager(access.role)) return true;
  const seal = ctx?.sealsByDocId !== undefined
    ? (ctx.sealsByDocId.get(doc.id) ?? null)
    : await prisma.sealRequest.findFirst({ where: { OR: [{ draftDocId: doc.id }, { stampedDocId: doc.id }] }, select: { id: true, requestedById: true, approvedById: true, stampedById: true, status: true } });
  if (seal) {
    return seal.requestedById === userId || seal.approvedById === userId || seal.stampedById === userId
      || (seal.status === "PENDING" && await canApproveItem(userId, "SEAL_APPROVE", seal.id))
      || (seal.status === "APPROVED" && await canApproveItem(userId, "SEAL_STAMP", seal.id))
      || await hasHandledApproval(userId, "SEAL_APPROVE", seal.id, doc.id);
  }
  // 上传者通道只覆盖无归属材料：挂在案件/收案上的材料须经 :29 起的归属分支——
  // 否则被移出案件的成员凭历史上传关系仍可长期下载该案材料（内置角色同样适用）
  if (canReadBusiness && doc.uploadedById === userId && !doc.matterId && !doc.intakeId) return true;
  // 2026-11-20（A6 修复）：加 deletedAt 条件，与列表口径一致。
  //
  // 此前这里只查归属，不看案件是否已被软删。而 listMatters / assertCanReadMatter
  // 都带 `deletedAt: null` —— 于是出现「列表里看不到这个案件，但知道材料 ID
  // 就能下载它的材料」。这不是设计选择，是口径不一致。
  //
  // 软删可恢复：案件恢复（deletedAt 置回 null）后，材料自动重新可下载，
  // 与「删除不销毁数据」的既有语义不冲突。
  if (canReadBusiness && doc.matterId) {
    // 2026-11-21：归档案件的**材料内容取阅**按策略要求有效借阅。
    //
    // 为什么要加这一跳：归档不收回团队/主办对案件的可见性，
    // 于是「案件关系 → 直接下载材料」这条老路让借阅链空转
    // （借阅授权只对"常规路径不通过"的人生效，而那些人在申请处就被拒）。
    // 详见 src/server/archive/borrow-policy.ts 的缺陷说明。
    //
    // 只作用于材料内容，不影响案件元数据读取——否则归档等于消失。
    const matterState = await prisma.matter.findUnique({
      where: { id: doc.matterId },
      select: { deletedAt: true, status: true, ownerId: true, members: { where: { userId }, select: { userId: true } } }
    });
    const isMine = Boolean(
      matterState && !matterState.deletedAt &&
      (matterState.ownerId === userId || matterState.members.length > 0)
    );
    if (isMine) {
      if (matterState!.status !== "ARCHIVED") return true;
      const { getArchiveMaterialPolicy, hasActiveArchiveBorrowGrant } = await import("@/server/archive/borrow-policy");
      if (await getArchiveMaterialPolicy() === "OPEN") return true;
      if (await hasActiveArchiveBorrowGrant(userId, doc.matterId)) return true;
      // 归档人/审批人仍可看 —— 不能把归档的人自己锁在外面，否则没人愿意做归档这件事
      const archivist = await prisma.archiveRecord.findFirst({
        where: {
          matterId: doc.matterId,
          status: { in: ["APPROVED", "PENDING_REVIEW"] },
          OR: [{ archivedById: userId }, { reviewedById: userId }]
        },
        select: { id: true }
      });
      if (archivist) return true;
      // 归档且无有效借阅：**在这里收敛为拒绝**，不再落到后面的「历史上传关系 / 审批历史」
      // 分支 —— 否则一个当年上传过材料的律师，在案件归档后仍能凭上传记录长期下载全文，
      // 「归档 = 收起来」就名存实亡。这正是借阅链空转的另一半成因。
      return false;
    }
  }
  if (doc.intakeId) {
    const intake = await prisma.intake.findUnique({ where: { id: doc.intakeId }, select: { createdById: true, ownerUserId: true, coUserIds: true, status: true } });
    if (intake?.createdById === userId) return true;
    if (canReadBusiness && intake && (intake.createdById === userId || intake.ownerUserId === userId || intake.coUserIds.includes(userId))) return true;
    if (intake?.status === "PENDING_CONFIRMATION" && await canApproveItem(userId, "INTAKE_APPROVE", doc.intakeId)) return true;
    if (await hasHandledApproval(userId, "INTAKE_APPROVE", doc.intakeId, doc.id)) return true;
  }
  const review = await prisma.document.findUnique({ where: { id: doc.id }, select: { status: true, approvedById: true, reviewedById: true } });
  if (doc.uploadedById === userId && review && (review.status !== "DRAFT" || await prisma.auditLog.findFirst({ where: { userId, action: "DOCUMENT_SUBMIT_REVIEW", targetType: "Document", targetId: doc.id }, select: { id: true } }))) return true;
  if (review?.status === "PENDING_REVIEW" && await canApproveItem(userId, "DOCUMENT_APPROVE", doc.id)) return true;
  if (review?.approvedById === userId || review?.reviewedById === userId || await hasHandledApproval(userId, "DOCUMENT_APPROVE", doc.id)) return true;
  const invoices = await prisma.invoiceRequest.findMany({ where: { OR: [{ evidenceDocIds: { has: doc.id } }, { contractScanId: doc.id }, { invoiceFileId: doc.id }] }, select: { id: true, requestedById: true, processedById: true, status: true } });
  for (const invoice of invoices) if (invoice.requestedById === userId || invoice.processedById === userId || ((invoice.status === "PENDING" && await canApproveItem(userId, "INVOICE_APPROVE", invoice.id)) || (invoice.status === "APPROVED" && await canExecuteInvoice(userId, invoice.id))) || await hasHandledApproval(userId, "INVOICE_APPROVE", invoice.id, doc.id)) return true;
  const archives = await prisma.archiveRecord.findMany({
    where: {
      OR: [
        { coverDocId: doc.id },
        { catalogDocId: doc.id },
        { checklistJson: { path: ["documentIds"], array_contains: [doc.id] } }
      ]
    },
    select: { id: true, status: true, archivedById: true, reviewedById: true }
  });
  for (const archive of archives) if (archive.archivedById === userId || archive.reviewedById === userId || (archive.status === "PENDING_REVIEW" && await canApproveItem(userId, "ARCHIVE_APPROVE", archive.id)) || await hasHandledApproval(userId, "ARCHIVE_APPROVE", archive.id, doc.id)) return true;
  return false;
}
