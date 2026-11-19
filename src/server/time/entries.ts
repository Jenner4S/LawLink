import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { amountOf, billableMinutesOf, resolveRate } from "./rate";

/**
 * 工时记录服务。
 *
 * 设计要点：
 *   1. 登记录入时**快照费率**（hourlyRateSnapshot），此后费率表怎么调都不影响历史金额；
 *   2. 不可计费（billable=false）必须填理由——否则等于变相隐藏工作量；
 *   3. 工时可见性跟随案件（复用 matterVisibilityFilter 的调用方口径），不在本模块重复判权。
 */

export interface CreateTimeEntryInput {
  matterId: string;
  userId: string;
  userRole: string;
  workDate: Date;
  minutes: number;
  narrative: string;
  taskCode?: string | null;
  billable?: boolean;
  noChargeReason?: string | null;
}

export interface CreatedTimeEntry {
  id: string;
  minutes: number;
  billableMinutes: number;
  hourlyRateSnapshot: Prisma.Decimal;
  amount: Prisma.Decimal;
  rateScope: string;
}

export async function createTimeEntry(input: CreateTimeEntryInput): Promise<CreatedTimeEntry> {
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) {
    throw new Error("工时分钟数必须为正整数");
  }
  if (input.minutes > 24 * 60) {
    throw new Error("单条工时不得到超过 24 小时");
  }
  const narrative = input.narrative.trim();
  if (!narrative) throw new Error("工作内容必填");
  if (narrative.length > 2000) throw new Error("工作内容不超过 2000 字");

  const billable = input.billable ?? true;
  const noChargeReason = (input.noChargeReason ?? "").trim();
  if (!billable && !noChargeReason) throw new Error("标记为不可计费时必须填写原因");

  const matter = await prisma.matter.findFirst({
    where: { id: input.matterId, deletedAt: null },
    select: { id: true, primaryClientId: true }
  });
  if (!matter) throw new Error("案件不存在或已删除");

  const rate = await resolveRate({
    matterId: input.matterId,
    clientId: matter.primaryClientId,
    userId: input.userId,
    role: input.userRole,
    workDate: input.workDate
  });

  const billableMinutes = billable ? billableMinutesOf(input.minutes, rate.billingIncrement) : 0;
  const amount = billable && rate.configured ? amountOf(billableMinutes, rate.hourlyRate) : new Prisma.Decimal(0);

  const created = await prisma.timeEntry.create({
    data: {
      matterId: input.matterId,
      userId: input.userId,
      workDate: input.workDate,
      minutes: input.minutes,
      billableMinutes,
      narrative,
      taskCode: input.taskCode?.trim() || null,
      billable,
      noChargeReason: billable ? null : noChargeReason,
      rateScheduleId: rate.scheduleId,
      hourlyRateSnapshot: rate.hourlyRate,
      amount
    },
    select: { id: true }
  });

  return {
    id: created.id,
    minutes: input.minutes,
    billableMinutes,
    hourlyRateSnapshot: rate.hourlyRate,
    amount,
    rateScope: rate.scope
  };
}

export interface MatterTimeSummary {
  entryCount: number;
  actualMinutes: number;
  billableMinutes: number;
  billableAmount: Prisma.Decimal;
  nonChargeableMinutes: number;
  /** 案件已收金额（FeeEntry 中已确认的实收），用于「折算金额 vs 已收」对比 */
  collectedAmount: Prisma.Decimal;
}

/**
 * 单案工时三角：投入（小时）→ 折算金额 → 已收金额。
 *
 * 这三个数放在一起才有意义：
 *   - 投入高、折算高、已收低 → 这个案子在亏
 *   - 投入高、折算低 → 报价偏低，或大量不可计费工作
 */
/**
 * 工时汇总（内部辅助）。
 *
 * 2026-11-20：**本函数不做权限校验**，它直接按 matterId 聚合。
 * 唯一调用方是同目录 actions.ts 的 getMatterTimeBoard，那里已经做了
 * `requireSession("matters.read")` + `assertCanReadMatter(...)`（后者含隔离墙）。
 *
 * 之所以仍然 export：跨文件复用。但新增调用方**必须自己先做鉴权**，
 * 否则等于绕过 permission 层。审计时按这个注释核对，不要因为「它在 lib 层」
 * 就假设安全。
 */
export async function getMatterTimeSummary(matterId: string): Promise<MatterTimeSummary> {
  const agg = await prisma.timeEntry.aggregate({
    where: { matterId },
    _count: { _all: true },
    _sum: { minutes: true, billableMinutes: true, amount: true }
  });

  const nonChargeable = await prisma.timeEntry.aggregate({
    where: { matterId, billable: false },
    _sum: { minutes: true }
  });

  // 口径与财务一致：只有「已确认」的实收才算已收（PENDING 不派生、不计入）
  const collected = await prisma.feeEntry.aggregate({
    where: { matterId, type: "RECEIVED", confirmState: "CONFIRMED" },
    _sum: { amount: true }
  });

  return {
    entryCount: agg._count._all,
    actualMinutes: agg._sum.minutes ?? 0,
    billableMinutes: agg._sum.billableMinutes ?? 0,
    billableAmount: agg._sum.amount ?? new Prisma.Decimal(0),
    nonChargeableMinutes: nonChargeable._sum.minutes ?? 0,
    collectedAmount: collected._sum.amount ?? new Prisma.Decimal(0)
  };
}

export interface LawyerTimeSummary {
  userId: string;
  entryCount: number;
  actualMinutes: number;
  billableMinutes: number;
  billableAmount: Prisma.Decimal;
}

/** 律师在时间段内的产能：可计费小时与折算金额 */
export async function getLawyerTimeSummary(input: {
  userId: string;
  from: Date;
  to: Date;
}): Promise<LawyerTimeSummary> {
  const agg = await prisma.timeEntry.aggregate({
    where: {
      userId: input.userId,
      workDate: { gte: input.from, lte: input.to }
    },
    _count: { _all: true },
    _sum: { minutes: true, billableMinutes: true, amount: true }
  });

  return {
    userId: input.userId,
    entryCount: agg._count._all,
    actualMinutes: agg._sum.minutes ?? 0,
    billableMinutes: agg._sum.billableMinutes ?? 0,
    billableAmount: agg._sum.amount ?? new Prisma.Decimal(0)
  };
}
