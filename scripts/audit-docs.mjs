#!/usr/bin/env node
/**
 * 文档索引守卫（2026-11-23）
 *
 * ## 为什么要守
 *
 * `docs/` 里已经有 **84 份**文档。没有索引时，接手的人只能靠猜
 * 「这份是不是最新」；而**新增文档没人登记**，则是文档增殖的起点。
 *
 * 本脚本做三件事：
 *   ① 索引里提到的每个文件名必须真的存在（防止死链）；
 *   ② `docs/` 下的主文档（排除证据类、索引自身）必须出现在索引里；
 *   ③ 允许用 `*` 通配与 `/` 并列写法（如 `系统审计-20260920*.md`）。
 *
 * 证据类（`交付证据-*`）与台账不需要登记：前者只增不改，后者本身就是进度源。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");
const INDEX = path.join(DOCS, "文档索引.md");

/** 不要求登记的文档（有明确理由） */
const EXEMPT = [
  /^文档索引\.md$/,                 // 索引自身
  /^交付证据-/,                     // 执行归档，只增不改
  /^待办台账-/,                     // 进度源，本身就是入口
];

const indexText = fs.readFileSync(INDEX, "utf8");

/** 从索引里抽出反引号包裹的文件名（含 * 通配与 A / B 并列写法） */
const refs = [];
for (const m of indexText.matchAll(/`([^`]+\.md)`/g)) {
  for (const part of m[1].split("/")) {
    const name = part.trim();
    if (name.endsWith(".md")) refs.push(name);
  }
}

const exists = (name) => {
  if (name.includes("*")) {
    const re = new RegExp("^" + name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return fs.readdirSync(DOCS).some((f) => re.test(f));
  }
  return fs.existsSync(path.join(DOCS, name));
};

const problems = [];

// ① 死链
for (const name of refs) {
  if (!exists(name)) problems.push(`索引里的文件不存在：${name}`);
}

// ② 未登记的主文档
const covered = (file) =>
  refs.some((name) => {
    if (!name.includes("*")) return name === file;
    const re = new RegExp("^" + name.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(file);
  });

for (const file of fs.readdirSync(DOCS)) {
  if (!file.endsWith(".md")) continue;
  if (EXEMPT.some((re) => re.test(file))) continue;
  if (!covered(file)) problems.push(`docs/ 下有主文档未登记进索引：${file}`);
}

if (problems.length === 0) {
  console.log(`✅ 文档索引通过：${refs.length} 条引用全部有效，docs/ 下主文档均已登记`);
  process.exit(0);
}

console.log(`⚠️  发现 ${problems.length} 处问题：`);
for (const p of problems) console.log("  " + p);
console.log("\n处置：在 docs/文档索引.md 里登记（或修正失效文件名）；");
console.log("      证据类与台账无需登记（脚本已豁免）。");
process.exit(1);
