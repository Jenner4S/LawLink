/**
 * 邀约提醒（2026-11-21，获客全链路 阶段五）
 *
 * ## 这一段为什么必须有
 *
 * 「约了时间没来」是获客里**最伤转化又最容易漏**的环节：
 * 线索停在 `INVITED` 不会报错、不会变红、不会出现在任何待办里——
 * 它只是安静地躺着，直到某天看漏斗发现到店率很低，却已经想不起是谁没来。
 *
 * ## 为什么复用 ReminderDelivery 台账
 *
 * 项目已有结论（F-1 方案）：只记「成功了哪些」的通知表答不了「该发未发」。
 * 邀约提醒正是这类——漏发一条就是丢一个客户，所以必须登记后由投递器复核现值再发。
 *
 * ## 两条判定口径
 *
 * ① **只提醒「已邀约未到店」**：`stage === INVITED` 且 `invitedAt` 已过。
 *    已经在 `VISITED`/`CONSULTED`/`CONVERTED` 的不提醒（人来了）；
 *    `LEAD` 不提醒（还没约，提醒什么）；`LOST` 不提醒。
 *
 * ② **过期按天补，不按小时轰炸**：`dayKey` 用上海日键去重，同一天同一条线索
 *    最多一条。逾期第 1/3/7 天各提醒一次，之后停（一直提醒会让人直接屏蔽通知，
 *    那比不提醒更糟）。
 *
 * ## 接收人
 *
 * 线索 `ownerId`（跟进人）。若跟进人已停用，登记给其上级会产生大量误投——
 * 这里选择**不发**并写审计，因为邀约是个人跟进事项，转派应由人决定而不是系统猜。
 */

import { prisma } from "@/lib/prisma";
import { registerReminderDelivery, voidPendingDeliveries } from "@/server/reminders/ledger";
import { audit } from "@/server/audit";

/** 逾期第几天提醒（1/3/7），之后不再提醒 */
export const LEAD_REMINDER_DAYS = [1, 3, 7] as const;

/**
 * 事前提醒：提前 1 天 + 当天（2026-11-21 补全）
 *
 * 只有逾期提醒是半个闭环——客户明天要来，跟进人今天不知道；当天要来了，
 * 也没有任何提示。**事前提醒比事后追责有用得多**：到店这件事，提醒得早能改期，
 * 提醒得晚只能算账。
 *
 * offset 语义沿用台账既有约定：负=提前天数，0=当天，正=逾期天数。
 */
export const LEAD_REMINDER_AHEAD_DAYS = [1, 0] as const;

/** 上海日键（与台账其它通道一致：同一自然日去重） */
function shDayKey(d: Date): string {
  const sh = new Date(d.getTime() + 8 * 3600_000);
  return `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, "0")}-${String(sh.getUTCDate()).padStart(2, "0")}`;
}

function dayDiff(from: Date, to: Date): number {
  const a = new Date(from.getTime() + 8 * 3600_000);
  const b = new Date(to.getTime() + 8 * 3600_000);
  const ka = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const kb = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((kb - ka) / 86_400_000);
}

export type LeadReminderScanResult = {
  scanned: number;
  registered: number;
  skippedDisabled: number;
  /** 事前（提前 1 天 / 当天）登记数，便于区分两类提醒的量 */
  registeredAhead: number;
};

/**
 * 扫描已邀约线索，登记**事前**（提前 1 天 / 当天）与**逾期**（1/3/7 天）提醒。
 * 由定时任务调用；同一天重复调用是幂等的（台账去重）。
 */
export async function scanLeadInviteReminders(now: Date = new Date()): Promise<LeadReminderScanResult> {
  const candidates = await prisma.lead.findMany({
    where: {
      stage: "INVITED",
      invitedAt: { not: null }
    },
    select: {
      id: true, name: true, invitedAt: true, ownerId: true,
      owner: { select: { name: true, active: true } }
    },
    take: 500
  });

  let registered = 0;
  let registeredAhead = 0;
  let skippedDisabled = 0;

  for (const lead of candidates) {
    if (!lead.invitedAt) continue;

    // daysUntil > 0 未来；0 当天；< 0 已过期
    const daysUntil = dayDiff(now, lead.invitedAt);
    let offset: number | null = null;

    if (daysUntil > 0) {
      // 未来：只在提前 1 天提醒
      if (LEAD_REMINDER_AHEAD_DAYS.includes(daysUntil as 0 | 1)) offset = -daysUntil;
    } else if (daysUntil === 0) {
      // 当天：约定时刻还没到 → 当天提醒；已过 → 走逾期口径（第 0 天不重复提醒）
      if (lead.invitedAt.getTime() > now.getTime()) offset = 0;
    } else {
      const overdueDays = -daysUntil;
      if (LEAD_REMINDER_DAYS.includes(overdueDays as 1 | 3 | 7)) offset = overdueDays;
    }

    if (offset === null) continue;

    // 跟进人已停用：不发，交给人工转派（见文件头「接收人」）
    if (!lead.owner.active) {
      skippedDisabled += 1;
      continue;
    }

    const res = await registerReminderDelivery({
      objectType: "LEAD",
      objectId: lead.id,
      kind: "OFFSET",
      offset,
      channel: "IN_APP",
      dayKey: shDayKey(now),
      userId: lead.ownerId
    }, prisma, new Date(), { invitedAt: lead.invitedAt.toISOString() });
    if (res === "REGISTERED") {
      registered += 1;
      if (offset <= 0) registeredAhead += 1;
    }
  }

  // 2026-11-21 收口审查补齐：停用负责人的线索此前只是**悄悄跳过**，
  // 除了一次函数返回值没人知道——正是「没做成会有人知道吗」这一问的反例。
  // 邀约是个人跟进事项，系统不替人转派（那会误投给不相干的人），
  // 但**必须留下痕迹**，否则这批客户就是静静流失。
  // 与保全提醒的 PRESERVATION_RECIPIENT_MISSING 同口径：记一条汇总审计，不逐条刷屏。
  if (skippedDisabled > 0) {
    await audit({
      action: "LEAD_REMINDER_RECIPIENT_DISABLED",
      targetType: "Lead",
      detail: { skippedDisabled, scanned: candidates.length, day: shDayKey(now) }
    });
  }

  return { scanned: candidates.length, registered, skippedDisabled, registeredAhead };
}

/**
 * 线索阶段变化后作废未发出的邀约提醒。
 *
 * 调用点：`addLeadActivity`（到店/谈案即作废）、`markLeadLost`、`convertLeadToIntake`。
 * 不作废的后果：客户已经到店了，第二天还会收到「约了没来」——一次这样的误报
 * 就足以让人不再相信这个提醒。
 */
export async function retireLeadReminders(
  leadIds: string[],
  status: "SUPERSEDED" | "CANCELLED",
  reason: string
): Promise<number> {
  if (leadIds.length === 0) return 0;
  return voidPendingDeliveries("LEAD", leadIds, status, reason);
}
