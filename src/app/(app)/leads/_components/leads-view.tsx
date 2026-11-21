"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Phone, MapPin, MessagesSquare, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTopbarAction } from "@/components/layout/topbar-action";
import { LeadTimelineDialog } from "./lead-timeline-dialog";
import { promptDialog } from "@/components/patterns/confirm-dialog";
import { formatDateTime } from "@/lib/utils";
import { actionErrorMessage } from "@/lib/action-error";
import { addLeadActivity, assignLeadLawyer, convertLeadToIntake, createLead, markLeadLost, respondLeadAssignment, setLeadSecondOwner, type LeadRow } from "@/server/leads/actions";
import { createLeadChannel, toggleLeadChannel } from "@/server/leads/channels-actions";
import { updateLeadFinancePolicy } from "@/server/settings/lead-finance-policy-actions";
import type { LeadFinancePolicy } from "@/server/settings/lead-finance-policy";
import type { LeadToCash } from "@/server/leads/lead-to-cash";
import type { LeadFunnel } from "@/server/leads/analytics";
import type { ChannelNode } from "@/server/leads/channels";

const ASSIGN_CN: Record<string, string> = {
  ASSIGNED: "待接单", ACCEPTED: "已接", DECLINED: "拒接", BUSY: "暂忙", UNASSIGNED: "未派"
};

const STAGE_CN: Record<string, string> = {
  LEAD: "线索", INVITED: "已邀约", VISITED: "已到店",
  CONSULTED: "已谈案", CONVERTED: "已转收案", LOST: "流失"
};
const STAGE_CLS: Record<string, string> = {
  LEAD: "b-slate", INVITED: "b-blue", VISITED: "b-blue",
  CONSULTED: "b-amber", CONVERTED: "b-green", LOST: "b-slate"
};
const SOURCE_CN: Record<string, string> = {
  REFERRAL: "转介绍", ONLINE: "网络", OFFLINE: "地推/活动",
  PARTNER: "合作机构", AD: "广告", OTHER: "其他"
};

type Filter = "OPEN" | "CONVERTED" | "LOST" | "ALL";

export function LeadsView({
  leads,
  funnel,
  owners,
  channels,
  lawyers,
  assigneeView = "ALL",
  financePolicy,
  leadToCash
}: {
  leads: LeadRow[];
  funnel: LeadFunnel;
  /** 在途线索的负责人（含人数），用于按人筛选；口径与列表默认一致 */
  owners: { ownerId: string; ownerName: string; count: number }[];
  /** 两级渠道树（2026-11-22 P0-1） */
  channels: ChannelNode[];
  /** 可派单的律师（2026-11-22 P1-2） */
  lawyers: { id: string; name: string }[];
  /** 当前派单视图（2026-11-22）：ALL / PENDING_ASSIGN / PENDING_ACCEPT */
  assigneeView?: "ALL" | "PENDING_ASSIGN" | "PENDING_ACCEPT";
  /** 业务口径（2026-11-22）：风代计提基数、券金额归属 */
  financePolicy: LeadFinancePolicy;
  /** 线索到回款闭环（本月）：补上漏斗与财务之间缺失的那一段连接 */
  leadToCash: LeadToCash;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  // 渠道设置（2026-11-22 P0-1）：渠道必须可配置（AGENTS §五之二），否则新投放平台无处可填
  const [channelPanel, setChannelPanel] = useState(false);
  const [newChannel, setNewChannel] = useState({ name: "", parentId: "" });
  const [form, setForm] = useState({ name: "", phone: "", wechat: "", organization: "", occupation: "", source: "REFERRAL", sourceDetail: "", channelId: "", voucherAmount: "" });

  useTopbarAction({ label: "新建线索", onClick: () => setCreating(true) }, []);

  const rows = useMemo(() => {
    const byStage = filter === "ALL"
      ? leads
      : filter === "OPEN"
        ? leads.filter((l) => ["LEAD", "INVITED", "VISITED", "CONSULTED"].includes(l.stage))
        : leads.filter((l) => l.stage === filter);
    // 负责人筛选在客户端做：列表最多 200 条已全量取回，再发一次请求只会多一次往返
    return ownerFilter ? byStage.filter((l) => l.ownerId === ownerFilter) : byStage;
  }, [leads, filter, ownerFilter]);

  const counts = useMemo(() => ({
    OPEN: leads.filter((l) => ["LEAD", "INVITED", "VISITED", "CONSULTED"].includes(l.stage)).length,
    CONVERTED: leads.filter((l) => l.stage === "CONVERTED").length,
    LOST: leads.filter((l) => l.stage === "LOST").length,
    ALL: leads.length
  }), [leads]);

  const submitCreate = () => {
    if (form.name.trim().length < 2) { toast.error("请填写线索人姓名"); return; }
    if (!form.phone.trim() && !form.wechat.trim()) { toast.error("请至少填写电话或微信"); return; }
    startTransition(async () => {
      try {
        const res = await createLead({
          ...form,
          source: form.source as never,
          channelId: form.channelId,
          voucherAmount: form.voucherAmount ? Number(form.voucherAmount) : undefined
        });
        // 2026-11-22 P0-2：同号可能已有人跟过（撞单/老客户复询）——提示但不阻断
        if (res.duplicates && res.duplicates.length > 0) {
          const first = res.duplicates[0];
          const more = res.duplicates.length > 1 ? ` 等 ${res.duplicates.length} 条` : "";
          toast.warning("该号码可能已有人跟进", {
            duration: 10000,
            description: `${first.kind === "LEAD" ? "线索" : first.kind === "CLIENT" ? "客户" : "收案"}「${first.name}」${first.ownerName ? `（${first.ownerName}）` : ""}${more}。线索已照常登记——同号也可能是家人代接或公司总机，请自行确认。`
          });
        } else {
          toast.success("线索已登记");
        }
        setCreating(false);
        setForm({ name: "", phone: "", wechat: "", organization: "", occupation: "", source: "REFERRAL", sourceDetail: "", channelId: "", voucherAmount: "" });
        router.refresh();
      } catch (err) {
        toast.error("登记失败", { description: actionErrorMessage(err) });
      }
    });
  };

  const record = (lead: LeadRow, type: "CONTACT" | "INVITE" | "VISIT" | "NO_SHOW" | "CONSULT") => {
    setBusyId(lead.id);
    startTransition(async () => {
      try {
        const res = await addLeadActivity({ leadId: lead.id, type, note: "" });
        toast.success(`已记录，当前阶段：${STAGE_CN[res.stage] ?? res.stage}`);
        router.refresh();
      } catch (err) {
        toast.error("记录失败", { description: actionErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    });
  };

  const convert = async (lead: LeadRow) => {
    setBusyId(lead.id);
    startTransition(async () => {
      try {
        const res = await convertLeadToIntake({ leadId: lead.id });
        toast.success("已转为收案", { description: `收案 ${res.intakeId.slice(0, 8)}… 已创建，请到「案件 · 收案中」继续办理` });
        router.refresh();
      } catch (err) {
        toast.error("转化失败", { description: actionErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    });
  };

  const lose = async (lead: LeadRow) => {
    const reason = await promptDialog({
      title: `标记「${lead.name}」流失`,
      description: "流失原因会进入获客分析——没有原因的流失等于没有信息。",
      placeholder: "如：比价后选了别家 / 暂缓 / 无委托意向",
      required: true,
      maxLength: 200
    });
    if (!reason) return;
    setBusyId(lead.id);
    startTransition(async () => {
      try {
        await markLeadLost({ leadId: lead.id, reason });
        toast.success("已标记流失");
        router.refresh();
      } catch (err) {
        toast.error("操作失败", { description: actionErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    });
  };

  // 比率显示：null（分母为 0）显示「—」，不显示 0%——0% 会被误读成「一个都没成」
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

  return (
    <div className="mo-page">
      {/* 获客看板（阶段二）：分母口径 = 本月新增线索，见 analytics.ts 文件头 */}
      <div className="card mb-3 p-4">
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13px] font-medium">本月获客漏斗</span>
          <span className="text-[10.5px] text-[var(--t-muted)]">
            分母＝本月新增线索（{funnel.total} 条）。用「本月转化的数量 ÷ 本月线索数」会因跨期成交超过 100%，故不采用。
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11.5px] sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "新增线索", value: String(funnel.total), sub: `预计 ¥${funnel.expectedAmount.toLocaleString()}` },
            { label: "已邀约", value: String(funnel.invited), sub: `邀约率 ${pct(funnel.inviteRate)}` },
            { label: "已到店", value: String(funnel.visited), sub: `到店率 ${pct(funnel.visitRate)}` },
            { label: "已谈案", value: String(funnel.consulted), sub: "由动作记录统计" },
            { label: "爽约", value: String(funnel.noShow), sub: `爽约率 ${pct(funnel.noShowRate)}` },
            { label: "已转收案", value: String(funnel.converted), sub: `转化率 ${pct(funnel.conversionRate)}` },
            { label: "转化天数", value: funnel.medianDaysToConvert === null ? "—" : `${funnel.medianDaysToConvert} 天`, sub: "中位数" }
          ].map((k) => (
            <div key={k.label} className="rounded border border-[var(--line)] px-3 py-2">
              <div className="text-[10px] text-[var(--t-muted)]">{k.label}</div>
              <div className="font-mono tabular text-[15px]">{k.value}</div>
              <div className="text-[9.5px] text-[var(--t-muted)]">{k.sub}</div>
            </div>
          ))}
        </div>

        {/* 2026-11-22：线索到回款的闭环。放在 total>0 门之外——
            本月没有线索时也要显示「线索 0 → … 回款率 —」，
            否则空白会被读成"功能没做"，而真实情况是"本月还没线索"。 */}
        <div className="mt-3">
            <div>
              <div className="mb-1 text-[11px] text-[var(--t-muted)]">本月线索 → 回款（只算本月新增线索）</div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                <span>线索 {leadToCash.leadCount}</span>
                <span className="text-[var(--t-muted)]">→</span>
                <span>转收案 {leadToCash.convertedCount}</span>
                <span className="text-[var(--t-muted)]">→</span>
                <span>已签约 {leadToCash.signedMatterCount}</span>
                <span className="text-[var(--t-muted)]">→</span>
                <span>已回款 {leadToCash.paidMatterCount}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px]">
                <span className="tabular text-[var(--t-muted)]">签约额 ¥{leadToCash.contractAmount.toLocaleString()}</span>
                <span className="tabular">实收 ¥{leadToCash.receivedAmount.toLocaleString()}</span>
                <span className="tabular text-[var(--t-muted)]">回款率 {pct(leadToCash.collectionRate)}</span>
                <span className="tabular text-[var(--t-muted)]">线索→回款 {pct(leadToCash.leadToCashRate)}</span>
              </div>
            </div>
        </div>

        {funnel.total > 0 ? (
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-[11px] text-[var(--t-muted)]">按来源</div>
              <div className="space-y-0.5">
                {funnel.bySource.map((r) => (
                  <div key={r.source} className="flex items-center gap-2 text-[11px]">
                    <span className="w-16 shrink-0">{SOURCE_CN[r.source] ?? r.source}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-[var(--surface-sunken,rgba(0,0,0,.04))]">
                      <div className="h-full rounded bg-[var(--teal-deep,#0f766e)]" style={{ width: `${funnel.total ? (r.total / funnel.total) * 100 : 0}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right tabular text-[var(--t-muted)]">{r.total} 条 · {pct(r.conversionRate)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-[var(--t-muted)]">按渠道（决定钱往哪投）</div>
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-[9.5px] text-[var(--t-muted)]">
                  <span className="w-28 shrink-0">渠道</span>
                  <span className="w-24 shrink-0 text-right">线索 / 到店 / 成交</span>
                  <span className="w-14 shrink-0 text-right">成交率</span>
                  <span className="w-24 shrink-0 text-right">
                    券{funnel.voucherSide === "COST" ? "成本" : funnel.voucherSide === "REVENUE" ? "收入" : ""}
                  </span>
                  <span className="w-24 shrink-0 text-right">单条线索 / 单成交</span>
                </div>
                {funnel.byChannel.slice(0, 6).map((r) => (
                  <div key={r.key} className="flex items-center gap-2 text-[11px]">
                    <span className="w-28 shrink-0 truncate" title={r.label}>{r.label}</span>
                    <span className="w-24 shrink-0 text-right tabular text-[var(--t-muted)]">
                      {r.total} / {r.visited} / {r.converted}
                    </span>
                    <span className="w-14 shrink-0 text-right tabular">{pct(r.conversionRate)}</span>
                    <span className="w-24 shrink-0 text-right tabular text-[var(--t-muted)]">
                      {r.voucherAmount > 0 ? `¥${r.voucherAmount}` : "—"}
                    </span>
                    {/* 单位成本（2026-11-22）：只做成本，不做 ROI 比率——
                        收入侧没有可信数据，混进来会把"线索质量"和"客单价"搅在一起。
                        分母为 0 或未录券金额时显示「—」，不显示 0（0 成本会被误读成"不花钱"）。 */}
                    {/* 单到店成本也已算好，但列宽不够就放 title 里——信息可得、不挤版面 */}
                    <span
                      className="w-24 shrink-0 text-right tabular"
                      title={`单到店成本 ${r.costPerVisit === null ? "—" : `¥${r.costPerVisit}`}`}
                    >
                      {r.costPerLead === null ? "—" : `¥${r.costPerLead}`}
                      {" / "}
                      {r.costPerConverted === null ? "—" : `¥${r.costPerConverted}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1 text-[11px] text-[var(--t-muted)]">按负责人</div>
              <div className="space-y-0.5">
                {funnel.byOwner.map((r) => (
                  <div key={r.ownerId} className="flex items-center gap-2 text-[11px]">
                    <span className="w-16 shrink-0 truncate">{r.ownerName}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded bg-[var(--surface-sunken,rgba(0,0,0,.04))]">
                      <div className="h-full rounded bg-[var(--bronze,#a16207)]" style={{ width: `${funnel.total ? (r.total / funnel.total) * 100 : 0}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right tabular text-[var(--t-muted)]">{r.total} 条 · {pct(r.conversionRate)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {funnel.lostReasons.length > 0 ? (
          <div className="mt-2 text-[10.5px] text-[var(--t-muted)]">
            本月流失 {funnel.lost} 条：
            {funnel.lostReasons.map((r) => `${r.reason}（${r.count}）`).join("、")}
          </div>
        ) : null}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {([["OPEN", "在途"], ["CONVERTED", "已转收案"], ["LOST", "已流失"], ["ALL", "全部"]] as [Filter, string][]).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setFilter(k)}
            className={`btn btn-sm ${filter === k ? "btn-primary" : "btn-ghost"}`}
          >
            {label} {counts[k]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-[11px] text-[var(--t-muted)]">负责人</label>
          <select
            className="input h-7 text-[11px]"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
          >
            <option value="">全部（{owners.reduce((n, o) => n + o.count, 0)}）</option>
            {owners.map((o) => (
              <option key={o.ownerId} value={o.ownerId}>{o.ownerName}（{o.count}）</option>
            ))}
          </select>
        </div>
        <span className="w-full text-[11px] text-[var(--t-muted)] lg:w-auto">
          转化只能从「已谈案」发起——否则漏斗里看不到真实的到店与谈案
        </span>
      </div>

      {/* 2026-11-22 P1-2：派单视图。回答「今天该我动的还有几件」——
          没有它，200 条里找待接单只能靠眼睛扫。 */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        <span className="text-[11px] text-[var(--t-muted)]">派单</span>
        {([
          ["ALL", "全部"],
          ["PENDING_ASSIGN", "待派单"],
          ["PENDING_ACCEPT", "待接单"]
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => router.push(key === "ALL" ? "/leads" : `/leads?assignee=${key}`)}
            className={`rounded px-1.5 py-0.5 text-[10.5px] ${
              assigneeView === key
                ? "bg-[var(--primary)] text-white"
                : "bg-[var(--surface-2,rgba(100,116,139,.10))] text-[var(--t-muted)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mb-2">
        <button
          type="button"
          onClick={() => setChannelPanel((v) => !v)}
          className="text-[11px] text-[var(--t-muted)] underline decoration-dotted"
        >
          {channelPanel ? "收起渠道与口径" : "渠道与口径"}
        </button>
      </div>

      {channelPanel ? (
        <div className="card mb-3 p-4">
          <div className="mb-3 rounded border border-[var(--bd-hair)] p-2">
            <p className="mb-1 text-[12px] font-medium">业务口径（改配置即可，不动代码）</p>
            <p className="mb-2 text-[10.5px] text-[var(--t-muted)]">
              这几项只有业主能定；定下来之前系统按有主张的默认跑，定了随时切换。
              <br />
              坏账自批上限默认 <b>0 = 永不自批</b>（两人复核）；填正数则小于该金额可由申报人自行确认，审计留痕。
            </p>
            <div className="flex flex-wrap gap-3">
              <label className="text-[11px]">
                风代计提基数
                <select
                  className="input ml-1 h-6 text-[11px]"
                  value={financePolicy.contingencyBasis}
                  disabled={isPending}
                  onChange={(e) => startTransition(async () => {
                    try {
                      await updateLeadFinancePolicy({ ...financePolicy, contingencyBasis: e.target.value as "RECEIVED" | "CONTRACT" });
                      toast.success("已切换计提基数");
                      router.refresh();
                    } catch (err) {
                      toast.error("保存失败", { description: actionErrorMessage(err) });
                    }
                  })}
                >
                  <option value="RECEIVED">按回款（默认，先收后提）</option>
                  <option value="CONTRACT">按合同额（预估收入）</option>
                </select>
              </label>
              <label className="text-[11px]">
                团购/券金额归属
                <select
                  className="input ml-1 h-6 text-[11px]"
                  value={financePolicy.voucherAmountSide}
                  disabled={isPending}
                  onChange={(e) => startTransition(async () => {
                    try {
                      await updateLeadFinancePolicy({ ...financePolicy, voucherAmountSide: e.target.value as "COST" | "REVENUE" | "IGNORED" });
                      toast.success("已切换券金额口径");
                      router.refresh();
                    } catch (err) {
                      toast.error("保存失败", { description: actionErrorMessage(err) });
                    }
                  })}
                >
                  <option value="COST">成本侧（律所付平台，默认）</option>
                  <option value="REVENUE">收入侧（客户付券款）</option>
                  <option value="IGNORED">只记录，不参与计算</option>
                </select>
              </label>
              <label className="text-[11px]">
                坏账自批上限（元）
                <input
                  className="input ml-1 h-6 w-20 text-[11px]"
                  type="number"
                  min={0}
                  step="0.01"
                  defaultValue={financePolicy.writeOffSelfApproveBelow}
                  disabled={isPending}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isFinite(v) || v < 0 || v === financePolicy.writeOffSelfApproveBelow) return;
                    startTransition(async () => {
                      try {
                        await updateLeadFinancePolicy({ ...financePolicy, writeOffSelfApproveBelow: v });
                        toast.success(v === 0 ? "已改为：坏账必须他人复核" : `已改为：${v} 元以下可自批`);
                        router.refresh();
                      } catch (err) {
                        toast.error("保存失败", { description: actionErrorMessage(err) });
                      }
                    });
                  }}
                  title="0 = 永不自批（默认，两人复核）；填 >0 时小于该金额的坏账可由申报人自行确认，审计会记录 selfApproved"
                />
              </label>
            </div>
          </div>
          <p className="mb-1 text-[13px] font-medium">渠道（两级）</p>
          <p className="mb-2 text-[10.5px] text-[var(--t-muted)]">
            渠道做成单选才能聚合出「某平台本月来多少条、成交几单」。停用不删除——历史线索仍指向它。
          </p>
          <div className="mb-2 space-y-1">
            {channels.map((c) => (
              <div key={c.id} className="text-[11px]">
                <button
                  type="button"
                  onClick={() => startTransition(async () => {
                    await toggleLeadChannel({ id: c.id, active: !c.active }).catch((e) => toast.error(actionErrorMessage(e)));
                    router.refresh();
                  })}
                  className={c.active ? "" : "line-through text-[var(--t-muted)]"}
                  title="点击启用/停用"
                >
                  {c.name}
                </button>
                {c.children.length > 0 ? (
                  <span className="ml-2 text-[var(--t-muted)]">
                    {c.children.map((x) => (
                      <button
                        key={x.id}
                        type="button"
                        onClick={() => startTransition(async () => {
                          await toggleLeadChannel({ id: x.id, active: !x.active }).catch((e) => toast.error(actionErrorMessage(e)));
                          router.refresh();
                        })}
                        className={`ml-1 underline decoration-dotted ${x.active ? "" : "line-through opacity-50"}`}
                        title="点击启用/停用"
                      >
                        {x.name}
                      </button>
                    ))}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-7 w-40 text-[11px]"
              placeholder="新渠道名称"
              value={newChannel.name}
              onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })}
            />
            <select
              className="input h-7 text-[11px]"
              value={newChannel.parentId}
              onChange={(e) => setNewChannel({ ...newChannel, parentId: e.target.value })}
            >
              <option value="">作为一级渠道</option>
              {channels.map((c) => <option key={c.id} value={c.id}>挂在「{c.name}」下</option>)}
            </select>
            <Button
              size="sm"
              disabled={isPending || !newChannel.name.trim()}
              onClick={() => startTransition(async () => {
                try {
                  await createLeadChannel({ name: newChannel.name, parentId: newChannel.parentId || undefined });
                  toast.success("渠道已添加");
                  setNewChannel({ name: "", parentId: "" });
                  router.refresh();
                } catch (err) {
                  toast.error("添加失败", { description: actionErrorMessage(err) });
                }
              })}
            >
              添加
            </Button>
          </div>
        </div>
      ) : null}

      {creating ? (
        <div className="card mb-3 p-4">
          <p className="mb-2 text-[13px] font-medium">新建线索</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div><Label className="text-[11px]">姓名 *</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="张三" /></div>
            <div><Label className="text-[11px]">电话</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="13800000000" /></div>
            <div><Label className="text-[11px]">微信</Label><Input value={form.wechat} onChange={(e) => setForm({ ...form, wechat: e.target.value })} /></div>
            <div><Label className="text-[11px]">单位</Label><Input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} /></div>
            <div><Label className="text-[11px]">来源</Label>
              <select className="input" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
                {Object.entries(SOURCE_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <div><Label className="text-[11px]">职业/行业</Label><Input value={form.occupation} onChange={(e) => setForm({ ...form, occupation: e.target.value })} placeholder="如 餐饮 / 房产中介" /></div>
            <div><Label className="text-[11px]">来源细节</Label><Input value={form.sourceDetail} onChange={(e) => setForm({ ...form, sourceDetail: e.target.value })} placeholder="谁介绍的 / 哪个平台" /></div>
            {/* 2026-11-22 P0-1：渠道两级联动（单选才能聚合出按平台的 ROI） */}
            <div>
              <Label className="text-[11px]">渠道</Label>
              <select className="input" value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })}>
                <option value="">未指定</option>
                {channels.filter((c) => c.active).map((c) => (
                  <optgroup key={c.id} label={c.name}>
                    {c.children.filter((x) => x.active).map((x) => (
                      <option key={x.id} value={x.id}>{c.name} / {x.name}</option>
                    ))}
                    <option value={c.id}>{c.name}（一级）</option>
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-[11px]">团购/券金额</Label>
              <Input
                value={form.voucherAmount}
                onChange={(e) => setForm({ ...form, voucherAmount: e.target.value })}
                placeholder="如 99"
                inputMode="decimal"
              />
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={submitCreate} disabled={isPending} className="gap-1">
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              保存
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCreating(false)} disabled={isPending}>取消</Button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="card p-8 text-center text-[12.5px] text-[var(--t-muted)]">
          还没有线索。点右上角「新建线索」登记第一位。
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="mo-table" style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th>线索人</th><th>来源</th><th>阶段</th><th>跟进</th><th>负责人</th><th>最近更新</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td>
                    <div className="text-[12.5px] font-medium">{l.name}</div>
                    <div className="text-[10.5px] text-[var(--t-muted)] flex items-center gap-1">
                      <span>{l.phone ?? l.wechat ?? "—"}{l.organization ? ` · ${l.organization}` : ""}</span>
                      {l.phoneDuplicateCount > 0 ? (
                        <span
                          className="rounded bg-[var(--amber-bg,rgba(161,98,7,.12))] px-1 text-[9.5px] text-[var(--bronze,#a16207)]"
                          title={`列表中还有 ${l.phoneDuplicateCount} 条相同号码的线索`}
                        >
                          重复×{l.phoneDuplicateCount}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="text-[11.5px]">
                    {SOURCE_CN[l.source] ?? l.source}
                    {l.sourceDetail ? <div className="text-[10px] text-[var(--t-muted)]">{l.sourceDetail}</div> : null}
                  </td>
                  <td>
                    <span className={`badge ${STAGE_CLS[l.stage] ?? "b-slate"}`} style={{ fontSize: 10 }}>{STAGE_CN[l.stage] ?? l.stage}</span>
                    {l.visitOutcome === "NO_SHOW" ? (
                      <span className="ml-1 rounded bg-[var(--red-bg,rgba(185,28,28,.12))] px-1 text-[9.5px] text-[var(--red,#b91c1c)]" title="约定时间已过但未到店">
                        爽约
                      </span>
                    ) : null}
                  </td>
                  <td className="text-[11px]">
                    <button
                      type="button"
                      onClick={() => setDetailId(l.id)}
                      className="underline decoration-dotted text-[var(--t-muted)] hover:text-[var(--t-strong)]"
                      title="查看跟进时间线"
                    >
                      {l.activityCount} 次
                    </button>
                  </td>
                  <td className="text-[11.5px]">{l.owner.name}</td>
                  <td className="text-[11px] text-[var(--t-muted)]">{formatDateTime(l.updatedAt)}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {l.stage === "LEAD" ? (
                        <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id} onClick={() => record(l, "CONTACT")} className="gap-1"><Phone className="h-3 w-3" />联系</Button>
                      ) : null}
                      {l.stage === "LEAD" || l.stage === "INVITED" ? (
                        <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id} onClick={() => record(l, "INVITE")} className="gap-1"><MessagesSquare className="h-3 w-3" />邀约</Button>
                      ) : null}
                      {l.stage === "INVITED" ? (
                        <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id} onClick={() => record(l, "VISIT")} className="gap-1"><MapPin className="h-3 w-3" />到店</Button>
                      ) : null}
                      {l.stage === "VISITED" ? (
                        <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id} onClick={() => record(l, "CONSULT")}>谈案完成</Button>
                      ) : null}
                      {/* 2026-11-22 P1-2/P1-3：派单给律师 + 二次对接人。
                          派单状态由律师本人确认——系统替律师答应下来，等于把"拒接"这一真实情况藏起来。 */}
                      <select
                        className="input h-6 max-w-[110px] text-[10.5px]"
                        value={l.assigneeLawyerId ?? ""}
                        disabled={isPending || busyId === l.id || l.stage === "CONVERTED" || l.stage === "LOST"}
                        onChange={(e) => startTransition(async () => {
                          const lawyerId = e.target.value;
                          if (!lawyerId) return;
                          try {
                            await assignLeadLawyer({ leadId: l.id, lawyerId });
                            toast.success("已派单，待律师确认");
                            router.refresh();
                          } catch (err) {
                            toast.error("派单失败", { description: actionErrorMessage(err) });
                          }
                        })}
                        title="对接律师"
                      >
                        <option value="">派给律师…</option>
                        {lawyers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      {l.assigneeStatus !== "UNASSIGNED" ? (
                        <span
                          className={`rounded px-1 text-[9.5px] ${
                            l.assigneeStatus === "ACCEPTED"
                              ? "bg-[var(--green-bg,rgba(21,128,61,.12))] text-[var(--green,#15803d)]"
                              : l.assigneeStatus === "ASSIGNED"
                                ? "bg-[var(--slate-bg,rgba(100,116,139,.14))] text-[var(--t-muted)]"
                                : "bg-[var(--red-bg,rgba(185,28,28,.12))] text-[var(--red,#b91c1c)]"
                          }`}
                          title={l.assigneeNote ?? undefined}
                        >
                          {ASSIGN_CN[l.assigneeStatus] ?? l.assigneeStatus}
                        </span>
                      ) : null}
                      {l.assigneeLawyer ? <span className="text-[10.5px] text-[var(--t-muted)]">{l.assigneeLawyer.name}</span> : null}
                      {l.secondOwner ? <span className="text-[10.5px] text-[var(--t-muted)]">二次：{l.secondOwner.name}</span> : null}
                      {l.assigneeLawyerId && l.assigneeStatus === "ASSIGNED" ? (
                        <>
                          <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id}
                            onClick={() => startTransition(async () => {
                              try {
                                await respondLeadAssignment({ leadId: l.id, decision: "ACCEPTED" });
                                toast.success("已接单");
                                router.refresh();
                              } catch (err) {
                                toast.error("操作失败", { description: actionErrorMessage(err) });
                              }
                            })}>接单</Button>
                          <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id}
                            onClick={() => startTransition(async () => {
                              const reason = await promptDialog({
                                title: "拒接线索", description: "拒接理由会记入跟进时间线与审计。",
                                placeholder: "如：专业方向不符 / 当前排期已满", required: true, maxLength: 200
                              });
                              if (!reason) return;
                              try {
                                await respondLeadAssignment({ leadId: l.id, decision: "DECLINED", reason });
                                toast.success("已拒接，需重新派单");
                                router.refresh();
                              } catch (err) {
                                toast.error("操作失败", { description: actionErrorMessage(err) });
                              }
                            })}>拒接</Button>
                        </>
                      ) : null}
                      {/* 二次对接人（P1-3）：首次接待与后续跟进常是两个人，
                          换负责人会丢掉"谁最先接触"，故单独一人字段。 */}
                      <select
                        className="input h-6 max-w-[104px] text-[10.5px]"
                        value={l.secondOwnerId ?? ""}
                        disabled={isPending || busyId === l.id}
                        onChange={(e) => startTransition(async () => {
                          try {
                            await setLeadSecondOwner({ leadId: l.id, secondOwnerId: e.target.value });
                            toast.success(e.target.value ? "已设二次对接人" : "已清除二次对接人");
                            router.refresh();
                          } catch (err) {
                            toast.error("操作失败", { description: actionErrorMessage(err) });
                          }
                        })}
                        title="二次对接人"
                      >
                        <option value="">二次对接人…</option>
                        {lawyers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      {/* 2026-11-22 P0-3：约了没来要能单独记——「没约」和「约了没来」是两个问题 */}
                      {l.stage === "INVITED" && l.visitOutcome !== "ARRIVED" ? (
                        <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id} onClick={() => record(l, "NO_SHOW")}>未到店</Button>
                      ) : null}
                      {l.stage === "CONSULTED" ? (
                        <Button size="sm" disabled={isPending || busyId === l.id} onClick={() => convert(l)}>转收案</Button>
                      ) : null}
                      {l.stage !== "CONVERTED" && l.stage !== "LOST" ? (
                        <Button size="sm" variant="ghost" disabled={isPending || busyId === l.id} onClick={() => lose(l)}>流失</Button>
                      ) : null}
                      {l.stage === "LOST" && l.lostReason ? (
                        <span className="text-[10.5px] text-[var(--t-muted)]" title={l.lostReason}>{l.lostReason.slice(0, 12)}…</span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LeadTimelineDialog
        leadId={detailId}
        open={detailId !== null}
        onOpenChange={(v) => { if (!v) setDetailId(null); }}
      />
    </div>
  );
}
