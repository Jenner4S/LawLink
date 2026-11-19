/**
 * v0.49 法定期限计算（PRD §二十）。
 *
 * 期间计算依据《中华人民共和国民事诉讼法（2023修正）》第八十五条（已核验）：
 * - 期间以时、日、月、年计算；期间开始的时和日不计算在期间内
 *   → 按日的期限：到期日 = 触发日 + N 日（即从次日起算第 N 日）
 * - 期间届满的最后一日是法定休假日的，以其后第一日为届满日
 *   → 系统不内置节假日表（每年国务院调整），由 UI 提示人工核对顺延
 * 按月/年的期间取到期月对应日；到期月无对应日的取该月最后一日。
 */
import type { DeadlinePeriodUnit } from "@prisma/client";
import { civilFromKey, shDayKey } from "@/lib/ui/sh-time";
import { ActionError } from "@/lib/action-error";

export const HOLIDAY_NOTE = "如届满日为法定休假日，以其后第一个工作日为届满日；已配置放假安排时由系统按其顺延并在依据标注，请核对";

/** 去掉时间部分，按本地日期归一到当天 00:00 */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
  const out = startOfDay(date);
  out.setDate(out.getDate() + days);
  return out;
}

/** 到期月对应日；无对应日（如 1/31 + 1 月）取到期月最后一日 */
function addMonthsClamped(date: Date, months: number): Date {
  const base = startOfDay(date);
  const targetMonthFirst = new Date(base.getFullYear(), base.getMonth() + months, 1);
  const lastDayOfTargetMonth = new Date(
    targetMonthFirst.getFullYear(),
    targetMonthFirst.getMonth() + 1,
    0
  ).getDate();
  return new Date(
    targetMonthFirst.getFullYear(),
    targetMonthFirst.getMonth(),
    Math.min(base.getDate(), lastDayOfTargetMonth)
  );
}

export function computeDeadlineDate(
  triggerDate: Date,
  periodValue: number,
  periodUnit: DeadlinePeriodUnit
): Date {
  if (!Number.isInteger(periodValue) || periodValue <= 0) {
    throw new ActionError("期限数值必须为正整数");
  }
  // 2026-11-19：输入先归一到「上海日历日的正午载体」再计算。
  //
  // 原因：下面的 startOfDay 用的是进程本地时区（getFullYear/getMonth/getDate）。
  // 若调用方传入的是 DB 里的真瞬间（如 2026-12-31T00:00:00Z），在 TZ=UTC 下取到
  // 12-31 是对的，但部署到 UTC 以西（如洛杉矶 UTC-8）就会取到 12-30——法定期限
  // 再少一天。历史上有调用方（addDeadline）自己包了一层 civilFromKey(shDayKey(...))，
  // 但保全的 defaultExpiryDate 与 renewProperty 都没包。
  //
  // 归一到上海日历日、以正午为载体，是本仓库约定的「日历日」表示法（见 sh-time.ts）：
  // 正午距日界 12 小时，任何时区偏移都不会跨日。对已归一过的输入是幂等的。
  const base = civilFromKey(shDayKey(triggerDate));
  switch (periodUnit) {
    case "DAYS":
      return addDays(base, periodValue);
    case "MONTHS":
      return addMonthsClamped(base, periodValue);
    case "YEARS":
      return addMonthsClamped(base, periodValue * 12);
  }
}

export function periodLabel(periodValue: number, periodUnit: DeadlinePeriodUnit): string {
  const unit = periodUnit === "DAYS" ? "日" : periodUnit === "MONTHS" ? "个月" : "年";
  return `${periodValue} ${unit}`;
}

/** 本地时区 yyyy-MM-dd。不能用 toISOString（UTC+8 下会把本地日期偏移一天） */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 生成 Deadline.basis 文本：法条 + 计算过程 + 顺延提示 */
export function buildDeadlineBasis(input: {
  legalBasis: string;
  triggerLabel: string;
  triggerDate: Date;
  periodValue: number;
  periodUnit: DeadlinePeriodUnit;
}): string {
  return [
    input.legalBasis,
    `自${input.triggerLabel}（${formatLocalDate(input.triggerDate)}）起 ${periodLabel(input.periodValue, input.periodUnit)}`,
    HOLIDAY_NOTE
  ].join("；");
}
