/**
 * 门户「案件进度」的**白名单投影**（2026-11-20，门户 S2）
 *
 * 方案 §七 Q1 的定案：**只显示阶段名 + 关键日期，不提供百分比。**
 *
 * 为什么不给百分比（原文照录，因为这是最容易被人"优化"掉的一处）：
 *   客户看到「60%」会自己在心里算「还有 40%，按这速度还要多久」，然后三天没动就来问。
 *   而律师**无法解释**这个数字——案件进度不是工作量，是法院排期。
 *   解释不了的数字，就是自己埋的争议。更麻烦的是客户会横向比较「人家三个月结案」。
 *   百分比需要一个可定义的「总工作量」作分母，案件没有。硬造一个 = 制造不可履约的承诺。
 *   阶段名是**事实**（法院的状态），不是我们的估计。
 *
 * 本文件的做法是**逐字段挑出来**（pick），不是「查出来再去掉敏感字段」（omit）。
 * 两者的差别很实际：将来 Matter 加了新的内部字段，pick 默认不会泄露，omit 默认会泄露。
 */

export type PortalMatterSummary = {
  matterId: string;
  internalCode: string;
  title: string;
  categoryLabel: string;
  /** 客户能看到的状态（办理中 / 已结案 / 已归档 …） */
  statusLabel: string;
  /** 当前阶段名。**给名字，不给进度** */
  stageName: string | null;
  stageStartedAt: Date | null;
  /** 受理日 / 结案日 —— 都是法院或双方确认的事实日期 */
  acceptedAt: Date | null;
  closedAt: Date | null;
  /** 主办律师姓名（客户本来就知道谁在办自己的案子） */
  leadLawyer: string | null;
};

/**
 * 从查到的案件行投影出客户可见字段。
 *
 * 刻意**不包含**：内部分析、经办记录、待办、涉案金额、材料清单与数量、
 * 团队成员以外的分工、任何"进度百分比/预计完成时间"。
 */
export function projectMatterSummary(row: {
  id: string;
  internalCode: string;
  title: string;
  categoryLabel: string;
  statusLabel: string;
  stageName: string | null;
  stageStartedAt: Date | null;
  acceptedAt: Date | null;
  closedAt: Date | null;
  leadLawyer: string | null;
}): PortalMatterSummary {
  return {
    matterId: row.id,
    internalCode: row.internalCode,
    title: row.title,
    categoryLabel: row.categoryLabel,
    statusLabel: row.statusLabel,
    stageName: row.stageName,
    stageStartedAt: row.stageStartedAt,
    acceptedAt: row.acceptedAt,
    closedAt: row.closedAt,
    leadLawyer: row.leadLawyer
  };
}
