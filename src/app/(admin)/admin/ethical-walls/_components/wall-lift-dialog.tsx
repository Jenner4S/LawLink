"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { actionErrorMessage } from "@/lib/action-error";
import { liftEthicalWall } from "@/server/ethical-walls/actions";

const MIN_REASON = 4;

export function WallLiftDialog({
  wallId,
  matterTitle,
  statusLabel,
  onClose
}: {
  wallId: string;
  matterTitle: string;
  statusLabel: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [liftReason, setLiftReason] = useState("");
  const [error, setError] = useState("");
  const ready = liftReason.trim().length >= MIN_REASON;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      try {
        await liftEthicalWall({ id: wallId, liftReason });
        toast.success("隔离墙已解除", { description: "被隔离对象重新按常规权限访问该案件；解除理由已写入审计日志。" });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? actionErrorMessage(err) : "解除失败，请稍后重试");
      }
    });
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>解除隔离墙</DialogTitle>
          <DialogDescription>
            案件「{matterTitle}」当前{statusLabel}。解除需填写理由，审计记录保留原隔离理由与本次解除理由两段，不可覆盖。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wall-lift-reason">解除理由</Label>
            <Textarea
              id="wall-lift-reason"
              value={liftReason}
              onChange={(event) => setLiftReason(event.target.value)}
              maxLength={500}
              rows={3}
              placeholder="例如：该客户已解除与对方的合作关系，隔离事由消失，经合伙会议确认解除。"
            />
            <p className="text-xs text-muted-foreground">
              {liftReason.trim().length < MIN_REASON ? `还差 ${MIN_REASON - liftReason.trim().length} 字（至少 ${MIN_REASON} 字）` : `${liftReason.trim().length} / 500 字`}
            </p>
          </div>
          {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>取消</Button>
            <Button type="submit" variant="destructive" disabled={pending || !ready}>{pending ? "正在解除…" : "确认解除"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
