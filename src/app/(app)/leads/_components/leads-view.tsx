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
import { addLeadActivity, convertLeadToIntake, createLead, markLeadLost, type LeadRow } from "@/server/leads/actions";
import type { LeadFunnel } from "@/server/leads/analytics";

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
  owners
}: {
  leads: LeadRow[];
  funnel: LeadFunnel;
  /** 在途线索的负责人（含人数），用于按人筛选；口径与列表默认一致 */
  owners: { ownerId: string; ownerName: string; count: number }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", wechat: "", organization: "", source: "REFERRAL", sourceDetail: "" });

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
        const res = await createLead({ ...form, source: form.source as never });
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
        setForm({ name: "", phone: "", wechat: "", organization: "", source: "REFERRAL", sourceDetail: "" });
        router.refresh();
      } catch (err) {
        toast.error("登记失败", { description: actionErrorMessage(err) });
      }
    });
  };

  const record = (lead: LeadRow, type: "CONTACT" | "INVITE" | "VISIT" | "CONSULT") => {
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
            <div><Label className="text-[11px]">来源细节</Label><Input value={form.sourceDetail} onChange={(e) => setForm({ ...form, sourceDetail: e.target.value })} placeholder="谁介绍的 / 哪个平台" /></div>
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
                  <td><span className={`badge ${STAGE_CLS[l.stage] ?? "b-slate"}`} style={{ fontSize: 10 }}>{STAGE_CN[l.stage] ?? l.stage}</span></td>
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
