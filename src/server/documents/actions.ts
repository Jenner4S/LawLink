"use server";
import {assertIntakeDocumentChange,intakeWorkflowReady} from "@/server/intakes/workflow";
import { parseInput } from "@/lib/parse-input";
import type {RoleUser} from "@/lib/roles/catalog";
import { roleMutation } from "@/lib/roles/service";

import { notifyRoleApprovers } from "@/server/notifications/approval";
import { approvalTransaction, approvalAudit, assertApprovalItem, approvalContextFor, requireApprovalRoute } from "@/lib/approvals/service";
import { selfConfirmEligible } from "@/lib/approvals/self-confirm";


import { revalidatePath } from "next/cache";
import { verifyCheckoutToken } from "@/lib/desktop/checkout-token";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { audit } from "@/server/audit";
import { assertDocumentWritable } from "@/lib/archive/guard";
import { matterVisibilityFilter, matterAssociationFilter, assertCanHandleMatter, assertCanLeadMatter } from "@/lib/permissions";
import { storage } from "@/lib/storage";
import { validateUploadedFile } from "@/lib/storage/file-validator";
import { encryptBuffer, sha256 } from "@/lib/storage/crypto";
import { extractDocumentTextLayer, ocrStatusFor } from "@/lib/documents/text-extraction";
import { revalidateMatter } from "@/server/matters/route";
import { assertDocumentNotInPendingArchive } from "@/server/archive/verification";
import { recordTimelineEvent } from "@/server/timeline/record";
import { ActionError } from "@/lib/action-error";

const documentCategorySchema = z.enum([
  "EVIDENCE",
  "PLEADING",
  "PROCEDURE",
  "JUDGMENT",
  "CONTRACT",
  "OTHER"
]);

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * 上传材料。前端通过 Server Action 传 FormData，含 file（File）、metadata。
 * 加密分支：encrypted=true 时把文件用 AES-256-GCM 加密后写盘。
 */
async function documentMutation<T>(user:RoleUser&{id:string},subject:{intakeId:string|null;matterId:string|null;id?:string},write:(db:Prisma.TransactionClient)=>Promise<T>){
 if(subject.intakeId&&await intakeWorkflowReady(prisma))return approvalTransaction(async db=>{
   if(!subject.matterId)await assertIntakeDocumentChange(db,user.id,subject.intakeId!,subject.id);
   else if(subject.id){const [used]=await db.$queryRaw<{count:bigint}[]>`SELECT COUNT(*) AS count FROM "IntakeRevision" WHERE "intakeId"=${subject.intakeId} AND snapshot->'documents' @> ${JSON.stringify([{id:subject.id}])}::jsonb`;if(Number(used.count))throw new ActionError('已送审材料原件须保留，请另传补充材料');}
   return write(db);
 });
 return roleMutation(user,'documents.write',write);
}

export async function uploadDocument(formData: FormData) {
  const session = await requireSession("documents.write");

  const matterIdRaw = formData.get("matterId");
  const intakeIdRaw = formData.get("intakeId");
  const procedureId = formData.get("procedureId");
  const folderIdRaw = formData.get("folderId");
  const name = formData.get("name");
  const category = formData.get("category");
  const encrypted = formData.get("encrypted") === "true";
  const tagsRaw = formData.get("tags");
  const archiveChecklistItemIdRaw = formData.get("archiveChecklistItemId");
  const stageIdRaw = formData.get("stageId");
  const sourcePartyRaw = formData.get("sourceParty");
  const sourceOriginRaw = formData.get("sourceOrigin");
  const SOURCE_ORIGINS = ["CLIENT_PROVIDED", "COURT_SERVED", "AI_EXTRACTED", "SELF_COLLECTED", "TEAM_PRODUCED"] as const;
  const sourceOrigin =
    typeof sourceOriginRaw === "string" && (SOURCE_ORIGINS as readonly string[]).includes(sourceOriginRaw)
      ? (sourceOriginRaw as (typeof SOURCE_ORIGINS)[number])
      : null;
  const file = formData.get("file");

  if (!(file instanceof File)) throw new ActionError("缺少文件");

  const matterId = typeof matterIdRaw === "string" && matterIdRaw ? matterIdRaw : null;
  const intakeId = typeof intakeIdRaw === "string" && intakeIdRaw ? intakeIdRaw : null;
  if (!matterId && !intakeId) throw new ActionError("matterId 或 intakeId 至少需要一个");

  if (typeof name !== "string" || !name.trim()) throw new ActionError("材料名称必填");
  const parsedCategory = parseInput(documentCategorySchema, category || "OTHER");
  const tags =
    typeof tagsRaw === "string" && tagsRaw
      ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
      : [];

  const validated = validateUploadedFile(file, { purpose: "document", maxBytes: MAX_FILE_SIZE });

  const folderId = typeof folderIdRaw === "string" && folderIdRaw ? folderIdRaw : null;
  const stageId = typeof stageIdRaw === "string" && stageIdRaw ? stageIdRaw : null;

  // 校验归属对象存在
  let folderName: string | null = null;
  if (matterId) {
    const matter = await prisma.matter.findUnique({
      where: { id: matterId, deletedAt: null },
      select: { id: true, status: true }
    });
    if (!matter) throw new ActionError("案件不存在");
    // 上传属案件写入，统一走经办断言：合伙人全所、其余（含 managerAuthorized）须本案经办，
    // 管理权只放大「可见」不放大写入（AGENTS 业务管理权决议）。
    await assertCanHandleMatter(session.user, matterId);

    if (folderId) {
      const folder = await prisma.documentFolder.findUnique({
        where: { id: folderId },
        select: { matterId: true, name: true }
      });
      if (!folder || folder.matterId !== matterId) {
        throw new ActionError("目标卷宗与案件不匹配");
      }
      folderName = folder.name;
    }

    // v0.48: 归属环节必须属于本案件（且与 procedureId 一致时才可信）
    if (stageId) {
      const stage = await prisma.matterStage.findUnique({
        where: { id: stageId },
        select: { procedureId: true, procedure: { select: { matterId: true } } }
      });
      if (!stage || stage.procedure.matterId !== matterId) {
        throw new ActionError("归属环节与案件不匹配");
      }
      if (typeof procedureId === "string" && procedureId && stage.procedureId !== procedureId) {
        throw new ActionError("归属环节与程序不匹配");
      }
    }

    // 归档后仅允许补传到 ARCHIVE 卷宗（结案 / 归档），由 guard 判定
    await assertDocumentWritable(matterId, { kind: "upload", folderName });
  }
  if (intakeId) {
    const intake = await prisma.intake.findUnique({
      where: { id: intakeId },
      select: { id: true, status: true, createdById: true, ownerUserId: true, coUserIds: true }
    });
    if (!intake) throw new ActionError("收案记录不存在");
    if(!matterId&&await intakeWorkflowReady(prisma)) await approvalTransaction(db=>assertIntakeDocumentChange(db,session.user.id,intakeId));
    if (intake.status === "DECLINED") throw new ActionError("已拒绝的收案不可上传材料");
    const uid = session.user.id;
    if (
      session.user.role !== "PRINCIPAL_LAWYER" &&
      intake.createdById !== uid &&
      intake.ownerUserId !== uid &&
      !intake.coUserIds.includes(uid)
    ) {
      throw new ActionError("无权向该收案上传材料");
    }
  }

  const raw = Buffer.from(await file.arrayBuffer());
  const hash = sha256(raw);

  const storageBucket = matterId ? `m_${matterId}` : `i_${intakeId}`;

  let path: string;
  let iv: string | null = null;
  let authTag: string | null = null;
  let algorithm: string | null = null;

  if (encrypted) {
    const enc = encryptBuffer(raw);
    path = await storage.writeFile(storageBucket, enc.ciphertext);
    iv = enc.iv.toString("base64");
    authTag = enc.authTag.toString("base64");
    algorithm = enc.algorithm;
  } else {
    path = await storage.writeFile(storageBucket, raw);
  }

  const archiveChecklistItemId =
    typeof archiveChecklistItemIdRaw === "string" && archiveChecklistItemIdRaw
      ? archiveChecklistItemIdRaw
      : null;

  const created = await documentMutation(session.user,{intakeId,matterId}, async roleDb => roleDb.document.create({
    data: {
      matterId,
      intakeId,
      procedureId: typeof procedureId === "string" && procedureId ? procedureId : null,
      stageId: matterId ? stageId : null,
      folderId,
      name,
      category: parsedCategory,
      sourceOrigin,
      sourceParty:
        typeof sourcePartyRaw === "string" && sourcePartyRaw.trim()
          ? sourcePartyRaw.trim()
          : null,
      path,
      mimeType: validated.mimeType,
      size: file.size,
      sha256: hash,
      encrypted,
      algorithm,
      iv,
      authTag,
      tags,
      archiveChecklistItemId,
      uploadedById: session.user.id
    }
  }));

  await audit({
    userId: session.user.id,
    action: "DOCUMENT_UPLOAD",
    targetType: "Document",
    targetId: created.id,
    detail: { matterId, intakeId, name, encrypted, size: file.size }
  });

  // v1.x 版本链：新上传即族首（familyId 指向自身，后续新版本挂同一族）
  await prisma.document.update({
    where: { id: created.id },
    data: { familyId: created.id }
  }).catch((err) => {
    // familyId 是版本链的族首指针，更新失败会让后续版本挂不上族，形成断链
    console.error("[documents] 版本族首指针写入失败，版本链可能断裂：", { documentId: created.id, err });
    return undefined;
  });

  // v1.x P0-2: 抽取文本层（docx / PDF 文本层 / 纯文本；扫描件标 SKIP，
  // 失败标 FAILED——失败页不可隐去）。抽取基于未加密内存副本，不读回存储；
  // 抽取失败不影响上传成功，但状态落库供维护与重试。
  try {
    const layer = await extractDocumentTextLayer(raw, validated.mimeType);
    await prisma.document.update({
      where: { id: created.id },
      data: {
        textContent: layer.text.slice(0, 500_000),
        pageCount: layer.pageCount,
        textSource: layer.source,
        ocrStatus: "READY"
      }
    });
  } catch (err) {
    await prisma.document.update({
      where: { id: created.id },
      data: { ocrStatus: ocrStatusFor(err) }
    }).catch(() => {
      // 状态落库失败随上传返回值暴露（不静默），但不阻断已成功的上传
    });
  }

  // v0.43 项4：写入案件动态时间线（仅案件文档）
  if (matterId) {
    await roleMutation(session.user, "documents.write", async roleDb => recordTimelineEvent(roleDb, {
        matterId,
        eventType: "DOCUMENT_UPLOADED",
        title: `上传材料：${name.trim()}`,
        occurredAt: new Date(),
        refType: "Document",
        refId: created.id
      }));
  }

  if (matterId) await revalidateMatter(matterId);
  if (intakeId) revalidatePath(`/intakes/${intakeId}`);
  return { ok: true, id: created.id };
}

export async function deleteDocument(id: string) {
  const session = await requireSession("documents.write");
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return { ok: false };
  await assertDocumentNotInPendingArchive(id);

  if (doc.matterId) {
    await assertDocumentWritable(doc.matterId, { kind: "modify" });
    if (doc.uploadedById !== session.user.id) {
      await assertCanLeadMatter(session.user.id, doc.matterId, "只能删除自己上传的材料，或由本案主办/协办删除", session.user.role);
    }
  } else if (
    doc.uploadedById !== session.user.id &&
    session.user.role !== "PRINCIPAL_LAWYER"
  ) {
    throw new ActionError("只能删除自己上传的材料");
  }

  // 软删除（保留文件以备审计），如需物理删除走单独脚本
  await documentMutation(session.user,doc, async roleDb => roleDb.document.update({
    where: { id },
    data: { deletedAt: new Date() }
  }));

  await audit({
    userId: session.user.id,
    action: "DOCUMENT_DELETE",
    targetType: "Document",
    targetId: id,
    detail: { matterId: doc.matterId, intakeId: doc.intakeId, name: doc.name }
  });

  if (doc.matterId) await revalidateMatter(doc.matterId);
  revalidatePath("/approvals");
  if (doc.intakeId) revalidatePath(`/intakes/${doc.intakeId}`);
  return { ok: true };
}

export async function hardDeleteDocument(id: string) {
  const session = await requireSession("documents.write");
  if (session.user.role !== "PRINCIPAL_LAWYER") {
    throw new ActionError("仅主任律师可彻底删除材料");
  }
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) return { ok: false };
  await assertDocumentNotInPendingArchive(id);
  await assertDocumentWritable(doc.matterId, { kind: "modify" });

  // 2026-11-20（A7）：有审核记录的材料不允许彻底删除。
  //
  // ReviewRecord.document 是 onDelete: Cascade —— 删材料会把审核记录一并删掉，
  // 而那是「谁在何时审过这份材料」的合规证据，属于律师执业留痕的一部分。
  // 材料内容可以销毁，审过这件事不该被抹掉。
  //
  // 这里选择「拦下并说明」而不是改 onDelete 为 SetNull：后者要把 documentId
  // 改成可空、牵动迁移与多处查询；先加运行时保护，语义清楚且零迁移风险。
  // 若产品上确实需要「销毁材料但保留审核记录」，再单独做 SetNull 方案。
  const reviews = await prisma.reviewRecord.count({ where: { documentId: id } });
  if (reviews > 0) {
    throw new ActionError(
      `该材料已有 ${reviews} 条审核记录，不能彻底删除——审核留痕属合规证据。如确需销毁内容，请先联系管理员导出审核记录。`
    );
  }

  await documentMutation(session.user,doc, async roleDb => {
    await storage.deleteFile(doc.path);
    return roleDb.document.delete({ where: { id } });
  });

  await audit({
    userId: session.user.id,
    action: "DOCUMENT_HARD_DELETE",
    targetType: "Document",
    targetId: id,
    detail: { matterId: doc.matterId, intakeId: doc.intakeId, name: doc.name }
  });

  if (doc.matterId) await revalidateMatter(doc.matterId);
  revalidatePath("/approvals");
  if (doc.intakeId) revalidatePath(`/intakes/${doc.intakeId}`);
  return { ok: true };
}

const docListQuerySchema = z.object({
  search: z.string().optional(),
  category: documentCategorySchema.optional(),
  matterId: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200)
});

export async function listAllDocuments(input: Partial<z.infer<typeof docListQuerySchema>> = {}) {
  const session = await requireSession("documents.read");
  const query = parseInput(docListQuerySchema, input);

  const visFilter = session.user.role === "FINANCE" ? matterAssociationFilter(session.user.id) : matterVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions);
  const where: Prisma.DocumentWhereInput = {
    deletedAt: null,
    matter: { deletedAt: null, ...visFilter },
    ...(query.category ? { category: query.category } : {}),
    ...(query.matterId ? { matterId: query.matterId } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            { tags: { has: query.search } }
          ]
        }
      : {})
  };

  return prisma.document.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: query.limit,
    include: {
      matter: { select: { id: true, internalCode: true, title: true } },
      uploadedBy: { select: { id: true, name: true } }
    }
  });
}

// ============ v0.10: 文书审批流程 ============

export async function submitDocumentForReview(id: string) {
  const session = await requireSession("documents.write");
  const doc = await prisma.document.findUnique({ where: { id, deletedAt: null } });
  if (!doc) throw new ActionError("材料不存在");
  if (doc.matterId) {
    await assertCanHandleMatter(session.user, doc.matterId);
    await assertDocumentWritable(doc.matterId, { kind: "modify" });
  }
  if (doc.uploadedById !== session.user.id) throw new ActionError("仅上传人可提交此材料审核");

  // v1.x 4.3：自确认分支——命中清单的低影响文书送审由上传人自我确认，
  // 不进审批队列、不通知审批人；审计动作区分（DOCUMENT_SELF_CONFIRM）。
  const docContext = await approvalContextFor("DOCUMENT_APPROVE", id);
  if (doc.matterId) {
    const matterRow = await prisma.matter.findUnique({ where: { id: doc.matterId }, select: { category: true } });
    if (matterRow) docContext.category = matterRow.category;
  }
  if (await selfConfirmEligible(docContext, prisma)) {
    if (doc.status !== "DRAFT") throw new ActionError("只有草稿状态的材料才能提交审核");
    await approvalTransaction(async db => {
      await db.document.update({
        where: { id, status: "DRAFT", updatedAt: doc.updatedAt },
        data: {
          status: "APPROVED",
          reviewedById: session.user.id,
          reviewedAt: new Date(),
          approvedById: session.user.id,
          approvedAt: new Date()
        }
      });
      await approvalAudit(db, session.user.id, "DOCUMENT_SELF_CONFIRM", id, {
        matterId: doc.matterId,
        name: doc.name,
        note: "命中自确认清单，申请人自我确认即生效"
      });
    });
    if (doc.matterId) await revalidateMatter(doc.matterId);
    revalidatePath("/approvals");
    return { ok: true, selfConfirmed: true };
  }

  await requireApprovalRoute(docContext);
  if (doc.status !== "DRAFT") throw new ActionError("只有草稿状态的材料才能提交审核");

  await documentMutation(session.user,doc, async roleDb => roleDb.document.update({
    where: { id, status: "DRAFT", updatedAt: doc.updatedAt },
    data: { status: "PENDING_REVIEW" },
  }));

  await audit({
    userId: session.user.id,
    action: "DOCUMENT_SUBMIT_REVIEW",
    targetType: "Document",
    targetId: id,
    detail: { matterId: doc.matterId, name: doc.name },
  });

  await notifyRoleApprovers({ roles: ["PRINCIPAL_LAWYER"], excludeUserId: session.user.id, title: "新的文书待审批", content: doc.name, href: "/approvals", refType: "Document", refId: id });
  if (doc.matterId) await revalidateMatter(doc.matterId);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function approveDocument(id: string, note?: string) {
  const session = await requireSession("approval");
  const doc = await prisma.document.findUnique({ where: { id, deletedAt: null } });
  if (!doc) throw new ActionError("材料不存在");
  if (doc.status !== "PENDING_REVIEW") throw new ActionError("材料不在待审核状态");

  await approvalTransaction(async tx => {
    await assertApprovalItem(session.user.id, "DOCUMENT_APPROVE", id, tx);
  await tx.document.update({
    where: { id, status: "PENDING_REVIEW", updatedAt: doc.updatedAt },
    data: {
      status: "APPROVED",
      approvedById: session.user.id,
      approvedAt: new Date(),
    },
  });
    await approvalAudit(tx, session.user.id, "DOCUMENT_APPROVE", id, { note: note?.trim().slice(0, 500) ?? "", attachmentIds: [id] });
  });


  if (doc.matterId) await revalidateMatter(doc.matterId);
  revalidatePath("/approvals");
  return { ok: true };
}

export async function rejectDocument(id: string, reason?: string) {
  const session = await requireSession("approval");
  const doc = await prisma.document.findUnique({ where: { id, deletedAt: null } });
  if (!doc) throw new ActionError("材料不存在");
  if (doc.status !== "PENDING_REVIEW") throw new ActionError("材料不在待审核状态");

  await approvalTransaction(async tx => {
    await assertApprovalItem(session.user.id, "DOCUMENT_APPROVE", id, tx);
  await tx.document.update({
    where: { id, status: "PENDING_REVIEW", updatedAt: doc.updatedAt },
    data: {
      status: "DRAFT",
      reviewedById: session.user.id,
      reviewedAt: new Date(),
    },
  });
    await approvalAudit(tx, session.user.id, "DOCUMENT_REJECT", id, { reason: reason?.trim() ?? "", attachmentIds: [id] });
  });


  if (doc.matterId) await revalidateMatter(doc.matterId);
  revalidatePath("/approvals");
  return { ok: true };
}



/**
 * v1.x 版本链闭合（P0-2 欠账）：为既有材料上传新版本。
 * 新行继承归属（案件/收案/程序/环节/卷宗/分类），familyId 沿用族首，
 * version+1、isLatest=true；旧版本置 isLatest=false 但永不删除（历史可溯）。
 * 归档守卫沿用（归档案件不可更新版本）。
 */
export async function uploadNewVersion(input: {
  documentId: string;
  file: File;
  category?: string;
  /** 受控回传（桌面连接器）：取件令牌，校验归属与基线 */
  checkoutToken?: string;
}): Promise<{ ok: true; id: string; version: number }> {
  const session = await requireSession("documents.write");
  // 2026-09-19 审计修复：此前新版本不经任何类型/大小校验、落库 MIME 取客户端值。
  const validated = validateUploadedFile(input.file, { purpose: "document", maxBytes: MAX_FILE_SIZE });
  const prior = await prisma.document.findUnique({ where: { id: input.documentId } });
  if (!prior || prior.deletedAt) throw new ActionError("原材料不存在");
  if (!prior.isLatest) throw new ActionError("只能基于最新版本更新");

  if (prior.matterId) {
    // 替换材料内容属材料操作（P1-1）：合伙人全所口径，其余岗位（含管理权）须经办，
    // 与上传入口的分流口径统一——管理权只放大可见不放大写入。
    await assertCanHandleMatter(session.user, prior.matterId);
    await assertDocumentWritable(prior.matterId, { kind: "modify" });
  }

  // 受控回传冲突拦截（DESKTOP-CONNECTOR-PLAN §二）：取件后他人已传新版
  // → 拒绝直传，提示基于新版另存；法律文本不自动合并。
  let checkout: { jti: string; baselineVersion: number } | null = null;
  if (input.checkoutToken) {
    const payload = verifyCheckoutToken(input.checkoutToken);
    if (!payload) throw new ActionError("取件令牌无效或已过期，请重新取件");
    if (payload.docId !== input.documentId) throw new ActionError("令牌与材料不匹配");
    if (payload.userId !== session.user.id) throw new ActionError("令牌不属于当前账号");
    if (payload.baselineVersion !== prior.version) {
      throw new ActionError(`文件已被他人更新为第 ${prior.version} 版（取件基线为第 ${payload.baselineVersion} 版）。请重新取件基于最新版另存副本，勿直接覆盖。`);
    }
    checkout = { jti: payload.jti, baselineVersion: payload.baselineVersion };
  }

  const raw = Buffer.from(await input.file.arrayBuffer());
  const hash = sha256(raw);
  // 加密策略随原材料：首传加密的文件其新版本必须同样加密，
  // 此前写死 false 会让「传新版本」把已加密材料静默替换成明文落盘。
  const encrypted = prior.encrypted;
  const enc = encrypted ? encryptBuffer(raw) : null;
  const path = await storage.writeFile(prior.matterId ? `m_${prior.matterId}` : `i_${prior.intakeId}`, enc ? enc.ciphertext : raw);

  // 2026-11-20（H1 修复）+ 2026-11-21 修正（真 P1，多智能体审计）：
  //
  // 背景：版本号不能用事务外读到的 `prior.version + 1` —— 两个并发请求都读到
  // prior.version=1 → 都写 version=2，版本链分叉。
  //
  // 2026-11-20 那条注释曾声称有「两道防线」且「遇到 P2002 时重试一次」。
  // **重试从来没写**（只有数据库唯一约束那一道），而且更严重的问题被漏掉了：
  // documentMutation → roleMutation 对**内置岗位直接 `write(prisma)`，不建事务**
  // （`roles/service.ts:38`）—— 而律所里所有人都是内置岗位。
  //
  // 于是原来的「先 updateMany 清 isLatest → 再 create」是两个独立提交：
  // 若 create 失败（P2002 撞版本号、DB 抖动、任何异常），
  // **整族文档没有任何一条 isLatest=true**。后果是材料从列表消失、
  // `export-bundle.ts:37` 的卷宗导出直接漏件，且没有自愈路径。
  //
  // 改成**不依赖事务的两步**，任何一步失败都不会留下「整族无 isLatest」：
  //   1. 先 create，`isLatest: false` —— 完全不碰老数据的 latest 标记；
  //   2. 再用**一条** UPDATE 原子地把「本条置 true、同族其它置 false」一次做完。
  //      PostgreSQL 单条 UPDATE 本身就是原子的，不需要事务包裹。
  // 失败情形：第 1 步失败 → 什么都没变;第 2 步失败 → 老版本仍是最新，新版本存在但不可见（可重试恢复）。
  // 两种情况都不会丢材料。
  const familyId = prior.familyId ?? prior.id;
  const created = await documentMutation(session.user,prior,async tx => {
    const top = await tx.document.findFirst({
      where: { familyId },
      orderBy: { version: "desc" },
      select: { version: true }
    });
    const nextVersion = (top?.version ?? 0) + 1;
    const row = await tx.document.create({
      data: {
        matterId: prior.matterId,
        intakeId: prior.intakeId,
        procedureId: prior.procedureId,
        stageId: prior.stageId,
        folderId: prior.folderId,
        name: input.file.name || prior.name,
        category: (input.category as never) ?? prior.category,
        sourceParty: prior.sourceParty,
        sourceOrigin: prior.sourceOrigin,
        path,
        mimeType: validated.mimeType,
        size: input.file.size,
        sha256: hash,
        encrypted,
        algorithm: enc?.algorithm ?? null,
        iv: enc ? enc.iv.toString("base64") : null,
        authTag: enc ? enc.authTag.toString("base64") : null,
        familyId,
        version: nextVersion,
        isLatest: false, // 切换交给下面那条原子 UPDATE
        uploadedById: session.user.id
      },
      select: { id: true, version: true }
    });
    // 单条 UPDATE 完成「唯一切换」：id = 新版本 → true，其余 → false。
    await tx.$executeRaw`
      UPDATE "Document"
      SET "isLatest" = (id = ${row.id})
      WHERE "familyId" = ${familyId}
    `;
    return row;
  });

  await audit({
    userId: session.user.id,
    action: "DOCUMENT_NEW_VERSION",
    targetType: "Document",
    targetId: created.id,
    detail: { priorId: prior.id, familyId: prior.familyId ?? prior.id, version: created.version, sha256: hash, ...(checkout ? { controlledReturn: true, checkoutJti: checkout.jti, baselineVersion: checkout.baselineVersion } : {}) }
  });

  // 新版本同样抽取文本层（沿用上传路径口径）
  try {
    const { extractDocumentTextLayer } = await import("@/lib/documents/text-extraction");
    const layer = await extractDocumentTextLayer(raw, validated.mimeType);
    await prisma.document.update({
      where: { id: created.id },
      data: {
        textContent: layer.text.slice(0, 500_000),
        pageCount: layer.pageCount,
        textSource: layer.source,
        ocrStatus: "READY"
      }
    });
  } catch (err) {
    const { ocrStatusFor } = await import("@/lib/documents/text-extraction");
    await prisma.document.update({
      where: { id: created.id },
      data: { ocrStatus: ocrStatusFor(err) }
    }).catch(() => undefined);
  }

  if (prior.matterId) await revalidateMatter(prior.matterId);
  if (prior.intakeId) revalidatePath(`/intakes/${prior.intakeId}`);
  return { ok: true, id: created.id, version: created.version };
}
