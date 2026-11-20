"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Phone, MapPin, MessagesSquare, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTopbarAction } from "@/components/layout/topbar-action";
import { promptDialog } from "@/components/patterns/confirm-dialog";
import { formatDateTime } from "@/lib/utils";
import { actionErrorMessage } from "@/lib/action-error";
import { addLeadActivity, convertLeadToIntake, createLead, markLeadLost, type LeadRow } from "@/server/leads/actions";

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

export function LeadsView({ leads }: { leads: LeadRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<Filter>("OPEN");
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", wechat: "", organization: "", source: "REFERRAL", sourceDetail: "" });

  useTopbarAction({ label: "新建线索", onClick: () => setCreating(true) }, []);

  const rows = useMemo(() => {
    if (filter === "ALL") return leads;
    if (filter === "OPEN") return leads.filter((l) => ["LEAD", "INVITED", "VISITED", "CONSULTED"].includes(l.stage));
    return leads.filter((l) => l.stage === filter);
  }, [leads, filter]);

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
        await createLead({ ...form, source: form.source as never });
        toast.success("线索已登记");
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

  return (
    <div className="mo-page">
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
        <span className="ml-auto text-[11px] text-[var(--t-muted)]">
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
                    <div className="text-[10.5px] text-[var(--t-muted)]">
                      {l.phone ?? l.wechat ?? "—"}{l.organization ? ` · ${l.organization}` : ""}
                    </div>
                  </td>
                  <td className="text-[11.5px]">
                    {SOURCE_CN[l.source] ?? l.source}
                    {l.sourceDetail ? <div className="text-[10px] text-[var(--t-muted)]">{l.sourceDetail}</div> : null}
                  </td>
                  <td><span className={`badge ${STAGE_CLS[l.stage] ?? "b-slate"}`} style={{ fontSize: 10 }}>{STAGE_CN[l.stage] ?? l.stage}</span></td>
                  <td className="text-[11px] text-[var(--t-muted)]">{l.activityCount} 次</td>
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
    </div>
  );
}
