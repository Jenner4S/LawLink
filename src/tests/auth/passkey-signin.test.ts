// @vitest-environment node
/**
 * Passkey 登录票据 → 会话身份的准入判定（台账 P2-2 后半）。
 *
 * 这一层是"验签之后、建会话之前"的最后一道闸。要点：
 *   - 票据一次性（重放同一张票据必须拿不到第二次会话）；
 *   - passkey 验签成功**不放宽账号状态**（停用 / 锁定 / 角色停用一律拒绝）；
 *   - 两步验证不可绕过：票据的 TICKET_2FA 标记是唯一凭据，没有它就不能放行 TOTP 账号；
 *   - 每个分支都写审计（成功 WEBAUTHN_LOGIN / 失败 WEBAUTHN_LOGIN_REJECT + reason）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown, roleEnabled: true }));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return state.db;
  }
}));
vi.mock("@/lib/roles/service", () => ({
  resolveRoleUser: vi.fn(async () => ({ enabled: state.roleEnabled, roleName: "律师", rolePermissions: [] }))
}));

import { createFakePrisma, type FakeDb } from "@/tests/server/_webauthn-fake-db";
import { passkeyRejectRedirectUrl, resolvePasskeySignIn } from "@/lib/auth/passkey-signin";
import { issueLoginTicket } from "@/lib/auth/webauthn";

const USER = "ckuser00000000000000000001";

type Fake = FakeDb & {
  __state: {
    challenges: Array<{ challenge: string; kind: string; userId: string | null; usedAt: Date | null }>;
    users: Array<Record<string, unknown> & { id: string }>;
    audits: Array<{ action: string; userId: string | null; detail?: Record<string, unknown> }>;
  };
};

let db: Fake;

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: USER,
    name: "测试律师",
    email: "lawyer@law.example.com",
    active: true,
    role: "LAWYER",
    systemRole: "NONE",
    sessionVersion: 3,
    avatar: null,
    passwordHash: "$2a$10$abcdef",
    lockedUntil: null,
    failedLoginAttempts: 4,
    totpEnabled: false,
    totpEnforced: false,
    ...over
  };
}

function makeDb(users: Array<Record<string, unknown> & { id: string }> = [userRow()]) {
  db = createFakePrisma({ users }) as Fake;
  state.db = db;
  state.roleEnabled = true;
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  makeDb();
});

describe("resolvePasskeySignIn：票据 → 会话身份", () => {
  it("票据有效 → 返回本地身份，刷新登录时间并清零失败计数", async () => {
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    const result = await resolvePasskeySignIn({ ticket });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toMatchObject({ id: USER, role: "LAWYER", sessionVersion: 3 });

    const stored = db.__state.users[0];
    expect(stored.lastLoginAt).toBeInstanceOf(Date);
    expect(stored.failedLoginAttempts).toBe(0);
    expect(stored.lockedUntil).toBeNull();

    const login = db.__state.audits.find((a) => a.action === "WEBAUTHN_LOGIN");
    expect(login?.detail).toMatchObject({ provider: "passkey", secondFactor: false });
  });

  it("同一张票据只能用一次（重放拿不到第二次会话）", async () => {
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    expect((await resolvePasskeySignIn({ ticket })).ok).toBe(true);
    const replay = await resolvePasskeySignIn({ ticket });
    expect(replay).toEqual({ ok: false, reason: "TICKET_INVALID" });
  });

  it("伪造票据 → TICKET_INVALID 且写审计（userId 为空，未定位到账号）", async () => {
    const result = await resolvePasskeySignIn({ ticket: "Zm9yZ2VkLXRpY2tldC1ub3QtcmVhbA" });
    expect(result).toEqual({ ok: false, reason: "TICKET_INVALID" });
    const auditRow = db.__state.audits.find((a) => a.action === "WEBAUTHN_LOGIN_REJECT");
    expect(auditRow?.detail).toMatchObject({ stage: "ticket", reason: "TICKET_INVALID" });
    expect(auditRow?.userId).toBeNull();
  });

  it("票据对应的账号已被删除 → NO_SUCH_USER", async () => {
    const ticket = await issueLoginTicket("ckdeleted00000000000000001", { secondFactor: false });
    expect(await resolvePasskeySignIn({ ticket })).toEqual({ ok: false, reason: "NO_SUCH_USER" });
  });

  it("账号已停用 → INACTIVE（验签成功不等于账号可用）", async () => {
    makeDb([userRow({ active: false })]);
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    expect(await resolvePasskeySignIn({ ticket })).toEqual({ ok: false, reason: "INACTIVE" });
    expect(db.__state.users[0].lastLoginAt).toBeUndefined();
  });

  it("登录失败锁定期内 → LOCKED（锁定是账号级措施，passkey 也不放行）", async () => {
    makeDb([userRow({ lockedUntil: new Date(Date.now() + 5 * 60 * 1000) })]);
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    expect(await resolvePasskeySignIn({ ticket })).toEqual({ ok: false, reason: "LOCKED" });
  });

  it("自定义角色被停用 → ROLE_DISABLED", async () => {
    makeDb([userRow({ role: "CUSTOM" })]);
    state.roleEnabled = false;
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    expect(await resolvePasskeySignIn({ ticket })).toEqual({ ok: false, reason: "ROLE_DISABLED" });
  });
});

describe("resolvePasskeySignIn：不绕过两步验证", () => {
  it("已开启 TOTP 但票据没有 2FA 标记 → TOTP_REQUIRED（防验签环节提前发票据的降级）", async () => {
    makeDb([userRow({ totpEnabled: true })]);
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    expect(await resolvePasskeySignIn({ ticket })).toEqual({ ok: false, reason: "TOTP_REQUIRED" });
    expect(db.__state.users[0].lastLoginAt).toBeUndefined();
  });

  it("已开启 TOTP 且票据带 2FA 标记 → 放行", async () => {
    makeDb([userRow({ totpEnabled: true })]);
    const ticket = await issueLoginTicket(USER, { secondFactor: true });
    const result = await resolvePasskeySignIn({ ticket });
    expect(result.ok).toBe(true);
    const login = db.__state.audits.find((a) => a.action === "WEBAUTHN_LOGIN");
    expect(login?.detail).toMatchObject({ secondFactor: true });
  });

  it("管理员强制开启但本人未绑定 → TOTP_ENFORCED_UNBOUND（即使票据是 2FA 也不放行）", async () => {
    makeDb([userRow({ totpEnforced: true, totpEnabled: false })]);
    const ticket = await issueLoginTicket(USER, { secondFactor: true });
    expect(await resolvePasskeySignIn({ ticket })).toEqual({ ok: false, reason: "TOTP_ENFORCED_UNBOUND" });
  });
});

describe("resolvePasskeySignIn：失败不清空凭据", () => {
  it("登录后状态更新失败不阻断登录，但必须留 LOGIN_POST_UPDATE_FAILED 审计", async () => {
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    db.__failUserUpdate = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await resolvePasskeySignIn({ ticket });
    expect(result.ok).toBe(true);
    expect(db.__state.audits.some((a) => a.action === "LOGIN_POST_UPDATE_FAILED")).toBe(true);
    errorSpy.mockRestore();
  });

  it("拒绝原因映射到登录页提示码：账号状态类统一收敛，TOTP 类明说", () => {
    expect(passkeyRejectRedirectUrl("TICKET_INVALID")).toBe("/login?passkey=passkey");
    expect(passkeyRejectRedirectUrl("NO_SUCH_USER")).toBe("/login?passkey=passkey");
    expect(passkeyRejectRedirectUrl("ROLE_DISABLED")).toBe("/login?passkey=passkey");
    expect(passkeyRejectRedirectUrl("TOTP_REQUIRED")).toBe("/login?passkey=totp");
    expect(passkeyRejectRedirectUrl("TOTP_ENFORCED_UNBOUND")).toBe("/login?passkey=totp");
  });
});
