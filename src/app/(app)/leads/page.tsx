import { requireSession } from "@/lib/auth/session";
import { listLeadOwners, listLeads } from "@/server/leads/actions";
import { listLeadChannels } from "@/server/leads/channels";
import { listLawyerOptions } from "@/server/leads/owners";
import { getLeadFinancePolicy } from "@/server/settings/lead-finance-policy";
import { getLeadsListColumns } from "@/server/settings/leads-columns";
import { getUpcomingVisits } from "@/server/leads/upcoming-visits";
import { getStaleConsultedLeads } from "@/server/leads/stale-consulted";
import { getChannelCostComparison, listChannelCosts, monthKey, recentMonths } from "@/server/leads/channel-costs";
import { getChannelQualityComparison } from "@/server/leads/channel-quality";
import { shMonthStart } from "@/server/finance/facts";
import { getLeadToCash } from "@/server/leads/lead-to-cash";
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
export default async function LeadsPage({ searchParams }: { searchParams?: Promise<{ assignee?: string; channel?: string; costMonth?: string }> }) {
  const sp = (await searchParams) ?? {};
  // 渠道下钻（2026-11-23）：?channel=<id>
  const channelFilter = typeof sp.channel === "string" && sp.channel.trim() ? sp.channel.trim() : null;
  const assigneeView = (sp.assignee === "PENDING_ASSIGN" || sp.assignee === "PENDING_ACCEPT" ? sp.assignee : "ALL") as
    | "ALL"
    | "PENDING_ASSIGN"
    | "PENDING_ACCEPT";
  await requireSession("clients.read");
  // 首次进入自动预置常用渠道（幂等）：空表意味着没人建，等于没这个功能
  await ensureDefaultChannels().catch(() => ({ created: 0 }));
  const now = new Date();
  // 月界必须与漏斗同口径（上海时区）。容器时区是 UTC，
  // 用 `new Date(y, m, 1)` 会得到 UTC 月初 = 上海 08:00，
  // 于是"本月 00:00 登记的线索"会被判进上月 —— 质量环比因此全是 null（踩过）。
  const monthStart = shMonthStart(now);
  // 投放成本编辑月份（2026-11-23）：默认本月；只允许近 12 个月且不晚于本月
  // （补录上月是常态，填未来的数没有意义还会让环比错位）
  const thisMonth = monthKey(monthStart);
  const monthSeq = recentMonths(thisMonth, 12);
  const costMonth =
    typeof sp.costMonth === "string" && monthSeq.includes(sp.costMonth) ? sp.costMonth : thisMonth;

  const nextMonth = shMonthStart(now, 1);
  const prevMonthStart = shMonthStart(now, -1);
  const [leads, funnel, owners, channels, lawyers, financePolicy, leadToCash, listColumns, upcoming, staleConsulted, channelCosts, costCompare, qualityCompare] = await Promise.all([
    listLeads({ stage: "ALL", assignee: assigneeView, ...(channelFilter ? { channelId: channelFilter } : {}) }),
    // 阶段二：获客看板。分母口径见 analytics.ts 文件头（期间新增线索，不是期间转化）
    getLeadFunnel(),
    listLeadOwners(),
    // 2026-11-22 P0-1：两级渠道树
    listLeadChannels(),
    // 2026-11-22 P1-2：可派单的律师清单
    listLawyerOptions(),
    // 2026-11-22：业务口径（可配置，默认按回款 / 券金额=成本）
    getLeadFinancePolicy(),
    // 2026-11-22：线索到回款的闭环（本月口径）
    getLeadToCash({ start: monthStart, end: nextMonth }),
    // 2026-11-23：列显隐（按所配置，线索人列不可隐藏）
    getLeadsListColumns(),
    // 2026-11-23：未来 7 天待上门（基层每天要回答的问题）
    getUpcomingVisits(7),
    // 2026-11-23：已谈案未转收案（谈完没签是真实漏损，之前没有任何机制盯）
    getStaleConsultedLeads(3),
    // 2026-11-23：渠道月度投放成本（本月的，供面板直接编辑）
    listChannelCosts(costMonth),
    // 2026-11-23：本月 vs 上月投放对比（录入的数要参与判断）
    getChannelCostComparison(costMonth),
    // 2026-11-23：到店率/成交率环比。成本环比只说多花了多少，
    // 说不清"多花的钱有没有换来更好的客"。
    getChannelQualityComparison(monthStart, nextMonth, prevMonthStart, monthStart)
  ]);
  return <LeadsView leads={leads} funnel={funnel} owners={owners} channels={channels} lawyers={lawyers} assigneeView={assigneeView} financePolicy={financePolicy} leadToCash={leadToCash} listColumns={listColumns} channelFilter={channelFilter} upcoming={upcoming} staleConsulted={staleConsulted} channelCosts={channelCosts} costMonth={costMonth} costMonths={monthSeq} costCompare={Object.fromEntries(costCompare)} qualityCompare={Object.fromEntries(qualityCompare)} />;
}
