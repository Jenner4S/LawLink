"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, Loader2, Undo2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listPortalSharesForMatter, revokePortalShare } from "@/server/portal/share";
import { promptDialog } from "@/components/patterns/confirm-dialog";
import { actionErrorMessage } from "@/lib/action-error";
import { formatDateTime } from "@/lib/utils";

type ShareRow = {
  id: string;
  documentId: string | null;
  documentName: string | null;
  sharedAt: Date | string;
  revokedAt: Date | string | null;
  note: string | null;
  /** 材料已被软删：名字仍保留，但面板要标注出来 */
  documentDeleted?: boolean;
};

/**
 * 员工侧「客户可见」面板（2026-11-20，门户 S2 二期）
 *
 * 补的是上一轮留下的欠账：分享动作已经能用了，但**律师看不到自己分享过什么、
 * 也撤不回来**。对「披露给外部客户」这件事，没有清单和撤销入口是不合格的——
 * 分享出去的东西必须能收回来。
 *
 * 三条设计纪律：
 *   1. **默认只看生效中的**。已撤销的折起来：它们存在的意义是留痕备查，
 *      不是让律师每天扫一遍。
 *   2. **撤销必须填理由**。理由进审计——事后问「为什么把这份材料给客户又收回」
 *      时，答案在审计里而不是在谁的记忆里。
 *   3. **撤销后立即生效**。判定读 `revokedAt IS NULL` 且不缓存，客户下一次刷新就看不到，
 *      不等「重新登录」这类模糊条件。
 */
export function PortalSharePanel({
  open,
  onOpenChange,
  matterId
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  matterId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rows, setRows] = useState<ShareRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const reload = () => {
    startTransition(async () => {
      try {
        const list = await listPortalSharesForMatter(matterId);
        setRows(list as ShareRow[]);
      } catch {
        setRows([]);
      }
    });
  };

  useEffect(() => {
    if (!open) return;
    setRows(null);
    setShowRevoked(false);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matterId]);

  const active = (rows ?? []).filter((r) => !r.revokedAt);
  const revoked = (rows ?? []).filter((r) => r.revokedAt);

  const doRevoke = async (r: ShareRow) => {
    const reason = await promptDialog({
      title: `收回「${r.documentName ?? "该材料"}」的客户可见权限？`,
      description:
        "收回后客户立即看不到、也无法再下载这份材料。\n\n" +
        "请填写原因（会记入审计）：例如「误发，含内部批注」。这条记录本身不会被删除，\n" +
        "留下是为了将来能回答「什么时候撤的、为什么撤」。",
      label: "收回原因",
      placeholder: "如：含内部策略备忘，不应对外",
      confirmText: "收回",
      required: true,
      maxLength: 200
    });
    if (!reason) return;
    setBusyId(r.id);
    startTransition(async () => {
      try {
        await revokePortalShare({ shareId: r.id, reason });
        toast.success("已收回，客户刷新即可看到变化");
        router.refresh();
        reload();
      } catch (err) {
        toast.error("收回失败", { description: actionErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Eye className="h-4 w-4" />
            客户可见
          </DialogTitle>
          <DialogDescription className="text-xs">
            这里只有<b>你明确分享过</b>的材料。门户不支持按分类自动开放——
            客户看不到任何未经分享的内容。
          </DialogDescription>
        </DialogHeader>

        <FormDialogBody>
          {rows === null ? (
            <div className="flex items-center gap-2 py-6 text-xs text-[var(--t-muted)]">
              <Loader2 className="h-4 w-4 animate-spin" />
              读取…
            </div>
          ) : (
            <>
              {active.length === 0 ? (
                <div className="rounded-md border border-[var(--line)] px-3 py-4 text-center">
                  <p className="text-[12px] text-[var(--t-muted)]">
                    本案还没有材料分享给客户。在材料行点「分享给客户」即可。
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-[11px] font-medium text-[var(--t-muted)]">
                    客户现在能看到 {active.length} 份
                  </p>
                  {active.map((r) => (
                    <div key={r.id} className="flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2">
                      <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-[var(--green)]" />
                      <span className="min-w-0 flex-1 truncate text-xs" title={r.documentName ?? ""}>
                        {r.documentName ?? "（材料已删除）"}
                        {r.documentDeleted ? (
                          <span className="ml-1 text-[10px] text-[var(--amber)]">（材料已删除）</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--t-muted)]">{formatDateTime(r.sharedAt)}</span>
                      <button
                        type="button"
                        className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                        disabled={isPending || busyId === r.id}
                        onClick={() => doRevoke(r)}
                        title="收回客户可见权限"
                      >
                        {busyId === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {revoked.length > 0 ? (
                <div className="mt-2">
                  <button
                    type="button"
                    className="text-[11px] text-[var(--t-muted)] underline"
                    onClick={() => setShowRevoked((v) => !v)}
                  >
                    {showRevoked ? "收起" : "查看"}已收回的 {revoked.length} 条（留痕备查）
                  </button>
                  {showRevoked ? (
                    <div className="mt-1.5 space-y-1">
                      {revoked.map((r) => (
                        <div key={r.id} className="flex items-center gap-2 rounded-md border border-dashed border-[var(--line)] px-3 py-1.5 opacity-70">
                          <span className="min-w-0 flex-1 truncate text-[11.5px] line-through" title={r.documentName ?? ""}>
                            {r.documentName ?? "（材料已删除）"}
                          </span>
                          <span className="shrink-0 text-[10px] text-[var(--t-muted)]">
                            收回于 {formatDateTime(r.revokedAt!)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </FormDialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
