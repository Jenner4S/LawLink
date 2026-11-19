#!/usr/bin/env node
/**
 * 核对交付文档里的数字与实际是否一致；`--fix` 可自动同步。
 *
 * ## 为什么从 bash + perl 改成 node（2026-11-21）
 *
 * 前一版是 `.sh` + `perl -0pi`，一天内自伤两次：
 *
 *   ① `--fix` 后 `exec` 重跑整个脚本 → 又跑一遍测试（几分钟），
 *      且因输出缓冲提取到 `?`
 *   ② 某项提取失败时 `${ACTUAL}` 为空，perl 的
 *      `s/\d+ passed/${ACTUAL} passed/g` 变成 `s/\d+ passed/ passed/g`
 *      —— **把数字删掉**。实测把「141 files / 1420 passed」
 *      改成「141 files /  passed」
 *
 * 第二个是致命的：一个「防止文档说谎」的脚本自己说错话，比没有更糟。
 * 换成 node 后，空值保护是语言级能力（`if (!v) return`），不用和 perl 的
 * 转义规则搏斗。
 *
 * ## 用法
 *
 *   node scripts/check-doc-numbers.mjs          # 只检查，退出码 0/1
 *   node scripts/check-doc-numbers.mjs --fix    # 检查并写回
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOC = path.join(ROOT, "docs/DELIVERY-STATUS-20261120.md");
const LEDGER = path.join(ROOT, "docs/BACKLOG-20261118.md");
const FIX = process.argv.includes("--fix");

/** 跑一次测试，取出 "Tests  N passed" 里的 N。失败返回 null，绝不返回空串。 */
function measureTests() {
  try {
    const out = execFileSync("npx", ["vitest", "run"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: process.env
    });
    const m = out.match(/Tests\s+(\d+) passed/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const measureLedger = () => {
  const src = fs.readFileSync(LEDGER, "utf8");
  return src.split("\n").filter((l) => l.startsWith("| 2026-")).length;
};

const measureMigrations = () => {
  const dir = path.join(ROOT, "prisma/migrations");
  return fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, "migration.sql"))).length
    : 0;
};

function measureDrift() {
  try {
    const out = execFileSync(
      "npx",
      ["prisma", "migrate", "diff", "--from-schema-datasource", "prisma/schema.prisma",
       "--to-schema-datamodel", "prisma/schema.prisma", "--script"],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, env: process.env }
    );
    return /empty migration/i.test(out);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 文档里读当前写的值（读不到返回 null，而不是空串）
 * ------------------------------------------------------------------ */
function docTests() {
  const m = fs.readFileSync(DOC, "utf8").match(/(\d+) passed/);
  return m ? Number(m[1]) : null;
}
function docLedger() {
  const m = fs.readFileSync(DOC, "utf8").match(/\*\*(\d+) 条\*\*/);
  return m ? Number(m[1]) : null;
}
function docMigrations() {
  const m = fs.readFileSync(DOC, "utf8").match(/\*\*(\d+) 个迁移\*\*/);
  return m ? Number(m[1]) : null;
}

/* ------------------------------------------------------------------ *
 * 写回：只在「实测值有效」时替换，且替换函数要求命中至少一处
 * ------------------------------------------------------------------ */
function writeBack(label, from, to, apply) {
  if (to === null || !Number.isFinite(to)) {
    console.error(`  ⚠️ ${label}：实测值不可用（${to}），跳过，不写入空值`);
    return false;
  }
  // from === null 表示文档里现在读不到那个数字 —— 可能是上一次坏的替换把它删了。
  // 这种情况要能补回去，不能像 perl 版那样直接跳过（那正是它两次修不好的原因）。
  // 交回给 apply 用「宽松模式」处理，由它决定怎么补。
  if (from !== null && from === to) return false;
  const before = fs.readFileSync(DOC, "utf8");
  const after = apply(before, from, to);
  if (after === before) {
    console.error(`  ⚠️ ${label}：替换未命中（文档里的写法可能变了），跳过`);
    return false;
  }
  fs.writeFileSync(DOC, after);
  console.log(`  ✅ ${label}：${from} → ${to}`);
  return true;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const actual = {
  tests: measureTests(),
  ledger: measureLedger(),
  migrations: measureMigrations(),
  driftOk: measureDrift()
};

const shown = {
  tests: docTests(),
  ledger: docLedger(),
  migrations: docMigrations()
};

let fail = 0;
const row = (label, doc, act, ok) => {
  console.log(`  ${label.padEnd(10)} 文档 ${String(doc ?? "?").padEnd(6)} 实际 ${String(act ?? "?").padEnd(6)} ${ok ? "✅" : "❌"}`);
  if (!ok) fail = 1;
};
row("测试数", shown.tests, actual.tests, shown.tests === actual.tests);
row("台账条目", shown.ledger, actual.ledger, shown.ledger === actual.ledger);
row("迁移数", shown.migrations, actual.migrations, shown.migrations === actual.migrations);
console.log(`  ${"schema 漂移".padEnd(9)} ${actual.driftOk ? "None（一致）" : "有差异"}      ${actual.driftOk ? "✅" : "❌"}`);
if (!actual.driftOk) fail = 1;

if (FIX) {
  console.log();
  let changed = false;
  // 测试数：文档里有两种写法（表格里的 `N passed` 与命令注释里的 `N passed`）
  changed = writeBack("测试数", shown.tests, actual.tests, (src, from, to) => {
    if (from === null) {
      // 宽松模式：补回被删掉的数字（`files /  passed` → `files / 1420 passed`）
      return src.replaceAll("files /  passed", `files / ${to} passed`);
    }
    return src.replaceAll(`${from} passed`, `${to} passed`);
  }) || changed;
  changed = writeBack("台账条目", shown.ledger, actual.ledger, (src, from, to) => {
    if (from === null) return src.replaceAll("** 条**", `**${to} 条**`);
    return src.replaceAll(`**${from} 条**`, `**${to} 条**`);
  }) || changed;
  changed = writeBack("迁移数", shown.migrations, actual.migrations, (src, from, to) => {
    if (from === null) return src.replaceAll("** 个迁移**", `**${to} 个迁移**`);
    return src.replaceAll(`**${from} 个迁移**`, `**${to} 个迁移**`);
  }) || changed;
  if (!changed) console.log("  没有需要写回的项（或全部替换未命中）。");
  else console.log("\n  已写回。重跑本脚本可复核（会再跑一遍测试，约几分钟）。");
  if (changed) process.exit(0);
}

process.exit(fail);
