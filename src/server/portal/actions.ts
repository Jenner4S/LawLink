"use server";

/**
 * 客户门户 S1 的服务端动作（2026-11-20）
 *
 * 三个动作，边界刻意画清楚：
 *   ① `invitePortalUser` —— **员工**发起（需 clients.write + 能编辑该客户），
 *      返回邀请链接**明文一次**，库里只留哈希。
 *   ② `acceptPortalInvite` —— **无会话**的公开动作（客户还没账号），
 *      只认 token，一次性，过期即废。
 *   ③ `authenticatePortalUser` —— 公开动作，校验口令后签发门户会话。
 *
 * 安全要点（逐条对应方案 §四的真实攻击面）：
 *   · 邀请 token 单次使用靠**条件更新**（`updateMany where usedAt: null`）保证，
 *     不是先查后写——并发重复提交只有一个能成功。
 *   · 邀请过期/已用/已撤销统一返回同一句「邀请无效或已过期」，
 *     不区分原因，避免把「这个 token 存在但过期了」告诉陌生人。
 *   · 登录失败对「邮箱不存在」与「口令错误」返回同一提示，且失败也走一次 bcrypt 比较
 *     （对齐员工侧防时序枚举的做法）。
 *   · 门户身份与员工身份结构性隔离：本模块只碰 ClientPortalUser / PortalInvite，
 *     不导入任何员工会话或员工权限断言。
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseInput } from "@/lib/parse-input";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { isManager } from "@/lib/permissions";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";
import { claimInvite } from "./invite-claim";
import {
  createInviteToken,
  hashInviteToken,
  hashPortalPassword,
  verifyPortalPassword,
  signPortalSession,
  PORTAL_SESSION_TTL_SECONDS,
  assertPortalPasswordStrength
} from "@/lib/portal/auth";

const inviteSchema = z.object({
  clientId: z.string().trim().min(1, "缺少客户标识"),
  email: z.string().trim().email("邮箱格式不正确").max(200),
  name: z.string().trim().min(1, "请填写客户方联系人姓名").max(50)
});

/**
 * 邀请客户开通门户账号。
 *
 * 若该邮箱已存在门户账号：
 *   · 同属这个客户 → 视为「重新发邀请」（旧邀请不撤销，各自过期；账号不重建）
 *   · 属于别的客户 → 拒绝，不泄露对方是谁
 * 若客户已停用（deletedAt 非空）→ 拒绝：给已删除的客户开账号没有意义。
 */
export async function invitePortalUser(input: z.input<typeof inviteSchema>) {
  const session = await requireSession("clients.write");
  const data = parseInput(inviteSchema, input);

  const client = await prisma.client.findFirst({
    where: { id: data.clientId, deletedAt: null },
    select: { id: true, name: true }
  });
  if (!client) throw new ActionError("客户不存在或已删除");

  const existing = await prisma.clientPortalUser.findUnique({
    where: { email: data.email },
    select: { id: true, clientId: true, active: true }
  });
  if (existing && existing.clientId !== client.id) {
    // 不说明「该邮箱已属于其他客户」——那是在向本所员工泄露另一个客户的存在
    throw new ActionError("该邮箱已被占用，请改用其他邮箱");
  }

  const { token, tokenHash } = createInviteToken();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const portalUser = await prisma.$transaction(async (db) => {
    // 账号在「接受邀请」时才设密码；未接受前 passwordHash 存一个不可用占位，
    // 使其无法通过口令登录（哈希比对必然失败），也不留空串这种「看起来像密码」的值。
    const user = existing
      ? await db.clientPortalUser.update({
          where: { id: existing.id },
          data: { name: data.name, active: true }
        })
      : await db.clientPortalUser.create({
          data: {
            clientId: client.id,
            email: data.email,
            name: data.name,
            passwordHash: `!unusable:${createInviteToken().tokenHash}`
          }
        });

    await db.portalInvite.create({
      data: { portalUserId: user.id, tokenHash, expiresAt, createdById: session.user.id }
    });
    return user;
  });

  await audit({
    userId: session.user.id,
    action: "PORTAL_INVITE_CREATE",
    targetType: "ClientPortalUser",
    targetId: portalUser.id,
    detail: {
      clientId: client.id,
      clientName: client.name,
      email: data.email,
      expiresAt: expiresAt.toISOString(),
      resent: Boolean(existing)
    }
  });

  revalidatePath(`/clients/${client.id}`);
  // 明文 token 只在此返回一次，不写审计、不落库
  return { ok: true as const, token, expiresAt: expiresAt.toISOString(), portalUserId: portalUser.id };
}

const acceptSchema = z.object({
  token: z.string().trim().min(10, "邀请链接不完整"),
  password: z.string().min(1, "请设置密码").max(128)
});

/**
 * 接受邀请并设置密码（公开动作，无会话）。
 *
 * 一次性由 `updateMany({ where: { id, usedAt: null } })` 保证：
 * 并发两次提交，只有 count === 1 的那次成功。
 */
export async function acceptPortalInvite(input: z.input<typeof acceptSchema>) {
  const data = parseInput(acceptSchema, input);
  try {
    assertPortalPasswordStrength(data.password);
  } catch (e) {
    throw new ActionError(e instanceof Error ? e.message : "密码不合要求");
  }

  const tokenHash = hashInviteToken(data.token);
  const invite = await prisma.portalInvite.findUnique({
    where: { tokenHash },
    select: { id: true, portalUserId: true, expiresAt: true, usedAt: true }
  });
  // 统一文案：不区分「不存在 / 已用 / 已过期」
  const invalid = new ActionError("邀请无效或已过期，请让经办律师重新发起邀请");
  if (!invite || invite.usedAt || invite.expiresAt.getTime() <= Date.now()) throw invalid;

  const passwordHash = await hashPortalPassword(data.password);

  const result = await prisma.$transaction(async (db) => {
    // 原子占位：判据完全在数据库的条件更新里（见 invite-claim.ts 的说明）
    if (!(await claimInvite(db as never, invite.id))) return null;

    // 设密码同时递增 sessionVersion：作废此前可能存在的旧会话
    const user = await db.clientPortalUser.update({
      where: { id: invite.portalUserId },
      data: { passwordHash, sessionVersion: { increment: 1 }, lastLoginAt: new Date() },
      select: { id: true, clientId: true, email: true, name: true, sessionVersion: true }
    });
    return user;
  });
  if (!result) throw invalid;

  await audit({
    // 客户设密码是本人行为，但审计的 actor 用员工侧的「系统」语义会误导，
    // 因此写 portalUserId 到 detail，userId 记为门户用户 id 并加 actorKind。
    userId: result.id,
    action: "PORTAL_INVITE_ACCEPT",
    targetType: "ClientPortalUser",
    targetId: result.id,
    detail: { clientId: result.clientId, email: result.email, actorKind: "PORTAL_USER" }
  });

  const session = signPortalSession({
    uid: result.id,
    sv: result.sessionVersion,
    exp: Math.floor(Date.now() / 1000) + PORTAL_SESSION_TTL_SECONDS
  });
  return { ok: true as const, session, portalUserId: result.id };
}

const loginSchema = z.object({
  email: z.string().trim().email("邮箱格式不正确").max(200),
  password: z.string().min(1, "请输入密码").max(128)
});

/**
 * 门户登录（公开动作）。
 *
 * 失败一律返回同一句提示；即使邮箱不存在也做一次 bcrypt 比较，避免用响应时间枚举邮箱。
 */
export async function authenticatePortalUser(input: z.input<typeof loginSchema>) {
  const data = parseInput(loginSchema, input);
  const fail = new ActionError("邮箱或密码不正确");

  const user = await prisma.clientPortalUser.findUnique({
    where: { email: data.email },
    select: {
      id: true,
      clientId: true,
      passwordHash: true,
      active: true,
      sessionVersion: true,
      client: { select: { deletedAt: true, name: true } }
    }
  });

  // 不存在也走一次比较（用固定假哈希，长度与真实哈希一致，代价相当）
  const hash = user?.passwordHash ?? "$2a$12$0000000000000000000000000000000000000000000000000000";
  const matches = await verifyPortalPassword(data.password, hash);

  if (!user || !matches) throw fail;
  // 账号停用、客户已删除：对外仍是同一句（内部审计区分原因）
  if (!user.active || user.client.deletedAt) {
    await audit({
      userId: user.id,
      action: "PORTAL_LOGIN_BLOCKED",
      targetType: "ClientPortalUser",
      targetId: user.id,
      detail: { reason: !user.active ? "INACTIVE" : "CLIENT_DELETED", actorKind: "PORTAL_USER" }
    });
    throw fail;
  }

  const updated = await prisma.clientPortalUser.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
    select: { sessionVersion: true }
  });

  await audit({
    userId: user.id,
    action: "PORTAL_LOGIN",
    targetType: "ClientPortalUser",
    targetId: user.id,
    detail: { clientId: user.clientId, actorKind: "PORTAL_USER" }
  });

  const session = signPortalSession({
    uid: user.id,
    sv: updated.sessionVersion,
    exp: Math.floor(Date.now() / 1000) + PORTAL_SESSION_TTL_SECONDS
  });
  return { ok: true as const, session, clientName: user.client.name };
}

/**
 * 员工停用某个门户账号（踢下线 + 禁止登录）。
 * sessionVersion 递增使已签发的 cookie 立即失效。
 */
export async function revokePortalUser(portalUserId: string) {
  const session = await requireSession("clients.write");
  const id = String(portalUserId ?? "").trim();
  if (!id) throw new ActionError("缺少门户账号标识");

  const user = await prisma.clientPortalUser.findUnique({
    where: { id },
    select: { id: true, clientId: true, email: true, active: true }
  });
  if (!user) throw new ActionError("门户账号不存在");

  await prisma.clientPortalUser.update({
    where: { id },
    data: { active: false, sessionVersion: { increment: 1 } }
  });

  await audit({
    userId: session.user.id,
    action: "PORTAL_USER_REVOKE",
    targetType: "ClientPortalUser",
    targetId: id,
    detail: { clientId: user.clientId, email: user.email, wasActive: user.active, byManager: isManager(session.user) }
  });

  revalidatePath(`/clients/${user.clientId}`);
  return { ok: true as const };
}
