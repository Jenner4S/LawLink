#!/usr/bin/env node
/**
 * 公开接口与登录中间件的一致性检查（2026-11-23）
 *
 * ## 背景（这是真踩过的坑）
 *
 * 加 `/api/inbound/lead` 时，单测 8 例全绿、`tsc`/`eslint`/`build` 全过，
 * 但线上用 curl 一打是 **307 重定向到 /login** —— 因为 `src/proxy.ts` 的
 * matcher 没排除这条路径。症状会是「表单提交成功但系统里没线索」，比报错更难查。
 *
 * 单测为什么没抓到：route 单测直接 import POST 函数调用，**绕过了 Next 的中间件**。
 *
 * ## 这个脚本做什么
 *
 * 找出 `src/app/api/**` 下**自己带鉴权、不依赖员工会话**的路由
 * （特征：读取 `x-*-token` 头，或用 `INBOUND_*` / `*_TOKEN` 环境变量比对），
 * 检查它是否在 `src/proxy.ts` 的 matcher 排除列表里。不在 → 失败。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const API = path.join(ROOT, "src/app/api");
const PROXY = path.join(ROOT, "src/proxy.ts");

const proxy = fs.readFileSync(PROXY, "utf8");
const matcherLine = proxy.split("\n").find((l) => l.includes("?!"));
if (!matcherLine) {
  console.log("⚠️  没找到 proxy.ts 的 matcher 排除列表，无法检查");
  process.exit(1);
}

/** 路由自己用 token 鉴权的特征 */
const SELF_AUTH = [/x-[a-z-]*token/i, /[A-Z_]+_TOKEN/, /timingSafeEqual/];

const routes = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (name === "route.ts") routes.push(full);
  }
};
walk(API);

const missing = [];
const publicRoutes = [];
for (const file of routes) {
  const text = fs.readFileSync(file, "utf8");
  if (!SELF_AUTH.some((re) => re.test(text))) continue;
  // 排除同时用 getServerSession 的（那些是员工接口，走登录即可）
  if (/getServerSession/.test(text)) continue;

  // 从路径推出 matcher 里的片段：src/app/api/inbound/lead/route.ts → api/inbound
  // 逐级前缀：matcher 里写一级（api/inbound）也算排除了 api/inbound/lead
  const rel = path.relative(API, file).replace(/\/route\.ts$/, "");
  const parts = rel.split("/");
  const seg = "api/" + parts.slice(0, 2).join("/");
  publicRoutes.push(seg);
  const covered = parts.some((_, i) => matcherLine.includes("api/" + parts.slice(0, i + 1).join("/")));
  if (!covered) missing.push({ seg, file: path.relative(ROOT, file) });
}

if (publicRoutes.length === 0) {
  console.log("✅ 没有发现「自带 token 鉴权」的 API 路由（无需检查）");
  process.exit(0);
}

console.log(`  自带 token 鉴权的路由 ${publicRoutes.length} 个：${publicRoutes.join(", ")}`);

if (missing.length === 0) {
  console.log("✅ 它们都已在 proxy.ts 的 matcher 排除列表里（不会被 307 到登录页）");
  process.exit(0);
}

console.log(`⚠️  ${missing.length} 个路由未在 matcher 排除：`);
for (const m of missing) console.log(`     ${m.seg}   (${m.file})`);
console.log("\n后果：外部调用会被 307 重定向到 /login，表现为「提交成功但数据没进来」。");
console.log("修法：在 src/proxy.ts 的 matcher 排除列表加该前缀，并注明为什么公开。");
process.exit(1);
