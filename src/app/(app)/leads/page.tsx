import { requireSession } from "@/lib/auth/session";
import { listLeadOwners, listLeads } from "@/server/leads/actions";
import { getLeadFunnel } from "@/server/leads/analytics";
import { LeadsView } from "./_components/leads-view";

/**
 * 获客线索（2026-11-21，全链路数字化 阶段 1）
 *
 * 这一段回答的是获客唯一该答的问题：**从多少个线索里谈成了几个**。
 * 收案（Intake）是"决定接案之后"的事，两者刻意分开——
 * 混在一起会让收案列表被「问一句就走」的噪声污染。
 */
export default async function LeadsPage() {
  await requireSession("clients.read");
  const [leads, funnel, owners] = await Promise.all([
    listLeads({ stage: "ALL" }),
    getLeadFunnel(),
    listLeadOwners()
    // 阶段二：获客看板。分母口径见 analytics.ts 文件头（期间新增线索，不是期间转化）
  ]);
  return <LeadsView leads={leads} funnel={funnel} owners={owners} />;
}
