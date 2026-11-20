import Link from "next/link";
import { LogOut, FileText, Scale, Receipt, MessageSquare } from "lucide-react";
import { requirePortalViewer } from "@/lib/portal/session";
import { portalLogoutAction } from "@/server/portal/page-actions";

/**
 * 门户首页（2026-11-20，门户 S1）
 *
 * S1 只交付「身份与登录」，所以这里**只显示身份与退出**，
 * 不画任何 S2 的进度/材料/账单占位——画了就是假功能。
 */
export default async function PortalHomePage() {
  const viewer = await requirePortalViewer("/portal");

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">你好，{viewer.name}</h1>
          <p className="mt-1 text-[12.5px] text-[var(--t-muted)]">
            {viewer.clientName} · {viewer.email}
          </p>
        </div>
        <form action={portalLogoutAction}>
          <button type="submit" className="btn btn-ghost btn-sm gap-1">
            <LogOut className="h-3.5 w-3.5" />
            退出
          </button>
        </form>
      </div>

      <div className="mt-6">
        <Link href="/portal/cases" className="btn btn-secondary btn-sm gap-1">
          <Scale className="h-3.5 w-3.5" />
          案件进度
        </Link>
        <Link href="/portal/materials" className="btn btn-ghost btn-sm gap-1">
          <FileText className="h-3.5 w-3.5" />
          我的材料
        </Link>
        <Link href="/portal/bills" className="btn btn-ghost btn-sm gap-1">
          <Receipt className="h-3.5 w-3.5" />
          账单
        </Link>
        <Link href="/portal/requests" className="btn btn-ghost btn-sm gap-1">
          <MessageSquare className="h-3.5 w-3.5" />
          我的提问
        </Link>
      </div>

      <div className="mt-8 rounded-lg border border-[var(--line)] p-5">
        <h2 className="text-sm font-medium">目前可以做什么</h2>
        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--t-muted)]">
          你的账号已开通。「案件进度」「我的材料」「账单」均已可用；
          在此之前，如需材料或进展，请直接联系你的经办律师。
        </p>
        <p className="mt-3 text-[11px] text-[var(--t-muted)]">
          安全提示：本页只显示你自己的信息。若你在公共电脑上登录过，
          请点右上「退出」。忘记密码请联系经办律师重新发起邀请。
        </p>
      </div>

      <p className="mt-6 text-[11px] text-[var(--t-muted)]">
        律师账号请走
        <Link href="/login" className="ml-1 underline">
          员工登录
        </Link>
        。
      </p>
    </div>
  );
}
