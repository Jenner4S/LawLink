"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Download, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { getFirmFileVersionHistory } from "@/server/firm-files/actions";
import { formatDateTime } from "@/lib/utils";

type VersionNode = {
  id: string;
  name: string;
  createdAt: Date;
  uploadedBy: { name: string };
};

/**
 * 律所文书版本历史（2026-11-20）
 *
 * `getFirmFileVersionHistory` 一直存在但没有界面入口——列表上只能看到
 * 「v3」这样一个版本号，看不到 v1/v2 是谁传的、什么时候传的。
 * 文书被替代后旧版仍在库里（supersedes 链），但用户在界面上找不到。
 *
 * 沿 supersedes 链向旧版遍历，业务上单链。
 */
export function FirmFileHistoryDialog({
  open,
  onOpenChange,
  fileId,
  fileName
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  fileId: string | null;
  fileName?: string;
}) {
  const [chain, setChain] = useState<VersionNode[] | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open || !fileId) return;
    setChain(null);
    startTransition(async () => {
      try {
        const rows = await getFirmFileVersionHistory({ id: fileId });
        setChain(rows as VersionNode[]);
      } catch {
        setChain([]);
      }
    });
  }, [open, fileId]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <History className="h-4 w-4" />
            版本历史
          </DialogTitle>
          <DialogDescription className="text-xs">
            {fileName ? `「${fileName}」` : ""}新版替代旧版后，旧版仍保留在库中，可随时下载
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          {chain === null ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              读取中…
            </div>
          ) : chain.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">没有可显示的版本记录</p>
          ) : (
            <ol className="space-y-2">
              {chain.map((v, i) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-[var(--line)] px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <span className="rounded bg-[var(--slate-bg)] px-1.5 py-0.5 text-[10px] text-[var(--slate)]">
                        {i === 0 ? "当前版本" : `旧版 v${chain.length - i}`}
                      </span>
                      <span className="truncate" title={v.name}>{v.name}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {v.uploadedBy.name} · {formatDateTime(new Date(v.createdAt))}
                    </div>
                  </div>
                  <a
                    href={`/api/firm-files/${v.id}/download`}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-popover hover:text-primary"
                    title={i === 0 ? "下载当前版本" : "下载该旧版"}
                  >
                    <Download className="h-3.5 w-3.5" />
                  </a>
                </li>
              ))}
            </ol>
          )}
          {chain && chain.length > 1 ? (
            <p className="text-[11px] text-muted-foreground">
              共 {chain.length} 个版本。旧版仅供追溯，不作为现行有效文本。
            </p>
          ) : null}
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
