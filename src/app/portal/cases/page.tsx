import Link from "next/link";
import { ArrowLeft, Scale, FileText } from "lucide-react";
import { requirePortalViewer } from "@/lib/portal/session";
import { listPortalMatterSummaries } from "@/server/portal/portal-reads";
import { formatDate } from "@/lib/utils";

/**
 * 门户「案件进度」（2026-11-20，门户 S2）
 *
 * 只显示：案号 / 案名 / 类别 / 状态 / **当前阶段名** / 受理日 / 结案日 / 主办律师。
 * **不显示进度百分比**——理由见 lib/portal/matter-summary.ts 顶部注释
 * （案件进度不是工作量，是法院排期；解释不了的数字就是自己埋的争议）。
 */
export default async function PortalCasesPage() {
  await requirePortalViewer("/portal/cases");
  const cases = await listPortalMatterSummaries();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">案件进度</h1>
          <p className="mt-1 text-[12px] text-[var(--t-muted)]">
            显示法院与双方确认的**事实状态**，不做进度估算——案件推进取决于法院排期，估出来的数字没有意义。
          </p>
        </div>
        <Link href="/portal" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </Link>
      </div>

      {cases.length === 0 ? (
        <div className="rounded-lg border border-[var(--line)] p-8 text-center">
          <Scale className="mx-auto h-6 w-6 text-[var(--t-muted)]" />
          <p className="mt-3 text-[12.5px] text-[var(--t-muted)]">
            目前没有向你开放进度的案件。如需了解，请联系你的经办律师。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => (
            <li key={c.matterId} className="rounded-lg border border-[var(--line)] p-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-[11px] text-[var(--t-muted)]">{c.internalCode}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium" title={c.title}>
                  {c.title}
                </span>
                <span className="badge b-white shrink-0">{c.categoryLabel}</span>
                <span className="badge b-slate shrink-0">{c.statusLabel}</span>
              </div>

              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">当前阶段</dt>
                  <dd>{c.stageName ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">阶段开始</dt>
                  <dd>{c.stageStartedAt ? formatDate(c.stageStartedAt) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">受理日</dt>
                  <dd>{c.acceptedAt ? formatDate(c.acceptedAt) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">结案日</dt>
                  <dd>{c.closedAt ? formatDate(c.closedAt) : "—"}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">主办律师</dt>
                  <dd>{c.leadLawyer ?? "—"}</dd>
                </div>
              </dl>

              <Link href="/portal/materials" className="mt-2.5 inline-flex items-center gap-1 text-[11.5px] underline">
                <FileText className="h-3 w-3" />
                查看我的材料
              </Link>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 text-[11px] leading-relaxed text-[var(--t-muted)]">
        页面只显示律师开放给你的案件信息。内部分析、办案记录与费用明细不在其中。
        对进展有疑问，直接联系主办律师最快。
      </p>
    </div>
  );
}
