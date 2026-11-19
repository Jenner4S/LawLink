/**
 * 上海时区的日期 / 时刻展示工具。
 *
 * 客户端组件会先在服务端渲染再在浏览器水合：若直接用 getHours()/getDate() 等本地时区方法，
 * 服务器（常为 UTC 或其他时区）与浏览器所在时区不同就会得到不同文本，导致水合失败、时间显示错位。
 * 业务时间一律按 Asia/Shanghai 解释，与 AGENTS「日期统一上海时区」约定一致。
 *
 * 「日历日」用本地正午的 Date 表示（new Date(y, m-1, d, 12)），只读取其年月日字段，
 * 这样在 UTC±12 以内的任意运行时区里做加减天数与取月份都不会跨日。
 */
export const SH_TZ = "Asia/Shanghai";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: SH_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short"
});

const WEEK_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 星期中文（0=周日）：与 shParts().w 配套 */
export const WEEKDAY_CN = ["日", "一", "二", "三", "四", "五", "六"] as const;

export type ShParts = { y: number; m: number; d: number; hh: number; mm: number; w: number };

/** 某一时刻在上海时区的年、月（1-12）、日、时、分、星期（0=周日） */
export function shParts(value: Date | string | number): ShParts {
  const map: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(new Date(value))) map[p.type] = p.value;
  return { y: Number(map.year), m: Number(map.month), d: Number(map.day), hh: Number(map.hour) % 24, mm: Number(map.minute), w: WEEK_INDEX[map.weekday] ?? 0 };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 上海日历日键 YYYY-MM-DD */
export function shDayKey(value: Date | string | number): string {
  const p = shParts(value);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 上海时刻 HH:mm */
export function shTime(value: Date | string | number): string {
  const p = shParts(value);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

/** 上海 MM-DD */
export function shMonthDay(value: Date | string | number): string {
  const p = shParts(value);
  return `${pad(p.m)}-${pad(p.d)}`;
}

/** 上海 MM-DD HH:mm */
export function shMonthDayTime(value: Date | string | number): string {
  return `${shMonthDay(value)} ${shTime(value)}`;
}

/** 由日历日键得到本地正午 Date（仅用于日历计算） */
export function civilFromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

/** 上海「今天」的日历日（本地正午 Date） */
export function shTodayCivil(): Date {
  return civilFromKey(shDayKey(new Date()));
}

/** 本地正午日历日 → 键 */
export function civilKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 某时刻相对上海今天相差的日历天数（今天 0，明天 1，昨天 -1） */
export function shDaysFromToday(value: Date | string | number): number {
  return Math.round((civilFromKey(shDayKey(value)).getTime() - shTodayCivil().getTime()) / 86_400_000);
}

/**
 * 上海墙钟字符串 → Date，日期不存在时返回 null。
 *
 * 2026-11-20 新增。起因：全仓有 4 处各自手写「解析后回验」的逻辑——
 * emails/actions.ts、ethical-walls/actions.ts、matters/export-format.ts、
 * sms/confirm-actions.ts。前两处写对了，第三、四处漏了，导致
 * `2026-02-30` 被 V8 静默滚成 3 月 2 日，错误的日期直接进了案件数据。
 *
 * 同一个校验写四遍，就一定会有一遍漏 —— 所以收进这里，让「写对」成为默认。
 *
 * 为什么必须回验：`new Date("2026-02-30T00:00:00+08:00")` 不会报错，
 * V8 会顺延到 3 月 2 日；`2026-13-45 99:99` 更会滚到下一年。
 * 外层若不比对「取回来的年月日时分是否等于输入」，错误就静默通过。
 *
 * 返回 null 而不是抛错：调用方有的是表单校验（该抛 ActionError）、
 * 有的是过滤参数（该退化成「不筛」）。语义由调用方定，这里只回答「存不存在」。
 */
function buildShInstant(text: string, tail: string, expectTime: string | null): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const at = new Date(`${text.trim()}T${tail}+08:00`);
  if (Number.isNaN(at.getTime())) return null;
  if (shDayKey(at) !== text.trim()) return null;
  if (expectTime !== null && shTime(at) !== expectTime) return null;
  return at;
}

/** `YYYY-MM-DD` → 当日上海 00:00 的瞬时；日期不存在返回 null */
export function parseShDayStart(text: string | null | undefined): Date | null {
  if (!text) return null;
  return buildShInstant(text, "00:00:00.000", null);
}

/** `YYYY-MM-DD` → 当日上海 23:59:59.999 的瞬时；日期不存在返回 null */
export function parseShDayEnd(text: string | null | undefined): Date | null {
  if (!text) return null;
  return buildShInstant(text, "23:59:59.999", null);
}

/**
 * `YYYY-MM-DD` + `HH:mm` → 瞬时；日期或时刻不存在返回 null。
 * 时分由调用方先校验格式，这里只负责「这个时刻在上海墙钟里真实存在吗」。
 */
export function parseShDateTime(day: string, hhmm: string): Date | null {
  const t = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!t) return null;
  const hh = Number(t[1]), mm = Number(t[2]);
  if (hh > 23 || mm > 59) return null;
  return buildShInstant(day, `${t[1]}:${t[2]}:00.000`, `${t[1]}:${t[2]}`);
}
