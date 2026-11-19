/**
 * 公开确认页（无需登录）：/confirm/[token]
 *
 * 合规定位：本页只用于记录客户对合同内容的「阅知并确认」，**不是电子签名**，
 * 不能替代签字盖章。页面显著位置固定展示法条口径的声明（原文见
 * CONTRACT_CONFIRMATION_DISCLAIMER），title 与按钮文案一律用「确认 / 阅知」。
 *
 * 安全：
 *   - 只按 token 哈希查库，不返回 clientId / matterId 等内部标识；
 *   - 同一 IP 每 60 秒最多 20 次访问（与确认接口共用配额），降低 token 枚举速率；
 *   - 展示前复核 contentHash：快照被改过就拒绝展示。
 */
import type { Metadata } from "next";
import { headers } from "next/headers";
import { formatDateTime } from "@/lib/utils";
import {
  CONTRACT_CONFIRMATION_DISCLAIMER,
  checkPublicRateLimit,
  extractClientIp,
  loadPublicConfirmation
} from "@/server/contracts/service";
import { ConfirmForm } from "./_components/confirm-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "合同内容阅知确认 — LawLink",
  description: "记录您对合同内容的阅知与确认；本页不构成电子签名，不能替代签字或盖章。",
  robots: { index: false, follow: false }
};

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <header className="mb-6 border-b border-border pb-4">
        <p className="text-xs tracking-wide text-muted-foreground">LawLink · 合同内容留痕</p>
        <h1 className="mt-1 text-xl font-semibold text-foreground">{title}</h1>
      </header>
      {children}
      <footer className="mt-10 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
        本页面由律所案件管理系统生成，仅用于记录阅知与确认过程，不构成任何一方对合同条款的变更。
      </footer>
    </main>
  );
}

/** 声明区：原文固定，任何改动都要同步改测试与合规说明。 */
function Disclaimer() {
  return (
    <section
      role="note"
      data-testid="contract-confirmation-disclaimer"
      className="mb-5 rounded-md border border-[#D8C79A] bg-[#FBF6E9] px-4 py-3 text-[13px] leading-relaxed text-[#6B5218]"
    >
      {CONTRACT_CONFIRMATION_DISCLAIMER}
    </section>
  );
}

function StatusNote({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-4 py-5 text-sm leading-relaxed">
      <p className="font-medium text-foreground">{title}</p>
      <p className="mt-1 text-muted-foreground">{detail}</p>
    </div>
  );
}

export default async function ContractConfirmPage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const requestHeaders = await headers();
  const ip = extractClientIp(requestHeaders);
  if (!checkPublicRateLimit(ip)) {
    return (
      <Shell title="访问过于频繁">
        <StatusNote title="请稍后再试" detail="该链接的访问次数过多，已暂时限制。请在一分钟后重试。" />
      </Shell>
    );
  }

  const view = await loadPublicConfirmation(token);

  if (view.kind === "invalid") {
    return (
      <Shell title="链接无效或已失效">
        <StatusNote
          title="无法打开该确认链接"
          detail="链接可能不完整、已被替换或从未签发。请联系您的律师重新发送确认链接。"
        />
      </Shell>
    );
  }

  if (view.kind === "expired") {
    return (
      <Shell title="链接已过期">
        <StatusNote
          title={`该链接已于 ${formatDateTime(view.expiresAt)} 过期`}
          detail="为保护合同信息安全，过期链接不能再次打开。请联系您的律师重新发送。"
        />
      </Shell>
    );
  }

  if (view.kind === "revoked") {
    return (
      <Shell title="该确认已被撤回">
        <StatusNote
          title="本次确认请求已由律所撤回"
          detail="如您仍收到过该链接，请以律师最新发送的内容为准；有疑问请直接联系承办律师。"
        />
      </Shell>
    );
  }

  if (view.kind === "tampered") {
    return (
      <Shell title="内容校验未通过">
        <StatusNote
          title="正文与签发时不一致"
          detail="系统检测到该链接对应的正文已被改动，已停止展示。请联系您的律师重新发送确认链接。"
        />
      </Shell>
    );
  }

  if (view.kind === "confirmed") {
    return (
      <Shell title="您已完成确认">
        <Disclaimer />
        <StatusNote
          title={`确认时间：${formatDateTime(view.confirmedAt)}`}
          detail={
            view.confirmerName
              ? `确认人：${view.confirmerName}。该记录已固定，不能重复提交。`
              : "该记录已固定，不能重复提交。如需更正，请联系您的律师另行处理。"
          }
        />
      </Shell>
    );
  }

  return (
    <Shell title="合同内容阅知确认">
      <Disclaimer />
      <p className="mb-3 text-sm text-muted-foreground">
        请完整阅读以下合同正文。点击「我已阅读并确认」后，系统将记录确认时间、访问 IP 与浏览器信息，作为您已阅知的留痕。链接有效期至 {formatDateTime(view.expiresAt)}。
      </p>
      <article
        data-testid="contract-confirmation-content"
        className="mb-6 max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-4 py-4 text-[13.5px] leading-relaxed text-foreground"
      >
        {view.content}
      </article>
      <ConfirmForm token={token} />
    </Shell>
  );
}
