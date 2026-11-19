// @vitest-environment node
/**
 * getFinanceLedger（财务台账读取入口）的真库测试。
 *
 * 它比其他两个目标函数多一层：不是在事务里被调用，而是自己 `requireSession("finance.read")`
 * 再开 `RepeatableRead` 事务。因此这里 mock 掉 `@/lib/auth/session`（可变 session 切身份，
 * 与 business-chain-e2e 同一手法），而 `@/lib/prisma` **不 mock**——`process.env.DATABASE_URL`
 * 在单例初始化前（vi.hoisted）改指临时库，读到的就是真库真 SQL。
 *
 * 覆盖：
 *   1. 返回结构（键、金额固定两位小数字符串、总计口径）
 *   2. 权限过滤（财务岗全所口径 / 律师仅经办 / 自定义岗位无 finance.read 为空）
 *   3. 指定 matterId（单案读数 + 无权时抛业务错误）
 *   4. 待确认实收清单（只含 PENDING，含登记人姓名）
 *   5. 来源不一致时拒绝生成汇总（金额防线）
 *
 * 隔离：临时库 `lawlink_finread_test_*`（lawlink-db:55432）→ `prisma migrate deploy`
 * → 结束 `DROP DATABASE … WITH (FORCE)`。**绝不写主库 lawlink。**
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_finread_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url, original, session: { user: {} } as { user: Record<string, unknown> } };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => HOLDER.session),
  getSession: vi.fn(async () => HOLDER.session),
  requireSystemAdmin: vi.fn(async () => HOLDER.session)
}));

import { prisma } from "@/lib/prisma";
import { getFinanceLedger } from "@/server/finance/ledger-actions";

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let admin: PrismaClient;

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  // 并发 CREATE DATABASE 会撞模板库占用（「source database is being accessed by
  // other users」），表现为「重跑就过」的偶发红。这里退避重试；
  // 与 src/tests/helpers/temp-db.ts 同一处理（那 19 个文件已迁到 helper）。
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (/already exists/i.test(String(err))) { lastErr = undefined; break; }
      if (!/being accessed by other users|template/i.test(String(err))) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (lastErr) throw new Error(`临时库创建失败，需先启动 lawlink-db：${String(lastErr)}`);
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: HOLDER.url },
    stdio: "pipe"
  });
  console.info(`[finance-ledger-read] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[finance-ledger-read] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const OCCURRED = new Date("2026-11-01T10:00:00+08:00");

type Actor = { id: string; name: string; role: string; rolePermissions?: { permissionKey: string; scope: string }[]; managerAuthorized?: boolean };

/** 切换当前会话身份（mock 的 requireSession 返回它） */
function as(actor: Actor) {
  HOLDER.session = {
    user: {
      id: actor.id, name: actor.name, role: actor.role, systemRole: null,
      rolePermissions: actor.rolePermissions, managerAuthorized: actor.managerAuthorized ?? false
    }
  };
}

async function seedUser(role: "FINANCE" | "LAWYER" | "CUSTOM", roleDefinitionId?: string) {
  return prisma.user.create({
    data: { id: uid("u"), name: `台账${role}`, email: `${uid("mail")}@example.test`, passwordHash: "x", role, roleDefinitionId: roleDefinitionId ?? null }
  });
}

async function seedMatter(ownerId: string, title: string) {
  const client = await prisma.client.create({ data: { id: uid("c"), name: `台账当事人${uid("N")}`, type: "INDIVIDUAL" } });
  return prisma.matter.create({
    data: { id: uid("m"), internalCode: uid("MS"), title, ownerId, primaryClientId: client.id }
  });
}

/** 一笔已确认实收（FeeEntry + Payment），可指定是否真的确认，用来制造「来源不一致」 */
async function seedReceipt(matterId: string, userId: string, amount: string, confirmed = true) {
  const entry = await prisma.feeEntry.create({
    data: {
      id: uid("fe"), matterId, type: "RECEIVED", amount: D(amount), moneyKind: "LAWYER_FEE", occurredAt: OCCURRED,
      recordedById: userId, confirmState: confirmed ? "CONFIRMED" : "PENDING",
      confirmedById: confirmed ? userId : null, confirmedAt: confirmed ? OCCURRED : null
    }
  });
  const payment = await prisma.payment.create({
    data: { id: uid("p"), matterId, feeEntryId: entry.id, amount: D(amount), moneyKind: "LAWYER_FEE", occurredAt: OCCURRED, recordedById: userId }
  });
  return { entry, payment };
}

describe("getFinanceLedger · 结构与金额口径（真库）", () => {
  let finance: Awaited<ReturnType<typeof seedUser>>;
  let lawyerA: Awaited<ReturnType<typeof seedUser>>;
  let lawyerB: Awaited<ReturnType<typeof seedUser>>;
  let matterA: Awaited<ReturnType<typeof seedMatter>>;
  let matterB: Awaited<ReturnType<typeof seedMatter>>;
  let receivableId: string;
  let pendingId: string;
  let paymentId: string;

  beforeAll(async () => {
    finance = await seedUser("FINANCE");
    lawyerA = await seedUser("LAWYER");
    lawyerB = await seedUser("LAWYER");
    matterA = await seedMatter(lawyerA.id, "台账测试案件A");
    matterB = await seedMatter(lawyerB.id, "台账测试案件B");

    // 案件 A：已签署合同 + 应收 6000（已核销 2000）+ 已确认实收 2000 + 发票 3000（已关联 1000）
    await prisma.billing.create({
      data: {
        id: uid("b"), matterId: matterA.id, title: "一审代理费", contractAmount: D("10000.00"),
        status: "ACTIVE", signedAt: OCCURRED, revision: 1, moneyKind: "LAWYER_FEE", amendmentType: "ORIGINAL"
      }
    });
    const ar = await prisma.receivable.create({
      data: {
        id: uid("ar"), matterId: matterA.id, title: "第一期", amount: D("6000.00"), settledAmount: D("2000.00"),
        moneyKind: "LAWYER_FEE", status: "OPEN"
      }
    });
    receivableId = ar.id;
    const { entry, payment } = await seedReceipt(matterA.id, finance.id, "2000.00");
    paymentId = payment.id;
    await prisma.allocation.create({
      data: { id: uid("al"), paymentId: payment.id, receivableId: ar.id, amount: D("2000.00"), allocatedById: finance.id }
    });
    await prisma.payment.update({ where: { id: payment.id }, data: { allocatedAmount: D("2000.00"), status: "FULLY_ALLOCATED" } });
    const invoice = await prisma.invoiceRequest.create({
      data: { id: uid("inv"), matterId: matterA.id, amount: D("3000.00"), status: "ISSUED", invoiceNo: "INV-0001", requestedById: lawyerA.id }
    });
    await prisma.invoicePaymentAllocation.create({
      data: { id: uid("ipa"), matterId: matterA.id, invoiceId: invoice.id, paymentId: payment.id, amount: D("1000.00"), recordedById: finance.id }
    });
    // 待确认实收（不进汇总，只进待办清单）
    const pending = await prisma.feeEntry.create({
      data: {
        id: uid("fe-pending"), matterId: matterA.id, type: "RECEIVED", amount: D("500.00"), moneyKind: "LAWYER_FEE",
        occurredAt: OCCURRED, recordedById: lawyerA.id, confirmState: "PENDING"
      }
    });
    pendingId = pending.id;
    // 支出
    await prisma.feeEntry.create({
      data: {
        id: uid("fe-cost"), matterId: matterA.id, type: "COST", amount: D("300.00"), moneyKind: "EXPENSE_RECOVERY",
        occurredAt: OCCURRED, recordedById: finance.id, confirmState: "CONFIRMED"
      }
    });
    // 分成计提
    await prisma.feeEntry.create({
      data: {
        id: uid("fe-cm"), matterId: matterA.id, type: "COMMISSION", amount: D("200.00"), moneyKind: "LAWYER_FEE",
        occurredAt: OCCURRED, parentFeeEntryId: entry.id, beneficiaryUserId: lawyerA.id, recordedById: finance.id,
        commissionRateSnapshot: D("10.00"), commissionBaseSnapshot: D("2000.00"), confirmState: "CONFIRMED"
      }
    });

    // 案件 B：草稿合同，无收款
    await prisma.billing.create({
      data: {
        id: uid("b"), matterId: matterB.id, title: "顾问费", contractAmount: D("5000.00"),
        status: "DRAFT", revision: 0, moneyKind: "LAWYER_FEE", amendmentType: "ORIGINAL"
      }
    });
  }, 120_000);

  it("财务岗：按全所口径读到两案，结构与分项金额一致", async () => {
    as(finance);
    const ledger = await getFinanceLedger();

    expect(ledger.ready).toBe(true);
    expect(ledger.currentUserId).toBe(finance.id);
    expect(ledger.matters.map(m => m.id).sort()).toEqual([matterA.id, matterB.id].sort());
    expect(ledger.matters.every(m => m.tailWritable === false)).toBe(true);

    // 合同：金额固定两位小数字符串
    const billings = ledger.billings.filter(b => b.matterId === matterA.id);
    expect(billings).toHaveLength(1);
    expect(billings[0].contractAmount).toBe("10000.00");
    expect(billings[0].status).toBe("ACTIVE");
    expect(billings[0].revision).toBe(1);

    // 应收：outstanding = 6000 − 2000 − 0
    const ar = ledger.receivables.find(r => r.id === receivableId)!;
    expect(ar.amount).toBe("6000.00");
    expect(ar.settledAmount).toBe("2000.00");
    expect(ar.outstanding).toBe("4000.00");
    expect(ar.revision).toBe(0);

    // 实收：来源校验通过（FeeEntry 已确认且金额一致）
    const payment = ledger.payments.find(p => p.id === paymentId)!;
    expect(payment.amount).toBe("2000.00");
    expect(payment.allocatedAmount).toBe("2000.00");
    expect(payment.unallocated).toBe("0.00");

    // 发票：linked 只算有效关联（amount − reversedAmount）
    expect(ledger.invoices.map(i => ({ amount: i.amount, linked: i.linked, outstanding: i.outstanding })))
      .toContainEqual({ amount: "3000.00", linked: "1000.00", outstanding: "2000.00" });

    // 汇总：应收 6000 / 未收 4000 / 净收款 2000
    expect(ledger.summary.receivable).toBe("6000.00");
    expect(ledger.summary.outstanding).toBe("4000.00");
    expect(ledger.summary.netReceived).toBe("2000.00");
    expect(ledger.summary.lawyerFeeReceived).toBe("2000.00");
    expect(ledger.summary.clientFundsReceived).toBe("0.00");

    // 支出与分成（金额同样固定两位）
    expect(ledger.expenses.map(e => ({ amount: e.amount, reversed: e.reversed }))).toContainEqual({ amount: "300.00", reversed: "0.00" });
    const commission = ledger.commissions.find(c => c.amount === "200.00")!;
    expect(commission.accrued).toBe("200.00");
    expect(commission.payable).toBe("200.00");

    // 其余集合存在且可序列化（空数组而非 undefined）
    for (const key of ["corrections", "allocations", "invoiceLinks", "settlements", "documents", "contractDocuments", "procedures", "scopes", "invoiceAdjustments", "pending"] as const) {
      expect(Array.isArray(ledger[key])).toBe(true);
    }
    expect(ledger.allocations).toContainEqual(expect.objectContaining({ amount: "2000.00" }));
    expect(ledger.invoiceLinks).toContainEqual(expect.objectContaining({ amount: "1000.00" }));
  });

  it("待确认实收清单：只含 PENDING，带登记人姓名，不含已确认实收", async () => {
    as(finance);
    const ledger = await getFinanceLedger(matterA.id);
    expect(ledger.pending.map(p => p.id)).toEqual([pendingId]);
    expect(ledger.pending[0].amount).toBe("500.00");
    expect(ledger.pending[0].name).toBe(lawyerA.name);
    expect(ledger.pending[0].matterId).toBe(matterA.id);
    // 已确认的那笔不在待办里
    expect(ledger.pending.some(p => p.amount === "2000.00")).toBe(false);
  });

  it("律师：只读到本人经办案件；指定他人案件时报「案件不存在或无权查看财务」", async () => {
    as(lawyerA);
    const own = await getFinanceLedger();
    expect(own.matters.map(m => m.id)).toEqual([matterA.id]);
    expect(own.receivables.every(r => r.matterId === matterA.id)).toBe(true);
    expect(own.billings.every(b => b.matterId === matterA.id)).toBe(true);

    await expect(getFinanceLedger(matterB.id)).rejects.toThrow("案件不存在或无权查看财务");
  });

  it("指定 matterId：只返回该案的合同与应收", async () => {
    as(finance);
    const ledger = await getFinanceLedger(matterB.id);
    expect(ledger.matters.map(m => m.id)).toEqual([matterB.id]);
    expect(ledger.billings.map(b => b.matterId)).toEqual([matterB.id]);
    expect(ledger.billings[0].contractAmount).toBe("5000.00");
    expect(ledger.billings[0].status).toBe("DRAFT");
    expect(ledger.receivables).toEqual([]);
    expect(ledger.payments).toEqual([]);
  });

  it("自定义岗位未授予 finance.read：清单为空，指定案件直接拒绝", async () => {
    const role = await prisma.roleDefinition.create({
      data: {
        id: uid("role"), name: `台账岗位${uid("R")}`, normalizedName: `台账岗位${uid("R")}`.toLowerCase(),
        permissions: { create: [{ permissionKey: "matters.read", scope: "OWN" }] }
      }
    });
    const custom = await seedUser("CUSTOM", role.id);
    as({ id: custom.id, name: custom.name, role: "CUSTOM", rolePermissions: [{ permissionKey: "matters.read", scope: "OWN" }] });

    const ledger = await getFinanceLedger();
    expect(ledger.matters).toEqual([]);
    expect(ledger.summary.receivable).toBe("0.00");
    await expect(getFinanceLedger(matterA.id)).rejects.toThrow("案件不存在或无权查看财务");
  });

  it("老库尚未升级（ready=false）：返回 ready:false 且不返回任何账目，案件本身仍可见", async () => {
    as(finance);
    // 模拟「未升级」的库形态：新版已删掉的 reviewState 列还在（financeLedgerReady 的核心探针之一）
    await prisma.$executeRawUnsafe(`ALTER TABLE "Payment" ADD COLUMN "reviewState" text`);
    try {
      const ledger = await getFinanceLedger();
      expect(ledger.ready).toBe(false);
      expect(ledger.receivables).toEqual([]);
      expect(ledger.payments).toEqual([]);
      expect(ledger.billings).toEqual([]);
      expect(ledger.pending).toEqual([]);
      expect(ledger.summary.receivable).toBe("0.00");
      // 案件清单不依赖升级标记：财务页仍能列出范围，只是提示尚未启用
      expect(ledger.matters.map(m => m.id).sort()).toEqual([matterA.id, matterB.id].sort());
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Payment" DROP COLUMN "reviewState"`);
    }
  });

  it("实收来源不一致（FeeEntry 未确认）时拒绝生成汇总，而不是给出错误数字", async () => {
    const owner = await seedUser("LAWYER");
    const matterC = await seedMatter(owner.id, "来源不一致案件");
    await seedReceipt(matterC.id, owner.id, "900.00", false); // 未确认却已有 Payment
    as(finance);
    await expect(getFinanceLedger(matterC.id)).rejects.toThrow("实收来源不一致，不能生成财务汇总");
  });
});
