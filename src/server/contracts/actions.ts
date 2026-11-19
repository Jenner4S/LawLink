"use server";

/**
 * 合同确认留痕（P1-4 降级实现）—— 律师侧动作。
 *
 * 合规边界（每个入口都要能对得上）：
 *   本功能是「客户已阅知并确认」的留痕，**不是电子签名**，不能替代签字盖章。
 *   对外不得表述为「电子签 / 在线签约 / 法律效力等同于手写签名」。
 *
 * 鉴权：
 *   - 创建 / 撤销 / 重新生成：clients.write；若挂到案件，再加 assertCanHandleMatter
 *     （管理权只放大「可见」，不放大「写入」）。
 *   - 列表：clients.read；按案件查询时额外 assertCanReadMatter。
 */
import { z } from "zod";
import { parseInput } from "@/lib/parse-input";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { assertCanHandleMatter, assertCanReadMatter } from "@/lib/permissions";
import {
  CONFIRMATION_DEFAULT_TTL_DAYS,
  CONFIRMATION_MAX_TTL_DAYS,
  createConfirmationRecord,
  regenerateConfirmationRecord,
  revokeConfirmationRecord
} from "./service";

const createSchema = z.object({
  clientId: z.string().cuid("请选择客户"),
  engagementId: z.string().cuid().optional().or(z.literal("")),
  matterId: z.string().cuid().optional().or(z.literal("")),
  contentSnapshot: z.string().trim().min(20, "合同正文至少 20 字").max(200_000, "合同正文过长"),
  expiresInDays: z.coerce
    .number()
    .int("有效期须为整数天")
    .min(1, "有效期最少 1 天")
    .max(CONFIRMATION_MAX_TTL_DAYS, `有效期最多 ${CONFIRMATION_MAX_TTL_DAYS} 天`)
    .default(CONFIRMATION_DEFAULT_TTL_DAYS)
});

const revokeSchema = z.object({
  id: z.string().cuid(),
  reason: z.string().trim().min(2, "请填写撤销理由（至少 2 字）").max(200, "撤销理由最多 200 字")
});

const regenerateSchema = z.object({
  id: z.string().cuid(),
  expiresInDays: z.coerce
    .number()
    .int("有效期须为整数天")
    .min(1, "有效期最少 1 天")
    .max(CONFIRMATION_MAX_TTL_DAYS, `有效期最多 ${CONFIRMATION_MAX_TTL_DAYS} 天`)
    .default(CONFIRMATION_DEFAULT_TTL_DAYS)
});

const listSchema = z
  .object({
    clientId: z.string().cuid().optional(),
    matterId: z.string().cuid().optional()
  })
  .refine((v) => Boolean(v.clientId || v.matterId), { message: "请指定客户或案件" });

export async function createContractConfirmation(input: z.input<typeof createSchema>) {
  const session = await requireSession("clients.write");
  const data = parseInput(createSchema, input);

  const client = await prisma.client.findUnique({
    where: { id: data.clientId },
    select: { id: true, name: true, deletedAt: true }
  });
  if (!client || client.deletedAt) throw new ActionError("客户不存在或已停用");

  const matterId = data.matterId || null;
  if (matterId) await assertCanHandleMatter(session.user, matterId);

  const engagementId = data.engagementId || null;
  if (engagementId) {
    const engagement = await prisma.engagement.findUnique({
      where: { id: engagementId },
      select: { id: true, clientId: true }
    });
    if (!engagement || engagement.clientId !== data.clientId) {
      throw new ActionError("委托不存在或不属于该客户");
    }
  }

  const created = await createConfirmationRecord({
    clientId: data.clientId,
    engagementId,
    matterId,
    contentSnapshot: data.contentSnapshot,
    expiresInDays: data.expiresInDays,
    createdById: session.user.id
  });

  // token 明文只在这一刻返回给律师拼链接；不写日志、不入库。
  return {
    ok: true as const,
    id: created.id,
    url: created.url,
    contentHash: created.contentHash,
    expiresAt: created.expiresAt
  };
}

export async function revokeContractConfirmation(input: z.input<typeof revokeSchema>) {
  const session = await requireSession("clients.write");
  const data = parseInput(revokeSchema, input);

  const row = await prisma.contractConfirmation.findUnique({
    where: { id: data.id },
    select: { id: true, matterId: true }
  });
  if (!row) throw new ActionError("确认记录不存在");
  if (row.matterId) await assertCanHandleMatter(session.user, row.matterId);

  await revokeConfirmationRecord({
    id: data.id,
    reason: data.reason,
    userId: session.user.id
  });
  return { ok: true as const };
}

export async function regenerateContractConfirmation(input: z.input<typeof regenerateSchema>) {
  const session = await requireSession("clients.write");
  const data = parseInput(regenerateSchema, input);

  const row = await prisma.contractConfirmation.findUnique({
    where: { id: data.id },
    select: { id: true, matterId: true }
  });
  if (!row) throw new ActionError("确认记录不存在");
  if (row.matterId) await assertCanHandleMatter(session.user, row.matterId);

  const created = await regenerateConfirmationRecord({
    id: data.id,
    expiresInDays: data.expiresInDays,
    userId: session.user.id
  });
  return { ok: true as const, id: created.id, url: created.url, expiresAt: created.expiresAt };
}

/** 律师侧列表：只返回展示所需字段，tokenHash / 正文全文不外泄（正文用长度代替）。 */
export async function listContractConfirmations(input: z.input<typeof listSchema>) {
  const session = await requireSession("clients.read");
  const data = parseInput(listSchema, input);

  if (data.matterId) {
    await assertCanReadMatter(
      session.user.id,
      session.user.role,
      data.matterId,
      session.user.rolePermissions
    );
  }

  const rows = await prisma.contractConfirmation.findMany({
    where: {
      ...(data.clientId ? { clientId: data.clientId } : {}),
      ...(data.matterId ? { matterId: data.matterId } : {})
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      createdAt: true,
      expiresAt: true,
      confirmedAt: true,
      confirmedIp: true,
      confirmedUa: true,
      confirmerName: true,
      contentHash: true,
      contentSnapshot: true,
      revokedAt: true,
      revokedReason: true,
      engagement: { select: { id: true, title: true } },
      createdBy: { select: { name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    confirmedAt: row.confirmedAt,
    confirmedIp: row.confirmedIp,
    // UA 在库里已截断 500；列表再截一次只为渲染，不改变存证原文
    confirmedUa: row.confirmedUa ? row.confirmedUa.slice(0, 200) : null,
    confirmerName: row.confirmerName,
    contentHash: row.contentHash,
    contentLength: row.contentSnapshot.length,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
    engagementId: row.engagement?.id ?? null,
    engagementTitle: row.engagement?.title ?? null,
    createdByName: row.createdBy?.name ?? null
  }));
}

/** 客户名下可关联的有效委托（创建对话框用）。 */
export async function listEngagementsForConfirmation(clientId: string) {
  await requireSession("clients.read");
  const parsed = parseInput(z.object({ clientId: z.string().cuid() }), { clientId });
  return prisma.engagement.findMany({
    where: { clientId: parsed.clientId, endedAt: null },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { id: true, title: true, startedAt: true }
  });
}
