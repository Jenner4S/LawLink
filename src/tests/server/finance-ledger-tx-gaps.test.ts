// @vitest-environment node
/**
 * 三个「有真实业务逻辑、此前零测试引用」的财务事务：
 *
 *   A. `settleCommissionTx`（ledger-corrections.ts:188）——分成实际支付 / 扣回
 *   B. `adjustInvoiceTx`（invoices/adjustments.ts:7）——已开票更正（红冲 / 作废 / 换开）
 *   C. `draftAmendmentTx`（ledger-contracts.ts:33）——收费变更草稿
 *      （附带 activate / cancel 的行为对照，用于验证「草稿不生效、激活才改账、取消不留账」）
 *
 * 为什么必须用真库：三条路径的钱全在 SQL 侧——`SELECT … FOR UPDATE` 的行锁、
 * `revision` 乐观锁、`CASE WHEN` 迁移冗余余额、`InvoiceAdjustment` 唯一索引与
 * `SUM(amount)` 累计、`CommissionSettlement` 的 CHECK 约束。mock 掉这些，等于把
 * 「钱有没有算错」换成「我 mock 了什么」。夹具搭建方式照抄同目录的
 * `finance-ledger-sign.test.ts` / `finance-ledger-correction.test.ts`。
 *
 * 隔离：每次运行建独立临时库 `lawlink_fintxgap_test_*`（lawlink-db:55432）→ 只跑
 * `prisma migrate deploy` 建结构 → 结束 `DROP DATABASE … WITH (FORCE)`。
 * **绝不写主库 lawlink。** 本文件使用自建 PrismaClient，不碰 `@/lib/prisma` 单例。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";
import { ActionError } from "@/lib/action-error";

// 必须在任何被测模块被求值之前改 DATABASE_URL（vi.hoisted 先于 import 执行），
// 这样即使某处误用 `@/lib/prisma` 单例，也只可能落到临时库。
const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_fintxgap_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

import { settleCommissionTx, commissionPositions } from "@/server/finance/ledger-corrections";
import { draftAmendmentTx, activateAmendmentTx, cancelAmendmentTx } from "@/server/finance/ledger-contracts";
import { adjustInvoiceTx } from "@/server/invoices/adjustments";
import { recordMatterReviewTx } from "@/server/conflicts/matter-review";


let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  // 建库 + 迁移统一交给 helper（退避重试 + 强制清理，见 src/tests/helpers/temp-db.ts）
  const temp = await createTempDatabase(HOLDER.name);
  dropDb = temp.drop;
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  console.info(`[finance-ledger-tx-gaps] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await dropDb?.();
}, 60_000);

/* ================================================================== *
 * 通用夹具（与 finance-ledger-sign / -correction 同一套写法）
 * ================================================================== */
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  v === null || v === undefined ? null : new Prisma.Decimal(v).toFixed(2);

/** 计提日（分成行）/ 支付日 / 合同签署日 / 开票日：全部落在过去的确定时刻 */
const OCCURRED = new Date("2026-11-01T10:00:00+08:00");
const LATER = new Date("2026-11-05T10:00:00+08:00");
const EARLIER = new Date("2026-10-30T10:00:00+08:00");
const SIGNED = new Date("2026-11-10T10:00:00+08:00");
const EFFECTIVE = new Date("2026-11-12T00:00:00+08:00");

const SERIAL = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000 };

async function seedUser(
  role: "FINANCE" | "LAWYER" | "PRINCIPAL_LAWYER" | "CUSTOM",
  options: { active?: boolean; roleDefinitionId?: string } = {}
) {
  return prisma.user.create({
    data: {
      id: uid("u"), name: `缺口测试${role}${uid("N")}`, email: `${uid("mail")}@example.test`,
      passwordHash: "x", role: role as never, active: options.active ?? true,
      roleDefinitionId: options.roleDefinitionId ?? null
    }
  });
}

/** 自定义岗位：按 grants 精确授予（内置岗位不接受 RolePermission 配置） */
async function seedCustomRole(grants: { permissionKey: string; scope: string }[]) {
  const tag = uid("R");
  const role = await prisma.roleDefinition.create({
    data: {
      id: uid("role"), name: `缺口测试岗位${tag}`, normalizedName: `缺口测试岗位${tag}`.toLowerCase(),
      permissions: { create: grants }
    }
  });
  const user = await prisma.user.create({
    data: {
      id: uid("u"), name: `缺口测试自定义${tag}`, email: `${uid("mail")}@example.test`,
      passwordHash: "x", role: "CUSTOM", roleDefinitionId: role.id
    }
  });
  return { role, user };
}

/** 客户名逐条唯一：动态冲突复核会重跑检索，同名会被判成新命中 */
async function seedMatter(ownerId: string, options: { status?: "IN_PROGRESS" | "ARCHIVED" } = {}) {
  const client = await prisma.client.create({ data: { id: uid("c"), name: `缺口当事人${uid("N")}`, type: "INDIVIDUAL" } });
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("MS"), title: "缺口测试案件", ownerId,
      primaryClientId: client.id, status: options.status ?? "IN_PROGRESS"
    }
  });
}

async function seedReceipt(matterId: string, userId: string, amount: string) {
  const entry = await prisma.feeEntry.create({
    data: {
      id: uid("fe"), matterId, type: "RECEIVED", amount: D(amount), moneyKind: "LAWYER_FEE",
      occurredAt: OCCURRED, recordedById: userId, confirmState: "CONFIRMED",
      confirmedById: userId, confirmedAt: OCCURRED
    }
  });
  const payment = await prisma.payment.create({
    data: {
      id: uid("p"), matterId, feeEntryId: entry.id, amount: D(amount), moneyKind: "LAWYER_FEE",
      occurredAt: OCCURRED, recordedById: userId
    }
  });
  return { entry, payment };
}

async function seedDocument(matterId: string, uploadedById: string) {
  // id 交给 Prisma 生成 cuid：invoiceAdjustmentInput.documentId 是 z.string().cuid()
  return prisma.document.create({
    data: { matterId, name: `依据材料${uid("N")}.pdf`, path: `matters/${matterId}/doc.pdf`, uploadedById }
  });
}

async function seedProcedure(matterId: string) {
  return prisma.matterProcedure.create({ data: { id: uid("proc"), matterId, type: "FIRST_INSTANCE", order: 1 } });
}

/** 隔离墙：写路径由 assertLedgerWrite 的 isMatterWalledFor 判定（读路径另有过滤） */
async function seedWall(args: { matterId: string; createdById: string; userId: string }) {
  return prisma.ethicalWall.create({
    data: {
      id: uid("wall"), matterId: args.matterId, reason: "本所同时为对方公司提供常年顾问，须隔离本案",
      createdById: args.createdById,
      denials: { create: [{ denyType: "USER", userId: args.userId }] }
    }
  });
}

/** 通过生产入口落一次复核：未命中自动 DIFFERENT + 主体指纹 */
function seedMatterReview(userId: string, matterId: string) {
  return prisma.$transaction(tx => recordMatterReviewTx(tx, userId, matterId), SERIAL);
}

const readPositions = (matterId: string) =>
  prisma.$transaction(tx => commissionPositions(tx, [matterId]));

/* ================================================================== *
 * A · settleCommissionTx —— 分成实际支付 / 扣回
 * ================================================================== */
const settle = (userId: string, input: Record<string, unknown>) =>
  prisma.$transaction(tx => settleCommissionTx(tx, userId, input as never), SERIAL);

function settlement(commissionEntryId: string, revision: number, overrides: Record<string, unknown> = {}) {
  return {
    commissionEntryId, revision, kind: "PAID", amount: "60.00", occurredAt: LATER,
    voucherReference: "付-0001", note: "", ...overrides
  };
}

/** 一笔计提 100（基数 1000 的 10%）+ 对应已确认实收；案件归财务本人 */
async function seedSettleable(amount = "100.00", base = "1000.00") {
  const finance = await seedUser("FINANCE");
  const matter = await seedMatter(finance.id);
  const { entry, payment } = await seedReceipt(matter.id, finance.id, base);
  const commission = await prisma.feeEntry.create({
    data: {
      id: uid("cm"), matterId: matter.id, type: "COMMISSION", amount: D(amount), moneyKind: "LAWYER_FEE",
      occurredAt: OCCURRED, parentFeeEntryId: entry.id, beneficiaryUserId: finance.id,
      recordedById: finance.id, commissionRateSnapshot: D("10.00"), commissionBaseSnapshot: D(base),
      confirmState: "CONFIRMED"
    }
  });
  return { finance, matter, entry, payment, commission };
}

/**
 * 退款导致的分成冲减：`applyCorrectionPlan` 在真实路径上写下的就是这样一条
 * `COMMISSION_ADJUSTMENT` 效果行（delta 为负）。这里直接构造同一状态，
 * 不重复测退款链路（`finance-ledger-correction-apply.test.ts` 已覆盖）。
 */
async function seedCommissionAdjustment(
  args: { matterId: string; paymentId: string; commissionId: string; userId: string; delta: string }
) {
  const correction = await prisma.financeCorrection.create({
    data: {
      id: uid("fc"), matterId: args.matterId, targetType: "Payment", targetId: args.paymentId,
      paymentId: args.paymentId, type: "REFUND", amount: D("200.00"), reason: "客户部分退费",
      createdById: args.userId, occurredAt: LATER, status: "CONFIRMED",
      confirmedById: args.userId, confirmedAt: LATER, requestPayload: {}
    }
  });
  await prisma.financeCorrectionEffect.create({
    data: {
      id: uid("eff"), correctionId: correction.id, effectKind: "COMMISSION_ADJUSTMENT",
      delta: D(args.delta), commissionEntryId: args.commissionId
    }
  });
  return correction;
}

const settlementsOf = (commissionId: string) =>
  prisma.commissionSettlement.findMany({ where: { commissionEntryId: commissionId }, orderBy: { createdAt: "asc" } });

describe("settleCommissionTx · 正常路径", () => {
  it("支付 60：结算行落库、计提 revision 递增、余额同步、审计留痕", async () => {
    const { finance, commission } = await seedSettleable();

    const result = await settle(finance.id, settlement(commission.id, 0, { amount: "60.00" }));
    expect(result).toMatchObject({ matterId: commission.matterId, id: expect.any(String) });

    const rows = await settlementsOf(commission.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "PAID", recordedById: finance.id, voucherReference: "付-0001", note: "", voidedAt: null
    });
    expect(dec(rows[0].amount)).toBe("60.00");
    expect(rows[0].occurredAt.toISOString()).toBe(LATER.toISOString());

    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(1);

    const position = (await readPositions(commission.matterId)).find(p => p.id === commission.id)!;
    expect(dec(position.paid)).toBe("60.00");
    expect(dec(position.netPaid)).toBe("60.00");
    expect(dec(position.payable)).toBe("40.00");
    expect(dec(position.recoverable)).toBe("0.00");

    const audits = await prisma.auditLog.findMany({ where: { action: "COMMISSION_PAID", targetId: rows[0].id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(finance.id);
    expect(audits[0].detail).toMatchObject({
      matterId: commission.matterId, commissionEntryId: commission.id,
      previousRevision: 0, amount: "60.00", voucherReference: "付-0001"
    });
  });

  it("扣回 20（退款把有效计提压到 80 之后）：可扣回额放开、扣回后归零", async () => {
    const { finance, matter, payment, commission } = await seedSettleable();
    await settle(finance.id, settlement(commission.id, 0, { amount: "100.00" }));
    await seedCommissionAdjustment({
      matterId: matter.id, paymentId: payment.id, commissionId: commission.id, userId: finance.id, delta: "-20.00"
    });

    // 计提 100，调整 −20 → 有效 80；已付 100 → 可扣回 20
    const before = (await readPositions(matter.id)).find(p => p.id === commission.id)!;
    expect(dec(before.accrued)).toBe("80.00");
    expect(dec(before.recoverable)).toBe("20.00");
    expect(dec(before.payable)).toBe("0.00");

    await settle(finance.id, settlement(commission.id, 1, {
      kind: "RECOVERED", amount: "20.00", voucherReference: "扣-0001", note: "客户退款按比例扣回"
    }));

    const rows = await settlementsOf(commission.id);
    expect(rows.map(r => r.kind)).toEqual(["PAID", "RECOVERED"]);
    expect(dec(rows[1].amount)).toBe("20.00");
    expect(rows[1].voucherReference).toBe("扣-0001");
    // 扣回不改计提金额，只走结算行；计提 revision 再 +1
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(2);
    const after = (await readPositions(matter.id)).find(p => p.id === commission.id)!;
    expect(dec(after.recovered)).toBe("20.00");
    expect(dec(after.netPaid)).toBe("80.00");
    expect(dec(after.recoverable)).toBe("0.00");
    expect(dec(after.payable)).toBe("0.00");

    const audits = await prisma.auditLog.findMany({ where: { action: "COMMISSION_RECOVERED", targetId: rows[1].id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toMatchObject({ amount: "20.00", previousRevision: 1 });
  });
});

describe("settleCommissionTx · 上限与不叠加（钱的核心不变式）", () => {
  it("累计支付不得超过可支付额：60 后补 40 成功，再补 0.01 被拒", async () => {
    const { finance, matter, commission } = await seedSettleable();
    await settle(finance.id, settlement(commission.id, 0, { amount: "60.00" }));

    await settle(finance.id, settlement(commission.id, 1, { amount: "40.00", voucherReference: "付-0002" }));
    const position = (await readPositions(matter.id)).find(p => p.id === commission.id)!;
    expect(dec(position.payable)).toBe("0.00");
    expect(dec(position.netPaid)).toBe("100.00");

    await expect(settle(finance.id, settlement(commission.id, 2, { amount: "0.01", voucherReference: "付-0003" })))
      .rejects.toThrow("支付超过当前待支付金额");
    // 被拒的调用没有留下任何痕迹
    expect(await settlementsOf(commission.id)).toHaveLength(2);
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(2);
  });

  it("单次超额（100 计提付 100.01）同样被拒，一分不入账", async () => {
    const { finance, commission } = await seedSettleable();
    await expect(settle(finance.id, settlement(commission.id, 0, { amount: "100.01" })))
      .rejects.toThrow("支付超过当前待支付金额");
    expect(await settlementsOf(commission.id)).toHaveLength(0);
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(0);
  });

  it("重复结算不叠加：同一请求（旧 revision）被乐观锁拒绝；换新 revision 再发也被上限挡住", async () => {
    const { finance, commission } = await seedSettleable();
    const input = settlement(commission.id, 0, { amount: "60.00" });
    await settle(finance.id, input);

    // ① 原样重放：revision 已从 0 变为 1
    await expect(settle(finance.id, input)).rejects.toThrow("分成账务已变化，请刷新");
    // ② 换新 revision 重放：金额上限兜住（60 + 60 > 100）
    await expect(settle(finance.id, settlement(commission.id, 1, { amount: "60.00" })))
      .rejects.toThrow("支付超过当前待支付金额");

    const rows = await settlementsOf(commission.id);
    expect(rows).toHaveLength(1);
    expect(dec(rows[0].amount)).toBe("60.00");
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(1);
  });

  it("扣回不得超过可扣回额：未支付时扣回 1 元被拒，扣回超额也被拒", async () => {
    const { finance, matter, payment, commission } = await seedSettleable();
    // 未支付任何分成 → recoverable = 0
    await expect(settle(finance.id, settlement(commission.id, 0, { kind: "RECOVERED", amount: "1.00" })))
      .rejects.toThrow("扣回超过当前待扣回金额");

    await settle(finance.id, settlement(commission.id, 0, { amount: "100.00" }));
    await seedCommissionAdjustment({
      matterId: matter.id, paymentId: payment.id, commissionId: commission.id, userId: finance.id, delta: "-20.00"
    });
    await expect(settle(finance.id, settlement(commission.id, 1, { kind: "RECOVERED", amount: "20.01" })))
      .rejects.toThrow("扣回超过当前待扣回金额");

    expect((await settlementsOf(commission.id)).map(r => r.kind)).toEqual(["PAID"]);
  });
});

describe("settleCommissionTx · 权限与前置门禁", () => {
  it("授薪律师（无 finance.settle）→ 独立财务执行权限不足", async () => {
    const { commission } = await seedSettleable();
    const lawyer = await seedUser("LAWYER");
    await expect(settle(lawyer.id, settlement(commission.id, 0)))
      .rejects.toThrow("当前岗位没有此项独立财务执行权限");
    expect(await settlementsOf(commission.id)).toHaveLength(0);
  });

  it("自定义岗位未授予 finance.settle → 岗位权限不足（不用独立执行权限文案）", async () => {
    const { commission } = await seedSettleable();
    const { user } = await seedCustomRole([
      { permissionKey: "matters.read", scope: "OWN" },
      { permissionKey: "finance.write", scope: "ALL" },
      { permissionKey: "finance.read", scope: "ALL" }
    ]);
    await expect(settle(user.id, settlement(commission.id, 0))).rejects.toThrow("当前岗位没有此项财务权限");
  });

  it("账号已停用 → 账号门禁先拦", async () => {
    const { commission } = await seedSettleable();
    const disabled = await seedUser("FINANCE", { active: false });
    await expect(settle(disabled.id, settlement(commission.id, 0))).rejects.toThrow("账号已停用或不存在");
  });

  it("归档案件未指定财务收尾人 → 拒绝追加财务业务", async () => {
    const { finance, matter, commission } = await seedSettleable();
    await prisma.matter.update({ where: { id: matter.id }, data: { status: "ARCHIVED" } });
    await expect(settle(finance.id, settlement(commission.id, 0)))
      .rejects.toThrow("只有本案指定的财务收尾负责人可以追加财务业务");
    expect(await settlementsOf(commission.id)).toHaveLength(0);
  });

  it("目标不是分成计提行（实收行）→ 被拒，且不写结算行", async () => {
    const { finance, entry } = await seedSettleable();
    // commissionPositions 只收 type='COMMISSION'，实收行永远找不到 → 归入「已变化」口径
    await expect(settle(finance.id, settlement(entry.id, 0))).rejects.toThrow("分成账务已变化，请刷新");
    expect(await prisma.commissionSettlement.count({ where: { commissionEntryId: entry.id } })).toBe(0);
  });

  it("计提不存在 → 「分成计提不存在」", async () => {
    const finance = await seedUser("FINANCE");
    await expect(settle(finance.id, settlement(uid("cm-missing"), 0))).rejects.toThrow("分成计提不存在");
  });

  it("支付日期早于计提日期 → 拒绝；扣回日期早于已有支付 → 拒绝", async () => {
    const { finance, commission } = await seedSettleable();
    await expect(settle(finance.id, settlement(commission.id, 0, { occurredAt: EARLIER })))
      .rejects.toThrow("支付日期不能早于分成计提");

    await settle(finance.id, settlement(commission.id, 0, { amount: "100.00", occurredAt: LATER }));
    // 退款把有效计提压到 80，从而留出 20 的可扣回空间（扣回日期门禁才有意义）
    await seedCommissionAdjustment({
      matterId: commission.matterId,
      paymentId: (await prisma.payment.findFirstOrThrow({ where: { matterId: commission.matterId } })).id,
      commissionId: commission.id, userId: finance.id, delta: "-20.00"
    });
    await expect(settle(finance.id, settlement(commission.id, 1, {
      kind: "RECOVERED", amount: "20.00", occurredAt: new Date("2026-11-03T10:00:00+08:00")
    }))).rejects.toThrow("扣回日期不能早于已有支付或扣回");
  });

  it("隔离墙覆盖写路径：被隔离的财务不能给该案登记分成", async () => {
    const { finance, matter, commission } = await seedSettleable();
    const principal = await seedUser("PRINCIPAL_LAWYER");
    await seedWall({ matterId: matter.id, createdById: principal.id, userId: finance.id });

    await expect(settle(finance.id, settlement(commission.id, 0))).rejects.toThrow("案件不存在或无权处理");
    expect(await settlementsOf(commission.id)).toHaveLength(0);
  });

  it("内置财务可为他人承办的案件登记分成（finance.settle 恒为 ALL，无「本案经办」概念）—— 记录口径", async () => {
    const owner = await seedUser("LAWYER");
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(owner.id);
    const { entry } = await seedReceipt(matter.id, owner.id, "1000.00");
    const commission = await prisma.feeEntry.create({
      data: {
        id: uid("cm"), matterId: matter.id, type: "COMMISSION", amount: D("100.00"), moneyKind: "LAWYER_FEE",
        occurredAt: OCCURRED, parentFeeEntryId: entry.id, beneficiaryUserId: owner.id, recordedById: finance.id,
        commissionRateSnapshot: D("10.00"), commissionBaseSnapshot: D("1000.00"), confirmState: "CONFIRMED"
      }
    });

    await expect(settle(finance.id, settlement(commission.id, 0, { amount: "30.00" }))).resolves.toMatchObject({ matterId: matter.id });
    expect(await settlementsOf(commission.id)).toHaveLength(1);
  });

  it("输入校验：金额 0 / 凭据空白 / 未来日期 → ActionError，且不触碰数据库", async () => {
    const { finance, commission } = await seedSettleable();
    await expect(settle(finance.id, settlement(commission.id, 0, { amount: "0" }))).rejects.toBeInstanceOf(ActionError);
    await expect(settle(finance.id, settlement(commission.id, 0, { voucherReference: "   " }))).rejects.toBeInstanceOf(ActionError);
    await expect(settle(finance.id, settlement(commission.id, 0, { occurredAt: new Date("2099-01-01T00:00:00+08:00") })))
      .rejects.toBeInstanceOf(ActionError);
    expect(await settlementsOf(commission.id)).toHaveLength(0);
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(0);
  });
});

describe("settleCommissionTx · 并发", () => {
  it("两个财务同时支付同一笔全额：只成交一次，结算行不翻倍", async () => {
    const { finance, commission } = await seedSettleable();
    const financeB = await seedUser("FINANCE");
    const input = settlement(commission.id, 0, { amount: "100.00" });

    const results = await Promise.allSettled([settle(finance.id, input), settle(financeB.id, input)]);
    const ok = results.filter(r => r.status === "fulfilled");
    const failed = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const message = failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason);
    expect(message).toMatch(/分成账务已变化|40001|could not serialize|P2034|支付超过当前待支付金额/);

    const rows = await settlementsOf(commission.id);
    expect(rows).toHaveLength(1);
    expect(dec(rows[0].amount)).toBe("100.00");
    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: commission.id } })).revision).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "COMMISSION_PAID", targetId: rows[0].id } })).toBe(1);
  }, 60_000);
});

/* ================================================================== *
 * B · adjustInvoiceTx —— 已开票更正
 * ================================================================== */
const adjustInvoice = (userId: string, input: Record<string, unknown>) =>
  prisma.$transaction(tx => adjustInvoiceTx(tx, userId, input as never), SERIAL);

const ISSUED_AT = new Date("2026-10-01T10:00:00+08:00");

function adjustment(invoiceId: string, documentId: string, overrides: Record<string, unknown> = {}) {
  return {
    invoiceId, kind: "RED", amount: "3000.00", occurredAt: LATER, reference: `红-${uid("R")}`,
    reason: "客户要求红冲部分金额", documentId, reversals: [], ...overrides
  };
}

/** 发票更正的合格执行人：独立财务更正权 + 开票执行权 + 案件经办（文档上传人也是他） */
const INVOICE_GRANTS = [
  { permissionKey: "matters.read", scope: "OWN" },
  { permissionKey: "finance.read", scope: "ALL" },
  { permissionKey: "finance.write", scope: "ALL" },
  { permissionKey: "finance.correct", scope: "ALL" },
  { permissionKey: "invoices.process", scope: "ALL" },
  { permissionKey: "documents.read", scope: "OWN" }
];

async function seedInvoiceCase(options: { amount?: string; status?: "PENDING" | "APPROVED" | "ISSUED" | "REJECTED" } = {}) {
  const { user: actor } = await seedCustomRole(INVOICE_GRANTS);
  const matter = await seedMatter(actor.id);
  const document = await seedDocument(matter.id, actor.id);
  const invoice = await prisma.invoiceRequest.create({
    data: {
      id: uid("inv"), matterId: matter.id, amount: D(options.amount ?? "10000.00"),
      status: options.status ?? "ISSUED", issuedAt: ISSUED_AT, requestedById: actor.id
    }
  });
  return { actor, matter, document, invoice };
}

/** 票款关联：需要一笔同案实收 + InvoicePaymentAllocation（复合外键要求同案） */
async function seedInvoiceLink(matterId: string, invoiceId: string, userId: string, amount: string) {
  const { payment } = await seedReceipt(matterId, userId, amount);
  const link = await prisma.invoicePaymentAllocation.create({
    data: { id: uid("ipa"), matterId, invoiceId, paymentId: payment.id, amount: D(amount), recordedById: userId }
  });
  return { payment, link };
}

const adjustmentsOf = (invoiceId: string) =>
  prisma.invoiceAdjustment.findMany({ where: { invoiceId }, orderBy: { createdAt: "asc" } });

describe("adjustInvoiceTx · 正常路径与票面余额", () => {
  it("红冲 3000：更正行、审计落库；发票本身金额不变（更正只留痕不改票）", async () => {
    const { actor, invoice, document } = await seedInvoiceCase();
    const reference = "红-2026-001";

    const result = await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "3000.00", reference }));
    expect(result).toEqual({ matterId: invoice.matterId });

    const rows = await adjustmentsOf(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "RED", reference, reason: "客户要求红冲部分金额", documentId: document.id,
      recordedById: actor.id, replacementInvoiceId: null
    });
    expect(dec(rows[0].amount)).toBe("3000.00");
    expect(rows[0].occurredAt.toISOString()).toBe(LATER.toISOString());

    const after = await prisma.invoiceRequest.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(dec(after.amount)).toBe("10000.00");
    expect(after.status).toBe("ISSUED");

    const audits = await prisma.auditLog.findMany({ where: { action: "INVOICE_ADJUSTMENT", targetId: invoice.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(actor.id);
    expect(audits[0].detail).toMatchObject({ kind: "RED", amount: "3000.00", reference, documentId: document.id });
  });

  it("同一发票多次红冲：每次按剩余票面校验，净额累计正确", async () => {
    const { actor, invoice, document } = await seedInvoiceCase({ amount: "10000.00" });
    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "3000.00" }));
    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "4000.00" }));

    // 已更正 7000，剩余 3000：再红冲 4000 必须是拒绝
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "4000.00" })))
      .rejects.toThrow("更正超出票面余额，作废或换开须处理全部剩余票面");

    const rows = await adjustmentsOf(invoice.id);
    expect(rows.map(r => dec(r.amount))).toEqual(["3000.00", "4000.00"]);
    const corrected = rows.reduce((s, r) => s.plus(r.amount), D(0));
    expect(corrected.toFixed(2)).toBe("7000.00");
    // 剩余票面 3000 —— 恰好等于剩余额的一次红冲是允许的
    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "3000.00" }));
    expect((await adjustmentsOf(invoice.id)).reduce((s, r) => s.plus(r.amount), D(0)).toFixed(2)).toBe("10000.00");
  });

  it("作废必须处理全部剩余票面：9000 被拒、10000 通过", async () => {
    const { actor, invoice, document } = await seedInvoiceCase({ amount: "10000.00" });
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, { kind: "VOID", amount: "9000.00" })))
      .rejects.toThrow("更正超出票面余额，作废或换开须处理全部剩余票面");
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);

    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { kind: "VOID", amount: "10000.00" }));
    expect((await adjustmentsOf(invoice.id)).map(r => r.kind)).toEqual(["VOID"]);
  });

  it("换开：新票须同案、已开且金额相符；同一新票不能重复作为换开目标", async () => {
    const { actor, matter, invoice, document } = await seedInvoiceCase({ amount: "10000.00" });
    const replacement = await prisma.invoiceRequest.create({
      data: { id: uid("inv"), matterId: matter.id, amount: D("10000.00"), status: "ISSUED", issuedAt: ISSUED_AT, requestedById: actor.id }
    });
    const foreign = await prisma.invoiceRequest.create({
      data: { id: uid("inv"), matterId: matter.id, amount: D("9000.00"), status: "ISSUED", issuedAt: ISSUED_AT, requestedById: actor.id }
    });

    // 金额不符
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      kind: "REPLACE", amount: "10000.00", replacementInvoiceId: foreign.id
    }))).rejects.toThrow("换开发票须同案、已开具且金额相符");
    // 自己换自己
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      kind: "REPLACE", amount: "10000.00", replacementInvoiceId: invoice.id
    }))).rejects.toThrow("请选择另一张本案已开具发票");
    // 非换开却带新票
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      kind: "RED", amount: "1000.00", replacementInvoiceId: replacement.id
    }))).rejects.toThrow("只有换开可以关联新票");

    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      kind: "REPLACE", amount: "10000.00", replacementInvoiceId: replacement.id
    }));
    const rows = await adjustmentsOf(invoice.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "REPLACE", replacementInvoiceId: replacement.id });
    // 新票已被占用：另一张原票再拿它换开必须拒绝（同一新票不能对应两份更正）
    const another = await prisma.invoiceRequest.create({
      data: { id: uid("inv"), matterId: matter.id, amount: D("10000.00"), status: "ISSUED", issuedAt: ISSUED_AT, requestedById: actor.id }
    });
    await expect(adjustInvoice(actor.id, adjustment(another.id, document.id, {
      kind: "REPLACE", amount: "10000.00", replacementInvoiceId: replacement.id
    }))).rejects.toThrow("新票已关联更正，不能重复作为换开目标");
    expect(await prisma.invoiceAdjustment.count({ where: { replacementInvoiceId: replacement.id } })).toBe(1);
  });

  it("票款关联不得被更正后票面穿透：关联 4000、红冲 7000（剩 3000）需先解除", async () => {
    const { actor, matter, invoice, document } = await seedInvoiceCase({ amount: "10000.00" });
    const { link } = await seedInvoiceLink(matter.id, invoice.id, actor.id, "4000.00");

    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "7000.00" })))
      .rejects.toThrow("请先明确解除足额票款关联，不能让关联款超过更正后的票面");

    // 解除 1000 后：关联有效额 3000 = 剩余票面 3000 → 放行
    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      amount: "7000.00", reversals: [{ id: link.id, amount: "1000.00" }]
    }));
    const linkAfter = await prisma.invoicePaymentAllocation.findUniqueOrThrow({ where: { id: link.id } });
    expect(dec(linkAfter.reversedAmount)).toBe("1000.00");
    expect(linkAfter.revision).toBe(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: link.paymentId } })).revision).toBe(1);
  });
});

describe("adjustInvoiceTx · 权限与前置门禁", () => {
  it("内置财务（唯一持有 finance.correct 的内置岗位）被 invoices.process 门禁拦住 —— 记录现状", async () => {
    // scopeFor 只解析 CUSTOM 岗位的 RolePermission 表，内置角色恒为 undefined；
    // 因此这里虽然通过了 finance.correct，仍会停在「还须当前开票执行权限」。
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const document = await seedDocument(matter.id, finance.id);
    const invoice = await prisma.invoiceRequest.create({
      data: { id: uid("inv"), matterId: matter.id, amount: D("10000.00"), status: "ISSUED", issuedAt: ISSUED_AT, requestedById: finance.id }
    });

    await expect(adjustInvoice(finance.id, adjustment(invoice.id, document.id)))
      .rejects.toThrow("更正发票还须当前开票执行权限");
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);
  });

  it("授薪律师（无 finance.correct）→ 独立财务执行权限不足", async () => {
    const { invoice, document } = await seedInvoiceCase();
    const lawyer = await seedUser("LAWYER");
    await expect(adjustInvoice(lawyer.id, adjustment(invoice.id, document.id)))
      .rejects.toThrow("当前岗位没有此项独立财务执行权限");
  });

  it("自定义岗位只有更正确认、没有开票执行 → 仍被拒；invoices.process = OWN 但非本案经办 → 同样被拒", async () => {
    const { invoice, document } = await seedInvoiceCase();
    const { user: noProcess } = await seedCustomRole([
      { permissionKey: "matters.read", scope: "OWN" },
      { permissionKey: "finance.read", scope: "ALL" },
      { permissionKey: "finance.correct", scope: "ALL" }
    ]);
    await expect(adjustInvoice(noProcess.id, adjustment(invoice.id, document.id)))
      .rejects.toThrow("更正发票还须当前开票执行权限");

    const { user: ownOnly } = await seedCustomRole([
      { permissionKey: "matters.read", scope: "OWN" },
      { permissionKey: "finance.read", scope: "ALL" },
      { permissionKey: "finance.correct", scope: "ALL" },
      { permissionKey: "invoices.process", scope: "OWN" }
    ]);
    // ownOnly 不是该案经办（案件归 seedInvoiceCase 的 actor）
    await expect(adjustInvoice(ownOnly.id, adjustment(invoice.id, document.id)))
      .rejects.toThrow("更正发票还须当前开票执行权限");
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);
  });

  it("只有已开具且有案件的发票可更正：PENDING / APPROVED / 无案件发票均被拒", async () => {
    const { actor, invoice, document } = await seedInvoiceCase({ status: "PENDING" });
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id)))
      .rejects.toThrow("仅可更正本案已开具发票");

    const approved = await prisma.invoiceRequest.create({
      data: { id: uid("inv"), matterId: invoice.matterId, amount: D("10000.00"), status: "APPROVED", requestedById: actor.id }
    });
    await expect(adjustInvoice(actor.id, adjustment(approved.id, document.id)))
      .rejects.toThrow("仅可更正本案已开具发票");

    const orphan = await prisma.invoiceRequest.create({
      data: {
        id: uid("inv"), matterId: null, noMatterReason: "咨询服务", amount: D("10000.00"),
        status: "ISSUED", issuedAt: ISSUED_AT, requestedById: actor.id
      }
    });
    await expect(adjustInvoice(actor.id, adjustment(orphan.id, document.id)))
      .rejects.toThrow("仅可更正本案已开具发票");
  });

  it("依据材料门禁：他案材料 / 已删除材料 / 非本人上传且无案件材料权 → 全部拒绝", async () => {
    const { actor, matter, invoice } = await seedInvoiceCase();
    const otherMatter = await seedMatter(actor.id);
    const foreignDoc = await seedDocument(otherMatter.id, actor.id);
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, foreignDoc.id)))
      .rejects.toThrow("外部处理依据须为本案有效文件");

    const deleted = await seedDocument(matter.id, actor.id);
    await prisma.document.update({ where: { id: deleted.id }, data: { deletedAt: LATER } });
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, deleted.id)))
      .rejects.toThrow("外部处理依据须为本案有效文件");

    // 无 documents.read 的岗位：只能引用本人上传的材料
    const byOther = await seedDocument(matter.id, actor.id);
    const { user: noDocs } = await seedCustomRole([
      { permissionKey: "matters.read", scope: "OWN" },
      { permissionKey: "finance.read", scope: "ALL" },
      { permissionKey: "finance.correct", scope: "ALL" },
      { permissionKey: "invoices.process", scope: "ALL" }
    ]);
    await expect(adjustInvoice(noDocs.id, adjustment(invoice.id, byOther.id)))
      .rejects.toThrow("外部处理依据须为本案有效文件");
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);
  });

  it("隔离墙覆盖写路径：被隔离的执行人不能更正该案发票", async () => {
    const { actor, matter, invoice, document } = await seedInvoiceCase();
    const principal = await seedUser("PRINCIPAL_LAWYER");
    await seedWall({ matterId: matter.id, createdById: principal.id, userId: actor.id });

    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id)))
      .rejects.toThrow("案件不存在或无权处理");
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);
  });

  it("日期门禁：更正日早于开票日 → 拒绝；未来日期 → ActionError", async () => {
    const { actor, invoice, document } = await seedInvoiceCase();
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, { occurredAt: new Date("2026-09-01T10:00:00+08:00") })))
      .rejects.toThrow("更正不能早于原开票日期");
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, { occurredAt: new Date("2099-01-01T00:00:00+08:00") })))
      .rejects.toBeInstanceOf(ActionError);
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);
  });

  it("解除关联的门禁：重复 id、他票关联、超过有效关联额 → 全部拒绝", async () => {
    const { actor, matter, invoice, document } = await seedInvoiceCase();
    const { link } = await seedInvoiceLink(matter.id, invoice.id, actor.id, "1000.00");

    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      amount: "2000.00", reversals: [{ id: link.id, amount: "100.00" }, { id: link.id, amount: "200.00" }]
    }))).rejects.toThrow("同一票款关联不能重复解除");

    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      amount: "2000.00", reversals: [{ id: uid("ipa-missing"), amount: "100.00" }]
    }))).rejects.toThrow("解除额超过本票有效关联");

    // 解除额本身超过这张关联的有效额
    await expect(adjustInvoice(actor.id, adjustment(invoice.id, document.id, {
      amount: "2000.00", reversals: [{ id: link.id, amount: "1000.01" }]
    }))).rejects.toThrow("解除额超过本票有效关联");
    expect(await adjustmentsOf(invoice.id)).toHaveLength(0);
    expect(dec((await prisma.invoicePaymentAllocation.findUniqueOrThrow({ where: { id: link.id } })).reversedAmount)).toBe("0.00");
  });
});

describe("adjustInvoiceTx · 幂等与并发", () => {
  it("同一凭据编号重复登记 → 数据库唯一约束拒绝，只留一条更正", async () => {
    const { actor, invoice, document } = await seedInvoiceCase();
    const input = adjustment(invoice.id, document.id, { amount: "1000.00", reference: "红-同号-001" });
    await adjustInvoice(actor.id, input);

    // 2026-11-20（D5 修复后）：改由前置检查拦下，给可读提示。
    // 修复前落到 (invoiceId, reference) 唯一索引 → $executeRaw 被包成 P2010(23505)
    // → mutate 翻译成「账务或授权已变化，请刷新后重试」，对「编号重复」是误导。
    await expect(adjustInvoice(actor.id, input)).rejects.toThrow(/凭据编号「红-同号-001」在本发票下已登记过/);
    expect(await adjustmentsOf(invoice.id)).toHaveLength(1);
  });

  it("换新凭据的相同红冲是一次新更正（非幂等，按外部凭证逐次登记）", async () => {
    const { actor, invoice, document } = await seedInvoiceCase();
    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "1000.00" }));
    await adjustInvoice(actor.id, adjustment(invoice.id, document.id, { amount: "1000.00" }));
    expect((await adjustmentsOf(invoice.id)).map(r => dec(r.amount))).toEqual(["1000.00", "1000.00"]);
  });

  it("两个执行人同时红冲全额：只成交一次，累计更正不超票面", async () => {
    const { actor, matter, invoice, document } = await seedInvoiceCase({ amount: "10000.00" });
    const other = await seedCustomRole(INVOICE_GRANTS);
    // 第二位执行人不是本案经办，且无 documents.read 权限覆盖本案 → 依据材料必须由本人上传，
    // 否则会先被「外部处理依据须为本案有效文件」拦下，测不到票面竞争。
    const otherDoc = await seedDocument(matter.id, other.user.id);

    const input = adjustment(invoice.id, document.id, { kind: "VOID", amount: "10000.00" });
    const results = await Promise.allSettled([
      adjustInvoice(actor.id, input),
      adjustInvoice(other.user.id, { ...input, documentId: otherDoc.id, reference: `红-${uid("R")}` })
    ]);
    const ok = results.filter(r => r.status === "fulfilled");
    const failed = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const message = failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason);
    expect(message).toMatch(/更正超出票面余额|40001|could not serialize|P2034/);

    const rows = await adjustmentsOf(invoice.id);
    expect(rows).toHaveLength(1);
    expect(dec(rows[0].amount)).toBe("10000.00");
    expect(await prisma.auditLog.count({ where: { action: "INVOICE_ADJUSTMENT", targetId: invoice.id } })).toBe(1);
  }, 60_000);
});

/* ================================================================== *
 * C · draftAmendmentTx —— 收费变更草稿（+ 激活 / 作废对照）
 * ================================================================== */
const draft = (userId: string, input: Record<string, unknown>) =>
  prisma.$transaction(tx => draftAmendmentTx(tx, userId, input as never), SERIAL);
const activate = (userId: string, id: string, revision: number) =>
  prisma.$transaction(tx => activateAmendmentTx(tx, userId, id, revision), SERIAL);
const cancel = (userId: string, id: string, revision: number) =>
  prisma.$transaction(tx => cancelAmendmentTx(tx, userId, id, revision), SERIAL);

const SOURCE_SIGNED = new Date("2026-09-01T10:00:00+08:00");

async function seedContract(options: {
  amount?: string; status?: "ACTIVE" | "DRAFT" | "CLOSED"; signedAt?: Date | null;
  amendmentType?: "ORIGINAL" | "TERMINATION"; ownerId?: string;
} = {}) {
  const finance = await seedUser("FINANCE");
  const ownerId = options.ownerId ?? finance.id;
  const matter = await seedMatter(ownerId);
  const document = await seedDocument(matter.id, ownerId);
  const procedure = await seedProcedure(matter.id);
  const source = await prisma.billing.create({
    data: {
      id: uid("b"), matterId: matter.id, title: "一审代理费",
      contractAmount: D(options.amount ?? "10000.00"),
      status: (options.status ?? "ACTIVE") as never,
      signedAt: options.signedAt === undefined ? SOURCE_SIGNED : options.signedAt,
      moneyKind: "LAWYER_FEE",
      amendmentType: (options.amendmentType ?? "ORIGINAL") as never
    }
  });
  return { finance, matter, document, procedure, source };
}

function terms(sourceId: string, documentId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceBillingId: sourceId, sourceRevision: 0, title: "补充协议：追加二审代理费",
    type: "ADDITION", amount: "2000.00", signedAt: SIGNED, effectiveAt: EFFECTIVE,
    reason: "二审阶段追加代理", completedWork: "", handoverWork: "",
    documentIds: [documentId], scopes: [],
    installments: [{ title: "追加款", amount: "2000.00", dueState: "UNKNOWN" }],
    reductions: [], ...overrides
  };
}

const billingsOf = (matterId: string) => prisma.billing.findMany({ where: { matterId }, orderBy: { createdAt: "asc" } });

describe("draftAmendmentTx · 正常路径（草稿只留痕，不动账）", () => {
  it("追加费用草稿：草稿行/前值/结果值/依据附件/审计正确，原合同与账目全部不变", async () => {
    const { finance, matter, document, source } = await seedContract({ amount: "10000.00" });

    const created = await draft(finance.id, terms(source.id, document.id));
    expect(created).toEqual({ id: expect.any(String), matterId: matter.id });

    const row = await prisma.billing.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({
      matterId: matter.id, status: "DRAFT", amendmentType: "ADDITION", sourceBillingId: source.id,
      signedAt: null, effectiveAt: null, moneyKind: "LAWYER_FEE", revision: 0
    });
    // contractAmount 记录的是「本次变更额」，previousAmount/resultingAmount 记录前后口径
    expect(dec(row.contractAmount)).toBe("2000.00");
    expect(dec(row.previousAmount)).toBe("10000.00");
    expect(dec(row.resultingAmount)).toBe("12000.00");
    expect(row.draftTerms).toMatchObject({ type: "ADDITION", amount: "2000.00", sourceBillingId: source.id });

    const attachments = await prisma.billingAttachment.findMany({ where: { billingId: created.id } });
    expect(attachments.map(a => a.documentId)).toEqual([document.id]);

    // 原合同一个字都没改
    const sourceAfter = await prisma.billing.findUniqueOrThrow({ where: { id: source.id } });
    expect(sourceAfter).toMatchObject({ status: "ACTIVE", revision: 0, resultingAmount: null });
    expect(dec(sourceAfter.contractAmount)).toBe("10000.00");

    // 草稿不生效：不生成应收、不生成更正
    expect(await prisma.receivable.count({ where: { matterId: matter.id } })).toBe(0);
    expect(await prisma.financeCorrection.count({ where: { matterId: matter.id } })).toBe(0);

    const audits = await prisma.auditLog.findMany({ where: { action: "BILLING_AMENDMENT_DRAFT", targetId: created.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(finance.id);
    expect(audits[0].detail).toMatchObject({
      matterId: matter.id, sourceBillingId: source.id, type: "ADDITION",
      previousAmount: "10000.00", resultingAmount: "12000.00"
    });
  });

  it("调减费用草稿：同样不产生更正与应收调整（真正的账要等激活）", async () => {
    const { finance, matter, document, source } = await seedContract({ amount: "10000.00" });
    const receivable = await prisma.receivable.create({
      data: {
        id: uid("ar"), matterId: matter.id, billingId: source.id, title: "一审代理费",
        amount: D("10000.00"), moneyKind: "LAWYER_FEE"
      }
    });

    const created = await draft(finance.id, terms(source.id, document.id, {
      type: "REDUCTION", amount: "2000.00", installments: [],
      reductions: [{ receivableId: receivable.id, revision: 0, amount: "2000.00", allocationReversals: [] }]
    }));

    const row = await prisma.billing.findUniqueOrThrow({ where: { id: created.id } });
    expect(dec(row.resultingAmount)).toBe("8000.00");
    expect(dec(row.previousAmount)).toBe("10000.00");
    expect(await prisma.financeCorrection.count({ where: { matterId: matter.id } })).toBe(0);
    const arAfter = await prisma.receivable.findUniqueOrThrow({ where: { id: receivable.id } });
    expect(dec(arAfter.adjustmentAmount)).toBe("0.00");
    expect(arAfter.revision).toBe(0);
  });
});

describe("draftAmendmentTx · 权限与前置门禁", () => {
  it("局外律师 → 「案件不存在或无权处理」；未关联的财务 → 「须由本案经办登记」", async () => {
    const outsiderOwner = await seedUser("LAWYER");
    const { matter, document, source } = await seedContract({ ownerId: outsiderOwner.id });
    const outsider = await seedUser("LAWYER");
    await expect(draft(outsider.id, terms(source.id, document.id))).rejects.toThrow("案件不存在或无权处理");

    // 内置财务跳过成员校验，但起草仍要求本案经办（不能凭全所财务权限枚举案件材料）
    const finance = await seedUser("FINANCE");
    await expect(draft(finance.id, terms(source.id, document.id))).rejects.toThrow("合同变更须由本案经办登记");
    expect(await billingsOf(matter.id)).toHaveLength(1);
  });

  it("自定义岗位无 finance.write → 岗位权限不足；有 finance.write 但无 documents.read → 依据材料权限不足", async () => {
    const owner = await seedUser("FINANCE");
    const { document, source } = await seedContract({ ownerId: owner.id });

    const { user: noWrite } = await seedCustomRole([{ permissionKey: "matters.read", scope: "OWN" }]);
    await expect(draft(noWrite.id, terms(source.id, document.id))).rejects.toThrow("当前岗位没有此项财务权限");

    // 本案经办 + finance.write，但没有 documents.read：不能枚举案件材料
    const ownerMatter = await seedMatter(owner.id);
    const ownerDoc = await seedDocument(ownerMatter.id, owner.id);
    const ownerSource = await prisma.billing.create({
      data: {
        id: uid("b"), matterId: ownerMatter.id, title: "一审代理费", contractAmount: D("10000.00"),
        status: "ACTIVE", signedAt: SOURCE_SIGNED, moneyKind: "LAWYER_FEE", amendmentType: "ORIGINAL"
      }
    });
    const { user: noDocs } = await seedCustomRole([
      { permissionKey: "matters.read", scope: "ALL" },
      { permissionKey: "finance.write", scope: "ALL" },
      { permissionKey: "finance.read", scope: "ALL" }
    ]);
    await prisma.matter.update({ where: { id: ownerMatter.id }, data: { ownerId: noDocs.id } });
    await expect(draft(noDocs.id, terms(ownerSource.id, ownerDoc.id)))
      .rejects.toThrow("当前岗位无权查阅合同依据材料");
  });

  it("账号停用 / 归档案件 → 各自门禁文案", async () => {
    const { finance, matter, document, source } = await seedContract();
    const disabled = await seedUser("FINANCE", { active: false });
    await expect(draft(disabled.id, terms(source.id, document.id))).rejects.toThrow("账号已停用或不存在");

    await prisma.matter.update({ where: { id: matter.id }, data: { status: "ARCHIVED" } });
    await expect(draft(finance.id, terms(source.id, document.id)))
      .rejects.toThrow("归档后不得新增或变更委托，请建立有关联的新案件");
    expect(await prisma.billing.count({ where: { matterId: matter.id } })).toBe(1);
  });

  it("原版本不合格：revision 过期 / 未签署 / 已关闭 / 已终止 / 已有生效子版本 → 全部拒绝", async () => {
    const stale = await seedContract();
    await expect(draft(stale.finance.id, terms(stale.source.id, stale.document.id, { sourceRevision: 1 })))
      .rejects.toThrow("原收费版本已变化、未生效或已终止，请刷新");

    const unsigned = await seedContract({ status: "DRAFT", signedAt: null });
    await expect(draft(unsigned.finance.id, terms(unsigned.source.id, unsigned.document.id)))
      .rejects.toThrow("原收费版本已变化、未生效或已终止，请刷新");

    const closed = await seedContract({ status: "CLOSED" });
    await expect(draft(closed.finance.id, terms(closed.source.id, closed.document.id)))
      .rejects.toThrow("原收费版本已变化、未生效或已终止，请刷新");

    const terminated = await seedContract({ amendmentType: "TERMINATION" });
    await expect(draft(terminated.finance.id, terms(terminated.source.id, terminated.document.id)))
      .rejects.toThrow("原收费版本已变化、未生效或已终止，请刷新");

    const chained = await seedContract();
    await prisma.billing.create({
      data: {
        id: uid("b"), matterId: chained.matter.id, title: "已生效变更", contractAmount: D("500.00"),
        status: "ACTIVE", signedAt: SOURCE_SIGNED, moneyKind: "LAWYER_FEE",
        amendmentType: "ADDITION", sourceBillingId: chained.source.id
      }
    });
    await expect(draft(chained.finance.id, terms(chained.source.id, chained.document.id)))
      .rejects.toThrow("该版本已有生效变更，请选择当前末版");
  });

  it("依据材料与代理范围必须属于本案：他案材料 / 已删除材料 / 他案程序", async () => {
    const { finance, document, source } = await seedContract();
    const otherMatter = await seedMatter(finance.id);
    const foreignDoc = await seedDocument(otherMatter.id, finance.id);
    const foreignProcedure = await seedProcedure(otherMatter.id);

    await expect(draft(finance.id, terms(source.id, foreignDoc.id)))
      .rejects.toThrow("变更依据必须是本案有效材料");

    const deleted = await seedDocument(source.matterId, finance.id);
    await prisma.document.update({ where: { id: deleted.id }, data: { deletedAt: LATER } });
    await expect(draft(finance.id, terms(source.id, deleted.id)))
      .rejects.toThrow("变更依据必须是本案有效材料");

    await expect(draft(finance.id, terms(source.id, document.id, {
      scopes: [{ procedureId: foreignProcedure.id, state: "COVERED", note: "覆盖二审" }]
    }))).rejects.toThrow("代理范围不得关联其他案件程序");

    await expect(draft(finance.id, terms(source.id, uid("doc-missing"))))
      .rejects.toThrow("变更依据必须是本案有效材料");
  });

  it("金额口径：分期合计 / 调减合计 / 超过合同额 / 仅范围变更带金额 → 各自拒绝", async () => {
    const { finance, document, source } = await seedContract({ amount: "10000.00" });

    await expect(draft(finance.id, terms(source.id, document.id, {
      installments: [{ title: "追加款", amount: "1500.00", dueState: "UNKNOWN" }]
    }))).rejects.toThrow("新增分期或调减应收合计必须等于合同变动差额");

    await expect(draft(finance.id, terms(source.id, document.id, {
      type: "REDUCTION", amount: "2000.00", installments: [],
      reductions: [{ receivableId: uid("ar"), revision: 0, amount: "1500.00", allocationReversals: [] }]
    }))).rejects.toThrow("新增分期或调减应收合计必须等于合同变动差额");

    await expect(draft(finance.id, terms(source.id, document.id, {
      type: "REDUCTION", amount: "20000.00", installments: [],
      reductions: [{ receivableId: uid("ar"), revision: 0, amount: "20000.00", allocationReversals: [] }]
    }))).rejects.toThrow("调减不能超过当前合同总额");

    await expect(draft(finance.id, terms(source.id, document.id, { type: "SCOPE_ONLY", amount: "1000.00" })))
      .rejects.toThrow("仅范围变更的变动金额必须为零");

    expect(await prisma.billing.count({ where: { sourceBillingId: source.id } })).toBe(0);
  });

  it("输入校验：缺依据材料 / 生效日早于签署日 / 终止结算缺项 → ActionError", async () => {
    const { finance, document, source } = await seedContract();
    await expect(draft(finance.id, terms(source.id, document.id, { documentIds: [] }))).rejects.toBeInstanceOf(ActionError);
    await expect(draft(finance.id, terms(source.id, document.id, {
      effectiveAt: new Date("2026-11-01T00:00:00+08:00")
    }))).rejects.toBeInstanceOf(ActionError);
    await expect(draft(finance.id, terms(source.id, document.id, {
      type: "TERMINATION", amount: "10000.00", installments: [], endsAt: new Date("2026-12-31T00:00:00+08:00")
    }))).rejects.toBeInstanceOf(ActionError); // 缺 completedWork / handoverWork
  });

  // 缺陷记录：contractTermsInput.reason 为 min(1) 必填，`if(TERMINATION && result===0 && !reason)`
  // 这条「零收费终止必须说明依据」永远不可达 —— reason 为空时 schema 已先拒绝。
  it.skip("零收费终止未填依据 → 「零收费终止必须说明依据」（源码分支不可达）", () => {});
});

describe("draftAmendmentTx · 草稿 → 激活 / 作废（账目时点）", () => {
  it("激活才改账：追加费用激活后生成应收、合同转 ACTIVE、双方 revision 递增、审计留痕", async () => {
    const { finance, matter, document, source } = await seedContract({ amount: "10000.00" });
    await seedMatterReview(finance.id, matter.id); // ADDITION 激活前须通过动态冲突复核

    const created = await draft(finance.id, terms(source.id, document.id));
    expect(await prisma.receivable.count({ where: { matterId: matter.id } })).toBe(0);

    await activate(finance.id, created.id, 0);

    const activated = await prisma.billing.findUniqueOrThrow({ where: { id: created.id } });
    expect(activated.status).toBe("ACTIVE");
    expect(activated.revision).toBe(1);
    expect(activated.signedAt?.toISOString()).toBe(SIGNED.toISOString());
    expect(activated.effectiveAt?.toISOString()).toBe(EFFECTIVE.toISOString());
    expect((await prisma.billing.findUniqueOrThrow({ where: { id: source.id } })).revision).toBe(1);

    const ars = await prisma.receivable.findMany({ where: { billingId: created.id } });
    expect(ars).toHaveLength(1);
    expect(dec(ars[0].amount)).toBe("2000.00");
    expect(ars[0].matterId).toBe(matter.id);
    expect(ars[0].moneyKind).toBe("LAWYER_FEE");
    expect(ars[0].sourceKey).toBe(`billing:${created.id}:1`);

    const audits = await prisma.auditLog.findMany({ where: { action: "BILLING_AMENDMENT_ACTIVATE", targetId: created.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].detail).toMatchObject({ type: "ADDITION", delta: "2000.00", resultingAmount: "12000.00" });
  });

  it("调减激活才落账：激活生成已确认折让更正，应收有效额下调", async () => {
    const { finance, matter, document, source } = await seedContract({ amount: "10000.00" });
    const receivable = await prisma.receivable.create({
      data: {
        id: uid("ar"), matterId: matter.id, billingId: source.id, title: "一审代理费",
        amount: D("10000.00"), moneyKind: "LAWYER_FEE"
      }
    });

    const created = await draft(finance.id, terms(source.id, document.id, {
      type: "REDUCTION", amount: "2000.00", installments: [],
      reductions: [{ receivableId: receivable.id, revision: 0, amount: "2000.00", allocationReversals: [] }]
    }));
    expect(dec((await prisma.receivable.findUniqueOrThrow({ where: { id: receivable.id } })).adjustmentAmount)).toBe("0.00");

    await activate(finance.id, created.id, 0);

    const arAfter = await prisma.receivable.findUniqueOrThrow({ where: { id: receivable.id } });
    expect(dec(arAfter.adjustmentAmount)).toBe("-2000.00");
    expect(arAfter.revision).toBe(1);
    expect(arAfter.status).toBe("OPEN");

    const correction = await prisma.financeCorrection.findFirstOrThrow({ where: { sourceBillingId: created.id } });
    expect(correction).toMatchObject({ status: "CONFIRMED", type: "DISCOUNT", targetType: "Receivable" });
    expect(dec(correction.amount)).toBe("2000.00");
    expect(correction.confirmedById).toBe(finance.id);
  });

  it("作废草稿：状态 CLOSED、revision 递增、账目零变化；作废后不可再激活", async () => {
    const { finance, matter, document, source } = await seedContract();
    await seedMatterReview(finance.id, matter.id);
    const created = await draft(finance.id, terms(source.id, document.id));

    await cancel(finance.id, created.id, 0);
    const closed = await prisma.billing.findUniqueOrThrow({ where: { id: created.id } });
    expect(closed.status).toBe("CLOSED");
    expect(closed.revision).toBe(1);
    expect(await prisma.receivable.count({ where: { matterId: matter.id } })).toBe(0);
    expect((await prisma.billing.findUniqueOrThrow({ where: { id: source.id } })).revision).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "BILLING_AMENDMENT_CANCEL", targetId: created.id } })).toBe(1);

    await expect(activate(finance.id, created.id, 1)).rejects.toThrow("变更已处理或不属于补充协议草稿");
    await expect(cancel(finance.id, created.id, 1)).rejects.toThrow("只可作废尚未生效且未变化的补充协议草稿");
  });

  it("重复起草不会重复生效：首份激活后旧 revision 起草被拒，刷新 revision 后仍被末版门禁挡住", async () => {
    const { finance, matter, document, source } = await seedContract();
    await seedMatterReview(finance.id, matter.id);
    const first = await draft(finance.id, terms(source.id, document.id));
    await activate(finance.id, first.id, 0);

    // ① 仍带旧 revision 的第二份草稿：起草阶段就被乐观锁拦下
    await expect(draft(finance.id, terms(source.id, document.id)))
      .rejects.toThrow("原收费版本已变化、未生效或已终止，请刷新");
    // ② 刷新到最新 revision 后仍不能起草：原版本已有生效变更，必须选末版
    await expect(draft(finance.id, terms(source.id, document.id, { sourceRevision: 1 })))
      .rejects.toThrow("该版本已有生效变更，请选择当前末版");
    // 生效的补充协议始终只有一份
    expect(await prisma.billing.count({ where: { sourceBillingId: source.id } })).toBe(1);
    expect(await prisma.receivable.count({ where: { matterId: matter.id } })).toBe(1);
  });

  it("激活前置：revision 过期 / 未到生效日 / 未到终止日 / 未复核 → 各自拒绝", async () => {
    const { finance, matter, document, source } = await seedContract();
    const stale = await draft(finance.id, terms(source.id, document.id));
    await expect(activate(finance.id, stale.id, 5)).rejects.toThrow("变更已处理或不属于补充协议草稿");

    const future = await draft(finance.id, terms(source.id, document.id, {
      title: "未来生效补充协议", effectiveAt: new Date("2026-12-01T00:00:00+08:00")
    }));
    await expect(activate(finance.id, future.id, 0)).rejects.toThrow("尚未到约定生效日期，可保留草稿到期后确认");

    const termination = await draft(finance.id, terms(source.id, document.id, {
      type: "TERMINATION", amount: "10000.00", installments: [], title: "终止结算",
      endsAt: new Date("2026-12-31T00:00:00+08:00"), completedWork: "一审已结", handoverWork: "无"
    }));
    await expect(activate(finance.id, termination.id, 0)).rejects.toThrow("尚未到终止日期");

    // 尚未复核：ADDITION 必须通过动态冲突复核
    const unreviewed = await draft(finance.id, terms(source.id, document.id, { title: "未复核追加" }));
    await expect(activate(finance.id, unreviewed.id, 0))
      .rejects.toThrow("主体或代理范围已变化，请先在案件中完成动态冲突复核");
    expect(await prisma.receivable.count({ where: { matterId: matter.id } })).toBe(0);
  });
});
