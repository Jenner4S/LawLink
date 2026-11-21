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
// date-only 一律用 UTC 日历（2026-11-23）
// ─────────────────────────────────────────────────────────────
//
// 这里有个容易搞混的区别，写清楚避免以后反复改：
//
//  · **date-only 字段**（期限届满日、保全起止日、续期日）表示"日历上的某一天"，
//    与时刻无关。既定契约是**以 UTC 0 点存储**（`deadline-rules-timezone.test.ts`
//    就是这个契约的守卫：`2026-12-31T00:00:00Z` + 1 年 = `2027-12-31`）。
//    这类字段必须用 UTC 日历运算，用上海日历反而会差一天。
//
//  · **datetime 场景**（"今天/本月是哪天"、按小时分组）才需要上海日历，
//    因为那是"此刻在上海是几号"，用 `sh*` 系列。
//
// 一句话：date-only 用 `dateOnly*`，now 相关用 `sh*`。

/** 把任意时刻归一为"它代表的 UTC 日历日"的 0 点（date-only 语义） */
export function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** date-only 加 N 天 */
export function dateOnlyAddDays(d: Date, days: number): Date {
  const b = dateOnly(d);
  return new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate() + days));
}

/** date-only 加 N 个月，超月末钳到月末（1/31 + 1 月 → 2/28；setMonth 会溢出到 3/2） */
export function dateOnlyAddMonthsClamped(d: Date, months: number): Date {
  const b = dateOnly(d);
  const y = b.getUTCFullYear();
  const m = b.getUTCMonth();
  const day = b.getUTCDate();
  const targetIndex = m + months;
  const targetYear = y + Math.floor(targetIndex / 12);
  const targetMonth = ((targetIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}

/** date-only 的 YYYY-MM-DD（按 UTC 日历，与存储契约一致） */
export function dateOnlyString(d: Date): string {
  const b = dateOnly(d);
  return `${b.getUTCFullYear()}-${String(b.getUTCMonth() + 1).padStart(2, "0")}-${String(b.getUTCDate()).padStart(2, "0")}`;
}

// ─────────────────────────────────────────────────────────────
// 与「正午载体」配套的推进函数（页面/预览层用）
// ─────────────────────────────────────────────────────────────

/** 正午载体日期 + N 天（不依赖进程时区） */
export function addDaysCivil(d: Date, days: number): Date {
  const [y, m, day] = shDayKey(d).split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, day + days));
  return shCivilFromKey(
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
  return shCivilFromKey(
    `${targetYear}-${String(targetMonth + 1).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`
  );
}

/** 由 `YYYY-MM-DD` 造正午载体（与 `lib/ui/sh-time.ts` 的 civilFromKey 同义，此处避免循环依赖） */
function shCivilFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  // 上海正午 12:00 = UTC 04:00
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
}

/** 上海日键（与 sh-time 的 shDayKey 同义） */
function shDayKey(d: Date): string {
  const sh = new Date(d.getTime() + SH_OFFSET_MS);
  return `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, "0")}-${String(sh.getUTCDate()).padStart(2, "0")}`;
}
