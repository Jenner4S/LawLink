// @vitest-environment node
/**
 * 短信一键生成开庭/期限的并发幂等（2026-11-21 补，P2 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `generateHearingFromSms` 原本是：
 *
 *   const existing = await prisma.smsMessage.findUnique({ select: { generatedHearingId } })  // 事务外
 *   if (existing?.generatedHearingId) throw ...
 *   const hearing = await roleMutation(..., db => db.hearing.create({ ... }))              // 事务 1
 *   await roleMutation(..., db => db.smsMessage.update({ generatedHearingId: hearing.id })) // 事务 2
 *
 * 内置岗位的 `roleMutation` **不建事务**（`roles/service.ts:38`），
 * 两次调用完全独立；前面的幂等检查在事务外，拦不住并发。
 *
 * 双击 / 界面重试 / 两个标签页同时点：
 *   都读到 generatedHearingId = null → 都建开庭 → 回写时后者覆盖前者
 *   → **两条开庭，其中一条成为孤儿**（没有任何短信指向它）。
 *   律师日程里出现两条开庭，按错的那条准备材料。
 *
 * 期限更糟：两条一样的期限，办结一条后另一条仍报逾期，律师无法判断哪条是真的。
 *
 * ## 修法与这里测什么
 *
 * 合到一个事务里，用**条件回写**当闸门：
 *   `updateMany({ where: { id, generatedHearingId: null } })` 抢到才继续；
 * 抢输方 count=0 → 抛错 → 整个事务（含刚建的开庭）回滚，不留孤儿。
 *
 * 本文件 mock 掉会话/权限/审计/提醒（与本 bug 无关），**保留真 prisma**，
 * 并发调两次生成函数，断言「只生成一个实体」。
 *
 * 隔离：自建临时库 `lawlink_smsgen_test_*` → migrate deploy → DROP。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_smsgen_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let prisma: PrismaClient;
let admin: PrismaClient;

const CURRENT_USER = "sms-gen-test-user";

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
    data: { id: CURRENT_USER, email: "smsgen@t.local", name: "办案人", role: "LAWYER", passwordHash: "x", active: true }
  });
  console.info(`[sms-generate] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[sms-generate] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "LAWYER", rolePermissions: undefined } })
}));
vi.mock("@/lib/permissions", async (orig) => ({
  ...(await orig<any>()),
  assertCanHandleMatter: async () => {},
  assertCanLeadMatter: async () => {}
}));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: async () => {} }));
vi.mock("@/server/audit", () => ({ audit: async () => {}, auditTx: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (f: any) => f }));
vi.mock("@/server/matters/revalidate", () => ({ revalidateMatter: async () => {} }));
vi.mock("@/server/reminders/schedule", () => ({ refreshScheduleReminderAfterSave: async () => {} }));

const { generateHearingFromSms, generateDeadlineFromSms } = await import("@/server/sms/actions");
const { ActionError } = await import("@/lib/action-error");

/** 造：案件 + 程序 + 一条短信 */
async function seed() {
  const matter = await prisma.matter.create({
    data: {
      internalCode: `LL-${Date.now().toString(36)}`, title: "短信生成测试案",
      category: "CIVIL_COMMERCIAL" as never, status: "IN_PROGRESS",
      serviceStatus: "SERVICE_ACTIVE", teamAccessRestricted: false,
      counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: CURRENT_USER, customValues: {}
    }
  });
  const proc = await prisma.matterProcedure.create({
    data: { matterId: matter.id, type: "FIRST_INSTANCE" as never, order: 1 }
  });
  const sms = await prisma.smsMessage.create({
    data: {
      rawText: "【法院】定于 2026-12-01 09:30 在本院第三法庭开庭",
      receivedById: CURRENT_USER, parsedJson: {}
    }
  });
  return { matterId: matter.id, procedureId: proc.id, smsId: sms.id };
}

describe("短信一键生成 · 并发只生成一个实体（真库）", () => {
  it("并发两次生成开庭：只落一条开庭，另一路明确报错", async () => {
    const { procedureId, smsId } = await seed();

    const results = await Promise.allSettled([
      generateHearingFromSms({ smsId, procedureId, title: "第一次开庭", startsAt: new Date("2026-12-01T09:30:00+08:00") } as never),
      generateHearingFromSms({ smsId, procedureId, title: "第一次开庭", startsAt: new Date("2026-12-01T09:30:00+08:00") } as never)
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected");

    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(ActionError);

    // 关键不变量：只落了一条开庭，没有孤儿
    const hearings = await prisma.hearing.findMany({ where: { procedureId } });
    expect(hearings).toHaveLength(1);

    // 短信指向的就是那一条
    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: smsId } });
    expect(after.generatedHearingId).toBe(hearings[0].id);
    expect(after.processed).toBe(true);
  });

  it("并发两次生成期限：只落一条期限，另一路明确报错", async () => {
    const { procedureId, smsId } = await seed();

    const results = await Promise.allSettled([
      generateDeadlineFromSms({
        smsId, procedureId, title: "提交证据", category: "EVIDENCE" as never,
        dueAt: new Date("2026-11-25T18:00:00+08:00"), remindDays: 3
      } as never),
      generateDeadlineFromSms({
        smsId, procedureId, title: "提交证据", category: "EVIDENCE" as never,
        dueAt: new Date("2026-11-25T18:00:00+08:00"), remindDays: 3
      } as never)
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const deadlines = await prisma.deadline.findMany({ where: { procedureId } });
    expect(deadlines).toHaveLength(1);
    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: smsId } });
    expect(after.generatedDeadlineId).toBe(deadlines[0].id);
  });

  it("串行第二次生成：报「已生成过」，不新增实体", async () => {
    const { procedureId, smsId } = await seed();
    await generateHearingFromSms({ smsId, procedureId, title: "开庭", startsAt: new Date("2026-12-01T09:30:00+08:00") } as never);

    await expect(
      generateHearingFromSms({ smsId, procedureId, title: "开庭", startsAt: new Date("2026-12-01T09:30:00+08:00") } as never)
    ).rejects.toBeInstanceOf(ActionError);

    expect(await prisma.hearing.count({ where: { procedureId } })).toBe(1);
  });

  it("程序不存在时拒绝，不留下任何实体", async () => {
    const { smsId } = await seed();
    await expect(
      generateHearingFromSms({
        smsId, procedureId: "clx0000000000000000000000", title: "开庭", startsAt: new Date()
      } as never)
    ).rejects.toBeInstanceOf(ActionError);
    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: smsId } });
    expect(after.generatedHearingId).toBeNull();
  });
});
