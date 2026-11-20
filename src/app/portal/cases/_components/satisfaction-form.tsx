"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Star, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { submitPortalSatisfaction } from "@/server/portal/requests";
import { actionErrorMessage } from "@/lib/action-error";

/**
 * 满意度评价（2026-11-21，S3）
 *
 * 三条产品约束：
 *   · **一案件一次**（服务端 @@unique 保证），提交后按钮消失
 *   · **可匿名**：匿名时服务端把 portalUserId 置空但保留 clientId——
 *     律所要知道是哪家客户，但不知道是哪个人，否则「给差评会被认出来」的顾虑没被消解
 *   · 只有已开放的案件可评价（拿 id 猜评不了）
 */
export function SatisfactionForm({ matterId }: { matterId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [score, setScore] = useState(0);
  const [comment, setComment] = useState("");
  const [anonymous, setAnonymous] = useState(false);

  const submit = () => {
    if (score < 1) {
      toast.error("请先选择评分");
      return;
    }
    startTransition(async () => {
      try {
        await submitPortalSatisfaction({
          matterId,
          score,
          comment: comment || "",
          anonymous
        });
        toast.success("感谢反馈");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error("提交失败", { description: actionErrorMessage(err) });
      }
    });
  };

  if (!open) {
    return (
      <button type="button" className="text-[11.5px] underline" onClick={() => setOpen(true)}>
        评价本次服务
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-md border border-[var(--line)] p-3">
      <p className="text-[11.5px] font-medium">对本次服务打分</p>
      <div className="mt-1.5 flex items-center gap-1">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setScore(n)}
            aria-label={`${n} 分`}
            aria-pressed={score === n}
            className="p-0.5"
          >
            <Star
              className="h-5 w-5"
              fill={n <= score ? "currentColor" : "none"}
              style={{ color: n <= score ? "var(--amber)" : "var(--t-muted)" }}
            />
          </button>
        ))}
        <span className="ml-1 text-[11px] text-[var(--t-muted)]">{score > 0 ? `${score} 分` : "未选择"}</span>
      </div>
      <Textarea
        className="mt-2"
        rows={2}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="可以留一句话（选填）"
        maxLength={500}
      />
      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--t-muted)]">
        <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
        匿名提交（律所仍知道是哪家客户，但不知道是哪个人）
      </label>
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={submit} disabled={isPending} className="gap-1">
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          提交评价
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
          取消
        </Button>
      </div>
    </div>
  );
}
