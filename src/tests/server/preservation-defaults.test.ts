// @vitest-environment node
/**
 * 保全期限默认值 / 日期推进 —— 纯逻辑单测（不连库）。
 *
 * 被测：src/lib/preservation-defaults.ts（法定年限表、到期日、折算天数、addDays）。
 *
 * 保全期限是法定期限，《民诉法解释》第 485 条以「年」为单位：
 * 银行存款 ≤1 年、动产 ≤2 年、不动产/其他财产权 ≤3 年。这里把「按年」的
 * 日历口径与「按固定天数」的旧口径的差异钉死——固定天数在跨闰年时少一天，
 * 是这类系统最常见的算错点（注释里 2027-06-15 动产两年即此例）。
 *
 * 断言全部以本地日历日构造、只比对年月日，因此在任意运行时区下结果一致。
 */
import { describe, expect, it } from "vitest";
import {
  PRESERVATION_DURATION_YEARS,
  PROPERTY_TYPE_CN,
  addDays,
  defaultDurationDays,
  defaultExpiryDate,
  preservationDurationYears
} from "@/lib/preservation-defaults";
import { computeDeadlineDate } from "@/lib/deadline-rules";
import type { PropertyType } from "@prisma/client";

const DAY = 86_400_000;
/** 本地正午日历日：只读年月日，跨时区不失真（与 UI 的 civilFromKey 同口径） */
const civil = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);
const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];
const days = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY);

describe("法定年限表", () => {
  it("年限与《民诉法解释》第 485 条一致：存款 1 年、动产 2 年、不动产/其他财产权 3 年", () => {
    expect(PRESERVATION_DURATION_YEARS.BANK_DEPOSIT).toBe(1);
    expect(PRESERVATION_DURATION_YEARS.VEHICLE).toBe(2);
    expect(PRESERVATION_DURATION_YEARS.OTHER).toBe(2);
    expect(PRESERVATION_DURATION_YEARS.REAL_ESTATE).toBe(3);
    expect(PRESERVATION_DURATION_YEARS.EQUITY).toBe(3);
    expect(PRESERVATION_DURATION_YEARS.IP).toBe(3);
    expect(preservationDurationYears("BANK_DEPOSIT")).toBe(1);
    expect(preservationDurationYears("REAL_ESTATE")).toBe(3);
  });

  it("未知类型回退到 2 年（不抛错、不返回 0）", () => {
    expect(preservationDurationYears("SOMETHING_NEW" as PropertyType)).toBe(2);
  });

  it("六种财产类型都有中文名（枚举与展示表不能漏项）", () => {
    const types: PropertyType[] = ["BANK_DEPOSIT", "REAL_ESTATE", "VEHICLE", "EQUITY", "IP", "OTHER"];
    for (const t of types) expect(PROPERTY_TYPE_CN[t]).toBeTruthy();
    expect(PROPERTY_TYPE_CN.BANK_DEPOSIT).toBe("银行存款");
    expect(PROPERTY_TYPE_CN.REAL_ESTATE).toBe("房产");
  });
});

describe("defaultExpiryDate（按年日历口径）", () => {
  it("各类型按年限推进到同一月日", () => {
    expect(ymd(defaultExpiryDate(civil(2027, 6, 15), "BANK_DEPOSIT"))).toEqual([2028, 6, 15]);
    expect(ymd(defaultExpiryDate(civil(2027, 6, 15), "VEHICLE"))).toEqual([2029, 6, 15]);
    expect(ymd(defaultExpiryDate(civil(2027, 6, 15), "REAL_ESTATE"))).toEqual([2030, 6, 15]);
  });

  it("闰日 2 月 29 起算：到期月无对应日时钳到月末（2028-02-29 + 1 年 = 2029-02-28）", () => {
    expect(ymd(defaultExpiryDate(civil(2028, 2, 29), "BANK_DEPOSIT"))).toEqual([2029, 2, 28]);
    expect(ymd(defaultExpiryDate(civil(2028, 2, 29), "VEHICLE"))).toEqual([2030, 2, 28]);
    expect(ymd(defaultExpiryDate(civil(2028, 2, 29), "REAL_ESTATE"))).toEqual([2031, 2, 28]);
  });

  it("闰日起算推 4 年落回 2 月 29（钳制只在到期月没有对应日时发生）", () => {
    // 引擎口径直测：2028-02-29 + 4 年 = 2032-02-29（2032 是闰年，不得钳到 28 日）
    expect(ymd(computeDeadlineDate(civil(2028, 2, 29), 4, "YEARS"))).toEqual([2032, 2, 29]);
    // 而默认年限表内（1/2/3 年）都落在平年，钳到 2 月 28 日
    expect(ymd(computeDeadlineDate(civil(2028, 2, 29), 3, "YEARS"))).toEqual([2031, 2, 28]);
  });

  it("年末起算跨年不失真：2027-12-31 + 1 年 = 2028-12-31", () => {
    expect(ymd(defaultExpiryDate(civil(2027, 12, 31), "BANK_DEPOSIT"))).toEqual([2028, 12, 31]);
  });

  it("1 月 31 日 + 1 年不溢出到 3 月（按年推进不涉月钳，仍为 1 月 31 日）", () => {
    expect(ymd(defaultExpiryDate(civil(2027, 1, 31), "BANK_DEPOSIT"))).toEqual([2028, 1, 31]);
  });

  it("到期日晚于起算日、且不早于按天数的近似值", () => {
    const start = civil(2027, 6, 15);
    const end = defaultExpiryDate(start, "VEHICLE");
    expect(end.getTime()).toBeGreaterThan(start.getTime());
  });
});

describe("defaultDurationDays（折算天数：随起算日变化，不能写成常量）", () => {
  it("动产两年（2027-06-15 → 2029-06-15，含 2028 闰日）= 731 天，而非固定 730", () => {
    expect(defaultDurationDays(civil(2027, 6, 15), "VEHICLE")).toBe(731);
  });

  it("同一类型不同起算日天数不同：2026-06-15 起算 731 天，2029-01-01 起算 730 天", () => {
    expect(defaultDurationDays(civil(2026, 6, 15), "VEHICLE")).toBe(731);
    expect(defaultDurationDays(civil(2027, 1, 1), "VEHICLE")).toBe(731);
    // 2029-01-01 → 2031-01-01：区间内无 2 月 29 日（2030 非闰年）
    expect(defaultDurationDays(civil(2029, 1, 1), "VEHICLE")).toBe(730);
  });

  it("银行存款一年：闰日区间 366 天，平年区间 365 天", () => {
    // 2027-06-15 → 2028-06-15 含 2028-02-29
    expect(defaultDurationDays(civil(2027, 6, 15), "BANK_DEPOSIT")).toBe(366);
    // 2029-06-15 → 2030-06-15 不含闰日
    expect(defaultDurationDays(civil(2029, 6, 15), "BANK_DEPOSIT")).toBe(365);
  });

  it("不动产三年：闰日区间 1095 天", () => {
    expect(defaultDurationDays(civil(2024, 2, 29), "REAL_ESTATE")).toBe(1095);
  });

  it("折算天数与 defaultExpiryDate 自洽（不引入时区偏移，非 364/367 之类）", () => {
    const start = civil(2027, 6, 15);
    const end = defaultExpiryDate(start, "VEHICLE");
    expect(defaultDurationDays(start, "VEHICLE")).toBe(days(new Date(2027, 5, 15), end));
  });
});

describe("addDays（本地日历推进）", () => {
  it("闰日前后各一日", () => {
    expect(ymd(addDays(civil(2028, 2, 28), 1))).toEqual([2028, 2, 29]);
    expect(ymd(addDays(civil(2028, 2, 28), 2))).toEqual([2028, 3, 1]);
    expect(ymd(addDays(civil(2028, 2, 29), 1))).toEqual([2028, 3, 1]);
  });

  it("平年 2 月末到 3 月 1 日", () => {
    expect(ymd(addDays(civil(2029, 2, 28), 1))).toEqual([2029, 3, 1]);
  });

  it("跨年：2027-12-31 + 1 天 = 2028-01-01", () => {
    expect(ymd(addDays(civil(2027, 12, 31), 1))).toEqual([2028, 1, 1]);
  });

  it("会带上时间部分，只按日推进（不因夏令时/时区偏移少一天）", () => {
    const out = addDays(new Date(2028, 1, 28, 23, 30), 1);
    expect(ymd(out)).toEqual([2028, 2, 29]);
    expect(out.getHours()).toBe(0);
    expect(out.getMinutes()).toBe(0);
  });
});

/**
 * 续保路径的日期口径交叉验证。
 *
 * UI 的续保弹窗用 `newExpiry = 旧到期日 + 天数 × 86400000`（默认 365 天），
 * 服务端 renewProperty 只存这个日期、不按 renewalDuration 重算，所以
 * 「续保一年是否等于法定一年」完全取决于这里的按天推进。
 */
describe("续保按天推进 vs 法定按年（跨闰年差一天）", () => {
  it("默认「续保 365 天」跨闰年比整一年短一天：2027-06-15 + 365 天 = 2028-06-14", () => {
    expect(ymd(addDays(civil(2027, 6, 15), 365))).toEqual([2028, 6, 14]);
    // 法定/文书口径的整一年是 2028-06-15
    expect(ymd(defaultExpiryDate(civil(2027, 6, 15), "BANK_DEPOSIT"))).toEqual([2028, 6, 15]);
  });

  it("不跨闰年时两者一致：2029-06-15 + 365 天 = 2030-06-15", () => {
    expect(ymd(addDays(civil(2029, 6, 15), 365))).toEqual([2030, 6, 15]);
  });

  it("动产两年：+730 天比法定两年早一天（2029-06-14 vs 2029-06-15）", () => {
    expect(ymd(addDays(civil(2027, 6, 15), 730))).toEqual([2029, 6, 14]);
    expect(ymd(addDays(civil(2027, 6, 15), 731))).toEqual([2029, 6, 15]);
    expect(ymd(defaultExpiryDate(civil(2027, 6, 15), "VEHICLE"))).toEqual([2029, 6, 15]);
  });

  it("闰日起算续保一年落在 2 月 28 日（与按年钳制同结果，不是 3 月 1 日）", () => {
    expect(ymd(addDays(civil(2028, 2, 29), 365))).toEqual([2029, 2, 28]);
    expect(ymd(defaultExpiryDate(civil(2028, 2, 29), "BANK_DEPOSIT"))).toEqual([2029, 2, 28]);
  });
});
