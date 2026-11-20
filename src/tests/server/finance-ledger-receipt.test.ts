// @vitest-environment node
/**
 * 实收确认真库测试（confirmReceiptTx）：两步制实收的第二步。
 *
 * 为什么用真库：确认动作的语义全在写入顺序与原子性上——`FeeEntry.confirmState`
 * 条件更新（updateMany where PENDING）防重复、`Payment.feeEntryId` 唯一键防双份实收、
 * 分成派生行与时间线/审计同事务。mock 掉这些 SQL 就只剩「我调用了某个函数」。
 *
 * 隔离：本文件自建临时库 `lawlink_fin_test_*`（lawlink-db:55432），只跑
 * `prisma migrate deploy` 建结构，运行结束 DROP。**绝不写主库 lawlink。**
 * 前置条件：lawlink-db 容器可用（docker compose 的 55432 端口）。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

import { confirmReceiptTx, rejectReceiptTx } from "@/server/finance/ledger-registration";

const DB_NAME = `lawlink_fin_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;


let dropDb: (() => Promise<void>) | undefined;
let prisma: PrismaClient;

beforeAll(async () => {
  // 建库 + 迁移统一交给 helper（退避重试 + 强制清理，见 src/tests/helpers/temp-db.ts）
  const temp = await createTempDatabase(DB_NAME);
  dropDb = temp.drop;
  prisma = temp.prisma;
  console.info(`[finance-ledger-receipt] 临时库：${DB_NAME}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await dropDb?.();
}, 60_000);

let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
const dec = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value).toFixed(2);

async function seedUser(role: "FINANCE" | "LAWYER" = "FINANCE", active = true) {
  return prisma.user.create({
    data: { id: uid("u"), name: `测试${role}`, email: `${uid("mail")}@example.test`, passwordHash: "x", role, active }
  });
}

async function seedMatter(ownerId: string) {
  return prisma.matter.create({ data: { id: uid("m"), internalCode: uid("MS"), title: "实收确认案件", ownerId } });
}

/** 登记的实收流水：按两步制一律先落 PENDING，等财务确认 */
async function seedPendingEntry(
  matterId: string,
  recordedById: string,
  amount: string,
  moneyKind: "LAWYER_FEE" | "CLIENT_FUNDS" | "EXPENSE_RECOVERY" = "LAWYER_FEE",
  type: "RECEIVED" | "COST" = "RECEIVED"
) {
  return prisma.feeEntry.create({
    data: {
      id: uid("fe"), matterId, type, amount: new Prisma.Decimal(amount), moneyKind,
      occurredAt: new Date("2026-11-05T09:00:00+08:00"), recordedById
    }
  });
}

describe("confirmReceiptTx（真库）", () => {
  it("确认待确认实收：FeeEntry → CONFIRMED、生成 Payment、时间线与审计同事务", async () => {
    const user = await seedUser("FINANCE");
    const matter = await seedMatter(user.id);
    const entry = await seedPendingEntry(matter.id, user.id, "1200.00");

    await prisma.$transaction(tx => confirmReceiptTx(tx, user.id, entry.id));

    const entryAfter = await prisma.feeEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entryAfter.confirmState).toBe("CONFIRMED");
    expect(entryAfter.confirmedById).toBe(user.id);
    expect(entryAfter.confirmedAt).not.toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { feeEntryId: entry.id } });
    expect(dec(payment.amount)).toBe("1200.00");
    expect(payment.moneyKind).toBe("LAWYER_FEE");
    expect(dec(payment.allocatedAmount)).toBe("0.00");
    expect(payment.status).toBe("UNALLOCATED");

    expect(await prisma.timelineEvent.count({ where: { matterId: matter.id, eventType: "FEE_RECEIVED", refId: entry.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "FEE_ENTRY_CONFIRM", targetId: entry.id } })).toBe(1);
  });

  it("律师费实收确认派生分成行：COMMISSION 落 CONFIRMED 且带比例/基数快照", async () => {
    const user = await seedUser("FINANCE");
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    await prisma.commissionPlan.create({
      data: { id: uid("cp"), matterId: matter.id, userId: lawyer.id, percent: new Prisma.Decimal("30.00"), label: "主办" }
    });
    const entry = await seedPendingEntry(matter.id, user.id, "1000.00");

    await prisma.$transaction(tx => confirmReceiptTx(tx, user.id, entry.id));

    const commission = await prisma.feeEntry.findFirstOrThrow({
      where: { matterId: matter.id, type: "COMMISSION", parentFeeEntryId: entry.id }
    });
    expect(dec(commission.amount)).toBe("300.00");
    expect(commission.confirmState).toBe("CONFIRMED"); // 派生行不得依赖数据库默认 PENDING
    expect(commission.beneficiaryUserId).toBe(lawyer.id);
    expect(dec(commission.commissionRateSnapshot ?? 0)).toBe("30.00");
    expect(dec(commission.commissionBaseSnapshot ?? 0)).toBe("1000.00");
  });

  it("代收款（CLIENT_FUNDS）确认不派生分成", async () => {
    const user = await seedUser("FINANCE");
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    await prisma.commissionPlan.create({
      data: { id: uid("cp"), matterId: matter.id, userId: lawyer.id, percent: new Prisma.Decimal("30.00") }
    });
    const entry = await seedPendingEntry(matter.id, user.id, "500.00", "CLIENT_FUNDS");

    await prisma.$transaction(tx => confirmReceiptTx(tx, user.id, entry.id));

    expect(await prisma.feeEntry.count({ where: { matterId: matter.id, type: "COMMISSION" } })).toBe(0);
  });

  it("幂等：已确认再确认被拒绝，且不会生成第二笔 Payment", async () => {
    const user = await seedUser("FINANCE");
    const matter = await seedMatter(user.id);
    const entry = await seedPendingEntry(matter.id, user.id, "900.00");

    await prisma.$transaction(tx => confirmReceiptTx(tx, user.id, entry.id));
    await expect(prisma.$transaction(tx => confirmReceiptTx(tx, user.id, entry.id)))
      .rejects.toThrow("此笔已被处理，只有待确认实收可以处理");

    expect(await prisma.payment.count({ where: { feeEntryId: entry.id } })).toBe(1);
  });

  it("非 RECEIVED 流水（COST）不可走确认（支出不经两步制）", async () => {
    const user = await seedUser("FINANCE");
    const matter = await seedMatter(user.id);
    const entry = await seedPendingEntry(matter.id, user.id, "80.00", "EXPENSE_RECOVERY", "COST");

    await expect(prisma.$transaction(tx => confirmReceiptTx(tx, user.id, entry.id)))
      .rejects.toThrow("此笔已被处理，只有待确认实收可以处理");
    expect(await prisma.payment.count({ where: { feeEntryId: entry.id } })).toBe(0);
  });

  it("确认权与写入权分离：非财务岗确认被拒（本人是主办也不行）", async () => {
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    const entry = await seedPendingEntry(matter.id, lawyer.id, "700.00");

    await expect(prisma.$transaction(tx => confirmReceiptTx(tx, lawyer.id, entry.id)))
      .rejects.toThrow("仅具备确认实收到账权限的人员可核对账务");

    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: entry.id } })).confirmState).toBe("PENDING");
    expect(await prisma.payment.count({ where: { feeEntryId: entry.id } })).toBe(0);
  });
});

describe("rejectReceiptTx（真库）", () => {
  it("退回待确认实收：流水被删除、写审计、通知登记人，且不产生 Payment", async () => {
    const finance = await seedUser("FINANCE");
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    const entry = await seedPendingEntry(matter.id, lawyer.id, "600.00");

    await prisma.$transaction(tx => rejectReceiptTx(tx, finance.id, entry.id, "款项未到账"));

    expect(await prisma.feeEntry.count({ where: { id: entry.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { feeEntryId: entry.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "FEE_ENTRY_REJECT", targetId: entry.id } })).toBe(1);
    const notices = await prisma.notification.findMany({ where: { refId: entry.id, refType: "FeeEntry" } });
    expect(notices).toHaveLength(1);
    expect(notices[0].userId).toBe(lawyer.id);
    expect(notices[0].content).toContain("款项未到账");
  });

  it("已确认的实收不能退回（退回只针对待确认）", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const entry = await seedPendingEntry(matter.id, finance.id, "400.00");
    await prisma.$transaction(tx => confirmReceiptTx(tx, finance.id, entry.id));

    await expect(prisma.$transaction(tx => rejectReceiptTx(tx, finance.id, entry.id, "重复登记")))
      .rejects.toThrow("此笔已被处理，只有待确认实收可以处理");

    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: entry.id } })).confirmState).toBe("CONFIRMED");
    expect(await prisma.payment.count({ where: { feeEntryId: entry.id } })).toBe(1);
  });

  it("退回原因必填：空字符串被 schema 拒绝", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const entry = await seedPendingEntry(matter.id, finance.id, "300.00");

    await expect(prisma.$transaction(tx => rejectReceiptTx(tx, finance.id, entry.id, "   ")))
      .rejects.toThrow("请填写退回原因");
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: entry.id } })).confirmState).toBe("PENDING");
  });
});
