// @vitest-environment node
/**
 * 财务核销的**参数契约与纯计算**测试（无数据库）。
 *
 * 分工：钱怎么落在库里由 `finance-ledger-allocation.test.ts` 用真实临时库验证；
 * 本文件只守两件不依赖 SQL 的事——
 * ① `allocationInput` 是核销的唯一入参契约（金额形态、目标去重、条数上限），
 *    且校验必须发生在任何数据库访问**之前**（否则非法金额会先进事务再回滚）；
 * ② `paymentBalance` / `receivableBalance` / `summarizeLedger` 的口径与精度，
 *    这三个函数决定「还能核销多少」，算错一分钱就等于放行超额核销。
 */
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { allocationInput, moneyInput, paymentBalance, receivableBalance, summarizeLedger } from "@/lib/finance/ledger";
import { allocateLedgerTx } from "@/server/finance/ledger-mutations";
import type { LedgerPayment, LedgerReceivable } from "@/lib/finance/ledger";

const dec = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value).toFixed(2);

describe("allocationInput · 金额与目标契约", () => {
  const base = { paymentId: "p1", revision: 0, kind: "RECEIVABLE" as const };

  it("金额必须是大于 0、最多两位小数的数字（0 / 负数 / 三位小数 / 前导零 / 非数字全部拒绝）", () => {
    for (const amount of ["0", "0.00", "-1", "-0.01", "1.234", "01", "1e3", "abc", "", " "]) {
      expect(() => allocationInput.parse({ ...base, items: [{ targetId: "ar1", amount }] }), `amount=${JSON.stringify(amount)}`).toThrow(ZodError);
    }
  });

  it("非法金额的文案是面向用户的中文（不是 zod 默认英文）", () => {
    try {
      moneyInput.parse("1.234");
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues[0].message).toBe("金额须大于 0，最多两位小数");
    }
  });

  it("合法金额：数字与字符串都被归一成字符串交给 Decimal（避免浮点进入 SQL）", () => {
    const parsed = allocationInput.parse({ ...base, items: [{ targetId: "ar1", amount: 100 }, { targetId: "ar2", amount: "0.01" }] });
    expect(parsed.items.map(i => i.amount)).toEqual(["100", "0.01"]);
    expect(parsed.items.every(i => typeof i.amount === "string")).toBe(true);
  });

  it("同一应收/发票不能在一批里出现两次（否则 upsert 会覆盖而不是累加）", () => {
    try {
      allocationInput.parse({ ...base, items: [{ targetId: "same", amount: "10" }, { targetId: "same", amount: "20" }] });
      throw new Error("应当抛错");
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues[0].message).toBe("同一目标只能填写一次");
    }
  });

  it("一批至少 1 项、至多 100 项", () => {
    expect(() => allocationInput.parse({ ...base, items: [] })).toThrow(ZodError);
    const over = Array.from({ length: 101 }, (_, i) => ({ targetId: `t${i}`, amount: "1" }));
    expect(() => allocationInput.parse({ ...base, items: over })).toThrow(ZodError);
    const max = Array.from({ length: 100 }, (_, i) => ({ targetId: `t${i}`, amount: "1" }));
    expect(allocationInput.parse({ ...base, items: max }).items).toHaveLength(100);
  });

  it("kind 只接受 RECEIVABLE / INVOICE；revision 必须是非负整数", () => {
    expect(() => allocationInput.parse({ ...base, kind: "PAYMENT", items: [{ targetId: "t", amount: "1" }] })).toThrow(ZodError);
    expect(() => allocationInput.parse({ ...base, revision: -1, items: [{ targetId: "t", amount: "1" }] })).toThrow(ZodError);
    expect(() => allocationInput.parse({ ...base, revision: 1.5, items: [{ targetId: "t", amount: "1" }] })).toThrow(ZodError);
  });
});

describe("allocateLedgerTx · 参数校验先于数据库访问", () => {
  it("非法金额在触碰任何 SQL 之前就被拒绝（不进入授权锁与事务）", async () => {
    const touched: string[] = [];
    // 任何属性访问都返回一个记录调用的桩函数：只要代码走到 DB，就会留下痕迹
    const spyTx = new Proxy({}, {
      get(_target, prop) {
        return () => {
          touched.push(String(prop));
          throw new Error(`不应触碰数据库（${String(prop)}）`);
        };
      }
    }) as unknown as Prisma.TransactionClient;

    await expect(
      allocateLedgerTx(spyTx, "user-1", { paymentId: "p1", revision: 0, kind: "RECEIVABLE", items: [{ targetId: "ar1", amount: "0" }] })
    ).rejects.toBeInstanceOf(ZodError);
    expect(touched).toEqual([]);
  });

  it("重复目标在触碰任何 SQL 之前就被拒绝", async () => {
    const touched: string[] = [];
    const spyTx = new Proxy({}, {
      get(_target, prop) {
        return () => {
          touched.push(String(prop));
          throw new Error(`不应触碰数据库（${String(prop)}）`);
        };
      }
    }) as unknown as Prisma.TransactionClient;

    await expect(
      allocateLedgerTx(spyTx, "user-1", {
        paymentId: "p1", revision: 0, kind: "RECEIVABLE",
        items: [{ targetId: "ar1", amount: "10" }, { targetId: "ar1", amount: "20" }]
      })
    ).rejects.toBeInstanceOf(ZodError);
    expect(touched).toEqual([]);
  });
});

describe("余额口径 · paymentBalance / receivableBalance", () => {
  const payment = (amount: string, allocated: string, refunded = "0"): LedgerPayment => ({
    id: "p", matterId: "m", amount: new Prisma.Decimal(amount), allocatedAmount: new Prisma.Decimal(allocated),
    refundedAmount: new Prisma.Decimal(refunded), feeEntryId: "fe", occurredAt: new Date(), moneyKind: "LAWYER_FEE",
    revision: 0, sourceValid: true
  });

  const receivable = (amount: string, settled: string, adjustment = "0"): LedgerReceivable => ({
    id: "ar", matterId: "m", title: "一审代理费", amount: new Prisma.Decimal(amount), settledAmount: new Prisma.Decimal(settled),
    adjustmentAmount: new Prisma.Decimal(adjustment), status: "OPEN", dueDate: null, dueState: "UNKNOWN",
    dueCondition: null, conditionSatisfiedAt: null, billingId: null, moneyKind: "LAWYER_FEE", revision: 0
  });

  it("实收可核销余额 = 金额 − 已退款 − 已核销（退款占用的额度不得再分配）", () => {
    expect(dec(paymentBalance(payment("1000.00", "300.00", "200.00")))).toBe("500.00");
    expect(dec(paymentBalance(payment("0.30", "0.10", "0.10")))).toBe("0.10"); // 0.3-0.1-0.1 的浮点陷阱
    expect(dec(paymentBalance(payment("100.00", "100.00")))).toBe("0.00");
  });

  it("应收未核销余额 = 金额 + 调整额 − 已核销（负调整＝减让，可收额随之下降）", () => {
    expect(dec(receivableBalance(receivable("1000.00", "400.00")))).toBe("600.00");
    expect(dec(receivableBalance(receivable("1000.00", "800.00", "-200.00")))).toBe("0.00");
    expect(dec(receivableBalance(receivable("1000.00", "0.00", "50.50")))).toBe("1050.50");
  });

  it("分毫精度不漂移：分账 99999999.99 / 0.01 组合仍可精确到分", () => {
    expect(dec(paymentBalance(payment("99999999.99", "0.01", "0.01")))).toBe("99999999.97");
    expect(dec(receivableBalance(receivable("0.01", "0.01")))).toBe("0.00");
  });
});

describe("summarizeLedger · 汇总口径", () => {
  const p = (id: string, amount: string, allocated: string, moneyKind: "LAWYER_FEE" | "CLIENT_FUNDS" = "LAWYER_FEE", sourceValid = true): LedgerPayment => ({
    id, matterId: "m", amount: new Prisma.Decimal(amount), allocatedAmount: new Prisma.Decimal(allocated),
    refundedAmount: new Prisma.Decimal(0), feeEntryId: `fe-${id}`, occurredAt: new Date(), moneyKind, revision: 0, sourceValid
  });
  const r = (id: string, amount: string, settled: string, status: "OPEN" | "SETTLED" | "CANCELLED" = "OPEN"): LedgerReceivable => ({
    id, matterId: "m", title: id, amount: new Prisma.Decimal(amount), settledAmount: new Prisma.Decimal(settled),
    adjustmentAmount: new Prisma.Decimal(0), status, dueDate: null, dueState: "UNKNOWN", dueCondition: null,
    conditionSatisfiedAt: null, billingId: null, moneyKind: "LAWYER_FEE", revision: 0
  });

  it("来源不一致的实收一律不参与汇总（宁可拒绝，不出错账）", () => {
    expect(() => summarizeLedger([r("ar", "100.00", "0.00")], [p("bad", "100.00", "0.00", "LAWYER_FEE", false)]))
      .toThrow("实收来源不一致，不能生成财务汇总");
  });

  it("作废应收不计入应收总额与未收，但实收未分配余额照算", () => {
    const summary = summarizeLedger(
      [r("a", "1000.00", "400.00"), r("cancelled", "5000.00", "0.00", "CANCELLED")],
      [p("one", "1000.00", "400.00"), p("two", "300.00", "0.00", "CLIENT_FUNDS")]
    );
    expect(summary).toEqual({
      receivable: "1000.00",
      outstanding: "600.00",
      netReceived: "1300.00",
      unallocated: "900.00",
      lawyerFeeReceived: "1000.00",
      clientFundsReceived: "300.00"
    });
  });
});
