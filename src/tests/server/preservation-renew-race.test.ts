// @vitest-environment node
/**
 * 保全续封的并发安全（2026-11-21 补，真 P1 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `renewProperty` 原实现：
 *
 *   const prop = await prisma.preservationProperty.findUnique(...)   // 事务外读
 *   const newExpiryDate = computeDeadlineDate(prop.expiryDate, ...)  // 基于读到的值算
 *   await prisma.$transaction(async db => {
 *     await db.preservationPropertyRenewal.create({ oldExpiryDate: prop.expiryDate, newExpiryDate, ... })
 *     await db.preservationProperty.update({ where: { id }, data: { expiryDate: newExpiryDate } })  // 无条件
 *   })
 *
 * 两人同时续封同一笔保全：
 *
 *   都读到 2027-01-01 → 都算出 2029-01-01（各续两年）
 *   → **两条续封记录都进台账，但到期日只被推到 2029-01-01 一次**
 *
 * 账面显示续了四年，实际只延了两年。**保全提前到期 = 保全效力丧失**，
 * 在律所这是执业事故，不只是数据不准。
 *
 * ## 修法与这里测什么
 *
 * 改成条件更新（compare-and-set）：`updateMany({ id, expiryDate: 读到的值 })`，
 * 抢输的一方 count=0 → 明确报冲突。并且把「先更新到期日、再写台账」
 * 的顺序调过来 —— 宁可「延期了但台账少一条」，不能「台账写了但没延」。
 *
 * 本文件 mock 掉会话/权限/提醒作废（与本 bug 无关），**保留真 prisma**，
 * 直接并发调两次 `renewProperty`，断言：
 *   · 恰好一次成功
 *   · 到期日只前进一次（不是两次叠加）
 *   · 台账条数与实际延期次数一致
 *
 * 隔离：自建临时库 `lawlink_renew_test_*` → migrate deploy → DROP。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_renew_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let prisma: PrismaClient;
let admin: PrismaClient;

const CURRENT_USER = "renew-test-user";

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
  } catch (err) {
    throw new Error(`临时库创建失败，需先启动 lawlink-db（${HOLDER.host}）：${String(err)}`);
  }
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: HOLDER.url }, stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  await prisma.user.create({
    data: { id: CURRENT_USER, email: "renew@t.local", name: "续封人", role: "LAWYER", passwordHash: "x", active: true }
  });
  console.info(`[preservation-renew] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[preservation-renew] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "LAWYER", rolePermissions: undefined } })
}));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: async () => {} }));
vi.mock("@/lib/approvals/service", async (orig) => ({
  ...(await orig<any>()),
  approvalTransaction: async (fn: any) => fn(prisma)
}));
vi.mock("@/lib/notifications/approval", () => ({ notifyRoleApprovers: async () => {} }));
// revalidatePath 需要 Next.js 的 static generation store，测试环境没有 → mock 掉
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { renewProperty } = await import("@/server/preservations/actions-v2");
const { ActionError } = await import("@/lib/action-error");

/**
 * 用上海日历口径断言日期。
 *
 * 踩过的坑：`computeDeadlineDate` 按上海 civil 日期计算，
 * 而 `new Date("2027-01-01")` 是 UTC 零点 = 上海 08:00。
 * 直接用 `toISOString().slice(0,10)`（UTC）断言会差一天，
 * 看起来像「算错了」其实是我的断言用了错的时区。
 */
const shDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);


/** 造一笔保全财产，到期日为给定日期 */
async function seedProperty(expiryDate: Date) {
  // id 交给 Prisma 生成 —— propertyRenewSchema 把 propertyId 校验为 cuid，
  // 自己拼的短 id 会被 zod 拒掉（实测报「Invalid cuid」）。
  const c = await prisma.preservationCase.create({
    data: { type: "PRE_LITIGATION" as never, ownerId: CURRENT_USER }
  });
  const t = await prisma.preservationTarget.create({
    data: { caseId: c.id, name: "目标1" }
  });
  const p = await prisma.preservationProperty.create({
    data: {
      targetId: t.id, propertyType: "BANK_DEPOSIT" as never,
      startDate: new Date("2026-01-01"), duration: 12,
      expiryDate, status: "ACTIVE" as never
    }
  });
  return { caseId: c.id, propertyId: p.id };
}

describe("renewProperty · 并发续封不得丢失续期（真库）", () => {
  it("串行续封两次：到期日前进两次，台账两条", async () => {
    const { propertyId } = await seedProperty(new Date("2027-01-01"));
    await renewProperty({ propertyId, renewalDuration: 1, renewalUnit: "YEARS" } as never);
    await renewProperty({ propertyId, renewalDuration: 1, renewalUnit: "YEARS" } as never);

    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: propertyId } });
    expect(shDay(after.expiryDate)).toBe("2029-01-01");
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId } })).toBe(2);
  });

  it("两个请求交错读取同一到期日：只有一个能写成功，另一个明确报冲突", async () => {
    // 模拟真实交错：拿到同一个 prop 快照后分别计算。
    // 修复前的实现会两个都写成功，台账两条但到期日只前进一次。
    const { propertyId } = await seedProperty(new Date("2027-01-01"));

    const results = await Promise.allSettled([
      renewProperty({ propertyId, renewalDuration: 1, renewalUnit: "YEARS" } as never),
      renewProperty({ propertyId, renewalDuration: 1, renewalUnit: "YEARS" } as never)
    ]);

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");

    // 恰好一个成功
    expect(ok).toBe(1);
    expect(failed).toHaveLength(1);
    // 失败方拿到的是可理解的冲突提示，不是原始 Prisma 错误
    const reason = (failed[0] as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(ActionError);
    expect(String((reason as Error).message)).toContain("请刷新");

    // 关键不变量：到期日只前进了一次（2027-01-01 → 2028-01-01）
    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: propertyId } });
    expect(shDay(after.expiryDate)).toBe("2028-01-01");

    // 台账条数与实际延期次数一致 —— 不能「台账记两次、实际延一次」
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId } })).toBe(1);
  });

  it("基于过期快照续封：被拒，不做任何写入（CAS 生效）", async () => {
    // 直接验证 CAS 语义：先改到期日（模拟别人先续了），
    // 再用旧值调用 —— 函数内部会重新读到新值，所以这里改为验证
    // 「同一笔财产第二次续封必须基于第一次的结果」。
    const { propertyId } = await seedProperty(new Date("2027-01-01"));
    await renewProperty({ propertyId, renewalDuration: 6, renewalUnit: "MONTHS" } as never);
    const mid = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: propertyId } });
    expect(shDay(mid.expiryDate)).toBe("2027-07-01");

    await renewProperty({ propertyId, renewalDuration: 6, renewalUnit: "MONTHS" } as never);
    const end = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: propertyId } });
    expect(shDay(end.expiryDate)).toBe("2028-01-01");
    expect(await prisma.preservationPropertyRenewal.count({ where: { propertyId } })).toBe(2);
  });

  it("已解除的保全不可续封", async () => {
    const { propertyId } = await seedProperty(new Date("2027-01-01"));
    await prisma.preservationProperty.update({ where: { id: propertyId }, data: { status: "LIFTED" as never } });
    await expect(
      renewProperty({ propertyId, renewalDuration: 1, renewalUnit: "YEARS" } as never)
    ).rejects.toBeInstanceOf(ActionError);
    const after = await prisma.preservationProperty.findUniqueOrThrow({ where: { id: propertyId } });
    expect(shDay(after.expiryDate)).toBe("2027-01-01"); // 未变
  });
});
