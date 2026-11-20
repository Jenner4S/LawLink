#!/usr/bin/env node
/**
 * 测试分层统计（2026-11-22）
 *
 * ## 解决什么问题
 *
 * 186 个测试文件里有大量**真库测试**：每个要建临时库、跑 `prisma migrate deploy`、
 * 结束后 DROP。全量跑十几分钟。改了纯函数（比如金额四舍五入）也要等全量，
 * 结果就是人开始跳过测试——**那比没有测试更危险**。
 *
 * 分层之后可以这样用：
 *   · 只改纯逻辑 → 先跑 `--unit`
 *   · 改了数据访问 / 事务 → 跑 `--db`
 *   · 交交付前 → 跑全量
 *
 * ## 判据（宁可误判为真库，不可误判为单元）
 *
 * 一个文件出现下列任一特征，就归为真库：
 *   · `createTempDatabase`（本项目的真库脚手架）
 *   · 直接 `CREATE DATABASE` / `DROP DATABASE`
 *   · 设置 `DATABASE_URL`（模块级单例在 import 期就要连库）
 *   · `prisma.$transaction` / `.findMany(` 等真实 SQL 调用
 *
 * 误判成单元的代价是「以为能快跑，其实连不上库直接红」，会误导人；
 * 误判成真库的代价只是「多花几分钟」。所以判据偏保守。
 *
 * 用法：
 *   node scripts/test-layers.mjs           # 汇总
 *   node scripts/test-layers.mjs --unit    # 只列可脱离数据库跑的文件
 *   node scripts/test-layers.mjs --db      # 只列必须起库的文件
 *   node scripts/test-layers.mjs --json    # 机器可读
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TESTS_DIR = path.join(ROOT, "src", "tests");

/** 递归收集 .test.ts(x) */
function collect(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

// 只在**确实是数据库访问**时命中：早先尝过用 `.update(` / `.create({` 这种裸方法名，
// 结果把 `createHash(...).update(...)` 判成了真库（crypto.test.ts / desktop-checkout.test.ts）。
// 判据必须锚定在 prisma 调用上，否则宁可漏判也不误判——但这里的取舍相反：
// 漏判（真库当单元）会让人以为能快跑却直接红，更误导；所以仍保留宽口径的"连库"特征，
// 只是把 ORM 方法名收紧到 `prisma.xxx.method(` 形式。
const DB_MARKERS = [
  /createTempDatabase/,
  /CREATE DATABASE/,
  /DROP DATABASE/,
  /process\.env\.DATABASE_URL/,
  /datasourceUrl/,
  /new PrismaClient/,
  /prisma\.[a-zA-Z]+\.(?:findMany|findFirst|findUnique|create|createMany|update|updateMany|upsert|delete|deleteMany|count|groupBy)/,
  /prisma\.\$transaction/,
  /prisma\.\$queryRaw/
];

function classify(file) {
  const src = readFileSync(file, "utf8");
  // 纯类型/工具文件不算（本脚本只扫测试）
  const hit = DB_MARKERS.find((re) => re.test(src));
  return hit ? { layer: "db", reason: String(hit) } : { layer: "unit", reason: "" };
}

const files = collect(TESTS_DIR).sort();
const rows = files.map((f) => ({
  file: path.relative(ROOT, f),
  ...classify(f)
}));

const db = rows.filter((r) => r.layer === "db");
const unit = rows.filter((r) => r.layer === "unit");

const arg = process.argv[2];
if (arg === "--json") {
  console.log(JSON.stringify({ total: rows.length, db: db.length, unit: unit.length, rows }, null, 2));
  process.exit(0);
}
if (arg === "--unit") {
  for (const r of unit) console.log(r.file);
  console.log(`\n合计 ${unit.length} 个纯单元文件（可脱离数据库跑）`);
  process.exit(0);
}
if (arg === "--db") {
  for (const r of db) console.log(r.file);
  console.log(`\n合计 ${db.length} 个真库文件（需 lawlink-db:55432 可用）`);
  process.exit(0);
}

console.log(`测试文件 ${rows.length} 个`);
console.log(`  · 纯单元（可脱离数据库）：${unit.length}`);
console.log(`  · 真库（需建临时库并迁移）：${db.length}`);
const ratio = rows.length ? Math.round((db.length / rows.length) * 100) : 0;
console.log(`真库占比：${ratio}%`);
if (ratio >= 50) {
  console.log("\n提示：真库占比过半，改纯逻辑时建议先 `npx vitest run --dir src/tests/lib` 或按 --unit 清单挑选。");
}
