import Link from "next/link";
import { ArrowRight, ShieldAlert } from "lucide-react";

import type { EthicalWallSummary } from "@/server/ethical-walls/read";

/**
 * 案件详情页的隔离墙合规提示条（页首，仅在该案有生效中的墙时渲染）。
 *
 * 为什么要有它：隔离墙只挡住「看」，挡不住「说」。能看案的律师不知道有墙，就会把材料
 * 转给被隔离的同事或在群里讨论——隔离形同虚设。被隔离者继续只看到 404（不泄露案件存在性），
 * 但有权限看案的人应当知道「发材料前要小心」。
 *
 * 三条展示纪律：
 *   1. **琥珀色，不用红色**。本案卷页的红色专属于「3 天内或已逾期的期限」（见信号条注释），
 *      隔离墙是合规状态不是逾期风险，占用红色会让真正的期限风险失去区分度。
 *   2. **不显示人数**。被隔离对象可能是团队或整个岗位，页面不为此多查三次成员数；
 *      写「N 项隔离对象」而不是把 3 条记录谎称成「3 人」。
 *   3. **管理入口只给能进后台的人**。普通律师看到提示条即可（知道要小心），
 *      看不到「查看详情」——后台墙列表本身还带「被他人的墙挡住则不可见」的口径，
 *      给了也点不出东西；系统管理员与合伙人（isSystemAdmin / isManager）才显示。
 */
export function EthicalWallBanner({
  summary,
  canOpenAdmin
}: {
  summary: EthicalWallSummary;
  canOpenAdmin: boolean;
}) {
  if (!summary.hasWall) return null;

  const firstReason = summary.reasons[0] ?? "";
  const extraReasons = Math.max(0, summary.reasons.length - 1);
  const targets = summary.deniedSummary.join("、");

  return (
    <div
      className="flex items-start gap-3 rounded-[10px] border border-[var(--amber-line)] bg-[var(--amber-bg)] px-4 py-3"
      role="note"
      aria-label="隔离墙提示"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--amber)]" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-[var(--amber)]">本案已设隔离墙</span>
          {summary.deniedSummary.length > 0 ? (
            <span className="text-xs text-[var(--amber)]">
              · 限制 {summary.deniedSummary.length} 项对象
            </span>
          ) : null}
          {summary.wallCount > 1 ? (
            <span className="text-[11px] text-[var(--amber)]">（{summary.wallCount} 堵生效中）</span>
          ) : null}
        </div>

        {firstReason ? (
          <div className="line-clamp-2 text-xs leading-relaxed text-[var(--t-secondary)]">
            {firstReason}
            {extraReasons > 0 ? `（另有 ${extraReasons} 条理由，见管理后台）` : ""}
          </div>
        ) : null}

        {targets ? (
          <div className="line-clamp-1 text-[11px] text-[var(--t-muted)]">受限对象：{targets}</div>
        ) : null}

        <div className="text-[11px] text-[var(--t-muted)]">
          转发本案材料、安排讨论前，请先确认对方不在隔离范围内。
        </div>
      </div>

      {canOpenAdmin ? (
        <Link
          href="/admin/ethical-walls"
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--amber-line)] bg-[var(--bg-card)] px-3 py-1.5 text-xs text-[var(--amber)] no-underline hover:bg-[var(--amber-bg)]"
        >
          查看详情
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
