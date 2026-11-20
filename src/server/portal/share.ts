"use server";

/**
 * 员工侧「分享给客户」的动作（2026-11-20，门户 S2）
 *
 * 权限口径（方案 §二 决策 3）：
 *   · 分享（写）走**员工既有断言** `assertCanHandleMatter` + `assertMatterWritable`——
 *     只有能办这个案的人能分享；**已归档案件不可再分享**（归档即冻结）。
 *   · 与门户读取断言（`lib/portal/access.ts`）严格分开，互不调用。
 *
 * 两个刻意的限制：
 *   ① **客户必须有关联的 primaryClientId**：材料挂在案件上，案件没有委托方就无从
 *      确定给哪个客户看。硬猜会让材料流到错误的人手里。
 *   ② **同一份材料重复分享不新增行**：已存在未撤销的分享就直接返回现有记录，
 *      否则客户会看到重复条目，撤销也会留下多条"看似仍在"的行。
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseInput } from "@/lib/parse-input";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { assertCanHandleMatter } from "@/lib/permissions";
import { assertMatterWritable } from "@/lib/archive/guard";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";

const shareDocumentSchema = z.object({
  documentId: z.string().trim().min(1, "缺少材料标识"),
  note: z.string().trim().max(200).optional().or(z.literal(""))
});

/** 分享一份材料给该案件的委托客户 */
export async function shareDocumentToPortal(input: z.input<typeof shareDocumentSchema>) {
  const session = await requireSession("documents.write");
  const data = parseInput(shareDocumentSchema, input);

  const doc = await prisma.document.findFirst({
    where: { id: data.documentId, deletedAt: null },
    select: {
      id: true,
      name: true,
      matterId: true,
      intakeId: true,
      matter: { select: { id: true, primaryClientId: true, title: true } }
    }
  });
  if (!doc) throw new ActionError("材料不存在或已删除");
  if (!doc.matter) {
    throw new ActionError("收案阶段的材料还没有委托方，转到正式案件后才能分享给客户");
  }
  const clientId = doc.matter.primaryClientId;
  if (!clientId) {
    throw new ActionError("该案件未登记委托方客户，无法确定分享给谁；请先在案件档案补上委托方");
  }

  await assertCanHandleMatter(session.user, doc.matter.id);
  // allowPrincipal 与 handle 同口径，否则会出现「handle 放行、writable 拦住」的自相矛盾
  await assertMatterWritable(doc.matter.id, { allowPrincipal: true });

  // 已存在未撤销的同一条分享 → 直接返回，不新增重复行
  const existing = await prisma.portalShare.findFirst({
    where: { clientId, documentId: doc.id, shareType: "DOCUMENT", revokedAt: null },
    select: { id: true }
  });
  if (existing) {
    return { ok: true as const, shareId: existing.id, alreadyShared: true };
  }

  const created = await prisma.portalShare.create({
    data: {
      clientId,
      shareType: "DOCUMENT",
      documentId: doc.id,
      matterId: doc.matter.id,
      sharedById: session.user.id,
      note: data.note?.trim() || null
    },
    select: { id: true }
  });

  await audit({
    userId: session.user.id,
    action: "PORTAL_SHARE_CREATE",
    targetType: "PortalShare",
    targetId: created.id,
    detail: {
      clientId,
      matterId: doc.matter.id,
      documentId: doc.id,
      documentName: doc.name,
      shareType: "DOCUMENT"
    }
  });

  revalidatePath(`/matters/${doc.matter.id}`);
  return { ok: true as const, shareId: created.id, alreadyShared: false };
}

const revokeSchema = z.object({
  shareId: z.string().trim().min(1, "缺少披露记录标识"),
  reason: z.string().trim().max(200).optional().or(z.literal(""))
});

/**
 * 撤销某条披露（软删）。
 *
 * 撤销后客户**下一次请求就看不到**——判定读 `revokedAt IS NULL`，不做缓存。
 * 行保留以便回答「什么时候撤的、谁撤的」。
 */
export async function revokePortalShare(input: z.input<typeof revokeSchema>) {
  const session = await requireSession("documents.write");
  const data = parseInput(revokeSchema, input);

  const share = await prisma.portalShare.findUnique({
    where: { id: data.shareId },
    select: { id: true, clientId: true, matterId: true, documentId: true, revokedAt: true }
  });
  if (!share) throw new ActionError("披露记录不存在");
  if (share.revokedAt) return { ok: true as const, alreadyRevoked: true };

  if (share.matterId) {
    await assertCanHandleMatter(session.user, share.matterId);
  } else {
    // 没有 matterId 的分享只能由管理员撤（理论上 S2 不会产生这种行）
    throw new ActionError("该披露记录未关联案件，请联系管理员处理撤销");
  }

  await prisma.portalShare.update({
    where: { id: share.id },
    data: { revokedAt: new Date(), revokedById: session.user.id }
  });

  await audit({
    userId: session.user.id,
    action: "PORTAL_SHARE_REVOKE",
    targetType: "PortalShare",
    targetId: share.id,
    detail: {
      clientId: share.clientId,
      matterId: share.matterId,
      documentId: share.documentId,
      reason: data.reason?.trim() || null
    }
  });

  if (share.matterId) revalidatePath(`/matters/${share.matterId}`);
  return { ok: true as const, alreadyRevoked: false };
}

/** 员工侧：某案件当前已分享给客户的材料（含分享人与时间，便于复核） */
export async function listPortalSharesForMatter(matterId: string) {
  const session = await requireSession("matters.read");
  await assertCanHandleMatter(session.user, matterId);

  const rows = await prisma.portalShare.findMany({
    where: { matterId, shareType: "DOCUMENT" },
    // nulls: "first" 是必须的：Postgres 的 ASC 默认把 NULL 排**最后**，
    // 直接 orderBy revokedAt: "asc" 会让「已撤销」全部排在生效中的前面——
    // 面板上律师第一眼看到的就是一堆收回记录。这是测试抓出来的，不是猜的。
    orderBy: [{ revokedAt: { sort: "asc", nulls: "first" } }, { sharedAt: "desc" }],
    select: {
      id: true,
      documentId: true,
      sharedAt: true,
      revokedAt: true,
      note: true,
      sharedById: true
    }
  });

  // 材料名单独取：PortalShare 与 Document 不建关系（披露是留痕，不该被材料删除连带）
  const docIds = rows.map((r) => r.documentId).filter((d): d is string => Boolean(d));
  // 软删的材料也要能查到名字：披露是留痕，材料被删掉之后
  // 「当时分享过什么」照样要回答得出。所以不过滤 deletedAt，而是把状态一并返回。
  const docs = docIds.length
    ? await prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, name: true, deletedAt: true } })
    : [];
  const docOf = new Map(docs.map((d) => [d.id, d]));

  return rows.map((r) => {
    const doc = r.documentId ? docOf.get(r.documentId) : undefined;
    return {
      ...r,
      documentName: doc?.name ?? (r.documentId ? "（材料已删除）" : null),
      /** 材料被软删：面板据此标注，但名字保留——留痕不该因为材料没了就变成一句「已删除」 */
      documentDeleted: Boolean(doc?.deletedAt)
    };
  });
}
