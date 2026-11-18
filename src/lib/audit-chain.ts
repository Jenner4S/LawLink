import { createHash } from "crypto";

/**
 * 链式审计（借鉴 LexNebulis 的 nonrepudiation 设计）
 *
 * 每条审计记录计算一个 SHA-256 摘要，摘要的输入包含「上一条记录的摘要」，
 * 因此任意一条被改动都会导致其后续所有记录的摘要对不上——篡改可被密码学证明。
 *
 * 与 LexNebulis 的差异：
 *   - 它用 Python 的字符串拼接 + date.isoformat；这里用固定字段顺序 + ISO 时间，
 *     保证同一组输入在任何实现下哈希一致（便于跨语言复核）。
 *   - detail 用 JSON.stringify 规范化，避免键顺序抖动导致误判断链。
 */

export interface AuditHashInput {
  userId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: Date;
  previousHash?: string | null;
}

/** 稳定序列化：对象键排序，避免同一内容因键顺序不同产生不同哈希 */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableJson(obj[k])).join(",") + "}";
}

export function computeAuditHash(input: AuditHashInput): string {
  const payload = [
    input.userId ?? "",
    input.action,
    input.targetType ?? "",
    input.targetId ?? "",
    stableJson(input.detail),
    input.ip ?? "",
    input.userAgent ?? "",
    input.createdAt.toISOString(),
    input.previousHash ?? ""
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  /** 首个断裂位置（记录 id 与原因）；ok 时为 null */
  brokenAt: { id: string; action: string; reason: string } | null;
  /** 未参与校验的历史记录数（加字段前写入的记录没有 integrityHash） */
  skippedLegacy: number;
}

type AuditRow = {
  id: string;
  userId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  ip: string | null;
  userAgent: string | null;
  integrityHash: string | null;
  previousHash: string | null;
  createdAt: Date;
};

/**
 * 校验整条链。按 createdAt 升序逐条重算，比对 integrityHash 与 previousHash。
 * 返回首个断裂点，便于审计时定位。
 */
export async function verifyAuditChain(db: {
  auditLog: { findMany: (args: unknown) => Promise<AuditRow[]> };
}): Promise<ChainVerifyResult> {
  const rows = await db.auditLog.findMany({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true, userId: true, action: true, targetType: true, targetId: true,
      detail: true, ip: true, userAgent: true,
      integrityHash: true, previousHash: true, createdAt: true
    }
  });

  let prev: string | null = null;
  let checked = 0;
  let skippedLegacy = 0;

  for (const row of rows) {
    // 加字段之前的历史记录没有摘要，跳过但计数（不能当作断裂）
    if (row.integrityHash === null) {
      skippedLegacy += 1;
      prev = null; // 链的起点重置：历史段与哈希段之间不连续
      continue;
    }
    if (row.previousHash !== prev) {
      return {
        ok: false, checked, skippedLegacy,
        brokenAt: { id: row.id, action: row.action, reason: `previousHash 与上一条摘要不一致（期望 ${prev ?? "空"}）` }
      };
    }
    const expected = computeAuditHash({
      userId: row.userId, action: row.action, targetType: row.targetType,
      targetId: row.targetId, detail: row.detail, ip: row.ip,
      userAgent: row.userAgent, createdAt: row.createdAt, previousHash: row.previousHash
    });
    if (expected !== row.integrityHash) {
      return {
        ok: false, checked, skippedLegacy,
        brokenAt: { id: row.id, action: row.action, reason: "记录内容与自身摘要不符（该条被改动）" }
      };
    }
    prev = row.integrityHash;
    checked += 1;
  }

  return { ok: true, checked, skippedLegacy, brokenAt: null };
}
