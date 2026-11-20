// @vitest-environment node
/**
 * 已归档案件不得再被修改其关联关系（2026-11-21）
 *
 * ## 发现过程
 *
 * 复核 `matters/actions.ts` 的 11 个导出时，逐个确认「能不能改已归档/已结案的案件」：
 *
 *   updateProcedureInfo   → assertMatterWritable ✅
 *   updateMatterTeam      → assertMatterWritable ✅
 *   updateMatterBasicInfo → assertMatterWritable ✅
 *   softDeleteMatter      → assertMatterWritable ✅
 *   addMatterLink         → **没有** ❌
 *   removeMatterLink      → **没有** ❌
 *
 * 而 `assertCanAssociateMatter` 只查「未删除 / 关联范围 / 隔离墙」，**不看案件状态**；
 * `searchMattersForLink` 也不按状态过滤，所以已归档案件确实可以被关联。
 *
 * 项目自己已有先例（docs/缺陷修复-20260906.md 第 11 条）：
 * 「关联案件的开票申请在任何入口都先检查案件可写，**归档案件不得新增申请**」。
 * 也就是说「归档即冻结」是本项目既定规则，关联关系这两条是漏网。
 *
 * ## 本文件守什么
 *
 * 归档案件的**自身记录**不得再被改动 —— 给归档案件加/删关联必须被拒。
 *
 * 有意保留的不对称（如实记录）：把**在办**案件关联到**已归档**案件仍然允许
 * （「参考已归档同类案」是真实动线）。该关联行记在在办案一侧，
 * 归档案件的存库字段没有被改写，只在展示层多一条反向引用。
 * 若将来认为展示层也不该变，需要在 `relatedMatterId` 一侧同样加守卫并同步产品口径。
 *
 * 隔离：自建临时库 `lawlink_linkguard_test_*` → migrate deploy → DROP。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

const NAME = vi.hoisted(() => {
  // 库名在这里生成；真正的建库与迁移在 beforeAll 里由 helpers/temp-db 做。
  // 必须在 hoisted 里先设 DATABASE_URL —— 被测 Server Action 通过 @/lib/prisma
  // 读环境变量建 client，import 时就要有值。
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
const CURRENT_USER = "link-guard-user";

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  await prisma.user.create({
    data: { id: CURRENT_USER, email: "t@t.local", name: "测试用户", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/server/audit", () => ({ audit: async () => {}, auditTx: async () => {} }));
vi.mock("@/server/matters/revalidate", () => ({ revalidateMatter: async () => {} }));

const { addMatterLink, removeMatterLink } = await import("@/server/matters/actions");

async function seedMatter(status: "IN_PROGRESS" | "ARCHIVED") {
  return prisma.matter.create({
    data: {
      internalCode: `LL-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      title: `${status} 案`,
      category: "CIVIL_COMMERCIAL" as never,
      status,
      serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false,
      counterclaimAsPlaintiff: false,
      counterclaimAsDefendant: false,
      ownerId: CURRENT_USER,
      customValues: {}
    }
  });
}

describe("已归档案件的关联关系不得再改", () => {
  it("给**已归档**案件新增关联：拒绝，且不落任何关联行", async () => {
    const archived = await seedMatter("ARCHIVED");
    const active = await seedMatter("IN_PROGRESS");

    await expect(addMatterLink(archived.id, active.id)).rejects.toThrow(/归档/);
    expect(await prisma.matterLink.count({ where: { matterId: archived.id } })).toBe(0);
  });

  it("从**已归档**案件删除关联：拒绝，原关联保持不变", async () => {
    const archived = await seedMatter("ARCHIVED");
    const active = await seedMatter("IN_PROGRESS");
    // 直接落库模拟「归档前就存在的关联」
    await prisma.matterLink.create({
      data: { matterId: archived.id, relatedMatterId: active.id, relation: "RELATED_CASE" as never, notedById: CURRENT_USER }
    });

    await expect(removeMatterLink(archived.id, active.id)).rejects.toThrow(/归档/);
    expect(await prisma.matterLink.count({ where: { matterId: archived.id } })).toBe(1);
  });

  it("**在办**案件之间的关联不受影响（基线：守卫不能误伤正常动线）", async () => {
    const a = await seedMatter("IN_PROGRESS");
    const b = await seedMatter("IN_PROGRESS");
    await addMatterLink(a.id, b.id);
    expect(await prisma.matterLink.count({ where: { matterId: a.id, relatedMatterId: b.id } })).toBe(1);
    await removeMatterLink(a.id, b.id);
    expect(await prisma.matterLink.count({ where: { matterId: a.id, relatedMatterId: b.id } })).toBe(0);
  });

  it("把**在办**案件关联到**已归档**案件仍然允许（参考已归档同类案是真实动线）", async () => {
    const active = await seedMatter("IN_PROGRESS");
    const archived = await seedMatter("ARCHIVED");
    await addMatterLink(active.id, archived.id);
    expect(await prisma.matterLink.count({ where: { matterId: active.id, relatedMatterId: archived.id } })).toBe(1);
  });
});
