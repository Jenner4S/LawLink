#!/usr/bin/env node
/**
 * `prisma db seed` 的入口（2026-11-21）
 *
 * ## 为什么需要这一层
 *
 * `package.json` 原本把 seed 命令写成 `tsx prisma/seed.ts`。这在开发机上没问题，
 * 但在**生产镜像里根本跑不起来**，而且有两个独立原因叠在一起：
 *
 *   1. `tsx` 是 devDependency，被 `npm prune --omit=dev` 移除，
 *      连带 esbuild 的平台二进制（`@esbuild/linux-*`）一起消失；
 *   2. `prisma/seeds/v08-templates-and-seals.ts` 通过相对路径
 *      `../../src/lib/template-builder` 引用应用源码，而 runner 阶段
 *      **不复制 `src/`**。
 *
 * 两者任一都会让 `npx prisma db seed` 失败。而 fresh install 恰恰必须跑它才能
 * 有第一个管理员 —— 也就是说：**按文档操作，全新部署会卡在最后一米**。
 * （2026-11-21 实测：`Cannot find module '@esbuild/linux-arm64'`，
 *   修掉后变成 `Cannot find module '../../src/lib/template-builder'`。）
 *
 * ## 怎么解
 *
 * 构建期（builder 阶段）用 esbuild 把 `prisma/seed.ts` 及其引用的 `src/` 代码
 * 打成**单个 CJS 文件** `prisma/seed.bundle.cjs`，只把 `@prisma/client` /
 * `bcryptjs` 这类必然存在于 node_modules 的包留作 external。
 *
 * 于是：
 *   · 生产镜像：没有 src/、没有 tsx，但有 bundle → 直接 node 跑，零依赖
 *   · 开发机  ：没有 bundle 时回退 `tsx prisma/seed.ts`，改完立即生效
 *
 * 两条路都不用复制代码 —— 这一层只做「选哪条路」，不承载任何业务逻辑。
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "prisma/seed.bundle.cjs");

if (existsSync(bundle)) {
  execFileSync(process.execPath, [bundle], { stdio: "inherit", cwd: root });
} else {
  // 开发路径：没有构建产物时直接跑 TS
  try {
    execFileSync("npx", ["tsx", path.join(root, "prisma/seed.ts")], {
      stdio: "inherit",
      cwd: root
    });
  } catch (err) {
    console.error(
      [
        "",
        "✗ 找不到 prisma/seed.bundle.cjs，且 tsx 回退也失败。",
        "",
        "  生产镜像里应当有构建期打好的 bundle；如果你是在裁剪过的镜像里手动",
        "  删了它，或者镜像构建跳过了 esbuild 那一步，请重新构建镜像。",
        "  开发机上请确认已 npm install（tsx 在 devDependencies）。",
        ""
      ].join("\n")
    );
    throw err;
  }
}
