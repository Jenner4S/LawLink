// @vitest-environment node
/**
 * 未来几天该盯谁上门（真库，2026-11-23）
 *
 * 漏斗回答"这个月怎么样"、渠道回答"钱往哪投"，
 * 但基层每天要回答的是：**今天/这周该打给谁**。
 *
 * 四条口径（都取"宁可少列"）：
 *  ① 只列 `visitOutcome = PENDING`（已到店、已爽约都不再"待上门"）；
 *  ② 只列未来（含今天），过去的约定归提醒链追，不在这块；
 *  ③ 只列 `stage = INVITED`（已谈案/已转化不再需要上门提醒）；
 *  ④ 按天分组、日期升序，每天最多给 3 条名字（再多只给数字）。
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
    data: { email: "uv@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => { await prisma.lead.deleteMany({}); });

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { getUpcomingVisits } = await import("@/server/leads/upcoming-visits");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const NOW = new Date("2026-11-23T09:00:00+08:00");
const day = (n: number) => new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + n, 14, 0);

async function seedLead(opts: {
  invitedAt?: Date | null;
  stage?: string;
  visitOutcome?: string;
  name?: string;
}) {
  return prisma.lead.create({
    data: {
      name: opts.name ?? uid("线索"),
      phone: `1390000${String(9000 + seq)}`,
      ownerId: STAFF.id,
      stage: (opts.stage ?? "INVITED") as never,
      visitOutcome: (opts.visitOutcome ?? "PENDING") as never,
      invitedAt: opts.invitedAt === undefined ? day(1) : opts.invitedAt
    }
  });
}

describe("未来待上门", () => {
  it("按天分组、日期升序；今天的也列", async () => {
    await seedLead({ invitedAt: day(2), name: "后天甲" });
    await seedLead({ invitedAt: day(0), name: "今天乙" });
    await seedLead({ invitedAt: day(0), name: "今天丙" });

    const d = await getUpcomingVisits(7, NOW);
    expect(d).toHaveLength(2);
    expect(d[0].date < d[1].date).toBe(true);
    expect(d[0].count).toBe(2);
    expect(d[0].items.map((i) => i.name)).toContain("今天乙");
  });

  it("**已到店与已爽约都不算待上门**", async () => {
    await seedLead({ visitOutcome: "ARRIVED" });
    await seedLead({ visitOutcome: "NO_SHOW" });
    expect(await getUpcomingVisits(7, NOW)).toHaveLength(0);
  });

  it("**过去的约定不列**（归提醒链追，不在这块）", async () => {
    await seedLead({ invitedAt: day(-1) });
    expect(await getUpcomingVisits(7, NOW)).toHaveLength(0);
  });

  it("**已谈案/已转化不列**（不再需要上门提醒）", async () => {
    await seedLead({ stage: "CONSULTED" });
    await seedLead({ stage: "CONVERTED" });
    expect(await getUpcomingVisits(7, NOW)).toHaveLength(0);
  });

  it("超出窗口的不列（默认 7 天）", async () => {
    await seedLead({ invitedAt: day(10) });
    expect(await getUpcomingVisits(7, NOW)).toHaveLength(0);
    expect(await getUpcomingVisits(14, NOW)).toHaveLength(1);
  });

  it("每天最多给 3 条名字，但 count 是真实条数", async () => {
    for (let i = 0; i < 5; i++) await seedLead({ invitedAt: day(1) });
    const d = await getUpcomingVisits(7, NOW);
    expect(d).toHaveLength(1);
    expect(d[0].count).toBe(5);
    expect(d[0].items).toHaveLength(3);
  });
});
