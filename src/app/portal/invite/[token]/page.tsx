import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getPortalViewer } from "@/lib/portal/session";
import { AcceptInviteForm } from "./_components/accept-form";

export const metadata: Metadata = { title: "设置门户密码 — LawLink" };

/**
 * 接受邀请页（2026-11-20，门户 S1）
 *
 * token 从路径取。页面本身**不校验 token 有效性**——校验发生在提交时
 * （`acceptPortalInvite` 走条件更新原子占位）。这样不为「猜 token」提供
 * 一个可以批量探测的接口：页面永远正常渲染，只有提交才失败。
 */
export default async function PortalInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const viewer = await getPortalViewer();
  if (viewer) redirect("/portal");

  const { token } = await params;

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken,rgba(0,0,0,.02))] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--surface,#fff)] p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="text-lg font-semibold">设置登录密码</h1>
          <p className="mt-1 text-[12px] text-[var(--t-muted)]">
            邀请链接 24 小时内有效、且只能使用一次。设置密码后即可登录查看案件进度。
          </p>
        </div>
        <AcceptInviteForm token={token} />
      </div>
    </div>
  );
}
