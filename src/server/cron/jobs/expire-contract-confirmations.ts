/**
 * 合同确认链接过期清理（P1-4 降级实现）。
 *
 * 把「PENDING 且 expiresAt 已过」的记录置为 EXPIRED：
 *   - 公开页本来就不放行过期链接；这里让律师侧列表与状态字段一致，便于筛选与统计；
 *   - 只动 PENDING：CONFIRMED / REVOKED 是证据链状态，任何清理都不得改写；
 *   - 与审计同事务：批次数与时间落审计，便于核对清理是否按预期运行。
 */
import { prisma } from "@/lib/prisma";
import { auditTx } from "@/server/audit";

export async function expireOverdueContractConfirmations(now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const stale = await tx.contractConfirmation.findMany({
      where: { status: "PENDING", expiresAt: { lt: now } },
      select: { id: true },
      take: 500
    });
    if (stale.length === 0) return { expired: 0 };

    const updated = await tx.contractConfirmation.updateMany({
      where: { id: { in: stale.map((row) => row.id) }, status: "PENDING" },
      data: { status: "EXPIRED" }
    });

    await auditTx(tx, {
      userId: null,
      action: "CONTRACT_EXPIRE_CRON",
      targetType: "ContractConfirmation",
      targetId: "batch",
      detail: { count: updated.count, at: now.toISOString() }
    });

    return { expired: updated.count };
  });
}
