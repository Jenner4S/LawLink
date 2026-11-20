import Link from "next/link";
import { ArrowLeft, MessageSquare, Loader2 } from "lucide-react";
import { requirePortalViewer } from "@/lib/portal/session";
import { listMyPortalRequests } from "@/server/portal/requests";
import { formatDateTime } from "@/lib/utils";
import { PortalRequestForm } from "./_components/request-form";

export const metadata = { title: "我的提问 — LawLink" };

const STATUS_CN: Record<string, string> = { OPEN: "待回复", ANSWERED: "已回复", CLOSED: "已关闭" };
const STATUS_CLS: Record<string, string> = { OPEN: "b-amber", ANSWERED: "b-green", CLOSED: "b-slate" };

/**
 * 门户「我的提问」（2026-11-21，S3）
 *
 * 协作者能否看到彼此的工单由账号的 visibility 决定（Q3 第二档）；
 * 主账号永远看到该客户全部工单。**永远不跨客户**。
 */
export default async function PortalRequestsPage() {
  await requirePortalViewer("/portal/requests");
  const rows = await listMyPortalRequests();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">我的提问</h1>
          <p className="mt-1 text-[12px] text-[var(--t-muted)]">
            向经办律师提问或反馈。律所通常会在 2 个工作日内回复。
          </p>
        </div>
        <Link href="/portal" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </Link>
      </div>

      <PortalRequestForm />

      {rows.length === 0 ? (
        <div className="mt-4 rounded-lg border border-[var(--line)] p-8 text-center">
          <MessageSquare className="mx-auto h-6 w-6 text-[var(--t-muted)]" />
          <p className="mt-3 text-[12.5px] text-[var(--t-muted)]">还没有提问记录。</p>
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-[var(--line)] p-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={r.subject}>
                  {r.subject}
                </span>
                <span className={`badge ${STATUS_CLS[r.status] ?? "b-slate"} shrink-0`} style={{ fontSize: 10 }}>
                  {STATUS_CN[r.status] ?? r.status}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed">{r.body}</p>
              <p className="mt-1 text-[10.5px] text-[var(--t-muted)]">提交于 {formatDateTime(r.createdAt)}</p>

              {r.answerBody ? (
                <div className="mt-2.5 rounded-md border-l-2 border-[var(--green)] bg-[var(--surface-sunken,rgba(0,0,0,.02))] px-3 py-2">
                  <p className="text-[10.5px] font-medium text-[var(--t-muted)]">
                    律所回复{r.answeredAt ? ` · ${formatDateTime(r.answeredAt)}` : ""}
                  </p>
                  <p className="mt-0.5 whitespace-pre-wrap text-[12.5px] leading-relaxed">{r.answerBody}</p>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-[var(--t-muted)]">
                  <Loader2 className="mr-1 inline h-3 w-3" />
                  等待律所回复
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
