import Link from "next/link";
import { Download, FileText, Search } from "lucide-react";
import type { DocumentCategory } from "@prisma/client";
import { listAllDocuments } from "@/server/documents/actions";
import { requireSession } from "@/lib/auth/session";
import { PageHeader, EmptyState } from "@/components/patterns/moan";
import { matterHref } from "@/lib/matters/route";
import { formatDate } from "@/lib/utils";

/**
 * 案件材料（跨案件全局检索）· 2026-11-20
 *
 * `listAllDocuments` 一直存在但零引用：**想找一份文件，只能一个个案件点进去翻**。
 * 律所里「上次那份保证合同在哪」是每天都会发生的问题。
 *
 * 可见性由服务端决定（`listAllDocuments` 内部走 matterVisibilityFilter /
 * matterAssociationFilter + 隔离墙），本页**不做任何前端过滤**——
 * 前端过滤等于把不该看的先取回来再藏起来，那是泄露。
 *
 * 筛选走原生 GET 表单，不引客户端状态：结果是可分享、可收藏的 URL。
 */

const CATEGORY_LABEL: Record<DocumentCategory, string> = {
  EVIDENCE: "证据",
  PLEADING: "诉辩文件",
  PROCEDURE: "程序文件",
  JUDGMENT: "裁决",
  CONTRACT: "合同",
  OTHER: "其他"
};

const CATEGORY_ORDER: DocumentCategory[] = ["EVIDENCE", "PLEADING", "PROCEDURE", "JUDGMENT", "CONTRACT", "OTHER"];

function formatBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export default async function DocumentsPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession("documents.read");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim() : "";
  const categoryRaw = typeof sp.category === "string" ? sp.category : "";
  const category = CATEGORY_ORDER.includes(categoryRaw as DocumentCategory)
    ? (categoryRaw as DocumentCategory)
    : undefined;

  const docs = await listAllDocuments({
    ...(q ? { search: q } : {}),
    ...(category ? { category } : {}),
    limit: 200
  });

  return (
    <div className="space-y-4">
      <PageHeader
        className="!mb-0"
        title="案件材料"
        sub={
          <>
            跨案件检索材料 · 共 <b>{docs.length}</b> 份
            {q || category ? " · 已按条件筛选" : ""} · 只显示你有权查看的案件
            <span className="text-[var(--t-muted)]">
              　（<b>不含收案阶段材料</b>：尚未转为正式案件的材料挂在收案上，请到
              <Link href="/matters?tab=intake" className="underline">收案中</Link>查看）
            </span>
          </>
        }
      />

      <div className="card" style={{ overflow: "hidden" }}>
        <div className="panel-body" style={{ paddingTop: 10 }}>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="doc-q" className="mb-1 block text-[11px] text-[var(--t-muted)]">
                材料名称或标签
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--t-muted)]" />
                <input
                  id="doc-q"
                  name="q"
                  defaultValue={q}
                  placeholder="如：保证合同、判决、发票"
                  className="h-9 w-full rounded-md border border-[var(--line)] bg-transparent pl-7 pr-2 text-sm"
                />
              </div>
            </div>
            <div style={{ width: 140 }}>
              <label htmlFor="doc-cat" className="mb-1 block text-[11px] text-[var(--t-muted)]">
                分类
              </label>
              <select
                id="doc-cat"
                name="category"
                defaultValue={category ?? ""}
                className="h-9 w-full rounded-md border border-[var(--line)] bg-transparent px-2 text-sm"
              >
                <option value="">全部分类</option>
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn btn-secondary btn-sm h-9">
              检索
            </button>
            {q || category ? (
              <Link href="/documents" className="btn btn-ghost btn-sm h-9">
                清除
              </Link>
            ) : null}
          </form>
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="card">
          <EmptyState
            title={q || category ? "没有符合条件的材料" : "还没有挂在案件上的材料"}
            description={
              q || category
                ? "换个关键词或分类再试；也可能这份材料在你还无权查看的案件里。本页只收已转为正式案件的材料。"
                : "材料在案件详情的「办案进程 → 材料」里上传，上传后这里会自动汇总。若你刚上传过却在这是空的，多半是材料还挂在收案上——收案阶段材料不在本页。"
            }
          />
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden" }}>
          <div className="mo-scroll-x">
            <table className="mo-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={{ paddingLeft: 20 }}>材料</th>
                  <th style={{ width: 240 }}>所属案件</th>
                  <th style={{ width: 88 }}>分类</th>
                  <th style={{ width: 76 }}>大小</th>
                  <th style={{ width: 90 }}>上传人</th>
                  <th style={{ width: 96 }}>上传时间</th>
                  <th style={{ width: 64 }}>下载</th>
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id} data-spine="slate">
                    <td style={{ paddingLeft: 20 }} className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-[var(--t-muted)]" />
                        <span className="truncate font-medium" title={d.name}>
                          {d.name}
                        </span>
                        {d.version && d.version > 1 ? (
                          <span className="shrink-0 rounded border border-[var(--line)] px-1 text-[9px] text-[var(--t-muted)]">
                            v{d.version}
                          </span>
                        ) : null}
                      </div>
                      {d.tags.length ? (
                        <div className="mt-0.5 truncate text-[10px] text-[var(--t-muted)]">标签：{d.tags.join("、")}</div>
                      ) : null}
                    </td>
                    <td className="min-w-0">
                      {/* matter 可为 null：收案阶段的材料挂在 Intake 上，尚未转正式案件 */}
                      {d.matter ? (
                        <>
                          <Link
                            href={matterHref(d.matter)}
                            className="block truncate text-xs hover:text-[var(--teal-deep)]"
                            title={d.matter.title}
                          >
                            {d.matter.title}
                          </Link>
                          <div className="font-mono text-[10px] text-[var(--t-muted)]">
                            {d.matter.internalCode ?? "—"}
                          </div>
                        </>
                      ) : (
                        <span className="text-[11px] text-[var(--t-muted)]">未挂案件（收案阶段）</span>
                      )}
                    </td>
                    <td>
                      <span className="badge b-white" style={{ fontSize: 10 }}>
                        {CATEGORY_LABEL[d.category]}
                      </span>
                    </td>
                    <td className="text-[11px] text-[var(--t-muted)]">{formatBytes(d.size)}</td>
                    <td className="truncate text-[11px]">{d.uploadedBy.name}</td>
                    <td className="text-[11px] text-[var(--t-muted)]">{formatDate(d.createdAt)}</td>
                    <td>
                      <a
                        href={`/api/documents/${d.id}/download`}
                        className="inline-flex items-center gap-1 text-[11px] text-[var(--teal-deep)] hover:underline"
                        title="下载"
                      >
                        <Download className="h-3 w-3" />
                        下载
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {docs.length >= 200 ? (
            <div className="border-t border-[var(--line)] px-4 py-2 text-[11px] text-[var(--t-muted)]">
              已显示最近 200 份。用上面的检索条件缩小范围可以找到更早的材料。
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
