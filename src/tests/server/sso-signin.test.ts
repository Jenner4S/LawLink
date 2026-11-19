// @vitest-environment node
/**
 * OIDC 登录准入（台账 P2-2）。
 *
 * 这里守的是五条红线里的前四条 + TOTP 不绕过：
 *   1. 绝不自动建号（匹配不到 → 拒绝 + 审计，且**没有**任何 user.create 调用）
 *   2. 只认 active=true
 *   3. email_verified=false → 拒绝
 *   4. id_token 的 iss 必须与配置一致
 *   5. 已绑定/被强制两步验证的账号不能走 SSO（第二因子无法提交，等于绕过）
 * 另含：邮箱大小写/空白归一、审计不泄露完整 issuer 路径、拒绝码不暴露本地账号是否存在，
 * 以及 options.ts 的接线（未配置不出现 provider；signIn 把 IdP sub 换成本地 User.id，
 * 使 jwt/session 走与密码登录同一条 sessionVersion 校验）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { db, auditMock, roleUserMock } = vi.hoisted(() => {
  const db: Record<string, any> = {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      // 存在即违规：SSO 路径不允许任何形式的建号（create / upsert 都不该被调用）
      create: vi.fn(),
      upsert: vi.fn()
    }
  };
  return { db, auditMock: vi.fn(), roleUserMock: vi.fn() };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/server/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/roles/service", () => ({ resolveRoleUser: roleUserMock }));

import { resolveOidcSignIn, ssoRejectRedirectUrl } from "@/lib/auth/sso-signin";
import type { OidcConfig } from "@/lib/auth/oidc";

const CONFIG: OidcConfig = {
  enabled: true,
  issuer: "https://login.microsoftonline.com/tenant-1/v2.0",
  clientId: "client-abc",
  clientSecret: "secret-xyz",
  displayName: "企业统一登录",
  scopes: "openid email profile"
};

const LOCAL_ID = "cuser00000000000000000001";

const localRow = (over: Record<string, unknown> = {}) => ({
  id: LOCAL_ID,
  name: "张三",
  email: "zhang.san@firm.cn",
  active: true,
  role: "LAWYER",
  systemRole: "NONE",
  sessionVersion: 3,
  avatar: null,
  totpEnabled: false,
  totpEnforced: false,
  ...over
});

/** IdP 侧身份：profile() 的返回值（id = IdP sub）+ 原始 id_token claims */
const idpUser = (over: Record<string, unknown> = {}) => ({
  id: "idp-sub-123",
  email: "zhang.san@firm.cn",
  name: "张三",
  image: null,
  ...over
});
const claims = (over: Record<string, unknown> = {}) => ({
  iss: CONFIG.issuer,
  sub: "idp-sub-123",
  email: "zhang.san@firm.cn",
  email_verified: true,
  ...over
});

beforeEach(() => {
  vi.clearAllMocks();
  roleUserMock.mockResolvedValue({ enabled: true, roleName: "律师" });
  db.user.findFirst.mockResolvedValue(localRow());
});

describe("安全红线：映射不到本地账号即拒绝，且绝不建号", () => {
  it("NO_SUCH_USER：拒绝 + 审计 SSO_LOGIN_REJECT，且没有任何建号写入", async () => {
    db.user.findFirst.mockResolvedValue(null);
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result).toEqual({ ok: false, reason: "NO_SUCH_USER" });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SSO_LOGIN_REJECT",
      userId: null,
      detail: expect.objectContaining({ provider: "oidc", reason: "NO_SUCH_USER", email: "zhang.san@firm.cn" })
    }));
    // 红线：能进 IdP 的可能是全集团几万人，自动开号＝把案卷开放给整个集团
    expect(db.user.create).not.toHaveBeenCalled();
    expect(db.user.upsert).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("INACTIVE：本地账号已停用，即使 IdP 仍有效也拒绝（审计带本地 userId）", async () => {
    db.user.findFirst.mockResolvedValue(localRow({ active: false }));
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result).toEqual({ ok: false, reason: "INACTIVE" });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SSO_LOGIN_REJECT",
      userId: LOCAL_ID,
      targetId: LOCAL_ID,
      detail: expect.objectContaining({ reason: "INACTIVE" })
    }));
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("ROLE_DISABLED：自定义角色已停用时与密码登录同口径拒绝", async () => {
    db.user.findFirst.mockResolvedValue(localRow({ role: "CUSTOM" }));
    roleUserMock.mockResolvedValue({ enabled: false, rolePermissions: [] });
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result).toEqual({ ok: false, reason: "ROLE_DISABLED" });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({ reason: "ROLE_DISABLED" })
    }));
  });
});

describe("安全红线：claim 校验（issuer / email_verified）", () => {
  it("email_verified=false → 拒绝，且不查库（先校验声明的可信度）", async () => {
    const result = await resolveOidcSignIn({
      user: idpUser(),
      profile: claims({ email_verified: false }),
      config: CONFIG
    });

    expect(result).toEqual({ ok: false, reason: "EMAIL_NOT_VERIFIED" });
    expect(db.user.findFirst).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SSO_LOGIN_REJECT",
      detail: expect.objectContaining({ reason: "EMAIL_NOT_VERIFIED" })
    }));
  });

  it("email_verified 为字符串 \"false\" 同样拒绝（部分 IdP 不一致地返回字符串）", async () => {
    const result = await resolveOidcSignIn({
      user: idpUser(),
      profile: claims({ email_verified: "false" }),
      config: CONFIG
    });
    expect(result).toEqual({ ok: false, reason: "EMAIL_NOT_VERIFIED" });
  });

  it("email_verified 为字符串 \"true\" 放行", async () => {
    const result = await resolveOidcSignIn({
      user: idpUser(),
      profile: claims({ email_verified: "true" }),
      config: CONFIG
    });
    expect(result.ok).toBe(true);
  });

  it("IdP 未返回 email_verified claim 时放行（信任链已由 wellKnown + 签名覆盖）", async () => {
    const profile = claims();
    delete (profile as Record<string, unknown>).email_verified;
    const result = await resolveOidcSignIn({ user: idpUser(), profile, config: CONFIG });
    expect(result.ok).toBe(true);
  });

  it("iss 不匹配 → ISSUER_MISMATCH，不查库", async () => {
    const result = await resolveOidcSignIn({
      user: idpUser(),
      profile: claims({ iss: "https://evil-idp.example.com" }),
      config: CONFIG
    });

    expect(result).toEqual({ ok: false, reason: "ISSUER_MISMATCH" });
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });

  it("iss 缺失 → 也按 ISSUER_MISMATCH 拒绝（\"没验\"不等于\"验过\"）", async () => {
    const profile = claims();
    delete (profile as Record<string, unknown>).iss;
    const result = await resolveOidcSignIn({ user: idpUser(), profile, config: CONFIG });
    expect(result).toEqual({ ok: false, reason: "ISSUER_MISMATCH" });
  });

  it("iss 尾斜杠差异视为同一 issuer（避免部署时多写一个 / 就全站登不上）", async () => {
    const result = await resolveOidcSignIn({
      user: idpUser(),
      profile: claims({ iss: `${CONFIG.issuer}/` }),
      config: CONFIG
    });
    expect(result.ok).toBe(true);
  });

  it("IdP 未给邮箱 → EMAIL_MISSING", async () => {
    const result = await resolveOidcSignIn({
      user: { id: "idp-sub-123", email: null },
      profile: { iss: CONFIG.issuer, sub: "idp-sub-123" },
      config: CONFIG
    });
    expect(result).toEqual({ ok: false, reason: "EMAIL_MISSING" });
  });

  it("配置缺失 → CONFIG_MISSING（provider 存在但配置读不到时不留后门）", async () => {
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: null });
    expect(result).toEqual({ ok: false, reason: "CONFIG_MISSING" });
    expect(db.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("安全红线：不绕过 TOTP", () => {
  it("已绑定两步验证 → TOTP_REQUIRED（SSO 无法提交动态码，不允许当旁路）", async () => {
    db.user.findFirst.mockResolvedValue(localRow({ totpEnabled: true }));
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result).toEqual({ ok: false, reason: "TOTP_REQUIRED" });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("管理员强制两步验证但本人未绑定 → TOTP_ENFORCED_UNBOUND（先绑定，门禁不因 SSO 失效）", async () => {
    db.user.findFirst.mockResolvedValue(localRow({ totpEnforced: true }));
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result).toEqual({ ok: false, reason: "TOTP_ENFORCED_UNBOUND" });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe("成功路径", () => {
  it("匹配到 active 用户 → 放行 + 审计 SSO_LOGIN + 返回本地身份（含 sessionVersion）", async () => {
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result).toEqual({
      ok: true,
      user: {
        id: LOCAL_ID,
        name: "张三",
        email: "zhang.san@firm.cn",
        role: "LAWYER",
        systemRole: "NONE",
        sessionVersion: 3,
        avatar: null
      }
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SSO_LOGIN",
      userId: LOCAL_ID,
      targetType: "User",
      targetId: LOCAL_ID,
      detail: expect.objectContaining({ provider: "oidc", sub: "idp-sub-123" })
    }));
    expect(db.user.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: LOCAL_ID },
      data: expect.objectContaining({ failedLoginAttempts: 0, lockedUntil: null })
    }));
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("邮箱按大小写不敏感精确匹配（trim 后比对）", async () => {
    await resolveOidcSignIn({
      user: idpUser({ email: "  Zhang.San@Firm.CN " }),
      profile: claims({ email: "  Zhang.San@Firm.CN " }),
      config: CONFIG
    });

    expect(db.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: { equals: "zhang.san@firm.cn", mode: "insensitive" } }
    }));
  });

  it("审计 detail 只留 issuer 主机名，不落租户路径", async () => {
    await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });
    const call = auditMock.mock.calls.find(([p]) => p.action === "SSO_LOGIN");
    expect(call?.[0].detail.issuer).toBe("login.microsoftonline.com");
    expect(JSON.stringify(call?.[0])).not.toContain("tenant-1");
  });

  it("登录后状态更新失败不阻断登录，但写 LOGIN_POST_UPDATE_FAILED 审计", async () => {
    db.user.update.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await resolveOidcSignIn({ user: idpUser(), profile: claims(), config: CONFIG });

    expect(result.ok).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "LOGIN_POST_UPDATE_FAILED",
      userId: LOCAL_ID
    }));
    warn.mockRestore();
  });
});

describe("拒绝码：可读但不可用于账号枚举", () => {
  it("不存在 / 停用 / 角色停用统一归入 not_provisioned", () => {
    expect(ssoRejectRedirectUrl("NO_SUCH_USER")).toBe("/login?sso=not_provisioned");
    expect(ssoRejectRedirectUrl("INACTIVE")).toBe("/login?sso=not_provisioned");
    expect(ssoRejectRedirectUrl("ROLE_DISABLED")).toBe("/login?sso=not_provisioned");
  });

  it("其余码各有专门提示", () => {
    expect(ssoRejectRedirectUrl("EMAIL_NOT_VERIFIED")).toBe("/login?sso=email_unverified");
    expect(ssoRejectRedirectUrl("TOTP_REQUIRED")).toBe("/login?sso=totp");
    expect(ssoRejectRedirectUrl("TOTP_ENFORCED_UNBOUND")).toBe("/login?sso=totp");
    expect(ssoRejectRedirectUrl("ISSUER_MISMATCH")).toBe("/login?sso=config");
  });
});

describe("options.ts 接线", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadAuthOptions() {
    return (await import("@/lib/auth/options")).authOptions;
  }

  it("未配置 OIDC 时 providers 里没有 SSO provider（登录页也就不显示按钮）", async () => {
    vi.stubEnv("AUTH_OIDC_ENABLED", "");
    vi.resetModules();
    const options = await loadAuthOptions();
    expect(options.providers.map((p) => p.id)).toEqual(["credentials"]);
  });

  it("配置齐全时追加 oidc provider，且 Credentials 仍在首位", async () => {
    vi.stubEnv("AUTH_OIDC_ENABLED", "1");
    vi.stubEnv("AUTH_OIDC_ISSUER", CONFIG.issuer);
    vi.stubEnv("AUTH_OIDC_CLIENT_ID", CONFIG.clientId);
    vi.stubEnv("AUTH_OIDC_CLIENT_SECRET", CONFIG.clientSecret);
    vi.stubEnv("AUTH_OIDC_DISPLAY_NAME", "企业统一登录");
    vi.resetModules();
    const options = await loadAuthOptions();
    const ids = options.providers.map((p) => p.id);
    expect(ids).toEqual(["credentials", "oidc"]);
    expect(options.providers[1].name).toBe("企业统一登录");
  });

  it("signIn 回调把 IdP sub 改写成本地 User.id，后续 jwt 走同一条 sessionVersion 校验", async () => {
    vi.stubEnv("AUTH_OIDC_ENABLED", "1");
    vi.stubEnv("AUTH_OIDC_ISSUER", CONFIG.issuer);
    vi.stubEnv("AUTH_OIDC_CLIENT_ID", CONFIG.clientId);
    vi.stubEnv("AUTH_OIDC_CLIENT_SECRET", CONFIG.clientSecret);
    vi.resetModules();
    const options = await loadAuthOptions();

    const user: Record<string, unknown> = { ...idpUser() };
    const allowed = await options.callbacks!.signIn!({
      user: user as never,
      account: { provider: "oidc", type: "oauth", providerAccountId: "idp-sub-123" } as never,
      profile: claims() as never
    });
    expect(allowed).toBe(true);
    expect(user.id).toBe(LOCAL_ID);
    expect(user.sessionVersion).toBe(3);

    // jwt 首次登录：token.id 取本地 id（不是 IdP sub），sessionVersion 一并带入
    db.user.findUnique.mockResolvedValue({
      active: true, role: "LAWYER", systemRole: "NONE", sessionVersion: 3,
      name: "张三", email: "zhang.san@firm.cn", avatar: null
    });
    const token = await options.callbacks!.jwt!({
      token: { sub: "idp-sub-123" } as never,
      user: user as never,
      account: { provider: "oidc", type: "oauth", providerAccountId: "idp-sub-123" } as never,
      isNewUser: false
    } as never);
    expect((token as Record<string, unknown>).id).toBe(LOCAL_ID);
    expect((token as Record<string, unknown>).sessionVersion).toBe(3);
  });

  it("signIn 拒绝时返回登录页地址（而非 NextAuth 英文错误页），且不写入 user", async () => {
    vi.stubEnv("AUTH_OIDC_ENABLED", "1");
    vi.stubEnv("AUTH_OIDC_ISSUER", CONFIG.issuer);
    vi.stubEnv("AUTH_OIDC_CLIENT_ID", CONFIG.clientId);
    vi.stubEnv("AUTH_OIDC_CLIENT_SECRET", CONFIG.clientSecret);
    vi.resetModules();
    const options = await loadAuthOptions();

    db.user.findFirst.mockResolvedValue(null);
    const user: Record<string, unknown> = { ...idpUser() };
    const result = await options.callbacks!.signIn!({
      user: user as never,
      account: { provider: "oidc", type: "oauth", providerAccountId: "idp-sub-123" } as never,
      profile: claims() as never
    });

    expect(result).toBe("/login?sso=not_provisioned");
    expect(user.id).toBe("idp-sub-123"); // 未被改写 → 不会有会话
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("Credentials 分支行为不变（signIn 回调对 credentials 直接放行）", async () => {
    vi.stubEnv("AUTH_OIDC_ENABLED", "");
    vi.resetModules();
    const options = await loadAuthOptions();
    const allowed = await options.callbacks!.signIn!({
      user: { id: LOCAL_ID } as never,
      account: { provider: "credentials", type: "credentials" } as never,
      profile: undefined as never
    });
    expect(allowed).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });
});
