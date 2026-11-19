// @vitest-environment node
/**
 * 财产保全 CRUD / 续保 / 解除 / 到期预警 —— 真库测试。
 *
 * 为什么用真库：保全的核心风险全在「写进去的日期和状态对不对」，
 * 而 `renewProperty` 是 `$transaction` 内三条写（续期台账 → 财产到期日/状态 → 作废
 * 残余 PENDING 提醒登记），`liftProperty` 是两条写，级联删除靠的是数据库外键
 * （PreservationTarget / PreservationProperty / Renewal 三级 Cascade，Matter → SetNull，
 * ReminderDelivery 是纯字符串 objectId 无外键）。mock 掉这些只剩「我调用了某个函数」，
 * 拿不到任何关于法定期限是否算对的证据。
 *
 * 隔离：本文件自建临时库 `lawlink_pres_test_*`（lawlink-db:55432），只跑
 * `prisma migrate deploy` 建结构，运行结束 `DROP DATABASE ... WITH (FORCE)`。
 * **绝不写主库 lawlink**。前置条件：lawlink-db 容器可用（55432 端口）。
 *
 * 被测：src/server/preservations/actions-v2.ts（13 个导出，此前零覆盖）。
 * 发现的生产缺陷不在这里修，只做「缺陷固化」断言 + 报告（见文件末尾 D-1…D-8）。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.PRES_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.PRES_TEST_PG_USER ?? "lawlink";
  const password = process.env.PRES_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_pres_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  // 必须在 @/lib/prisma 单例初始化之前落盘：actions-v2 经 roleMutation / prisma 直连该单例。
  // 记下原值，跑完还原——process.env 在同一 worker 的后续测试文件间是共享的。
  const originalUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url, originalUrl, session: { user: { id: "", role: "LAWYER" } } as any };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/server/matters/route", () => ({
  revalidateMatter: vi.fn(),
  matterHref: (id: string) => `/matters/${id}`
}));
// 会话注入：assertMatterWritable 内部也走 requireSession("personal")，必须一起换成可变会话
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => HOLDER.session),
  getSession: vi.fn(async () => HOLDER.session)
}));

import { prisma } from "@/lib/prisma";
import {
  addProperty,
  addTarget,
  createPreservationCase,
  deletePreservationCase,
  deleteProperty,
  deleteTarget,
  liftProperty,
  listExpiringProperties,
  listPreservationCases,
  renewProperty,
  updateProperty
} from "@/server/preservations/actions-v2";

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

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
  console.info(`[preservation-crud] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[preservation-crud] 已 DROP 临时库：${HOLDER.name}`);
  }
  // 还原环境变量，避免影响同 worker 后续测试文件
  if (HOLDER.originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = HOLDER.originalUrl;
}, 60_000);

// ── 夹具 ──

let seq = 0;
/** zod 的 .cuid() 要求 ID 形如 cuid：以 c 开头、≥9 位、不含连字符 */
const cid = (prefix: string) => `c${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 本地正午日历日（与 UI 的 civilFromKey 同口径，避免 UTC 偏移一天） */
const civil = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12);
const DAY = 86_400_000;

async function seedUser(role: "LAWYER" | "PRINCIPAL_LAWYER" | "ASSISTANT" = "LAWYER", name = "测试律师") {
  const id = cid("user");
  return prisma.user.create({
    data: { id, name, email: `${id}@example.test`, passwordHash: "x", role, active: true }
  });
}

async function seedMatter(ownerId: string, overrides: Partial<{ status: "ARCHIVED" | "IN_PROGRESS"; deletedAt: Date }> = {}) {
  const id = cid("matter");
  return prisma.matter.create({
    data: { id, internalCode: id, title: "保全测试案件", ownerId, ...overrides }
  });
}

async function seedCase(input: {
  matterId?: string | null;
  ownerId?: string | null;
  type?: "PRE_LITIGATION" | "LITIGATION" | "ENFORCEMENT";
}) {
  const id = cid("pcase");
  return prisma.preservationCase.create({
    data: {
      id,
      matterId: input.matterId ?? null,
      ownerId: input.ownerId ?? null,
      type: input.type ?? "LITIGATION",
      court: "北京市朝阳区人民法院"
    }
  });
}

async function seedTarget(caseId: string, name = "被保全人甲") {
  const id = cid("ptarget");
  return prisma.preservationTarget.create({ data: { id, caseId, name } });
}

async function seedProperty(
  targetId: string,
  overrides: Partial<{
    status: "ACTIVE" | "RENEWED" | "EXPIRED" | "LIFTED";
    expiryDate: Date;
    startDate: Date;
    propertyType: "BANK_DEPOSIT" | "REAL_ESTATE" | "VEHICLE" | "EQUITY" | "IP" | "OTHER";
    amount: string;
  }> = {}
) {
  const id = cid("pprop");
  return prisma.preservationProperty.create({
    data: {
      id,
      targetId,
      propertyType: overrides.propertyType ?? "BANK_DEPOSIT",
      propertyDetail: "工商银行 6222****1234",
      amount: overrides.amount ? new Prisma.Decimal(overrides.amount) : new Prisma.Decimal("1000000.00"),
      startDate: overrides.startDate ?? civil(2027, 6, 15),
      duration: 365,
      expiryDate: overrides.expiryDate ?? civil(2028, 6, 15),
      status: overrides.status ?? "ACTIVE"
    }
  });
}

async function seedPendingReminder(propertyId: string, offset = 30, dayKey = "2026-11-19") {
  return prisma.reminderDelivery.create({
    data: {
      objectType: "PRESERVATION_PROPERTY",
      objectId: propertyId,
      kind: "OFFSET",
      offset,
      channel: "IN_APP",
      dayKey,
      userId: "",
      status: "PENDING",
      registeredAt: new Date()
    }
  });
}

/** 完整链路：案件（挂案件）→ 被保全人 → 财产。可指定 owner，使链路归属与当前会话一致 */
async function seedChain(
  opts: {
    status?: "ACTIVE" | "RENEWED" | "EXPIRED" | "LIFTED";
    expiryDate?: Date;
    owner?: { id: string; role: string };
  } = {}
) {
  const lawyer = opts.owner ?? (await seedUser("LAWYER"));
  const matter = await seedMatter(lawyer.id);
  const pcase = await seedCase({ matterId: matter.id });
  const target = await seedTarget(pcase.id);
  const property = await seedProperty(target.id, { status: opts.status, expiryDate: opts.expiryDate });
  return { lawyer, matter, pcase, target, property };
}

const as = (user: { id: string; role: string }) => {
  HOLDER.session.user = { id: user.id, role: user.role };
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// A. 续保 renewProperty —— 最关键
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("renewProperty（续保，真库）", () => {
  it("A1 已解除（LIFTED）的财产续保 → 拒绝「已解除的保全不可续保」，且不改库", async () => {
    const { lawyer, property } = await seedChain({ status: "LIFTED" });
    as(lawyer);
    const before = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });

    await expect(
      renewProperty({
        propertyId: property.id,
        newExpiryDate: civil(2029, 6, 15),
        renewalDuration: 365,
        note: "试图续保已解除财产"
      })
    ).rejects.toThrow("已解除的保全不可续保");

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("LIFTED");
    expect(after.expiryDate).toEqual(before.expiryDate);
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it("A2 新到期日不晚于原到期日 → 拒绝「新到期日必须晚于原到期日」（相等与更早都拒）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);

    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2028, 6, 15), renewalDuration: 365 })
    ).rejects.toThrow("新到期日必须晚于原到期日");

    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2028, 6, 14), renewalDuration: 365 })
    ).rejects.toThrow("新到期日必须晚于原到期日");

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.expiryDate).toEqual(civil(2028, 6, 15));
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it("A3 正常续保：续期台账落库（旧/新到期日、期限、经办人、续保时刻）、财产转 RENEWED 并更新到期日", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const pending = await seedPendingReminder(property.id, 30, "2026-11-20");
    const startedAt = new Date();

    const result = await renewProperty({
      propertyId: property.id,
      newExpiryDate: civil(2029, 6, 15),
      renewalDuration: 365,
      note: "  银行续冻一年  "
    });

    expect(result).toEqual({ ok: true });

    const renewals = await prisma.preservationPropertyRenewal.findMany({ where: { propertyId: property.id } });
    expect(renewals).toHaveLength(1);
    expect(renewals[0].oldExpiryDate).toEqual(civil(2028, 6, 15));
    expect(renewals[0].newExpiryDate).toEqual(civil(2029, 6, 15));
    expect(renewals[0].renewalDuration).toBe(365);
    expect(renewals[0].performedById).toBe(lawyer.id);
    expect(renewals[0].note).toBe("银行续冻一年");
    // 续保时刻是「真实当前时刻」而不是到期日或其它日期
    expect(renewals[0].renewedAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1000);
    expect(renewals[0].renewedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("RENEWED");
    expect(after.expiryDate).toEqual(civil(2029, 6, 15));

    // 改期后旧档位提醒登记作废（SUPERSEDED / RENEWED），防止按旧到期日误发
    const ledger = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ledger.status).toBe("SUPERSEDED");
    expect(ledger.detail).toEqual({ reason: "RENEWED" });
  });

  it("A4 连续续保两次：第二次的旧到期日接续第一次的新到期日（台账成链，不覆盖）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);

    await renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 });
    await renewProperty({ propertyId: property.id, newExpiryDate: civil(2030, 6, 15), renewalDuration: 365 });

    const renewals = await prisma.preservationPropertyRenewal.findMany({
      where: { propertyId: property.id },
      orderBy: { renewedAt: "asc" }
    });
    expect(renewals).toHaveLength(2);
    expect(renewals[0].oldExpiryDate).toEqual(civil(2028, 6, 15));
    expect(renewals[0].newExpiryDate).toEqual(civil(2029, 6, 15));
    expect(renewals[1].oldExpiryDate).toEqual(civil(2029, 6, 15));
    expect(renewals[1].newExpiryDate).toEqual(civil(2030, 6, 15));

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(civil(2030, 6, 15));
    expect(after.status).toBe("RENEWED");
  });

  // ── 续保期限计算的边界（跨年 / 2 月 29 日）──
  it("A5 跨闰年续保一年：2028-02-29 到期 + 365 天 = 2029-02-28（闰日不可续到，日历口径钳到月末）", async () => {
    const { lawyer, property } = await seedChain({ expiryDate: civil(2028, 2, 29) });
    as(lawyer);

    // UI 的续保算法：newExpiry = expiryDate + days*86400000（见 RenewPropertyDialog）
    const nextYear = new Date(property.expiryDate.getTime() + 365 * DAY);
    await renewProperty({ propertyId: property.id, newExpiryDate: nextYear, renewalDuration: 365 });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(civil(2029, 2, 28));
    // 不是 3 月 1 日（多算），也不是 2029-02-27（少算）
    expect(after.expiryDate).not.toEqual(civil(2029, 3, 1));
  });

  it("A6 跨年续保：2028-12-31 到期 + 365 天 = 2029-12-31（跨年不丢一天）", async () => {
    const { lawyer, property } = await seedChain({ expiryDate: civil(2028, 12, 31) });
    as(lawyer);

    await renewProperty({
      propertyId: property.id,
      newExpiryDate: new Date(property.expiryDate.getTime() + 365 * DAY),
      renewalDuration: 365
    });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(civil(2029, 12, 31));
  });

  // ── 缺陷固化 ──

  it("A7【缺陷固化 D-1】已到期（EXPIRED，财产事实上已解封）仍可续保，被改回 RENEWED 复活", async () => {
    // 到期扫描把过期财产置 EXPIRED（见 scan-due-reminders）。此后续保应当被拦下
    // （保全已失效，须重新申请保全裁定），但 renewProperty 只拦 LIFTED。
    const { lawyer, property } = await seedChain({ status: "EXPIRED", expiryDate: civil(2026, 10, 1) });
    as(lawyer);

    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2027, 10, 1), renewalDuration: 365 })
    ).resolves.toEqual({ ok: true });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("RENEWED"); // ← 已失效的保全被「复活」
  });

  it("A8【缺陷固化 D-2】renewalDuration 与新到期日不做一致性校验：期限填 365 天、日期只推后 1 天也接受", async () => {
    // renewalDuration 只是台账文本，到期日完全由调用方给；服务端不按期限重算。
    // 结果：台账写「续保 365 天」，实际只延长 1 天，事后无法用台账证明真实续保区间。
    const { lawyer, property } = await seedChain();
    as(lawyer);

    await renewProperty({
      propertyId: property.id,
      newExpiryDate: new Date(property.expiryDate.getTime() + DAY),
      renewalDuration: 365
    });

    const renewal = await prisma.preservationPropertyRenewal.findFirstOrThrow({
      where: { propertyId: property.id }
    });
    expect(renewal.renewalDuration).toBe(365);
    const actualSpan = Math.round(
      (renewal.newExpiryDate.getTime() - renewal.oldExpiryDate.getTime()) / DAY
    );
    expect(actualSpan).toBe(1); // 台账天数 365 ≠ 实际 1 天
  });

  it("A9【缺陷固化 D-3】同一天只把时刻往后挪也能「续保」成功（校验按毫秒而非日历日）", async () => {
    const { lawyer, property } = await seedChain(); // 到期 2028-06-15 12:00
    as(lawyer);

    await expect(
      renewProperty({
        propertyId: property.id,
        newExpiryDate: new Date(property.expiryDate.getTime() + 3_600_000), // 同日 13:00
        renewalDuration: 1
      })
    ).resolves.toEqual({ ok: true });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    // 日历日没变，却被记为一次「续保」并把状态改成 RENEWED
    expect(after.expiryDate.getFullYear()).toBe(2028);
    expect(after.expiryDate.getMonth()).toBe(5);
    expect(after.expiryDate.getDate()).toBe(15);
    expect(after.status).toBe("RENEWED");
  });

  it("A10 续保校验失败时不产生台账、不改状态（拒绝路径先于写入）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const pending = await seedPendingReminder(property.id);

    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2028, 6, 1), renewalDuration: 365 })
    ).rejects.toThrow("新到期日必须晚于原到期日");

    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
    // 被拒的续保不应顺手作废已有的提醒登记
    expect((await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
  });

  it("A11 财产不存在 → 「保全财产不存在」", async () => {
    const lawyer = await seedUser("LAWYER");
    as(lawyer);
    await expect(
      renewProperty({ propertyId: cid("ghost"), newExpiryDate: civil(2030, 1, 1), renewalDuration: 365 })
    ).rejects.toThrow("保全财产不存在");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// B. 财产生命周期
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("财产生命周期（真库）", () => {
  it("B1 解除：状态转 LIFTED，残余 PENDING 提醒登记作废（CANCELLED / LIFTED）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const pending = await seedPendingReminder(property.id, 15);

    await expect(liftProperty(property.id)).resolves.toEqual({ ok: true });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("LIFTED");
    const ledger = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ledger.status).toBe("CANCELLED");
    expect(ledger.detail).toEqual({ reason: "LIFTED" });
  });

  it("B2【缺陷固化 D-4】解除不落「解除时间」也不写审计：只靠 updatedAt 间接体现", async () => {
    // schema 上 PreservationProperty 无 liftedAt 字段；liftProperty 也只写 status，
    // 不调 audit()。而 addProperty/updateProperty 都写审计 —— 解除是唯一无痕的关键动作。
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const before = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(Object.keys(before)).not.toContain("liftedAt");

    await liftProperty(property.id);

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
    expect(
      await prisma.auditLog.count({ where: { targetId: property.id, action: { contains: "LIFT" } } })
    ).toBe(0);
  });

  it("B3 已解除的再解除：幂等（不抛错、状态仍 LIFTED、不重复作废）", async () => {
    const { lawyer, property } = await seedChain({ status: "LIFTED" });
    as(lawyer);
    const pending = await seedPendingReminder(property.id, 7);

    await expect(liftProperty(property.id)).resolves.toEqual({ ok: true });
    await expect(liftProperty(property.id)).resolves.toEqual({ ok: true });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("LIFTED");
    // 第二次解除没有 PENDING 可作废，登记保持第一次的结果（CANCELLED），不被改写
    const ledger = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ledger.status).toBe("CANCELLED");
    expect(ledger.detail).toEqual({ reason: "LIFTED" });
  });

  it("B4 删除财产：财产与其续保台账级联删除，提醒台账保留为历史（CANCELLED / OBJECT_DELETED）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);
    await renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 });
    const pending = await seedPendingReminder(property.id);
    const renewalCount = await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } });
    expect(renewalCount).toBe(1);

    await expect(deleteProperty(property.id)).resolves.toEqual({ ok: true });

    expect(await prisma.preservationProperty.count({ where: { id: property.id } })).toBe(0);
    // 三级外键：Renewal.propertyId → Cascade
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
    // ReminderDelivery.objectId 是纯字符串，行保留（历史），只把 PENDING 取消
    const ledger = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ledger.status).toBe("CANCELLED");
    expect(ledger.detail).toEqual({ reason: "OBJECT_DELETED" });
    //【缺陷固化 D-5】删除财产（连带销毁续保台账）未写审计
    expect(await prisma.auditLog.count({ where: { action: "PRESERVATION_PROPERTY_DELETE" } })).toBe(0);
  });

  it("B5 删除被保全人：其名下财产与续保台账一并级联删除", async () => {
    const { lawyer, pcase, target, property } = await seedChain();
    as(lawyer);
    await renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 });

    await expect(deleteTarget(target.id)).resolves.toEqual({ ok: true });

    expect(await prisma.preservationTarget.count({ where: { id: target.id } })).toBe(0);
    expect(await prisma.preservationProperty.count({ where: { id: property.id } })).toBe(0);
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
    // 保全案件本身不受影响
    expect(await prisma.preservationCase.count({ where: { id: pcase.id } })).toBe(1);
  });

  it("B6 删除保全案件（主任律师）：案件 → 被保全人 → 财产 → 续保台账 全链级联，并写审计", async () => {
    const principal = await seedUser("PRINCIPAL_LAWYER", "主任律师");
    as(principal);
    const { pcase, target, property } = await seedChain({ owner: principal });
    await renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 });

    await expect(deletePreservationCase({ id: pcase.id })).resolves.toEqual({ ok: true });

    expect(await prisma.preservationCase.count({ where: { id: pcase.id } })).toBe(0);
    expect(await prisma.preservationTarget.count({ where: { id: target.id } })).toBe(0);
    expect(await prisma.preservationProperty.count({ where: { id: property.id } })).toBe(0);
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { action: "PRESERVATION_CASE_DELETE", targetId: pcase.id } })
    ).toBe(1);
  });

  it("B7 非主任律师删除保全案件 → 「仅主任律师可删除保全记录」，记录保留", async () => {
    const lawyer = await seedUser("LAWYER");
    as(lawyer);
    const { pcase } = await seedChain({ owner: lawyer });

    await expect(deletePreservationCase({ id: pcase.id })).rejects.toThrow("仅主任律师可删除保全记录");
    expect(await prisma.preservationCase.count({ where: { id: pcase.id } })).toBe(1);
  });

  it("B8 硬删案件：保全记录不删除，matterId 被置 null（SetNull）——续保台账随之成为孤儿", async () => {
    const { lawyer, matter, pcase, property } = await seedChain();
    as(lawyer);
    await renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 });

    await prisma.matter.delete({ where: { id: matter.id } });

    const orphanCase = await prisma.preservationCase.findUniqueOrThrow({ where: { id: pcase.id } });
    expect(orphanCase.matterId).toBeNull();
    expect(await prisma.preservationProperty.count({ where: { id: property.id } })).toBe(1);
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(1);
  });

  it("B9【缺陷固化 D-6】案件软删后保全案件不再出现在列表（deletedAt 过滤生效）", async () => {
    const { lawyer, matter, pcase } = await seedChain();
    as(lawyer);
    expect((await listPreservationCases({})).some(row => row.id === pcase.id)).toBe(true);

    await prisma.matter.update({ where: { id: matter.id }, data: { deletedAt: new Date() } });

    expect((await listPreservationCases({})).some(row => row.id === pcase.id)).toBe(false);
  });

  it("B10【缺陷固化 D-7】硬删案件后残留的保全财产既不出现在任何人列表，也不进到期预警（沉默失效）", async () => {
    // 案件硬删 → matterId null；而 ownerId 为 null 时访问分支只剩 { matterId: null, ownerId: 本人 }，
    // 谁都匹配不到 → 仍 ACTIVE 的财产彻底失明。理论上不该走到这，但 schema 允许，且无清理任务。
    const { lawyer, matter, pcase, property } = await seedChain({
      expiryDate: new Date(Date.now() + 5 * DAY)
    });
    as(lawyer);
    await prisma.matter.delete({ where: { id: matter.id } });

    expect((await listPreservationCases({})).some(row => row.id === pcase.id)).toBe(false);
    expect((await listExpiringProperties(60)).some(row => row.id === property.id)).toBe(false);
    // 但财产仍是 ACTIVE、到期日在即
    const stillActive = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(stillActive.status).toBe("ACTIVE");
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// C. 到期预警 listExpiringProperties
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("listExpiringProperties（到期预警边界，真库）", () => {
  it("C1 恰好 daysAhead 天到期 → 命中；再多 1 分钟 → 不命中", async () => {
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    const pcase = await seedCase({ matterId: matter.id });
    const target = await seedTarget(pcase.id);
    as(lawyer);
    const daysAhead = 30;
    const now = Date.now();

    const exact = await seedProperty(target.id, { expiryDate: new Date(now + daysAhead * DAY) });
    const justPast = await seedProperty(target.id, { expiryDate: new Date(now + daysAhead * DAY + 60_000) });

    const rows = await listExpiringProperties(daysAhead);
    const ids = rows.map(row => row.id);
    expect(ids).toContain(exact.id);
    expect(ids).not.toContain(justPast.id);
  });

  it("C2 已过期的 ACTIVE 财产仍出现在预警里（无下界，属逾期未处理提示）", async () => {
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    const pcase = await seedCase({ matterId: matter.id });
    const target = await seedTarget(pcase.id);
    as(lawyer);
    const overdue = await seedProperty(target.id, { expiryDate: new Date(Date.now() - 45 * DAY) });

    const rows = await listExpiringProperties(60);
    expect(rows.map(row => row.id)).toContain(overdue.id);
  });

  it("C3 状态过滤：ACTIVE/RENEWED 在列；LIFTED、EXPIRED 不在列（即使到期日落在窗口内）", async () => {
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    const pcase = await seedCase({ matterId: matter.id });
    const target = await seedTarget(pcase.id);
    as(lawyer);
    const soon = () => new Date(Date.now() + 10 * DAY);
    const active = await seedProperty(target.id, { status: "ACTIVE", expiryDate: soon() });
    const renewed = await seedProperty(target.id, { status: "RENEWED", expiryDate: soon() });
    const lifted = await seedProperty(target.id, { status: "LIFTED", expiryDate: soon() });
    const expired = await seedProperty(target.id, { status: "EXPIRED", expiryDate: soon() });

    const ids = (await listExpiringProperties(60)).map(row => row.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(renewed.id);
    expect(ids).not.toContain(lifted.id);
    expect(ids).not.toContain(expired.id);
  });

  it("C4 跨用户隔离：他人案件下的临期财产不出现在我的预警里", async () => {
    const me = await seedUser("LAWYER", "我");
    const other = await seedUser("LAWYER", "同事");
    const myCase = await seedCase({ matterId: (await seedMatter(me.id)).id });
    const otherCase = await seedCase({ matterId: (await seedMatter(other.id)).id });
    const mine = await seedProperty((await seedTarget(myCase.id)).id, { expiryDate: new Date(Date.now() + 10 * DAY) });
    const theirs = await seedProperty((await seedTarget(otherCase.id)).id, { expiryDate: new Date(Date.now() + 10 * DAY) });

    as(me);
    const ids = (await listExpiringProperties(60)).map(row => row.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
  });

  it("C5 排序：按到期日升序（最先到期的排最前）", async () => {
    const lawyer = await seedUser("LAWYER");
    const pcase = await seedCase({ matterId: (await seedMatter(lawyer.id)).id });
    const target = await seedTarget(pcase.id);
    as(lawyer);
    const later = await seedProperty(target.id, { expiryDate: new Date(Date.now() + 20 * DAY) });
    const sooner = await seedProperty(target.id, { expiryDate: new Date(Date.now() + 2 * DAY) });

    const ids = (await listExpiringProperties(60)).map(row => row.id).filter(id => [later.id, sooner.id].includes(id));
    expect(ids).toEqual([sooner.id, later.id]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D. 权限 / 隔离 / 边界
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe("权限与隔离（真库）", () => {
  it("D1 非案件成员试图给别人案件的财产续保 → 「案件不存在或无权关联」", async () => {
    const owner = await seedUser("LAWYER", "案件主办");
    const outsider = await seedUser("LAWYER", "无关律师");
    const matter = await seedMatter(owner.id);
    const pcase = await seedCase({ matterId: matter.id });
    const property = await seedProperty((await seedTarget(pcase.id)).id);

    as(outsider);
    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2030, 1, 1), renewalDuration: 365 })
    ).rejects.toThrow("案件不存在或无权关联");

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.expiryDate).toEqual(civil(2028, 6, 15));
  });

  it("D2 协办（MatterMember）可续保——成员分支放行", async () => {
    const owner = await seedUser("LAWYER", "主办");
    const member = await seedUser("LAWYER", "协办");
    const matter = await seedMatter(owner.id);
    await prisma.matterMember.create({ data: { matterId: matter.id, userId: member.id } });
    const property = await seedProperty((await seedTarget((await seedCase({ matterId: matter.id })).id)).id);

    as(member);
    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 })
    ).resolves.toEqual({ ok: true });
  });

  it("D3 他人未挂案件的保全记录（ownerId=他人）→ 「无权操作此保全记录」", async () => {
    const owner = await seedUser("LAWYER", "记录负责人");
    const outsider = await seedUser("LAWYER", "别人");
    const pcase = await seedCase({ matterId: null, ownerId: owner.id });
    const target = await seedTarget(pcase.id);

    as(outsider);
    await expect(addTarget({ caseId: pcase.id, name: "想加的人" })).rejects.toThrow("无权操作此保全记录");
    expect(await prisma.preservationTarget.count({ where: { caseId: pcase.id } })).toBe(1);
    expect(target.caseId).toBe(pcase.id);
  });

  it("D4【缺陷固化 D-8】未挂案件且未指定负责人的保全记录，创建者也无法再维护（ownerId null 无人可操作）", async () => {
    const lawyer = await seedUser("LAWYER");
    as(lawyer);
    const created = await createPreservationCase({
      matterId: null,
      ownerId: null,
      remindDays: [30, 7, 1],
      type: "PRE_LITIGATION",
      court: ""
    });
    // createPreservationCase 未把 ownerId 兜底为 session.user.id
    const row = await prisma.preservationCase.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.ownerId).toBeNull();

    await expect(addTarget({ caseId: created.id, name: "被保全人" })).rejects.toThrow("无权操作此保全记录");
  });

  it("D5 归档案件禁止续保（归档只读门禁）→ 「案件已归档，禁止修改」", async () => {
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id, { status: "ARCHIVED" });
    const property = await seedProperty((await seedTarget((await seedCase({ matterId: matter.id })).id)).id);

    as(lawyer);
    await expect(
      renewProperty({ propertyId: property.id, newExpiryDate: civil(2029, 6, 15), renewalDuration: 365 })
    ).rejects.toThrow("案件已归档，禁止修改");
  });

  it("D6 添加财产：到期日必须晚于生效日（相等也拒）", async () => {
    const lawyer = await seedUser("LAWYER");
    const pcase = await seedCase({ matterId: (await seedMatter(lawyer.id)).id });
    const target = await seedTarget(pcase.id);
    as(lawyer);

    await expect(
      addProperty({
        targetId: target.id,
        propertyType: "BANK_DEPOSIT",
        startDate: civil(2027, 6, 15),
        expiryDate: civil(2027, 6, 15),
        duration: 365
      })
    ).rejects.toThrow("到期日期必须晚于生效日期");

    await expect(
      addProperty({
        targetId: target.id,
        propertyType: "BANK_DEPOSIT",
        startDate: civil(2027, 6, 15),
        expiryDate: civil(2027, 6, 14),
        duration: 365
      })
    ).rejects.toThrow("到期日期必须晚于生效日期");
    expect(await prisma.preservationProperty.count({ where: { targetId: target.id } })).toBe(0);
  });

  it("D7 新建保全案件（内联首个被保全人+财产）：层级落库正确，金额保留两位小数", async () => {
    const lawyer = await seedUser("LAWYER");
    const matter = await seedMatter(lawyer.id);
    as(lawyer);

    const created = await createPreservationCase({
      matterId: matter.id,
      type: "LITIGATION",
      remindDays: [30, 7, 1],
      court: "  北京市第三中级人民法院  ",
      firstTarget: "  乙公司  ",
      firstPropertyType: "REAL_ESTATE",
      firstPropertyDetail: "  朝阳区某房产  ",
      firstAmount: 1234.5,
      firstStartDate: civil(2027, 1, 1),
      firstDuration: 1095,
      firstExpiryDate: civil(2030, 1, 1)
    });

    const row = await prisma.preservationCase.findUniqueOrThrow({
      where: { id: created.id },
      include: { targets: { include: { properties: true } } }
    });
    expect(row.status).toBe("ACTIVE");
    expect(row.court).toBe("北京市第三中级人民法院");
    expect(row.targets).toHaveLength(1);
    expect(row.targets[0].name).toBe("乙公司");
    expect(row.targets[0].properties).toHaveLength(1);
    expect(row.targets[0].properties[0].propertyType).toBe("REAL_ESTATE");
    expect(row.targets[0].properties[0].propertyDetail).toBe("朝阳区某房产");
    expect(row.targets[0].properties[0].amount?.toFixed(2)).toBe("1234.50");
    expect(row.targets[0].properties[0].expiryDate).toEqual(civil(2030, 1, 1));
    expect(row.targets[0].properties[0].status).toBe("ACTIVE");
    expect(
      await prisma.auditLog.count({ where: { action: "PRESERVATION_CASE_CREATE", targetId: created.id } })
    ).toBe(1);
  });

  it("D8 关联不存在的案件 → 「关联案件不存在」；更新财产不改状态与到期日", async () => {
    const lawyer = await seedUser("LAWYER");
    as(lawyer);
    await expect(
      createPreservationCase({ matterId: cid("nomatter"), type: "LITIGATION", remindDays: [30] })
    ).rejects.toThrow("关联案件不存在");

    const { property } = await seedChain({ owner: lawyer });
    await updateProperty({ id: property.id, amount: 88.8, propertyDetail: "  新说明  " });
    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.amount?.toFixed(2)).toBe("88.80");
    expect(after.propertyDetail).toBe("新说明");
    // 直改不触碰状态/到期日（必须走续期或扫描）
    expect(after.status).toBe("ACTIVE");
    expect(after.expiryDate).toEqual(civil(2028, 6, 15));
  });
});
