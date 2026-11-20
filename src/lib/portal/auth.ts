/**
 * 客户门户的底层凭据与会话原语（2026-11-20，门户 S1）
 *
 * 设计纪律（来自 docs/客户门户架构方案-20261120.md §二）：
 *
 * 1. **与员工侧完全独立**。不复用 NextAuth 的 session/JWT：
 *    门户 cookie 名、签名密钥用途、载荷结构都与员工侧不同，
 *    任何一方被伪造都不等于另一方。客户 cookie 拿到员工接口上，员工侧根本不解它。
 *
 * 2. **会话里不放权限**。只放 portalUserId 与 sessionVersion。
 *    权限/可见性每次请求现算——浏览器里的东西不可信。
 *
 * 3. **令牌只存哈希**。邀请 token 原文只在生成时返回一次，
 *    库里存 sha256；即便库被拖走也无法据此伪造邀请。
 *
 * 4. **sessionVersion 是踢线下线的唯一开关**。
 *    cookie 里的 sv 与库中的 sessionVersion 不一致即失效，
 *    用于「换人用同一账号」「员工停用客户账号」这类场景。
 */
import { createHmac, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import bcrypt from "bcryptjs";

/** 门户会话 cookie 名。刻意与员工侧（next-auth.session-token）不同，互不干扰。 */
export const PORTAL_COOKIE = "lawlink_portal_session";

/** 会话有效期：7 天。比员工侧短——客户是外部人，暴露窗口越小越好。 */
export const PORTAL_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** 邀请有效期：24 小时（方案 §三） */
export const PORTAL_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 签名密钥。
 *
 * 用 `NEXTAUTH_SECRET` 加域分隔串派生，而不是直接复用同一把密钥：
 * 域分隔保证「员工侧签名」与「门户签名」不可互相冒用（同一密钥、不同用途）。
 * 若运维提供了独立 `PORTAL_SESSION_SECRET` 则优先用它——独立密钥总是更好。
 */
function secret(): string {
  const dedicated = process.env.PORTAL_SESSION_SECRET?.trim();
  if (dedicated) return dedicated;
  const base = process.env.NEXTAUTH_SECRET;
  if (!base || base.length < 16) {
    // 不做静默降级：没有密钥就无法签发可信会话，宁可启动即失败也不要签出可伪造的 cookie
    throw new Error("门户会话密钥缺失：请配置 PORTAL_SESSION_SECRET 或 NEXTAUTH_SECRET");
  }
  return createHmac("sha256", base).update("lawlink.portal.session.v1").digest("hex");
}

export type PortalSessionPayload = {
  /** ClientPortalUser.id */
  uid: string;
  /** 签发时的 sessionVersion，用于踢下线 */
  sv: number;
  /** 过期时间（epoch 秒） */
  exp: number;
};

/** 生成邀请 token 明文与其哈希。明文只返回给调用方一次。 */
export function createInviteToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 口令哈希（与员工侧同一强度） */
export async function hashPortalPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export async function verifyPortalPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** 签发门户会话 cookie 值 */
export function signPortalSession(payload: PortalSessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/**
 * 校验并解析门户会话。
 * 返回 null 表示签名不对 / 结构不对 / 已过期——调用方一律当未登录处理。
 * 注意：**不查库**。sessionVersion 与 active 的复核在服务层做（需查库）。
 */
export function readPortalSession(raw: string | undefined | null): PortalSessionPayload | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = raw.slice(0, idx);
  const mac = raw.slice(idx + 1);
  const expected = createHmac("sha256", secret()).update(body).digest("base64url");
  // 定长比较，避免签名被逐字节试探
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as PortalSessionPayload;
    if (typeof payload?.uid !== "string" || typeof payload?.sv !== "number" || typeof payload?.exp !== "number") return null;
    if (payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 门户口令的强度下限：客户不是内部员工，不强制复杂度，但拒绝极短口令 */
export function assertPortalPasswordStrength(plain: string): void {
  const pw = plain ?? "";
  if (pw.length < 8) throw new Error("密码至少 8 位");
  if (pw.length > 128) throw new Error("密码过长");
}
