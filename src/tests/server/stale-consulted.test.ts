// @vitest-environment node
/**
 * 已谈案未转收案的积压（真库，2026-11-23）
 *
 * 漏斗里「已谈案」是中间态：谈完不等于签下。
 * 提醒链只管邀约到店之前，**谈案之后没有任何机制** ——
 * 谈完当场没签，忙起来就忘了，三个月后还挂在"已谈案"。
 *
 * 四条口径：
 *  ① 只看 stage=CONSULTED 且未转收案；
 *  ② 以 consultedAt 起算，缺则用 updatedAt 兜底（历史数据可能没记谈案时间）；
 *  ③ 只列等待 ≥ days 天（默认 3：当天谈完当天转是正常节奏）；
 *  ④ 按等待天数从长到短（最该催的排最前）。
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
    data: { email: "sc@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => { await prisma.lead.deleteMany({}); });

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { getStaleConsultedLeads } = await import("@/server/leads/stale-consulted");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const NOW = new Date("2026-11-23T09:00:00+08:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function seed(opts: { consultedAt?: Date | null; stage?: string; name?: string; convertedIntakeId?: string | null }) {
  return prisma.lead.create({
    data: {
      name: opts.name ?? uid("线索"),
      phone: `1390000${String(9500 + seq)}`,
      ownerId: STAFF.id,
      stage: (opts.stage ?? "CONSULTED") as never,
      consultedAt: opts.consultedAt === undefined ? daysAgo(5) : opts.consultedAt,
      ...(opts.convertedIntakeId === undefined ? {} : { convertedIntakeId: opts.convertedIntakeId })
    }
  });
}

describe("已谈案未转收案", () => {
  it("谈了 5 天的列出来，等 5 天", async () => {
    const l = await seed({ consultedAt: daysAgo(5), name: "五天后" });
    const rows = await getStaleConsultedLeads(3, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(l.id);
    expect(rows[0].waitingDays).toBe(5);
  });

  it("**刚谈完不到 3 天的不列**（当天谈完当天转是正常节奏）", async () => {
    await seed({ consultedAt: daysAgo(1) });
    expect(await getStaleConsultedLeads(3, NOW)).toHaveLength(0);
  });

  it("**已转收案的不列**（已经不是漏损候选）", async () => {
    const client = await prisma.client.create({
      data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
    });
    const intake = await prisma.intake.create({
      data: { title: uid("收案"), category: "CIVIL_COMMERCIAL", status: "PENDING_CONFIRMATION", createdById: STAFF.id, clientId: client.id }
    });
    await seed({ consultedAt: daysAgo(9), convertedIntakeId: intake.id });
    expect(await getStaleConsultedLeads(3, NOW)).toHaveLength(0);
  });

  it("**非「已谈案」阶段不列**（到店/邀约归未来待上门那套）", async () => {
    await seed({ stage: "VISITED", consultedAt: daysAgo(9) });
    await seed({ stage: "INVITED", consultedAt: daysAgo(9) });
    expect(await getStaleConsultedLeads(3, NOW)).toHaveLength(0);
  });

  it("**没记谈案时间的老数据用 updatedAt 兜底**（不然会永远看不见）", async () => {
    const l = await prisma.lead.create({
      data: {
        name: uid("老线索"), phone: "13900009601", ownerId: STAFF.id,
        stage: "CONSULTED" as never, consultedAt: null,
        createdAt: daysAgo(30), updatedAt: daysAgo(7)
      }
    });
    const rows = await getStaleConsultedLeads(3, NOW);
    expect(rows.map((r) => r.id)).toContain(l.id);
    expect(rows.find((r) => r.id === l.id)!.waitingDays).toBe(7);
  });

  it("按等待天数从长到短（最该催的排最前）", async () => {
    await seed({ consultedAt: daysAgo(4), name: "四天" });
    await seed({ consultedAt: daysAgo(20), name: "二十天" });
    await seed({ consultedAt: daysAgo(9), name: "九天" });
    const rows = await getStaleConsultedLeads(3, NOW);
    expect(rows.map((r) => r.waitingDays)).toEqual([20, 9, 4]);
  });
});
