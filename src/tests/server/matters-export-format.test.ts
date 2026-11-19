// @vitest-environment node
/**
 * 案件 Excel 导出的格式化层单元测试（`src/server/matters/export-format.ts`）。
 *
 * 该文件此前零测试引用，而它是导出工作簿里「值 → 单元格文本」的唯一入口：
 * 日期边界、空值口径、枚举回退、文件名与表名都在这里定型，改错的代价是导出数据静默错位。
 * 本测试只覆盖纯函数（不查库、不写库、不需要数据库连接）。
 *
 * 重点：`resolveDateBoundary`（2026-09-20 第五轮审计时区修复）。
 * 修复前边界按服务器本地时区构造，UTC 容器里用户选 2026-09-20 实际从上海 09-20 08:00 起筛，
 * 漏掉当日 0-8 点。修复后必须按上海日界构造：
 *   上海 2026-09-20 00:00:00      = UTC 2026-09-19T16:00:00.000Z（UTC 小时 16，且日期是 19 日）
 *   上海 2026-09-20 23:59:59.999  = UTC 2026-09-20T15:59:59.999Z
 * 下面第 3 组用例把「UTC 小时必须是 16、不能是 0」写成显式回归断言——那正是当年 bug 的形态。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  buildFilename,
  cleanDateText,
  cleanText,
  decimalNumber,
  formatDate,
  formatDateTime,
  formatJson,
  label,
  procedureStatusLabel,
  resolveDateBoundary,
  sheetName,
  yesNo
} from "@/server/matters/export-format";

afterEach(() => {
  vi.useRealTimers();
});

describe("cleanText：trim 后空串归 undefined", () => {
  it("保留首尾空白之外的内容", () => {
    expect(cleanText("  张三  ")).toBe("张三");
    expect(cleanText("a b")).toBe("a b");
  });

  it("空串与纯空白归 undefined（不是空串）", () => {
    expect(cleanText("")).toBeUndefined();
    expect(cleanText("   ")).toBeUndefined();
    expect(cleanText("\n\t ")).toBeUndefined();
  });

  it("null 归 undefined", () => {
    expect(cleanText(null)).toBeUndefined();
  });
});

describe("cleanDateText：只接受零填充的 YYYY-MM-DD", () => {
  it("合法日期原样返回，允许首尾空白", () => {
    expect(cleanDateText("2026-09-20")).toBe("2026-09-20");
    expect(cleanDateText("  2026-09-20  ")).toBe("2026-09-20");
    expect(cleanDateText("  2026-09-20\n")).toBe("2026-09-20");
  });

  it("非零填充与其它格式一律 undefined", () => {
    expect(cleanDateText("2026-9-5")).toBeUndefined();
    expect(cleanDateText("20260920")).toBeUndefined();
    expect(cleanDateText("2026/09/20")).toBeUndefined();
    expect(cleanDateText("2026-09-20T00:00:00+08:00")).toBeUndefined();
  });

  it("空值（null / undefined 语义的空串）归 undefined", () => {
    expect(cleanDateText(null)).toBeUndefined();
    expect(cleanDateText("")).toBeUndefined();
    expect(cleanDateText("   ")).toBeUndefined();
  });
});

describe("resolveDateBoundary：按上海日界构造过滤边界（第五轮审计时区修复）", () => {
  it("start = 上海 2026-09-20 00:00:00 → UTC 2026-09-19T16:00:00.000Z", () => {
    const start = resolveDateBoundary("2026-09-20", false);
    expect(start).toBeInstanceOf(Date);
    expect(start?.toISOString()).toBe("2026-09-19T16:00:00.000Z");
    expect(start?.getTime()).toBe(Date.UTC(2026, 8, 19, 16, 0, 0, 0));
  });

  it("end = 上海 2026-09-20 23:59:59.999 → UTC 2026-09-20T15:59:59.999Z", () => {
    const end = resolveDateBoundary("2026-09-20", true);
    expect(end).toBeInstanceOf(Date);
    expect(end?.toISOString()).toBe("2026-09-20T15:59:59.999Z");
    expect(end?.getTime()).toBe(Date.UTC(2026, 8, 20, 15, 59, 59, 999));
  });

  it("回归：start 的 UTC 小时必须是 16 且 UTC 日期是前一日，不能是 0（当年 bug 的形态）", () => {
    const start = resolveDateBoundary("2026-09-20", false);
    expect(start?.getUTCHours()).toBe(16);
    // 若按 UTC 本地构造，小时会是 0、UTC 日期会是 20 —— 正是漏掉上海当日 0-8 点的成因
    expect(start?.getUTCHours()).not.toBe(0);
    expect(start?.getUTCDate()).toBe(19);
    expect(start?.getUTCDate()).not.toBe(20);
    // 反过来：end 的 UTC 日就是同一天，小时 15
    const end = resolveDateBoundary("2026-09-20", true);
    expect(end?.getUTCDate()).toBe(20);
    expect(end?.getUTCHours()).toBe(15);
  });

  it("同一日期的 start/end 覆盖完整上海日（跨度 23:59:59.999）", () => {
    const start = resolveDateBoundary("2026-09-20", false)!;
    const end = resolveDateBoundary("2026-09-20", true)!;
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
    // 上海 0-8 点这条区间必须落在边界内（修复前会被漏掉）
    const shanghaiMidnight = new Date("2026-09-20T00:00:00.000+08:00");
    const shanghaiEight = new Date("2026-09-20T08:00:00.000+08:00");
    expect(start.getTime()).toBeLessThanOrEqual(shanghaiMidnight.getTime());
    expect(end.getTime()).toBeGreaterThanOrEqual(shanghaiEight.getTime());
  });

  it("非法输入一律 undefined", () => {
    expect(resolveDateBoundary("2026-9-20", false)).toBeUndefined();
    expect(resolveDateBoundary("2026-9-20", true)).toBeUndefined();
    expect(resolveDateBoundary("20260920", false)).toBeUndefined();
    expect(resolveDateBoundary("2026/09/20", false)).toBeUndefined();
    expect(resolveDateBoundary("2026-09-20T00:00:00+08:00", false)).toBeUndefined();
    expect(resolveDateBoundary("2026-09-20 ", false)).toBeUndefined();
    expect(resolveDateBoundary("", false)).toBeUndefined();
    expect(resolveDateBoundary("", true)).toBeUndefined();
    expect(resolveDateBoundary(undefined, false)).toBeUndefined();
    expect(resolveDateBoundary(undefined, true)).toBeUndefined();
  });

  it("跨年边界：2026-12-31 end 与 2027-01-01 start 各自落在正确的 UTC 时刻", () => {
    const endOfYear = resolveDateBoundary("2026-12-31", true);
    expect(endOfYear?.toISOString()).toBe("2026-12-31T15:59:59.999Z");
    expect(endOfYear?.getUTCFullYear()).toBe(2026);

    const startOfYear = resolveDateBoundary("2027-01-01", false);
    expect(startOfYear?.toISOString()).toBe("2026-12-31T16:00:00.000Z");
    expect(startOfYear?.getUTCFullYear()).toBe(2026);

    // 跨年两周首尾相接：2026-12-31 的 end 与 2027-01-01 的 start 相差 1 毫秒
    expect(startOfYear!.getTime() - endOfYear!.getTime()).toBe(1);
  });

  it("跨月与闰日边界同样按 +08:00 构造", () => {
    expect(resolveDateBoundary("2026-01-31", true)?.toISOString()).toBe("2026-01-31T15:59:59.999Z");
    expect(resolveDateBoundary("2026-02-01", false)?.toISOString()).toBe("2026-01-31T16:00:00.000Z");
    expect(resolveDateBoundary("2028-02-29", false)?.toISOString()).toBe("2028-02-28T16:00:00.000Z");
    expect(resolveDateBoundary("2028-02-29", true)?.toISOString()).toBe("2028-02-29T15:59:59.999Z");
  });
});

describe("formatDate / formatDateTime：上海时区口径", () => {
  it("formatDate 取上海日历日（UTC 前一日 16:00 已是上海的次日）", () => {
    expect(formatDate(new Date("2026-09-19T16:00:00.000Z"))).toBe("2026-09-20");
    expect(formatDate(new Date("2026-09-20T15:59:59.999Z"))).toBe("2026-09-20");
    expect(formatDate(new Date("2026-09-20T16:00:00.000Z"))).toBe("2026-09-21");
  });

  it("formatDate 空值返回空串", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(undefined)).toBe("");
  });

  it("formatDateTime 输出 YYYY-MM-DD HH:mm 且按上海时刻", () => {
    expect(formatDateTime(new Date("2026-09-20T15:30:00.000Z"))).toBe("2026-09-20 23:30");
    expect(formatDateTime(new Date("2026-09-19T16:00:00.000Z"))).toBe("2026-09-20 00:00");
    expect(formatDateTime(new Date("2026-09-20T01:05:00.000Z"))).toBe("2026-09-20 09:05");
  });

  it("formatDateTime 空值返回空串", () => {
    expect(formatDateTime(null)).toBe("");
    expect(formatDateTime(undefined)).toBe("");
  });
});

describe("decimalNumber：Prisma.Decimal → number", () => {
  it("Decimal 转 number", () => {
    expect(decimalNumber(new Prisma.Decimal("1234.56"))).toBe(1234.56);
    expect(decimalNumber(new Prisma.Decimal("0"))).toBe(0);
    expect(decimalNumber(new Prisma.Decimal("-0.01"))).toBe(-0.01);
    expect(decimalNumber(new Prisma.Decimal("1000000"))).toBe(1000000);
  });

  it("number 原样返回（含 0 与负数，不被当作空值）", () => {
    expect(decimalNumber(1234.56)).toBe(1234.56);
    expect(decimalNumber(0)).toBe(0);
    expect(decimalNumber(-5)).toBe(-5);
  });

  it("null / undefined 返回空串（不是 0）", () => {
    expect(decimalNumber(null)).toBe("");
    expect(decimalNumber(undefined)).toBe("");
  });
});

describe("yesNo：boolean → 是/否", () => {
  it("true 为是、false 为否", () => {
    expect(yesNo(true)).toBe("是");
    expect(yesNo(false)).toBe("否");
  });

  it("null / undefined 一律否", () => {
    expect(yesNo(null)).toBe("否");
    expect(yesNo(undefined)).toBe("否");
  });
});

describe("label：查表，查不到回退原值", () => {
  const customLabels: Record<string, string> = { WON: "胜诉" };

  it("命中返回中文标签", () => {
    expect(label(customLabels, "WON")).toBe("胜诉");
    expect(label(procedureStatusLabel, "CONCLUDED")).toBe("已结束");
    expect(label(procedureStatusLabel, "IN_PROGRESS")).toBe("进行中");
  });

  it("查不到时回退原值（契约：不是空串）", () => {
    // 枚举值未被映射（例如新增枚举后漏加标签）时，宁可显示原值也不显示空白
    expect(label(customLabels, "LOST")).toBe("LOST");
    expect(label(customLabels, "NOT_A_LABEL")).toBe("NOT_A_LABEL");
    expect(label(customLabels, "LOST")).not.toBe("");
  });

  it("空值（null / undefined / 空串）返回空串", () => {
    expect(label<string>(customLabels, null)).toBe("");
    expect(label<string>(customLabels, undefined)).toBe("");
    expect(label<string>(customLabels, "")).toBe("");
  });
});

describe("formatJson：空容器返回空串", () => {
  it("空数组与空对象都返回空串（不是 [] / {}）", () => {
    expect(formatJson([])).toBe("");
    expect(formatJson({})).toBe("");
  });

  it("非空数组与对象序列化", () => {
    expect(formatJson([1, 2])).toBe("[1,2]");
    expect(formatJson({ a: 1 })).toBe('{"a":1}');
    expect(formatJson({ a: [1, { b: null }] })).toBe('{"a":[1,{"b":null}]}');
    expect(formatJson([null])).toBe("[null]");
  });

  it("标量走 String（含 0 与 false，不被当作空值）", () => {
    expect(formatJson("abc")).toBe("abc");
    expect(formatJson(0)).toBe("0");
    expect(formatJson(false)).toBe("false");
    expect(formatJson("")).toBe("");
  });

  it("null / undefined 返回空串", () => {
    expect(formatJson(null)).toBe("");
    expect(formatJson(undefined as unknown as Prisma.JsonValue)).toBe("");
  });
});

describe("buildFilename：含上海日期的工作簿文件名", () => {
  it("各页签的文件名键", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T03:00:00.000Z")); // 上海 11:00，与 UTC 同日
    expect(buildFilename("all")).toBe("lawlink-matters-all-2026-09-20.xlsx");
    expect(buildFilename("intake")).toBe("lawlink-matters-intake-2026-09-20.xlsx");
    expect(buildFilename("active")).toBe("lawlink-matters-active-2026-09-20.xlsx");
    expect(buildFilename("revision")).toBe("lawlink-matters-revision-2026-09-20.xlsx");
    expect(buildFilename("archived")).toBe("lawlink-matters-archived-2026-09-20.xlsx");
  });

  it("日期取上海日历日：UTC 仍是 09-20、上海已跨到 09-21", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T17:30:00.000Z")); // 上海 2026-09-21 01:30
    expect(buildFilename("active")).toBe("lawlink-matters-active-2026-09-21.xlsx");
  });

  it("上海跨年前一刻仍属当年，跨年后跳到次年", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-31T15:59:00.000Z")); // 上海 2026-12-31 23:59
    expect(buildFilename("all")).toBe("lawlink-matters-all-2026-12-31.xlsx");
    vi.setSystemTime(new Date("2026-12-31T16:00:00.000Z")); // 上海 2027-01-01 00:00
    expect(buildFilename("all")).toBe("lawlink-matters-all-2027-01-01.xlsx");
  });
});

describe("sheetName：去 Excel 非法字符 + 截断 31 字符", () => {
  it("去除 \\ / : * ? [ ] 七类非法字符", () => {
    expect(sheetName("案件/清单")).toBe("案件清单");
    expect(sheetName("a\\b:c*d?e[f]g")).toBe("abcdefg");
    expect(sheetName("2026-09-20 案件:一审")).toBe("2026-09-20 案件一审");
  });

  it("全是非法字符或空串时回退 Sheet", () => {
    expect(sheetName("///")).toBe("Sheet");
    expect(sheetName("[]:*?\\")).toBe("Sheet");
    expect(sheetName("")).toBe("Sheet");
  });

  it("超过 31 字符截断到 31", () => {
    const long = "案".repeat(40);
    expect(sheetName(long)).toHaveLength(31);
    expect(sheetName(long)).toBe("案".repeat(31));
    // 先截断后判空：31 个字符被非法字符清空时同样回退 Sheet
    expect(sheetName("/".repeat(40))).toBe("Sheet");
  });

  it("恰好 31 字符不截断，合法字符原样保留", () => {
    const exact = "A".repeat(31);
    expect(sheetName(exact)).toBe(exact);
    const short = "案件台账";
    expect(sheetName(short)).toBe(short);
  });

  it("格式合规但日期不存在的输入一律拒绝（不可静默滚动到别的日期）", () => {
    // 2026-11-20：V8 会把 `2026-02-30` 滚成上海 3 月 2 日、`2026-02-29`（非闰年）
    // 滚成 3 月 1 日、`2026-04-31` 滚成 5 月 1 日。界面用 <input type="date">
    // 拦得住，但直接调接口（脚本、导入、桌面端）不经过那层——必须在这里挡住。
    for (const bad of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-10"]) {
      expect(resolveDateBoundary(bad, false), `start ${bad}`).toBeUndefined();
      expect(resolveDateBoundary(bad, true), `end ${bad}`).toBeUndefined();
    }
    // 闰年 2-29 是真实存在的，必须通过
    expect(resolveDateBoundary("2028-02-29", false)?.toISOString()).toBe("2028-02-28T16:00:00.000Z");
  });
});
