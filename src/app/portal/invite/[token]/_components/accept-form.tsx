"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { portalAcceptInviteAction } from "@/server/portal/page-actions";

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(portalAcceptInviteAction, null);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <div className="space-y-1.5">
        <Label htmlFor="portal-pw">设置密码</Label>
        <Input id="portal-pw" name="password" type="password" autoComplete="new-password" minLength={8} required />
        <p className="text-[11px] text-[var(--t-muted)]">至少 8 位</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="portal-pw2">再输一次</Label>
        <Input id="portal-pw2" name="confirm" type="password" autoComplete="new-password" minLength={8} required />
      </div>
      {state?.error ? (
        <p className="text-[12px] text-[var(--red)]" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="w-full gap-1" disabled={pending}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        设置并进入门户
      </Button>
    </form>
  );
}
