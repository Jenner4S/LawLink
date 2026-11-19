/**
 * 合同确认留痕（台账 P1-4 降级实现）—— 数据与安全原语。
 *
 * 合规定位（勿越过）：
 *   本模块只记录「客户对某一版合同正文表示已阅知并确认」的时间 / IP / UA / 正文哈希，
 *   **不构成《中华人民共和国电子签名法》意义上的电子签名，不能替代签字盖章**。
 *   它的用途是证据链：事后有争议时可举证「该客户于 X 时间、Y IP 确认了哈希为 Z 的内容」。
 *
 * 鉴权不在本模块：律师侧在 src/server/contracts/actions.ts，公开侧在 public-actions.ts。
 *
 * 安全边界：
 *   - token 32 字节随机（crypto.randomBytes），明文只出现在发出的链接里，库中只存 SHA-256；
 *   - contentSnapshot 与其 SHA-256 同时落库，展示与确认前都复核哈希——有人直接改库里的
 *     快照就会对不上；
 *   - 公开访问按 IP 限流（每 60 秒 20 次），降低 token 枚举的可尝试速率。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ConfirmationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ActionError } from "@/lib/action-error";
import { auditTx } from "@/server/audit";

/**
 * 页面与交付物上的合规声明（原文定义在 ./compliance，客户端组件也要用）。
 * 它包含「签署」二字是法条引述需要；页面 title 与按钮文案不得出现「签署/签名/签订」。
 */
export { CONTRACT_CONFIRMATION_DISCLAIMER } from "./compliance";

/** 撤销已确认记录的固定拒绝理由（证据链不可抹除）。 */
export const CONFIRMED_REVOKE_MESSAGE =
  "客户已确认，不能撤销。已确认记录是证据链的原始凭据；如确认内容有误，请新建一条更正说明并保留本记录，不得抹除已发生的确认事实。";

export const CONFIRMATION_TOKEN_BYTES = 32;
export const CONFIRMATION_DEFAULT_TTL_DAYS = 7;
export const CONFIRMATION_MAX_TTL_DAYS = 30;
export const PUBLIC_RATE_LIMIT_MAX = 20;
export const PUBLIC_RATE_LIMIT_WINDOW_MS = 60_000;

/** 32 字节 base64url 固定 43 个字符；形状不合法直接判无效，不查库。 */
export const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashContentSnapshot(snapshot: string): string {
  return sha256Hex(snapshot);
}

/** 生成一次性访问令牌；只有 token 明文进链接，tokenHash 落库。 */
export function generateConfirmationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(CONFIRMATION_TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: sha256Hex(token) };
}

/** 定长时间比较，避免哈希比较泄露前缀。 */
export function verifyContentHash(snapshot: string, contentHash: string): boolean {
  if (typeof contentHash !== "string" || contentHash.length !== 64) return false;
  const actual = sha256Hex(snapshot);
  const a = Buffer.from(actual, "utf8");
  const b = Buffer.from(contentHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 公开路由限流：同一 IP 每 60 秒最多 20 次公开访问（浏览 + 确认共用同一配额，
 * 防止用一个接口的余量绕过另一个）。
 *
 * 进程内滑动窗口：自部署单进程 + node-cron 的既有形态下够用；多实例部署时
 * 各实例独立计数（速率放大到 N 倍），需要时再换 Redis。这是明确的已知限制。
 */
const publicRateBuckets = new Map<string, number[]>();

export function checkPublicRateLimit(ip: string, now: number = Date.now()): boolean {
  const key = (ip || "unknown").slice(0, 100);
  const hits = (publicRateBuckets.get(key) ?? []).filter((at) => now - at < PUBLIC_RATE_LIMIT_WINDOW_MS);
  if (hits.length >= PUBLIC_RATE_LIMIT_MAX) {
    publicRateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  publicRateBuckets.set(key, hits);
  // 枚举攻击会制造大量 IP 键；超过阈值时清掉已过窗口的桶，避免 Map 无限增长。
  if (publicRateBuckets.size > 5000) {
    for (const [bucketKey, bucket] of publicRateBuckets) {
      if (bucket.length === 0 || now - bucket[bucket.length - 1] >= PUBLIC_RATE_LIMIT_WINDOW_MS) {
        publicRateBuckets.delete(bucketKey);
      }
    }
  }
  return true;
}

/** 仅测试使用：清空限流状态。 */
export function resetPublicRateLimits(): void {
  publicRateBuckets.clear();
}

/**
 * 取客户端 IP：优先 x-forwarded-for 首个地址，其次 x-real-ip。
 *
 * Next.js 的 Server Action / Server Component 不暴露底层 socket，
 * 因此拿不到「直连 IP」时记为 unknown（本部署通常位于反向代理之后，
 * x-forwarded-for 由代理写入）。真值需在代理层保证不被客户端伪造。
 */
export function extractClientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first.slice(0, 100);
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 100);
  return "unknown";
}

export function normalizeUserAgent(ua: string | null | undefined): string {
  return (ua ?? "").slice(0, 500);
}

export function normalizeConfirmerName(name: string | null | undefined): string | null {
  const trimmed = (name ?? "").trim();
  return trimmed ? trimmed.slice(0, 60) : null;
}

export type PublicConfirmationView =
  | { kind: "invalid" }
  | { kind: "expired"; expiresAt: Date }
  | { kind: "revoked"; revokedAt: Date | null }
  | { kind: "confirmed"; confirmedAt: Date; confirmerName: string | null }
  | { kind: "tampered" }
  | { kind: "pending"; content: string; expiresAt: Date };

/** 公开页只取必要字段——不返回 clientId / matterId 等内部标识。 */
const publicSelect = {
  id: true,
  status: true,
  expiresAt: true,
  contentSnapshot: true,
  contentHash: true,
  confirmedAt: true,
  confirmerName: true,
  revokedAt: true
} satisfies Prisma.ContractConfirmationSelect;

export async function loadPublicConfirmation(
  token: string,
  now: Date = new Date()
): Promise<PublicConfirmationView> {
  if (!CONFIRMATION_TOKEN_PATTERN.test(token)) return { kind: "invalid" };
  const row = await prisma.contractConfirmation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    select: publicSelect
  });
  if (!row) return { kind: "invalid" };

  if (row.status === "CONFIRMED") {
    return {
      kind: "confirmed",
      confirmedAt: row.confirmedAt ? new Date(row.confirmedAt) : now,
      confirmerName: row.confirmerName
    };
  }
  if (row.status === "REVOKED") {
    return { kind: "revoked", revokedAt: row.revokedAt ? new Date(row.revokedAt) : null };
  }
  if (row.status === "EXPIRED") return { kind: "expired", expiresAt: new Date(row.expiresAt) };
  if (new Date(row.expiresAt).getTime() <= now.getTime()) {
    return { kind: "expired", expiresAt: new Date(row.expiresAt) };
  }
  // 展示前复核哈希：库里快照被改过就不能再展示，更不能让客户确认被篡改的内容。
  if (!verifyContentHash(row.contentSnapshot, row.contentHash)) return { kind: "tampered" };

  return { kind: "pending", content: row.contentSnapshot, expiresAt: new Date(row.expiresAt) };
}

export type ConfirmOutcome =
  | { kind: "confirmed"; confirmedAt: Date; already: boolean }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "revoked" }
  | { kind: "tampered" };

/**
 * 客户确认：幂等。
 *
 * - 已 CONFIRMED 再次提交：直接返回 already=true，**不再写审计**（一次确认一条审计）；
 * - 用 updateMany(where status=PENDING) 做条件更新，并发下只有一个请求能把状态推进；
 *   落败方回读最新状态，已确认则同样按「已确认」返回，不重复审计；
 * - 写审计与状态变更同一事务（auditTx）：审计失败则确认不成立，避免"确认了但无从举证"。
 */
export async function confirmByToken(input: {
  token: string;
  confirmerName?: string | null;
  ip: string;
  ua: string;
  now?: Date;
}): Promise<ConfirmOutcome> {
  const now = input.now ?? new Date();
  if (!CONFIRMATION_TOKEN_PATTERN.test(input.token)) return { kind: "invalid" };

  const row = await prisma.contractConfirmation.findUnique({
    where: { tokenHash: sha256Hex(input.token) },
    select: { ...publicSelect, clientId: true }
  });
  if (!row) return { kind: "invalid" };

  if (row.status === "CONFIRMED") {
    return {
      kind: "confirmed",
      confirmedAt: row.confirmedAt ? new Date(row.confirmedAt) : now,
      already: true
    };
  }
  if (row.status === "REVOKED") return { kind: "revoked" };
  if (row.status === "EXPIRED") return { kind: "expired" };
  if (new Date(row.expiresAt).getTime() <= now.getTime()) return { kind: "expired" };
  // 确认前复核哈希：快照被改过就拒绝确认，否则会为篡改后的文本作证。
  if (!verifyContentHash(row.contentSnapshot, row.contentHash)) return { kind: "tampered" };

  const ip = (input.ip || "unknown").slice(0, 100);
  const ua = normalizeUserAgent(input.ua) || null;
  const confirmerName = normalizeConfirmerName(input.confirmerName);

  const outcome = await prisma.$transaction(async (tx) => {
    const updated = await tx.contractConfirmation.updateMany({
      where: { id: row.id, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "CONFIRMED", confirmedAt: now, confirmedIp: ip, confirmedUa: ua, confirmerName }
    });
    if (updated.count === 0) return "race" as const;
    await auditTx(tx, {
      userId: null,
      action: "CONTRACT_CONFIRM",
      targetType: "ContractConfirmation",
      targetId: row.id,
      detail: {
        contentHash: row.contentHash,
        clientId: row.clientId,
        confirmedIp: ip,
        ...(confirmerName ? { confirmerName } : {})
      },
      ip,
      userAgent: ua ?? undefined
    });
    return "confirmed" as const;
  });

  if (outcome === "confirmed") return { kind: "confirmed", confirmedAt: now, already: false };

  // 并发落败：回读最新状态（可能是他人刚确认，也可能刚被撤销/过期）
  const latest = await prisma.contractConfirmation.findUnique({
    where: { id: row.id },
    select: { status: true, confirmedAt: true }
  });
  if (latest?.status === "CONFIRMED") {
    return {
      kind: "confirmed",
      confirmedAt: latest.confirmedAt ? new Date(latest.confirmedAt) : now,
      already: true
    };
  }
  if (latest?.status === "REVOKED") return { kind: "revoked" };
  return { kind: "expired" };
}

/** 律师创建留痕记录：返回一次性 token 明文（调用方只用于拼链接，不得落库/记日志）。 */
export async function createConfirmationRecord(input: {
  clientId: string;
  engagementId?: string | null;
  matterId?: string | null;
  contentSnapshot: string;
  expiresInDays?: number;
  createdById: string;
}): Promise<{ id: string; token: string; contentHash: string; expiresAt: Date; url: string }> {
  const snapshot = input.contentSnapshot;
  const contentHash = hashContentSnapshot(snapshot);
  const { token, tokenHash } = generateConfirmationToken();
  const days = Math.min(
    CONFIRMATION_MAX_TTL_DAYS,
    Math.max(1, Math.trunc(input.expiresInDays ?? CONFIRMATION_DEFAULT_TTL_DAYS))
  );
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.contractConfirmation.create({
      data: {
        clientId: input.clientId,
        engagementId: input.engagementId ?? null,
        matterId: input.matterId ?? null,
        contentSnapshot: snapshot,
        contentHash,
        tokenHash,
        expiresAt,
        createdById: input.createdById
      },
      select: { id: true }
    });
    await auditTx(tx, {
      userId: input.createdById,
      action: "CONTRACT_CREATE",
      targetType: "ContractConfirmation",
      targetId: row.id,
      detail: {
        clientId: input.clientId,
        engagementId: input.engagementId ?? null,
        matterId: input.matterId ?? null,
        contentHash,
        expiresAt: expiresAt.toISOString()
      }
    });
    return row;
  });

  return { id: created.id, token, contentHash, expiresAt, url: `/confirm/${token}` };
}

/** 撤销：已确认的记录拒绝撤销（证据链不可抹除），已撤销的拒绝重复操作。 */
export async function revokeConfirmationRecord(input: {
  id: string;
  reason: string;
  userId: string;
}): Promise<{ ok: true; matterId: string | null; clientId: string }> {
  const row = await prisma.contractConfirmation.findUnique({
    where: { id: input.id },
    select: { id: true, status: true, clientId: true, matterId: true }
  });
  if (!row) throw new ActionError("确认记录不存在");
  if (row.status === "CONFIRMED") throw new ActionError(CONFIRMED_REVOKE_MESSAGE);
  if (row.status === "REVOKED") throw new ActionError("该确认记录已撤销，无需重复操作");

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.contractConfirmation.updateMany({
      where: { id: input.id, status: { in: ["PENDING", "EXPIRED"] } },
      data: { status: "REVOKED", revokedAt: now, revokedReason: input.reason }
    });
    if (updated.count === 0) throw new ActionError("确认状态已变化，请刷新后重试");
    await auditTx(tx, {
      userId: input.userId,
      action: "CONTRACT_REVOKE",
      targetType: "ContractConfirmation",
      targetId: input.id,
      detail: { reason: input.reason, clientId: row.clientId, matterId: row.matterId }
    });
  });

  return { ok: true, matterId: row.matterId, clientId: row.clientId };
}

/**
 * 重新生成链接：token 明文不可再取，只能以同一正文快照新发一条记录。
 *
 * 先建新记录、再撤销旧的待确认记录：两步之间若中断，旧链接仍然可用，
 * 不会出现「新旧都失效、客户无链接可点」的空窗；新链接仅在整段成功后返回。
 */
export async function regenerateConfirmationRecord(input: {
  id: string;
  expiresInDays?: number;
  userId: string;
}): Promise<{ id: string; token: string; url: string; expiresAt: Date }> {
  const row = await prisma.contractConfirmation.findUnique({
    where: { id: input.id },
    select: {
      id: true,
      status: true,
      clientId: true,
      engagementId: true,
      matterId: true,
      contentSnapshot: true
    }
  });
  if (!row) throw new ActionError("确认记录不存在");
  if (row.status === "CONFIRMED") {
    throw new ActionError("已确认的记录不能重新生成链接；如内容有误，请新建一条确认记录并保留原记录。");
  }
  if (row.status === "REVOKED") {
    throw new ActionError("已撤销的记录不能重新生成链接，请新建一条确认记录。");
  }

  const created = await createConfirmationRecord({
    clientId: row.clientId,
    engagementId: row.engagementId,
    matterId: row.matterId,
    contentSnapshot: row.contentSnapshot,
    expiresInDays: input.expiresInDays,
    createdById: input.userId
  });

  try {
    await revokeConfirmationRecord({
      id: row.id,
      reason: "重新生成链接",
      userId: input.userId
    });
  } catch (err) {
    // 旧记录刚过期/刚被撤销等情况下撤销会失败；新链接已可用，不回滚。
    if (!(err instanceof ActionError)) throw err;
  }

  return { id: created.id, token: created.token, url: created.url, expiresAt: created.expiresAt };
}


/** 公开确认表单的返回状态（Server Action ↔ 客户端组件共用）。 */
export type ConfirmFormState = {
  ok: boolean;
  message: string;
  confirmedAt?: string | null;
  already?: boolean;
};

// 供测试与调用方复用的类型别名
export type { ConfirmationStatus };
