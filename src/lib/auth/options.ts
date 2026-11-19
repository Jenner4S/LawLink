import type { NextAuthOptions, User } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { resolveRoleUser } from "@/lib/roles/service";
import { audit } from "@/server/audit";
import { verifyLoginSecondFactor } from "@/server/auth/totp-login";
import { recordLoginFailure } from "@/lib/auth/login-lockout";
import { oidcWellKnownUrl, readOidcConfig } from "@/lib/auth/oidc";
import { resolveOidcSignIn, ssoRejectRedirectUrl } from "@/lib/auth/sso-signin";

// v1.x P0-3: 登录失败锁定参数（连续 5 次失败锁 15 分钟；成功登录清零）
const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

/**
 * 台账 P2-2：OIDC 单点登录 provider。
 *
 * 必须在模块加载时求值（providers 数组是同步的），所以配置只读环境变量——
 * 见 src/lib/auth/oidc.ts 的说明。未设置 AUTH_OIDC_ENABLED=1 时为 null，
 * providers 数组里不会出现 SSO provider，登录页也就不会显示按钮。
 */
const oidcConfig = readOidcConfig();

type OidcClaims = Record<string, unknown>;

const oidcProvider: OAuthConfig<OidcClaims> | null = oidcConfig
  ? {
      id: "oidc",
      name: oidcConfig.displayName,
      type: "oauth",
      wellKnown: oidcWellKnownUrl(oidcConfig),
      clientId: oidcConfig.clientId,
      clientSecret: oidcConfig.clientSecret,
      authorization: { params: { scope: oidcConfig.scopes } },
      idToken: true,
      checks: ["pkce", "state"],
      profile(claims) {
        const email = typeof claims.email === "string" ? claims.email.toLowerCase().trim() : undefined;
        const name = typeof claims.name === "string" ? claims.name : email;
        const picture = typeof claims.picture === "string" ? claims.picture : undefined;
        // 严格说这一步只产出"IdP 侧身份"：id 是 IdP 的 sub，不是本地 User.id。
        // 本地映射在 signIn callback 里完成（resolveOidcSignIn → 就地改写 user）。
        // 额外带出 emailVerified 供 signIn 兜底（next-auth 只读 id/name/email/image）。
        const fromIdp = {
          id: String(claims.sub ?? ""),
          email,
          name,
          image: picture,
          emailVerified: claims.email_verified
        };
        // 项目把 User 扩展出了 role/systemRole/sessionVersion/avatar（src/types/next-auth.d.ts），
        // 这些值此刻尚不存在，故按 IdP 实际形状显式转换，避免填假值。
        return fromIdp as unknown as User;
      }
    }
  : null;

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totpCode: z.string().optional()
});

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 12 * 60 * 60 }, // 12h
  pages: {
    signIn: "/login"
  },
  providers: [
    CredentialsProvider({
      name: "邮箱密码",
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" }
      },
      async authorize(credentials) {
        const parsed = credentialsSchema.safeParse(credentials);
        if (!parsed.success) return null;

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
          select: { id: true, name: true, email: true, passwordHash: true, active: true, role: true, systemRole: true, sessionVersion: true, avatar: true, failedLoginAttempts: true, lockedUntil: true, totpEnabled: true, totpEnforced: true }
        });
        if (!user || !user.active) {
          // 失败原因区分「账号不存在」与「已停用」，但都不回给前端，避免账号枚举
          await audit({
            userId: user?.id ?? null,
            action: "LOGIN_FAILED",
            targetType: "User",
            targetId: user?.id,
            detail: { email: parsed.data.email, reason: user ? "INACTIVE" : "NO_SUCH_USER" }
          });
          return null;
        }

        // v1.x P0-3: 登录失败锁定——锁定期间直接拒绝（不比较密码，不给爆破窗口）
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          await audit({
            userId: user.id,
            action: "LOGIN_LOCKED_REJECT",
            targetType: "User",
            targetId: user.id,
            detail: { email: parsed.data.email, lockedUntil: user.lockedUntil.toISOString() }
          });
          return null;
        }

        const matches = await bcrypt.compare(parsed.data.password, user.passwordHash);
        if (!matches) {
          // 连续失败累计，达到阈值锁定 15 分钟（成功登录清零）。
          // 数据库端原子递增：读-算-写会被并发请求读到同一旧值而绕过阈值。
          const attempts = await recordLoginFailure(user.id, LOGIN_LOCKOUT_THRESHOLD, LOGIN_LOCKOUT_MINUTES);
          const lock = attempts >= LOGIN_LOCKOUT_THRESHOLD;
          await audit({
            userId: user.id,
            action: lock ? "LOGIN_LOCKED" : "LOGIN_FAILED",
            targetType: "User",
            targetId: user.id,
            detail: { email: parsed.data.email, reason: "BAD_PASSWORD", attempts, locked: lock }
          });
          return null;
        }

        if (!(await resolveRoleUser(user.id, user.role)).enabled) return null;

        // v1.x P1 收尾 c: 管理端强制开启——enforced 且未绑定时拒绝登录（提示先绑定）。
        // 密码已验明才走到这里：不计入失败锁定（凭据无误，是策略拦截而非爆破）。
        if (user.totpEnforced && !user.totpEnabled) {
          await audit({
            userId: user.id,
            action: "LOGIN_TOTP_ENFORCED_REJECT",
            targetType: "User",
            targetId: user.id,
            detail: { email: parsed.data.email, hint: "BIND_TOTP_FIRST" }
          });
          return null;
        }

        // v1.x P1: 双步验证——已开启者必须提供动态码或恢复码（恒拒绝空码）。
        // 动态码错误同样计入失败锁定：持正确密码的爆破者也必须被闸住
        //（与上面的「策略拦截不计失败」不同——那是未绑定即拒绝，无码可试）。
        if (user.totpEnabled) {
          const code = (parsed.data as { totpCode?: string }).totpCode?.trim() ?? "";
          if (!code || !(await verifyLoginSecondFactor(user.id, code))) {
            const attempts = code
              ? await recordLoginFailure(user.id, LOGIN_LOCKOUT_THRESHOLD, LOGIN_LOCKOUT_MINUTES)
              : user.failedLoginAttempts;
            const lock = attempts >= LOGIN_LOCKOUT_THRESHOLD;
            await audit({
              userId: user.id,
              action: lock ? "LOGIN_LOCKED" : "LOGIN_TOTP_FAILED",
              targetType: "User",
              targetId: user.id,
              detail: { email: parsed.data.email, ...(code ? { attempts, locked: lock } : {}) }
            });
            return null;
          }
        }

        // 更新最后登录时间 + 失败计数清零。
        // 第六轮体检 P3-1：此前 fire-and-forget 且空吞——更新失败时失败计数
        // 不清零，用户后续少量失败即被锁定且无任何痕迹。改为等待完成；失败
        // 不阻断登录（凭据已验证），但必须留审计供排查。
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date(), failedLoginAttempts: 0, lockedUntil: null }
          });
        } catch (err) {
          console.error("[auth] 登录后状态更新失败（失败计数未清零，可能引发误锁）：", err);
          try {
            await audit({
              userId: user.id,
              action: "LOGIN_POST_UPDATE_FAILED",
              targetType: "User",
              targetId: user.id,
              detail: { reason: err instanceof Error ? err.message : String(err) }
            });
          } catch {
            console.error("[auth] 登录后状态更新失败的审计写入也失败了", { userId: user.id });
          }
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          systemRole: user.systemRole,
          sessionVersion: user.sessionVersion,
          avatar: user.avatar
        };
      }
    }),
    // 台账 P2-2：条件展开——未配置 OIDC 时数组里没有该 provider
    ...(oidcProvider ? [oidcProvider] : [])
  ],
  callbacks: {
    /**
     * 台账 P2-2：SSO 准入分支。
     *
     * Credentials 分支的行为**完全不变**（直接 return true），判定逻辑全在
     * resolveOidcSignIn 里（含审计与"绝不自动建号"）。
     *
     * 关键点：NextAuth 4 的 signIn callback 只能返回 boolean/string/URL，**不能用
     * 返回值替换 user**。而 jwt callback 依赖 `user.id`/`user.sessionVersion` 取本地
     * 身份与会话版本——所以这里就地改写 user（同一次请求内是同一个对象引用）：
     * 把 IdP 的 sub 换成**本地 User.id**，并带上 role/systemRole/sessionVersion。
     * 不改 jwt callback 一行——SSO 与会话失效机制（sessionVersion 递增踢下线）
     * 因此天然共用同一条路，不存在"SSO 会话踢不掉"的旁路。
     */
    async signIn({ user, account, profile }) {
      if (account?.provider !== "oidc") return true;

      const result = await resolveOidcSignIn({
        user: (user ?? {}) as unknown as Record<string, unknown>,
        profile: (profile ?? null) as unknown as Record<string, unknown> | null,
        config: oidcConfig
      });
      if (!result.ok) {
        // 拒绝原因不回给前端（避免账号枚举），统一跳回登录页给业务化提示；
        // 审计已在 resolveOidcSignIn 内写入 SSO_LOGIN_REJECT。
        return ssoRejectRedirectUrl(result.reason);
      }

      Object.assign(user as unknown as Record<string, unknown>, {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
        image: result.user.avatar,
        role: result.user.role,
        systemRole: result.user.systemRole,
        sessionVersion: result.user.sessionVersion,
        avatar: result.user.avatar
      });
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = user.role;
        token.systemRole = user.systemRole;
        token.avatar = user.avatar;
        token.sessionVersion = user.sessionVersion;
      }
      if (token.id) {
        const current = await prisma.user.findUnique({ where: { id: token.id },
          select: { active: true, role: true, systemRole: true, sessionVersion: true, name: true, email: true, avatar: true } });
        if (!current?.active || current.sessionVersion !== (token.sessionVersion ?? 0)) {
          token.id = "";
        } else {
          token.role = current.role;
          token.systemRole = current.systemRole;
          token.name = current.name;
          token.email = current.email;
          token.avatar = current.avatar;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (!token.id) {
        delete (session as { user?: unknown }).user;
        return session;
      }
      if (session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.systemRole = token.systemRole as string;
        session.user.avatar = token.avatar as string | null;
        const access = await resolveRoleUser(session.user.id, session.user.role);
        if (!access.enabled) {
          delete (session as { user?: unknown }).user;
          return session;
        }
        session.user.roleName = access.roleName;
        session.user.rolePermissions = access.rolePermissions;
        session.user.managerAuthorized = access.managerAuthorized === true;
      }
      return session;
    }
  },
  // AGENTS.md §六：AuditLog 必须记录登录/登出
  events: {
    async signIn({ user }) {
      await audit({
        userId: user.id,
        action: "LOGIN",
        targetType: "User",
        targetId: user.id
      });
    },
    async signOut({ token }) {
      const userId = token?.id as string | undefined;
      await audit({
        userId: userId ?? null,
        action: "LOGOUT",
        targetType: "User",
        targetId: userId
      });
    }
  }
};
