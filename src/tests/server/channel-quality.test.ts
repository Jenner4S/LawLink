// @vitest-environment node
/**
 * 渠道转化质量环比（真库，2026-11-23）
 *
 * 成本环比回答"多花了多少"，但答不了"多花的钱有没有换来更好的客"。
 *
 * 四条口径：
 *  ① 分母只用**当期新增线索**（与漏斗同口径）——否则上月老线索本月到店
 *    会把本月到店率抬高，看着像变好；
 *  ② 到店按 visitOutcome=ARRIVED，成交按 stage=CONVERTED（与漏斗同）；
 *  ③ 上月该渠道**没有线索**时比率为 null（不是 0%）——没基线谈不上"变好/变差"；
 *  ④ 变化用**百分点差**（不是百分比差），保留一位小数。
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
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "q@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.lead.deleteMany({});
  await prisma.leadChannel.deleteMany({});
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { getChannelQualityComparison } = await import("@/server/leads/channel-quality");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const CUR_START = new Date("2026-11-01T00:00:00+08:00");
const CUR_END = new Date("2026-12-01T00:00:00+08:00");
const PREV_START = new Date("2026-10-01T00:00:00+08:00");
const PREV_END = CUR_START;

async function seedChannel() {
  return prisma.leadChannel.create({ data: { name: uid("渠道"), kind: "PAID" } });
}

async function mk(
  channelId: string,
  createdAt: Date,
  opts: { arrived?: boolean; converted?: boolean; updatedAt?: Date } = {}
) {
  return prisma.lead.create({
    data: {
      name: uid("线索"), phone: `1390000${String(9200 + seq)}`, ownerId: STAFF.id, channelId,
      stage: (opts.converted ? "CONVERTED" : "VISITED") as never,
      visitOutcome: (opts.arrived ? "ARRIVED" : "PENDING") as never,
      createdAt, updatedAt: opts.updatedAt ?? createdAt
    }
  });
}

describe("转化质量环比", () => {
  it("上月 2 条 0 成交 → 本月 2 条 1 成交：成交率 +50 个百分点", async () => {
    const ch = await seedChannel();
    await mk(ch.id, PREV_START, { arrived: true });
    await mk(ch.id, PREV_START, { arrived: false });
    await mk(ch.id, CUR_START, { arrived: true, converted: true });
    await mk(ch.id, CUR_START, { arrived: true });

    const c = (await getChannelQualityComparison(CUR_START, CUR_END, PREV_START, PREV_END)).get(ch.id)!;
    expect(c.current.conversionRate).toBe(50);
    expect(c.previous.conversionRate).toBe(0);
    expect(c.conversionRateDelta).toBe(50);
  });

  it("**上月无基线 → delta 为 null**（不是 0，也不是满额）", async () => {
    const ch = await seedChannel();
    await mk(ch.id, CUR_START, { arrived: true, converted: true });

    const c = (await getChannelQualityComparison(CUR_START, CUR_END, PREV_START, PREV_END)).get(ch.id)!;
    expect(c.previous.total).toBe(0);
    expect(c.previous.conversionRate).toBeNull();
    expect(c.conversionRateDelta).toBeNull();
    // 到店率也必须为 null —— 我只断言了成交率，变异改到店率时没抓到（补上）
    expect(c.visitRateDelta).toBeNull();
  });

  it("**分母只算当期新增**：上月老线索本月到店，不计入本月到店率", async () => {
    const ch = await seedChannel();
    // 上月的线索，本月才到店（updatedAt 落在本月）——若实现按 updatedAt 统计，
    // 会把它算进本月并把到店率抬高。第一版 seed 让 createdAt==updatedAt，
    // 换列无差别，变异没被抓；补上 updatedAt 才有分辨力。
    await mk(ch.id, PREV_START, { arrived: true, converted: true, updatedAt: CUR_START });
    await mk(ch.id, CUR_START, { arrived: false });

    const c = (await getChannelQualityComparison(CUR_START, CUR_END, PREV_START, PREV_END)).get(ch.id)!;
    expect(c.current.total).toBe(1);          // 本月只新增 1 条
    expect(c.current.visited).toBe(0);        // 它没到店
    expect(c.current.visitRate).toBe(0);
  });

  it("变差时为负：上月 100% 到店 → 本月 50% 到店 = -50", async () => {
    const ch = await seedChannel();
    await mk(ch.id, PREV_START, { arrived: true });
    await mk(ch.id, CUR_START, { arrived: true });
    await mk(ch.id, CUR_START, { arrived: false });

    const c = (await getChannelQualityComparison(CUR_START, CUR_END, PREV_START, PREV_END)).get(ch.id)!;
    expect(c.visitRateDelta).toBe(-50);
  });

  it("两期都无线索的渠道不出现在结果里", async () => {
    const ch = await seedChannel();
    expect((await getChannelQualityComparison(CUR_START, CUR_END, PREV_START, PREV_END)).has(ch.id)).toBe(false);
  });

  it("**本月无线索但有上月数据**：delta 仍为 null（不是「下降 100%」）", async () => {
    // 「上月没投」与「本月没投」在比率上都不构成可比基线：
    // 一个是"没有对照起点"，一个是"本期没有样本"，都不能说成涨跌。
    const ch = await seedChannel();
    await mk(ch.id, PREV_START, { arrived: true, converted: true });

    const c = (await getChannelQualityComparison(CUR_START, CUR_END, PREV_START, PREV_END)).get(ch.id)!;
    expect(c.current.total).toBe(0);
    expect(c.current.conversionRate).toBeNull();
    expect(c.conversionRateDelta).toBeNull();
    expect(c.visitRateDelta).toBeNull();
  });
});
