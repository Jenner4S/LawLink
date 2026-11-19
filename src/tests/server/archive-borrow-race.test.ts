// @vitest-environment node
/**
 * 归档借阅「在途去重」的并发安全（2026-11-21 补，P2 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `createArchiveBorrow` 原本是「findFirst 查在途 → create」。
 * 两步之间没有锁，也没有唯一约束。用户双击 / 网络重试时：
 *
 *   两个请求都查到「没有在途」→ 都 create → **两条 PENDING 借阅单**
 *
 * 两条都被批准的话，还会登记两份到期提醒、开两个有效访问窗口。
 *
 * 已实测复现（两条连接 + 显式交错跑同一段「查 → 建」）：
 *   无锁  在途借阅单数: 2  ❌
 *   有锁  在途借阅单数: 1  ✅
 *
 * ## 修法
 *
 * 把「查 + 建」放进一个事务，先对该归档记录行 `FOR UPDATE`，
 * 串行化同一案卷的借阅申请。第二次请求等第一次提交，那时能看见刚建的
 * PENDING 单，正确拒绝。
 *
 * **为什么不加部分唯一索引**：去重条件带状态与时效（PENDING，或 APPROVED
 * 且未到期），部分索引表达不了「时间」这一维；已归还/已过期的历史单也允许
 * 重复存在。行锁不动 Schema，语义更直观。
 *
 * ## 测试分层（与 client-contacts-race 同一套分法）
 *
 *   ① 行为测试：并发调 createArchiveBorrow，断言最多一条在途单
 *   ② 机制测试：手工两条连接 + 显式交错，验证 FOR UPDATE 真的串行化
 *   ③ 结构性守卫：防止有人删掉那一行锁（守不住「换成语义不同的写法」）
 *
 * 隔离：自建临时库 `lawlink_borrowrace_test_*` → migrate deploy → DROP。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_borrowrace_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let prisma: PrismaClient;
let admin: PrismaClient;

const CURRENT_USER = "borrow-race-user";

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
  } catch (err) {
    throw new Error(`临时库创建失败，需先启动 lawlink-db（${HOLDER.host}）：${String(err)}`);
  }
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: HOLDER.url }, stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  await prisma.user.create({
    data: { id: CURRENT_USER, email: "borrowrace@t.local", name: "借阅申请人", role: "LAWYER", passwordHash: "x", active: true }
  });
  console.info(`[archive-borrow-race] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[archive-borrow-race] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "LAWYER", rolePermissions: undefined } })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/server/audit", () => ({ audit: async () => {}, auditTx: async () => {} }));

const { createArchiveBorrow } = await import("@/server/archive/borrow");

async function seedArchive() {
  const matter = await prisma.matter.create({
    data: {
      internalCode: `LL-${Date.now().toString(36)}`, title: "借阅竞态测试案",
      category: "CIVIL_COMMERCIAL" as never, status: "ARCHIVED",
      serviceStatus: "SERVICE_COMPLETED", teamAccessRestricted: false,
      counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: CURRENT_USER, customValues: {}
    }
  });
  const rec = await prisma.archiveRecord.create({
    data: {
      matterId: matter.id, archiveNo: `AR-${Date.now().toString(36)}`,
      summary: "归档摘要", checklistJson: {}, archivedBy: "申请人", archivedById: CURRENT_USER,
      status: "APPROVED"
    }
  });
  return rec;
}

describe("createArchiveBorrow · 在途去重（真库）", () => {
  it("串行第二次申请：报「已有在途借阅」，不新增", async () => {
    const rec = await seedArchive();
    await createArchiveBorrow({ archiveRecordId: rec.id, reason: "查阅本案卷宗材料", scope: "WHOLE_VOLUME" } as never);
    await expect(
      createArchiveBorrow({ archiveRecordId: rec.id, reason: "再次查阅本案卷宗", scope: "WHOLE_VOLUME" } as never)
    ).rejects.toBeTruthy();
    expect(await prisma.archiveBorrowRequest.count({ where: { archiveRecordId: rec.id } })).toBe(1);
  });

  it("并发两次申请：最多留下一条在途单（不变量检查，非竞态复现）", async () => {
    // 坦白说：这条**复现不出竞态**。实测把行锁去掉它仍然绿——
    // 因为从「查到没有」到「create 提交」之间只隔一个 await，
    // 两次调用的时序几乎总是错开。
    // 真正验证锁的是下面那条【机制】测试，以及【结构性守卫】。
    // 这条留着是为了守住「在途单只能有一条」这个业务不变量（比如有人改成
    // 允许重复申请、或锁加了但去重条件被放宽），不宣称它是并发回归守卫。
    const rec = await seedArchive();
    const results = await Promise.allSettled([
      createArchiveBorrow({ archiveRecordId: rec.id, reason: "查阅本案卷宗甲", scope: "WHOLE_VOLUME" } as never),
      createArchiveBorrow({ archiveRecordId: rec.id, reason: "查阅本案卷宗乙", scope: "WHOLE_VOLUME" } as never)
    ]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const rows = await prisma.archiveBorrowRequest.findMany({ where: { archiveRecordId: rec.id } });
    expect(rows.length).toBe(1); // 关键不变量：绝不出现两条在途单
  });

  it("【机制】FOR UPDATE 真的把同一归档记录的申请串行化", async () => {
    // 手工两条连接 + 显式交错，复现的就是 createArchiveBorrow 里那段「查 → 建」。
    // 实测无锁时这里会留下 2 条，有锁留下 1 条 —— 这条是真的行为验证。
    const rec = await seedArchive();
    const other = new PrismaClient({ datasourceUrl: HOLDER.url });

    const apply = (db: PrismaClient, delayMs: number) =>
      db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM "ArchiveRecord" WHERE id = ${rec.id} FOR UPDATE`;
        const active = await tx.archiveBorrowRequest.findFirst({
          where: { archiveRecordId: rec.id, applicantId: CURRENT_USER, OR: [{ status: "PENDING" }] },
          select: { id: true }
        });
        await new Promise((r) => setTimeout(r, delayMs));
        if (active) throw new Error("已有在途借阅");
        return tx.archiveBorrowRequest.create({
          data: { archiveRecordId: rec.id, applicantId: CURRENT_USER, reason: "交错测试", status: "PENDING" }
        });
      });

    const a = apply(prisma, 200).catch(() => null);
    await new Promise((r) => setTimeout(r, 50));
    const b = apply(other, 0).catch(() => null);
    await Promise.all([a, b]);

    expect(await prisma.archiveBorrowRequest.count({ where: { archiveRecordId: rec.id } })).toBe(1);
    await other.$disconnect();
  });

  it("【结构性守卫】createArchiveBorrow 里确实取了归档记录行锁", async () => {
    // 守不住「换成语义不同但同样有锁的写法」—— 那种只能靠评审。
    // 这条只保证那一行不会被人无意删掉。
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/server/archive/borrow.ts", "utf8");
    const body = src.slice(src.indexOf("export async function createArchiveBorrow"));
    expect(body).toMatch(/SELECT 1 AS locked FROM "ArchiveRecord" WHERE id = \$\{record\.id\} FOR UPDATE/);
  });
});
