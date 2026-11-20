import type { Metadata } from "next";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getPortalViewer } from "@/lib/portal/session";
import { PortalLoginForm } from "./_components/login-form";

export const metadata: Metadata = { title: "客户门户登录 — LawLink" };

/**
 * 门户登录页（2026-11-20，门户 S1）
 *
 * 与员工登录页**不共用任何组件**：外部客户看到的界面不该出现
 * 「通行密钥」「单点登录」「冲突预检」这类内部功能入口。
 */
export default async function PortalLoginPage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await getPortalViewer();
  if (viewer) redirect("/portal");

  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-sunken,rgba(0,0,0,.02))] px-4">
      <div className="w-full max-w-sm rounded-lg border border-[var(--line)] bg-[var(--surface,#fff)] p-6 shadow-sm">
        <div className="mb-5">
          <h1 className="text-lg font-semibold">客户门户</h1>
          <p className="mt-1 text-[12px] text-[var(--t-muted)]">
            查看你的案件进度、已分享的材料与账单。账号由经办律师邀请开通。
          </p>
        </div>

        <PortalLoginForm next={next} />

        <p className="mt-4 text-[11px] leading-relaxed text-[var(--t-muted)]">
          还没有账号？请联系你的经办律师开通，你会收到一封含邀请链接的邮件。
          <br />
          律师账号请走
          <Link href="/login" className="ml-1 underline">
            员工登录
          </Link>
          。
        </p>
      </div>
    </div>
  );
}
