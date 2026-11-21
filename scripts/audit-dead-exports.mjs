#!/usr/bin/env node
/**
 * 未使用的导出扫描（2026-11-23）
 *
 * 这十几轮改了不少文件，最容易被忽略的欠账是**导出了但没人用**的函数——
 * 它们让读者以为存在某条路径，也会被误当"能力"计入盘点。
 *
 * 判定：`export function/const/type X` 在全仓（含测试）只出现一次（即定义处）。
 * 说明：保守 —— 只在测试里出现的也算"有用"，不算死代码。
 *
 * 注意：`export default` 与 barrel（index.ts 的 re-export）不参与判定。
 *
 * ## 基线（2026-11-23 加）
 *
 * 历史遗留有 55 个零引用导出，全部清掉风险大（旧模块归位不删、Server Action
 * 零 UI 仍可 RPC）。于是把它们登记进 `scripts/dead-exports-baseline.json` 作为
 * **允许值**；此后：
 *
 *   · 出现基线外的**新增**死导出 → 退出码 1（"你又造了个没人用的东西"）；
 *   · 基线里的某项**已经修好**（不再是零引用）→ 只提示，退出码 0
 *     （提示你去基线里删掉它，别让基线腐烂）。
 *
 * `--update-baseline` 可重写基线（慎用：只在确认"这些是有意保留"时才跑）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");

const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(name)) files.push(full);
  }
};
walk(SRC);

const texts = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
const all = [...texts.values()].join("\n");

const defs = [];
for (const [file, text] of texts) {
  if (/\.test\.tsx?$/.test(file)) continue;
  if (/\/index\.ts$/.test(file)) continue; // barrel 文件
  for (const m of text.matchAll(/^export (?:async )?(?:function|const|type|class|enum) (\w+)/gm)) {
    defs.push({ file: path.relative(ROOT, file), name: m[1] });
  }
}

const dead = [];
for (const d of defs) {
  const re = new RegExp(`\\b${d.name}\\b`, "g");
  const hits = (all.match(re) ?? []).length;
  if (hits <= 1) dead.push(d); // 只有定义处
}

const BASELINE = path.join(ROOT, "scripts/dead-exports-baseline.json");
const key = (d) => `${d.file}::${d.name}`;
const current = dead.map(key).sort();

if (process.argv.includes("--update-baseline")) {
  fs.writeFileSync(BASELINE, JSON.stringify(current, null, 2) + "\n", "utf8");
  console.log(`已写入基线：${current.length} 项 → ${path.relative(ROOT, BASELINE)}`);
  process.exit(0);
}

let baseline = [];
try {
  baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
} catch {
  console.log("⚠️  没找到基线文件。先跑一次 --update-baseline 登记当前状态。");
  process.exit(1);
}
const baselineSet = new Set(baseline);
const currentSet = new Set(current);

const added = current.filter((k) => !baselineSet.has(k));      // 新增死导出（要红）
const fixed = baseline.filter((k) => !currentSet.has(k));      // 已修好（可清理基线）

console.log(`  扫描 ${defs.length} 个导出，其中零引用 ${current.length} 个；基线 ${baseline.length} 个`);

if (fixed.length > 0) {
  console.log(`\n  ℹ️  ${fixed.length} 项基线里已不再是零引用（可删掉基线行）：`);
  for (const k of fixed) console.log(`     ${k}`);
}

if (added.length > 0) {
  console.log(`\n⚠️  ${added.length} 个**新增**零引用导出（不在基线里）：`);
  for (const k of added) console.log(`     ${k}`);
  console.log("\n处置：接上调用点 / 删掉 / 或确认「有意保留」后跑 --update-baseline 登记。");
  process.exit(1);
}

console.log("✅ 没有出现基线外的新增死导出");
process.exit(0);
