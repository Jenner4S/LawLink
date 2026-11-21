// @vitest-environment node
/**
 * 上海时区工具（2026-11-23）
 *
 * 容器跑在 UTC，业务口径是上海。这组测试钉住的都是**跨日/跨年/月末**这类
 * 一天之差就会出错的地方 —— 期限与保全起止日差一天就是法律风险。
 */
import { describe, expect, it } from "vitest";
import {
  shParts, shStartOfDay, shAddDays, shAddMonthsClamped, shDateString, shYear
} from "@/lib/tz";

// 上海 2026-11-24 00:30 = UTC 2026-11-23T16:30Z
const SH_0030 = new Date(Date.UTC(2026, 10, 23, 16, 30));
// 上海 2026-11-23 23:30 = UTC 2026-11-23T15:30Z
const SH_2330 = new Date(Date.UTC(2026, 10, 23, 15, 30));

describe("上海日历字段", () => {
  it("上海 00:30 属当天，不是前一天", () => {
    expect(shDateString(SH_0030)).toBe("2026-11-24");
    expect(shParts(SH_0030)).toMatchObject({ y: 2026, m: 11, day: 24, h: 0, min: 30 });
  });

  it("上海 23:30 仍属当天", () => {
    expect(shDateString(SH_2330)).toBe("2026-11-23");
  });

  it("跨年：上海 2027-01-01 00:30 = UTC 2026-12-31T16:30Z", () => {
    const ny = new Date(Date.UTC(2026, 11, 31, 16, 30));
    expect(shYear(ny)).toBe(2027);
    expect(shDateString(ny)).toBe("2027-01-01");
  });
});

describe("上海日历运算", () => {
  it("shStartOfDay(上海 00:30) 就是该日 00:00（绝对时刻 = UTC 前一天 16:00）", () => {
    const s = shStartOfDay(SH_0030);
    expect(s.toISOString()).toBe("2026-11-23T16:00:00.000Z");
    expect(shDateString(s)).toBe("2026-11-24");
  });

  it("加一天跨月", () => {
    const end = shAddDays(new Date(Date.UTC(2026, 10, 30, 16, 0)), 1); // 上海 12-01
    expect(shDateString(end)).toBe("2026-12-02");
  });

  it("**1/31 + 1 月钳到 2/28**（不是溢出到 3/2）", () => {
    const jan31 = new Date(Date.UTC(2027, 0, 31, 4, 0)); // 上海 2027-01-31 12:00
    expect(shDateString(jan31)).toBe("2027-01-31");
    expect(shDateString(shAddMonthsClamped(jan31, 1))).toBe("2027-02-28");
  });

  it("闰年 1/31 + 1 月 → 2/29", () => {
    const jan31 = new Date(Date.UTC(2028, 0, 31, 4, 0));
    expect(shDateString(shAddMonthsClamped(jan31, 1))).toBe("2028-02-29");
  });

  it("加 12 个月不影响日期（含跨年）", () => {
    const d = new Date(Date.UTC(2026, 10, 23, 4, 0));
    expect(shDateString(shAddMonthsClamped(d, 12))).toBe("2027-11-23");
  });
});
