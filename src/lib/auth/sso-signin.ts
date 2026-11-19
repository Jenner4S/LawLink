/**
 * OIDC 登录的准入判定（台账 P2-2：SSO 只做"把 IdP 身份映射到已存在的本地 User"）。
 *
 * 与 options.ts 的分工：
 *   options.ts 的 signIn callback 只负责"是不是 oidc"这一层路由，全部判定逻辑
 *   收在本模块，便于单测直调，不必启动 NextAuth 流程。
 *
 * ── 安全红线（做错比不做更危险）──────────────────────────────────────────
 * 1. **绝不自动创建账号**。能进企业 IdP 的可能是全集团几万人，自动开号等于把
 *    律所案卷开放给整个集团。只按 email 精确匹配（大小写不敏感 + trim）本地
 *    已有 User；匹配不到 → 拒绝 + 审计 SSO_LOGIN_REJECT(no_such_user)。
 *    因此本模块**只有 findFirst，没有任何写入用户表的路径**。
 * 2. **只认 active=true**。IdP 侧仍有效但本系统已停用的账号一律拒绝。
 * 3. **必须校验 email_verified**。IdP 允许用户自填邮箱时（部分部署的 Keycloak、
 *    飞书外部联系人），未验证的邮箱 claim 可被用来劫持本地同名账号。
 * 4. **必须校验 id_token 的 iss**。wellKnown 已锁定 issuer，但 signIn 阶段再比一次
 *    成本极低，防的是"同一套 client 凭据被用于多个 issuer"的配置漂移。
 * 5. **不绕过 TOTP**。见 resolveOidcSignIn 的 TOTP 分支说明。
 * 6. 每个判定分支都写审计（成功 SSO_LOGIN / 失败 SSO_LOGIN_REJECT + reason），
 *    失败原因与账号密码登录的 LOGIN_FAILED 一样**不回给前端**，避免账号枚举。
 */
import { prisma } from "@/lib/prisma";
import { resolveRoleUser } from "@/lib/roles/service";
import { audit } from "@/server/audit";
import { redactIssuer, type OidcConfig } from "@/lib/auth/oidc";

export type SsoRejectReason =
  | "CONFIG_MISSING"
  | "ISSUER_MISMATCH"
  | "EMAIL_MISSING"
  | "EMAIL_NOT_VERIFIED"
  | "NO_SUCH_USER"
  | "INACTIVE"
  | "ROLE_DISABLED"
  | "TOTP_ENFORCED_UNBOUND"
  | "TOTP_REQUIRED";

export interface SsoLocalUser {
  id: string;
  name: string;
  email: string;
  role: string;
  systemRole: string;
  sessionVersion: number;
  avatar: string | null;
}

export type SsoSignInResult =
  | { ok: true; user: SsoLocalUser }
  | { ok: false; reason: SsoRejectReason };

/**
 * 拒绝后回登录页的跳转地址。
 *
 * 为什么要跳回 /login 而不是 `return false`：v4.24 的 signIn callback 返回 false
 * 时用户会被送到 NextAuth 内置错误页（/api/auth/error?error=AccessDenied，英文），
 * 而这里的拒绝原因需要被业务化说明（"该身份未在本系统开通，请联系管理员"）。
 * NextAuth 允许 signIn callback 返回一个地址字符串作为重定向目标。
 *
 * 码值经过"是否可用于账号枚举"的区分：
 *   - not_provisioned / totp / config 之外的一切 → 统一归入 not_provisioned，
 *     不区分"不存在""已停用""角色停用"，避免把本地账号状态泄露给 IdP 侧用户。
 *   - email_unverified 是 IdP 侧事实，与本地账号无关，可以明说。
 */
export function ssoRejectRedirectUrl(reason: SsoRejectReason): string {
  const code =
    reason === "EMAIL_NOT_VERIFIED"
      ? "email_unverified"
      : reason === "TOTP_REQUIRED" || reason === "TOTP_ENFORCED_UNBOUND"
        ? "totp"
        : reason === "ISSUER_MISMATCH" || reason === "CONFIG_MISSING"
          ? "config"
          : "not_provisioned";
  return `/login?sso=${code}`;
}

type Claims = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** email_verified 可能是 boolean 或字符串（部分 IdP 返 "true"） */
function isVerifiedClaim(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value.trim().toLowerCase() === "true";
  return false;
}

function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/**
 * 判定一次 OIDC 登录是否放行。
 *
 * 处理顺序（先身份、再账号、再策略；越早拒绝越少信息泄露）：
 *   1. CONFIG_MISSING        —— provider 存在但配置读不到（理论上不会出现）
 *   2. ISSUER_MISMATCH       —— 缺 iss 或与 AUTH_OIDC_ISSUER 不一致
 *   3. EMAIL_MISSING         —— IdP 没给邮箱，无法映射
 *   4. EMAIL_NOT_VERIFIED    —— claim 明确为 false
 *   5. NO_SUCH_USER          —— 本地无同邮箱账号（**不建号**）
 *   6. INACTIVE              —— 本地已停用
 *   7. ROLE_DISABLED         —— 自定义角色已停用（与 credentials 路径同口径）
 *   8. TOTP_ENFORCED_UNBOUND —— 管理员强制两步验证但本人未绑定
 *   9. TOTP_REQUIRED         —— 已绑定两步验证：SSO 无法提交第二因子，拒绝
 *  10. 成功：更新最后登录时间并审计 SSO_LOGIN
 *
 * @param user    provider.profile() 的返回值（id = IdP sub）
 * @param profile id_token 原始 claims（含 iss / email_verified）
 * @param config  当前生效的 OIDC 配置
 */
export async function resolveOidcSignIn(params: {
  user: Claims;
  profile?: Claims | null;
  config: OidcConfig | null;
}): Promise<SsoSignInResult> {
  const { user, config } = params;
  const profile: Claims = params.profile ?? {};
  const sub = str(user.id) || str(profile.sub);
  const issuerHost = config ? redactIssuer(config.issuer) : "";

  const reject = async (
    reason: SsoRejectReason,
    extra: { email?: string; userId?: string | null } = {}
  ): Promise<SsoSignInResult> => {
    await audit({
      userId: extra.userId ?? null,
      action: "SSO_LOGIN_REJECT",
      targetType: "User",
      targetId: extra.userId ?? undefined,
      detail: {
        provider: "oidc",
        reason,
        email: extra.email ?? null,
        sub: sub || null,
        issuer: issuerHost || null
      }
    });
    return { ok: false, reason };
  };

  // 1. 配置
  if (!config) return reject("CONFIG_MISSING");

  // 2. issuer：缺 claim 也不放行——"没验"与"验过"不能等价
  const claimIssuer = normalizeIssuer(str(profile.iss) || str(user.iss));
  if (!claimIssuer || claimIssuer !== normalizeIssuer(config.issuer)) {
    return reject("ISSUER_MISMATCH");
  }

  // 3. 邮箱（profile() 已 lowercase，这里再 trim 一次兜底）
  const email = (str(profile.email) || str(user.email)).toLowerCase().trim();
  if (!email) return reject("EMAIL_MISSING");

  // 4. email_verified：claim 存在且非真 → 拒绝；claim 缺失 → 交由 issuer 信任链
  const verifiedRaw = Object.hasOwn(profile, "email_verified") ? profile.email_verified : user.emailVerified;
  const hasVerifiedClaim = Object.hasOwn(profile, "email_verified") || Object.hasOwn(user, "emailVerified");
  if (hasVerifiedClaim && !isVerifiedClaim(verifiedRaw)) {
    return reject("EMAIL_NOT_VERIFIED", { email });
  }

  // 5. 映射到本地已存在账号（大小写不敏感精确匹配；**绝不创建**）
  const local = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: {
      id: true, name: true, email: true, active: true, role: true, systemRole: true,
      sessionVersion: true, avatar: true, totpEnabled: true, totpEnforced: true
    }
  });
  if (!local) return reject("NO_SUCH_USER", { email });

  // 6. 本地停用优先于 IdP 状态
  if (!local.active) return reject("INACTIVE", { email, userId: local.id });

  // 7. 角色停用（CUSTOM 角色的定义被停用/删除时与密码登录同样拒绝）
  if (!(await resolveRoleUser(local.id, local.role)).enabled) {
    return reject("ROLE_DISABLED", { email, userId: local.id });
  }

  // 8/9. TOTP：SSO 通道拿不到第二因子，因此**任何已绑定两步验证的账号都不能走 SSO**。
  //      - 管理员强制 + 本人未绑定：与 credentials 路径一致，先要求绑定（否则等于
  //        用 IdP 绕过强制开关）；
  //      - 本人已绑定（无论是否强制）：没有码可验，拒绝并要求改用账号密码登录。
  //      宁可让这批人走密码 + 动态码，也不让 SSO 成为绕过第二因子的旁路。
  if (local.totpEnabled) return reject("TOTP_REQUIRED", { email, userId: local.id });
  if (local.totpEnforced) return reject("TOTP_ENFORCED_UNBOUND", { email, userId: local.id });

  // 10. 放行：刷新最后登录时间（失败不阻断，但留痕）
  try {
    await prisma.user.update({
      where: { id: local.id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null }
    });
  } catch (err) {
    console.error("[auth/oidc] SSO 登录后状态更新失败：", err);
    await audit({
      userId: local.id,
      action: "LOGIN_POST_UPDATE_FAILED",
      targetType: "User",
      targetId: local.id,
      detail: { provider: "oidc", reason: err instanceof Error ? err.message : String(err) }
    });
  }

  await audit({
    userId: local.id,
    action: "SSO_LOGIN",
    targetType: "User",
    targetId: local.id,
    detail: { provider: "oidc", email: local.email, sub: sub || null, issuer: issuerHost }
  });

  return {
    ok: true,
    user: {
      id: local.id,
      name: local.name,
      email: local.email,
      role: local.role,
      systemRole: local.systemRole,
      sessionVersion: local.sessionVersion,
      avatar: local.avatar
    }
  };
}
