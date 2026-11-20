#!/usr/bin/env node
/**
 * 金线变异验证（2026-11-22）
 *
 * ## 解决什么问题
 *
 * 「金线能抓住缺陷」这句话本身需要证据。手工做法（改一行 → 重新构建 → 起实例 →
 * 跑金线 → 看是否红 → 恢复）本轮做过一次，8 分钟构建 × 2 次，且**容易忘恢复**。
 * 这个脚本把整条流程固化成一条命令，并保证无论成败都恢复源码、停实例、清产物。
 *
 * ## 关键设计：构建后立刻恢复源码
 *
 * 变异在**构建阶段**固化进产物，构建完成就立即把源码恢复。
 * 于是：
 *   · 产品代码里不留任何"变异开关"（那是长期负债）；
 *   · 源码树在跑完时一定是干净的，不依赖人记得 revert。
 *
 * ## 判据（严格）
 *
 * 一次变异算「有效」必须同时满足：
 *   ① 金线退出码非 0（确实红了）；
 *   ② 输出里出现**预期的那一条**检查失败（不是别的偶然错误把它弄红了）。
 * 只有 ① 不算——服务没起来、CDP 掉了都会让脚本非 0，那是假阳性。
 *
 * ## 用法
 *
 *   node scripts/mutation-golden.mjs              # 跑全部定义
 *   node scripts/mutation-golden.mjs --only client-skip-write
 *   node scripts/mutation-golden.mjs --dry        # 只打印计划，不构建
 *
 * 注意：每个变异要跑一次 `next build`（约 8 分钟）+ 起一个实例。
 * 这是**按需工具**，不适合放进每次 CI；改动了写入路径时跑一次即可。
 */
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const PORT = process.env.MUT_PORT ?? "3111";
const DIST = ".next-mutation";
/**
 * `next build` 会按 NEXT_DIST_DIR 改写这两个文件（本项目已知特性）。
 * 构建前快照、跑完恢复，否则跑一次变异就把工作树弄脏，
 * 下一个人 `git status` 会看到两处无意义的改动。
 */
const BUILD_REWRITTEN = ["next-env.d.ts", "tsconfig.json"];

/** 变异定义：把 find 替换成 replace，期望金线中 `expect` 这条检查变红 */
/*
 * 新增变异的两个陷阱（本轮都踩过）：
 *
 * ① **早返回会让类型收窄失效**。在 `create` 之前插 `return {...}` 会触发
 *    `'viewer' is possibly 'null'` 一类错误 —— 因为 TS 认为后续代码可达。
 *    可用 `as never` 绕过（client-skip-write 就是这么做的）。
 * ② **`if (false)` 死分支同样破坏收窄**，不要用它来"注释掉"写入。
 *
 * 若变异让 `next build` 失败，脚本会明确报告「变异本身不合法」——
 * 那**不等于**金线抓住了缺陷，不能算通过。
 */
const MUTATIONS = [
  {
    name: "client-skip-write",
    file: "src/server/clients/actions.ts",
    find: "  const created = await roleMutation(session.user, \"clients.write\", async roleDb => roleDb.client.create({",
    replace:
      "  // [MUTATION] 跳过真实写入，验证金线的「真实落库」断言不是空转\n" +
      "  return { ok: true as const, id: \"mutation-skip-write\" } as never;\n" +
      "  const created = await roleMutation(session.user, \"clients.write\", async roleDb => roleDb.client.create({",
    expect: "界面提交后**真实落库**"
  },
];

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;

if (selected.length === 0) {
  console.error(`没有匹配的变异：${only}`);
  process.exit(2);
}

if (dry) {
  for (const m of selected) {
    const src = readFileSync(path.join(ROOT, m.file), "utf8");
    const hit = src.includes(m.find);
    console.log(`${m.name} → ${m.file} 命中=${hit} 预期变红=${m.expect}`);
  }
  process.exit(0);
}

/** 起实例并等待可访问；失败抛错 */
async function startServer(distDir, port) {
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: ROOT,
    env: { ...process.env, NEXT_DIST_DIR: distDir, PORT: String(port) },
    stdio: "ignore",
    detached: true
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/login`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return child;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
  throw new Error(`变异实例 ${port} 在 90s 内未就绪`);
}

function stopServer(child) {
  if (!child) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
}

const results = [];
for (const m of selected) {
  const abs = path.join(ROOT, m.file);
  const backup = `${abs}.mutation-backup`;
  let server = null;
  let verdict = { name: m.name, ok: false, why: "" };
  const rewritten = new Map();

  console.log(`\n=== 变异：${m.name}（${m.file}） ===`);
  try {
    const src = readFileSync(abs, "utf8");
    if (!src.includes(m.find)) {
      verdict.why = "变异锚点未命中（代码已改动？请更新脚本里的 find 串）";
      console.log(`  ✗ ${verdict.why}`);
      results.push(verdict);
      continue;
    }

    copyFileSync(abs, backup);
    writeFileSync(abs, src.replace(m.find, m.replace), "utf8");
    // 快照被 next build 改写的生成文件，跑完原样写回
    for (const rel of BUILD_REWRITTEN) {
      const p2 = path.join(ROOT, rel);
      if (existsSync(p2)) rewritten.set(rel, readFileSync(p2, "utf8"));
    }
    console.log("  · 已注入变异");

    rmSync(path.join(ROOT, DIST), { recursive: true, force: true });
    execFileSync("npx", ["next", "build"], {
      cwd: ROOT,
      env: { ...process.env, NEXT_DIST_DIR: DIST },
      stdio: "pipe"
    });
    console.log("  · 构建完成（变异已固化进产物）");

    // 关键：立刻恢复源码，跑完不留痕
    copyFileSync(backup, abs);
    rmSync(backup, { force: true });
    console.log("  · 源码已恢复（产物仍是变异版）");

    server = await startServer(DIST, PORT);
    console.log(`  · 变异实例已就绪 :${PORT}`);

    let out = "";
    let code = 0;
    try {
      out = execFileSync("node", ["scripts/golden-thread-write.mjs"], {
        cwd: ROOT,
        env: { ...process.env, BASE: `http://localhost:${PORT}` },
        stdio: "pipe",
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024
      });
    } catch (err) {
      code = typeof err.status === "number" ? err.status : 1;
      out = String(err.stdout ?? "") + String(err.stderr ?? "");
    }

    const red = code !== 0;
    const expectedRed = out.includes(m.expect);
    verdict.ok = red && expectedRed;
    verdict.why = red
      ? expectedRed
        ? `如预期：${m.expect} 变红`
        : `红了但不是预期那条（期望含「${m.expect}」）`
      : "**未变红 —— 这条金线抓不住这个缺陷（假测试）**";
    console.log(`  ${verdict.ok ? "✓" : "✗"} ${verdict.why}`);
    if (!verdict.ok) {
      const tail = out.trim().split("\n").slice(-12).join("\n");
      console.log(`  · 金线输出尾部：\n${tail}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 构建失败 = 变异本身不合法（类型不收窄/语法错），不是"金线抓住了缺陷"
    verdict.why = /next build|Failed to type check|Type error/i.test(msg)
      ? `变异本身不合法（构建失败），无效——不算金线通过：${msg.split("\n")[0]}`
      : `执行失败：${msg.split("\n")[0]}`;
    console.log(`  ✗ ${verdict.why}`);
  } finally {
    stopServer(server);
    // 双保险：即使中途异常，也把源码与备份恢复干净
    if (existsSync(backup)) {
      copyFileSync(backup, abs);
      rmSync(backup, { force: true });
    }
    for (const [rel, content] of rewritten) writeFileSync(path.join(ROOT, rel), content, "utf8");
    rmSync(path.join(ROOT, DIST), { recursive: true, force: true });
    results.push(verdict);
  }
}

console.log("\n=== 结果 ===");
for (const r of results) console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}：${r.why}`);
const bad = results.filter((r) => !r.ok).length;
console.log(`\n通过 ${results.length - bad}，失败 ${bad}`);
process.exit(bad === 0 ? 0 : 1);
