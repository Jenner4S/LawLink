// @vitest-environment node
/**
 * 满意度看板计算（真库，2026-11-21）
 *
 * 三处口径各自都能算错且看不出来，所以逐条钉住：
 *   ① **匿名评价仍计入客户维度**——匿名只隐藏"哪个人"，不是隐藏"哪家客户"。
 *      若把匿名的 clientId 也抹掉，客户级统计会出现无法归因的空洞。
 *   ② **NPS 分母只算填了 npsScore 的评价**——没填当 0 分会把 NPS 系统性压低。
 *   ③ **平均分按 score 计**，不与 NPS 混算（两者量纲不同）。
 *   ④ 隔离墙：被墙挡住案件的评价不得出现在看板（靠 matter 关系在 SQL 层叠加）。
 */
import { beforeEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
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
    data: { email: "staff@sat.local", name: "经办律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { getSatisfactionAnalysis } = await import("@/server/reports/analytics");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

const PERIOD = {
  key: "month" as const,
  label: "本期",
  start: new Date(Date.now() - 24 * 3600 * 1000),
  end: new Date(Date.now() + 24 * 3600 * 1000)
};

async function seedClient(name: string) {
  return prisma.client.create({ data: { id: uid("c"), name, type: "COMPANY" } });
}
async function seedMatter(clientId: string, title = "满意度案") {
  return prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title, category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: clientId, customValues: {}
    }
  });
}
async function seedRating(clientId: string, matterId: string, score: number, npsScore: number | null, anonymous = false) {
  return prisma.portalSatisfaction.create({
    data: { clientId, matterId, score, npsScore, anonymous, comment: anonymous ? null : `评分 ${score}` }
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  // 每个用例独立数据：不清理会让「本期之外」这类用例把上一条的评分算进去
  // （第一版就是没清理，期望 2 条却读到 5 条）。顺序按外键依赖：
  // 评价 → 案件 → 客户，反过来会被 RESTRICT 拦住。
  await prisma.portalSatisfaction.deleteMany();
  await prisma.matter.deleteMany();
  await prisma.client.deleteMany();
});

describe("满意度看板口径", () => {
  it("平均分按 score 计；分布按 1..5 桶；匿名条数单独计数", async () => {
    const c = await seedClient("甲客户");
    const m1 = await seedMatter(c.id, "案一");
    const m2 = await seedMatter(c.id, "案二");
    const m3 = await seedMatter(c.id, "案三");

    await seedRating(c.id, m1.id, 5, 10);
    await seedRating(c.id, m2.id, 3, 7, true);
    await seedRating(c.id, m3.id, 1, 2);

    const r = await getSatisfactionAnalysis(PERIOD);
    expect(r.count).toBe(3);
    expect(r.averageScore).toBeCloseTo(3, 5);      // (5+3+1)/3
    expect(r.distribution).toEqual([1, 0, 1, 0, 1]); // 1分1条 / 3分1条 / 5分1条
    expect(r.anonymousCount).toBe(1);
  });

  it("NPS 分母只算填写了 npsScore 的评价（未填不当 0 分）", async () => {
    const c = await seedClient("乙客户");
    const m1 = await seedMatter(c.id);
    const m2 = await seedMatter(c.id);
    const m3 = await seedMatter(c.id);

    await seedRating(c.id, m1.id, 5, 10);  // 推荐者
    await seedRating(c.id, m2.id, 4, 8);   // 被动者
    await seedRating(c.id, m3.id, 4, null); // 未填 NPS

    const r = await getSatisfactionAnalysis(PERIOD);
    expect(r.nps.responses).toBe(2);            // 只有 2 条填答
    expect(r.nps.promoters).toBe(1);
    expect(r.nps.passives).toBe(1);
    expect(r.nps.detractors).toBe(0);
    expect(r.nps.score).toBe(50);               // (1-0)/2 * 100
    expect(r.count).toBe(3);                    // 但评价总数仍是 3
  });

  it("全部未填 NPS → nps.score 为 null（不是 0）", async () => {
    const c = await seedClient("丙客户");
    const m = await seedMatter(c.id);
    await seedRating(c.id, m.id, 4, null);
    const r = await getSatisfactionAnalysis(PERIOD);
    expect(r.nps.responses).toBe(0);
    expect(r.nps.score).toBeNull();
  });

  it("匿名评价的客户名仍能看到（匿名只隐藏人，不隐藏客户）", async () => {
    const c = await seedClient("丁客户");
    const m = await seedMatter(c.id, "匿名案");
    await seedRating(c.id, m.id, 5, null, true);

    const r = await getSatisfactionAnalysis(PERIOD);
    expect(r.recent).toHaveLength(1);
    expect(r.recent[0].anonymous).toBe(true);
    expect(r.recent[0].clientName).toBe("丁客户");
  });

  it("隔离墙：被挡住案件的评价不出现在看板（matter 关系在 SQL 层叠加）", async () => {
    const c = await seedClient("戊客户");
    const visible = await seedMatter(c.id, "可见案");
    const hidden = await seedMatter(c.id, "被墙案");
    await seedRating(c.id, visible.id, 5, null);
    await seedRating(c.id, hidden.id, 1, null);

    const r = await getSatisfactionAnalysis(PERIOD, { matters: { id: visible.id }, finance: {} });
    expect(r.count).toBe(1);
    expect(r.recent[0].matterTitle).toBe("可见案");
  });

  it("本期之外的评价不计入", async () => {
    const c = await seedClient("己客户");
    const m = await seedMatter(c.id);
    const old = await seedRating(c.id, m.id, 5, null);
    await prisma.portalSatisfaction.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 90 * 24 * 3600 * 1000) } });

    const r = await getSatisfactionAnalysis(PERIOD);
    expect(r.count).toBe(0);
    expect(r.averageScore).toBeNull();
  });
});
