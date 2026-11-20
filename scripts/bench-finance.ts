#!/usr/bin/env node
/**
 * 财务台账读取的性能基准（2026-11-22）
 *
 * ## 为什么需要它
 *
 * 2026-11-22 测页面耗时发现 `/finance` 最慢（570–810ms，中位 199ms），
 * 归因是这一页落下约 34 条 SQL。当时想顺手把 `readLedger` 里 3 条独立查询
 * 并进 `Promise.all`（省 2 次往返 ≈ 25ms），但**页面测量方差 ±50ms，
 * 改完无法证明收益** —— 于是没做，并立了规矩：要做先建可重复的计时基准。
 *
 * 这个脚本就是那个基准。它**不测浏览器**（噪声太大），直接测函数：
 *
 *   · 固定数据量（默认 200 个案件 × 每案 3 应收/3 实收/3 发票）
 *   · 同一台机器、同一临时库
 *   · 跑 N 轮取中位数（对偶发 GC/调度抖动不敏感）
 *
 * ## 用法
 *
 *   node scripts/bench-finance.ts                  # 默认 200 案 / 20 轮
 *   node scripts/bench-finance.ts --matters 500 --rounds 30
 *   node scripts/bench-finance.ts --keep           # 不删临时库（复核用）
 *
 * ## 判定标准（写在前面，避免事后找理由）
 *
 * 改动只有在**中位数下降 > 2×中位绝对偏差**时才算有效。否则记「无法证明收益」，
 * 不合并那次改动 —— 「改了一行然后把噪声当成果」比不改更糟。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const argOf = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : fallback;
};
const MATTERS = argOf("matters", 200);
const ROUNDS = argOf("rounds", 20);
const KEEP = args.includes("--keep");

const HOST = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
const USER = process.env.FIN_TEST_PG_USER ?? "lawlink";
const PASSWORD = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
const NAME = `lawlink_bench_${Date.now().toString(36)}`;
const urlFor = (db: string) => `postgresql://${USER}:${PASSWORD}@${HOST}/${db}?schema=public`;

const D = (v: string) => new Prisma.Decimal(v);

async function main() {
  const admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  await admin.$executeRawUnsafe(`CREATE DATABASE "${NAME}"`);
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: urlFor(NAME) },
    stdio: "pipe"
  });

  const prisma = new PrismaClient({ datasourceUrl: urlFor(NAME) });
  try {
    // ── 灌数据 ────────────────────────────────────────────
    const user = await prisma.user.create({
      data: { email: `bench@${NAME}.local`, name: "基准用户", role: "FINANCE", passwordHash: "x", active: true }
    });
    const t0 = Date.now();
    const matterIds: string[] = [];
    for (let i = 0; i < MATTERS; i++) {
      const m = await prisma.matter.create({
        data: {
          internalCode: `BENCH-${i}`,
          title: `基准案件 ${i}`,
          category: "CIVIL_COMMERCIAL",
          status: "IN_PROGRESS",
          serviceStatus: "SERVICE_ACTIVE",
          teamAccessRestricted: false,
          counterclaimAsPlaintiff: false,
          counterclaimAsDefendant: false,
          ownerId: user.id,
          customValues: {}
        }
      });
      matterIds.push(m.id);
      for (let k = 0; k < 3; k++) {
        await prisma.receivable.create({
          data: { matterId: m.id, title: `应收${k}`, amount: D("10000.00"), moneyKind: "LAWYER_FEE" }
        });
        const fee = await prisma.feeEntry.create({
          data: {
            matterId: m.id, type: "RECEIVED", amount: D("10000.00"), moneyKind: "LAWYER_FEE",
            confirmState: "CONFIRMED", recordedById: user.id
          }
        });
        await prisma.payment.create({
          data: { matterId: m.id, feeEntryId: fee.id, amount: D("10000.00"), moneyKind: "LAWYER_FEE" }
        });
        await prisma.invoiceRequest.create({
          data: { matterId: m.id, amount: D("10000.00"), status: "ISSUED", invoiceNo: `INV-${i}-${k}`, requestedById: user.id }
        });
      }
    }
    console.log(`  灌数据：${MATTERS} 个案件（每案 3 应收/3 实收/3 发票），耗时 ${Date.now() - t0}ms`);

    // ── 基准：直接测 readLedger（不经过浏览器）────────────
    //
    // **两种模式都要测**：生产热路径 `getFinanceLedger` 是在
    // `prisma.$transaction` 内部调用 readLedger 的（ledger-actions.ts:29）。
    // 事务内的查询跑在**同一条连接上、串行执行** —— 所以「把 3 条独立查询
    // 并进 Promise.all」在事务内**不会真的并行**。
    // 只测事务外会得出一个生产环境不成立的假收益。
    const { readLedger } = await import("@/server/finance/ledger-storage");

    const measure = async (label: string, run: () => Promise<unknown>) => {
      await run(); // 预热（JIT / 连接池 / 计划缓存）
      const samples: number[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const s = performance.now();
        await run();
        samples.push(performance.now() - s);
      }
      samples.sort((a, b) => a - b);
      const median = samples[Math.floor(samples.length / 2)];
      const p90 = samples[Math.floor(samples.length * 0.9)];
      const dev = samples.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      console.log("");
      console.log(`  ${label} × ${ROUNDS} 轮`);
      console.log(`    中位 ${median.toFixed(1)}ms   中位绝对偏差 ${dev.toFixed(1)}ms   p90 ${p90.toFixed(1)}ms`);
      console.log(`    最小 ${samples[0].toFixed(1)}ms   最大 ${samples[samples.length - 1].toFixed(1)}ms`);
      console.log(`    判定门槛：中位下降需 > ${(dev * 2).toFixed(1)}ms 才算有效`);
      return { median, dev };
    };

    await measure(`readLedger(${MATTERS} 案) · 事务外`, () => readLedger(prisma as never, matterIds));
    await measure(`readLedger(${MATTERS} 案) · 事务内（=生产热路径）`, () =>
      prisma.$transaction(async (tx) => readLedger(tx as never, matterIds))
    );
  } finally {
    await prisma.$disconnect();
    if (!KEEP) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${NAME}" WITH (FORCE)`);
      console.log(`  已 DROP 临时库 ${NAME}`);
    } else {
      console.log(`  保留临时库 ${NAME}（--keep）`);
    }
    await admin.$disconnect();
  }
}

main().catch(async (err) => {
  console.error("基准失败：", err);
  process.exit(1);
});
