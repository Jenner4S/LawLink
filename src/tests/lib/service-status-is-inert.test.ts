import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 守卫：`Matter.serviceStatus` 是**惰性字段**，谁要读它必须先想清楚（2026-11-20）
 *
 * 事实（已核实，不是推断）：
 *   · `completeMatterService` / `activateMatterService` 没有任何 UI 入口
 *     → 该字段**恒为默认值 SERVICE_ACTIVE**（主库 7 个案件实测全为该值，从未出现 SERVICE_COMPLETED）
 *   · 除这两个动作自身外，**全仓无任何读者** —— 结案、归档、报表、工作台都不读它
 *
 * 危险在哪：把 `where: { serviceStatus: "SERVICE_ACTIVE" }` 写进查询，
 * 看着像在按「服务进行中」筛选，实际**恒为真、什么也没筛**；
 * 反过来筛 SERVICE_COMPLETED 则永远为空。两种都会让代码说谎。
 *
 * 所以本测试把读取面锁死在白名单内。将来谁要在别处读它，
 * 会先被这条测试拦下，被迫面对上面这段说明——要么按 schema 注释里写的方式
 * 真正启用（补入口 + 加消费方），要么别读。
 *
 * 这与 `no-hardcoded-approval-capabilities.test.ts` 是同一类守卫：
 * 拦的不是"错代码"，是"看起来对、实际不成立"的代码。
 */

/** 允许出现 serviceStatus 的文件（相对仓库根） */
const ALLOWED = new Set([
  // 唯一写入方：两个无入口的动作
  "src/server/matters/lifecycle.ts",
  // 标签映射（SERVICE_ACTIVE → "服务进行中"）与类型引用；纯数据，不构成读取
  "src/lib/enums.ts"
]);

const ROOTS = ["src/server", "src/lib", "src/app", "src/components"];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) {
      out.push(p);
    }
  }
  return out;
}

describe("serviceStatus 是惰性字段，读取面受控", () => {
  it("除 lifecycle.ts 与 enums.ts 外，不得读写 serviceStatus", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const rel = file.split(path.sep).join("/");
        if (ALLOWED.has(rel)) continue;
        const text = fs.readFileSync(file, "utf8");
        if (/\bserviceStatus\b/.test(text)) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `以下文件读写 Matter.serviceStatus，但该字段恒为 SERVICE_ACTIVE、全仓无消费方：\n` +
        offenders.map((f) => `  · ${f}`).join("\n") +
        `\n\n要么按 prisma/schema.prisma 里 serviceStatus 的注释真正启用（补入口 + 加消费方），` +
        `要么不要读它——拿一个恒真值去过滤，代码会看起来在筛选、实际什么也没筛。`
    ).toEqual([]);
  });

  it("守卫自检：能识别出真实读取，也不会误报注释里的字段名", () => {
    // 正样本：查询条件里用 serviceStatus
    expect(/\bserviceStatus\b/.test(`prisma.matter.findMany({ where: { serviceStatus: "SERVICE_ACTIVE" } })`)).toBe(true);
    // 负样本：完全不涉及
    expect(/\bserviceStatus\b/.test(`prisma.matter.findMany({ where: { status: "IN_PROGRESS" } })`)).toBe(false);
  });

  it("两个无入口的服务轴动作仍在（删除它们会连带让字段失去唯一写入方，需走迁移决策）", () => {
    const file = "src/server/matters/lifecycle.ts";
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/export async function completeMatterService/);
    expect(text).toMatch(/export async function activateMatterService/);
  });
});
