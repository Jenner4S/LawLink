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
 *
 * 2026-11-19 续保 API 改造（本文件随之改写）：
 * `renewProperty` 不再接受调用方算好的 newExpiryDate，只收
 * `{ renewalDuration, renewalUnit }`，日期由服务端 `computeDeadlineDate` 计算——
 * 与「默认到期日」同一个函数，跨闰年不再少一天、月末自动钳制。
 * 故旧用例 A2/A8/A9 固化的那三个缺陷**已被消除**，改为断言「新契约下缺陷无法复现」；
 * A7（EXPIRED 仍可续保）不在本次改动范围，按原口径保留并标注。
 *
 * 日期断言口径：`computeDeadlineDate` 会把结果归一到**本地日界 00:00**，
 * 而夹具 `civil()` 用的是正午载体（避免 UTC 偏移一天），二者不能混用
 * `toEqual(civil(...))` —— 续保**之后**的日期一律用 `dayStart(...)` 断言。
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
  // ⚠️ 已知迁移缺口（不在本文件修复范围；按任务约束未改迁移文件，问题已列入报告）：
  // prisma/migrations/20261119000005_renewal_unit/migration.sql 是 0 字节空迁移，
  // 但在 _prisma_migrations 里被登记为「已应用」。后果是 `migrate deploy` 建出的库
  //（新装库、本临时库，乃至当前主库）都没有 PreservationPropertyRenewal.renewalUnit 列，
  // 而 schema.prisma 与生成的 Prisma Client 都已包含它 —— 任何续保写入/读取都会
  // P2022「column renewalUnit does not exist」。
  // 这里只在**临时库**上按 schema.prisma 补这一列（等价于该迁移本应写入的 SQL，
  // `prisma migrate diff` 的唯一差异也就是它），使本文件能验新 API 的行为；
  // 主库缺口修好后本步骤自动成为 no-op。
  const [{ count: renewalUnitColumns }] = await prisma.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM information_schema.columns
    WHERE table_name = 'PreservationPropertyRenewal' AND column_name = 'renewalUnit'
  `;
  if (renewalUnitColumns === 0) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "PreservationPropertyRenewal" ADD COLUMN "renewalUnit" "DeadlinePeriodUnit" NOT NULL DEFAULT 'DAYS'`
    );
    console.warn("[preservation-crud] 临时库补列 renewalUnit（空迁移 20261119000005 未包含 DDL）");
  }
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
/** 本地日界 00:00：computeDeadlineDate 的产出形态（addDays/addMonthsClamped 都先 startOfDay） */
const dayStart = (y: number, m: number, d: number) => new Date(y, m - 1, d);
const DAY = 86_400_000;

/** 只取日历日（年月日），忽略时刻——用于断言「换了哪一天」而不是「差了几毫秒」 */
const ymd = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()] as const;
/** 两个日期之间的日历日差（各自先归到本地日界，再按整天取整） */
const dayDiff = (from: Date, to: Date) =>
  Math.round(
    (new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime() -
      new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime()) /
      DAY
  );
/** 两个日期之间的整月差（跨年按 12 个月折算） */
const monthDiff = (from: Date, to: Date) =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

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
        renewalDuration: 1,
        renewalUnit: "YEARS",
        note: "试图续保已解除财产"
      })
    ).rejects.toThrow("已解除的保全不可续保");

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("LIFTED");
    expect(after.expiryDate).toEqual(before.expiryDate);
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it("A2 到期日必须后移 → 新 API 下在入参层就被拒（0 / 负数 / 非整数 / 非法单位），不落台账不改库", async () => {
    // 旧 API 由调用方传日期，服务端只能做「必须晚于原到期日」的兜底比较，于是
    // 「传相等或更早的日期」是可构造的攻击面。新 API 只收正整数 + 单位：
    // computeDeadlineDate 的最小时长是 1 天且先归一日界，结果必然落在原日历日之后，
    // 「到期日不后移」在接口层已经构造不出来 —— 校验前移到入参边界。
    // actions-v2 里那条「新到期日必须晚于原到期日」守卫保留为防御代码（无合法入参可触发）。
    const { lawyer, property } = await seedChain();
    as(lawyer);

    await expect(
      renewProperty({ propertyId: property.id, renewalDuration: 0, renewalUnit: "YEARS" })
    ).rejects.toThrow("输入信息有误，请检查后重试");

    await expect(
      renewProperty({ propertyId: property.id, renewalDuration: -1, renewalUnit: "DAYS" })
    ).rejects.toThrow("输入信息有误，请检查后重试");

    await expect(
      renewProperty({ propertyId: property.id, renewalDuration: 1.5, renewalUnit: "MONTHS" })
    ).rejects.toThrow("输入信息有误，请检查后重试");

    await expect(
      renewProperty({
        propertyId: property.id,
        renewalDuration: 1,
        renewalUnit: "WEEKS" as never // 旧版本没有单位字段，这里钉住「单位是封闭集合」
      })
    ).rejects.toThrow("输入信息有误，请检查后重试");

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.expiryDate).toEqual(civil(2028, 6, 15));
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
  });

  it("A3 正常续保：续期台账落库（旧/新到期日、期限数值+单位、经办人、续保时刻）、财产转 RENEWED 并更新到期日", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const pending = await seedPendingReminder(property.id, 30, "2026-11-20");
    const startedAt = new Date();

    const result = await renewProperty({
      propertyId: property.id,
      renewalDuration: 1,
      renewalUnit: "YEARS",
      note: "  银行续冻一年  "
    });

    expect(result).toEqual({ ok: true });

    const renewals = await prisma.preservationPropertyRenewal.findMany({ where: { propertyId: property.id } });
    expect(renewals).toHaveLength(1);
    expect(renewals[0].oldExpiryDate).toEqual(civil(2028, 6, 15)); // 原值原样留存（正午载体）
    expect(renewals[0].newExpiryDate).toEqual(dayStart(2029, 6, 15)); // 计算结果归一到日界
    // 台账新语义：存「数值 + 单位」，不再把年折成 365 天（折天数正是旧缺陷的根源）
    expect(renewals[0].renewalDuration).toBe(1);
    expect(renewals[0].renewalUnit).toBe("YEARS");
    expect(renewals[0].performedById).toBe(lawyer.id);
    expect(renewals[0].note).toBe("银行续冻一年");
    // 续保时刻是「真实当前时刻」而不是到期日或其它日期
    expect(renewals[0].renewedAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1000);
    expect(renewals[0].renewedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("RENEWED");
    expect(after.expiryDate).toEqual(dayStart(2029, 6, 15));

    // 改期后旧档位提醒登记作废（SUPERSEDED / RENEWED），防止按旧到期日误发
    const ledger = await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } });
    expect(ledger.status).toBe("SUPERSEDED");
    expect(ledger.detail).toEqual({ reason: "RENEWED" });
  });

  it("A4 连续续保两次：第二次的旧到期日接续第一次的新到期日（台账成链，不覆盖）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);

    await renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" });
    await renewProperty({ propertyId: property.id, renewalDuration: 2, renewalUnit: "YEARS" });

    const renewals = await prisma.preservationPropertyRenewal.findMany({
      where: { propertyId: property.id },
      orderBy: [{ renewedAt: "asc" }, { createdAt: "asc" }]
    });
    expect(renewals).toHaveLength(2);
    expect(renewals[0].oldExpiryDate).toEqual(civil(2028, 6, 15));
    expect(renewals[0].newExpiryDate).toEqual(dayStart(2029, 6, 15));
    expect(renewals[0].renewalDuration).toBe(1);
    expect(renewals[1].oldExpiryDate).toEqual(dayStart(2029, 6, 15)); // 接续第一次的新到期日
    expect(renewals[1].newExpiryDate).toEqual(dayStart(2031, 6, 15));
    expect(renewals[1].renewalDuration).toBe(2);

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(dayStart(2031, 6, 15));
    expect(after.status).toBe("RENEWED");
  });

  // ── 续保期限计算的边界（跨年 / 2 月 29 日 / 月末）──
  it("A5 闰日到期续保一年：2028-02-29 + 1 年 = 2029-02-28（addMonthsClamped 把闰日钳到月末，不溢出到 3-01）", async () => {
    const { lawyer, property } = await seedChain({ expiryDate: civil(2028, 2, 29) });
    as(lawyer);

    // 旧算法（原到期日 + 365 天）在这一天同样落到 2029-02-28 —— 所以本用例本身
    // 不是「闰年少一天」的场景（真正的少一天见 A12），它验的是月末钳制方向。
    const legacyByDays = new Date(property.expiryDate.getTime() + 365 * DAY);
    expect(ymd(legacyByDays)).toEqual([2029, 2, 28]);

    await renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(dayStart(2029, 2, 28));
    // 不是 3 月 1 日（多算），也不是 2029-02-27（少算）
    expect(after.expiryDate).not.toEqual(dayStart(2029, 3, 1));
    expect(ymd(after.expiryDate)).not.toEqual([2029, 2, 27]);
  });

  it("A6 跨年续保：2028-12-31 + 1 年 = 2029-12-31（跨年不丢一天，也不溢出到次年 1 月）", async () => {
    const { lawyer, property } = await seedChain({ expiryDate: civil(2028, 12, 31) });
    as(lawyer);

    await renewProperty({
      propertyId: property.id,
      renewalDuration: 1,
      renewalUnit: "YEARS"
    });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(dayStart(2029, 12, 31));
    expect(ymd(after.expiryDate)).not.toEqual([2030, 1, 1]);
  });

  // ── 缺陷固化 ──

  it("A7【缺陷固化 D-1】已到期（EXPIRED，财产事实上已解封）仍可续保，被改回 RENEWED 复活", async () => {
    // 到期扫描把过期财产置 EXPIRED（见 scan-due-reminders）。此后续保应当被拦下
    // （保全已失效，须重新申请保全裁定），但 renewProperty 只拦 LIFTED。
    // 2026-11-19 的「数值 + 单位」改造**不改变**该行为，故按原口径保留：
    // 这是已记录、待产品决策的缺陷，不是本次新 API 引入的回归。
    const { lawyer, property } = await seedChain({ status: "EXPIRED", expiryDate: civil(2026, 10, 1) });
    as(lawyer);

    await expect(
      renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" })
    ).resolves.toEqual({ ok: true });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("RENEWED"); // ← 已失效的保全被「复活」
    expect(after.expiryDate).toEqual(dayStart(2027, 10, 1)); // 从已过的原到期日再续一年
  });

  it("A8【已消除 D-2】台账的 duration×unit 与落库日期增量恒等：日期由服务端算，二者不可能再不一致", async () => {
    // 旧 API：renewalDuration 只是台账文本，到期日完全由调用方给，可写「续保 365 天、实际只推 1 天」，
    // 事后无法用台账证明真实续保区间。
    // 新 API：newExpiryDate = computeDeadlineDate(oldExpiryDate, duration, unit)，与台账同源，
    // 本用例按 DAYS / MONTHS / YEARS 三种单位逐一验证「写进去的期限」＝「实际推进的日历量」。
    const combos = [
      { duration: 1, unit: "DAYS" as const, expectDate: dayStart(2028, 6, 16), expectDays: 1 },
      { duration: 6, unit: "MONTHS" as const, expectDate: dayStart(2028, 12, 15), expectMonths: 6 },
      { duration: 1, unit: "YEARS" as const, expectDate: dayStart(2029, 6, 15), expectMonths: 12 }
    ];

    for (const combo of combos) {
      const { lawyer, property } = await seedChain();
      as(lawyer);

      await renewProperty({
        propertyId: property.id,
        renewalDuration: combo.duration,
        renewalUnit: combo.unit
      });

      const renewal = await prisma.preservationPropertyRenewal.findFirstOrThrow({
        where: { propertyId: property.id }
      });
      // ① 台账原样存下调用方给的数值 + 单位（不再折算成天数）
      expect(renewal.renewalDuration).toBe(combo.duration);
      expect(renewal.renewalUnit).toBe(combo.unit);
      // ② 旧到期日原样留存，新到期日 = 按期限推进后的日历日
      expect(renewal.oldExpiryDate).toEqual(civil(2028, 6, 15));
      expect(renewal.newExpiryDate).toEqual(combo.expectDate);
      // ③ 台账声明的期限与实际距离恒等（按日历折算，不受时刻影响）
      if (combo.unit === "DAYS") {
        expect(dayDiff(renewal.oldExpiryDate, renewal.newExpiryDate)).toBe(combo.expectDays);
      } else {
        expect(monthDiff(renewal.oldExpiryDate, renewal.newExpiryDate)).toBe(combo.expectMonths);
        // 按月/年推进时「日」保持不变（无钳制场景）
        expect(renewal.newExpiryDate.getDate()).toBe(renewal.oldExpiryDate.getDate());
      }
      // ④ 财产到期日与台账新到期日同一来源
      const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
      expect(after.expiryDate).toEqual(combo.expectDate);
    }
  });

  it("A9【已消除 D-3】新 API 构造不出「同一日历日只把时刻挪后」的续保：最小 1 天必然后移一个日历日", async () => {
    // 旧 API 只比较毫秒（newExpiryDate > oldExpiryDate），把 12:00 挪到 13:00 也算一次续保，
    // 日历日没变却记成 RENEWED。
    // 新 API 的 computeDeadlineDate 先 startOfDay 归一日界再推进，最小单位 1 天，
    // 结果永远落在原日历日之后 —— 同日毫秒微调在接口层无法表达。
    const { lawyer, property } = await seedChain(); // 到期 2028-06-15 12:00
    as(lawyer);

    await expect(
      renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "DAYS" })
    ).resolves.toEqual({ ok: true });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(ymd(after.expiryDate)).toEqual([2028, 6, 16]); // 日历日确实后移
    // 日历口径的后移量正好 1 天（正午基准 → 次日日界，真瞬间只差 12 小时：
    // 这正是旧实现按毫秒比较会看错的地方，新实现按日历日推进）
    expect(dayDiff(property.expiryDate, after.expiryDate)).toBe(1);
    expect(after.expiryDate.getTime()).toBeGreaterThan(property.expiryDate.getTime());
    expect(after.status).toBe("RENEWED");

    // 取最极端的基准（当日 23:59:59.999）也同样跨日：归一日界后 +1 天 = 次日 00:00，
    // 不可能留在同一天里「只往后挪几毫秒」。
    const edge = await seedChain({ expiryDate: new Date(2028, 5, 15, 23, 59, 59, 999) });
    as(edge.lawyer);
    await renewProperty({ propertyId: edge.property.id, renewalDuration: 1, renewalUnit: "DAYS" });

    const edgeAfter = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: edge.property.id } });
    expect(ymd(edgeAfter.expiryDate)).toEqual([2028, 6, 16]);
    expect(edgeAfter.expiryDate).toEqual(dayStart(2028, 6, 16));
  });

  it("A10 续保校验失败时不产生台账、不改状态、也不顺手作废已有提醒（拒绝路径先于写入）", async () => {
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const pending = await seedPendingReminder(property.id);

    // 业务上限（schema max 3600）被拒：越长的续保本身也不受法定期限保护
    await expect(
      renewProperty({ propertyId: property.id, renewalDuration: 3601, renewalUnit: "DAYS" })
    ).rejects.toThrow("输入信息有误，请检查后重试");

    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId: property.id } })).toBe(0);
    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("ACTIVE");
    expect(after.expiryDate).toEqual(civil(2028, 6, 15));
    // 被拒的续保不应顺手作废已有的提醒登记
    expect((await prisma.reminderDelivery.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
  });

  it("A11 财产不存在 → 「保全财产不存在」", async () => {
    const lawyer = await seedUser("LAWYER");
    as(lawyer);
    await expect(
      renewProperty({ propertyId: cid("ghost"), renewalDuration: 1, renewalUnit: "YEARS" })
    ).rejects.toThrow("保全财产不存在");
  });

  // ── 本次修复的价值（旧 API 在这两条上会算错/溢出）──
  it("A12 跨闰年不少一天：2027-06-15 续保 1 年 = 2028-06-15（旧「+365 天」只得 2028-06-14）", async () => {
    const { lawyer, property } = await seedChain({ expiryDate: civil(2027, 6, 15) });
    as(lawyer);

    // 旧算法基准：原到期日 + 365 × 86400000。2028 是闰年，这样算会比法定一年少一天。
    const legacyByDays = new Date(property.expiryDate.getTime() + 365 * DAY);
    expect(ymd(legacyByDays)).toEqual([2028, 6, 14]);
    expect(ymd(legacyByDays)).not.toEqual([2028, 6, 15]);

    await renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" });

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.expiryDate).toEqual(dayStart(2028, 6, 15));
    expect(after.status).toBe("RENEWED");

    const renewal = await prisma.preservationPropertyRenewal.findFirstOrThrow({
      where: { propertyId: property.id }
    });
    expect(ymd(renewal.oldExpiryDate)).toEqual([2027, 6, 15]);
    expect(ymd(renewal.newExpiryDate)).toEqual([2028, 6, 15]);
    expect(renewal.renewalDuration).toBe(1);
    expect(renewal.renewalUnit).toBe("YEARS");

    // 调用方即便按旧签名多塞一个算错的 newExpiryDate 也不会生效：该字段已不在 schema 内
    //（zod 默认 strip 未知键），日期只由 duration + unit 决定 —— 防止旧调用方式回潮再少一天。
    const legacyCaller = await seedChain({ expiryDate: civil(2027, 6, 15) });
    as(legacyCaller.lawyer);
    await renewProperty({
      propertyId: legacyCaller.property.id,
      renewalDuration: 1,
      renewalUnit: "YEARS",
      newExpiryDate: civil(2028, 6, 14) // ← 旧字段，已被 schema 移除
    } as never);

    const legacyAfter = await prisma.preservationProperty.findUniqueOrThrow({
      where: { id: legacyCaller.property.id }
    });
    expect(legacyAfter.expiryDate).toEqual(dayStart(2028, 6, 15)); // 落库仍是 06-15，不是传入的 06-14
  });

  it("A13 月末钳制：1-31 续保 1 个月 → 闰年 2-29 / 平年 2-28（不溢出到 3 月，也不少一天）", async () => {
    // 闰年：2028-01-31 + 1 月 → 2028-02-29（2 月最后一日）
    const leap = await seedChain({ expiryDate: civil(2028, 1, 31) });
    as(leap.lawyer);
    await renewProperty({ propertyId: leap.property.id, renewalDuration: 1, renewalUnit: "MONTHS" });

    const leapAfter = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: leap.property.id } });
    expect(leapAfter.expiryDate).toEqual(dayStart(2028, 2, 29));
    expect(ymd(leapAfter.expiryDate)).not.toEqual([2028, 3, 1]);

    // 平年：2027-01-31 + 1 月 → 2027-02-28
    const common = await seedChain({ expiryDate: civil(2027, 1, 31) });
    as(common.lawyer);
    await renewProperty({ propertyId: common.property.id, renewalDuration: 1, renewalUnit: "MONTHS" });

    const commonAfter = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: common.property.id } });
    expect(commonAfter.expiryDate).toEqual(dayStart(2027, 2, 28));
    expect(ymd(commonAfter.expiryDate)).not.toEqual([2027, 3, 1]); // 不溢出
    expect(ymd(commonAfter.expiryDate)).not.toEqual([2027, 2, 27]); // 不少算
    expect(commonAfter.status).toBe("RENEWED");

    // 台账记录的是同一个钳制后日期（台账与财产同一来源，不是两处各算一遍）
    const renewal = await prisma.preservationPropertyRenewal.findFirstOrThrow({
      where: { propertyId: common.property.id }
    });
    expect(ymd(renewal.oldExpiryDate)).toEqual([2027, 1, 31]);
    expect(ymd(renewal.newExpiryDate)).toEqual([2027, 2, 28]);
    expect(renewal.renewalUnit).toBe("MONTHS");
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

  it("B2 解除写审计（D-4 已于 2026-11-21 修复；此前这条测的是缺陷本身）", async () => {
    // 这条原本是「缺陷固化」用例：断言解除**不**写审计（action 含 LIFT 的条数为 0）。
    // 2026-11-21 多智能体审计把它列为真缺口并修掉了 ——
    // 解除保全是律所高风险动作（解除后财产可能被转移），
    // 「谁在什么时候解除的」必须查得到。现在改为断言修复后的行为。
    //
    // 仍如实保留的事实：schema 上没有 liftedAt 字段，解除时间靠审计时间戳表达。
    // 这是有意的取舍（不为一个时间点加迁移），但**审计必须存在**，否则连间接线索都没有。
    const { lawyer, property } = await seedChain();
    as(lawyer);
    const before = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(Object.keys(before)).not.toContain("liftedAt");

    await liftProperty(property.id);

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.status).toBe("LIFTED");
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    const logs = await prisma.auditLog.findMany({
      where: { targetId: property.id, action: "PRESERVATION_PROPERTY_LIFT" },
      select: { userId: true, createdAt: true, detail: true }
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].userId).toBe(lawyer.id);
    // 详情里带解除前的到期日 —— 事后能复算「解除时它还剩多久」
    expect(logs[0].detail).toMatchObject({ expiryDate: property.expiryDate.toISOString() });
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
    await renewProperty({ propertyId: property.id, renewalDuration: 2, renewalUnit: "YEARS" });
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
    // 【D-5 已于 2026-11-21 修复】删除财产（连带销毁续保台账）现在写审计。
    // 这条原本断言条数为 0 —— 那是把缺陷固化成期望。删除后原始记录就没了，
    // 审计是唯一还能查到「谁在什么时候删了什么」的地方。
    const delLogs = await prisma.auditLog.findMany({
      where: { action: "PRESERVATION_PROPERTY_DELETE", targetId: property.id },
      select: { userId: true, detail: true }
    });
    expect(delLogs).toHaveLength(1);
    expect(delLogs[0].userId).toBe(lawyer.id);
    expect(delLogs[0].detail).toMatchObject({ propertyType: property.propertyType });
  });

  it("B5 删除被保全人：其名下财产与续保台账一并级联删除", async () => {
    const { lawyer, pcase, target, property } = await seedChain();
    as(lawyer);
    await renewProperty({ propertyId: property.id, renewalDuration: 2, renewalUnit: "YEARS" });

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
    await renewProperty({ propertyId: property.id, renewalDuration: 2, renewalUnit: "YEARS" });

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
    await renewProperty({ propertyId: property.id, renewalDuration: 2, renewalUnit: "YEARS" });

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
      renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" })
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
      renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" })
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
      renewProperty({ propertyId: property.id, renewalDuration: 1, renewalUnit: "YEARS" })
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
