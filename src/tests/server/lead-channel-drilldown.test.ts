// @vitest-environment node
/**
 * 渠道下钻（真库，2026-11-23）
 *
 * 漏斗里「按渠道」那一行显示 40 条、成交 3 单——但点不进去看是哪 40 条。
 * 数字与清单不连通时，人只能"相信"这个数字，没法核对。
 *
 * 三条口径：
 *  ① 传**一级渠道**时含其全部子渠道（否则点"大众点评"只能看到直接挂一级的零星线索，
 *     与漏斗那一行的数字对不上）；
 *  ② 传**二级渠道**时只看自己；
 *  ③ 与其他筛选（阶段/派单视图）可叠加，互不覆盖。
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
    data: { email: "drill@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.lead.deleteMany({});
  await prisma.leadChannel.deleteMany({ where: { parentId: { not: null } } });
  await prisma.leadChannel.deleteMany({});
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { listLeads } = await import("@/server/leads/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seed() {
  const parent = await prisma.leadChannel.create({ data: { name: uid("投放"), kind: "PAID" } });
  const c1 = await prisma.leadChannel.create({ data: { name: uid("点评"), parentId: parent.id, kind: "PAID" } });
  const c2 = await prisma.leadChannel.create({ data: { name: uid("抖音"), parentId: parent.id, kind: "PAID" } });
  const other = await prisma.leadChannel.create({ data: { name: uid("转介绍"), kind: "ORGANIC" } });

  const mk = (channelId: string, extra: Record<string, unknown> = {}) =>
    prisma.lead.create({
      data: { name: uid("线索"), phone: `1390000${String(7000 + seq)}`, ownerId: STAFF.id, channelId, ...extra }
    });

  const a = await mk(c1.id);
  const b = await mk(c2.id);
  const c = await mk(other.id);
  return { parent, c1, c2, other, a, b, c };
}

describe("渠道下钻", () => {
  it("**一级渠道含全部子渠道**（点母公司能看到两个平台各自带来的线索）", async () => {
    const { parent, a, b, c } = await seed();
    const rows = await listLeads({ stage: "ALL", channelId: parent.id });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(ids).not.toContain(c.id); // 别的一级渠道不该混进来
  });

  it("**二级渠道只看自己**", async () => {
    const { c1, a, b } = await seed();
    const rows = await listLeads({ stage: "ALL", channelId: c1.id });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("无子渠道的一级渠道：只返回直接挂它的线索", async () => {
    const { other, c } = await seed();
    const rows = await listLeads({ stage: "ALL", channelId: other.id });
    expect(rows.map((r) => r.id)).toContain(c.id);
  });

  it("**可与派单视图叠加**（渠道 + 待派单同时生效）", async () => {
    const { parent, a } = await seed();
    await prisma.lead.update({ where: { id: a.id }, data: { assigneeStatus: "UNASSIGNED" } });
    const rows = await listLeads({ stage: "ALL", channelId: parent.id, assignee: "PENDING_ASSIGN" });
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.id);
    // 已派单的同类线索不应出现
    const pendingIds = rows.filter((r) => r.assigneeStatus !== "UNASSIGNED").map((r) => r.id);
    expect(pendingIds).toHaveLength(0);
  });

  it("不存在的渠道 id → 空结果（不报错、不返回全部）", async () => {
    await seed();
    const rows = await listLeads({ stage: "ALL", channelId: "nonexistent-channel-id" });
    expect(rows).toHaveLength(0);
  });
});
