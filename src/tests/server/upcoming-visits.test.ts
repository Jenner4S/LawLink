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
/** 断言分组键用（与实现同口径：上海日期串） */
const ymdOf = (d: Date) => {
  const sh = new Date(d.getTime() + 8 * 3600_000);
  return `${sh.getUTCFullYear()}-${String(sh.getUTCMonth() + 1).padStart(2, "0")}-${String(sh.getUTCDate()).padStart(2, "0")}`;
};

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

  it("**窗口是半开区间 [今天0点, +7天)**：第 6 天 23:59 在内、第 7 天 00:00 不在", async () => {
    // 我第一版断言写反了：以为「第 7 天 00:00 在窗口内」。
    // 实现是 [start, start + days 天)，7 天窗口覆盖今天..第 6 天，
    // 第 7 天 00:00 恰是区间右端点 → **不属于**窗口。这条用例据此钉住边界语义。
    const late6 = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 6, 23, 59);
    const midnight7 = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 7, 0, 0);
    await seedLead({ invitedAt: late6, name: "第六天末" });
    await seedLead({ invitedAt: midnight7, name: "第七天初" });

    const days = await getUpcomingVisits(7, NOW);
    const names = days.flatMap((d) => d.items.map((i) => i.name));
    expect(names).toContain("第六天末");
    expect(names).not.toContain("第七天初");
  });

  it("days = 0 时窗口为空，返回空数组（退化输入不抛错）", async () => {
    // 页面固定传 7，但函数签名允许传 0。测它是为了让"退化输入不炸"有据可查，
    // 而不是靠读者推断"应该不会有人传 0 吧"。
    await seedLead({ invitedAt: day(1), name: "不该出现" });
    const days = await getUpcomingVisits(0, NOW);
    expect(days).toEqual([]);
  });

  it("**同一天多条同名不合并**（截断按条数，不按名字去重）", async () => {
    // 3 条/天的截断是按**条**算的：客户可能真有两个同名联系人，
    // 按名字去重会少报"今天要来几个人"。
    for (let i = 0; i < 4; i++) {
      await seedLead({ invitedAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1, 10, i), name: "同名客户" });
    }
    const days = await getUpcomingVisits(7, NOW);
    const tomorrow = days.find((d) => d.date === ymdOf(day(1)));
    expect(tomorrow?.count).toBe(4);      // 真实条数
    expect(tomorrow?.items.length).toBe(3); // 名字最多 3 条
    expect(new Set(tomorrow?.items.map((i) => i.name)).size).toBe(1); // 全是同一个名字，没被去重掉计数
  });
});
