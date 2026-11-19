/**
 * WebAuthn / Passkey 服务层（台账 P2-2 后半）。
 *
 * 这里放"仪式"本身：注册（attestation）与登录（assertion）的 options 生成、
 * 响应验签、凭证增删。输入校验一律走 parseInput（不要 schema.parse），
 * 面向用户的拒绝一律 throw ActionError（digest 通道才能把中文提示送到客户端）。
 *
 * 为什么这些函数不标 "use server"：登录验签必须能被**未登录**的浏览器调用，
 * 走的是 app/api/auth/webauthn/* 的 Route Handler（见该目录下两个 route.ts）。
 * 标了 "use server" 的模块导出即等于"可被任意客户端 RPC 直呼的端点"——
 * 2026-09-19 的 TOTP 事故就是这个形态（verifyLoginSecondFactor 被当端点穷举）。
 * 因此真正的服务动作放在本文件，会话态动作再包一层在 webauthn-actions.ts。
 *
 * ── 七条安全红线在本文件的落点 ──────────────────────────────────────────
 * 1. 挑战一次性 + 5 分钟 + 用后即焚 → webauthn.ts 的 createChallenge / consumeChallenge
 *    （条件更新 usedAt）；无用户名发现时挑战 userId 为空，验签成功后回填。
 * 2. 计数器递增 → finishLogin 里 counterRolledBack → 拒绝 + WEBAUTHN_COUNTER_ANOMALY。
 * 3/4. rpID / origin 只读配置、origin 必须 https（本机除外）→ requireConfig()。
 * 5. 注册要二次确认密码 → finishRegistration 里 bcrypt.compare 当前密码。
 * 6. 全部写审计 → 各分支 audit（关键写入与业务同事务时用 auditTx）。
 * 7. 不绕过 TOTP → finishLogin 里走现有的 verifyLoginSecondFactor。
 */
import bcrypt from "bcryptjs";
import { z } from "zod";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse
} from "@simplewebauthn/server";
import { prisma } from "@/lib/prisma";
import { ActionError } from "@/lib/action-error";
import { parseInput } from "@/lib/parse-input";
import { audit } from "@/server/audit";
import { verifyLoginSecondFactor } from "@/server/auth/totp-login";
import { recordLoginFailure } from "@/lib/auth/login-lockout";
import { resolveRoleUser } from "@/lib/roles/service";
import {
  consumeChallenge,
  counterRolledBack,
  createChallenge,
  decodeBase64Url,
  encodeBase64Url,
  issueLoginTicket,
  readClientChallenge,
  readWebAuthnConfig,
  sanitizeTransports,
  webauthnUserHandle,
  type WebAuthnConfig
} from "@/lib/auth/webauthn";

/** 与 options.ts 的锁定参数保持一致（连续 5 次失败锁 15 分钟） */
const LOGIN_LOCKOUT_THRESHOLD = 5;
const LOGIN_LOCKOUT_MINUTES = 15;

export type WebAuthnActor = { id: string; role: string };

// ============ 输入 schema（全部经 parseInput） ============

const registrationInputSchema = z.object({
  attestation: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional()
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().optional()
  }),
  deviceName: z.string().trim().max(40, "设备名称最多 40 字").optional(),
  password: z.string().min(1, "请重新输入当前登录密码")
});

const assertionInputSchema = z.object({
  assertion: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    type: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().nullish()
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
    authenticatorAttachment: z.string().optional()
  }),
  totpCode: z.string().trim().max(32).optional()
});

const loginOptionsInputSchema = z.object({
  email: z
    .string()
    .trim()
    .max(254, "邮箱过长")
    .optional()
    .transform((v) => (v && v.length > 0 ? v.toLowerCase() : null))
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "请填写有效邮箱")
});

const deleteInputSchema = z.object({
  id: z.string().trim().min(1, "请选择要删除的通行密钥")
});

// ============ 结果类型 ============

export type PasskeyLoginRejectCode =
  | "CHALLENGE_INVALID"
  | "UNKNOWN_CREDENTIAL"
  | "USER_MISMATCH"
  | "VERIFY_FAILED"
  | "COUNTER_ANOMALY"
  | "ACCOUNT_DISABLED"
  | "LOCKED"
  | "ROLE_DISABLED"
  | "TOTP_ENFORCED_UNBOUND"
  | "TOTP_FAILED";

export type PasskeyLoginOutcome =
  | { status: "OK"; ticket: string }
  | { status: "TOTP_REQUIRED" }
  | { status: "REJECTED"; code: PasskeyLoginRejectCode; message: string };

/** 面向用户的拒绝文案（登录页另有更细的兜底，这里给服务端权威版本） */
const REJECT_MESSAGES: Record<PasskeyLoginRejectCode, string> = {
  CHALLENGE_INVALID: "本次通行密钥验证已过期或已被使用，请重新点击「使用 Passkey 登录」。",
  UNKNOWN_CREDENTIAL: "该设备未绑定到本系统的任何账号。请先用账号密码登录，在「个人设置」中添加通行密钥。",
  USER_MISMATCH: "该设备与本次登录请求的账号不一致，请重新发起登录。",
  VERIFY_FAILED: "通行密钥签名校验未通过，请重试；若持续失败，请改用账号密码登录并联系管理员。",
  COUNTER_ANOMALY: "该设备的签名计数器异常（凭证可能被复制），出于安全考虑已拒绝本次登录。请改用账号密码登录，并联系所内管理员核验该设备。",
  ACCOUNT_DISABLED: "账号不可用，请联系所内管理员。",
  LOCKED: "账号因多次登录失败处于临时锁定状态，请稍后再试或联系管理员。",
  ROLE_DISABLED: "当前岗位角色已被停用，请联系管理员。",
  TOTP_ENFORCED_UNBOUND: "该账号已被管理员要求开启两步验证且尚未完成绑定，暂无法登录。请联系管理员协助完成绑定。",
  TOTP_FAILED: "两步验证码或恢复码不正确，请重新验证通行密钥后再试。"
};

function requireConfig(): WebAuthnConfig {
  const config = readWebAuthnConfig();
  if (!config) {
    throw new ActionError("通行密钥功能未启用：管理员尚未配置 AUTH_WEBAUTHN_RP_ID 与 AUTH_WEBAUTHN_ORIGIN");
  }
  return config;
}

function shortId(credentialId: string): string {
  return credentialId.slice(-8);
}

// ============ 注册 ============

/** 开始注册：生成 options 并把挑战落库（5 分钟）。要求已登录（由 actions 层保证）。 */
export async function beginRegistration(actor: WebAuthnActor): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const config = requireConfig();
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { id: true, name: true, email: true }
  });
  if (!user) throw new ActionError("账号不存在");

  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId: actor.id },
    select: { credentialId: true, transports: true }
  });

  const options = await generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userName: user.email,
    userDisplayName: user.name,
    userID: webauthnUserHandle(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: sanitizeTransports(c.transports)
    })),
    // 律所场景要求"人在这里"：必须做用户验证（指纹/面容/PIN），不接受仅触碰
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" }
  });

  await createChallenge({ kind: "register", userId: actor.id, challenge: options.challenge });
  return options;
}

/**
 * 完成注册：二次确认当前密码 → 一次性消费挑战 → 验签 → 落库凭证。
 *
 * 为什么必须重新输入密码（红线 5）：会话被劫持（XSS / 未锁屏 / 共享电脑）时，
 * 攻击者若能静默绑定自己的设备，就等于永久后门——他不需要知道密码，只要"当初
 * 登录过"。因此绑定动作要求重新证明"我是知道密码的那个人"。
 */
export async function finishRegistration(
  actor: WebAuthnActor,
  input: unknown
): Promise<{ id: string; deviceName: string | null }> {
  const config = requireConfig();
  const data = parseInput(registrationInputSchema, input);

  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { id: true, passwordHash: true }
  });
  if (!user) throw new ActionError("账号不存在");

  const passwordOk = await bcrypt.compare(data.password, user.passwordHash);
  if (!passwordOk) {
    await audit({
      userId: actor.id,
      action: "WEBAUTHN_REGISTER",
      targetType: "WebAuthnCredential",
      detail: { result: "REJECTED", reason: "BAD_PASSWORD" }
    });
    throw new ActionError("当前密码不正确，未添加通行密钥");
  }

  const challenge = readClientChallenge(data.attestation.response.clientDataJSON);
  if (!challenge) throw new ActionError("注册响应缺少挑战值，请重新开始注册");

  const consumed = await consumeChallenge({ challenge, kind: "register" });
  if (!consumed) throw new ActionError("注册请求已过期或已被使用，请重新开始注册");
  if (consumed.userId && consumed.userId !== actor.id) {
    await audit({
      userId: actor.id,
      action: "WEBAUTHN_REGISTER",
      targetType: "WebAuthnCredential",
      detail: { result: "REJECTED", reason: "CHALLENGE_USER_MISMATCH" }
    });
    throw new ActionError("注册请求与当前账号不匹配，请重新开始注册");
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: data.attestation as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      requireUserVerification: true
    });
  } catch (err) {
    await audit({
      userId: actor.id,
      action: "WEBAUTHN_REGISTER",
      targetType: "WebAuthnCredential",
      detail: { result: "REJECTED", reason: "VERIFY_ERROR", message: err instanceof Error ? err.message : String(err) }
    });
    throw new ActionError("通行密钥注册验证失败，请重试；若持续失败请联系管理员");
  }

  if (!verification.verified || !verification.registrationInfo) {
    await audit({
      userId: actor.id,
      action: "WEBAUTHN_REGISTER",
      targetType: "WebAuthnCredential",
      detail: { result: "REJECTED", reason: "NOT_VERIFIED" }
    });
    throw new ActionError("通行密钥注册验证失败，请重试；若持续失败请联系管理员");
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;
  const publicKey = encodeBase64Url(credential.publicKey);
  const transports = sanitizeTransports(
    data.attestation.response.transports ?? credential.transports ?? []
  );

  const duplicate = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: credential.id },
    select: { userId: true }
  });
  if (duplicate) {
    await audit({
      userId: actor.id,
      action: "WEBAUTHN_REGISTER",
      targetType: "WebAuthnCredential",
      detail: { result: "REJECTED", reason: "DUPLICATE", sameUser: duplicate.userId === actor.id }
    });
    throw new ActionError(
      duplicate.userId === actor.id
        ? "该设备已绑定到当前账号，无需重复添加"
        : "该设备已绑定到其他账号，请联系管理员处理"
    );
  }

  const created = await prisma.webAuthnCredential.create({
    data: {
      userId: actor.id,
      credentialId: credential.id,
      publicKey,
      counter: BigInt(credential.counter),
      transports,
      deviceName: data.deviceName && data.deviceName.length > 0 ? data.deviceName : null,
      backedUp: credentialBackedUp
    },
    select: { id: true, deviceName: true }
  });

  await audit({
    userId: actor.id,
    action: "WEBAUTHN_REGISTER",
    targetType: "WebAuthnCredential",
    targetId: created.id,
    detail: {
      result: "OK",
      credentialIdSuffix: shortId(credential.id),
      deviceName: created.deviceName,
      transports,
      backedUp: credentialBackedUp
    }
  });

  return { id: created.id, deviceName: created.deviceName };
}

// ============ 登录 ============

/**
 * 开始登录：生成 options 并把挑战落库（5 分钟）。
 *
 * 传 email 时限定该账号的凭证（allowCredentials），不传则空 allowCredentials
 * 走"无用户名发现"（浏览器让用户选设备，assertion 里带 credentialId）。
 *
 * **账号枚举防护**：邮箱不存在、账号已停用、账号没有任何凭证——三种情况返回
 * 完全相同的响应（空 allowCredentials），攻击者无法从响应形态判断账号是否存在。
 */
export async function beginLogin(input: unknown): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const config = requireConfig();
  const data = parseInput(loginOptionsInputSchema, input ?? {});

  let userId: string | null = null;
  let allowCredentials: { id: string; transports: string[] }[] = [];

  if (data.email) {
    // 大小写不敏感匹配（与 sso-signin 同口径）：邮箱在库里原样保存，
    // 用户手输大小写不同时不该退化成"设备选择器"——那会让"限定该账号"失效。
    const user = await prisma.user.findFirst({
      where: { email: { equals: data.email, mode: "insensitive" } },
      select: { id: true, active: true }
    });
    if (user?.active) {
      const credentials = await prisma.webAuthnCredential.findMany({
        where: { userId: user.id },
        select: { credentialId: true, transports: true }
      });
      if (credentials.length > 0) {
        userId = user.id;
        allowCredentials = credentials.map((c) => ({
          id: c.credentialId,
          transports: sanitizeTransports(c.transports)
        }));
      }
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    // 登录本身就要"人在现场"，平台认证器会直接弹指纹/面容
    userVerification: "required",
    allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined
  });

  await createChallenge({ kind: "login", userId, challenge: options.challenge });
  return options;
}

/**
 * 完成登录：消费挑战 → 定位凭证 → 验签 → 计数器校验 → 两步验证 → 签发一次性票据。
 *
 * 顺序上的两个要点：
 *   - **先消费挑战再验签**：挑战是一次性的，若先验签再消费，并发两方都能通过验签
 *     （同一份断言被重放）；反过来只有一方能拿到 count=1。
 *   - **计数器在验签之后、发票据之前**：验签只能证明"签名来自该公钥"，不能证明
 *     "私钥只有一份"；计数器是唯一能发现克隆的信号，必须在放行前判定。
 */
export async function finishLogin(input: unknown): Promise<PasskeyLoginOutcome> {
  const config = requireConfig();
  const data = parseInput(assertionInputSchema, input);

  const reject = (code: PasskeyLoginRejectCode): PasskeyLoginOutcome => ({
    status: "REJECTED",
    code,
    message: REJECT_MESSAGES[code]
  });

  const challenge = readClientChallenge(data.assertion.response.clientDataJSON);
  if (!challenge) {
    await audit({
      userId: null,
      action: "WEBAUTHN_LOGIN_REJECT",
      targetType: "User",
      detail: { provider: "passkey", stage: "verify", reason: "MALFORMED_CLIENT_DATA" }
    });
    return reject("CHALLENGE_INVALID");
  }

  const consumed = await consumeChallenge({ challenge, kind: "login" });
  if (!consumed) {
    await audit({
      userId: null,
      action: "WEBAUTHN_LOGIN_REJECT",
      targetType: "User",
      detail: { provider: "passkey", stage: "verify", reason: "CHALLENGE_INVALID" }
    });
    return reject("CHALLENGE_INVALID");
  }

  // 凭证定位：assertion.id 就是 Base64URL 的 credentialId
  const credential = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: data.assertion.id },
    select: {
      id: true, userId: true, credentialId: true, publicKey: true, counter: true, transports: true
    }
  });
  if (!credential) {
    await audit({
      userId: consumed.userId ?? null,
      action: "WEBAUTHN_LOGIN_REJECT",
      targetType: "User",
      detail: { provider: "passkey", stage: "verify", reason: "UNKNOWN_CREDENTIAL" }
    });
    return reject("UNKNOWN_CREDENTIAL");
  }

  // 挑战与凭证必须属于同一账号（防 A 账号发起挑战、B 账号凭证断言）
  if (consumed.userId && consumed.userId !== credential.userId) {
    await audit({
      userId: credential.userId,
      action: "WEBAUTHN_LOGIN_REJECT",
      targetType: "User",
      targetId: credential.userId,
      detail: { provider: "passkey", stage: "verify", reason: "USER_MISMATCH", credentialIdSuffix: shortId(credential.credentialId) }
    });
    return reject("USER_MISMATCH");
  }

  // 回填：无用户名发现时挑战的 userId 为空，验签成功后补上匹配到的用户（硬要求）
  if (!consumed.userId) {
    try {
      await prisma.webAuthnChallenge.updateMany({
        where: { challenge, userId: null },
        data: { userId: credential.userId }
      });
    } catch (err) {
      // 回填失败不影响本次登录（挑战已消费），但要留痕
      console.error("[auth/webauthn] 登录挑战 userId 回填失败：", err);
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: credential.userId },
    select: {
      id: true, email: true, active: true, role: true, lockedUntil: true,
      totpEnabled: true, totpEnforced: true
    }
  });
  if (!user || !user.active) {
    await audit({
      userId: user?.id ?? credential.userId, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User",
      targetId: credential.userId,
      detail: { provider: "passkey", stage: "verify", reason: "INACTIVE" }
    });
    return reject("ACCOUNT_DISABLED");
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await audit({
      userId: user.id, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User", targetId: user.id,
      detail: { provider: "passkey", stage: "verify", reason: "LOCKED" }
    });
    return reject("LOCKED");
  }
  if (!(await resolveRoleUser(user.id, user.role)).enabled) {
    await audit({
      userId: user.id, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User", targetId: user.id,
      detail: { provider: "passkey", stage: "verify", reason: "ROLE_DISABLED" }
    });
    return reject("ROLE_DISABLED");
  }
  // 与密码路径一致：管理员强制开启两步验证但本人未绑定 → 拒绝（提示先绑定）
  if (user.totpEnforced && !user.totpEnabled) {
    await audit({
      userId: user.id, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User", targetId: user.id,
      detail: { provider: "passkey", stage: "verify", reason: "TOTP_ENFORCED_UNBOUND" }
    });
    return reject("TOTP_ENFORCED_UNBOUND");
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: data.assertion as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpId,
      credential: {
        id: credential.credentialId,
        publicKey: decodeBase64Url(credential.publicKey),
        counter: Number(credential.counter),
        transports: sanitizeTransports(credential.transports)
      },
      requireUserVerification: true
    });
  } catch (err) {
    await audit({
      userId: user.id, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User", targetId: user.id,
      detail: {
        provider: "passkey", stage: "verify", reason: "VERIFY_ERROR",
        credentialIdSuffix: shortId(credential.credentialId),
        message: err instanceof Error ? err.message : String(err)
      }
    });
    return reject("VERIFY_FAILED");
  }

  if (!verification.verified) {
    await audit({
      userId: user.id, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User", targetId: user.id,
      detail: { provider: "passkey", stage: "verify", reason: "NOT_VERIFIED", credentialIdSuffix: shortId(credential.credentialId) }
    });
    return reject("VERIFY_FAILED");
  }

  const newCounter = verification.authenticationInfo.newCounter;

  // 红线 2：计数器未推进＝凭证可能被克隆（防克隆的唯一手段）
  if (counterRolledBack(credential.counter, newCounter)) {
    await audit({
      userId: user.id,
      action: "WEBAUTHN_COUNTER_ANOMALY",
      targetType: "WebAuthnCredential",
      targetId: credential.id,
      detail: {
        severity: "HIGH",
        storedCounter: credential.counter.toString(),
        incomingCounter: newCounter,
        credentialIdSuffix: shortId(credential.credentialId),
        hint: "签名计数器未推进，凭证可能被复制；已拒绝登录，请核验并删除该设备"
      }
    });
    return reject("COUNTER_ANOMALY");
  }

  // 红线 7：不绕过两步验证——沿用现有 verifyLoginSecondFactor（同一重放防护与恢复码核销）
  let secondFactor = false;
  if (user.totpEnabled) {
    const code = data.totpCode?.trim() ?? "";
    if (!code) {
      await audit({
        userId: user.id, action: "WEBAUTHN_LOGIN_REJECT", targetType: "User", targetId: user.id,
        detail: { provider: "passkey", stage: "verify", reason: "TOTP_REQUIRED" }
      });
      return { status: "TOTP_REQUIRED" };
    }
    const passed = await verifyLoginSecondFactor(user.id, code);
    if (!passed) {
      const attempts = await recordLoginFailure(user.id, LOGIN_LOCKOUT_THRESHOLD, LOGIN_LOCKOUT_MINUTES);
      const locked = attempts >= LOGIN_LOCKOUT_THRESHOLD;
      await audit({
        userId: user.id,
        action: locked ? "LOGIN_LOCKED" : "WEBAUTHN_LOGIN_REJECT",
        targetType: "User",
        targetId: user.id,
        detail: {
          provider: "passkey", stage: "verify",
          reason: locked ? "TOTP_FAILED_LOCKED" : "TOTP_FAILED",
          attempts, locked
        }
      });
      return reject("TOTP_FAILED");
    }
    secondFactor = true;
  }

  // 计数器推进 + 最后使用时间（BigInt：认证器 counter 为 32 位无符号）
  await prisma.webAuthnCredential.update({
    where: { id: credential.id },
    data: { counter: BigInt(newCounter), lastUsedAt: new Date() }
  });

  const ticket = await issueLoginTicket(user.id, { secondFactor });
  return { status: "OK", ticket };
}

// ============ 凭证管理 ============

export type PasskeyCredentialView = {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  transports: string[];
};

export async function listCredentials(actor: WebAuthnActor): Promise<PasskeyCredentialView[]> {
  const rows = await prisma.webAuthnCredential.findMany({
    where: { userId: actor.id },
    orderBy: [{ createdAt: "desc" }],
    select: {
      id: true, deviceName: true, createdAt: true, lastUsedAt: true, backedUp: true, transports: true
    }
  });
  return rows.map((row) => ({
    id: row.id,
    deviceName: row.deviceName,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    backedUp: row.backedUp,
    transports: sanitizeTransports(row.transports)
  }));
}

/**
 * 删除一台设备的通行密钥。
 *
 * 「至少要保留一种登录方式」：本系统的 User.passwordHash 必填，所以现实里删到最后一台
 * 也不会锁死；但这条守卫必须写下来并生效——将来若支持"无密码账号"，它是唯一防线。
 * 判定口径：删完之后「没有密码 且 一台不剩」→ 拒绝。
 */
export async function deleteCredential(
  actor: WebAuthnActor,
  input: unknown
): Promise<{ ok: true }> {
  const data = parseInput(deleteInputSchema, input);

  const credential = await prisma.webAuthnCredential.findFirst({
    where: { id: data.id, userId: actor.id },
    select: { id: true, deviceName: true, credentialId: true }
  });
  if (!credential) throw new ActionError("通行密钥不存在，或不属于当前账号");

  const [user, remaining] = await Promise.all([
    prisma.user.findUnique({ where: { id: actor.id }, select: { passwordHash: true } }),
    prisma.webAuthnCredential.count({ where: { userId: actor.id } })
  ]);
  const hasPassword = Boolean(user?.passwordHash && user.passwordHash.length > 0);
  if (remaining <= 1 && !hasPassword) {
    throw new ActionError("这是账号唯一的登录方式，不能删除。请先设置密码，或再添加一台设备。");
  }

  await prisma.webAuthnCredential.delete({ where: { id: credential.id } });

  await audit({
    userId: actor.id,
    action: "WEBAUTHN_DELETE",
    targetType: "WebAuthnCredential",
    targetId: credential.id,
    detail: {
      credentialIdSuffix: shortId(credential.credentialId),
      deviceName: credential.deviceName,
      remainingAfter: remaining - 1
    }
  });

  return { ok: true };
}
