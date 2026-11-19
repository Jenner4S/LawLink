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

/**
 * 稳定序列化：对象键排序，避免同一内容因键顺序不同产生不同哈希。
 *
 * 2026-11-19 修复：必须**跳过值为 undefined 的键**。
 *
 * 原实现把 {dueAt: undefined} 序列化成 `{"dueAt":}`，而 JSONB 在落库时会把
 * undefined 字段整个丢掉——于是写入时算的哈希基于「有这个键」，读回后重算时
 * 「没这个键」，两者必然不等。表现就是零星几条审计被判为「内容被改动」，
 * 而它们的 detail 看上去完全正常（主库 MATTERS_EXPORT、测试库 WORK_ITEM_COMPLETE 各一例）。
 *
 * 与 JSON.stringify 的行为对齐（它也跳过 undefined 值的键），
 * 保证「写入时算的」与「从库里读回后重算的」是同一份输入。
 */
function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
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
  /**
   * 不可达记录的具体位置（2026-11-20 补）。
   *
   * 此前只有一个 `unreachable` 局部变量算出这批记录，注释写着「逐条报出」，
   * 但**从未被使用**（eslint 报 unused）——结果是审计页只显示「N 条未校验」，
   * 却不说是哪几条，运维拿到数字也无法定位。
   * 现在把 id / action 一并返回，与 unchecked 的减法口径互补：
   * `unchecked` 保证「缺口总量不会被藏起来」，这里回答「缺口在哪」。
   */
  unreachable: { id: string; action: string; previousHash: string | null }[] | null;
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
  /** 首个问题（用于快速定位）；继续遍历以覆盖全量 */
  let firstBroken: { id: string; action: string; reason: string } | null = null;

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

  // 全图遍历（2026-11-19 改）。
  //
  // 此前是单链遍历：从 prev=null 出发，每个前驱只取 createdAt 最早的一条继续，
  // 其余分支静默丢弃。撤销唯一约束后「同事务多条审计」会共用同一个前驱形成分叉，
  // 单链遍历在第一个分叉点就走进死路 —— 主库实测 checked=7 / 26，
  // 19 条审计从未被校验，而 ok 仍是 true。
  //
  // 现在改为遍历所有可达节点（含全部分支）。校验语义相应从
  // 「线性链：previousHash 必须等于上一条的 integrityHash」
  // 改为「图：previousHash 必须指向图中真实存在的 hash（或 null）」。
  // 分叉本身不再算断裂 —— 它是撤销唯一约束后的已知取舍，单独计入 forks。
  const allHashed = rows.filter((r) => r.integrityHash !== null);
  const byHash = new Map<string, AuditRow>();
  for (const row of rows) {
    if (row.integrityHash) byHash.set(row.integrityHash, row);
  }

  const seen = new Set<string>();
  const ordered: AuditRow[] = [];
  const stack: AuditRow[] = [...(byPrev.get(null) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop() as AuditRow;
    const key = node.integrityHash as string;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(node);
    for (const succ of byPrev.get(key) ?? []) {
      if (!seen.has(succ.integrityHash as string)) stack.push(succ);
    }
  }

  // 不可达节点：其 previousHash 指向图中不存在的 hash（被删/被改），
  // 或压根没有根可达。这是真正的断链信号，逐条报出。
  const unreachable = rows.filter(
    (r) => r.integrityHash !== null && !seen.has(r.integrityHash as string)
  );

  for (const row of ordered) {
    // 图语义：previousHash 必须是 null 或指向图中真实存在的记录
    const prev = row.previousHash;
    if (prev !== null && !byHash.has(prev)) {
      // 记录但不中断：校验要覆盖全量，遇错即停会让后面的记录从未被检查过
      if (!firstBroken) {
        firstBroken = {
          id: row.id,
          action: row.action,
          reason: `previousHash 指向不存在的记录（${prev.slice(0, 12)}…），链在此断`
        };
      }
      continue;
    }
    const expected = computeAuditHash({
      userId: row.userId, action: row.action, targetType: row.targetType,
      targetId: row.targetId, detail: row.detail, ip: row.ip,
      userAgent: row.userAgent, createdAt: row.createdAt, previousHash: row.previousHash
    });
    if (expected !== row.integrityHash) {
      if (!firstBroken) {
        firstBroken = {
          id: row.id,
          action: row.action,
          reason: "记录内容与自身摘要不符（该条被改动）"
        };
      }
      continue;
    }
    checked += 1;
  }

  // unchecked 的定义：带摘要总数里「没有通过逐条校验」的部分。
  // 初版写成 allHashed.length - ordered.length（没进遍历序列的），
  // 导致 checked + unchecked ≠ total —— 断裂时 checked 停在断点，
  // 而 ordered 已排到后面，两边口径不同，覆盖账对不上。
  // 现在统一为 total - checked，等式恒成立：
  //   · 分叉分支（遍历只走第一条，其余未校验）
  //   · 断裂点及其之后
  // 都计入 unchecked。
  // 覆盖账：unchecked = 带摘要总数 - 通过校验的条数。
  // 恒等式 checked + unchecked === total 成立，缺口不会被藏起来。
  return {
    ok: firstBroken === null,
    checked,
    skippedLegacy,
    brokenAt: firstBroken,
    forks: forks.length ? forks : null,
    unchecked: allHashed.length - checked,
    unreachable: unreachable.length
      ? unreachable.map((r) => ({ id: r.id, action: r.action, previousHash: r.previousHash }))
      : null
  };
}
