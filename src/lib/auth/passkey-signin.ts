/**
 * Passkey 登录的准入判定（台账 P2-2 后半：票据 → 本地会话身份）。
 *
 * 与 options.ts 的分工（照 sso-signin.ts 的组织方式）：
 *   options.ts 的 authorize 只负责"是不是 passkey 票据"这一层路由，全部判定收在
 *   本模块，便于单测直调，不必启动 NextAuth 流程。
 *
 * ── 安全红线 ──────────────────────────────────────────────────────────────
 * 1. **票据一次性**。核销动作在 consumeLoginTicket 里用条件更新完成，这里拿到的
 *    一定是"刚刚被我独占的那一张"。重放同一张票据只会得到 TICKET_INVALID。
 * 2. **票据只换身份，不放宽账号状态**。停用账号、自定义角色被停用、登录失败锁定
 *    仍然在票据这一环拦下来——passkey 验签成功不等于账号可用。
 * 3. **不绕过两步验证**。票据的 kind 记录了"两步验证是否已在验签环节通过"
 *    （TICKET_2FA）。账号已绑定 TOTP 而票据不是 TICKET_2FA 时拒绝：这条防的是
 *    "验签环节出了 bug 提前发票据"的降级路径，让 2FA 无法被绕过。
 * 4. **管理员强制开启但本人未绑定**（totpEnforced && !totpEnabled）同样拒绝，
 *    与账号密码路径完全一致——否则 passkey 会变成跳过"先去绑定"的旁路。
 * 5. 每个判定分支都写审计（成功 WEBAUTHN_LOGIN / 失败 WEBAUTHN_LOGIN_REJECT + reason）。
 */
import { prisma } from "@/lib/prisma";
import { resolveRoleUser } from "@/lib/roles/service";
import { audit } from "@/server/audit";
import { consumeLoginTicket } from "@/lib/auth/webauthn";

export type PasskeyRejectReason =
  | "TICKET_INVALID"
  | "NO_SUCH_USER"
  | "INACTIVE"
  | "LOCKED"
  | "ROLE_DISABLED"
  | "TOTP_ENFORCED_UNBOUND"
  | "TOTP_REQUIRED";

export interface PasskeyLocalUser {
  id: string;
  name: string;
  email: string;
  role: string;
  systemRole: string;
  sessionVersion: number;
  avatar: string | null;
}

export type PasskeySignInResult =
  | { ok: true; user: PasskeyLocalUser }
  | { ok: false; reason: PasskeyRejectReason };

/**
 * 拒绝原因 → 登录页提示码。
 *
 * 与 SSO 一样，**不回给前端具体是哪个账号状态出了问题**：票据无效、账号不存在、
 * 已停用、角色停用统一收敛为 `passkey_rejected`，避免把本地账号状态泄露出去。
 * TOTP 相关是策略事实（本人已知自己开了两步验证），可以明说。
 */
export function passkeyRejectRedirectUrl(reason: PasskeyRejectReason): string {
  const code = reason === "TOTP_REQUIRED" || reason === "TOTP_ENFORCED_UNBOUND" ? "totp" : "passkey";
  return `/login?passkey=${code}`;
}

/**
 * 用一张 Passkey 登录票据换取本地会话身份。
 *
 * 处理顺序（先票据、再账号、再策略）：
 *   1. TICKET_INVALID       —— 票据不存在/已用/已过期/kind 不符
 *   2. NO_SUCH_USER         —— 票据里的 userId 查不到
 *   3. INACTIVE             —— 本地已停用
 *   4. LOCKED               —— 登录失败锁定期内（票据来自别的窗口，仍须拦）
 *   5. ROLE_DISABLED        —— 自定义角色已停用（与密码路径同口径）
 *   6. TOTP_ENFORCED_UNBOUND—— 管理员强制两步验证但本人未绑定
 *   7. TOTP_REQUIRED        —— 已绑定两步验证，但票据没有 2FA 标记
 *   8. 成功：更新最后登录时间、清零失败计数、审计 WEBAUTHN_LOGIN
 */
export async function resolvePasskeySignIn(params: {
  ticket: string;
  now?: Date;
}): Promise<PasskeySignInResult> {
  const reject = async (
    reason: PasskeyRejectReason,
    extra: { userId?: string | null } = {}
  ): Promise<PasskeySignInResult> => {
    await audit({
      userId: extra.userId ?? null,
      action: "WEBAUTHN_LOGIN_REJECT",
      targetType: "User",
      targetId: extra.userId ?? undefined,
      detail: { provider: "passkey", stage: "ticket", reason }
    });
    return { ok: false, reason };
  };

  // 1. 票据一次性核销
  const consumed = await consumeLoginTicket(params.ticket, params.now);
  if (!consumed) return reject("TICKET_INVALID");

  // 2. 票据 → 本地账号
  const user = await prisma.user.findUnique({
    where: { id: consumed.userId },
    select: {
      id: true, name: true, email: true, active: true, role: true, systemRole: true,
      sessionVersion: true, avatar: true, lockedUntil: true,
      totpEnabled: true, totpEnforced: true
    }
  });
  if (!user) return reject("NO_SUCH_USER");

  // 3. 本地停用
  if (!user.active) return reject("INACTIVE", { userId: user.id });

  // 4. 锁定（密码路径连续失败锁定期间，passkey 也不放行——锁定是账号级措施）
  if (user.lockedUntil && user.lockedUntil > (params.now ?? new Date())) {
    return reject("LOCKED", { userId: user.id });
  }

  // 5. 角色停用
  if (!(await resolveRoleUser(user.id, user.role)).enabled) {
    return reject("ROLE_DISABLED", { userId: user.id });
  }

  // 6/7. 两步验证：票据必须带上"已通过 2FA"的标记
  if (user.totpEnabled && !consumed.secondFactor) return reject("TOTP_REQUIRED", { userId: user.id });
  if (user.totpEnforced && !user.totpEnabled) return reject("TOTP_ENFORCED_UNBOUND", { userId: user.id });

  // 8. 放行：刷新最后登录时间（失败不阻断，但留痕——照 oidc 与密码路径的口径）
  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null }
    });
  } catch (err) {
    console.error("[auth/webauthn] Passkey 登录后状态更新失败：", err);
    await audit({
      userId: user.id,
      action: "LOGIN_POST_UPDATE_FAILED",
      targetType: "User",
      targetId: user.id,
      detail: { provider: "passkey", reason: err instanceof Error ? err.message : String(err) }
    });
  }

  await audit({
    userId: user.id,
    action: "WEBAUTHN_LOGIN",
    targetType: "User",
    targetId: user.id,
    detail: { provider: "passkey", email: user.email, secondFactor: consumed.secondFactor }
  });

  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      systemRole: user.systemRole,
      sessionVersion: user.sessionVersion,
      avatar: user.avatar
    }
  };
}
