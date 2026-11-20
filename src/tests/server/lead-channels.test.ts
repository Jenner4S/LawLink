// @vitest-environment node
/**
 * 获客渠道两级 + 券金额（真库，2026-11-22，对标分析 P0-1）
 *
 * 客户现行系统里「渠道/二级渠道」是**单选**（本地生活/大众点评），
 * 单选的意义就是聚合出「大众点评这个月来 40 条、成交 3 单」。
 * LawLink 此前只有固定枚举 + 自由文本，导不出按平台 ROI。
 *
 * 四条口径各能搞错：
 *  ① **只两级**：三级没有收益，只会让表单更难选
 *  ② **停用不删除**：历史线索仍指向它，聚合照旧
 *  ③ **同级唯一**：同名渠道在同一父级下不能重复（否则聚合会分裂成两行）
 *  ④ **聚合优先 channelId，为空回退 source**：存量数据不能变成「未指定」
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
    data: { email: "ch@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { listLeadChannels } = await import("@/server/leads/channels");
const { createLeadChannel, toggleLeadChannel, ensureDefaultChannels } =
  await import("@/server/leads/channels-actions");
const { createLead } = await import("@/server/leads/actions");
const { getLeadFunnel } = await import("@/server/leads/analytics");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

describe("渠道维护", () => {
  it("预置渠道幂等：跑两次不重复建", async () => {
    const first = await ensureDefaultChannels();
    expect(first.created).toBeGreaterThan(0);
    const second = await ensureDefaultChannels();
    expect(second.created).toBe(0);
  });

  it("只支持两级：不能在二级下再建", async () => {
    const tree = await listLeadChannels();
    const parent = tree.find((t) => t.children.length > 0)!;
    const child = parent.children[0];
    await expect(createLeadChannel({ name: uid("三级"), parentId: child.id })).rejects.toThrow("只支持两级");
  });

  it("同级重名被拒（否则聚合会分裂成两行）", async () => {
    const parent = (await listLeadChannels())[0];
    await createLeadChannel({ name: uid("新渠道"), parentId: parent.id });
    const name = uid("重名");
    await createLeadChannel({ name, parentId: parent.id });
    await expect(createLeadChannel({ name, parentId: parent.id })).rejects.toThrow("已有同名渠道");
  });

  it("停用不删除：仍出现在渠道树里，只是 active=false", async () => {
    const tree = await listLeadChannels();
    const parent = tree[0];
    const { id } = await createLeadChannel({ name: uid("待停用"), parentId: parent.id });
    await toggleLeadChannel({ id, active: false });
    const after = await listLeadChannels();
    const row = after.find((t) => t.id === parent.id)!.children.find((c) => c.id === id);
    expect(row).toBeTruthy();
    expect(row!.active).toBe(false);
  });
});

describe("线索带渠道与券金额", () => {
  it("登记时写入 channelId 与 voucherAmount，列表返回一级/二级名", async () => {
    const tree = await listLeadChannels();
    const parent = tree.find((t) => t.children.length > 0)!;
    const child = parent.children[0];

    const { id } = await createLead({
      name: uid("带渠道"),
      phone: "13900000070",
      channelId: child.id,
      voucherAmount: 99
    });

    const row = await prisma.lead.findUniqueOrThrow({ where: { id }, select: { channelId: true, voucherAmount: true } });
    expect(row.channelId).toBe(child.id);
    expect(Number(row.voucherAmount)).toBe(99);
  });
});

describe("漏斗按渠道聚合", () => {
  beforeEach(async () => { /* 不清理：每条用例自造独立渠道与线索，按 channelId 断言 */ });

  it("同一二级渠道的线索聚合成一行，券金额合计，并能算出成交率", async () => {
    const tree = await listLeadChannels();
    const parent = tree.find((t) => t.children.length > 0)!;
    // 用**专用**二级渠道：共用渠道会把前面用例造的线索也算进来（第一版 total 得 3 而非 2）
    const { id: childId } = await createLeadChannel({ name: uid("聚合专用"), parentId: parent.id });
    const child = { id: childId, name: (await listLeadChannels()).find((t) => t.id === parent.id)!.children.find((c) => c.id === childId)!.name };

    // 造 2 条线索：1 条成交、1 条仅登记；券金额 99 + 99
    for (const [i, stage] of ["CONVERTED", "LEAD"].entries()) {
      await prisma.lead.create({
        data: {
          name: uid("聚合"), phone: `1390000008${i}`, ownerId: STAFF.id,
          stage: stage as never, channelId: child.id, voucherAmount: 99,
          convertedAt: stage === "CONVERTED" ? new Date() : null,
          createdAt: new Date(), updatedAt: new Date()
        }
      });
    }

    const start = new Date(Date.now() - 3600_000);
    const end = new Date(Date.now() + 3600_000);
    const f = await getLeadFunnel({ start, end });
    const row = f.byChannel.find((c) => c.key === child.id);
    expect(row).toBeTruthy();
    expect(row!.total).toBe(2);
    expect(row!.converted).toBe(1);
    expect(row!.voucherAmount).toBe(198);
    expect(row!.conversionRate).toBe(50);
    expect(row!.label).toBe(`${parent.name} / ${child.name}`);
  });

  it("没有 channelId 的存量线索回退按 source 聚合，不会变成「未指定」黑洞", async () => {
    await prisma.lead.create({
      data: { name: uid("存量"), phone: "13900000090", ownerId: STAFF.id, source: "REFERRAL", createdAt: new Date(), updatedAt: new Date() }
    });
    const start = new Date(Date.now() - 3600_000);
    const end = new Date(Date.now() + 3600_000);
    const f = await getLeadFunnel({ start, end });
    const row = f.byChannel.find((c) => c.key === "SRC:REFERRAL");
    expect(row).toBeTruthy();
    expect(row!.total).toBeGreaterThanOrEqual(1);
  });
});
