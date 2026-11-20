import Link from "next/link";
import { Stamp, ArrowRight } from "lucide-react";
import type { SealType } from "@prisma/client";
import { listSealRequests, getSealStats } from "@/server/seals/actions";
import { requireSession } from "@/lib/auth/session";
import { PageHeader, EmptyState } from "@/components/patterns/moan";
import { matterHref } from "@/lib/matters/route";
import { formatDateTime } from "@/lib/utils";
import { SEAL_TYPE_CN } from "@/app/(app)/approvals/seals/_components/seal-types";

/**
 * 用章台账 · 2026-11-20
 *
 * `listSealRequests` 与 `getSealStats` 一直存在但**没有任何页面**：
 * 用印记录只能从审批工作台的待审列表里看，**审完就翻不到了**，
 * 也没法回答「这个月用了几次章、都是谁的案子、卡在哪个环节」。
 *
 * 本页取代 v0.8.1 留下的 `/seals → /approvals/seals` 308 重定向：
 * 旧链接仍然有用（落到台账而不是被弹走），待审处理仍走审批工作台，
 * 页头给出明确入口，不重复审批工作台的职责。
 *
 * 权限：`listSealRequests` 内部 `requireSession("approval")`，
 * 且逐行判定 canRead（本人申请 / 可审批 / 可盖章 / 已审批 / 已盖章）。
 * 本页不做任何前端过滤。
 */

const STATUS_LABEL: Record<string, string> = {
  PENDING: "待审批",
  APPROVED: "已通过 · 待盖章",
  STAMPED: "已盖章",
  REJECTED: "已驳回",
  CANCELLED: "已撤销"
};

const STATUS_CLS: Record<string, string> = {
  PENDING: "b-amber",
  APPROVED: "b-blue",
  STAMPED: "b-green",
  REJECTED: "b-outline-red",
  CANCELLED: "b-slate"
};

const SCOPES: { key: "mine" | "approval" | "all"; label: string }[] = [
  { key: "mine", label: "我的申请" },
  { key: "approval", label: "待我审批" },
  { key: "all", label: "全部" }
];

export default async function SealLedgerPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession("approval");
  const sp = await searchParams;
  const scopeRaw = typeof sp.scope === "string" ? sp.scope : "mine";
  const scope = (SCOPES.some((s) => s.key === scopeRaw) ? scopeRaw : "mine") as "mine" | "approval" | "all";
  const status = typeof sp.status === "string" && STATUS_LABEL[sp.status] ? sp.status : undefined;
  const sealType = typeof sp.sealType === "string" && SEAL_TYPE_CN[sp.sealType] ? (sp.sealType as SealType) : undefined;

  const [rows, stats] = await Promise.all([
    listSealRequests({ scope, ...(status ? { status: status as never } : {}), ...(sealType ? { sealType } : {}) }),
    getSealStats()
  ]);

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { scope, status, sealType, ...patch } as Record<string, string | undefined>;
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/seals?${p.toString()}`;
  };

  return (
    <div className="space-y-4">
      <PageHeader
        className="!mb-0"
        title="用章台账"
        sub={
          <>
            本月已用印 <b>{stats.monthStamped}</b> 次 · 待审批 <b>{stats.pendingApprovalCount}</b> · 待盖章{" "}
            <b>{stats.waitingStampCount}</b>
            <span className="text-[var(--t-muted)]">　（申请与审批在审批工作台办理）</span>
          </>
        }
        actions={
          <Link href="/approvals?type=SEAL_APPROVE&new=seal" className="btn btn-secondary btn-sm gap-1">
            <Stamp className="h-3.5 w-3.5" />
            发起用章申请
          </Link>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        {SCOPES.map((s) => (
          <Link
            key={s.key}
            href={qs({ scope: s.key })}
            className={scope === s.key ? "btn btn-secondary btn-sm" : "btn btn-ghost btn-sm"}
          >
            {s.label}
          </Link>
        ))}
        <span className="mx-1 h-4 w-px bg-[var(--bd-hair)]" />
        <Link href={qs({ status: undefined })} className={!status ? "btn btn-secondary btn-sm" : "btn btn-ghost btn-sm"}>
          全部状态
        </Link>
        {Object.entries(STATUS_LABEL).map(([k, label]) => (
          <Link key={k} href={qs({ status: k })} className={status === k ? "btn btn-secondary btn-sm" : "btn btn-ghost btn-sm"}>
            {label}
          </Link>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={qs({ sealType: undefined })}
          className={!sealType ? "btn btn-secondary btn-sm" : "btn btn-ghost btn-sm"}
        >
          全部印章
        </Link>
        {Object.entries(SEAL_TYPE_CN).map(([k, label]) => (
          <Link
            key={k}
            href={qs({ sealType: k })}
            className={sealType === k ? "btn btn-secondary btn-sm" : "btn btn-ghost btn-sm"}
          >
            {label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <EmptyState
            title={
              scope === "mine"
                ? "你还没有发起过用章申请"
                : scope === "approval"
                  ? "没有待你审批的用章申请"
                  : "没有符合条件的用章记录"
            }
            description={
              scope === "approval"
                ? "换到「全部」或「我的申请」可以查看历史用印记录；审批工作台里也能直接处理待审。"
                : "用章申请需要先上传待盖章文件，由审批人通过后再上传盖章件回填。点右上「发起用章申请」开始。"
            }
          />
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="mo-scroll-x">
            <table className="mo-table" style={{ minWidth: 1020 }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 20, width: 150 }}>编号</th>
                  <th style={{ width: 96 }}>印章</th>
                  <th>用章事由 / 文件</th>
                  <th style={{ width: 200 }}>案件</th>
                  <th style={{ width: 84 }}>申请人</th>
                  <th style={{ width: 110 }}>状态</th>
                  <th style={{ width: 118 }}>申请时间</th>
                  <th style={{ width: 118 }}>后续节点</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-spine="bronze">
                    <td style={{ paddingLeft: 20 }} className="font-mono text-[12px] font-semibold">
                      {r.code}
                    </td>
                    <td>
                      <span className="badge b-white" style={{ fontSize: 10 }}>
                        {SEAL_TYPE_CN[r.sealType] ?? r.sealType}
                      </span>
                    </td>
                    <td className="min-w-0">
                      <div className="truncate text-xs font-medium" title={r.purpose}>
                        {r.purposeLabel || r.purpose}
                      </div>
                      <div className="truncate text-[10px] text-[var(--t-muted)]" title={r.documentTitle}>
                        {r.documentTitle} · {r.pageCount} 页 · {r.copies} 份
                      </div>
                    </td>
                    <td className="min-w-0">
                      {r.matter ? (
                        <>
                          <Link
                            href={matterHref(r.matter)}
                            className="block truncate text-xs hover:text-[var(--teal-deep)]"
                            title={r.matter.title}
                          >
                            {r.matter.title}
                          </Link>
                          <div className="font-mono text-[10px] text-[var(--t-muted)]">
                            {r.matter.internalCode ?? "—"}
                          </div>
                        </>
                      ) : (
                        <span className="text-[11px] text-[var(--t-muted)]">未关联案件</span>
                      )}
                    </td>
                    <td className="truncate text-[11px]">{r.requestedBy.name}</td>
                    <td>
                      <span className={`badge ${STATUS_CLS[r.status] ?? "b-slate"}`} style={{ fontSize: 10 }}>
                        {STATUS_LABEL[r.status] ?? r.status}
                      </span>
                      {r.status === "REJECTED" && r.approveNote ? (
                        <div className="mt-0.5 truncate text-[10px] text-[var(--red)]" title={r.approveNote}>
                          {r.approveNote}
                        </div>
                      ) : null}
                    </td>
                    <td className="text-[11px] text-[var(--t-muted)]">{formatDateTime(r.requestedAt)}</td>
                    <td className="text-[11px] text-[var(--t-muted)]">
                      {r.status === "STAMPED" && r.stampedAt ? (
                        <>盖章 {formatDateTime(r.stampedAt)}</>
                      ) : r.status === "APPROVED" && r.approvedAt ? (
                        <>通过 {formatDateTime(r.approvedAt)}</>
                      ) : r.status === "PENDING" ? (
                        <Link href={`/approvals?type=SEAL_APPROVE&id=${r.id}`} className="text-[var(--teal-deep)] hover:underline">
                          去审批
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-[var(--bd-hair)] px-4 py-2 text-[11px] text-[var(--t-muted)]">
            共 {rows.length} 条（按待处理优先、申请时间倒序）。
            {scope !== "all" ? (
              <>
                {" "}
                想看全部历史请切到
                <Link href={qs({ scope: "all" })} className="ml-1 underline">
                  全部
                </Link>
                。
              </>
            ) : null}
          </div>
        </div>
      )}

      <div className="text-[11px] text-[var(--t-muted)]">
        只显示你有权查看的记录（本人申请、你审批过、你盖章过，或你当前可审批的）。
        审批动作在审批工作台完成，
        <Link href="/approvals?type=SEAL_APPROVE" className="ml-1 inline-flex items-center gap-0.5 underline">
          去审批工作台 <ArrowRight className="h-2.5 w-2.5" />
        </Link>
      </div>
    </div>
  );
}
