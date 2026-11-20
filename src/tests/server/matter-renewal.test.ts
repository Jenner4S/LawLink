// @vitest-environment node
/**
 * 续案 / 二次委托（真库，2026-11-22，P2）
 *
 * 客户宽表用「父记录字段」表达"同一客户再次委托"，并统计「委托次数」。
 * LawLink 既有 MatterLink 已能表达有向关联，但 RELATED_CASE 只说明"两件有关联"，
 * 说不清**谁是主案、谁是后续**——而续案的价值恰恰在"第 N 次委托"这个序次上。
 *
 * 三条口径：
 *  ① RENEWAL 是有向的（新案 → 主案），不是无向"关联"
 *  ② 同一条关系不能重复建（既有唯一约束）
 *  ③ 委托次数按客户维度派生（软删案件不计）
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
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "rn@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: vi.fn(async () => {}) }));
vi.mock("@/server/matters/access", () => ({ assertCanAssociateMatter: vi.fn(async () => {}) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { addMatterLink } = await import("@/server/matters/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedClientWithMatters(count: number) {
  const client = await prisma.client.create({
    data: { name: uid("委托客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
  });
  const matters = [];
  for (let i = 0; i < count; i++) {
    matters.push(
      await prisma.matter.create({
        data: {
          internalCode: uid("LL-"), title: `第 ${i + 1} 次委托`, category: "CIVIL_COMMERCIAL",
          status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
          teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
          ownerId: STAFF.id, primaryClientId: client.id, customValues: {}
        }
      })
    );
  }
  return { client, matters };
}

describe("续案链", () => {
  it("可建成 RENEWAL 关系，且有向（新案 → 主案）", async () => {
    const { matters } = await seedClientWithMatters(2);
    const [main, renewal] = matters;

    await addMatterLink(renewal.id, main.id, "RENEWAL");

    const link = await prisma.matterLink.findFirstOrThrow({
      where: { matterId: renewal.id, relatedMatterId: main.id }
    });
    expect(link.relation).toBe("RENEWAL");
    // 反向不存在：这是有向关系，不是无向"关联"
    const reverse = await prisma.matterLink.findFirst({
      where: { matterId: main.id, relatedMatterId: renewal.id }
    });
    expect(reverse).toBeNull();
  });

  it("重复建链是**幂等**的：不报错、不产生第二条，关系可被改写", async () => {
    // 第一版我按"唯一约束会报错"写了这条用例，跑出来才发现 addMatterLink 用的是 upsert：
    // 重复建链不会报错，而是把 relation 改写成新的。幂等比报错更合适（用户点两次不该看到失败）。
    const { matters } = await seedClientWithMatters(2);
    const [main, renewal] = matters;

    await addMatterLink(renewal.id, main.id, "RENEWAL");
    await addMatterLink(renewal.id, main.id, "RELATED_CASE");

    const rows = await prisma.matterLink.findMany({
      where: { matterId: renewal.id, relatedMatterId: main.id }
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].relation).toBe("RELATED_CASE");
  });

  it("委托次数按客户派生：软删案件不计入", async () => {
    const { client, matters } = await seedClientWithMatters(3);
    let count = await prisma.matter.count({ where: { primaryClientId: client.id, deletedAt: null } });
    expect(count).toBe(3);

    await prisma.matter.update({ where: { id: matters[2].id }, data: { deletedAt: new Date() } });
    count = await prisma.matter.count({ where: { primaryClientId: client.id, deletedAt: null } });
    expect(count).toBe(2);
  });
});
