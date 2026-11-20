// @vitest-environment node
/**
 * /finance 首屏取数的**查询条数画像**（真库，2026-11-21）
 *
 * ## 为什么要这个文件
 *
 * 台账长期挂着「/finance 34 查询瓶颈」，但一直没人复核得了：
 *   · xact_commit 增量被 cron worker 干扰（实测同页三次 2 / 132 / 229）
 *   · pg_stat_statements 未安装，装它要改容器 shared_preload_libraries 并重启 DB
 *
 * 换一条不需要动生产配置的路：在**临时库**上给 Prisma 挂 `query` 事件监听，
 * 直接调页面用的那批取数函数，数出真实条数。可重复、可对比、零生产影响。
 *
 * ## 断言的用意（棘轮，不是精确值）
 *
 * 上面那条 `≤ CEILING` 不是「当前值」，而是**上限**：将来谁加了 N+1，
 * 条数会跳上去，这里先红。精确值会随业务变化，写死精确值只会变成噪声。
 *
 * ## 本文件测不到的（如实声明）
 *
 * · 页面 RSC 渲染之外的串行开销（React 渲染、序列化）
 * · 真实数据量下的耗时（临时库是空库，查询都命中空表）
 *
 * ## 结论：不优化（2026-11-21 分析过，别重复）
 *
 * 画像里最显眼的可优化点是 `financeLedgerReady` 的 information_schema 探测
 * **在一页里跑了 5 次**。看起来加个模块级缓存就能省掉 4 次，但**不做**：
 *
 *   · 探测结果依赖**当前库结构**，而结构在测试里会被中途修改——
 *     `finance-ledger-read` / `-sign` / `-correction` 三个文件都会
 *     `ALTER TABLE "Payment" ADD COLUMN "reviewState"` 来模拟未升级库。
 *     加缓存就得在三个地方补失效调用，且未来任何同类测试都会踩坑。
 *   · 收益是 5 条**元数据**查询（返回一个布尔），量级远小于 0.2s 的页面渲染。
 *   · 用 React `cache()` 只能省 RSC 渲染内的重复，测试与脚本测不出改进，
 *     等于换一个「无法验证的优化」。
 *
 * 判断：**为省 4 条元数据查询引入一处正确性耦合，不划算。**
 * 耗时另行用手工采样：见台账 2026-11-21 06:50 记录（0.18–0.35s）。
 */
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { createTempDatabase } from "@/tests/helpers/temp-db";

const NAME = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

/** 查询计数器：Prisma 的 query 事件在每次 SQL 执行后触发 */
const counter = { n: 0, sql: [] as string[] };

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  // 用带 event 日志的 client：需要显式声明 log 才拿得到 query 事件
  prisma = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  (prisma as unknown as { $on: (e: "query", cb: (ev: { query: string }) => void) => void }).$on("query", (ev) => {
    counter.n += 1;
    counter.sql.push(ev.query);
  });
  dropDb = async () => { await db.drop(); };
  const u = await prisma.user.create({
    data: { email: "owner@fin.local", name: "合伙人", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await dropDb?.();
}, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } })),
  getSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const finance = await import("@/server/finance/actions");
const invoices = await import("@/server/invoices/actions");
const recon = await import("@/server/finance/invoice-reconciliation");
const aging = await import("@/server/finance/aging");

/** 页面 `/finance` 的 10 个并行取数（顺序与 page.tsx 一致） */
async function runFinancePageQueries() {
  await Promise.all([
    finance.listAllFeeEntries({ limit: 500 }),
    finance.listPendingReceipts(),
    finance.listAllFeeEntries({ type: "COMMISSION", limit: 500 }),
    finance.getFinanceKpis(),
    finance.getMonthlyRevenue(12),
    finance.getPersonalRevenue(STAFF.id),
    invoices.listInvoiceRequests(),
    invoices.getInvoiceStats(),
    aging.getReceivablesAging(),
    recon.getInvoiceReconciliation()
  ]);
}

beforeEach(() => { counter.n = 0; counter.sql.length = 0; });

describe("/finance 首屏查询画像", () => {
  it("量出条数并打印（诊断输出）", async () => {
    await runFinancePageQueries();
    // 打印明细便于人工复核哪些表被反复查
    const byTable = new Map<string, number>();
    for (const q of counter.sql) {
      // Prisma 生成的是 FROM "public"."Table" —— 取最后一个带引号的标识符
      const m = q.match(/FROM\s+"(?:[A-Za-z_]+)"\."([A-Za-z_]+)"/) ?? q.match(/FROM\s+"([A-Za-z_]+)"/);
      const k = m?.[1] ?? "(other)";
      byTable.set(k, (byTable.get(k) ?? 0) + 1);
    }
    const summary = [...byTable.entries()].sort((a, b) => b[1] - a[1]);
    console.info(`[/finance] 共 ${counter.n} 条查询；按表：${JSON.stringify(Object.fromEntries(summary))}`);
    // 同一形状重复出现 = 潜在可合并点；打印归一化后的次数，便于判断
    const shape = (q: string) => q.replace(/\$\d+/g, "?").replace(/\s+/g, " ").trim().slice(0, 120);
    const dupes = new Map<string, number>();
    for (const q of counter.sql) {
      const k = shape(q);
      dupes.set(k, (dupes.get(k) ?? 0) + 1);
    }
    const repeated = [...dupes.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    console.info(`[/finance] 重复形状 ${repeated.length} 种：` + (repeated.length ? JSON.stringify(repeated.slice(0, 8)) : "无"));

    expect(counter.n).toBeGreaterThan(0);
  });

  it("查询条数不超过棘轮上限（防 N+1 回归）", async () => {
    await runFinancePageQueries();
    // CEILING 取「实测值 + 少量余量」：精确值随业务变化，写死只会变成噪声；
    // 上限的作用是——谁加了 N+1，条数会明显跳上去，这里先红。
    const CEILING = 40;
    expect(counter.n, `实测 ${counter.n} 条，上限 ${CEILING}。若确属业务增长请同步上调并说明原因`).toBeLessThanOrEqual(CEILING);
  });
});
