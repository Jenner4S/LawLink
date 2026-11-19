// @vitest-environment node
/**
 * 有待审归档申请的案件不得被软删除（2026-11-21）
 *
 * ## 怎么发现的
 *
 * 软删除一致性扫描（本轮）：按 id 写软删除实体的导出函数 24 个，
 * 其中 7 个靠断言间接过滤 deletedAt，剩下 3 个既无字面量也无间接守卫。
 * 逐个 triage 后发现真正的链路断点在**别处**：
 *
 *   approveArchiveRecord 会把 matter.status 改成 ARCHIVED；
 *   而 softDeleteMatter 只拦「未决交接」与「未办结事项」，
 *   **没有拦「正在审批中的归档申请」**。
 *
 * 于是可以：提交归档 → 删除案件 → 管理员批准。
 * 结果是：归档记录变成 APPROVED、拿到归档编号，而它指向的案件已被软删除。
 * 归档列表自己会过滤 `matter: { deletedAt: null }`，所以这条记录**从此不可见**
 * —— 一次静默的记录丢失，审批人还会以为处理完了。
 *
 * ## 修法
 *
 * 修在入口而不是出口：`softDeleteMatter` 增加「有待审归档则拒绝删除」。
 * 这样不进入不一致状态，也给用户明确动作（先完成或驳回归档）。
 *
 * 未做的（如实记）：删除与审批并发仍无序列化——两者各自在事务里读写，
 * 但这个窗口需要「恰好同时」，且 guard 已把稳态堵住，暂不为此加行锁。
 *
 * 隔离：自建临时库 `lawlink_delguard_test_*` → migrate deploy → DROP。
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
const CURRENT_USER = "del-guard-user";

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

const { softDeleteMatter } = await import("@/server/matters/actions");

let seq = 0;
async function seedMatter() {
  return prisma.matter.create({
    data: {
      internalCode: `LL-DEL-${++seq}-${Date.now().toString(36)}`,
      title: "待删除案",
      category: "CIVIL_COMMERCIAL" as never,
      status: "IN_PROGRESS",
      serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false,
      counterclaimAsPlaintiff: false,
      counterclaimAsDefendant: false,
      ownerId: CURRENT_USER,
      customValues: {}
    }
  });
}

async function seedArchive(matterId: string, status: "PENDING_REVIEW" | "REJECTED") {
  return prisma.archiveRecord.create({
    data: {
      matterId,
      archiveNo: `ARC-${++seq}-${Date.now().toString(36)}`,
      summary: "归档摘要",
      checklistJson: {},
      missingItems: [],
      archivedBy: "主办",
      status: status as never
    }
  });
}

describe("软删除 × 待审归档", () => {
  it("有 PENDING_REVIEW 归档申请时删除案件：拒绝，且案件未被标记删除", async () => {
    const m = await seedMatter();
    await seedArchive(m.id, "PENDING_REVIEW");

    await expect(softDeleteMatter(m.id)).rejects.toThrow(/归档/);
    const after = await prisma.matter.findUnique({ where: { id: m.id }, select: { deletedAt: true } });
    expect(after?.deletedAt).toBeNull();
  });

  it("归档申请已驳回时可以删除（基线：守卫不能把驳回后的案件也拦住）", async () => {
    const m = await seedMatter();
    await seedArchive(m.id, "REJECTED");

    await softDeleteMatter(m.id);
    const after = await prisma.matter.findUnique({ where: { id: m.id }, select: { deletedAt: true } });
    expect(after?.deletedAt).not.toBeNull();
  });

  it("没有任何归档申请时可以删除（基线：普通案件不受影响）", async () => {
    const m = await seedMatter();
    await softDeleteMatter(m.id);
    const after = await prisma.matter.findUnique({ where: { id: m.id }, select: { deletedAt: true } });
    expect(after?.deletedAt).not.toBeNull();
  });
});
