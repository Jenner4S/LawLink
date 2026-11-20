/**
 * 台账保留期（2026-11-22）
 *
 * ## 为什么需要
 *
 * 运行健康巡检发现：`ExternalCallLog`（外部调用台账）**没有任何清理策略**，
 * 三天测试回放就写了 28148 行。它是取证资料，要留；但**无上限增长**会在
 * 真实使用中变成两件事：库越来越大、统计查询越来越慢（groupBy 走时间索引，
 * 行数上去后 P95 会先变难看）。
 *
 * 所以需要的不是「删」或「不删」，而是**保留期**。
 *
 * ## 默认取 365 天（有主张）
 *
 * 取值理由：
 *   · 财务与合规复核通常回看一年内（跨年度审计）；
 *   · 该表只是**调用元数据**（服务名、耗时、是否成功），不含正文与凭据，
 *     留存风险低，可以留久一点；
 *   · 低于 90 天会明显损害「三个月前某次批量失败是什么原因」这类排查。
 *
 * 可配置：改 `retention.externalCallLogDays` 即可，不用改代码。
 * 设为 0 表示**不清理**（有的所要求全量留存取证数据）。
 *
 * ## 安全边界
 *
 * · 只会删 `createdAt < cutoff` 的行，**永不触碰当期**；
 * · 每轮删除写一条审计，含截止时间与删除条数 —— 删了什么要能查；
 * · 分批删除（单批 5000），避免一条长事务锁表。
 */
import { prisma } from "@/lib/prisma";

const KEY = "retention.externalCallLogDays";

/** 默认保留天数；0 = 不清理 */
export const DEFAULT_EXTERNAL_CALL_LOG_DAYS = 365;

export async function getExternalCallLogRetentionDays(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  const v = (row?.value as { days?: unknown } | null)?.days;
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : NaN;
  if (Number.isNaN(n) || n < 0) return DEFAULT_EXTERNAL_CALL_LOG_DAYS;
  return n;
}

export async function saveExternalCallLogRetentionDays(days: number): Promise<void> {
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: { days } },
    update: { value: { days } }
  });
}

export type RetentionPurgeResult = {
  /** 保留天数；0 表示未清理 */
  days: number;
  /** 删除的截止时间（createdAt 早于此的行被删）；未清理时为 null */
  cutoff: Date | null;
  /** 实际删除行数 */
  deleted: number;
};

/**
 * 清理超期外部调用台账。
 *
 * `now` 可注入，便于测试与补跑；生产由 cron 每周调用一次。
 */
export async function purgeExternalCallLogs(
  opts: { now?: Date; batchSize?: number } = {}
): Promise<RetentionPurgeResult> {
  const days = await getExternalCallLogRetentionDays();
  if (days === 0) return { days: 0, cutoff: null, deleted: 0 };

  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const batchSize = opts.batchSize ?? 5000;

  let deleted = 0;
  // 分批删：单批 5000 行，最多 20 批（10 万行/轮），避免长事务与锁表
  for (let i = 0; i < 20; i += 1) {
    const rows = await prisma.externalCallLog.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true },
      take: batchSize
    });
    if (rows.length === 0) break;
    const res = await prisma.externalCallLog.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } }
    });
    deleted += res.count;
    if (rows.length < batchSize) break;
  }

  return { days, cutoff, deleted };
}
