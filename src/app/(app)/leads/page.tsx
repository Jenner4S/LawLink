import { requireSession } from "@/lib/auth/session";
import { listLeadOwners, listLeads } from "@/server/leads/actions";
import { listLeadChannels } from "@/server/leads/channels";
import { listLawyerOptions } from "@/server/leads/owners";
import { ensureDefaultChannels } from "@/server/leads/channels-actions";
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
  // 首次进入自动预置常用渠道（幂等）：空表意味着没人建，等于没这个功能
  await ensureDefaultChannels().catch(() => ({ created: 0 }));
  const [leads, funnel, owners, channels, lawyers] = await Promise.all([
    listLeads({ stage: "ALL" }),
    // 阶段二：获客看板。分母口径见 analytics.ts 文件头（期间新增线索，不是期间转化）
    getLeadFunnel(),
    listLeadOwners(),
    // 2026-11-22 P0-1：两级渠道树
    listLeadChannels(),
    // 2026-11-22 P1-2：可派单的律师清单
    listLawyerOptions()
  ]);
  return <LeadsView leads={leads} funnel={funnel} owners={owners} channels={channels} lawyers={lawyers} />;
}
