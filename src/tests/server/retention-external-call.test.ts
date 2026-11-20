// @vitest-environment node
/**
 * 外部调用台账保留期（真库，2026-11-22）
 *
 * 运行健康巡检发现：该表**没有任何清理策略**，三天测试回放写了 28148 行。
 * 它是取证资料，要留；但无上限增长会让统计查询变慢。
 * 需要的不是「删」或「不删」，而是**保留期**。
 *
 * 四条口径：
 *  ① 默认保留 365 天（跨年度审计可回看；该表只有调用元数据，无正文与凭据）
 *  ② **设为 0 = 不清理**（有的所要求全量留存取证数据）
 *  ③ 只删 createdAt < cutoff，**永不触碰当期**
 *  ④ 保留期可配置；坏配置回落默认（不让页面白屏）
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

const NAME = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.externalCallLog.deleteMany({});
  await prisma.systemSetting.deleteMany({ where: { key: "retention.externalCallLogDays" } });
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const {
  purgeExternalCallLogs, getExternalCallLogRetentionDays, saveExternalCallLogRetentionDays,
  DEFAULT_EXTERNAL_CALL_LOG_DAYS
} = await import("@/server/settings/retention");

const NOW = new Date("2026-11-22T10:00:00+08:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function seedLog(createdAt: Date) {
  return prisma.externalCallLog.create({
    data: { service: "ai-chat", ok: true, durationMs: 120, createdAt }
  });
}

describe("保留期", () => {
  it("默认 365 天", async () => {
    expect(await getExternalCallLogRetentionDays()).toBe(DEFAULT_EXTERNAL_CALL_LOG_DAYS);
    expect(DEFAULT_EXTERNAL_CALL_LOG_DAYS).toBe(365);
  });

  it("坏配置回落默认（不让页面白屏）", async () => {
    await prisma.systemSetting.create({ data: { key: "retention.externalCallLogDays", value: { days: "abc" } } });
    expect(await getExternalCallLogRetentionDays()).toBe(DEFAULT_EXTERNAL_CALL_LOG_DAYS);
  });

  it("只删超期行，当期与未超期的一行不动", async () => {
    await seedLog(daysAgo(400)); // 超期
    await seedLog(daysAgo(300)); // 未超期
    await seedLog(daysAgo(1));   // 当期

    const res = await purgeExternalCallLogs({ now: NOW });
    expect(res.deleted).toBe(1);
    const left = await prisma.externalCallLog.count();
    expect(left).toBe(2);
  });

  it("**设为 0 表示不清理**（取证留存要求）", async () => {
    await saveExternalCallLogRetentionDays(0);
    await seedLog(daysAgo(1000));
    const res = await purgeExternalCallLogs({ now: NOW });
    expect(res.deleted).toBe(0);
    expect(res.cutoff).toBeNull();
    expect(await prisma.externalCallLog.count()).toBe(1);
  });

  it("保留期可配置：改成 30 天后 60 天前的行被删", async () => {
    await saveExternalCallLogRetentionDays(30);
    await seedLog(daysAgo(60));
    await seedLog(daysAgo(10));
    const res = await purgeExternalCallLogs({ now: NOW });
    expect(res.deleted).toBe(1);
    expect(res.days).toBe(30);
    expect(await prisma.externalCallLog.count()).toBe(1);
  });

  it("分批删除：批大小 2、共 5 条超期 → 全删（不会只删一批）", async () => {
    for (let i = 0; i < 5; i++) await seedLog(daysAgo(400 + i));
    const res = await purgeExternalCallLogs({ now: NOW, batchSize: 2 });
    expect(res.deleted).toBe(5);
    expect(await prisma.externalCallLog.count()).toBe(0);
  });
});
