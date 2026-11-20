import { requireSession } from "@/lib/auth/session";
import { listLeads } from "@/server/leads/actions";
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
  const leads = await listLeads({ stage: "ALL" });
  return <LeadsView leads={leads} />;
}
