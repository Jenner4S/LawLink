import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 守卫：禁止「硬编码审批能力」的函数复活（2026-11-20）
 *
 * 背景：`getSealApprovalCapabilities` 曾是这样一段代码 ——
 *
 *   await requireSession("approval");          // 只保证「登录 + 有 approval 菜单权」
 *   return { canApprove: true, canViewFirmQueue: true };  // 硬编码放行
 *
 * 它把「你能进审批菜单」偷换成「你能审批用印、能看全所队列」。
 * 当时零引用所以无害，但这是**看得见会用错的雷**：谁拿它做按钮显隐或服务端守卫，
 * 就等于绕过用印审批权限。已删除，并记入可达性判定表。
 *
 * 本测试是防止它（或同类写法）被写回来。判据很窄，只抓两种模式：
 *   ① 函数体里直接 `canApprove: true` / `canStamp: true` / `canViewFirmQueue: true`
 *   ② 同上但用 `!0`、`Boolean(1)` 之类伪装 —— 一并按字面量放行处理
 *
 * 允许的写法：`canApprove: await canApproveItem(...)`、`canApprove: row.status === "PENDING" && ...`
 * —— 即结果来自真实判定，而不是常量。
 */

const ROOTS = ["src/server", "src/lib"];

/** 收集所有 .ts 文件（跳过测试与 d.ts） */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 危险字段名：表示「我有权做某事」的布尔能力 */
const CAPABILITY_KEYS = ["canApprove", "canStamp", "canDecide", "canViewFirmQueue", "canExecute"];

/** 字面量 true 的各种写法 */
const TRUE_LITERAL = String.raw`(?:true|!0|Boolean\(\s*(?:true|1)\s*\))`;

describe("审批能力不得硬编码", () => {
  it("src/server 与 src/lib 里不存在 `canXxx: true` 形式的硬编码放行", () => {
    const hits: string[] = [];

    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = fs.readFileSync(file, "utf8");
        for (const key of CAPABILITY_KEYS) {
          // 允许 `!== true`、`=== true` 这类比较；只抓「赋值/返回字面量 true」
          const re = new RegExp(String.raw`\b${key}\s*:\s*${TRUE_LITERAL}`, "g");
          const matches = text.match(re);
          if (!matches) continue;
          // 排除比较上下文：`x ? { canApprove: true } : ...` 仍是硬编码，要抓；
          // 但 `expect(canApprove: true)` 之类出现在测试文件里已排除。
          for (const m of matches) hits.push(`${file}: ${m}`);
        }
      }
    }

    expect(hits, `发现硬编码审批能力（必须改成真实判定）：\n${hits.join("\n")}`).toEqual([]);
  });

  it("守卫本身有效：能识别一段典型硬编码样本", () => {
    // 自检：正则确实能抓到历史上那段代码的形态，避免守卫写成摆设
    const sample = `export async function f() { return { canApprove: true, canViewFirmQueue: !0 }; }`;
    const re = new RegExp(String.raw`\bcanApprove\s*:\s*${TRUE_LITERAL}`);
    expect(re.test(sample)).toBe(true);
    const re2 = new RegExp(String.raw`\bcanViewFirmQueue\s*:\s*${TRUE_LITERAL}`);
    expect(re2.test(sample)).toBe(true);

    // 反向：真实判定不得被误报
    const ok = `return { canApprove: await canApproveItem(u, "SEAL_APPROVE", id), canStamp: row.status === "APPROVED" };`;
    expect(re.test(ok)).toBe(false);
    expect(re2.test(ok)).toBe(false);
  });

  it("getSealApprovalCapabilities 已被移除，不得复活", () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = fs.readFileSync(file, "utf8");
        if (/\bgetSealApprovalCapabilities\b/.test(text)) hits.push(file);
      }
    }
    expect(hits, `getSealApprovalCapabilities 是已删除的陷阱函数，不得重新引入：${hits.join(", ")}`).toEqual([]);
  });
});
