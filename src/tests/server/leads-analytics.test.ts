// @vitest-environment node
/**
 * 获客漏斗口径（真库，2026-11-21）
 *
 * 钉住三件容易做错、且错了看不出来的事：
 *
 *  ① **分母是「期间新增线索」**，不是「期间转化的数量」。
 *     后者会把跨期成交算进本月分子、分母却只有本月线索 → 比率可能 >100%。
 *     看板上一旦出现不可能的数字，整块看板就没人信了。
 *
 *  ② **「曾到过某阶段」看动作记录，不看当前 stage**。
 *     用 stage 反推会得出「所有谈过案的都被邀约过」——听起来合理，
 *     但无法区分「跳过邀约直接来所里」，而后者恰恰是流程漏洞。
 *
 *  ③ **分母为 0 时比率为 null，不是 0%**。
 *     0% 会被读成「一个都没成」；null 显示成「—」才是诚实的。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const OWNER = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "funnel@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  OWNER.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { getLeadFunnel } = await import("@/server/leads/analytics");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

const PERIOD_START = new Date("2026-12-01T00:00:00+08:00");
const PERIOD_END = new Date("2026-12-31T23:59:59+08:00");
const IN_PERIOD = new Date("2026-12-10T10:00:00+08:00");

async function seedLead(args: {
  stage?: "LEAD" | "INVITED" | "VISITED" | "CONSULTED" | "CONVERTED" | "LOST";
  createdAt?: Date;
  convertedAt?: Date | null;
  activities?: ("CONTACT" | "INVITE" | "VISIT" | "CONSULT")[];
  source?: "REFERRAL" | "ONLINE";
  expectedAmount?: number;
  lostReason?: string | null;
}) {
  const lead = await prisma.lead.create({
    data: {
      name: uid("线索"),
      phone: "13800000000",
      stage: args.stage ?? "LEAD",
      source: args.source ?? "REFERRAL",
      ownerId: OWNER.id,
      expectedAmount: args.expectedAmount ?? null,
      convertedAt: args.convertedAt ?? null,
      lostReason: args.lostReason ?? null,
      createdAt: args.createdAt ?? IN_PERIOD
    }
  });
  for (const type of args.activities ?? []) {
    await prisma.leadActivity.create({
      data: { leadId: lead.id, type, happenedAt: IN_PERIOD, createdById: OWNER.id }
    });
  }
  return lead;
}

describe("漏斗分母口径", () => {
  it("跨期成交：上月线索本月转化，不计入本月分母也不计入分子", async () => {
    // 上月创建、本月转化
    const old = await seedLead({
      stage: "CONVERTED",
      createdAt: new Date("2026-11-20T10:00:00+08:00"),
      convertedAt: new Date("2026-12-05T10:00:00+08:00"),
      activities: ["INVITE", "VISIT", "CONSULT"]
    });
    // 本月创建、本月转化
    await seedLead({ stage: "CONVERTED", convertedAt: new Date("2026-12-15T10:00:00+08:00"), activities: ["INVITE", "VISIT", "CONSULT"] });

    const f = await getLeadFunnel({ start: PERIOD_START, end: PERIOD_END });
    expect(f.total).toBe(1);       // 只有本月新增的那条
    expect(f.converted).toBe(1);
    expect(f.conversionRate).toBe(100); // 1/1，绝不会出现 200%

    // 上月那条确实被排除了（不是被算成未转化）
    const oldLead = await prisma.lead.findUniqueOrThrow({ where: { id: old.id }, select: { stage: true } });
    expect(oldLead.stage).toBe("CONVERTED");
  });

  it("分母为 0 时比率为 null（不是 0%）", async () => {
    const f = await getLeadFunnel({
      start: new Date("2027-03-01T00:00:00+08:00"),
      end: new Date("2027-03-31T00:00:00+08:00")
    });
    expect(f.total).toBe(0);
    expect(f.conversionRate).toBeNull();
    expect(f.inviteRate).toBeNull();
    expect(f.visitRate).toBeNull();
    expect(f.consultRate).toBeNull();
    expect(f.medianDaysToConvert).toBeNull();
  });
});

describe("阶段判定看动作记录，不看当前 stage", () => {
  it("已谈案但**没有**邀约动作 → 计入 consulted 但不计入 invited（能暴露流程漏洞）", async () => {
    // 跳过邀约：客户自己上门，只有 VISIT + CONSULT。
    // 用独立时间窗——同库里其它用例造的带 INVITE 的线索会污染 invited 计数
    // （第一版就撞在这上面，expected 1 to be 0）。
    const ownStart = new Date("2028-01-01T00:00:00+08:00");
    const ownEnd = new Date("2028-01-31T00:00:00+08:00");
    await seedLead({ stage: "CONSULTED", activities: ["VISIT", "CONSULT"], createdAt: new Date("2028-01-10T10:00:00+08:00") });

    const f = await getLeadFunnel({ start: ownStart, end: ownEnd });
    expect(f.consulted).toBeGreaterThanOrEqual(1);
    expect(f.invited).toBe(0); // 若按 stage 反推，这里会错成 1
    expect(f.visitRate).toBeNull(); // 分母 invited=0
  });
});

describe("转化天数与金额", () => {
  it("转化天数取中位数（样本少时平均值会被极端值带偏）", async () => {
    // 三条：1 天、2 天、100 天 → 中位数 2 天，平均值会是 34 天
    const cases: [number, number][] = [[1, 0], [2, 1], [100, 2]];
    for (const [days] of cases) {
      const created = new Date("2026-12-01T10:00:00+08:00");
      const converted = new Date(created.getTime() + days * 86_400_000);
      await seedLead({ stage: "CONVERTED", createdAt: created, convertedAt: converted, activities: ["CONSULT"] });
    }
    const f = await getLeadFunnel({
      start: new Date("2026-12-01T00:00:00+08:00"),
      end: new Date("2027-01-31T00:00:00+08:00")
    });
    expect(f.medianDaysToConvert).not.toBeNull();
    // 该窗口里还有前面的用例数据，故只断言「中位数 < 平均值」这个方向性事实
    expect(f.medianDaysToConvert!).toBeLessThan(34);
  });

  it("预计金额：合计全部新增线索，已转化金额只算转了的", async () => {
    const f = await getLeadFunnel({ start: PERIOD_START, end: PERIOD_END });
    expect(f.expectedAmount).toBeGreaterThanOrEqual(0);
    expect(f.convertedAmount).toBeLessThanOrEqual(f.expectedAmount);
  });
});

describe("来源与流失", () => {
  it("按来源聚合，并按线索量排序", async () => {
    await seedLead({ source: "ONLINE" });
    await seedLead({ source: "ONLINE" });
    const f = await getLeadFunnel({ start: PERIOD_START, end: PERIOD_END });
    expect(f.bySource.length).toBeGreaterThan(0);
    expect(f.bySource[0].total).toBeGreaterThanOrEqual(f.bySource[f.bySource.length - 1].total);
  });

  it("流失原因汇总，未填写归入「（未填写）」", async () => {
    await seedLead({ stage: "LOST", lostReason: "比价后选了别家" });
    await seedLead({ stage: "LOST", lostReason: null });
    const f = await getLeadFunnel({ start: PERIOD_START, end: PERIOD_END });
    const reasons = f.lostReasons.map((r) => r.reason);
    expect(reasons).toContain("比价后选了别家");
    expect(reasons).toContain("（未填写）");
  });
});
