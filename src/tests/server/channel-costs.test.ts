// @vitest-environment node
/**
 * 渠道月度投放成本（真库，2026-11-23）
 *
 * 线索上的 voucherAmount 是"每条线索的券金额"，
 * 不等于"这个月在大众点评投了 3000"。没有渠道级投放成本，
 * 漏斗里"单线索/单到店/单成交成本"就没有可信来源。
 *
 * 五条口径：
 *  ① 渠道 × 月唯一，重复录入是**覆盖**不是累加（同月改数是常态）；
 *  ② 填 0 = 没投 → **删除该月记录**（0 与"未录入"在成本口径里是同一件事）；
 *  ③ 券金额只在归属=成本侧时才并入成本（否则双计）；
 *  ④ 投放成本**总是**并入（那是真花出去的钱）；
 *  ⑤ 只有管理员/合伙人能录入。
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
let role: string = "PRINCIPAL_LAWYER";

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "cc@t.local", name: "主任", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  role = "PRINCIPAL_LAWYER";
  await prisma.leadChannelCost.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.leadChannel.deleteMany({ where: { parentId: { not: null } } });
  await prisma.leadChannel.deleteMany({});
  await prisma.systemSetting.deleteMany({ where: { key: "leadFinancePolicy" } });
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role, rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { upsertChannelCost } = await import("@/server/leads/channel-costs-actions");
const { getChannelCostsForMonth, listChannelCosts, monthKey } = await import("@/server/leads/channel-costs");
const { getLeadFunnel } = await import("@/server/leads/analytics");
const { saveLeadFinancePolicy, LEAD_FINANCE_POLICY_DEFAULTS } = await import("@/server/settings/lead-finance-policy");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const MONTH = "2026-11";

async function seedChannel() {
  return prisma.leadChannel.create({ data: { name: uid("渠道"), kind: "PAID" } });
}

describe("渠道月度投放成本", () => {
  it("录入后可读回（按渠道索引 + 列表两处一致）", async () => {
    const ch = await seedChannel();
    await upsertChannelCost({ channelId: ch.id, month: MONTH, amount: 3000, note: "包月" });

    expect((await getChannelCostsForMonth(MONTH)).get(ch.id)).toBe(3000);
    const list = await listChannelCosts(MONTH);
    expect(list.find((r) => r.channelId === ch.id)?.amount).toBe(3000);
  });

  it("**重复录入是覆盖不是累加**（同月改数是常态）", async () => {
    const ch = await seedChannel();
    await upsertChannelCost({ channelId: ch.id, month: MONTH, amount: 3000 });
    await upsertChannelCost({ channelId: ch.id, month: MONTH, amount: 2500 });
    expect((await getChannelCostsForMonth(MONTH)).get(ch.id)).toBe(2500);
    expect(await prisma.leadChannelCost.count()).toBe(1);
  });

  it("**填 0 = 没投 → 删除该月记录**（0 与未录入是同一件事）", async () => {
    const ch = await seedChannel();
    await upsertChannelCost({ channelId: ch.id, month: MONTH, amount: 3000 });
    await upsertChannelCost({ channelId: ch.id, month: MONTH, amount: 0 });
    expect(await prisma.leadChannelCost.count()).toBe(0);
  });

  it("渠道不存在被拒；月份格式错被拒", async () => {
    await expect(upsertChannelCost({ channelId: "nope", month: MONTH, amount: 100 })).rejects.toThrow(/渠道不存在/);
    const ch = await seedChannel();
    await expect(upsertChannelCost({ channelId: ch.id, month: "2026-13", amount: 100 })).rejects.toThrow();
  });

  it("**只有管理员/合伙人能录入**（财务角色被拒）", async () => {
    role = "FINANCE";
    const ch = await seedChannel();
    await expect(upsertChannelCost({ channelId: ch.id, month: MONTH, amount: 100 })).rejects.toThrow(/仅管理员或合伙人/);
  });

  it("**投放成本总是并入单位成本**（券归属=收入侧时也不漏掉真花出去的钱）", async () => {
    await saveLeadFinancePolicy({ ...LEAD_FINANCE_POLICY_DEFAULTS, voucherAmountSide: "REVENUE" });
    const ch = await seedChannel();
    const periodStart = new Date("2026-11-01T00:00:00+08:00");
    const periodEnd = new Date("2026-12-01T00:00:00+08:00");
    for (let i = 0; i < 2; i++) {
      await prisma.lead.create({
        data: { name: uid("线索"), phone: `1390000${String(9900 + seq)}`, ownerId: STAFF.id, channelId: ch.id, createdAt: periodStart }
      });
    }
    await upsertChannelCost({ channelId: ch.id, month: monthKey(periodStart), amount: 600 });

    const f = await getLeadFunnel({ start: periodStart, end: periodEnd });
    const row = f.byChannel.find((r) => r.key === ch.id)!;
    expect(row.monthlyCost).toBe(600);
    expect(row.costPerLead).toBe(300); // 600 / 2 条
  });
});
