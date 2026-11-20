"use server";

/**
 * 获客 → 邀约 → 到店谈案 → 转收案（2026-11-21，全链路数字化 阶段 1）
 *
 * ## 为什么这一段要单独存在
 *
 * 系统此前只有 `Intake`（收案登记）——那是**已经决定接案之后**的事。
 * 前端「有人来问、约了时间、来了、聊了、决定委托」整段没有任何记录，
 * 于是律所答不出获客唯一该答的问题：**从多少个线索里谈成了几个**。
 *
 * ## 状态机（见 schema 注释）
 *
 * `LEAD → INVITED → VISITED → CONSULTED → CONVERTED`，任何阶段可 `LOST`。
 * 每次阶段推进同时落一条 `LeadActivity`，形成时间线（谁在什么时候做了什么）。
 *
 * ## 一条铁律
 *
 * **转化只从 `CONSULTED` 出发**。不提供「线索直接转收案」的入口——
 * 否则「到店谈案」这一段会被默认跳过，漏斗数据永远漂亮但不可信。
 *
 * ## 权限
 *
 * 读：`clients.read`（线索就是尚未成为客户的人，与客户同一权限域）。
 * 写：`clients.write`。
 * 转化：额外要求 `intakes.create`——转收案会真的产生一份收案。
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseInput } from "@/lib/parse-input";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { hasCustomPermission } from "@/lib/roles/catalog";
import { audit } from "@/server/audit";
import { retireLeadReminders } from "./reminders";
import { findPhoneDuplicates, normalizePhone } from "./phone";
import { revalidatePath } from "next/cache";
import type { LeadSource, LeadStage, LeadActivityType, MatterCategory } from "@prisma/client";

const createSchema = z.object({
  name: z.string().trim().min(2, "请填写线索人姓名（至少 2 字）").max(40),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  wechat: z.string().trim().max(60).optional().or(z.literal("")),
  organization: z.string().trim().max(80).optional().or(z.literal("")),
  source: z.enum(["REFERRAL", "ONLINE", "OFFLINE", "PARTNER", "AD", "OTHER"]).default("OTHER"),
  sourceDetail: z.string().trim().max(120).optional().or(z.literal("")),
  category: z.string().trim().min(1).default("CIVIL_COMMERCIAL"),
  expectedAmount: z.coerce.number().nonnegative().max(1_000_000_000).optional(),
  notes: z.string().trim().max(1000).optional().or(z.literal(""))
});

function requireLeadWrite(user: { role: string; rolePermissions?: unknown } & Record<string, unknown>) {
  if (!hasCustomPermission(user as never, "clients.write")) {
    throw new ActionError("没有维护线索的权限");
  }
}


/**
 * 作废邀约提醒——**失败不阻断主操作**（2026-11-21 收口审查）
 *
 * 三次调用都发生在写事务**之后**：到店/谈案已落库、流失已落库、转收案已落库。
 * 如果这里抛错冒泡上去，用户会看到「操作失败」，但数据其实已经写进去了——
 * 他会重试，于是又多一条记录。**已成功的事不该因为后续清理失败而报失败。**
 *
 * 失败时写审计，让「提醒没作废」这件事可查（否则客户到店后第二天仍收到
 * 「约了没来」，而没人知道是哪一环没跑）。
 */
async function retireLeadRemindersSafely(leadId: string, reason: string) {
  try {
    await retireLeadReminders([leadId], "CANCELLED", reason);
  } catch (err) {
    await audit({
      action: "LEAD_REMINDER_RETIRE_FAILED",
      targetType: "Lead",
      targetId: leadId,
      detail: { reason, error: err instanceof Error ? err.message : String(err) }
    });
  }
}

/** 新建线索 */
export async function createLead(input: z.input<typeof createSchema>) {
  const session = await requireSession("clients.write");
  requireLeadWrite(session.user);
  const data = parseInput(createSchema, input);

  // 电话与微信至少有一样，否则后面无法邀约——这是「线索」的最低可用信息
  if (!data.phone && !data.wechat) {
    throw new ActionError("请至少填写电话或微信，否则无法后续邀约");
  }

  const created = await prisma.lead.create({
    data: {
      name: data.name,
      phone: data.phone || null,
      wechat: data.wechat || null,
      organization: data.organization || null,
      source: data.source as LeadSource,
      sourceDetail: data.sourceDetail || null,
      category: data.category as MatterCategory,
      expectedAmount: data.expectedAmount ?? null,
      ownerId: session.user.id,
      notes: data.notes || null
    },
    select: { id: true }
  });

  await audit({
    userId: session.user.id,
    action: "LEAD_CREATE",
    targetType: "Lead",
    targetId: created.id,
    detail: { name: data.name, source: data.source }
  });
  // 2026-11-22 对标分析 P0-2：同一号码可能已有人跟过（撞单/老客户复询）。
  // **只提示不阻断**——同号可能是家人代接、公司总机，硬拦会把真实新客户挡在门外。
  const duplicates = await findPhoneDuplicates(data.phone, { excludeLeadId: created.id }).catch(() => []);
  if (duplicates.length > 0) {
    await audit({
      userId: session.user.id,
      action: "LEAD_DUPLICATE_WARNED",
      targetType: "Lead",
      targetId: created.id,
      detail: { phone: normalizePhone(data.phone), count: duplicates.length, kinds: [...new Set(duplicates.map((d) => d.kind))] }
    });
  }

  revalidatePath("/leads");
  return { ok: true as const, id: created.id, duplicates };
}

/**
 * 线索负责人清单（2026-11-21）
 *
 * 列表此前不能按人筛：负责人只出现在看板统计里。而这恰恰是律所最常见的问法——
 * 「我手上还有几个没跟的」。
 *
 * 只统计**在途**线索（与列表默认口径一致），否则一个人会看到自己名下有
 * 30 条、点进去只剩 3 条，差额全是已流失的历史。
 */
export async function listLeadOwners(): Promise<{ ownerId: string; ownerName: string; count: number }[]> {
  await requireSession("clients.read");

  const rows = await prisma.lead.groupBy({
    by: ["ownerId"],
    where: { stage: { in: ["LEAD", "INVITED", "VISITED", "CONSULTED"] } },
    _count: { _all: true }
  });
  if (rows.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: rows.map((r) => r.ownerId) } },
    select: { id: true, name: true, active: true }
  });
  const nameOf = new Map(users.map((u) => [u.id, u]));

  return rows
    .map((r) => ({
      ownerId: r.ownerId,
      // 停用账号也要显示名字，否则历史线索的负责人会变成一个空字符串
      ownerName: nameOf.get(r.ownerId)?.name ?? "（已删除账号）",
      count: r._count._all
    }))
    .sort((a, b) => b.count - a.count);
}

/** 列表（按阶段筛选；默认不显示已流失与已转化，避免噪声） */
export async function listLeads(filter: { stage?: LeadStage | "ALL"; ownerId?: string } = {}) {
  const session = await requireSession("clients.read");
  void session;

  const stage = filter.stage ?? "OPEN";
  const where =
    stage === "ALL"
      ? {}
      : stage === "OPEN"
        ? { stage: { in: ["LEAD", "INVITED", "VISITED", "CONSULTED"] as LeadStage[] } }
        : { stage };

  const rows = await prisma.lead.findMany({
    where: { ...where, ...(filter.ownerId ? { ownerId: filter.ownerId } : {}) },
    orderBy: [{ updatedAt: "desc" }],
    take: 200,
    select: {
      id: true, name: true, phone: true, wechat: true, organization: true,
      source: true, sourceDetail: true, stage: true, category: true,
      expectedAmount: true, invitedAt: true, visitedAt: true, consultedAt: true,
      lostReason: true, convertedIntakeId: true, convertedAt: true, notes: true,
      ownerId: true, owner: { select: { name: true } }, updatedAt: true,
      _count: { select: { activities: true } }
    }
  });

  // 列表内的重复识别：同一归一手机号出现多次即标记。
  // 在内存算而不是再发一次 SQL——这 200 条已经全取回来了，
  // 各写一套归一化逻辑反而会出现"库里算的和列表显示的不一致"。
  const phoneCount = new Map<string, number>();
  for (const r of rows) {
    const n = normalizePhone(r.phone);
    if (n.length >= 7) phoneCount.set(n, (phoneCount.get(n) ?? 0) + 1);
  }

  return rows.map((r) => ({
    ...r,
    expectedAmount: r.expectedAmount === null ? null : Number(r.expectedAmount),
    activityCount: r._count.activities,
    /** 列表内同号的其它线索数（0 = 不重复） */
    phoneDuplicateCount: (() => {
      const n = normalizePhone(r.phone);
      if (n.length < 7) return 0;
      return (phoneCount.get(n) ?? 1) - 1;
    })()
  }));
}

const activitySchema = z.object({
  leadId: z.string().trim().min(1),
  type: z.enum(["CONTACT", "INVITE", "VISIT", "CONSULT", "NOTE"]),
  happenedAt: z.coerce.date().optional(),
  channel: z.string().trim().max(40).optional().or(z.literal("")),
  note: z.string().trim().max(1000).optional().or(z.literal(""))
});

/** 每条动作推进的下一阶段；NOTE/CONTACT 不改变阶段 */
const STAGE_AFTER: Record<LeadActivityType, LeadStage | null> = {
  CONTACT: null,
  NOTE: null,
  INVITE: "INVITED",
  VISIT: "VISITED",
  CONSULT: "CONSULTED"
};

/**
 * 记一笔跟进动作，并按动作类型推进阶段。
 *
 * 阶段只**向前**推进（用 stageOrder 比较）：先记「到店」再补记「联系」不会把阶段拉回去。
 * 这个方向性很重要——数据补录是常态，回退会导致漏斗统计倒挂。
 */
export async function addLeadActivity(input: z.input<typeof activitySchema>) {
  const session = await requireSession("clients.write");
  requireLeadWrite(session.user);
  const data = parseInput(activitySchema, input);

  const lead = await prisma.lead.findUnique({
    where: { id: data.leadId },
    select: { id: true, name: true, stage: true }
  });
  if (!lead) throw new ActionError("线索不存在");
  if (lead.stage === "LOST") throw new ActionError("该线索已标记流失，不再记录跟进");
  if (lead.stage === "CONVERTED") throw new ActionError("该线索已转为收案，请到收案里继续记录");

  const happenedAt = data.happenedAt ?? new Date();
  const nextStage = STAGE_AFTER[data.type as LeadActivityType];
  const order: Record<LeadStage, number> = { LEAD: 0, INVITED: 1, VISITED: 2, CONSULTED: 3, CONVERTED: 4, LOST: 4 };
  const advance = nextStage && order[nextStage] > order[lead.stage] ? nextStage : null;

  await prisma.$transaction(async (tx) => {
    await tx.leadActivity.create({
      data: {
        leadId: lead.id,
        type: data.type as LeadActivityType,
        happenedAt,
        channel: data.channel || null,
        note: data.note || null,
        createdById: session.user.id
      }
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...(advance ? { stage: advance } : {}),
        ...(data.type === "INVITE" ? { invitedAt: happenedAt } : {}),
        ...(data.type === "VISIT" ? { visitedAt: happenedAt } : {}),
        ...(data.type === "CONSULT" ? { consultedAt: happenedAt } : {})
      }
    });
  });

  // 到店/谈案即作废未发出的邀约提醒——客户已经到了，第二天还收「约了没来」
  // 一次就足以让人不再相信这个提醒（见 reminders.ts 文件头）。
  if (data.type === "VISIT" || data.type === "CONSULT") {
    await retireLeadRemindersSafely(lead.id, `LEAD_${data.type}`);
  }

  await audit({
    userId: session.user.id,
    action: "LEAD_ACTIVITY",
    targetType: "Lead",
    targetId: lead.id,
    detail: { type: data.type, advancedTo: advance, leadName: lead.name }
  });
  revalidatePath("/leads");
  return { ok: true as const, stage: advance ?? lead.stage };
}

const loseSchema = z.object({
  leadId: z.string().trim().min(1),
  reason: z.string().trim().min(2, "请填写流失原因（至少 2 字）").max(200)
});

/** 标记流失（必须写原因——没有原因的流失等于没有信息） */
export async function markLeadLost(input: z.input<typeof loseSchema>) {
  const session = await requireSession("clients.write");
  requireLeadWrite(session.user);
  const data = parseInput(loseSchema, input);

  const lead = await prisma.lead.findUnique({ where: { id: data.leadId }, select: { id: true, stage: true, name: true } });
  if (!lead) throw new ActionError("线索不存在");
  if (lead.stage === "CONVERTED") throw new ActionError("已转收案的线索不能标记流失");

  await prisma.lead.update({
    where: { id: lead.id },
    data: { stage: "LOST", lostReason: data.reason, lostAt: new Date() }
  });
  await retireLeadRemindersSafely(lead.id, "LEAD_LOST");
  await audit({
    userId: session.user.id,
    action: "LEAD_LOST",
    targetType: "Lead",
    targetId: lead.id,
    detail: { reason: data.reason, fromStage: lead.stage, leadName: lead.name }
  });
  revalidatePath("/leads");
  return { ok: true as const };
}

/**
 * 转正式收案（**只能从 CONSULTED**）。
 *
 * 生成的是 `Intake` 草稿（INTAKE 状态）：冲突检索与收案审批照原样走，
 * 本动作不替代那条链路——它只是把线索阶段已经收集到的信息带过去，
 * 避免律师在收案向导里重录一遍姓名电话。
 */
export async function convertLeadToIntake(input: { leadId: string; title?: string }) {
  const session = await requireSession("intakes.create");
  const leadId = String(input?.leadId ?? "").trim();
  if (!leadId) throw new ActionError("缺少线索标识");

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: {
      id: true, name: true, phone: true, organization: true, category: true,
      stage: true, convertedIntakeId: true, consultedAt: true, expectedAmount: true
    }
  });
  if (!lead) throw new ActionError("线索不存在");
  if (lead.convertedIntakeId) throw new ActionError("该线索已转过收案");
  if (lead.stage !== "CONSULTED") {
    throw new ActionError("请先完成「到店谈案」再转收案——否则漏斗里「到店谈案」这一段会没有数据");
  }

  const title = input.title?.trim() || `${lead.name}${lead.organization ? `（${lead.organization}）` : ""}委托事项`;

  const intakeId = await prisma.$transaction(async (tx) => {
    const intake = await tx.intake.create({
      data: {
        title,
        category: lead.category,
        description: lead.expectedAmount ? `线索阶段预计标的/收费：${lead.expectedAmount.toString()}` : null,
        contactName: lead.name,
        contactPhone: lead.phone ?? null,
        // Intake.createdById 必填（谁登记的）；线索转来的收案由当前操作用户创建，
        // 负责人留空由收案流程指定——不在这里替律师决定主办。
        createdById: session.user.id
      },
      select: { id: true }
    });
    await tx.lead.update({
      where: { id: lead.id },
      data: { stage: "CONVERTED", convertedIntakeId: intake.id, convertedAt: new Date() }
    });
    return intake.id;
  });

  await retireLeadRemindersSafely(lead.id, "LEAD_CONVERTED");
  await audit({
    userId: session.user.id,
    action: "LEAD_CONVERT",
    targetType: "Lead",
    targetId: lead.id,
    detail: { intakeId, leadName: lead.name }
  });
  revalidatePath("/leads");
  revalidatePath("/matters");
  return { ok: true as const, intakeId };
}

/**
 * 线索跟进时间线（2026-11-21）
 *
 * 列表上只显示「跟进 N 次」——次数知道了，却点不开看历史。
 * 而时间线数据一直都在 `LeadActivity` 里（每次操作都落一行），
 * 这是典型的「数据有了但用不到」：跟进记录的价值全在「上次谈了什么」，
 * 而不是「谈了几次」。
 *
 * 按发生时间倒序（最近的在最上面），与人的回忆顺序一致。
 */
export async function listLeadTimeline(leadId: string) {
  const session = await requireSession("clients.read");
  void session;

  const id = String(leadId ?? "").trim();
  if (!id) throw new ActionError("缺少线索标识");

  const lead = await prisma.lead.findUnique({
    where: { id },
    select: {
      id: true, name: true, phone: true, wechat: true, organization: true,
      stage: true, source: true, sourceDetail: true, category: true,
      expectedAmount: true, invitedAt: true, visitedAt: true, consultedAt: true,
      convertedIntakeId: true, convertedAt: true, lostReason: true, lostAt: true,
      notes: true, createdAt: true,
      owner: { select: { name: true } }
    }
  });
  if (!lead) throw new ActionError("线索不存在");

  const activities = await prisma.leadActivity.findMany({
    where: { leadId: id },
    orderBy: [{ happenedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    select: {
      id: true, type: true, happenedAt: true, channel: true, note: true,
      createdBy: { select: { name: true } }
    }
  });

  return { lead: { ...lead, expectedAmount: lead.expectedAmount === null ? null : Number(lead.expectedAmount) }, activities };
}

export type LeadTimeline = Awaited<ReturnType<typeof listLeadTimeline>>;

export type LeadRow = Awaited<ReturnType<typeof listLeads>>[number];
