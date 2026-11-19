// @vitest-environment node
/**
 * signBillingTx（收费安排签署）的真库测试。
 *
 * 为什么用真库：这条路径的钱全部在 SQL 里——`SELECT … FOR UPDATE` 的行锁、
 * `UPDATE … revision=revision+1` 的乐观锁、`createInstallments` 用 `$executeRaw`
 * 逐期写应收（带 `moneyKind`/`dueState` 枚举转换）。mock 掉 `$queryRaw/$executeRaw`
 * 只能证明「我 mock 的 SQL 被我断言到了」，证明不了并发下钱有没有被签两次。
 *
 * 覆盖的检查（与源码行序一致）：
 *   1. `billingSignInput.parse` 输入校验
 *   2. `requireFinanceLedger` 升级门禁
 *   3. billing 不存在 →「收费安排不存在」
 *   4. `assertLedgerWrite(…,"finance.write",{allowTail:false})`
 *      （停用账号 / 非本案经办 / 归档后不得新增变更）
 *   5. `SELECT * FROM "Billing" … FOR UPDATE` 行锁（并发签署只成交一次）
 *   6. `sourceBillingId` →「补充协议须从合同变更入口确认生效」
 *   7. `revision/status/signedAt` →「收费安排已签署或发生变化，请刷新」
 *   8. 分期合计 = 合同额（`billingRegistrationInput.parse` 二次校验）
 *   9. `assertMatterReviewCurrent` 动态冲突复核门禁
 *  10. 正常签署：状态/签署日/revision/应收明细/审计
 *
 * 隔离：每次运行建独立临时库 `lawlink_finsign_test_*`（lawlink-db:55432），只跑
 * `prisma migrate deploy` 建结构，结束 DROP。**绝不写主库 lawlink。**
 * `process.env.DATABASE_URL` 在 @/lib/prisma 单例初始化前（vi.hoisted）改指临时库，
 * 这样即使被测代码某处误用单例，也只可能落到临时库。
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";
import { ActionError } from "@/lib/action-error";

// 必须在 import @/lib/prisma 之前落盘（vi.hoisted 先于 import 执行）
const NAME = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

import { signBillingTx } from "@/server/finance/ledger-registration";
import { recordMatterReviewTx } from "@/server/conflicts/matter-review";

/** 主连接：与生产一样走事务 */
let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
/** 旁路连接：只用于并发用例（另一个会话），不参与断言主路径 */
let side: PrismaClient;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  side = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  console.info(`[finance-ledger-sign] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

/* ------------------------------------------------------------------ *
 * 夹具：每条用例自建客户/案件/用户/合同，不共用数据
 * ------------------------------------------------------------------ */
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

type Role = "FINANCE" | "LAWYER";

async function seedUser(role: Role = "FINANCE", active = true) {
  return prisma.user.create({
    data: { id: uid("u"), name: `签署测试${role}`, email: `${uid("mail")}@example.test`, passwordHash: "x", role, active }
  });
}

/** 客户名逐条唯一：动态冲突复核会重跑检索，同名会被判成新命中 */
async function seedClient() {
  return prisma.client.create({ data: { id: uid("c"), name: `签署当事人${uid("N")}`, type: "INDIVIDUAL" } });
}

async function seedMatter(ownerId: string, options: { status?: "IN_PROGRESS" | "ARCHIVED"; withClient?: boolean } = {}) {
  const client = options.withClient === false ? null : await seedClient();
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("MS"), title: "签署测试案件", ownerId,
      primaryClientId: client?.id ?? null, status: options.status ?? "IN_PROGRESS"
    }
  });
}

async function seedBilling(
  matterId: string,
  options: { amount?: string; status?: "DRAFT" | "ACTIVE" | "CLOSED"; signedAt?: Date | null; revision?: number; sourceBillingId?: string | null } = {}
) {
  return prisma.billing.create({
    data: {
      id: uid("b"), matterId, title: "一审代理费",
      contractAmount: new Prisma.Decimal(options.amount ?? "10000.00"),
      status: options.status ?? "DRAFT",
      signedAt: options.signedAt ?? null,
      revision: options.revision ?? 0,
      moneyKind: "LAWYER_FEE",
      amendmentType: options.sourceBillingId ? "ADDITION" : "ORIGINAL",
      sourceBillingId: options.sourceBillingId ?? null
    }
  });
}

/** 通过生产入口（recordMatterReviewTx）落一次复核：未命中自动 DIFFERENT + 主体指纹 */
async function seedMatterReview(userId: string, matterId: string) {
  return prisma.$transaction(tx => recordMatterReviewTx(tx, userId, matterId), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable
  });
}

const signedAt = new Date("2026-11-10T10:00:00+08:00");
const installment = (amount: string, extra: Record<string, unknown> = {}) => ({
  title: "第一期", amount, dueState: "UNKNOWN" as const, ...extra
});

/** 与 signBilling 同一入口形状：事务内调用（Serializable 由调用方给） */
function sign(userId: string, input: Parameters<typeof signBillingTx>[2]) {
  return prisma.$transaction(tx => signBillingTx(tx, userId, input), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 20_000
  });
}

const readBilling = (id: string) => prisma.billing.findUniqueOrThrow({ where: { id } });
const receivablesOf = (billingId: string) =>
  prisma.receivable.findMany({ where: { billingId }, orderBy: { installmentNumber: "asc" } });
const signAudits = (billingId: string) =>
  prisma.auditLog.findMany({ where: { action: "BILLING_SIGN", targetId: billingId } });

/** 一条「已过全部前置门禁、只差签署」的夹具：财务岗 + 在办案件 + 草稿合同 + 已复核 */
async function seedSignable(options: { amount?: string } = {}) {
  const finance = await seedUser("FINANCE");
  const matter = await seedMatter(finance.id);
  const billing = await seedBilling(matter.id, { amount: options.amount ?? "10000.00" });
  await seedMatterReview(finance.id, matter.id);
  return { finance, matter, billing };
}

describe("signBillingTx · 输入与前置门禁（真库）", () => {
  it("billingSignInput 校验失败时抛 ActionError（用户可读中文，不再是含英文结构的 ZodError），且不触碰数据库", async () => {
    const finance = await seedUser("FINANCE");
    const before = await prisma.billing.count();
    // 缺 signedAt
    await expect(
      sign(finance.id, { id: "b-not-exist", revision: 0, installments: [] } as never)
    ).rejects.toBeInstanceOf(ActionError);
    // revision 为负
    await expect(
      sign(finance.id, { id: "b-not-exist", revision: -1, signedAt, installments: [] } as never)
    ).rejects.toBeInstanceOf(ActionError);
    expect(await prisma.billing.count()).toBe(before);
  });

  it("收费安排不存在 → ActionError「收费安排不存在」", async () => {
    const finance = await seedUser("FINANCE");
    await expect(
      sign(finance.id, { id: uid("b-missing"), revision: 0, signedAt, installments: [installment("1.00")] })
    ).rejects.toThrow("收费安排不存在");
  });

  it("老库未完成财务升级（Payment.reviewState 仍存在）→ 升级门禁先拦下", async () => {
    const { finance, billing } = await seedSignable({ amount: "100.00" });
    // 模拟「未升级」的库形态：新版已删掉的 reviewState 列还在
    await side.$executeRawUnsafe(`ALTER TABLE "Payment" ADD COLUMN "reviewState" text`);
    try {
      await expect(
        sign(finance.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
      ).rejects.toThrow("应收与收款分配尚未启用，请由管理员完成已批准的财务升级后再操作");
      expect((await readBilling(billing.id)).status).toBe("DRAFT");
    } finally {
      await side.$executeRawUnsafe(`ALTER TABLE "Payment" DROP COLUMN "reviewState"`);
    }
  });

  it("账号已停用 → ActionError「账号已停用或不存在」", async () => {
    const owner = await seedUser("FINANCE");
    const matter = await seedMatter(owner.id);
    const billing = await seedBilling(matter.id, { amount: "100.00" });
    const disabled = await seedUser("FINANCE", false);
    await expect(
      sign(disabled.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("账号已停用或不存在");
  });

  it("非本案经办律师（LAWYER 且非主办/成员）→ ActionError「案件不存在或无权处理」", async () => {
    const owner = await seedUser("LAWYER");
    const matter = await seedMatter(owner.id);
    const billing = await seedBilling(matter.id, { amount: "100.00" });
    const outsider = await seedUser("LAWYER");
    await expect(
      sign(outsider.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("案件不存在或无权处理");
    expect((await readBilling(billing.id)).status).toBe("DRAFT");
  });

  it("自定义岗位未授予 finance.write → ActionError「当前岗位没有此项财务权限」", async () => {
    const role = await prisma.roleDefinition.create({
      data: {
        id: uid("role"), name: `签署测试岗位${uid("R")}`, normalizedName: `签署测试岗位${uid("R")}`.toLowerCase(),
        permissions: { create: [{ permissionKey: "matters.read", scope: "OWN" }] }
      }
    });
    const custom = await prisma.user.create({
      data: { id: uid("u"), name: "自定义岗位用户", email: `${uid("mail")}@example.test`, passwordHash: "x", role: "CUSTOM", roleDefinitionId: role.id }
    });
    const owner = await seedUser("FINANCE");
    const matter = await seedMatter(owner.id);
    const billing = await seedBilling(matter.id, { amount: "100.00" });
    await expect(
      sign(custom.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("当前岗位没有此项财务权限");
    expect((await readBilling(billing.id)).status).toBe("DRAFT");
  });

  it("归档案件的 allowTail:false → ActionError「归档后不得新增或变更委托…」", async () => {
    const { finance, billing } = await seedSignable({ amount: "100.00" });
    await prisma.matter.update({ where: { id: billing.matterId }, data: { status: "ARCHIVED" } });
    await expect(
      sign(finance.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("归档后不得新增或变更委托，请建立有关联的新案件");
  });
});

describe("signBillingTx · 行锁后的状态校验（真库）", () => {
  it("补充协议（sourceBillingId 非空）→ 拒绝，提示走合同变更入口", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const source = await seedBilling(matter.id, { status: "ACTIVE", signedAt: new Date("2026-10-01T10:00:00+08:00"), amount: "10000.00" });
    const amendment = await seedBilling(matter.id, { amount: "2000.00", sourceBillingId: source.id });
    await seedMatterReview(finance.id, matter.id);
    await expect(
      sign(finance.id, { id: amendment.id, revision: 0, signedAt, installments: [installment("2000.00")] })
    ).rejects.toThrow("补充协议须从合同变更入口确认生效");
    const after = await readBilling(amendment.id);
    expect(after.status).toBe("DRAFT");
    expect(after.revision).toBe(0);
  });

  it("revision 与库内不一致 → 「收费安排已签署或发生变化，请刷新」", async () => {
    const { finance, billing } = await seedSignable({ amount: "100.00" });
    await expect(
      sign(finance.id, { id: billing.id, revision: 1, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("收费安排已签署或发生变化，请刷新");
    expect((await readBilling(billing.id)).revision).toBe(0);
  });

  it("已被签署（status ACTIVE）→ 同一提示，且不重复生成应收", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const billing = await seedBilling(matter.id, { amount: "100.00", status: "ACTIVE", signedAt: new Date("2026-10-01T10:00:00+08:00") });
    await seedMatterReview(finance.id, matter.id);
    await expect(
      sign(finance.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("收费安排已签署或发生变化，请刷新");
    expect(await prisma.receivable.count({ where: { billingId: billing.id } })).toBe(0);
  });

  it("status 仍为 DRAFT 但 signedAt 已有值 → 同一提示（半签署脏状态不得二次签署）", async () => {
    const { finance, billing } = await seedSignable({ amount: "100.00" });
    await prisma.billing.update({ where: { id: billing.id }, data: { signedAt: new Date("2026-10-01T10:00:00+08:00") } });
    await expect(
      sign(finance.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("收费安排已签署或发生变化，请刷新");
  });

  it("分期合计 ≠ 合同额 → ZodError（「各期金额合计必须等于收费总额」），合同保持草稿", async () => {
    const { finance, billing } = await seedSignable({ amount: "10000.00" });
    await expect(
      sign(finance.id, { id: billing.id, revision: 0, signedAt, installments: [installment("4000.00")] })
    ).rejects.toThrow("各期金额合计必须等于收费总额");
    expect((await readBilling(billing.id)).status).toBe("DRAFT");
    expect(await prisma.receivable.count({ where: { billingId: billing.id } })).toBe(0);
  });

  it("未完成动态冲突复核 → 拒绝并提示先复核", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const billing = await seedBilling(matter.id, { amount: "100.00" });
    // 注意：这里故意不 seedMatterReview
    await expect(
      sign(finance.id, { id: billing.id, revision: 0, signedAt, installments: [installment("100.00")] })
    ).rejects.toThrow("主体或代理范围已变化，请先在案件中完成动态冲突复核");
    expect((await readBilling(billing.id)).status).toBe("DRAFT");
  });
});

describe("signBillingTx · 正常签署（真库）", () => {
  it("签署成功：状态/签署日/revision/应收分期/审计全部落库", async () => {
    const { finance, billing } = await seedSignable({ amount: "10000.00" });
    const result = await sign(finance.id, {
      id: billing.id, revision: 0, signedAt,
      installments: [installment("6000.00"), { title: "第二期", amount: "4000.00", dueState: "UNKNOWN" }]
    });

    expect(result).toEqual({ id: billing.id, matterId: billing.matterId });

    const after = await readBilling(billing.id);
    expect(after.status).toBe("ACTIVE");
    expect(after.signedAt?.toISOString()).toBe(signedAt.toISOString());
    expect(after.revision).toBe(1);
    expect(after.contractAmount.toFixed(2)).toBe("10000.00");

    const ars = await receivablesOf(billing.id);
    expect(ars).toHaveLength(2);
    expect(ars.map(ar => ar.amount.toFixed(2))).toEqual(["6000.00", "4000.00"]);
    expect(ars.map(ar => ar.installmentNumber)).toEqual([1, 2]);
    expect(ars.map(ar => ar.sourceKey)).toEqual([`billing:${billing.id}:1`, `billing:${billing.id}:2`]);
    expect(ars.every(ar => ar.matterId === billing.matterId)).toBe(true);
    expect(ars.every(ar => ar.moneyKind === "LAWYER_FEE")).toBe(true);
    expect(ars.every(ar => ar.status === "OPEN")).toBe(true);
    expect(ars.every(ar => ar.settledAmount.toFixed(2) === "0.00")).toBe(true);
    expect(ars.every(ar => ar.dueState === "UNKNOWN")).toBe(true);
    expect(ars.every(ar => ar.dueDate === null && ar.dueCondition === null)).toBe(true);

    const audits = await signAudits(billing.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(finance.id);
    expect(audits[0].detail).toMatchObject({
      matterId: billing.matterId, previousRevision: 0, installments: 2
    });
  });

  it("分期到期形态落库：DATE_SET 写 dueDate、CONDITIONAL 写 dueCondition", async () => {
    const { finance, billing } = await seedSignable({ amount: "3000.00" });
    const dueDate = new Date("2026-12-31T00:00:00+08:00");
    await sign(finance.id, {
      id: billing.id, revision: 0, signedAt,
      installments: [
        { title: "首期", amount: "1000.00", dueState: "DATE_SET", dueDate },
        { title: "尾款", amount: "2000.00", dueState: "CONDITIONAL", dueCondition: "一审判决生效后十日内" }
      ]
    });
    const ars = await receivablesOf(billing.id);
    expect(ars.map(ar => ar.dueState)).toEqual(["DATE_SET", "CONDITIONAL"]);
    expect(ars[0].dueDate?.toISOString()).toBe(dueDate.toISOString());
    expect(ars[0].dueCondition).toBeNull();
    expect(ars[1].dueDate).toBeNull();
    expect(ars[1].dueCondition).toBe("一审判决生效后十日内");
  });
});

describe("signBillingTx · 并发防线（真库）", () => {
  it("两个事务同时签署同一份合同：只成交一次，应收不重复生成", async () => {
    const { finance, billing } = await seedSignable({ amount: "10000.00" });
    const input = {
      id: billing.id, revision: 0, signedAt,
      installments: [installment("5000.00"), { title: "第二期", amount: "5000.00", dueState: "UNKNOWN" as const }]
    };

    const results = await Promise.allSettled([sign(finance.id, input), sign(finance.id, input)]);
    const ok = results.filter(r => r.status === "fulfilled");
    const failed = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // 后到者要么在行锁后读到「已签署」（ActionError），要么被 Serializable 判为并发更新
    // （由 ledger-actions.mutate 统一转成「账务或授权已变化，请刷新后重试」）
    const message = failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason);
    expect(message).toMatch(/收费安排已签署或发生变化|40001|could not serialize|P2034/);

    const after = await readBilling(billing.id);
    expect(after.status).toBe("ACTIVE");
    expect(after.revision).toBe(1);
    // 钱的防线：分期只写了一套
    expect(await prisma.receivable.count({ where: { billingId: billing.id } })).toBe(2);
    expect(await signAudits(billing.id)).toHaveLength(1);
  }, 60_000);

  /**
   * 竞态：findUnique 读到 Billing 之后、FOR UPDATE 真正取到行锁之前，另一会话把这一行删掉。
   * 用 Proxy 包一层事务客户端，在第一条「Billing … FOR UPDATE」发出前用旁路会话删除，
   * 精确复现那个窗口（不 mock SQL 结果，SQL 仍由数据库执行）。
   */
  async function signWithRacingDelete(userId: string, billing: { id: string; matterId: string }, isolation: Prisma.TransactionIsolationLevel) {
    return prisma.$transaction(async tx => {
      let deleted = false;
      const proxy = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "$queryRaw") {
            return async (strings: TemplateStringsArray, ...values: unknown[]) => {
              const sql = Array.isArray(strings) ? strings.join(" ? ") : String(strings);
              if (!deleted && sql.includes('FROM "Billing"') && sql.includes("FOR UPDATE")) {
                deleted = true;
                await side.billing.delete({ where: { id: billing.id } });
              }
              return (target.$queryRaw as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>)(strings, ...values);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
      return signBillingTx(proxy as unknown as Prisma.TransactionClient, userId, {
        id: billing.id, revision: 0, signedAt, installments: [installment("100.00")]
      });
    }, { isolationLevel: isolation, timeout: 20_000 });
  }

  it("签署与并发删除交错（生产口径 Serializable）：被序列化冲突拒绝，无半签写入", async () => {
    const { finance, billing } = await seedSignable({ amount: "100.00" });
    const err = await signWithRacingDelete(finance.id, billing, Prisma.TransactionIsolationLevel.Serializable)
      .then(() => null, (e: unknown) => e);

    // 实测：Postgres 以 40001 拒绝加锁（Prisma 包成 P2010），ledger-actions.mutate 把它
    // 翻译成「账务或授权已变化，请刷新后重试」——用户看到业务提示，不是 500。
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((err as { code?: string }).code).toBe("P2010");
    expect((err as Error).message).toContain("40001");
    expect(await prisma.billing.count({ where: { id: billing.id } })).toBe(0);
    expect(await prisma.receivable.count({ where: { matterId: billing.matterId } })).toBe(0);
  }, 60_000);

  it(
    "签署与并发删除交错（未显式指定隔离级别）应给业务提示，而不是读未定义行",
    async () => {
      // 2026-11-20：此用例原为 it.fails（反面锁住期望行为）——当时 READ COMMITTED 下
      // FOR UPDATE 对被删行返回 0 行，下一行直接读 billing.sourceBillingId 抛 TypeError。
      // 现已补上「锁后无行」的业务分支（ledger-registration.ts 的 if(!billing) throw），
      // 期望行为变成实际行为，故改为普通 it。
      const { finance, billing } = await seedSignable({ amount: "100.00" });
      await expect(
        signWithRacingDelete(finance.id, billing, Prisma.TransactionIsolationLevel.ReadCommitted)
      ).rejects.toThrow("收费安排不存在");
    },
    60_000
  );
});
