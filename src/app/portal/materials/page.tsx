import Link from "next/link";
import { ArrowLeft, FileText, Download } from "lucide-react";
import { requirePortalViewer } from "@/lib/portal/session";
import { prisma } from "@/lib/prisma";
import { formatDateTime } from "@/lib/utils";

/**
 * 门户「我的材料」（2026-11-20，门户 S2）
 *
 * 数据来源只有一条：**该客户名下未撤销的 DOCUMENT 分享**。
 * 没有「按分类自动可见」的规则——不存在这样的代码路径。
 */
export default async function PortalMaterialsPage() {
  const viewer = await requirePortalViewer("/portal/materials");

  const shares = await prisma.portalShare.findMany({
    where: { clientId: viewer.clientId, shareType: "DOCUMENT", revokedAt: null },
    orderBy: { sharedAt: "desc" },
    select: { id: true, documentId: true, sharedAt: true, matterId: true }
  });

  const docIds = shares.map((s) => s.documentId).filter((d): d is string => Boolean(d));
  const matterIds = [...new Set(shares.map((s) => s.matterId).filter((m): m is string => Boolean(m)))];

  const [docs, matters] = await Promise.all([
    docIds.length
      ? prisma.document.findMany({
          where: { id: { in: docIds }, deletedAt: null },
          select: { id: true, name: true, size: true, createdAt: true }
        })
      : [],
    matterIds.length
      ? prisma.matter.findMany({ where: { id: { in: matterIds } }, select: { id: true, title: true } })
      : []
  ]);

  const docOf = new Map(docs.map((d) => [d.id, d]));
  const matterOf = new Map(matters.map((m) => [m.id, m.title]));

  // 材料可能已被员工删除：那类分享不展示（客户看不到已删除的东西）
  const rows = shares
    .map((s) => ({ share: s, doc: s.documentId ? docOf.get(s.documentId) : undefined }))
    .filter((r): r is { share: typeof shares[number]; doc: NonNullable<typeof docs[number]> } => Boolean(r.doc));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">我的材料</h1>
          <p className="mt-1 text-[12px] text-[var(--t-muted)]">
            由经办律师分享给你的文件。新增材料需要律师在案件里点「分享」。
          </p>
        </div>
        <Link href="/portal" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-[var(--line)] p-8 text-center">
          <FileText className="mx-auto h-6 w-6 text-[var(--t-muted)]" />
          <p className="mt-3 text-[12.5px] text-[var(--t-muted)]">
            目前还没有分享给你的材料。如需某份文件，请联系你的经办律师。
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--line)] rounded-lg border border-[var(--line)]">
          {rows.map(({ share, doc }) => (
            <li key={share.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <FileText className="h-4 w-4 shrink-0 text-[var(--t-muted)]" />
              <span className="min-w-0 flex-1 truncate text-[13px]" title={doc.name}>
                {doc.name}
              </span>
              {share.matterId && matterOf.get(share.matterId) ? (
                <span className="shrink-0 text-[11px] text-[var(--t-muted)]" title={matterOf.get(share.matterId)}>
                  {matterOf.get(share.matterId)}
                </span>
              ) : null}
              <span className="shrink-0 text-[11px] text-[var(--t-muted)]">{formatDateTime(share.sharedAt)}</span>
              <a
                href={`/api/portal/documents/${doc.id}/download`}
                className="btn btn-ghost btn-sm shrink-0 gap-1"
                download
              >
                <Download className="h-3.5 w-3.5" />
                下载
              </a>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-5 text-[11px] leading-relaxed text-[var(--t-muted)]">
        只显示律师明确分享给你的材料。案件内部批注、策略备忘等不会出现在这里。
        若你认为某份材料不该给你看，请及时告知经办律师。
      </p>
    </div>
  );
}
