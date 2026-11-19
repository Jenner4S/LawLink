"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@prisma/client";
import { toast } from "sonner";

import { MatterCombobox } from "@/app/(app)/approvals/seals/_components/matter-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { actionErrorMessage } from "@/lib/action-error";
import { createEthicalWall, type WallTargetOptions } from "@/server/ethical-walls/actions";
import type { DenyInput } from "@/server/ethical-walls/schemas";

import { DenialPicker, type PickedTarget } from "./denial-picker";

const MIN_REASON = 10;

function toDenialInput(target: PickedTarget): DenyInput {
  if (target.denyType === "USER") return { denyType: "USER", userId: target.id };
  if (target.denyType === "TEAM") return { denyType: "TEAM", teamId: target.id };
  return { denyType: "ROLE", role: target.id as UserRole };
}

export function WallCreateSheet({ targets, onClose }: { targets: WallTargetOptions; onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [matterId, setMatterId] = useState("");
  const [reason, setReason] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [picked, setPicked] = useState<PickedTarget[]>([]);
  const [error, setError] = useState("");

  const reasonLength = reason.trim().length;
  const ready = Boolean(matterId) && reasonLength >= MIN_REASON && picked.length > 0;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    startTransition(async () => {
      try {
        await createEthicalWall({
          matterId,
          reason,
          expiresAt: expiresAt || null,
          denials: picked.map(toDenialInput)
        });
        toast.success("隔离墙已建立", { description: "被隔离对象立即无法再打开该案件；本次操作已写入审计日志。" });
        router.refresh();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? actionErrorMessage(err) : "保存失败，请稍后重试");
      }
    });
  }

  return (
    <Sheet open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
      <SheetContent className="flex w-full flex-col sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>新建隔离墙</SheetTitle>
          <SheetDescription>
            隔离墙是执业合规措施，不是权限设置：对全所生效，被隔离的合伙人与管理员同样看不到该案件。如需恢复访问，必须在此页面解除并填写理由。
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <fieldset disabled={pending} className="min-h-0 flex-1 space-y-5 overflow-y-auto py-5">
            <div className="space-y-2">
              <Label>隔离的案件</Label>
              <MatterCombobox matters={targets.matters} value={matterId} onChange={setMatterId} />
              {targets.matters.length === 0 ? (
                <p className="text-xs text-muted-foreground">当前没有可选的案件。</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="wall-reason">隔离理由</Label>
              <Textarea
                id="wall-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={2000}
                rows={4}
                placeholder="写明隔离原因与涉及哪一方，例如：本所同时为对方公司提供常年法律顾问服务，客户经理团队不得接触本案卷宗。"
              />
              <p className="text-xs text-muted-foreground">
                {reasonLength < MIN_REASON ? `还差 ${MIN_REASON - reasonLength} 字（至少 ${MIN_REASON} 字）` : `${reasonLength} / 2000 字`}
                。理由会进入审计日志，事后据此自证合规。
              </p>
            </div>

            <div className="space-y-2">
              <Label>被隔离对象</Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                可同时隔离人员、团队与岗位；命中任一条即不可见该案件。团队按「当前活跃成员」判定，成员变动即时生效。
              </p>
              <DenialPicker targets={targets} value={picked} onChange={setPicked} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wall-expires">失效日期（可选）</Label>
              <Input
                id="wall-expires"
                type="date"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                className="w-48"
              />
              <p className="text-xs text-muted-foreground">留空表示长期生效，直到手动解除。所选日期当天结束前仍生效。</p>
            </div>

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </fieldset>
          <SheetFooter className="border-t pt-4">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={pending || !ready}>{pending ? "正在建立…" : "建立隔离墙"}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
