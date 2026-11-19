import { describe, it, expect, afterAll, beforeAll } from "vitest";

import { computeDeadlineDate } from "@/lib/deadline-rules";

/**
 * 期限计算的时区无关性（2026-11-19 新增）。
 *
 * 背景：computeDeadlineDate 内部用 startOfDay（getFullYear/getMonth/getDate），
 * 依赖进程本地时区。若调用方传入 DB 里的真瞬间（如 2026-12-31T00:00:00Z），
 * 在 TZ=UTC 下取到 12-31 正确，但部署到 UTC 以西（如洛杉矶 UTC-8）会取到 12-30，
 * 法定期限再少一天。
 *
 * 修法是让 computeDeadlineDate 自己把输入归一到「上海日历日的正午载体」
 * （civilFromKey(shDayKey(...))，见 sh-time.ts 的约定），调用方无需各自包装。
 *
 * 本文件用两组时区跑同一批断言，证明结果与进程时区无关。
 */

const ORIGINAL_TZ = process.env.TZ;

function calendarDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 模拟 DB 里的真瞬间：UTC 午夜 */
const dbInstant = (iso: string) => new Date(iso);

describe.each([
  ["UTC", "UTC"],
  ["America/Los_Angeles（UTC-8，最坏情况）", "America/Los_Angeles"],
  ["Asia/Shanghai（部署地）", "Asia/Shanghai"]
])("computeDeadlineDate 在 TZ=%s 下", (_label, tz) => {
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it("DB 瞬间 + 1 年不跨日（2026-12-31 → 2027-12-31）", () => {
    expect(calendarDay(computeDeadlineDate(dbInstant("2026-12-31T00:00:00Z"), 1, "YEARS"))).toBe("2027-12-31");
  });

  it("跨闰年的「一年」不早一天（2027-06-15 → 2028-06-15）", () => {
    expect(calendarDay(computeDeadlineDate(dbInstant("2027-06-15T00:00:00Z"), 1, "YEARS"))).toBe("2028-06-15");
  });

  it("闰日续一年钳到月末（2028-02-29 → 2029-02-28）", () => {
    expect(calendarDay(computeDeadlineDate(dbInstant("2028-02-29T00:00:00Z"), 1, "YEARS"))).toBe("2029-02-28");
  });

  it("月末续一月钳到月末（2026-01-31 → 2026-02-28）", () => {
    expect(calendarDay(computeDeadlineDate(dbInstant("2026-01-31T00:00:00Z"), 1, "MONTHS"))).toBe("2026-02-28");
  });

  it("按天推进也是日历日口径（2026-12-31 + 31 天 → 2027-01-31）", () => {
    expect(calendarDay(computeDeadlineDate(dbInstant("2026-12-31T00:00:00Z"), 31, "DAYS"))).toBe("2027-01-31");
  });
});
