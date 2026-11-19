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
  /**
   * 链分叉点（2026-11-19 新增）。
   *
   * 同一 previousHash 出现多条后继时，链在此分成两股。此前实现只走第一条，
   * 其余分支静默跳过 —— 「ok:true」既不保证条数，也不保证末段被检查（假绿灯）。
   *
   * 为什么会有分叉：审计扩展用另一条连接读前驱，读不到同事务内未提交的前一条，
   * 于是同事务内写多条审计时会共用同一个 previousHash。撤销唯一约束后这不再
   * 让事务失败，但会留下分叉 —— 所以必须能查出来。null 表示无分叉。
   */
  forks: { previousHash: string; ids: string[]; actions: string[] }[] | null;
  /** 未被任何路径覆盖到的带摘要记录数；>0 说明链有分支没走完 */
  unchecked: number;
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

  let checked = 0;
  let skippedLegacy = 0;

  // 2026-11-19：改为**按链遍历**，不再按 createdAt 线性扫描。
  //
  // 原因：并发写入时，createdAt（wall clock）与哈希链的先后可能不是同一顺序——
  // 两个请求同时读到同一个前驱，唯一索引让后写者重试并指向先写者的哈希，
  // 但此时后写者的 createdAt 可能早于先写者。线性扫描会误判为断裂。
  //
  // 正确的判据是链本身：从 previousHash 为 null 的记录出发，沿 integrityHash →
  // previousHash 逐条前进。多条 prev=null 的记录各为一条链的起点
  //（加链前的历史段与首条新记录都会是 null）。
  const byPrev = new Map<string | null, AuditRow[]>();
  for (const row of rows) {
    if (row.integrityHash === null) { skippedLegacy += 1; continue; }
    const list = byPrev.get(row.previousHash) ?? [];
    list.push(row);
    byPrev.set(row.previousHash, list);
  }

  // 每条链从 prev=null 起步；若某条链的起点被唯一索引保证唯一，这里就是全量覆盖。
  // 仍按 createdAt 排序来稳定同一前驱下的候选顺序（正常情况下每个前驱只有一条后继）。
  // 分叉检测：同一前驱出现多条后继
  const forks: { previousHash: string; ids: string[]; actions: string[] }[] = [];
  for (const [prev, list] of byPrev) {
    if (prev !== null && list.length > 1) {
      forks.push({
        previousHash: prev,
        ids: list.map((r) => r.id),
        actions: list.map((r) => r.action)
      });
    }
  }

  // 沿链遍历：分叉时取 createdAt 最早的一条继续（保证 checked 计数稳定），
  // 其余分支记入 forks 并计入 unchecked —— 不再静默丢弃。
  const seen = new Set<string>();
  const ordered: AuditRow[] = [];
  {
    let cursor: string | null = null;
    // 多个 prev=null 的起点：历史段（无 hash）已被跳过，这里只会有首个新记录
    const roots = byPrev.get(null) ?? [];
    if (roots.length > 1) {
      forks.push({
        previousHash: "(root)",
        ids: roots.map((r) => r.id),
        actions: roots.map((r) => r.action)
      });
    }
    for (;;) {
      const candidates = byPrev.get(cursor);
      if (!candidates || candidates.length === 0) break;
      const next = candidates[0];
      const key = next.integrityHash as string;
      if (seen.has(key)) break;
      seen.add(key);
      ordered.push(next);
      cursor = key;
    }
  }
  const allHashed = rows.filter((r) => r.integrityHash !== null);
  const unchecked = Math.max(0, allHashed.length - ordered.length);

  for (let i = 0; i < ordered.length; i += 1) {
    const row = ordered[i];
    const prev = i === 0 ? null : ordered[i - 1].integrityHash;
    const expected = computeAuditHash({
      userId: row.userId, action: row.action, targetType: row.targetType,
      targetId: row.targetId, detail: row.detail, ip: row.ip,
      userAgent: row.userAgent, createdAt: row.createdAt, previousHash: row.previousHash
    });
    if (expected !== row.integrityHash) {
      return {
        ok: false, checked, skippedLegacy, forks: forks.length ? forks : null, unchecked,
        brokenAt: { id: row.id, action: row.action, reason: "记录内容与自身摘要不符（该条被改动）" }
      };
    }
    checked += 1;
  }

  return { ok: true, checked, skippedLegacy, brokenAt: null, forks: forks.length ? forks : null, unchecked };
}
