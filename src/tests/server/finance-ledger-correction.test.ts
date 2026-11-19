// @vitest-environment node
/**
 * 财务两条此前空着的链路，真库测试：
 *
 *   A. `getFinanceLedger`（ledger-actions.ts:24）的**隔离墙过滤**——「被隔离的人真的看不到钱」。
 *   B. `decideCorrectionTx`（ledger-corrections.ts:116）的**完整确认链路**——
 *      批准/拒绝/撤销、快照比对、独立 `finance.correct` 权限、重复决定。
 *
 * 为什么必须用真库：
 *   隔离墙的拦截是一段 `Prisma.MatterWhereInput`（`NOT: { ethicalWalls: { some: … } }`），
 *   只有让 Postgres 真的执行它，「墙生效」才是事实而不是我对 where 对象的自我表白；
 *   更正决定的防线同样全在 SQL 侧——`SELECT … FOR UPDATE` 的行锁、`revision` 乐观锁、
 *   sha256 快照与 `FinanceCorrectionEffect` 的唯一索引。mock 掉这些，等于把
 *   「钱有没有被退两次」换成「我 mock 了什么」。
 *
 * 安全断言以**负向**为主：不是「有权限的人能看到」，而是「被隔离的人看不到」。
 *
 * 隔离：临时库 `lawlink_fincorr2_test_*`（lawlink-db:55432）→ `prisma migrate deploy`
 * → 结束 `DROP DATABASE … WITH (FORCE)`。**绝不写主库 lawlink。**
 * `process.env.DATABASE_URL` 在 `@/lib/prisma` 单例初始化前（vi.hoisted）改指临时库，
 * 即使被测代码某处误用单例，也只可能落到临时库。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ActionError } from "@/lib/action-error";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_fincorr2_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  const original = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url, original, session: { user: {} } as { user: Record<string, unknown> } };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
/** 可变 session：切身份只改 HOLDER.session，与 business-chain-e2e / finance-ledger-read 同手法 */
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => HOLDER.session),
  getSession: vi.fn(async () => HOLDER.session),
  requireSystemAdmin: vi.fn(async () => HOLDER.session)
}));

import { prisma } from "@/lib/prisma";
import { getFinanceLedger } from "@/server/finance/ledger-actions";
import { decideCorrectionTx, submitCorrectionTx } from "@/server/finance/ledger-corrections";

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

/** 旁路连接：只在并发用例与 DDL 探针里用，不参与主路径断言 */
let side: PrismaClient;
let admin: PrismaClient;

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
  } catch (err) {
    throw new Error(`临时库创建失败，需先启动 lawlink-db（${HOLDER.host}）：${String(err)}`);
  }
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: HOLDER.url },
    stdio: "pipe"
  });
  side = new PrismaClient({ datasourceUrl: HOLDER.url });
  console.info(`[finance-ledger-correction] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await side?.$disconnect();
  await prisma.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[finance-ledger-correction] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

/* ================================================================== *
 * 通用夹具
 * ================================================================== */
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const dec = (v: Prisma.Decimal | string | number | null | undefined) =>
  v === null || v === undefined ? null : new Prisma.Decimal(v).toFixed(2);

const OCCURRED = new Date("2026-11-01T10:00:00+08:00");
const LATER = new Date("2026-11-05T10:00:00+08:00");

type UserRoleName = "FINANCE" | "LAWYER" | "PRINCIPAL_LAWYER" | "INDEPENDENT_LAWYER" | "ASSISTANT";

type Actor = {
  id: string; name: string; role: string;
  rolePermissions?: { permissionKey: string; scope: string }[];
  managerAuthorized?: boolean;
};

/** 切换 getFinanceLedger 看到的会话身份 */
function as(actor: Actor | { id: string; name: string; role: string; rolePermissions?: { permissionKey: string; scope: string }[]; managerAuthorized?: boolean }) {
  HOLDER.session = {
    user: {
      id: actor.id, name: actor.name, role: actor.role, systemRole: null,
      rolePermissions: actor.rolePermissions, managerAuthorized: actor.managerAuthorized ?? false
    }
  };
}

async function seedUser(
  role: UserRoleName | "CUSTOM",
  options: { active?: boolean; roleDefinitionId?: string; managerAuthorized?: boolean } = {}
) {
  return prisma.user.create({
    data: {
      id: uid("u"), name: `更正链路${role}${uid("N")}`, email: `${uid("mail")}@example.test`,
      passwordHash: "x", role: role as never, active: options.active ?? true,
      roleDefinitionId: options.roleDefinitionId ?? null,
      managerAuthorized: options.managerAuthorized ?? false
    }
  });
}

async function seedMatter(ownerId: string, title = "更正链路测试案件") {
  const client = await prisma.client.create({ data: { id: uid("c"), name: `链路当事人${uid("N")}`, type: "INDIVIDUAL" } });
  return prisma.matter.create({
    data: { id: uid("m"), internalCode: uid("MS"), title, ownerId, primaryClientId: client.id }
  });
}

/** 一笔已确认实收（FeeEntry RECEIVED CONFIRMED + Payment），来源必须一致，否则 readLedger 会拒绝汇总 */
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

async function seedReceivable(matterId: string, amount: string, settledAmount = "0") {
  return prisma.receivable.create({
    data: {
      id: uid("ar"), matterId, title: "一审代理费", amount: D(amount), settledAmount: D(settledAmount),
      moneyKind: "LAWYER_FEE", status: settledAmount === "0" ? "OPEN" : "SETTLED"
    }
  });
}

/** 一笔支出（EXPENSE 类更正的唯一合法目标） */
async function seedExpense(matterId: string, userId: string, amount: string) {
  return prisma.feeEntry.create({
    data: {
      id: uid("fe-cost"), matterId, type: "COST", amount: D(amount), moneyKind: "EXPENSE_RECOVERY",
      occurredAt: OCCURRED, recordedById: userId, confirmState: "CONFIRMED",
      confirmedById: userId, confirmedAt: OCCURRED
    }
  });
}

/**
 * 一个「有账可读、有账可改」的完整案件：合同 + 应收 + 已确认实收（+ 可选待确认实收）。
 * `readLedger` 要求实收与已确认来源流水一致，故此处一律造合规数据。
 */
async function seedLedgerMatter(
  ownerId: string,
  options: { title?: string; receivable?: string; receipt?: string; pending?: string } = {}
) {
  const matter = await seedMatter(ownerId, options.title ?? "链路测试案件");
  const receivable = await seedReceivable(matter.id, options.receivable ?? "6000.00");
  const { entry, payment } = await seedReceipt(matter.id, ownerId, options.receipt ?? "2000.00");
  let pending: { id: string } | null = null;
  if (options.pending) {
    pending = await prisma.feeEntry.create({
      data: {
        id: uid("fe-pending"), matterId: matter.id, type: "RECEIVED", amount: D(options.pending),
        moneyKind: "LAWYER_FEE", occurredAt: OCCURRED, recordedById: ownerId, confirmState: "PENDING"
      }
    });
  }
  return { matter, receivable, entry, payment, pending };
}

/* ================================================================== *
 * A · 隔离墙（EthicalWall）过滤
 * ================================================================== */

async function seedWall(params: {
  matterId: string;
  createdById: string;
  reason?: string;
  denials: { denyType: "USER" | "TEAM" | "ROLE"; userId?: string; teamId?: string; role?: UserRoleName }[];
  active?: boolean;
  expiresAt?: Date | null;
}) {
  return prisma.ethicalWall.create({
    data: {
      id: uid("wall"),
      matterId: params.matterId,
      reason: params.reason ?? "本所同时为对方公司提供常年顾问，须隔离本案",
      createdById: params.createdById,
      active: params.active ?? true,
      expiresAt: params.expiresAt ?? null,
      denials: {
        create: params.denials.map(d => ({
          denyType: d.denyType as never,
          userId: d.userId ?? null,
          teamId: d.teamId ?? null,
          role: (d.role ?? null) as never
        }))
      }
    }
  });
}

/** 汇总口径恒等式：summary 只能由「本会话可见的明细」构成（墙一盖，金额就不可能进汇总） */
const sumReceivable = (rows: { amount: string | null; adjustmentAmount?: string | null; status?: string }[]) =>
  rows.filter(r => r.status !== "CANCELLED")
    .reduce((acc, r) => acc.plus(r.amount ?? 0).plus(r.adjustmentAmount ?? 0), D(0)).toFixed(2);
const sumNetReceived = (rows: { amount: string | null; refundedAmount: string | null }[]) =>
  rows.reduce((acc, r) => acc.plus(r.amount ?? 0).minus(r.refundedAmount ?? 0), D(0)).toFixed(2);

describe("getFinanceLedger · 隔离墙（真库）", () => {
  /**
   * 本人经办口径（OWN）是唯一能把「金额汇总」做成精确断言的范围口径：
   * 该律师恰好只经办一个案件，墙一盖，汇总必须回到 0，而不是「少了一点」。
   */
  it("正向：无墙时，本人经办案件的财务数据完整可读（金额与待确认清单都在）", async () => {
    const lawyer = await seedUser("LAWYER");
    const { matter, receivable, payment, pending } = await seedLedgerMatter(lawyer.id, {
      receivable: "6000.00", receipt: "2000.00", pending: "500.00"
    });
    as(lawyer);

    const ledger = await getFinanceLedger();
    expect(ledger.ready).toBe(true);
    expect(ledger.matters.map(m => m.id)).toEqual([matter.id]);
    // 本夹具没有核销关系：应收 6000 全额未收，实收 2000 全额未分配
    expect(ledger.receivables.map(r => ({ id: r.id, amount: r.amount, outstanding: r.outstanding })))
      .toContainEqual({ id: receivable.id, amount: "6000.00", outstanding: "6000.00" });
    expect(ledger.payments.map(p => ({ id: p.id, amount: p.amount, unallocated: p.unallocated })))
      .toContainEqual({ id: payment.id, amount: "2000.00", unallocated: "2000.00" });
    expect(ledger.pending.map(p => p.id)).toEqual([pending!.id]);
    expect(ledger.summary.receivable).toBe("6000.00");
    expect(ledger.summary.netReceived).toBe("2000.00");

    // 指定 matterId 也读得到
    const single = await getFinanceLedger(matter.id);
    expect(single.matters.map(m => m.id)).toEqual([matter.id]);
    expect(single.summary.receivable).toBe("6000.00");
  });

  it("负向（USER 类）：盖墙后，被隔离的经办律师读不到——单案报错、列表为空、汇总归零", async () => {
    const lawyer = await seedUser("LAWYER");
    const { matter, receivable, payment } = await seedLedgerMatter(lawyer.id, {
      receivable: "6000.00", receipt: "2000.00", pending: "500.00"
    });
    const admin = await seedUser("PRINCIPAL_LAWYER");

    // 同一夹具、同一身份的对照：造墙前确实读得到（证明后面的「读不到」不是空转）
    as(lawyer);
    expect((await getFinanceLedger()).summary.receivable).toBe("6000.00");
    expect((await getFinanceLedger(matter.id)).matters.map(m => m.id)).toEqual([matter.id]);

    await seedWall({ matterId: matter.id, createdById: admin.id, denials: [{ denyType: "USER", userId: lawyer.id }] });

    as(lawyer);
    // ① 指定案件：直接业务错误，不是「返回空账」
    await expect(getFinanceLedger(matter.id)).rejects.toThrow("案件不存在或无权查看财务");

    // ② 列表：案件本身不出现
    const ledger = await getFinanceLedger();
    expect(ledger.matters).toEqual([]);
    // ③ 金额：一分都不能漏出来
    expect(ledger.receivables.find(r => r.id === receivable.id)).toBeUndefined();
    expect(ledger.payments.find(p => p.id === payment.id)).toBeUndefined();
    expect(ledger.billings).toEqual([]);
    expect(ledger.expenses).toEqual([]);
    expect(ledger.pending).toEqual([]);
    expect(ledger.summary.receivable).toBe("0.00");
    expect(ledger.summary.outstanding).toBe("0.00");
    expect(ledger.summary.netReceived).toBe("0.00");
    expect(ledger.summary.lawyerFeeReceived).toBe("0.00");
  });

  it("负向（全所口径）：财务岗的 ALL 范围不能越过隔离墙", async () => {
    const finance = await seedUser("FINANCE");
    const owner = await seedUser("LAWYER");
    const walled = await seedLedgerMatter(owner.id, { receivable: "6000.00", receipt: "2000.00" });
    const open = await seedLedgerMatter(owner.id, { receivable: "3000.00", receipt: "1000.00" });
    await seedWall({
      matterId: walled.matter.id, createdById: finance.id,
      denials: [{ denyType: "USER", userId: finance.id }]
    });

    as(finance);
    const ledger = await getFinanceLedger();
    // 未隔离的案件照常可见（证明墙是精准的，不是把整个财务页搞空）
    expect(ledger.matters.map(m => m.id)).toContain(open.matter.id);
    // 被隔离案件：案件、应收、实收、合同全不出现
    expect(ledger.matters.map(m => m.id)).not.toContain(walled.matter.id);
    expect(ledger.receivables.some(r => r.matterId === walled.matter.id)).toBe(false);
    expect(ledger.payments.some(p => p.matterId === walled.matter.id)).toBe(false);
    expect(ledger.billings.some(b => b.matterId === walled.matter.id)).toBe(false);
    expect(ledger.summary.receivable).toBe(sumReceivable(ledger.receivables));
    expect(ledger.summary.netReceived).toBe(sumNetReceived(ledger.payments));
    await expect(getFinanceLedger(walled.matter.id)).rejects.toThrow("案件不存在或无权查看财务");
    // 指定未隔离案件仍然正常
    await expect(getFinanceLedger(open.matter.id)).resolves.toMatchObject({ matters: [{ id: open.matter.id }] });
  });

  it("负向（管理身份）：合伙人/业务管理权不豁免隔离墙——这是执业合规，不是权限设置", async () => {
    const partner = await seedUser("PRINCIPAL_LAWYER", { managerAuthorized: true });
    const owner = await seedUser("LAWYER");
    const { matter } = await seedLedgerMatter(owner.id, { receivable: "6000.00", receipt: "2000.00" });

    // 对照：管理身份在无墙时确实能看到该案（墙是唯一变量）
    as(partner);
    expect((await getFinanceLedger()).matters.map(m => m.id)).toContain(matter.id);

    await seedWall({ matterId: matter.id, createdById: partner.id, denials: [{ denyType: "USER", userId: partner.id }] });

    as(partner);
    await expect(getFinanceLedger(matter.id)).rejects.toThrow("案件不存在或无权查看财务");
    const ledger = await getFinanceLedger();
    expect(ledger.matters.map(m => m.id)).not.toContain(matter.id);
    expect(ledger.payments.some(p => p.matterId === matter.id)).toBe(false);
    expect(ledger.receivables.some(r => r.matterId === matter.id)).toBe(false);
    // 合伙人范围是全所，精确总数会随其他用例的夹具变化；改断言更强的恒等式：
    // 汇总只能由本次可见明细构成 —— 墙内金额没有任何渠道进入数字。
    expect(ledger.summary.receivable).toBe(sumReceivable(ledger.receivables));
    expect(ledger.summary.netReceived).toBe(sumNetReceived(ledger.payments));
  });

  it("负向（ROLE 类）：按岗位隔离命中同岗位所有人，其他岗位不受影响", async () => {
    const lawyer = await seedUser("LAWYER");
    const otherLawyer = await seedUser("LAWYER");
    const finance = await seedUser("FINANCE");
    const { matter, receivable } = await seedLedgerMatter(lawyer.id, { receivable: "6000.00", receipt: "2000.00" });
    const other = await seedLedgerMatter(otherLawyer.id, { receivable: "3000.00", receipt: "1000.00" });
    await seedWall({ matterId: matter.id, createdById: finance.id, denials: [{ denyType: "ROLE", role: "LAWYER" }] });

    // 同岗位、且是该案经办人的律师：被挡住
    as(lawyer);
    expect((await getFinanceLedger()).receivables.find(r => r.id === receivable.id)).toBeUndefined();
    await expect(getFinanceLedger(matter.id)).rejects.toThrow("案件不存在或无权查看财务");

    // 另一名律师的另一个案件不受影响（岗位隔离不误伤别人的案子）
    as(otherLawyer);
    expect((await getFinanceLedger()).matters.map(m => m.id)).toEqual([other.matter.id]);

    // 财务岗不在 LAWYER 岗位，墙对它的可见性不生效（但对本案例仍可能因 USER/TEAM 被挡，这里只有 ROLE 类）
    as(finance);
    expect((await getFinanceLedger()).matters.map(m => m.id)).toContain(matter.id);
  });

  it("负向（TEAM 类）：团队成员被隔离；成员关系停用后不再命中", async () => {
    const leader = await seedUser("PRINCIPAL_LAWYER");
    const finance = await seedUser("FINANCE");
    const owner = await seedUser("LAWYER");
    const { matter, receivable } = await seedLedgerMatter(owner.id, { receivable: "6000.00", receipt: "2000.00" });
    const team = await prisma.team.create({
      data: { id: uid("team"), name: `隔离团队${uid("T")}`, leaderId: leader.id }
    });
    const member = await prisma.teamMember.create({
      data: { teamId: team.id, userId: finance.id, active: true }
    });
    await seedWall({ matterId: matter.id, createdById: leader.id, denials: [{ denyType: "TEAM", teamId: team.id }] });

    as(finance);
    expect((await getFinanceLedger()).receivables.find(r => r.id === receivable.id)).toBeUndefined();
    await expect(getFinanceLedger(matter.id)).rejects.toThrow("案件不存在或无权查看财务");

    // 边界：成员关系 active=false 不再是「团队成员」，墙不再命中该人
    await prisma.teamMember.update({ where: { teamId_userId: { teamId: team.id, userId: finance.id } }, data: { active: false } });
    expect((await getFinanceLedger()).receivables.find(r => r.id === receivable.id)).toBeDefined();
    expect(await prisma.teamMember.count({ where: { teamId: team.id, userId: finance.id, active: false } })).toBe(1);
    void member;
  });

  it("边界：墙 active=false（已手动解除）不再拦截", async () => {
    const lawyer = await seedUser("LAWYER");
    const { matter, receivable } = await seedLedgerMatter(lawyer.id, { receivable: "6000.00", receipt: "2000.00" });
    const admin = await seedUser("PRINCIPAL_LAWYER");
    await seedWall({
      matterId: matter.id, createdById: admin.id, active: false,
      denials: [{ denyType: "USER", userId: lawyer.id }]
    });

    as(lawyer);
    const ledger = await getFinanceLedger();
    expect(ledger.matters.map(m => m.id)).toEqual([matter.id]);
    expect(ledger.receivables.find(r => r.id === receivable.id)?.amount).toBe("6000.00");
    expect(ledger.summary.receivable).toBe("6000.00");
  });

  it("边界：expiresAt 已过 → 自动失效；expiresAt 在未来 → 仍然拦截", async () => {
    const lawyer = await seedUser("LAWYER");
    const expired = await seedLedgerMatter(lawyer.id, { receivable: "6000.00", receipt: "2000.00" });
    const future = await seedLedgerMatter(lawyer.id, { receivable: "3000.00", receipt: "1000.00" });
    const admin = await seedUser("PRINCIPAL_LAWYER");
    await seedWall({
      matterId: expired.matter.id, createdById: admin.id, expiresAt: new Date("2020-01-01T00:00:00+08:00"),
      denials: [{ denyType: "USER", userId: lawyer.id }]
    });
    await seedWall({
      matterId: future.matter.id, createdById: admin.id, expiresAt: new Date("2099-01-01T00:00:00+08:00"),
      denials: [{ denyType: "USER", userId: lawyer.id }]
    });

    as(lawyer);
    const ledger = await getFinanceLedger();
    expect(ledger.matters.map(m => m.id)).toEqual([expired.matter.id]);
    expect(ledger.receivables.find(r => r.id === expired.receivable.id)?.amount).toBe("6000.00");
    expect(ledger.receivables.some(r => r.matterId === future.matter.id)).toBe(false);
    await expect(getFinanceLedger(future.matter.id)).rejects.toThrow("案件不存在或无权查看财务");
  });

  it("边界：墙只作用于它挂的案件——同一人另一案件的数据完整保留", async () => {
    const lawyer = await seedUser("LAWYER");
    const walled = await seedLedgerMatter(lawyer.id, { receivable: "6000.00", receipt: "2000.00", pending: "500.00" });
    const safe = await seedLedgerMatter(lawyer.id, { receivable: "3000.00", receipt: "1000.00" });
    const admin = await seedUser("PRINCIPAL_LAWYER");
    await seedWall({ matterId: walled.matter.id, createdById: admin.id, denials: [{ denyType: "USER", userId: lawyer.id }] });

    as(lawyer);
    const ledger = await getFinanceLedger();
    expect(ledger.matters.map(m => m.id)).toEqual([safe.matter.id]);
    expect(ledger.summary.receivable).toBe("3000.00");
    expect(ledger.summary.netReceived).toBe("1000.00");
    expect(ledger.pending).toEqual([]);
    expect(ledger.receivables.map(r => r.matterId)).toEqual([safe.matter.id]);
  });

  it("负向（自定义岗位）：全所范围 finance.read 同样被墙挡住", async () => {
    const role = await prisma.roleDefinition.create({
      data: {
        id: uid("role"), name: `隔离墙测试岗位${uid("R")}`, normalizedName: `隔离墙测试岗位${uid("R")}`.toLowerCase(),
        permissions: { create: [{ permissionKey: "finance.read", scope: "ALL" }, { permissionKey: "matters.read", scope: "ALL" }] }
      }
    });
    const custom = await seedUser("CUSTOM", { roleDefinitionId: role.id });
    const owner = await seedUser("LAWYER");
    const { matter, receivable } = await seedLedgerMatter(owner.id, { receivable: "6000.00", receipt: "2000.00" });
    const admin = await seedUser("PRINCIPAL_LAWYER");
    await seedWall({ matterId: matter.id, createdById: admin.id, denials: [{ denyType: "USER", userId: custom.id }] });

    const grants = [
      { permissionKey: "finance.read", scope: "ALL" },
      { permissionKey: "matters.read", scope: "ALL" }
    ];
    as({ id: custom.id, name: custom.name, role: "CUSTOM", rolePermissions: grants });
    expect((await getFinanceLedger()).receivables.find(r => r.id === receivable.id)).toBeUndefined();
    await expect(getFinanceLedger(matter.id)).rejects.toThrow("案件不存在或无权查看财务");
  });
});

/* ================================================================== *
 * B · decideCorrectionTx
 * ================================================================== */

/** 与生产同一形状：`mutate()` 用 Serializable + 20s（ledger-actions.ts:72） */
function submit(userId: string, input: unknown) {
  return prisma.$transaction(tx => submitCorrectionTx(tx, userId, input as never), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000
  });
}

function decide(userId: string, input: unknown) {
  return prisma.$transaction(tx => decideCorrectionTx(tx, userId, input as never), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20_000
  });
}

const readCorrection = (id: string) => prisma.financeCorrection.findUniqueOrThrow({ where: { id } });
const effectsOf = (id: string) => prisma.financeCorrectionEffect.findMany({ where: { correctionId: id } });
const auditsOf = (id: string, action: string) => prisma.auditLog.findMany({ where: { action, targetId: id } });

/** 一笔 1000 已确认实收 + 1000 应收的干净案件（无核销、无票款，退款无需撤回） */
async function seedRefundable(paymentAmount = "1000.00") {
  const finance = await seedUser("FINANCE");
  const matter = await seedMatter(finance.id);
  const { entry, payment } = await seedReceipt(matter.id, finance.id, paymentAmount);
  return { finance, matter, entry, payment };
}

/** 敞口退款申请：1000 实收里退 300，不涉核销/票款 */
function refundInput(paymentId: string, amount = "300.00") {
  return {
    targetId: paymentId, targetKind: "LEDGER" as const, revision: 0, type: "REFUND" as const,
    amount, occurredAt: LATER, reason: "客户部分退费", voucherReference: "退-0001",
    allocationReversals: [], invoiceReversals: [], waivers: []
  };
}

async function seedPendingRefund(ownerId: string, paymentAmount = "1000.00") {
  const base = await seedRefundable(paymentAmount);
  const submitted = await submit(base.finance.id, refundInput(base.payment.id));
  return { ...base, correctionId: submitted.id, submitted };
}

describe("decideCorrectionTx · 输入与前置门禁（真库）", () => {
  it("correctionDecision 校验：缺 note 的 REJECTED/CANCELLED 抛 ActionError（用户可读中文，不再是含英文结构的 ZodError），申请保持 PENDING", async () => {
    const { finance, correctionId } = await seedPendingRefund(await seedUser("LAWYER").then(u => u.id));

    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "REJECTED" } as never))
      .rejects.toBeInstanceOf(ActionError);
    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CANCELLED", note: "  " } as never))
      .rejects.toBeInstanceOf(ActionError);
    // decision 不在枚举内
    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "APPROVED", note: "x" } as never))
      .rejects.toBeInstanceOf(ActionError);

    const row = await readCorrection(correctionId);
    expect(row.status).toBe("PENDING");
    expect(row.revision).toBe(0);
  });

  it("老库未完成财务升级（Payment.reviewState 仍存在）→ 升级门禁先拦下，状态不变", async () => {
    const { finance, payment, correctionId } = await seedPendingRefund(await seedUser("LAWYER").then(u => u.id));
    await side.$executeRawUnsafe(`ALTER TABLE "Payment" ADD COLUMN "reviewState" text`);
    try {
      await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
        .rejects.toThrow("应收与收款分配尚未启用，请由管理员完成已批准的财务升级后再操作");
      expect((await readCorrection(correctionId)).status).toBe("PENDING");
      expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
    } finally {
      await side.$executeRawUnsafe(`ALTER TABLE "Payment" DROP COLUMN "reviewState"`);
    }
  });

  it("更正申请不存在 → 「更正申请不存在」", async () => {
    const finance = await seedUser("FINANCE");
    await expect(decide(finance.id, { id: uid("fc-missing"), revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("更正申请不存在");
  });

  it("账号已停用 → 「账号已停用或不存在」", async () => {
    const applicant = await seedUser("LAWYER");
    const { payment } = await seedRefundable();
    const submitted = await submit(applicant.id, refundInput(payment.id)).catch(() => null);
    // 申请人无 finance.write 关联时提交会失败，用财务先造单，再用停用账号决定
    const { finance, correctionId } = await seedPendingRefund(applicant.id);
    const disabled = await seedUser("FINANCE", { active: false });
    await expect(decide(disabled.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("账号已停用或不存在");
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
    void submitted; void finance;
  });

  it("决定权的检查顺序：先查独立财务权限，再查案件关联——局外律师拿到的是权限提示而不是「无权处理」", async () => {
    const applicant = await seedUser("LAWYER");
    const { correctionId } = await seedPendingRefund(applicant.id);
    const outsider = await seedUser("LAWYER");
    // 实测顺序（ledger-access.ts）：active → 岗位配置 → finance.confirm → canExecuteFinance → 案件关联。
    // 因此没有 finance.correct 的人，无论是不是本案经办，都在第 4 步被拦下；
    // 「案件不存在或无权处理」只在通过权限检查后才可能触发（见下一条 CANCELLED 用例）。
    await expect(decide(outsider.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("当前岗位没有此项独立财务执行权限");
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
  });

  it("撤销走 finance.write：局外律师（有该权限但非本案经办）→「案件不存在或无权处理」", async () => {
    const applicant = await seedUser("LAWYER");
    const { correctionId } = await seedPendingRefund(applicant.id);
    const outsider = await seedUser("LAWYER");
    // CANCELLED 只要 finance.write，故能走到案件关联这一步，被 association 过滤挡下
    await expect(decide(outsider.id, { id: correctionId, revision: 0, decision: "CANCELLED", note: "代为撤回" }))
      .rejects.toThrow("案件不存在或无权处理");
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
  });

  it("申请人本人（LAWYER，有 finance.write 关联、无 finance.correct）→ 「当前岗位没有此项独立财务执行权限」", async () => {
    const applicant = await seedUser("LAWYER");
    const { matter, payment } = await seedRefundable();
    // 让申请人成为本案经办并提交，才能证明「能申请 ≠ 能决定」
    await prisma.matter.update({ where: { id: matter.id }, data: { ownerId: applicant.id } });
    const submitted = await submit(applicant.id, refundInput(payment.id));

    await expect(decide(applicant.id, { id: submitted.id, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("当前岗位没有此项独立财务执行权限");
    // 但申请人可以撤销自己的申请（下面单独用例断言），这里先确认它仍 PENDING
    expect((await readCorrection(submitted.id)).status).toBe("PENDING");
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
  });

  it("合伙人 + 业务管理权 + 系统管理员：管理身份不取得 finance.correct（注释所说「独立 ALL 权限」）", async () => {
    const applicant = await seedUser("LAWYER");
    const { matter, payment } = await seedRefundable();
    await prisma.matter.update({ where: { id: matter.id }, data: { ownerId: applicant.id } });
    const submitted = await submit(applicant.id, refundInput(payment.id));

    // 三种「看起来最大」的身份，逐一确认都过不了 canExecuteFinance
    const partner = await seedUser("PRINCIPAL_LAWYER", { managerAuthorized: true });
    const superAdmin = await prisma.user.create({
      data: {
        id: uid("u"), name: "系统管理员", email: `${uid("mail")}@example.test`, passwordHash: "x",
        role: "PRINCIPAL_LAWYER", systemRole: "SUPER_ADMIN", managerAuthorized: true
      }
    });
    for (const actor of [partner, superAdmin]) {
      await expect(decide(actor.id, { id: submitted.id, revision: 0, decision: "CONFIRMED", note: "" }))
        .rejects.toThrow("当前岗位没有此项独立财务执行权限");
    }
    expect((await readCorrection(submitted.id)).status).toBe("PENDING");
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
  });

  it("自定义岗位无 finance.correct → 「当前岗位没有此项财务权限」", async () => {
    const applicant = await seedUser("LAWYER");
    const { correctionId } = await seedPendingRefund(applicant.id);
    const role = await prisma.roleDefinition.create({
      data: {
        id: uid("role"), name: `更正测试岗位${uid("R")}`, normalizedName: `更正测试岗位${uid("R")}`.toLowerCase(),
        permissions: {
          create: [
            { permissionKey: "matters.read", scope: "OWN" },
            { permissionKey: "finance.write", scope: "ALL" },
            { permissionKey: "finance.read", scope: "ALL" }
          ]
        }
      }
    });
    const custom = await seedUser("CUSTOM", { roleDefinitionId: role.id });
    await expect(decide(custom.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("当前岗位没有此项财务权限");
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
  });

  it("归档案件：未指定财务收尾负责人时，即使有 finance.correct 也不能决定（收尾权限独立）", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, matter, payment, correctionId } = await seedPendingRefund(applicant.id);
    await prisma.matter.update({ where: { id: matter.id }, data: { status: "ARCHIVED" } });

    // assertLedgerWrite 对 ARCHIVED + allowTail:true（默认）走 assertTailAuthority：
    // 内置财务跳过 finance.tail 判定，但必须与 ArchiveClosurePlan.financeOwnerId 一致
    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("只有本案指定的财务收尾负责人可以追加财务业务");
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
  });

  it("自定义岗位授予 finance.correct ALL → 可以决定（独立权限走 ALL 范围，不需案件关联）", async () => {
    const applicant = await seedUser("LAWYER");
    const { correctionId, payment } = await seedPendingRefund(applicant.id);
    const role = await prisma.roleDefinition.create({
      data: {
        id: uid("role"), name: `财务执行岗位${uid("R")}`, normalizedName: `财务执行岗位${uid("R")}`.toLowerCase(),
        permissions: {
          create: [
            { permissionKey: "matters.read", scope: "ALL" },
            { permissionKey: "finance.read", scope: "ALL" },
            { permissionKey: "finance.write", scope: "ALL" },
            { permissionKey: "finance.correct", scope: "ALL" }
          ]
        }
      }
    });
    const custom = await seedUser("CUSTOM", { roleDefinitionId: role.id });

    await expect(decide(custom.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .resolves.toEqual({ matterId: (await readCorrection(correctionId)).matterId });
    expect((await readCorrection(correctionId)).status).toBe("CONFIRMED");
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("300.00");
  });
});

describe("decideCorrectionTx · 批准与账务落地（真库）", () => {
  it("REFUND 批准：状态/确认人/确认时间/revision/效果行/实收退款额/审计全部落地", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, matter, payment, correctionId } = await seedPendingRefund(applicant.id);

    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "同意退费" }))
      .resolves.toEqual({ matterId: matter.id });

    const row = await readCorrection(correctionId);
    expect(row.status).toBe("CONFIRMED");
    expect(row.revision).toBe(1);
    expect(row.confirmedById).toBe(finance.id);
    expect(row.confirmedAt).not.toBeNull();
    expect(row.resolutionNote).toBe("同意退费");

    const effects = await effectsOf(correctionId);
    expect(effects).toHaveLength(1);
    expect(effects[0].effectKind).toBe("PAYMENT_REFUND");
    expect(effects[0].paymentId).toBe(payment.id);
    expect(dec(effects[0].delta)).toBe("300.00");

    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(dec(after.refundedAmount)).toBe("300.00");
    expect(after.revision).toBe(1);

    const audits = await auditsOf(correctionId, "FINANCE_CORRECTION_CONFIRMED");
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(finance.id);
    expect(audits[0].detail).toMatchObject({ matterId: matter.id, previousRevision: 0, note: "同意退费" });
  });

  it("REJECTED：状态与原因落库、确认人/时间为空，钱一分不动", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, payment, correctionId } = await seedPendingRefund(applicant.id);

    await decide(finance.id, { id: correctionId, revision: 0, decision: "REJECTED", note: "金额与对账单不符" });

    const row = await readCorrection(correctionId);
    expect(row.status).toBe("REJECTED");
    expect(row.revision).toBe(1);
    expect(row.confirmedById).toBeNull();
    expect(row.confirmedAt).toBeNull();
    expect(row.resolutionNote).toBe("金额与对账单不符");

    expect(await effectsOf(correctionId)).toEqual([]);
    const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(dec(after.refundedAmount)).toBe("0.00");
    expect(after.revision).toBe(0);
    expect(await auditsOf(correctionId, "FINANCE_CORRECTION_REJECTED")).toHaveLength(1);
  });

  it("CANCELLED：只有申请人可以撤销；申请人撤销成功且不动机器", async () => {
    const applicant = await seedUser("LAWYER");
    const { matter, payment } = await seedRefundable();
    await prisma.matter.update({ where: { id: matter.id }, data: { ownerId: applicant.id } });
    const submitted = await submit(applicant.id, refundInput(payment.id));

    // 非申请人的财务（有 finance.write）撤销 → 拒绝，且原因明确指向「只有申请人」
    const finance = await seedUser("FINANCE");
    await expect(decide(finance.id, { id: submitted.id, revision: 0, decision: "CANCELLED", note: "财务代为撤销" }))
      .rejects.toThrow("只有申请人可以撤销更正");
    expect((await readCorrection(submitted.id)).status).toBe("PENDING");

    // 申请人本人撤销 → 成功（撤销只要 finance.write，不要求 finance.correct）
    await decide(applicant.id, { id: submitted.id, revision: 0, decision: "CANCELLED", note: "重复申请，自行撤回" });
    const row = await readCorrection(submitted.id);
    expect(row.status).toBe("CANCELLED");
    expect(row.revision).toBe(1);
    expect(row.resolutionNote).toBe("重复申请，自行撤回");
    expect(await effectsOf(submitted.id)).toEqual([]);
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
  });

  it("DISCOUNT 批准：只调整应收有效额，不碰实收、不生成退款", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const ar = await seedReceivable(matter.id, "1000.00");
    const submitted = await submit(finance.id, {
      targetId: ar.id, targetKind: "LEDGER", revision: 0, type: "DISCOUNT", amount: "200.00",
      occurredAt: LATER, reason: "人情折让", voucherReference: "折-0001",
      allocationReversals: [], invoiceReversals: [], waivers: []
    });

    await decide(finance.id, { id: submitted.id, revision: 0, decision: "CONFIRMED", note: "" });

    const afterAr = await prisma.receivable.findUniqueOrThrow({ where: { id: ar.id } });
    expect(dec(afterAr.adjustmentAmount)).toBe("-200.00");
    expect(dec(afterAr.settledAmount)).toBe("0.00");
    expect(afterAr.status).toBe("OPEN");
    expect(afterAr.revision).toBe(1);
    const effects = await effectsOf(submitted.id);
    expect(effects.map(e => e.effectKind)).toEqual(["RECEIVABLE_ADJUSTMENT"]);
    expect(effects[0].receivableId).toBe(ar.id);
    expect(dec(effects[0].delta)).toBe("-200.00");
    // 折让不产生退款目标：本案没有 Payment 被动过
    expect(await prisma.payment.count({ where: { matterId: matter.id, refundedAmount: { gt: 0 } } })).toBe(0);
  });

  it("EXPENSE 冲销批准：支出 revision 递增、不产生退款目标", async () => {
    const finance = await seedUser("FINANCE");
    const matter = await seedMatter(finance.id);
    const expense = await seedExpense(matter.id, finance.id, "300.00");
    const submitted = await submit(finance.id, {
      targetId: expense.id, targetKind: "EXPENSE", revision: 0, type: "REVERSAL", amount: "300.00",
      occurredAt: LATER, reason: "重复登记的费用", voucherReference: "冲-0001",
      allocationReversals: [], invoiceReversals: [], waivers: []
    });

    await decide(finance.id, { id: submitted.id, revision: 0, decision: "CONFIRMED", note: "" });

    expect((await prisma.feeEntry.findUniqueOrThrow({ where: { id: expense.id } })).revision).toBe(1);
    const effects = await effectsOf(submitted.id);
    expect(effects.map(e => e.effectKind)).toEqual(["EXPENSE_REVERSAL"]);
    expect(effects[0].expenseEntryId).toBe(expense.id);
    expect(dec(effects[0].delta)).toBe("300.00");
  });
});

describe("decideCorrectionTx · 快照比对（防「按旧数据更正」）", () => {
  it("申请后账务发生变化（新增了一笔应收）→ 拒绝并提示退回重新申请，钱不动", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, matter, payment, correctionId } = await seedPendingRefund(applicant.id);

    // 目标实收的 revision 完全没动，只有「本案账务」多了余额明细——
    // 这正是「按旧数据更正」的危险形态：只看目标行 revision 是看不出来的。
    const intruder = await seedReceivable(matter.id, "500.00");
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).revision).toBe(0);

    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("申请后账务已变化，请退回后重新申请");

    const row = await readCorrection(correctionId);
    expect(row.status).toBe("PENDING");
    expect(row.revision).toBe(0);
    expect(await effectsOf(correctionId)).toEqual([]);
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
    // 新旧应收都未被动过
    expect(dec(await prisma.receivable.findUniqueOrThrow({ where: { id: intruder.id } }).then(r => r.adjustmentAmount))).toBe("0.00");
  });

  it("目标行 revision 变化 → 计划阶段先拦下（更早的一层防线）", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, payment, correctionId } = await seedPendingRefund(applicant.id);
    await side.payment.update({ where: { id: payment.id }, data: { revision: { increment: 1 } } });

    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("目标账务已变化，请刷新后重新申请");
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
    expect(await effectsOf(correctionId)).toEqual([]);
  });

  it("账务无变化 → 快照一致，正常批准（证明快照不是「永远不等」的摆设）", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, payment, correctionId } = await seedPendingRefund(applicant.id);
    const snapshot = (await readCorrection(correctionId)).requestPayload as { snapshot: string };
    expect(snapshot.snapshot).toMatch(/^[0-9a-f]{64}$/);

    // 重新算一次计划，快照应与申请时完全一致（同案、同数据、同序）
    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .resolves.toBeTruthy();
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("300.00");
  });
});

describe("decideCorrectionTx · 重复决定（拒绝而非幂等）与并发", () => {
  it("已批准的申请再决定 → 「更正申请已处理或发生变化」，钱只退一次", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, payment, correctionId } = await seedPendingRefund(applicant.id);
    await decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" });

    // 用「当前 revision」（1）再批一次：不是 revision 过期，而是状态已非 PENDING
    await expect(decide(finance.id, { id: correctionId, revision: 1, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("更正申请已处理或发生变化");
    // 同一 revision 重复提交同样被拒（说明不是靠 revision 取巧）
    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("更正申请已处理或发生变化");
    // 已批准后改为拒绝也不行
    await expect(decide(finance.id, { id: correctionId, revision: 1, decision: "REJECTED", note: "反悔" }))
      .rejects.toThrow("更正申请已处理或发生变化");

    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("300.00");
    expect(await effectsOf(correctionId)).toHaveLength(1);
    expect(await auditsOf(correctionId, "FINANCE_CORRECTION_CONFIRMED")).toHaveLength(1);
  });

  it("revision 过期（并发者已处理，客户端还在旧页）→ 拒绝，且不覆盖前一次决定", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, correctionId } = await seedPendingRefund(applicant.id);
    await decide(finance.id, { id: correctionId, revision: 0, decision: "REJECTED", note: "第一次决定：拒绝" });

    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "旧页面点批准" }))
      .rejects.toThrow("更正申请已处理或发生变化");

    const row = await readCorrection(correctionId);
    expect(row.status).toBe("REJECTED");
    expect(row.resolutionNote).toBe("第一次决定：拒绝");
    expect(row.confirmedById).toBeNull();
  });

  it("两个财务同时批准同一申请：只成交一次，退款额不翻倍", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, payment, correctionId } = await seedPendingRefund(applicant.id);
    const financeB = await seedUser("FINANCE");
    const input = { id: correctionId, revision: 0, decision: "CONFIRMED" as const, note: "" };

    const results = await Promise.allSettled([decide(finance.id, input), decide(financeB.id, input)]);
    const ok = results.filter(r => r.status === "fulfilled");
    const failed = results.filter(r => r.status === "rejected") as PromiseRejectedResult[];

    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // 后到者要么在行锁后读到「已处理」（ActionError），要么被 Serializable 判为并发更新
    const message = failed[0].reason instanceof Error ? failed[0].reason.message : String(failed[0].reason);
    expect(message).toMatch(/更正申请已处理或发生变化|40001|could not serialize|P2034/);

    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("300.00");
    expect(await effectsOf(correctionId)).toHaveLength(1);
    expect(await prisma.financeCorrection.findUniqueOrThrow({ where: { id: correctionId } }).then(r => r.revision)).toBe(1);
  }, 60_000);
});

/* ================================================================== *
 * C · 读取与写入两侧的隔离墙边界（发现的缺口，如实固定当前行为）
 * ================================================================== */
describe("隔离墙与更正决定的交叉（当前行为的如实记录）", () => {
  /**
   * `src/lib/permissions/ethical-wall.ts` 的设计约束第 2 条写明「只在读取链路拦截；
   * 写操作本就要求主办/成员身份，被隔离的人通常也不具备」。财务复核是例外：
   * `assertLedgerWrite` 对内置财务岗（globalFinance）不做案件关联校验，也不查墙，
   * 因此**被隔离的财务仍能批准该案的更正**。本条用例固定这个事实，避免它被当成
   * 「已经防住了」而在后续审计里漏掉。何时修、怎么修属于产品口径决定，不在本轮。
   */
  it("隔离墙同时拦住该案的读取与财务写操作（2026-11-20 修复后）", async () => {
    const applicant = await seedUser("LAWYER");
    const { finance, matter, payment, correctionId } = await seedPendingRefund(applicant.id);
    await seedWall({ matterId: matter.id, createdById: finance.id, denials: [{ denyType: "USER", userId: finance.id }] });

    // 读取侧：被挡住
    as(finance);
    await expect(getFinanceLedger(matter.id)).rejects.toThrow("案件不存在或无权查看财务");
    expect((await getFinanceLedger()).matters.map(m => m.id)).not.toContain(matter.id);

    // 写入侧：同样被挡住 —— 这是 2026-11-20 补上的那条防线。
    // 修复前：assertLedgerWrite 只查成员关系，财务岗甚至跳过成员校验，
    // 于是「读不到却改得了」，同一人能把 300 元退出去。
    // 修复后：assertLedgerWrite 在成员校验之后加 isMatterWalledFor 判定，
    // 文案与读取侧一致（不泄露案件是否存在）。
    await expect(decide(finance.id, { id: correctionId, revision: 0, decision: "CONFIRMED", note: "" }))
      .rejects.toThrow("案件不存在或无权处理");

    // 钱没动、状态没变 —— 这才是隔离墙的意义：不是「看不到」，是「碰不到」
    expect((await readCorrection(correctionId)).status).toBe("PENDING");
    expect(dec(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }).then(p => p.refundedAmount))).toBe("0.00");
  });
});
