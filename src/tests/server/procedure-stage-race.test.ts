// @vitest-environment node
/**
 * 环节物化的并发去重（2026-11-21 补，P2 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `materializeProcedureStage` 在事务里做「查重 → 插入」：
 *
 *   const existingStages = await tx.matterStage.findMany({ where: { procedureId } })
 *   const existing = existingStages.find(s => normalize(s.name) === normalizedTarget)
 *   if (existing) { ...抛「该环节已存在」... }
 *   await tx.matterStage.create({ ... })
 *
 * **事务存在，但默认隔离级别是 READ COMMITTED** —— 两个并发事务互相读不到
 * 对方未提交的行，于是都判定「不存在」，**同名环节建两条**。
 * `MatterStage` 也没有 `(procedureId, name)` 唯一约束兜底。
 *
 * 已实测复现（两条连接 + 显式交错跑同一段「查 → 建」）：
 *   无锁  同名环节数: 2  ❌
 *   有锁  同名环节数: 1  ✅
 *
 * 后果不只是列表里多一行：律师在两个同名环节里分别记材料与事项，
 * 程序轴上的进度就分散了；`order` 也会因为 updateMany 递增与插入的竞态而撞号。
 *
 * ## 修法
 *
 * 事务开头 `SELECT 1 FROM "MatterProcedure" WHERE id = $1 FOR UPDATE`，
 * 把同一程序的环节变更串行化。不用 Serializable：并发到这里的通常是
 * 第二个用户手快，串行化比「报 40001 让人重试」体验好，也不用写重试逻辑。
 *
 * ## 测试分层（与 129/130 轮同一套分法）
 *
 *   ① 行为：串行第二次添加同名环节被拒
 *   ② 不变量：并发两次添加，同名环节只有一条（**复现不出竞态，见注释**）
 *   ③ 机制：手工两条连接 + 显式交错，验证 FOR UPDATE 串行化
 *   ④ 结构性守卫：防止删掉那一行
 *
 * 隔离：自建临时库 `lawlink_stage_test_*` → migrate deploy → DROP。
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

const CURRENT_USER = "stage-test-user";

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  await prisma.user.create({
    data: { id: CURRENT_USER, email: "stage@t.local", name: "办案人", role: "LAWYER", passwordHash: "x", active: true }
  });
  console.info(`[procedure-stage] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "LAWYER", rolePermissions: undefined } })
}));
vi.mock("@/lib/permissions", async (orig) => ({
  ...(await orig<any>()),
  assertCanHandleMatter: async () => {},
  assertCanLeadMatter: async () => {}
}));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: async () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/server/audit", () => ({ audit: async () => {}, auditTx: async () => {} }));
vi.mock("@/server/matters/revalidate", () => ({ revalidateMatter: async () => {} }));
vi.mock("@/server/reminders/schedule", () => ({
  refreshScheduleReminderAfterSave: async () => {},
  retireScheduleReminders: async () => {}
}));

const { createProcedureStage } = await import("@/server/procedures/actions");

async function seedProcedure() {
  const matter = await prisma.matter.create({
    data: {
      internalCode: `LL-${Date.now().toString(36)}`, title: "环节物化测试案",
      category: "CIVIL_COMMERCIAL" as never, status: "IN_PROGRESS",
      serviceStatus: "SERVICE_ACTIVE", teamAccessRestricted: false,
      counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: CURRENT_USER, customValues: {}
    }
  });
  const proc = await prisma.matterProcedure.create({
    data: { matterId: matter.id, type: "FIRST_INSTANCE" as never, order: 1 }
  });
  return proc;
}

describe("createProcedureStage · 同名环节只应有一条（真库）", () => {
  it("串行第二次添加同名环节：报「该环节已存在」，不新增", async () => {
    const proc = await seedProcedure();
    await createProcedureStage({ procedureId: proc.id, name: "开庭审理" } as never);
    const before = await prisma.matterStage.count({ where: { procedureId: proc.id, name: "开庭审理" } });
    expect(before).toBe(1);

    await expect(
      createProcedureStage({ procedureId: proc.id, name: "开庭审理" } as never)
    ).rejects.toBeTruthy();
    expect(await prisma.matterStage.count({ where: { procedureId: proc.id, name: "开庭审理" } })).toBe(1);
  });

  it("并发两次添加同名环节：同名环节仍只有一条（不变量检查，非竞态复现）", async () => {
    // 坦白说：这条复现不出竞态 —— 实测去掉行锁它仍然绿，
    // 因为从「查到没有」到 create 之间只隔一个 await，两次调用几乎总是错开。
    // 真正验证锁的是下面那条【机制】测试与【结构性守卫】。
    // 这条守的是业务不变量（不允许同名环节并存），不宣称是并发回归守卫。
    const proc = await seedProcedure();
    await Promise.allSettled([
      createProcedureStage({ procedureId: proc.id, name: "举证质证" } as never),
      createProcedureStage({ procedureId: proc.id, name: "举证质证" } as never)
    ]);
    const rows = await prisma.matterStage.findMany({ where: { procedureId: proc.id, name: "举证质证" } });
    expect(rows.length).toBe(1);
  });

  it("【机制】FOR UPDATE 真的把同一程序的环节变更串行化", async () => {
    // 手工两条连接 + 显式交错，复现的是 materializeProcedureStage 里那段「查 → 建」。
    // 实测无锁时这里会留下 2 条同名环节，有锁留下 1 条。
    const proc = await seedProcedure();
    const other = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });

    const add = (db: PrismaClient, delayMs: number) =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM "MatterProcedure" WHERE id = ${proc.id} FOR UPDATE`;
        const rows = await tx.matterStage.findMany({ where: { procedureId: proc.id }, select: { name: true } });
        await new Promise((r) => setTimeout(r, delayMs));
        if (rows.some((r) => r.name === "开庭审理")) throw new Error("该环节已存在");
        return tx.matterStage.create({ data: { procedureId: proc.id, name: "开庭审理", order: rows.length + 1 } });
      });

    const a = add(prisma, 200).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    const b = add(other, 0).catch(() => null);
    await Promise.all([a, b]);

    expect(await prisma.matterStage.count({ where: { procedureId: proc.id, name: "开庭审理" } })).toBe(1);
    await other.$disconnect();
  });

  it("【结构性守卫】materializeProcedureStage 里确实取了程序行锁", async () => {
    // 守不住「换成语义不同但同样有锁的写法」——那种只能靠评审。
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/server/procedures/actions.ts", "utf8");
    const body = src.slice(src.indexOf("async function materializeProcedureStage"));
    expect(body).toMatch(/SELECT 1 AS locked FROM "MatterProcedure" WHERE id = \$\{data\.procedureId\} FOR UPDATE/);
  });
});
