// @vitest-environment jsdom
/**
 * 公开确认页（/confirm/[token]）—— 页面文案与状态分支。
 *
 * 合规硬要求在这里被固化成测试：
 * - 声明原文整句出现；
 * - title 与按钮不出现「签署 / 签名 / 签订」；
 * - 不存在 / 过期 / 已确认 / 已撤销 / 哈希不符 各有独立说明页；
 * - 限流超阈值给「访问过于频繁」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const { db } = vi.hoisted(() => ({
  db: { contractConfirmation: { findUnique: vi.fn() } }
}));

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(), auditTx: vi.fn(), auditStrict: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "vitest" }))
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }), redirect: vi.fn() }));

import ContractConfirmPage, { metadata } from "@/app/confirm/[token]/page";
import {
  CONTRACT_CONFIRMATION_DISCLAIMER,
  checkPublicRateLimit,
  resetPublicRateLimits,
  sha256Hex
} from "@/server/contracts/service";

const TOKEN = "B".repeat(43);
const CONTENT = "委托代理合同\n甲方：客户甲\n乙方：某律师事务所\n第一条 委托事项：代理本案一审。";
const HASH = sha256Hex(CONTENT);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "cconfirm0000000000000000001",
    status: "PENDING",
    expiresAt: new Date("2026-12-01T00:00:00Z"),
    contentSnapshot: CONTENT,
    contentHash: HASH,
    confirmedAt: null,
    confirmerName: null,
    revokedAt: null,
    ...overrides
  };
}

async function renderPage() {
  render(await ContractConfirmPage({ params: Promise.resolve({ token: TOKEN }) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPublicRateLimits();
  db.contractConfirmation.findUnique.mockResolvedValue(row());
});

afterEach(cleanup);

describe("待确认页", () => {
  it("展示声明原文、正文与「我已阅读并确认」按钮", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { name: "合同内容阅知确认" })).toBeVisible();
    expect(screen.getByTestId("contract-confirmation-disclaimer")).toHaveTextContent(
      CONTRACT_CONFIRMATION_DISCLAIMER
    );
    expect(screen.getByTestId("contract-confirmation-content")).toHaveTextContent("第一条 委托事项");
    expect(screen.getByRole("button", { name: "我已阅读并确认" })).toBeVisible();
    expect(screen.getByLabelText("您的姓名（可不填）")).toBeVisible();
  });

  it("title 与按钮文案不含「签署 / 签名 / 签订」", async () => {
    expect(String(metadata.title)).not.toMatch(/签署|签名|签订/);
    await renderPage();
    const button = screen.getByRole("button", { name: "我已阅读并确认" });
    expect(button.textContent ?? "").not.toMatch(/签署|签名|签订/);
    expect(screen.getByRole("heading", { level: 1 }).textContent ?? "").not.toMatch(/签署|签名|签订/);
  });
});

describe("状态说明页", () => {
  it("链接不存在 → 无效说明，且不渲染确认按钮", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(null);
    await renderPage();
    expect(screen.getByRole("heading", { name: "链接无效或已失效" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已阅读并确认" })).not.toBeInTheDocument();
  });

  it("已过期 → 过期说明与到期时间", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() - 3600_000) })
    );
    await renderPage();
    expect(screen.getByRole("heading", { name: "链接已过期" })).toBeVisible();
    expect(screen.getByText(/该链接已于 .* 过期/)).toBeVisible();
  });

  it("已确认 → 只读页显示确认时间，不再提供确认按钮", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      row({ status: "CONFIRMED", confirmedAt: new Date("2026-11-19T02:30:00Z"), confirmerName: "张三" })
    );
    await renderPage();
    expect(screen.getByRole("heading", { name: "您已完成确认" })).toBeVisible();
    expect(screen.getByText(/确认时间：/)).toBeVisible();
    expect(screen.getByText(/确认人：张三/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "我已阅读并确认" })).not.toBeInTheDocument();
  });

  it("已撤销 → 撤回说明", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      row({ status: "REVOKED", revokedAt: new Date("2026-11-18T00:00:00Z") })
    );
    await renderPage();
    expect(screen.getByRole("heading", { name: "该确认已被撤回" })).toBeVisible();
  });

  it("正文哈希不符 → 内容校验未通过，不展示正文", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      row({ contentSnapshot: `${CONTENT}\n（被追加的条款）` })
    );
    await renderPage();
    expect(screen.getByRole("heading", { name: "内容校验未通过" })).toBeVisible();
    expect(screen.queryByTestId("contract-confirmation-content")).not.toBeInTheDocument();
  });
});

describe("公开访问限流", () => {
  it("同 IP 超过 20 次/分钟后，页面显示「访问过于频繁」", async () => {
    for (let i = 0; i < 20; i++) {
      expect(checkPublicRateLimit("203.0.113.9")).toBe(true);
    }
    await renderPage();
    expect(screen.getByRole("heading", { name: "访问过于频繁" })).toBeVisible();
    expect(screen.getByText(/请在一分钟后重试/)).toBeVisible();
    // 被限流时不再查库
    expect(db.contractConfirmation.findUnique).not.toHaveBeenCalled();
  });
});
