"use client";

/**
 * 「立即推送周报」（2026-11-21 补）。
 *
 * 为什么加：`triggerWeeklyReportNow`（`server/cron/manual-triggers.ts`）
 * 一直有 `requireAdmin()` 守卫、cron 也在自动跑，但**全仓无 UI 入口**——
 * 管理员想「配好 SMTP 后立刻验证一次」或「今天漏了补发一次」都没有按钮。
 * 2026-11-21 多智能体审计把它标为「疑似漏接线」，核到这里确认是缺入口。
 *
 * 复用 `ReminderScanButton` 的交互模式（useTransition + toast + router.refresh）。
 * 放在邮件通道卡片里而不放页头：它是邮件通路的动作，跟着上下文走更清楚。
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { triggerWeeklyReportNow } from "@/server/cron/manual-triggers";
import { actionErrorMessage } from "@/lib/action-error";

export function WeeklyPushButton({ disabled }: { disabled?: boolean }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handlePush() {
    startTransition(async () => {
      try {
        const r = await triggerWeeklyReportNow();
        router.refresh();
        if (r.failed.length === 0) {
          toast.success(`周报推送完成：${r.succeeded} 封`, {
            description: `周期 ${r.weekLabel}`
          });
        } else {
          // 部分失败不当作成功提示 —— 管理员需要知道有几个人没收到
          toast.warning(`周报推送部分失败：成功 ${r.succeeded}，失败 ${r.failed.length}`, {
            description: r.failed.map((f) => f.error).slice(0, 3).join("；")
          });
        }
      } catch (err) {
        toast.error("周报推送失败", { description: actionErrorMessage(err) });
      }
    });
  }

  return (
    <button
      type="button"
      onClick={handlePush}
      disabled={isPending || disabled}
      className="btn btn-secondary btn-sm shrink-0"
      title={disabled ? "SMTP 未配置，无法推送" : "立即向全所律师推送本期周报"}
    >
      {isPending ? <Loader2 className="animate-spin" /> : <Send />}
      立即推送周报
    </button>
  );
}
