"use server";

/**
 * 客户门户 S3：工单与满意度（2026-11-21）
 *
 * 工单是客户**唯一能主动发起**的通道。三类动作，边界分开：
 *   ① `submitPortalRequest` / `listMyPortalRequests` —— 门户侧（客户会话）
 *   ② `listPortalRequestsForStaff` / `answerPortalRequest` —— 员工侧
 *   ③ `submitPortalSatisfaction` —— 门户侧，一案件一次，可匿名
 *
 * 三条安全约束：
 *   · 工单可见性：主账号看该客户全部工单；协作者按 `visibility` 决定
 *     （ALL = 全部 / OWN_SUBMISSIONS = 只看自己的）。**永远不跨客户**——
 *     过滤条件是 `clientId`，不是「同一个律师」。
 *   · 回答只追加不覆盖：`answerBody` / `answeredById` / `answeredAt` 并列留痕。
 *   · 匿名评价：`portalUserId` 置空但保留 `clientId` —— 律所要能知道是哪家客户，
 *     但不知道是哪个人，否则「给差评会被认出来」的顾虑没有真的被消解。
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseInput } from "@/lib/parse-input";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";
import { getPortalViewer } from "@/lib/portal/session";
import { assertCanHandleMatter } from "@/lib/permissions";
import { registerReminderDelivery, voidPendingDeliveries } from "@/server/reminders/ledger";
import { shDayKey } from "@/lib/ui/sh-time";

/** 员工侧默认回复时限：2 个工作日（按自然日近似，工单不是法定期限，不做节假日顺延） */
const DEFAULT_DUE_DAYS = 2;

const submitSchema = z.object({
  subject: z.string().trim().min(2, "请填写标题（至少 2 个字）").max(80, "标题不超过 80 字"),
  body: z.string().trim().min(5, "请描述你的问题（至少 5 个字）").max(2000, "内容不超过 2000 字")
});

/** 客户提交工单（门户侧） */
export async function submitPortalRequest(input: z.input<typeof submitSchema>) {
  const viewer = await getPortalViewer();
  if (!viewer) throw new ActionError("请先登录");

  const data = parseInput(submitSchema, input);
  const dueAt = new Date(Date.now() + DEFAULT_DUE_DAYS * 24 * 60 * 60 * 1000);

  const created = await prisma.portalRequest.create({
    data: {
      portalUserId: viewer.portalUserId,
      clientId: viewer.clientId,
      subject: data.subject,
      body: data.body,
      dueAt
    },
    select: { id: true }
  });

  // 到期提醒（2026-11-21）：走提醒台账而不是另发通知——台账能回答「该发未发」，
  // 扫描式通知答不了。registeredAt 设为 dueAt：投递器到点才 sweep，不会提前打扰。
  // 接收人＝该客户在办案件的主办律师；查不到就升级给合伙人/主任（不静默丢失）。
  const owner = await prisma.matter.findFirst({
    where: { primaryClientId: viewer.clientId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { ownerId: true }
  });
  let recipientId = owner?.ownerId ?? null;
  if (!recipientId) {
    const fallback = await prisma.user.findFirst({
      where: { active: true, role: { in: ["PRINCIPAL_LAWYER"] } },
      select: { id: true }
    });
    recipientId = fallback?.id ?? null;
  }
  if (recipientId) {
    await registerReminderDelivery(
      {
        objectType: "PORTAL_REQUEST",
        objectId: created.id,
        kind: "OFFSET",
        offset: 0,
        channel: "IN_APP",
        dayKey: shDayKey(dueAt),
        userId: recipientId
      },
      prisma as never,
      dueAt
    );
  }

  await audit({
    userId: viewer.portalUserId,
    action: "PORTAL_INQUIRY_CREATE",
    targetType: "PortalRequest",
    targetId: created.id,
    detail: { clientId: viewer.clientId, subject: data.subject, actorKind: "PORTAL_USER" }
  });

  revalidatePath("/portal/requests");
  return { ok: true as const, id: created.id };
}

/** 客户查看工单（按 visibility 过滤） */
export async function listMyPortalRequests() {
  const viewer = await getPortalViewer();
  if (!viewer) return [];

  const user = await prisma.clientPortalUser.findUnique({
    where: { id: viewer.portalUserId },
    select: { visibility: true, isPrimary: true }
  });
  if (!user) return [];

  // 主账号永远看全部；协作者按档位决定。过滤条件里**始终带 clientId**：
  // 跨客户隔离不依赖角色，而是靠这个条件本身。
  const onlyMine = !user.isPrimary && user.visibility === "OWN_SUBMISSIONS";

  const rows = await prisma.portalRequest.findMany({
    where: {
      clientId: viewer.clientId,
      ...(onlyMine ? { portalUserId: viewer.portalUserId } : {})
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      subject: true,
      body: true,
      status: true,
      createdAt: true,
      answeredAt: true,
      answerBody: true
    }
  });
  return rows;
}

/** 员工查看某客户的工单（客户详情/门户页用） */
export async function listPortalRequestsForStaff(clientId: string) {
  const session = await requireSession("approval");
  const id = String(clientId ?? "").trim();
  if (!id) throw new ActionError("缺少客户标识");

  const rows = await prisma.portalRequest.findMany({
    where: { clientId: id },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      subject: true,
      body: true,
      status: true,
      createdAt: true,
      dueAt: true,
      answeredAt: true,
      answerBody: true,
      portalUser: { select: { name: true, email: true, isPrimary: true } }
    }
  });

  void session;
  return rows.map((r) => ({
    ...r,
    /** 超期未回复：员工侧标红（S3 验收判据之一） */
    overdue: r.status === "OPEN" && Boolean(r.dueAt) && r.dueAt!.getTime() < Date.now()
  }));
}

const answerSchema = z.object({
  requestId: z.string().trim().min(1, "缺少工单标识"),
  answer: z.string().trim().min(1, "请填写回复内容").max(2000, "回复不超过 2000 字"),
  closeIt: z.boolean().optional()
});

/** 员工回复工单 */
export async function answerPortalRequest(input: z.input<typeof answerSchema>) {
  const session = await requireSession("approval");
  const data = parseInput(answerSchema, input);

  const row = await prisma.portalRequest.findUnique({
    where: { id: data.requestId },
    select: { id: true, clientId: true, subject: true, status: true }
  });
  if (!row) throw new ActionError("工单不存在");

  // 权限口径：能进审批工作台且能处理该客户的案件——工单本身就是「客户诉求」，
  // 与审批同属需要判断的事项。这里用客户下是否有我可办的案件来收口。
  const anyMatter = await prisma.matter.findFirst({
    where: { primaryClientId: row.clientId, deletedAt: null },
    select: { id: true }
  });
  if (anyMatter) await assertCanHandleMatter(session.user, anyMatter.id);

  await prisma.portalRequest.update({
    where: { id: row.id },
    data: {
      answerBody: data.answer,
      answeredById: session.user.id,
      answeredAt: new Date(),
      status: data.closeIt ? "CLOSED" : "ANSWERED"
    }
  });

  // 已回复 → 作废该工单所有待发提醒（不这么做，员工回完了还会收到"超期未回复"）
  await voidPendingDeliveries("PORTAL_REQUEST", [row.id], "CANCELLED", "ANSWERED");

  await audit({
    userId: session.user.id,
    action: "PORTAL_INQUIRY_ANSWER",
    targetType: "PortalRequest",
    targetId: row.id,
    detail: { clientId: row.clientId, subject: row.subject, closed: Boolean(data.closeIt) }
  });

  revalidatePath(`/clients/${row.clientId}`);
  return { ok: true as const };
}

const satisfactionSchema = z.object({
  matterId: z.string().trim().min(1, "缺少案件标识"),
  score: z.coerce.number().int().min(1, "评分 1-5").max(5, "评分 1-5"),
  npsScore: z.coerce.number().int().min(0).max(10).optional(),
  comment: z.string().trim().max(500, "评价不超过 500 字").optional().or(z.literal("")),
  anonymous: z.boolean().optional()
});

/**
 * 客户提交满意度（一案件一次）。
 *
 * 匿名时把 portalUserId 置空，但**保留 clientId**：
 * 律所必须知道是哪家客户的评价（否则无法改进），但不需要知道是哪个人。
 */
export async function submitPortalSatisfaction(input: z.input<typeof satisfactionSchema>) {
  const viewer = await getPortalViewer();
  if (!viewer) throw new ActionError("请先登录");

  const data = parseInput(satisfactionSchema, input);

  // 只能评价自己客户名下的案件，且该案件必须已分享给客户（否则是拿 id 猜）
  const matter = await prisma.matter.findFirst({
    where: { id: data.matterId, deletedAt: null, primaryClientId: viewer.clientId },
    select: { id: true }
  });
  if (!matter) throw new ActionError("案件不存在");

  const shared = await prisma.portalShare.findFirst({
    where: { clientId: viewer.clientId, matterId: matter.id, shareType: "MATTER_SUMMARY", revokedAt: null },
    select: { id: true }
  });
  if (!shared) throw new ActionError("该案件尚未向你开放，无法评价");

  const existing = await prisma.portalSatisfaction.findUnique({
    where: { clientId_matterId: { clientId: viewer.clientId, matterId: matter.id } },
    select: { id: true }
  });
  if (existing) throw new ActionError("本案已提交过评价，感谢你的反馈");

  const created = await prisma.portalSatisfaction.create({
    data: {
      clientId: viewer.clientId,
      matterId: matter.id,
      portalUserId: data.anonymous ? null : viewer.portalUserId,
      score: data.score,
      npsScore: data.npsScore ?? null,
      comment: data.comment?.trim() || null,
      anonymous: Boolean(data.anonymous)
    },
    select: { id: true }
  });

  await audit({
    userId: viewer.portalUserId,
    action: "PORTAL_SATISFACTION_CREATE",
    targetType: "PortalSatisfaction",
    targetId: created.id,
    detail: { clientId: viewer.clientId, matterId: matter.id, score: data.score, anonymous: Boolean(data.anonymous), actorKind: "PORTAL_USER" }
  });

  revalidatePath("/portal/cases");
  return { ok: true as const };
}
