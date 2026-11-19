"use client";

/**
 * 公开确认表单。
 *
 * 文案纪律：按钮与标题不出现「签署 / 签名 / 签订」，统一用「确认 / 阅知」。
 */
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { ConfirmFormState } from "@/server/contracts/service";
import { confirmContractFormAction } from "@/server/contracts/public-actions";

const INITIAL: ConfirmFormState = { ok: false, message: "" };

export function ConfirmForm({ token }: { token: string }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(confirmContractFormAction, INITIAL);

  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, router]);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-1.5">
        <label htmlFor="confirmer-name" className="block text-sm font-medium text-foreground">
          您的姓名（可不填）
        </label>
        <input
          id="confirmer-name"
          name="name"
          type="text"
          maxLength={60}
          autoComplete="name"
          placeholder="用于佐证本次确认由谁操作"
          className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary"
        />
      </div>
      <button
        type="submit"
        disabled={pending || state.ok}
        className="h-11 w-full rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60"
      >
        {pending ? "正在提交…" : state.ok ? "已完成确认" : "我已阅读并确认"}
      </button>
      {state.message ? (
        <p
          role="status"
          aria-live="polite"
          className={`text-sm ${state.ok ? "text-[var(--teal-deep,#005054)]" : "text-destructive"}`}
        >
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
