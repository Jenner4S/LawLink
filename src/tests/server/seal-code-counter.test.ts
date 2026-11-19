// @vitest-environment node
/**
 * 用印流水号必须走统一发号器（2026-11-21 补，P2 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `generateSealCode` 原本是 `nextSystemCounter` 事务体的**逐字复制，
 * 只少了重试循环**。而 `system-counter.ts` 的注释写得清清楚楚：
 *
 *   「此前发号器没有重试路径，并发建档时偶发冲突会直接把错误抛给用户
 *     （报告 P0-6 验证项发现）」
 *
 * 那个 P0-6 修的是客户编号与案件编号，用印这一份漏掉了。
 *
 * 在 `Serializable` 下两人同时提交用印申请会产生 40001（Prisma P2034），
 * 直接以脱敏错误抛给用户 —— 用户只看到「未能保存，请稍后重试」，
 * 而他的附件文件其实已经落了盘（后续步骤未执行），留下孤儿文件。
 *
 * ## 为什么不写「并发冲突」的行为测试
 *
 * P2034 的产生依赖真实的事务交错，无法稳定构造。而**重试逻辑本身
 * 已经有 3 条测试**（`src/tests/lib/p0-baseline.test.ts`：
 * 两次冲突后成功、非序列化错误不重试、超上限抛出）。
 *
 * 所以这里守的是**「有没有复用那份已测过的实现」**：
 * 只要用印走 `nextSystemCounter`，它自动继承那 3 条覆盖；
 * 一旦有人再复制一份，这条会红。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SEALS = path.join(process.cwd(), "src/server/seals/actions.ts");

describe("用印流水号 · 复用统一发号器", () => {
  it("seals/actions.ts 里不再有自己实现的计数器（systemSetting.upsert）", async () => {
    // 复制一份计数器的典型特征：在业务文件里直接 upsert 计数器键。
    // 设置项（webhook / 邮件结果 / 企业资料）的 upsert 不在此列 ——
    // 它们写的是配置，不是自增序列；所以只在这个文件里断言「一处都不许有」。
    const src = await fs.readFile(SEALS, "utf8");
    expect(src).not.toMatch(/systemSetting\.upsert/);
  });

  it("generateSealCode 调用 nextSystemCounter，且键名带上海年份", async () => {
    const src = await fs.readFile(SEALS, "utf8");
    const body = src.slice(src.indexOf("async function generateSealCode"));
    expect(body).toMatch(/nextSystemCounter\(`seal-counter-\$\{year\}`\)/);
    // 年份仍按上海口径取（元旦 0-8 点不能用去年）
    expect(body).toMatch(/shParts\(new Date\(\)\)\.y/);
  });

  it("不再持有 Serializable 的裸事务（那是被删掉的那份副本的痕迹）", async () => {
    const src = await fs.readFile(SEALS, "utf8");
    // 用印文件里其他事务都是普通 $transaction；出现 TransactionIsolationLevel
    // 说明计数器副本又长回来了。
    expect(src).not.toMatch(/Prisma\.TransactionIsolationLevel/);
  });
});
