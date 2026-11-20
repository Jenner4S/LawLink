"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare, Loader2, Clock, CheckCircle2 } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { listPortalRequestsForStaff, answerPortalRequest } from "@/server/portal/requests";
import { actionErrorMessage } from "@/lib/action-error";
import { formatDateTime } from "@/lib/utils";

type Row = {
  id: string;
  subject: string;
  body: string;
  status: "OPEN" | "ANSWERED" | "CLOSED";
  createdAt: Date | string;
  dueAt: Date | string | null;
  answeredAt: Date | string | null;
  answerBody: string | null;
  overdue: boolean;
  portalUser: { name: string; email: string; isPrimary: boolean };
};

const STATUS_CN: Record<string, string> = { OPEN: "待回复", ANSWERED: "已回复", CLOSED: "已关闭" };

/**
 * 员工侧「客户提问」面板（2026-11-21，S3）
 *
 * 放在客户详情页而不是新开导航：工单是「这家客户的事」，
 * 处理它的人本来就在这个页面看客户。
 *
 * 超期标红（S3 验收判据）：OPEN 且过了 dueAt 的工单在标题旁标红，
 * 而不是只按创建时间排序——按时间排的列表里，超期三天和刚提交的看起来一样。
 */
export function PortalRequestsPanel({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    startTransition(async () => {
      try {
        const list = await listPortalRequestsForStaff(clientId);
        setRows(list as Row[]);
      } catch {
        setRows([]);
      }
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const submit = (r: Row, closeIt: boolean) => {
    const answer = (drafts[r.id] ?? "").trim();
    if (!answer) {
      toast.error("请填写回复内容");
      return;
    }
    setBusyId(r.id);
    startTransition(async () => {
      try {
        await answerPortalRequest({ requestId: r.id, answer, closeIt });
        toast.success(closeIt ? "已回复并关闭" : "已回复");
        setDrafts((d) => ({ ...d, [r.id]: "" }));
        router.refresh();
        load();
      } catch (err) {
        toast.error("回复失败", { description: actionErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    });
  };

  const pending = (rows ?? []).filter((r) => r.status === "OPEN");

  return (
    <div className="card">
      <div className="panel-head">
        <div className="panel-title">
          <MessageSquare className="ic" strokeWidth={1.8} />
          客户提问
        </div>
        {pending.length > 0 ? (
          <span className="badge b-amber" style={{ fontSize: 10 }}>{pending.length} 条待回复</span>
        ) : null}
      </div>

      <div className="space-y-2 px-4 pb-4">
        {rows === null ? (
          <p className="flex items-center gap-2 py-3 text-[12px] text-[var(--t-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            读取…
          </p>
        ) : rows.length === 0 ? (
          <p className="py-3 text-[12px] text-[var(--t-muted)]">
            该客户还没有在门户里提问。开通门户后，客户的提问会出现在这里。
          </p>
        ) : (
          rows.map((r) => (
            <div key={r.id} className="rounded-md border border-[var(--line)] p-3">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={r.subject}>
                  {r.subject}
                </span>
                {r.overdue ? (
                  <span className="badge b-amber shrink-0 gap-0.5" style={{ fontSize: 10 }}>
                    <Clock className="h-2.5 w-2.5" />
                    已超期
                  </span>
                ) : null}
                <span className={`badge shrink-0 ${r.status === "OPEN" ? "b-amber" : r.status === "ANSWERED" ? "b-green" : "b-slate"}`} style={{ fontSize: 10 }}>
                  {STATUS_CN[r.status] ?? r.status}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed">{r.body}</p>
              <p className="mt-1 text-[10.5px] text-[var(--t-muted)]">
                {r.portalUser.name}（{r.portalUser.isPrimary ? "主账号" : "协作者"}） · {formatDateTime(r.createdAt)}
                {r.dueAt ? ` · 应于 ${formatDateTime(r.dueAt)} 前回复` : ""}
              </p>

              {r.answerBody ? (
                <div className="mt-2 rounded border-l-2 border-[var(--green)] bg-[var(--surface-sunken,rgba(0,0,0,.02))] px-2.5 py-1.5">
                  <p className="text-[10.5px] text-[var(--t-muted)]">
                    <CheckCircle2 className="mr-0.5 inline h-2.5 w-2.5" />
                    已回复{r.answeredAt ? ` · ${formatDateTime(r.answeredAt)}` : ""}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12px] leading-relaxed">{r.answerBody}</p>
                </div>
              ) : null}

              {r.status !== "CLOSED" ? (
                <div className="mt-2 space-y-1.5">
                  <Textarea
                    value={drafts[r.id] ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    rows={2}
                    placeholder={r.answerBody ? "补充回复…" : "回复客户…"}
                    maxLength={2000}
                  />
                  <div className="flex gap-1.5">
                    <Button size="sm" disabled={isPending || busyId === r.id} onClick={() => submit(r, false)} className="gap-1">
                      {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      回复
                    </Button>
                    <Button size="sm" variant="ghost" disabled={isPending || busyId === r.id} onClick={() => submit(r, true)}>
                      回复并关闭
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
