/**
 * 提醒送达台账投递器（F-1，docs/提醒送达台账方案-20260921.md）。
 *
 * sweep PENDING 行 → 复核对象当前状态（B3「发送前核实当前状态」原则，兜住
 * 作废-投递竞态）→ 发送 → 落终态。阶段一接入保全四种 kind；阶段二接入期限/
 * 开庭（OFFSET 档位 + DEADLINE 逾期升级）。对象变更/消亡经 voidPendingDeliveries
 * /retireScheduleReminders 作废，杜绝投递已失效的提醒。
 *
 * 阶段二起本模块依赖 schedule.ts 的 evaluateScheduleReminder（复核共用登记
 * 口径）；schedule 的保存路径经动态 import 回调本模块投递——勿引入静态环。
 */
import { prisma } from "@/lib/prisma";
import { Prisma, type ReminderDeliveryChannel, type ReminderDeliveryKind, type ReminderDeliveryObjectType } from "@prisma/client";
import { createNotification } from "@/server/notifications/create";
import { audit } from "@/server/audit";
import { matterHref } from "@/lib/matters/route";
import { PROPERTY_TYPE_CN } from "@/lib/preservation-defaults";
import { shDayKey } from "@/lib/ui/sh-time";
import { shDayStart, isReminderRecipientEnabled, evaluateScheduleReminder, type ReminderRecipient, type ScheduleKind } from "@/server/reminders/schedule";
import { escalateOverduePreservationToTeamLeaders, escalateOverdueDeadlineToTeamLeaders } from "@/server/reminders/escalation";
import { voidPendingDeliveries, MAX_ATTEMPTS } from "@/server/reminders/ledger";

// 既有调用方（扫描、保全 actions、测试）沿用 delivery 命名空间导入，转出台账原语
export { registerReminderDelivery, MAX_ATTEMPTS } from "@/server/reminders/ledger";

/** 作废保全对象的全部 PENDING 登记（阶段一作废矩阵的落库侧） */
export async function voidPendingPreservation(
  propertyIds: string[],
  status: "SUPERSEDED" | "CANCELLED",
  reason: string,
  tx: Pick<typeof prisma, "reminderDelivery"> = prisma
): Promise<number> {
  return voidPendingDeliveries("PRESERVATION_PROPERTY", propertyIds, status, reason, tx);
}

const preservationRecipientSelect = { id: true, active: true, role: true, roleDefinition: { select: { active: true } } } as const;

export type PreservationDeliveryNode = {
  owner: ReminderRecipient | null;
  matter: { id: string; title: string; internalCode: string; owner: ReminderRecipient | null } | null;
};

/** 有效保全负责人优先，回退有效案件主办；全部失效返回 null（与扫描同口径） */
export function pickPreservationRecipient(cs: PreservationDeliveryNode | null | undefined): ReminderRecipient | null {
  if (!cs) return null;
  if (isReminderRecipientEnabled(cs.owner)) return cs.owner;
  const matterOwner = cs.matter?.owner ?? null;
  if (isReminderRecipientEnabled(matterOwner)) return matterOwner;
  return null;
}

export const preservationDeliverySelect = {
  id: true,
  propertyType: true,
  propertyDetail: true,
  expiryDate: true,
  status: true,
  target: {
    select: {
      name: true,
      case: {
        select: {
          remindDays: true,
          owner: { select: preservationRecipientSelect },
          matter: {
            select: { id: true, title: true, internalCode: true, owner: { select: preservationRecipientSelect } }
          }
        }
      }
    }
  }
} as const;

export type DeliverySweepResult = {
  processed: number; sent: number; voided: number; skipped: number; failed: number;
  /** 上一轮 sweep 仍在进行，本次整轮让开（重入守卫，见下） */
  reentrantSkipped?: boolean;
  /** 候选行全被其他实例领走（多实例下正常现象，不是错误） */
  leaseMissed?: boolean;
};

/**
 * 进程内重入守卫（第七轮体检 P2-1 的单进程部分）。
 *
 * sweep 没有「领取」动作：findMany PENDING → 逐行 finalize，行在处理期间仍是
 * PENDING。node-cron 的每 2 分钟作业在上一次回调尚未结束时照常触发下一次，
 * 重入的 sweep 会捞到同一批未 finalize 的行并重复投递——唯一约束挡不住，
 * 它防的是同键重复「行」，不是同一行重复「发送」。
 *
 * 本标志只在单进程内有效（AGENTS：单体应用 + 单进程），足以消除 node-cron
 * 重叠触发这一现实成因。多实例部署仍需数据库级租约，那需要 Schema 迁移，
 * 走红线审批，见 docs/系统审计-20260921-第7轮v2.md §五。
 */
let sweepInFlight = false;

/**
 * 投递器：sweep 到期 PENDING 行，逐行复核对象现值后发送并落终态。
 */
/** 租约时长：一轮 sweep 正常在秒级完成；给 2 分钟容忍慢库与 GC 停顿 */
const LEASE_MS = 2 * 60 * 1000;
/** 失败退避基数：2^n 分钟，封顶 30 分钟（MAX_ATTEMPTS=5 → 1/2/4/8/16 分钟） */
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_CAP_MS = 30 * 60 * 1000;
/** 本进程的租约所有者标识（多实例时各副本不同） */
const LEASE_OWNER = `pid:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

export async function deliverPendingReminders(
  limit = 20,
  opts: { timeBudgetMs?: number; maxBatches?: number } = {}
): Promise<DeliverySweepResult> {
  if (sweepInFlight) {
    return { processed: 0, sent: 0, voided: 0, skipped: 0, failed: 0, reentrantSkipped: true };
  }
  sweepInFlight = true;
  try {
    // 吞吐（2026-11-21）：原先每次 cron 只发一批（20 条 / 2 分钟 = 600 条/小时）。
    // 09:00 全量补扫会把当日全部档位一次性登记进来，机构一多就积压，
    // 「今天到期」的提醒会被排到几小时后——这正是第七轮审计要求同批调整的吞吐项。
    //
    // 改为**排空循环**：单批仍限 limit（内存与事务边界不变），
    // 但在时间预算内连续领取下一批，直到没有可领行或预算用尽。
    // 预算 20s < cron 间隔 120s，留足余量；上限 10 批兜住极端情况。
    const timeBudgetMs = opts.timeBudgetMs ?? 20_000;
    const maxBatches = opts.maxBatches ?? 10;
    const startedAt = Date.now();

    const total: DeliverySweepResult = { processed: 0, sent: 0, voided: 0, skipped: 0, failed: 0 };
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const one = await sweepOnce(limit);
      total.processed += one.processed;
      total.sent += one.sent;
      total.voided += one.voided;
      total.skipped += one.skipped;
      total.failed += one.failed;
      // 保留「候选存在但全被别人领走」这个观测信号：排空循环里它是首批的典型状态，
      // 丢了的话运维看不出「有积压但抢不到」
      if (one.leaseMissed) total.leaseMissed = true;
      // 本批处理数不足单批上限 → 队列已排空（剩余行为退避中或被别的实例领走）。
      // 这个条件比「本批为 0」更准确：宁可多跑一次也不漏批，
      // 而不足 limit 说明后面确实没得领了。
      if (one.processed < limit) break;
      if (Date.now() - startedAt >= timeBudgetMs) break;
    }
    return total;
  } finally {
    sweepInFlight = false;
  }
}

async function sweepOnce(limit: number): Promise<DeliverySweepResult> {
  const now = new Date();

  // ① 候选：到点、未在退避窗口内
  const candidates = await prisma.reminderDelivery.findMany({
    where: {
      status: "PENDING",
      registeredAt: { lte: now },
      AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }]
    },
    orderBy: [{ registeredAt: "asc" }],
    take: limit,
    select: { id: true }
  });
  if (candidates.length === 0) {
    return { processed: 0, sent: 0, voided: 0, skipped: 0, failed: 0 };
  }

  // ② 原子领取：只有 leaseUntil 为空或已过期的行才能被本次抢到。
  //    这是多实例下唯一可靠的互斥——进程内 sweepInFlight 只管得住自己那个进程。
  //    租约过期可被其他实例接手，等价于崩溃恢复（比「启动时扫一次」更简单）。
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const claimed = await prisma.reminderDelivery.updateMany({
    where: {
      id: { in: candidates.map((c) => c.id) },
      status: "PENDING",
      AND: [{ OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] }]
    },
    data: { leaseOwner: LEASE_OWNER, leaseUntil }
  });
  if (claimed.count === 0) {
    return { processed: 0, sent: 0, voided: 0, skipped: 0, failed: 0, leaseMissed: true };
  }

  // ③ 只处理**本次抢到**的行：再按 leaseOwner + leaseUntil 精确筛选，
  //    避免把恰好落在同一窗口、被别的实例领走的行也读进来。
  const rows = await prisma.reminderDelivery.findMany({
    where: {
      id: { in: candidates.map((c) => c.id) },
      status: "PENDING",
      leaseOwner: LEASE_OWNER,
      leaseUntil: leaseUntil
    },
    orderBy: [{ registeredAt: "asc" }],
    select: {
      id: true, objectType: true, objectId: true, kind: true, offset: true,
      channel: true, dayKey: true, userId: true, attempts: true
    }
  });

  const result: DeliverySweepResult = { processed: 0, sent: 0, voided: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    result.processed++;
    try {
      let outcome: RowOutcome;
      if (row.objectType === "PRESERVATION_PROPERTY") {
        outcome = await deliverPreservationRow(row, now);
      } else if (row.objectType === "DEADLINE" || row.objectType === "HEARING") {
        outcome = await deliverScheduleRow(row, now);
      } else if (row.objectType === "ARCHIVE_BORROW") {
        outcome = await deliverArchiveBorrowRow(row, now);
      } else if (row.objectType === "PORTAL_REQUEST") {
        outcome = await deliverPortalRequestRow(row, now);
      } else if (row.objectType === "LEAD") {
        // 2026-11-21 获客全链路 阶段五：约了到店时间没来 → 提醒跟进人
        outcome = await deliverLeadRow(row, now);
      } else {
        // 未接入的对象类型（如 DIGEST 行不经投递器）——防御性跳过
        await finalize(row, "SKIPPED", { reason: "UNSUPPORTED" });
        outcome = "skipped";
      }
      result[outcome]++;
    } catch (err) {
      result.failed++;
      const attempts = row.attempts + 1;
      // 指数退避：不改 registeredAt（那是「应发时刻」，是事实），
      // 用 nextAttemptAt 择下一次尝试，正常行因此不再被失败行挤掉。
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
      await prisma.reminderDelivery.update({
        where: { id: row.id },
        data: {
          status: attempts >= MAX_ATTEMPTS ? "FAILED" : "PENDING",
          attempts,
          lastError: err instanceof Error ? err.message : String(err),
          ...(attempts >= MAX_ATTEMPTS ? {} : { nextAttemptAt: new Date(Date.now() + backoff) }),
          // 失败即释放租约：不释放的话要等 LEASE_MS 到期才能重试
          leaseOwner: null,
          leaseUntil: null
        }
      });
    }
  }
  return result;
}

type SweepRow = {
  id: string;
  objectType: ReminderDeliveryObjectType;
  objectId: string;
  kind: ReminderDeliveryKind;
  offset: number;
  channel: ReminderDeliveryChannel;
  dayKey: string;
  userId: string;
  attempts: number;
};

type RowOutcome = "sent" | "voided" | "skipped";

/** 期限/开庭行投递：evaluate 复核 → 漂移作废 → 确定性主键幂等创建通知 */
async function deliverScheduleRow(row: SweepRow, now: Date): Promise<RowOutcome> {
  const kind: ScheduleKind = row.objectType === "DEADLINE" ? "Deadline" : "Hearing";
  const ev = await evaluateScheduleReminder(kind, row.objectId, now);

  if (ev.outcome === "SKIP") {
    // 对象消亡（删除/办结/案件删除/责任关闭）→ CANCELLED；变更类（非档期/无接收人）→ SUPERSEDED，待重登记
    const gone = ev.reason === "GONE" || ev.reason === "MATTER_DELETED" || ev.reason === "COMPLETED" || ev.reason === "RESP_CLOSED";
    await finalize(row, gone ? "CANCELLED" : "SUPERSEDED", { reason: ev.reason });
    return "voided";
  }

  if (row.kind === "ESCALATION") {
    if (ev.offset < 1 || ev.offset !== row.offset) {
      await finalize(row, "SUPERSEDED", { reason: "TIER_DRIFT", offset: ev.offset });
      return "voided";
    }
    const outcomes = await escalateOverdueDeadlineToTeamLeaders({
      matterId: ev.matterId,
      matterTitle: ev.matterTitle,
      internalCode: ev.internalCode,
      ownerId: ev.userId,
      deadlineId: row.objectId,
      deadlineTitle: ev.itemTitle,
      offset: ev.offset,
      todayStart: shDayStart(now)
    });
    await finalize(row, "SENT", { outcomes });
    return "sent";
  }

  // OFFSET：档位或接收人漂移即作废（改期路径会作废重登记，这里兜竞态）
  if (ev.offset !== row.offset || ev.userId !== row.userId) {
    await finalize(row, "SUPERSEDED", { reason: ev.offset !== row.offset ? "TIER_DRIFT" : "RECIPIENT_DRIFT", offset: ev.offset });
    return "voided";
  }
  await prisma.notification.createMany({
    data: [{
      id: ev.notificationId, userId: ev.userId,
      type: ev.notificationType, priority: ev.priority,
      title: ev.title, content: ev.content, href: ev.href,
      refType: ev.refType, refId: row.objectId, createdAt: now
    }],
    skipDuplicates: true
  });
  await finalize(row, "SENT");
  return "sent";
}

/** 单行投递：复核 → 发送 → 落终态（终态由调用方 update） */
async function deliverPreservationRow(row: SweepRow, now: Date): Promise<RowOutcome> {
  const prop = await prisma.preservationProperty.findUnique({
    where: { id: row.objectId },
    select: preservationDeliverySelect
  });
  const todayStart = shDayStart(now);

  // 对象已删除：登记取消
  if (!prop) {
    await finalize(row, "CANCELLED", { reason: "OBJECT_GONE" });
    return "voided";
  }

  const cs = prop.target.case;
  const propertyLabel = prop.propertyDetail?.trim() || PROPERTY_TYPE_CN[prop.propertyType];
  const matterText = cs.matter ? `案件 ${cs.matter.internalCode}·${cs.matter.title}` : "未关联案件";

  if (row.kind === "OFFSET") {
    // 复核：状态仍生效、档位仍命中且与登记一致、接收人未漂移——任一不符即作废
    if (prop.status !== "ACTIVE" && prop.status !== "RENEWED") {
      await finalize(row, "CANCELLED", { reason: `STATUS_${prop.status}` });
      return "voided";
    }
    const daysUntil = Math.round((shDayStart(prop.expiryDate).getTime() - todayStart.getTime()) / 86_400_000);
    const isCritical = daysUntil === 0 || daysUntil === -1;
    if (daysUntil !== row.offset || (!isCritical && !cs.remindDays.includes(daysUntil))) {
      await finalize(row, "SUPERSEDED", { reason: "TIER_DRIFT", daysUntil });
      return "voided";
    }
    const recipient = pickPreservationRecipient(cs);
    if (!recipient || recipient.id !== row.userId) {
      // 接收人漂移/失效：作废，下次扫描按当前接收人重新登记
      await finalize(row, "SUPERSEDED", { reason: "RECIPIENT_DRIFT" });
      return "voided";
    }
    const refType = `PreservationExpiry:${daysUntil}`;
    const dup = await prisma.notification.findFirst({
      where: { refType, refId: prop.id, createdAt: { gte: todayStart } },
      select: { id: true }
    });
    if (!dup) {
      const whenText =
        daysUntil === 0 ? "今天到期"
          : daysUntil < 0 ? `已逾期 ${-daysUntil} 天，保全效力可能已消灭`
            : `还有 ${daysUntil} 天到期`;
      await createNotification({
        userId: recipient.id,
        type: "DEADLINE_REMINDER",
        priority: daysUntil <= 3 ? "URGENT" : daysUntil <= 15 ? "HIGH" : "NORMAL",
        title: `保全${whenText}：${prop.target.name} · ${propertyLabel}`,
        content: `${matterText}。逾期未办续封手续的，查封、扣押、冻结的效力消灭（查扣冻规定第二十七条）。`,
        href: cs.matter ? matterHref(cs.matter) : "/preservation",
        refType,
        refId: prop.id
      });
    }
    await finalize(row, "SENT");
    return "sent";
  }

  if (row.kind === "EXPIRED") {
    if (prop.status !== "EXPIRED") {
      // 已续封/解除/删除：翻转产生的提醒不再有效
      await finalize(row, prop.status === "ACTIVE" || prop.status === "RENEWED" ? "SUPERSEDED" : "CANCELLED", { reason: `STATUS_${prop.status}` });
      return "voided";
    }
    const daysOverdue = Math.max(1, Math.round((todayStart.getTime() - shDayStart(prop.expiryDate).getTime()) / 86_400_000));
    const recipient = pickPreservationRecipient(cs); // 接收人投递时重解析（翻转只登记一次，漂移不重登记）
    const refType = "PreservationExpired";
    const dup = await prisma.notification.findFirst({
      where: { refType, refId: prop.id, createdAt: { gte: todayStart } },
      select: { id: true }
    });
    if (recipient && !dup) {
      await createNotification({
        userId: recipient.id,
        type: "DEADLINE_REMINDER",
        priority: "URGENT",
        title: `保全已过期未续封：${prop.target.name} · ${propertyLabel}`,
        content:
          `到期日 ${shDayKey(prop.expiryDate)}，已过 ${daysOverdue} 天。` +
          `未办理续封手续的，查封、扣押、冻结的效力消灭（查扣冻规定第二十七条），` +
          `系统已将该条保全标记为「已到期」。若实际已办理续封，请在系统中更新记录。`,
        href: cs.matter ? matterHref(cs.matter) : "/preservation",
        refType,
        refId: prop.id
      });
      await finalize(row, "SENT");
      return "sent";
    }
    await finalize(row, "SENT", recipient ? undefined : { reason: "NO_RECIPIENT" });
    return recipient ? "sent" : "skipped";
  }

  if (row.kind === "ESCALATION") {
    if (prop.status !== "EXPIRED") {
      await finalize(row, prop.status === "ACTIVE" || prop.status === "RENEWED" ? "SUPERSEDED" : "CANCELLED", { reason: `STATUS_${prop.status}` });
      return "voided";
    }
    const rawOwnerId = cs.owner?.id ?? cs.matter?.owner?.id ?? null;
    const daysOverdue = Math.max(1, Math.round((todayStart.getTime() - shDayStart(prop.expiryDate).getTime()) / 86_400_000));
    if (rawOwnerId) {
      // 受众动态：投递时解析团队负责人，行状态代表当日该对象的升级动作
      await escalateOverduePreservationToTeamLeaders({
        ownerId: rawOwnerId,
        matterId: cs.matter?.id ?? null,
        internalCode: cs.matter?.internalCode ?? null,
        matterTitle: cs.matter?.title ?? null,
        propertyId: prop.id,
        propertyLabel,
        targetName: prop.target.name,
        daysOverdue,
        todayStart
      });
    }
    await finalize(row, "SENT");
    return "sent";
  }

  // RECIPIENT_MISSING：档位提醒无合格接收人——接收人若已恢复则无需升级
  if (prop.status !== "ACTIVE" && prop.status !== "RENEWED") {
    await finalize(row, "CANCELLED", { reason: `STATUS_${prop.status}` });
    return "voided";
  }
  if (pickPreservationRecipient(cs)) {
    await finalize(row, "SUPERSEDED", { reason: "RECIPIENT_RECOVERED" });
    return "voided";
  }
  const refType = "PreservationRecipientMissing";
  const dup = await prisma.notification.findFirst({
    where: { refType, refId: prop.id, createdAt: { gte: todayStart } },
    select: { id: true }
  });
  if (!dup) {
    const receivers = await prisma.user.findMany({
      where: {
        active: true,
        role: "CUSTOM",
        roleDefinition: { active: true, permissions: { some: { permissionKey: "matters.transfer", scope: "ALL" } } }
      },
      select: { id: true }
    });
    const targets = receivers.length > 0
      ? receivers
      : await prisma.user.findMany({ where: { active: true, systemRole: "SUPER_ADMIN" }, select: { id: true } });
    await audit({
      userId: null,
      action: "PRESERVATION_RECIPIENT_MISSING",
      targetType: "PreservationProperty",
      targetId: prop.id,
      detail: { matterId: cs.matter?.id ?? null, receivers: receivers.length, deliveredAt: now.toISOString() }
    });
    for (const t of targets) {
      await createNotification({
        userId: t.id,
        type: "DEADLINE_REMINDER",
        priority: "URGENT",
        title: `保全提醒无人接收：${prop.target.name} · ${propertyLabel}`,
        content:
          `该保全的续封提醒没有合格接收人（保全负责人与案件主办均停用或缺失），提醒不会送达任何律师。` +
          `${cs.matter ? `关联案件 ${cs.matter.internalCode}·${cs.matter.title}，` : "该保全未关联案件，"}请在管理后台安排责任交接。`,
        href: cs.matter ? matterHref(cs.matter) : "/preservation",
        refType,
        refId: prop.id
      });
    }
  }
  await finalize(row, "SENT");
  return "sent";
}

/** 借阅到期提醒（F-6）：复核借阅单仍 APPROVED 且未归还未过期后送达；否则作废 */
async function deliverArchiveBorrowRow(row: SweepRow, now: Date): Promise<RowOutcome> {
  const borrow = await prisma.archiveBorrowRequest.findUnique({
    where: { id: row.objectId },
    select: {
      id: true, status: true, accessUntil: true, applicantId: true,
      archiveRecord: { select: { archiveNo: true, matter: { select: { id: true, title: true, internalCode: true } } } }
    }
  });
  if (!borrow) {
    await finalize(row, "CANCELLED", { reason: "OBJECT_GONE" });
    return "voided";
  }
  // 已归还/驳回/过期：到期提醒随对象消亡取消
  if (borrow.status !== "APPROVED") {
    await finalize(row, "CANCELLED", { reason: `BORROW_${borrow.status}` });
    return "voided";
  }
  const until = borrow.accessUntil ? shDayKey(borrow.accessUntil) : null;
  if (!until || borrow.accessUntil!.getTime() < now.getTime()) {
    await finalize(row, "CANCELLED", { reason: "ALREADY_EXPIRED" });
    return "voided";
  }
  const refType = "ArchiveBorrowDue";
  const dup = await prisma.notification.findFirst({
    where: { refType, refId: borrow.id, createdAt: { gte: shDayStart(now) } },
    select: { id: true }
  });
  if (!dup) {
    const isDueDay = row.offset === 0;
    await createNotification({
      userId: borrow.applicantId,
      type: "SYSTEM",
      priority: "HIGH",
      title: isDueDay ? `借阅今日到期：${borrow.archiveRecord.matter.title}` : `借阅 3 天后到期：${borrow.archiveRecord.matter.title}`,
      content: `${borrow.archiveRecord.archiveNo}（${borrow.archiveRecord.matter.internalCode}）的借阅将于 ${until} 到期，到期后自动失去查阅资格。请阅毕后在归档台账标记归还；仍需使用请重新申请。`,
      href: "/archive",
      refType,
      refId: borrow.id
    });
  }
  await finalize(row, "SENT");
  return "sent";
}

async function finalize(row: SweepRow, status: "SENT" | "SUPERSEDED" | "CANCELLED" | "SKIPPED", detail?: Record<string, unknown>) {
  const data: Prisma.ReminderDeliveryUpdateInput = {
    status,
    sentAt: status === "SENT" ? new Date() : null,
    // 终态释放租约：租约只为「处理中」这层互斥存在，处理完就该让位
    leaseOwner: null,
    leaseUntil: null
  };
  if (detail) data.detail = detail as Prisma.InputJsonValue;
  await prisma.reminderDelivery.update({ where: { id: row.id }, data });
}

/**
 * 客户工单到期未回复提醒（2026-11-21，门户 S3）
 *
 * 与借阅到期同一套做法：**投递前复核对象现值**。
 * 客户已经自己撤回不了工单，但员工可能已经回复——那时提醒没有意义，
 * 必须 CANCELLED 而不是照发（这正是台账相对于"定时扫表发通知"的价值：
 * 它问的是「这条提醒还该不该发」，而不是「今天到点了没」）。
 */
async function deliverPortalRequestRow(row: SweepRow, now: Date): Promise<RowOutcome> {
  const req = await prisma.portalRequest.findUnique({
    where: { id: row.objectId },
    select: {
      id: true,
      status: true,
      subject: true,
      createdAt: true,
      answeredAt: true,
      clientId: true
    }
  });
  if (!req) {
    await finalize(row, "CANCELLED", { reason: "OBJECT_GONE" });
    return "voided";
  }
  // 已回复/已关闭：提醒失去意义
  if (req.status !== "OPEN") {
    await finalize(row, "CANCELLED", { reason: `REQUEST_${req.status}` });
    return "voided";
  }

  const refType = "PortalRequestDue";
  const dup = await prisma.notification.findFirst({
    where: { refType, refId: req.id, userId: row.userId, createdAt: { gte: shDayStart(now) } },
    select: { id: true }
  });
  const client = await prisma.client.findUnique({ where: { id: req.clientId }, select: { name: true } });
  if (!dup) {
    await createNotification({
      userId: row.userId,
      type: "SYSTEM",
      priority: "HIGH",
      title: "客户提问待回复",
      content: `${client?.name ?? "客户"} 的提问「${req.subject}」已超过承诺时限仍未回复。`,
      href: "/clients",  // 客户详情需 id；这里给可点入口而不是死链
      refType,
      refId: req.id
    });
  }
  await finalize(row, "SENT", { notifiedAt: now.toISOString(), dup: Boolean(dup) });
  return "sent";
}

/**
 * 邀约提醒投递（获客 阶段五）
 *
 * 发之前**复核现值**（沿用 B3「发送前核实当前状态」原则）：
 * 线索已被删、已到店、已谈案、已转化、已流失——任何一种都让这条提醒失去意义，
 * 直接作废。发一条「约了没来」给刚谈完案的律师，比不发更糟。
 */
async function deliverLeadRow(row: SweepRow, now: Date): Promise<RowOutcome> {
  const lead = await prisma.lead.findUnique({
    where: { id: row.objectId },
    select: { id: true, name: true, stage: true, invitedAt: true, ownerId: true }
  });
  if (!lead) {
    await finalize(row, "CANCELLED", { reason: "OBJECT_GONE" });
    return "voided";
  }
  if (lead.stage !== "INVITED") {
    await finalize(row, "CANCELLED", { reason: `LEAD_${lead.stage}` });
    return "voided";
  }

  const refType = "LeadInviteOverdue";
  const dup = await prisma.notification.findFirst({
    where: { refType, refId: lead.id, userId: row.userId, createdAt: { gte: shDayStart(now) } },
    select: { id: true }
  });
  if (!dup) {
    const days = lead.invitedAt
      ? Math.max(1, Math.round((now.getTime() - lead.invitedAt.getTime()) / 86_400_000))
      : 1;
    await createNotification({
      userId: row.userId,
      type: "SYSTEM",
      priority: "HIGH",
      title: "邀约客户未到店",
      content: `${lead.name} 约了 ${days} 天前的到店时间但未到店。请跟进确认是否改期——停在「已邀约」的线索不会自己变红。`,
      href: "/leads",
      refType,
      refId: lead.id
    });
  }
  await finalize(row, "SENT", { notifiedAt: now.toISOString(), dup: Boolean(dup) });
  return "sent";
}
