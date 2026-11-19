import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

import { assertAllocationTotals } from "@/server/finance/ledger-mutations";

/**
 * 票据关联与核销明细的解耦（2026-11-19）。
 *
 * 背景：assertAllocationTotals 校验「Allocation 明细合计 == payment.allocatedAmount」。
 * 它此前在 allocateLedgerTx 里**无条件执行**，于是某笔实收只要存在历史脏账
 *（明细与余额背离），连「关联发票」——一个既不读也不写 Allocation 的动作——
 * 都会被「实收核销明细与余额不符」拦住。
 *
 * 后果：必须先修好核销账才能关联票据，而修核销账又要求先解除错误分配，形成死结。
 *
 * 修法：把该护栏下沉到 RECEIVABLE 分支。核销仍严格校验，
 * 发票关联只看它自己的余额口径（amount - refundedAmount - 已关联）。
 *
 * 本文件分两部分验证：
 *   1. 函数行为：护栏本身没被削弱（脏账仍抛错）
 *   2. 代码结构：它确实位于 RECEIVABLE 分支内，不再是无条件调用
 */

const SOURCE = readFileSync("src/server/finance/ledger-mutations.ts", "utf8");

describe("assertAllocationTotals 行为未削弱", () => {
  it("明细合计与 allocatedAmount 一致 → 通过", async () => {
    const db = {
      $queryRaw: async () => [{ amount: new Prisma.Decimal("300") }]
    };
    await expect(
      assertAllocationTotals(db as never, {
        id: "p1",
        allocatedAmount: new Prisma.Decimal("300")
      } as never)
    ).resolves.toBeUndefined();
  });

  it("明细合计与 allocatedAmount 背离（脏账）→ 抛 ActionError", async () => {
    const db = {
      // 明细合计 0，但 allocatedAmount 声称 300 —— 典型脏账
      $queryRaw: async () => [{ amount: new Prisma.Decimal("0") }]
    };
    await expect(
      assertAllocationTotals(db as never, {
        id: "p2",
        allocatedAmount: new Prisma.Decimal("300")
      } as never)
    ).rejects.toThrow(/实收核销明细与余额不符/);
  });

  it("多行明细先求和再比较（不是逐行比较）", async () => {
    const db = {
      $queryRaw: async () => [
        { amount: new Prisma.Decimal("100") },
        { amount: new Prisma.Decimal("200") }
      ]
    };
    await expect(
      assertAllocationTotals(db as never, {
        id: "p3",
        allocatedAmount: new Prisma.Decimal("300")
      } as never)
    ).resolves.toBeUndefined();
  });
});

describe("护栏位置：已下沉到 RECEIVABLE 分支", () => {
  it("assertAllocationTotals 调用出现在 RECEIVABLE 分支之后（= 分支内）", () => {
    const idxBranch = SOURCE.indexOf('if (data.kind === "RECEIVABLE") {');
    const idxCheck = SOURCE.indexOf("await assertAllocationTotals(db, payment);");
    expect(idxBranch).toBeGreaterThan(-1);
    expect(idxCheck).toBeGreaterThan(idxBranch);
  });

  it("无条件调用已被移除（不再紧跟 assertPaymentSource）", () => {
    // 修复前是连续两行：assertPaymentSource 之后紧跟 assertAllocationTotals
    const unconditional = /await assertPaymentSource\(db, payment\);\s*\n\s*await assertAllocationTotals\(db, payment\);/;
    expect(unconditional.test(SOURCE)).toBe(false);
  });

  it("INVOICE 分支不调用核销明细校验", () => {
    const idxInvoice = SOURCE.indexOf("// 发票是律师服务费票据");
    expect(idxInvoice).toBeGreaterThan(-1);
    const invoiceBlock = SOURCE.slice(idxInvoice);
    expect(invoiceBlock).not.toContain("assertAllocationTotals(db, payment)");
  });

  it("发票关联仍校验自己的余额口径（不因解耦而失去保护）", () => {
    expect(SOURCE).toContain("分配合计超过实收可关联票据余额");
    expect(SOURCE).toContain("只有已开具发票可以关联实收");
  });
});
