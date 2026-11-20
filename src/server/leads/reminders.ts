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

/** 逾期第几天提醒（1/3/7），之后不再提醒 */
export const LEAD_REMINDER_DAYS = [1, 3, 7] as const;

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

export type LeadReminderScanResult = { scanned: number; registered: number; skippedDisabled: number };

/**
 * 扫描「已邀约但没到店」的线索并登记提醒。
 * 由定时任务调用；同一天重复调用是幂等的（台账去重）。
 */
export async function scanLeadInviteReminders(now: Date = new Date()): Promise<LeadReminderScanResult> {
  const candidates = await prisma.lead.findMany({
    where: {
      stage: "INVITED",
      invitedAt: { not: null },
      // 只扫已经过期的：约定时间早于现在
      AND: [{ invitedAt: { lt: now } }]
    },
    select: {
      id: true, name: true, invitedAt: true, ownerId: true,
      owner: { select: { name: true, active: true } }
    },
    take: 500
  });

  let registered = 0;
  let skippedDisabled = 0;

  for (const lead of candidates) {
    if (!lead.invitedAt) continue;
    const overdueDays = dayDiff(lead.invitedAt, now);
    if (!LEAD_REMINDER_DAYS.includes(overdueDays as 1 | 3 | 7)) continue;

    // 跟进人已停用：不发，交给人工转派（见文件头「接收人」）
    if (!lead.owner.active) {
      skippedDisabled += 1;
      continue;
    }

    const res = await registerReminderDelivery({
      objectType: "LEAD",
      objectId: lead.id,
      kind: "OFFSET",
      offset: overdueDays,
      channel: "IN_APP",
      dayKey: shDayKey(now),
      userId: lead.ownerId
    });
    if (res === "REGISTERED") registered += 1;
  }

  return { scanned: candidates.length, registered, skippedDisabled };
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
