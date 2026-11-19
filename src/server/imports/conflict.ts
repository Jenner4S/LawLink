/**
 * 批量导入触发利益冲突检索（BACKLOG P1-1）
 *
 * 背景：导入界面写着「当事人（驱动利益冲突）」，但 commitMatterImportAction 建完案件后
 * 从不跑检索——冲突检索只发生在收案流程与案件动态复核。历史案件迁移进来后，所内不知道
 * 自己代理了对方当事人，这是执业违规风险，且导入路径是唯一能造出「案件存在但从未检索」
 * 的写入路径（界面创建的每件都过收案检索）。
 *
 * 口径（与收案转正式案件完全一致，不重写算法）：
 *   - 检索主体由本案当事人 + 委托方客户档案生成（buildIntakeConflictQueries，与案件动态
 *     复核同源），即「委托方 + 相对方」的名称与证件号；
 *   - 写入走 recordMatterReviewTx（src/server/conflicts/matter-review.ts）——与
 *     `convertIntakeToMatter` 承接收案时调用的**同一个函数**，一次落 ConflictCheck
 *     （matterId + subjectFingerprint + queryPayload）与 ConflictHit；
 *   - 未命中 → 结论自动 DIFFERENT（系统自动提示「未命中」，与收案未命中口径一致）；
 *     有命中 → 结论 PENDING，案件详情侧栏「利益冲突复核」卡出现，新增程序/委托合同
 *     等写路径被 assertMatterReviewCurrent 拦下，须律师给出结论后才继续。
 *
 * 不复用「收案」分支的 inheritedNote：收案转化时传的继承备注会把结论直接判成 DIFFERENT
 * （表示审批环节已复核）；导入没有任何前置审批，命中就必须停在 PENDING 等律师判断。
 */

import type { ConflictConclusion, ConflictSeverity, Prisma } from "@prisma/client";

import { recordMatterReviewTx } from "@/server/conflicts/matter-review";
import { intakeWorkflowReady } from "@/server/intakes/workflow";
import { conflictSeverityLabel } from "@/lib/approvals/intake-detail";
import { ActionError } from "@/lib/action-error";

/** 单次导入行的检索结果摘要；null 表示未执行（老库未启用动态复核） */
export type ImportConflictReview = {
  checkId: string;
  /** 命中冲突条数，0 = 系统检索未命中 */
  hitCount: number;
  /** 命中中的最高严重度，未命中为 null */
  maxSeverity: ConflictSeverity | null;
  conclusion: ConflictConclusion;
  /** 中文一行摘要，直接进导入结果清单 */
  summary: string;
};

const SEVERITY_ORDER: Record<ConflictSeverity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, BLOCKING: 3 };

/**
 * 为一个刚创建的案件跑一次利益冲突检索并落库。
 *
 * 必须在建案事务内调用（与 convertIntakeToMatter 同一事务边界）：
 * 案件与检索记录同生同灭，不会出现「案件已导入但从未检索」的半状态。
 */
export async function recordImportConflictReview(
  tx: Prisma.TransactionClient,
  userId: string,
  matterId: string
): Promise<ImportConflictReview | null> {
  // 动态复核依赖 2026-09-20 收案工作流建表（IntakeRevision / subjectFingerprint）。
  // 判断与「承接收案」转化处同一函数：老库未升级时不写复核记录（也写不进去），
  // 不让历史数据迁移因为一个尚未启用的能力整行失败。
  if (!(await intakeWorkflowReady(tx))) return null;

  let checkId: string;
  try {
    checkId = (await recordMatterReviewTx(tx, userId, matterId)).id;
  } catch (e) {
    // 检索是纯读 + 一次写，失败即真实故障；本行整体回滚，避免留下无人复核的案件
    throw new ActionError(
      `利益冲突检索失败，本行已回滚（未创建案件）：${e instanceof Error ? e.message : "未知错误"}`
    );
  }

  const check = await tx.conflictCheck.findUniqueOrThrow({
    where: { id: checkId },
    select: { conclusion: true, hits: { select: { severity: true } } }
  });

  const hitCount = check.hits.length;
  const maxSeverity = check.hits.reduce<ConflictSeverity | null>(
    (acc, hit) => (acc === null || SEVERITY_ORDER[hit.severity] > SEVERITY_ORDER[acc] ? hit.severity : acc),
    null
  );

  return {
    checkId,
    hitCount,
    maxSeverity,
    conclusion: check.conclusion,
    summary:
      hitCount === 0
        ? "未命中系统内已登记案件（系统自动检索）"
        : `命中 ${hitCount} 条冲突（最高${conflictSeverityLabel[maxSeverity ?? "LOW"]}），请在案件页「利益冲突复核」给出结论`
  };
}
