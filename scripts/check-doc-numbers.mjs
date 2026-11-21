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

// 2026-11-21：自己加载 .env，不依赖调用方 `set -a && . ./.env`。
//
// 之前依赖外部导出 DATABASE_URL，忘了导出时 `prisma migrate diff` 会失败，
// measureDrift() 返回 false，脚本就报「schema 漂移 有差异」——
// 手跑同一条命令却是空的。**检查工具因为自己环境没准备好而误报**，
// 与上一轮 perl 版把数字删掉是同一类问题：工具本身不可靠。
function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue; // 已有值不覆盖
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadDotEnv();

// 2026-11-21：.env 里只有 POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD，
// 没有 DATABASE_URL（项目一直靠 `set -a && . ./.env` 或手动 export）。
// 忘 export 时 prisma 命令跑不起来，脚本会误报「schema 漂移 有差异」。
// 这里按 compose 的约定拼出来，让脚本不依赖调用方的 shell 状态。
if (!process.env.DATABASE_URL && process.env.POSTGRES_DB && process.env.POSTGRES_USER) {
  const port = process.env.POSTGRES_PORT || "55432";
  process.env.DATABASE_URL =
    `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD ?? ""}` +
    `@localhost:${port}/${process.env.POSTGRES_DB}?schema=public`;
}
const DOC = path.join(ROOT, "docs/交付状态-20261120.md");
const LEDGER = path.join(ROOT, "docs/待办台账-20261118.md");
const FIX = process.argv.includes("--fix");

/** 跑一次测试，取出 "Tests  N passed" 里的 N。失败返回 null，绝不返回空串。 */
/**
 * 跑测试这件事一次只能有一个（2026-11-21 加）。
 *
 * 起因：`check-doc-numbers` 和 `mutation-check` 都会跑完整 `vitest run`。
 * 两个同时跑时，各自那些「真库测试」会同时 `CREATE DATABASE`，
 * 撞上 PostgreSQL 的模板库锁，一边报：
 *   LockAcquireExtended  ...  CREATE DATABASE
 * 于是 vitest 退出码 1，本脚本读不到测试数，屏幕上出现「实际 ?」。
 *
 * 这在我这儿发生过三次，每次都要花时间排查「到底文档错了还是没测成」。
 * 用 mkdir 做原子锁（POSIX 上 mkdir 是原子的），让第二个进程排队等，
 * 而不是两个一起撞死。
 *
 * 超时上限 15 分钟（全量测试约 2-3 分钟，留足余量）；超时后不强等，
 * 继续往下跑并把原因说出来 —— 卡死比失败更糟。
 */
const LOCK_PARENT = path.join(ROOT, "node_modules", ".cache");
const LOCK_DIR = path.join(LOCK_PARENT, "lawlink-test-run.lock");

async function withTestLock(fn) {
  // 父目录可能不存在（干净的 node_modules 没有 .cache）—— 先建，
  // 否则 mkdirSync(recursive:false) 抛 ENOENT，被外层 catch 当成「测试没跑起来」。
  fs.mkdirSync(LOCK_PARENT, { recursive: true });
  const start = Date.now();
  const deadline = start + 15 * 60_000;
  let waited = false;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIR, { recursive: false });
      fs.writeFileSync(path.join(LOCK_DIR, "pid"), String(process.pid));
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (!waited) {
        console.error("  ⏳ 另一个进程正在跑测试，排队等待（避免撞 PostgreSQL 模板库锁）…");
        waited = true;
      }
      if (Date.now() > deadline) {
        console.error("  ⚠️ 等锁超过 15 分钟，放弃等待，继续尝试（可能会因并发失败）");
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      /* 清锁失败不影响主流程 */
    }
  }
}

async function measureTests() {
  try {
    const out = await withTestLock(() => execFileSync("npx", ["vitest", "run"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      env: process.env
    }));
    const m = out.match(/Tests\s+(\d+) passed/);
    if (!m) {
      // 2026-11-21：实测过一种情况 —— 同时有另一个 vitest 在跑时，
      // 输出可能被交错的进程信息打乱、匹配不到这一行。
      // 返回 null 而不是 0，让主流程报「未知」而不是「文档写错了」。
      // 把输出末尾打出来 —— 光说「读不到」帮不了排查，得看到它到底印了什么。
      const tail = out.split("\n").filter((l) => /Test|Tests|Files|fail|passed/i.test(l)).slice(-6).join("\n");
      console.error("  ⚠️ 从 vitest 输出里读不到『Tests N passed』。相关行：");
      console.error(tail ? tail.split("\n").map((l) => "      " + l).join("\n") : "      （输出里没有任何 Tests 相关行）");
      return null;
    }
    return Number(m[1]);
  } catch (err) {
    // 2026-11-21：原来这里静默返回 null，于是「vitest 根本没跑起来」和
    // 「跑起来了但输出格式变了」在屏幕上完全一样（都是 实际 ?）。
    // 现在把原因打出来 —— 诊断的价值在于指向对的地方。
    const status = err && typeof err === "object" && "status" in err ? `退出码 ${err.status}` : "无退出码";
    const stderr = err && typeof err === "object" && "stderr" in err && err.stderr ? String(err.stderr).slice(-400) : "";
    console.error(`  ⚠️ vitest 没有正常跑完（${status}）${stderr ? `，stderr 末尾：\n${stderr}` : ""}`);
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
  } catch (err) {
    // 命令本身跑不起来（缺 DATABASE_URL、库连不上）不等于「有漂移」。
    // 返回 null 表示未知，主流程会报 ⚠️ 而不是 ❌，避免误报。
    console.error(`  ⚠️ migrate diff 执行失败（不是漂移，是命令没跑起来）：${String(err).slice(0, 120)}`);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 文档里读当前写的值（读不到返回 null，而不是空串）
 * ------------------------------------------------------------------ */
/** 实测测试文件数（静态目录扫描，很便宜） */
function measureTestFiles() {
  const walk = (dir, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, out);
      else if (/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  };
  try {
    return walk(path.join(ROOT, "src")).length;
  } catch {
    return null;
  }
}

function docTests() {
  const m = fs.readFileSync(DOC, "utf8").match(/(\d+) passed/);
  return m ? Number(m[1]) : null;
}
function docLedger() {
  const m = fs.readFileSync(DOC, "utf8").match(/\*\*(\d+) 条\*\*/);
  return m ? Number(m[1]) : null;
}
/**
 * 测试**文件数**（2026-11-23 补）。
 *
 * 之前只校验"用例数"，而快照里同时写了「199 个测试文件」——
 * 加一个文件就等于两处要改，容易只改一处。这条把它也钉住。
 */
function docTestFiles() {
  const m = fs.readFileSync(DOC, "utf8").match(/(\d+) (?:files|个测试文件)/);
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
  tests: await measureTests(),
  files: measureTestFiles(),
  ledger: measureLedger(),
  migrations: measureMigrations(),
  driftOk: measureDrift()
};

const shown = {
  tests: docTests(),
  files: docTestFiles(),
  ledger: docLedger(),
  migrations: docMigrations()
};

let fail = 0;
/**
 * 三态输出（2026-11-21 修）。
 *
 * 原先只有两态：相等 ✅ / 不等 ❌。但「实测值拿不到」时 act 是 null，
 * 于是也走 ❌ 分支，屏幕上出现「文档 1462 实际 ? ❌」——
 * 读起来像「文档写错了」，实际是「这次没测成」。
 *
 * 这两种情况的后续动作完全不同：
 *   ❌ 要改文档（或改代码）
 *   ⚠️ 要换时机重跑（比如另一个 vitest 正在跑，输出交错）
 *
 * 现在分开：act 为 null 报 ⚠️ 且**不计入失败**（但整轮仍返回非零，
 * 因为「没验成」不能当通过）。这样屏幕上的指向永远是对的。
 */
const row = (label, doc, act, ok) => {
  const cell = (v) => String(v ?? "?").padEnd(6);
  if (act === null || act === undefined) {
    console.log(`  ${label.padEnd(10)} 文档 ${cell(doc)} 实际 ${cell(act)} ⚠️ 未测成（不是文档错）`);
    fail = 1; // 没验成也不算通过
    return;
  }
  console.log(`  ${label.padEnd(10)} 文档 ${cell(doc)} 实际 ${cell(act)} ${ok ? "✅" : "❌"}`);
  if (!ok) fail = 1;
};
row("测试数", shown.tests, actual.tests, shown.tests === actual.tests);
if (shown.files !== null) {
  // 只在文档确实写了"文件数"时才校验（旧文档没有这一项，不因此失败）
  row("测试文件", shown.files, actual.files ?? null, shown.files === actual.files);
}
row("台账条目", shown.ledger, actual.ledger, shown.ledger === actual.ledger);
row("迁移数", shown.migrations, actual.migrations, shown.migrations === actual.migrations);
if (actual.driftOk === null) {
  console.log(`  ${"schema 漂移".padEnd(9)} 未知（命令未跑起来）  ⚠️`);
  fail = 1;
} else {
  console.log(`  ${"schema 漂移".padEnd(9)} ${actual.driftOk ? "None（一致）" : "有差异"}      ${actual.driftOk ? "✅" : "❌"}`);
  if (!actual.driftOk) fail = 1;
}

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
