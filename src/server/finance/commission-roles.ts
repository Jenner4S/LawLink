/**
 * 分成角色与建议值（2026-11-22，D 段）
 *
 * ## 客户在做什么
 *
 * 他现行系统有三列：**案源人 / 邀约人 / 面谈签约人**。
 * 一次成交的功劳拆给三个人——这不是同一字段的三种叫法，是**三笔绩效**。
 *
 * ## 为什么需要"建议值"而不是"自动写入"
 *
 * 线索里已有两个事实：谁在跟（`Lead.ownerId`）、谁最终谈成（转收案的操作人）。
 * 可以把它们**作为建议**呈现，但**不能自动写成绩效**：
 * 分成直接决定钱怎么分，误记一次就要走财务更正流程，还会引起内部纠纷。
 * 界面上预填、由人确认——比任何"智能推断"都可靠。
 */

import { prisma } from "@/lib/prisma";

/**
 * 角色中文名只在界面下拉里用（那边已有自己的常量），服务端不需要第二份 ——
 * 两份并存必然有一天只改一处。故此处不导出标签表。
 */
export type CommissionRoleKey = "REFERRER" | "INVITER" | "CLOSER" | "OTHER";

export type RoleSuggestion = {
  role: CommissionRoleKey;
  userId: string;
  userName: string;
  /** 这句话会显示在界面上，说明"为什么建议是他" */
  reason: string;
};

/**
 * 根据案件的来源线索给出角色建议。
 *
 * 数据链：Lead →（转化）→ Intake → Matter。
 * 因此从 matter 反查：matter.intakeId → Lead.convertedIntakeId。
 *
 * 只给出**能证实的**两个：
 * · 邀约人 = 线索负责人（谁在跟这条线索）
 * · 案源人 = 线索的来源方（转介绍时有具体人名，否则无可建议）
 * 面谈签约人通常就是主办律师，界面上已有承办信息，不重复建议。
 */
export async function suggestCommissionRoles(matterId: string): Promise<RoleSuggestion[]> {
  const id = String(matterId ?? "").trim();
  if (!id) return [];

  const matter = await prisma.matter.findUnique({
    where: { id },
    select: { intakeId: true }
  });
  if (!matter?.intakeId) return [];

  const lead = await prisma.lead.findFirst({
    where: { convertedIntakeId: matter.intakeId },
    select: {
      ownerId: true,
      owner: { select: { name: true } },
      source: true,
      sourceDetail: true
    }
  });
  if (!lead) return [];

  const out: RoleSuggestion[] = [];
  out.push({
    role: "INVITER",
    userId: lead.ownerId,
    userName: lead.owner.name,
    reason: `该案由他/她跟进的线索转化而来（来源：${lead.source}）`
  });
  return out;
}
