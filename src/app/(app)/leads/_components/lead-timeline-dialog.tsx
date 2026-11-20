"use client";

/**
 * 线索详情与跟进时间线（2026-11-21）
 *
 * 列表只显示「跟进 N 次」，点不开看历史。而时间线数据一直存在 `LeadActivity` 里——
 * 这是典型的「数据有了但用不到」：跟进记录的价值在「上次谈了什么」，不在「谈了几次」。
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime } from "@/lib/utils";
import { actionErrorMessage } from "@/lib/action-error";
import { listLeadTimeline, type LeadTimeline } from "@/server/leads/actions";

const TYPE_CN: Record<string, string> = {
  CONTACT: "联系", INVITE: "邀约", VISIT: "到店", CONSULT: "谈案", NOTE: "备注"
};
const STAGE_CN: Record<string, string> = {
  LEAD: "线索", INVITED: "已邀约", VISITED: "已到店",
  CONSULTED: "已谈案", CONVERTED: "已转收案", LOST: "流失"
};

export function LeadTimelineDialog({
  leadId,
  open,
  onOpenChange
}: {
  leadId: string | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [data, setData] = useState<LeadTimeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !leadId) return;
    let alive = true;
    setLoading(true);
    setError(null);
    listLeadTimeline(leadId)
      .then((res) => { if (alive) setData(res); })
      .catch((err) => { if (alive) setError(actionErrorMessage(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, leadId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{data ? `${data.lead.name} · 跟进时间线` : "跟进时间线"}</DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-[12px] text-[var(--t-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取中…
          </div>
        ) : error ? (
          <div className="py-6 text-[12px] text-[var(--red)]">{error}</div>
        ) : data ? (
          <div className="max-h-[60vh] overflow-y-auto">
            <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[11.5px]">
              <div><span className="text-[var(--t-muted)]">阶段：</span>{STAGE_CN[data.lead.stage] ?? data.lead.stage}</div>
              <div><span className="text-[var(--t-muted)]">跟进人：</span>{data.lead.owner.name}</div>
              <div><span className="text-[var(--t-muted)]">联系方式：</span>{data.lead.phone ?? data.lead.wechat ?? "—"}</div>
              <div><span className="text-[var(--t-muted)]">登记时间：</span>{formatDateTime(data.lead.createdAt)}</div>
              {data.lead.invitedAt ? <div><span className="text-[var(--t-muted)]">约定到店：</span>{formatDateTime(data.lead.invitedAt)}</div> : null}
              {data.lead.consultedAt ? <div><span className="text-[var(--t-muted)]">谈案完成：</span>{formatDateTime(data.lead.consultedAt)}</div> : null}
              {data.lead.lostReason ? <div className="col-span-2"><span className="text-[var(--t-muted)]">流失原因：</span>{data.lead.lostReason}</div> : null}
              {data.lead.convertedIntakeId ? (
                <div className="col-span-2">
                  <span className="text-[var(--t-muted)]">已转收案：</span>
                  <span className="font-mono">{data.lead.convertedIntakeId.slice(0, 8)}…</span>
                  <span className="ml-1 text-[var(--t-muted)]">{formatDateTime(data.lead.convertedAt)}</span>
                </div>
              ) : null}
            </div>

            {data.activities.length === 0 ? (
              <div className="rounded border border-[var(--line)] px-3 py-4 text-center text-[11.5px] text-[var(--t-muted)]">
                还没有跟进记录。用列表里的「联系 / 邀约 / 到店 / 谈案完成」按钮记一笔。
              </div>
            ) : (
              <ol className="space-y-2">
                {data.activities.map((a) => (
                  <li key={a.id} className="flex gap-2 rounded border border-[var(--line)] px-3 py-2">
                    <span className="w-12 shrink-0 text-[10.5px] font-medium text-[var(--teal-deep,#0f766e)]">
                      {TYPE_CN[a.type] ?? a.type}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-[var(--t-muted)]">
                        {formatDateTime(a.happenedAt)} · {a.createdBy.name}
                        {a.channel ? ` · ${a.channel}` : ""}
                      </div>
                      {a.note ? <div className="mt-0.5 whitespace-pre-wrap text-[11.5px]">{a.note}</div> : null}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
