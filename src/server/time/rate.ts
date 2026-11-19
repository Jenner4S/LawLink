import type { UserRole } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * 费率解析：四级覆盖，就近优先。
 *
 *   MATTER（案件专属协议价）
 *     ↓ 未命中
 *   CLIENT（客户协议价）
 *     ↓
 *   USER（律师个人费率）
 *     ↓
 *   ROLE（角色标准费率）
 *     ↓
 *   DEFAULT（所内默认）
 *
 * 命中条件还要求「生效日期落在 workDate 当天」——费率调整不会倒灌历史工时。
 * 全部未命中时返回 0 费率并标记 configured=false，由调用方决定是拒绝录入还是允许（金额为 0）。
 */

export interface ResolvedRate {
  hourlyRate: Prisma.Decimal;
  billingIncrement: number;
  scheduleId: string | null;
  scope: "MATTER" | "CLIENT" | "USER" | "ROLE" | "DEFAULT" | "NONE";
  configured: boolean;
}

const ZERO = new Prisma.Decimal(0);

function effectiveWhere(workDate: Date) {
  return {
    active: true,
    effectiveFrom: { lte: workDate },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: workDate } }]
  };
}

export async function resolveRate(input: {
  matterId: string;
  clientId?: string | null;
  userId: string;
  role: string;
  workDate: Date;
}): Promise<ResolvedRate> {
  const eff = effectiveWhere(input.workDate);

  // 1) 案件
  const byMatter = await prisma.rateSchedule.findFirst({
    where: { ...eff, scope: "MATTER", matterId: input.matterId },
    orderBy: { effectiveFrom: "desc" }
  });
  if (byMatter) return pick(byMatter, "MATTER");

  // 2) 客户
  if (input.clientId) {
    const byClient = await prisma.rateSchedule.findFirst({
      where: { ...eff, scope: "CLIENT", clientId: input.clientId },
      orderBy: { effectiveFrom: "desc" }
    });
    if (byClient) return pick(byClient, "CLIENT");
  }

  // 3) 个人
  const byUser = await prisma.rateSchedule.findFirst({
    where: { ...eff, scope: "USER", userId: input.userId },
    orderBy: { effectiveFrom: "desc" }
  });
  if (byUser) return pick(byUser, "USER");

  // 4) 角色
  const byRole = await prisma.rateSchedule.findFirst({
    // 2026-11-21：`as never` → `as UserRole`。
    //
    // `as never` 接受任何值，连"这个字符串是不是 UserRole"都不检查；
    // `as UserRole` 至少要求它属于那个联合类型的运行时表达（仍是断言，
    // 但强度高一级）。真正的根治是把 next-auth.d.ts 的 `role: string`
    // 收窄成 UserRole —— 那会牵动全仓，属独立改动，本轮不做。
    //
    // 已知残留风险：`input.role` 若拼错（如 "LAWER"），这里不会报错，
    // 只会让角色级费率**静默不命中**，落到默认费率。影响是算错钱，
    // 不是崩溃，所以按 P3 处理。已登记。
    where: { ...eff, scope: "ROLE", role: input.role as UserRole },
    orderBy: { effectiveFrom: "desc" }
  });
  if (byRole) return pick(byRole, "ROLE");

  // 5) 默认
  const byDefault = await prisma.rateSchedule.findFirst({
    where: { ...eff, scope: "DEFAULT" },
    orderBy: { effectiveFrom: "desc" }
  });
  if (byDefault) return pick(byDefault, "DEFAULT");

  return {
    hourlyRate: ZERO,
    billingIncrement: 0,
    scheduleId: null,
    scope: "NONE",
    configured: false
  };
}

function pick(
  s: { id: string; hourlyRate: Prisma.Decimal; billingIncrement: number },
  scope: ResolvedRate["scope"]
): ResolvedRate {
  return {
    hourlyRate: s.hourlyRate,
    billingIncrement: s.billingIncrement,
    scheduleId: s.id,
    scope,
    configured: true
  };
}

/**
 * 计费分钟进位。
 *
 * 律所惯例按 0.1 小时（6 分钟）进位：实际 7 分钟按 12 分钟计。
 * increment = 0 表示不进位，按实际分钟。
 * 向上取整（ceil），与实务一致——不足一个单位按一个单位收。
 */
export function billableMinutesOf(actualMinutes: number, increment: number): number {
  if (increment <= 0) return actualMinutes;
  return Math.ceil(actualMinutes / increment) * increment;
}

/**
 * 金额 = 计费分钟 / 60 × 小时费率，保留 2 位小数（四舍五入）。
 * 用 Decimal 计算，避免浮点误差导致账单尾差。
 */
export function amountOf(billableMinutes: number, hourlyRate: Prisma.Decimal): Prisma.Decimal {
  if (billableMinutes <= 0) return ZERO;
  return new Prisma.Decimal(billableMinutes)
    .div(60)
    .mul(hourlyRate)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}
