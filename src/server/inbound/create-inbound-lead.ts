/**
 * 入站线索的统一落库（2026-11-23）
 *
 * 官网表单（HTTP）和邮件收件（IMAP）都走这里 —— 两处各写一遍必然分叉：
 * 一处改了"渠道匹配不到不拒单"，另一处忘了改，症状就是"邮件来的线索不挂渠道"。
 *
 * 口径（与 `docs/外部对接说明-20261123.md` 一致）：
 * · 阶段 LEAD、来源 ONLINE、`assigneeStatus = UNASSIGNED` → 进「待派单」；
 * · 有 `externalId` 才判重；没有就不猜（同手机号两次是两件事）；
 * · 渠道按名匹配已启用渠道，匹配不到只是不挂，不拒单；
 * · 接收人：设置 `leadInboundOwnerId` → 否则第一个在职合伙人/独立律师 → 都没有则报错。
 */
import { prisma } from "@/lib/prisma";
import { audit } from "@/server/audit";

export type InboundLeadInput = {
  name: string;
  phone?: string | null;
  channelName?: string | null;
  externalId?: string | null;
  message?: string | null;
  sourceDetail?: string | null;
  /** 落到跟进记录里的那一句（如「官网表单提交」/「邮件咨询」） */
  activityNote: string;
};

export type InboundLeadResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; reason: "NO_RECEIVER"; howTo: string };

const IDEMPOTENCY_PREFIX = "[inbound:";

/** 幂等标记（写进 notes，判重时按 contains 查） */
export function idempotencyMarker(externalId: string): string {
  return `${IDEMPOTENCY_PREFIX}${externalId}]`;
}

async function resolveReceiver(): Promise<{ id: string } | null> {
  const setting = await prisma.systemSetting.findUnique({ where: { key: "leadInboundOwnerId" } });
  const configuredId = typeof setting?.value === "string" ? setting.value : null;
  if (configuredId) {
    const u = await prisma.user.findFirst({ where: { id: configuredId, active: true }, select: { id: true } });
    if (u) return u;
  }
  return prisma.user.findFirst({
    where: { active: true, role: { in: ["PRINCIPAL_LAWYER", "INDEPENDENT_LAWYER"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true }
  });
}

export async function createInboundLead(input: InboundLeadInput): Promise<InboundLeadResult> {
  // 幂等：只认 externalId
  if (input.externalId) {
    const marker = idempotencyMarker(input.externalId);
    const existing = await prisma.lead.findFirst({ where: { notes: { contains: marker } }, select: { id: true } });
    if (existing) return { ok: true, id: existing.id, duplicate: true };
  }

  const receiver = await resolveReceiver();
  if (!receiver) {
    return {
      ok: false,
      reason: "NO_RECEIVER",
      howTo: "先在系统里启用一个用户，或把设置项 leadInboundOwnerId 指到某个用户 id"
    };
  }

  const channel = input.channelName
    ? await prisma.leadChannel.findFirst({
        where: { name: input.channelName, active: true },
        select: { id: true }
      })
    : null;

  const noteParts = [
    input.message ? `客户留言：${input.message}` : null,
    input.externalId ? idempotencyMarker(input.externalId) : null,
    input.sourceDetail ? `来源：${input.sourceDetail}` : null
  ].filter(Boolean);

  const lead = await prisma.lead.create({
    data: {
      name: input.name,
      phone: input.phone ?? null,
      source: "ONLINE",
      sourceDetail: input.sourceDetail ?? null,
      channelId: channel?.id ?? null,
      notes: noteParts.length ? noteParts.join("\n") : null,
      stage: "LEAD",
      ownerId: receiver.id,
      assigneeStatus: "UNASSIGNED"
    },
    select: { id: true }
  });

  await prisma.leadActivity.create({
    data: { leadId: lead.id, type: "NOTE", note: input.activityNote, createdById: receiver.id }
  });

  await audit({
    action: "LEAD_INBOUND",
    targetType: "Lead",
    targetId: lead.id,
    detail: { name: input.name, channel: channel?.id ?? null, externalId: input.externalId ?? null }
  });

  return { ok: true, id: lead.id, duplicate: false };
}
