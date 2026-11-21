/**
 * 统一时区工具（2026-11-23）
 *
 * ## 为什么需要
 *
 * 容器跑在 **UTC**（实测 `docker exec lawlink-app date` = UTC），
 * 而业务口径是**上海（+08:00）**。直接用 `new Date(y, m, d)` 这类"本地字段"构造，
 * 在 UTC 下得到的当天 0 点是上海 08:00 —— 跨日算出来的日期会**差一天**。
 *
 * 期限、保全起止日这类字段差一天就是法律风险，必须显式按 +08:00 计算。
 *
 * ## 约定
 *
 * 本文件只做"取上海日历字段"与"按上海日历运算"，返回的仍是标准 `Date`（绝对时刻）。
 * 展示层继续用 `formatDate`（它已固定 `timeZone: "Asia/Shanghai"`）。
 *
 * ## 当前使用面（2026-11-23 复核）
 *
 * · 生产代码只用到 `addDaysCivil`（提醒窗口、期限预览）与 `addMonthsCivilClamped`（迟延利息默认日）；
 * · `shParts` / `shStartOfDay` / `shAddDays` / `shAddMonthsClamped` / `shDateString` / `shYear`
 *   目前由 `tz.test.ts` 覆盖，作为时区口径的**断言工具**保留（防止以后改坏而不自知）。
 * · 曾写过的 `dateOnly*` 一族已删（与既有正午载体契约冲突，见文末说明）。
 */
export const SH_OFFSET_MS = 8 * 3600_000;

/** 取上海日历字段（注意：用 UTC getter 读"偏移后的时刻"） */
export function shParts(d: Date): { y: number; m: number; day: number; h: number; min: number } {
  const sh = new Date(d.getTime() + SH_OFFSET_MS);
  return {
    y: sh.getUTCFullYear(),
    m: sh.getUTCMonth() + 1,
    day: sh.getUTCDate(),
    h: sh.getUTCHours(),
    min: sh.getUTCMinutes()
  };
}

/** 年份（上海）——节假日表按年取，跨年时不能错一年 */
export function shYear(d: Date = new Date()): number {
  return shParts(d).y;
}

/** 上海当天的 00:00（作为绝对时刻返回） */
export function shStartOfDay(d: Date): Date {
  const { y, m, day } = shParts(d);
  return new Date(Date.UTC(y, m - 1, day) - SH_OFFSET_MS);
}

/** 上海日历上加 N 天（自动处理跨月/跨年与夏令时——上海无 DST，但算法本身不依赖） */
export function shAddDays(d: Date, days: number): Date {
  const base = shStartOfDay(d);
  const { y, m, day } = shParts(base);
  return new Date(Date.UTC(y, m - 1, day + days) - SH_OFFSET_MS);
}

/**
 * 上海日历上加 N 个月，日期超出目标月时**钳到该月最后一天**。
 * 例：1/31 + 1 月 → 2/28（平年）或 2/29（闰年）。
 * 期限计算必须这样，否则 `setMonth` 会溢出到 3/2 或 3/3。
 */
export function shAddMonthsClamped(d: Date, months: number): Date {
  const { y, m, day } = shParts(d);
  const targetIndex = (m - 1) + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12; // 0..11
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)) - SH_OFFSET_MS);
}

/** 上海年月日字符串（YYYY-MM-DD） */
export function shDateString(d: Date): string {
  const { y, m, day } = shParts(d);
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────
// 关于 date-only：结论是「用正午载体，不用 UTC 0 点」（2026-11-23）
// ─────────────────────────────────────────────────────────────
//
// 我一开始以为 date-only 该用 UTC 0 点表示，于是写了 `dateOnly*` 一族工具。
// 实测与既有契约冲突：`deadline-rules-timezone.test.ts` 要求
// `2026-12-31T00:00:00Z` + 1 年 = `2027-12-31`，而本仓库既有的日历日表示法是
// **上海日子 + 正午载体**（`civilFromKey(shDayKey())`，正午距日界 12 小时不跨日）。
//
// 于是把 `dateOnly*` 全部删掉（生产与测试都无人使用，留着只是给后来者添乱），
// 期限/保全/法律计算统一走正午载体；本文件只保留 now 相关的 `sh*` 与
// 「正午载体推进」的 `addDaysCivil` / `addMonthsCivilClamped`。

// ─────────────────────────────────────────────────────────────
// 与「正午载体」配套的推进函数（页面/预览层用）
// ─────────────────────────────────────────────────────────────

/** 正午载体日期 + N 天（不依赖进程时区） */
export function addDaysCivil(d: Date, days: number): Date {
  const [y, m, day] = shDayKey(d).split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, day + days));
  return shNoon(
    `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`
  );
}

/** 正午载体日期 + N 个月，超月末钳到月末 */
export function addMonthsCivilClamped(d: Date, months: number): Date {
  const [y, m, day] = shDayKey(d).split("-").map(Number);
  const targetIndex = m - 1 + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return shNoon(
    `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`
  );
}

/**
 * 由 `YYYY-MM-DD` 造**固定的**上海正午时刻（UTC 04:00）。
 *
 * ⚠️ 与 `lib/ui/sh-time.ts` 的 `civilFromKey` **不等价**，别混用：
 *
 * · `civilFromKey(key)` 用 `new Date(y, m-1, d, 12)` —— **进程本地**正午。
 *   容器是 UTC 时它等于 12:00Z（上海 20:00，同一天，正确）；
 *   但若进程在 UTC-8 跑，就成了 20:00Z（上海次日 04:00），**跨日**。
 * · `shNoon(key)` 固定 UTC 04:00，任何进程时区下都表示同一个上海日正午。
 *
 * 本文件选择后者（与时区无关），因为它要服务"跨时区部署也不能错"的场景；
 * 而 `civilFromKey` 已被大量既有代码使用，改动面过大，故两套并存并在此写明边界。
 */
function shNoon(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
}

/** 上海日键（与 `sh-time.shDayKey` 同义，但此处不 import 以避免 lib 层耦合） */
function shDayKey(d: Date): string {
  const sh = new Date(d.getTime() + SH_OFFSET_MS);
  return `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, "0")}-${String(sh.getUTCDate()).padStart(2, "0")}`;
}
