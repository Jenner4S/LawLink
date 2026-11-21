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

if (dead.length === 0) {
  console.log(`✅ 未发现死导出（扫描 ${defs.length} 个导出）`);
  process.exit(0);
}

console.log(`⚠️  ${dead.length} 个导出全仓无引用（扫描 ${defs.length} 个）：`);
for (const d of dead) console.log(`  ${d.file}  →  ${d.name}`);
console.log("\n处置：删除 / 加进可达性审计的有意清单 / 或确实要用就接上调用点。");
console.log("注意：这是保守判定，barrel 与动态引用可能漏判，需人工确认。");
