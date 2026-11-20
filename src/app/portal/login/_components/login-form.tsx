"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { portalLoginAction } from "@/server/portal/page-actions";

/**
 * 门户登录表单（2026-11-20，门户 S1）
 *
 * 用 `useActionState` 而不是 toast：错误要**贴在表单里**，
 * 因为一旦失败整页只剩「邮箱或密码不正确」这一句，不应让客户去找浮层。
 */
export function PortalLoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(portalLoginAction, null);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <div className="space-y-1.5">
        <Label htmlFor="portal-email">邮箱</Label>
        <Input id="portal-email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-password">密码</Label>
        <Input id="portal-password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {state?.error ? (
        <p className="text-[12px] text-[var(--red)]" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="w-full gap-1" disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        登录
      </Button>
    </form>
  );
}
