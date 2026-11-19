/**
 * WebAuthn / Passkey 基础层（台账 P2-2 后半）。
 *
 * 与 options.ts 的分工（照 sso-signin.ts 的组织方式）：
 *   - options.ts 的 CredentialsProvider.authorize 只做一道"是不是 passkey 票据"的路由；
 *   - 票据换本地身份的准入判定在 src/lib/auth/passkey-signin.ts（可单测直调）；
 *   - 本文件只放**基础设施**：配置读取、挑战落库与一次性消费、一次性登录票据、
 *     Base64URL 编解码、计数器回退判定。全部是纯函数或单表单查询，便于用真逻辑测。
 *
 * ── 四条硬约束（做错比不做更危险）──────────────────────────────────────────
 *
 * 1. **rpID / origin 只从配置读，绝不从请求头推断**。Host / X-Forwarded-Host / Origin
 *    请求头都是攻击者可控的：若用 `req.headers.host` 当作 expectedOrigin，攻击者把
 *    自己的域名解析到本机、反代进来即可让"假站点上的断言"通过验签——抗钓鱼的全部
 *    价值就此归零。配置缺失时**功能整体关闭**，不降级为"用请求头凑一个"。
 *
 * 2. **origin 必须是 https**，只有 localhost / 127.0.0.1 / ::1 允许 http（本地联调）。
 *    WebAuthn 规范本身要求安全上下文；本机允许 http 是浏览器给的特例，服务端必须
 *    用同一口径，否则会出现"浏览器允许注册但服务端恒拒"或反过来。
 *
 * 3. **挑战必须落库**（不能只存进程内 Map）。多实例/多进程部署下，A 实例发出的挑战
 *    在 B 实例验签时查不到，表现为偶发登录失败；更危险的是"为了绕开这个偶发失败"
 *    有人会去放宽校验。落库后一次性消费由 `updateMany(where: { usedAt: null,
 *    expiresAt: { gt: now } })` 的**条件更新**保证原子性——两个并发请求只有一个能
 *    把 usedAt 从 null 改成时间戳。
 *
 * 4. **一次性登录票据同样落库**（原因同上），TTL 60 秒、用后即焚、绑定 userId。
 *    票据是浏览器 JS 完成断言后与服务端 Credentials 回调之间的桥：
 *    断言验签通过 → 发票据 → 前端 `signIn("credentials", { ticket, __passkey: "1" })`
 *    → authorize 核销票据。票据本身不含身份信息以外的凭据，核销一次即失效，
 *    因此即便被 XSS 读走也无法二次使用（且仍需先完成生物识别）。
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

/** 挑战有效期 5 分钟（RFC 建议短有效期；注册/登录各自一份） */
export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** 登录票据有效期 60 秒（够一次 signIn 往返，被截获也几乎无法利用） */
export const WEBAUTHN_TICKET_TTL_MS = 60 * 1000;
export const WEBAUTHN_DEFAULT_RP_NAME = "LawLink";

export type WebAuthnConfig = {
  /** WebAuthn RP ID：域名（不带协议/端口/路径），必须是 origin 主机名或其上级域 */
  rpId: string;
  /** 浏览器弹窗里显示的名称 */
  rpName: string;
  /** 站点源（协议 + 主机 + 可选端口），验签时与实际 origin 严格比对 */
  origin: string;
};

export type WebAuthnChallengeKind = "register" | "login";

/** 票据 kind：TICKET_2FA 表示该账号的两步验证已在验签环节通过 */
const TICKET_KIND = "TICKET";
const TICKET_2FA_KIND = "TICKET_2FA";
const TICKET_KINDS = [TICKET_KIND, TICKET_2FA_KIND] as const;

// ============ Base64URL ============

export function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return toArrayBufferView(Buffer.from(padded, "base64"));
}

/**
 * Buffer → 独立的 Uint8Array<ArrayBuffer>。
 *
 * 为什么不能直接返回 `new Uint8Array(buffer)`：Buffer 在 TS 里的底层类型是
 * ArrayBufferLike（可能是 SharedArrayBuffer），而 @simplewebauthn/server 的
 * Uint8Array_ 要求 ArrayBuffer 支撑；直接传会在类型层报"可能被共享"。
 * 这里显式复制一份，既满足类型，也避免调用方持有 Buffer 池里的同一块内存。
 */
function toArrayBufferView(source: Uint8Array): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(new ArrayBuffer(source.length));
  view.set(source);
  return view;
}

/** 挑战值：32 字节 CSPRNG，Base64URL（无填充） */
export function newChallengeValue(): string {
  return encodeBase64Url(randomBytes(32));
}

/**
 * WebAuthn user handle：对 userId 做带前缀的 SHA-256。
 *
 * 为什么不直接塞 userId：user handle 会长期停留在认证器里（可同步的 passkey 还会
 * 跨设备复制），放原始主键等于把内部 ID 泄露到用户的设备上；哈希既稳定（同一账号
 * 每次注册拿到同一 handle，认证器可合并显示）又不可反推。
 */
export function webauthnUserHandle(userId: string): Uint8Array<ArrayBuffer> {
  return toArrayBufferView(createHash("sha256").update(`lawlink:webauthn:${userId}`).digest());
}

// ============ 配置读取 ============

const RP_ID_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;

/** 本机回环主机（浏览器对这几个主机名允许 http 下的 WebAuthn） */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * 读取 WebAuthn 配置。
 *
 * 返回 null ＝ 功能关闭（登录页不出现按钮、所有服务端入口直接拒绝），**不降级**。
 * 三种情况：
 *   - 三个变量全空：静默 null（这是"没启用"，与 oidc.ts 同口径，不刷日志）；
 *   - 部分配置 / 非法配置：warn + null（部署方写错了必须看得见）；
 *   - 完整合法：返回规范化后的配置。
 */
export function readWebAuthnConfig(env: NodeJS.ProcessEnv = process.env): WebAuthnConfig | null {
  const rpIdRaw = (env.AUTH_WEBAUTHN_RP_ID ?? "").trim();
  const originRaw = (env.AUTH_WEBAUTHN_ORIGIN ?? "").trim();
  const rpNameRaw = (env.AUTH_WEBAUTHN_RP_NAME ?? "").trim();

  if (!rpIdRaw && !originRaw && !rpNameRaw) return null;

  if (!rpIdRaw || !originRaw) {
    console.warn(
      "[auth/webauthn] 配置不完整，通行密钥功能已关闭：需同时设置 AUTH_WEBAUTHN_RP_ID 与 AUTH_WEBAUTHN_ORIGIN"
    );
    return null;
  }

  if (rpIdRaw.includes("://") || rpIdRaw.includes("/") || rpIdRaw.includes(":") || !RP_ID_RE.test(rpIdRaw)) {
    console.warn(
      `[auth/webauthn] AUTH_WEBAUTHN_RP_ID 必须是纯域名（不带协议/端口/路径），当前为「${rpIdRaw}」；通行密钥功能已关闭`
    );
    return null;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(originRaw);
  } catch {
    console.warn(
      `[auth/webauthn] AUTH_WEBAUTHN_ORIGIN 不是合法 URL（需形如 https://law.example.com），当前为「${originRaw}」；通行密钥功能已关闭`
    );
    return null;
  }

  if (parsedOrigin.protocol !== "https:" && parsedOrigin.protocol !== "http:") {
    console.warn(
      `[auth/webauthn] AUTH_WEBAUTHN_ORIGIN 必须使用 https，当前协议为「${parsedOrigin.protocol}」；通行密钥功能已关闭`
    );
    return null;
  }
  if (parsedOrigin.protocol === "http:" && !isLoopbackHost(parsedOrigin.hostname)) {
    console.warn(
      `[auth/webauthn] AUTH_WEBAUTHN_ORIGIN 使用 http 时只允许 localhost / 127.0.0.1（当前主机「${parsedOrigin.hostname}」）；通行密钥功能已关闭`
    );
    return null;
  }
  // origin 只到主机与端口，不带路径/查询/片段（WebAuthn clientData.origin 的形状）
  if (parsedOrigin.pathname !== "/" || parsedOrigin.search || parsedOrigin.hash) {
    console.warn(
      `[auth/webauthn] AUTH_WEBAUTHN_ORIGIN 不能带路径/查询（当前「${originRaw}」，应为「${parsedOrigin.origin}」）；通行密钥功能已关闭`
    );
    return null;
  }

  const rpId = rpIdRaw.toLowerCase();
  const originHost = parsedOrigin.hostname.toLowerCase();
  if (originHost !== rpId && !originHost.endsWith(`.${rpId}`)) {
    console.warn(
      `[auth/webauthn] AUTH_WEBAUTHN_RP_ID「${rpId}」必须是 AUTH_WEBAUTHN_ORIGIN 主机「${originHost}」或其上级域名；通行密钥功能已关闭`
    );
    return null;
  }

  return {
    rpId,
    rpName: rpNameRaw || WEBAUTHN_DEFAULT_RP_NAME,
    origin: parsedOrigin.origin
  };
}

export function isWebAuthnConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readWebAuthnConfig(env) !== null;
}

// ============ 挑战 ============

/** 清理过期挑战/票据（表只增不减会拖慢唯一索引以外的查询） */
export async function pruneExpiredChallenges(now: Date = new Date()): Promise<number> {
  const res = await prisma.webAuthnChallenge.deleteMany({ where: { expiresAt: { lt: now } } });
  return res.count;
}

/**
 * 生成并落库一个挑战。清理过期行失败不影响主流程（只是表变大，不构成安全风险）。
 */
export async function createChallenge(params: {
  kind: WebAuthnChallengeKind;
  userId?: string | null;
  /** 已由 @simplewebauthn/server 生成的挑战值；缺省则新生成一个 */
  challenge?: string;
  now?: Date;
  ttlMs?: number;
}): Promise<string> {
  const now = params.now ?? new Date();
  const challenge = params.challenge ?? newChallengeValue();
  try {
    await pruneExpiredChallenges(now);
  } catch (err) {
    console.error("[auth/webauthn] 过期挑战清理失败（不影响本次挑战）：", err);
  }
  await prisma.webAuthnChallenge.create({
    data: {
      challenge,
      kind: params.kind,
      userId: params.userId ?? null,
      expiresAt: new Date(now.getTime() + (params.ttlMs ?? WEBAUTHN_CHALLENGE_TTL_MS))
    }
  });
  return challenge;
}

/**
 * 原子消费一个挑战：先读出行做前置判断，再用条件更新抢占（usedAt 从 null → now）。
 *
 * 为什么不是"先 update 再读"：updateMany 不返回命中的行，挑战与 userId 的绑定关系
 * 只能先读；而真正的独占由 updateMany 的 where 保证——并发两方都读到未使用，但只有
 * 一方能把 count 拿到 1。
 *
 * 返回 null 的四种情况一律等价于"拒绝"：不存在、kind 不符、已使用、已过期。
 */
export async function consumeChallenge(params: {
  challenge: string;
  kind: WebAuthnChallengeKind;
  now?: Date;
}): Promise<{ userId: string | null } | null> {
  const now = params.now ?? new Date();
  const row = await prisma.webAuthnChallenge.findUnique({
    where: { challenge: params.challenge },
    select: { userId: true, kind: true, expiresAt: true, usedAt: true }
  });
  if (!row) return null;
  if (row.kind !== params.kind) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;

  const claimed = await prisma.webAuthnChallenge.updateMany({
    where: {
      challenge: params.challenge,
      kind: params.kind,
      usedAt: null,
      expiresAt: { gt: now }
    },
    data: { usedAt: now }
  });
  if (claimed.count !== 1) return null;
  return { userId: row.userId };
}

// ============ 一次性登录票据 ============

/** 断言验签通过后签发票据；60 秒、单次、绑定 userId 与第二因子状态 */
export async function issueLoginTicket(
  userId: string,
  params: { secondFactor: boolean; now?: Date }
): Promise<string> {
  const now = params.now ?? new Date();
  const ticket = encodeBase64Url(randomBytes(32));
  await prisma.webAuthnChallenge.create({
    data: {
      challenge: ticket,
      kind: params.secondFactor ? TICKET_2FA_KIND : TICKET_KIND,
      userId,
      expiresAt: new Date(now.getTime() + WEBAUTHN_TICKET_TTL_MS)
    }
  });
  return ticket;
}

/**
 * 核销票据（一次性）。
 *
 * 返回值里的 secondFactor 是"两步验证已在验签环节通过"的凭据，供 authorize 侧
 * 判定是否需要再次索要动态码——两边都读同一个事实，不存在"验签环节放过、会话环节忘了"。
 */
export async function consumeLoginTicket(
  ticket: string,
  now: Date = new Date()
): Promise<{ userId: string; secondFactor: boolean } | null> {
  const row = await prisma.webAuthnChallenge.findUnique({
    where: { challenge: ticket },
    select: { userId: true, kind: true, expiresAt: true, usedAt: true }
  });
  if (!row?.userId) return null;
  if (!(TICKET_KINDS as readonly string[]).includes(row.kind)) return null;
  if (row.usedAt) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;

  const claimed = await prisma.webAuthnChallenge.updateMany({
    where: {
      challenge: ticket,
      kind: { in: [...TICKET_KINDS] },
      usedAt: null,
      expiresAt: { gt: now }
    },
    data: { usedAt: now }
  });
  if (claimed.count !== 1) return null;
  return { userId: row.userId, secondFactor: row.kind === TICKET_2FA_KIND };
}

// ============ 计数器与 transports ============

/**
 * 判定"签名计数器未推进"——防克隆的唯一手段。
 *
 * 认证器每次签名都会把内部 counter +1，克隆出来的凭证拿不到真凭证的计数器状态，
 * 因此当服务端存 N、断言里又报 <= N 时，说明同一份私钥被两处使用（或重放了旧断言）。
 *
 * **例外**：WebAuthn L2 §6.1.3 规定不支持计数器的认证器恒报 0。存 0 且来 0 时无法
 * 判断克隆与否，一律拒绝会让这类设备（部分平台 passkey）永远登录不了，所以只在
 * "已存 > 0" 时执行严格递增校验；一旦该设备报过一次正数，此后任何不前进都判异常。
 * 这条例外是显式口径，不是遗漏——见 docs 报告的「口径决定」。
 */
export function counterRolledBack(storedCounter: bigint | number, newCounter: bigint | number): boolean {
  const stored = BigInt(storedCounter);
  const incoming = BigInt(newCounter);
  if (stored === BigInt(0) && incoming === BigInt(0)) return false;
  return incoming <= stored;
}

const KNOWN_TRANSPORTS = new Set(["usb", "nfc", "ble", "internal", "hybrid", "smart-card"]);

/** 归一 transports：只保留规范里的取值，去重去空白（浏览器上报值不可全信） */
export function sanitizeTransports(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out = input
    .filter((t): t is string => typeof t === "string")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => KNOWN_TRANSPORTS.has(t));
  return [...new Set(out)];
}

/**
 * 从 clientDataJSON（Base64URL）里读出挑战值。
 *
 * 为什么服务端要自己解一遍：验签函数需要 `expectedChallenge`，而挑战是一次性的，
 * 必须先"消费"它才能调用验签（否则并发两方都能验）。挑战值只存在于浏览器回传的
 * clientDataJSON 里，所以解出来 → 原子消费 → 再交给验签函数比对，顺序不能颠倒。
 * 解不出来就是畸形响应，直接拒绝。
 */
export function readClientChallenge(clientDataJSON: string): string | null {
  try {
    const raw = Buffer.from(decodeBase64Url(clientDataJSON)).toString("utf8");
    const parsed = JSON.parse(raw) as { challenge?: unknown };
    return typeof parsed.challenge === "string" && parsed.challenge.length > 0 ? parsed.challenge : null;
  } catch {
    return null;
  }
}
