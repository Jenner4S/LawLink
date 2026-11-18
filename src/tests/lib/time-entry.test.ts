import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";

// 纯函数不需要库，先 mock prisma 防止 import 副作用
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const { billableMinutesOf, amountOf } = await import("@/server/time/rate");

describe("计费分钟进位", () => {
  it("increment=0 按实际分钟，不进位", () => {
    expect(billableMinutesOf(7, 0)).toBe(7);
    expect(billableMinutesOf(1, 0)).toBe(1);
  });

  it("increment=6（0.1h 惯例）向上取整", () => {
    expect(billableMinutesOf(7, 6)).toBe(12);   // 1 分多按 12 分
    expect(billableMinutesOf(6, 6)).toBe(6);    // 正好不进位
    expect(billableMinutesOf(1, 6)).toBe(6);    // 1 分钟也按 6 分钟
    expect(billableMinutesOf(13, 6)).toBe(18);
  });

  it("increment=15（0.25h 惯例）向上取整", () => {
    expect(billableMinutesOf(16, 15)).toBe(30);
    expect(billableMinutesOf(15, 15)).toBe(15);
  });

  it("负数或零不进位", () => {
    expect(billableMinutesOf(0, 6)).toBe(0);
  });
});

describe("金额计算", () => {
  const rate = new Prisma.Decimal("2000.00");   // 2000 元/小时

  it("1 小时 = 费率全额", () => {
    expect(amountOf(60, rate).toFixed(2)).toBe("2000.00");
  });

  it("30 分钟 = 半额", () => {
    expect(amountOf(30, rate).toFixed(2)).toBe("1000.00");
  });

  it("6 分钟 = 0.1 小时", () => {
    expect(amountOf(6, rate).toFixed(2)).toBe("200.00");
  });

  it("保留两位小数，四舍五入", () => {
    // 7 分钟 * 1500/60 = 175.00
    expect(amountOf(7, new Prisma.Decimal("1500")).toFixed(2)).toBe("175.00");
    // 1 分钟 * 1000/60 = 16.666… → 16.67
    expect(amountOf(1, new Prisma.Decimal("1000")).toFixed(2)).toBe("16.67");
  });

  it("零分钟金额为零（不产生 -0 或 NaN）", () => {
    expect(amountOf(0, rate).toFixed(2)).toBe("0.00");
  });

  it("Decimal 精度：不出现浮点尾差", () => {
    // 0.1 + 0.2 类问题的等价场景：6 分钟 × 3 次累积
    const once = amountOf(6, new Prisma.Decimal("1000"));
    const total = once.mul(3);
    expect(total.toFixed(2)).toBe("300.00");
  });
});
