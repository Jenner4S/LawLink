"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, FolderArchive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listFoldersByMatter, moveDocumentToFolder } from "@/server/document-folders/actions";
import { actionErrorMessage } from "@/lib/action-error";
import { cn } from "@/lib/utils";

type FolderRow = { id: string; name: string; _count?: { documents: number } };

/**
 * 材料移入卷宗文件夹（2026-11-20）
 *
 * 卷宗文件夹一直存在——由 `default-folders` 在结案/归档等时机**自动创建**，
 * 但 `listFoldersByMatter` 零引用、`moveDocumentToFolder` 零引用：
 * **库里有文件夹，界面上看不见，材料也无法归类**。
 * 材料一多，办案进程里就是一长串平铺的文件。
 *
 * 建文件夹本身仍不开放（`createFolder` 有意不给入口——避免与默认卷宗目录打架），
 * 这里只做「把现有材料放进已有文件夹」。
 */
export function DocFolderMoveDialog({
  open,
  onOpenChange,
  documentId,
  documentName,
  matterId,
  currentFolderId
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  documentId: string | null;
  documentName?: string;
  matterId: string;
  currentFolderId?: string | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [folders, setFolders] = useState<FolderRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setFolders(null);
    setSelected(currentFolderId ?? null);
    startTransition(async () => {
      try {
        const rows = await listFoldersByMatter(matterId);
        setFolders(rows as FolderRow[]);
      } catch {
        setFolders([]);
      }
    });
  }, [open, matterId, currentFolderId]);

  const submit = () => {
    if (!documentId) return;
    startTransition(async () => {
      try {
        await moveDocumentToFolder({ documentId, folderId: selected });
        toast.success(selected === null ? "已移出文件夹" : "已移入文件夹");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("操作失败", { description: actionErrorMessage(err) });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <FolderArchive className="h-4 w-4" />
            归入文件夹
          </DialogTitle>
          <DialogDescription className="text-xs">
            {documentName ? `「${documentName}」` : ""}选择要归入的卷宗目录；选「不归入」即移出
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          {folders === null ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              读取目录…
            </div>
          ) : folders.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              本案还没有卷宗目录。归档或结案时系统会自动建立默认目录，届时即可归入。
            </p>
          ) : (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={cn(
                  "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-xs",
                  selected === null
                    ? "border-[var(--primary)] bg-[var(--primary-bg,rgba(30,86,200,0.06))]"
                    : "border-[var(--line)] hover:bg-muted"
                )}
              >
                <span>不归入（留在根目录）</span>
              </button>
              {folders.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setSelected(f.id)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-xs",
                    selected === f.id
                      ? "border-[var(--primary)] bg-[var(--primary-bg,rgba(30,86,200,0.06))]"
                      : "border-[var(--line)] hover:bg-muted"
                  )}
                >
                  <span className="truncate">{f.name}</span>
                  {typeof f._count?.documents === "number" ? (
                    <span className="ml-2 shrink-0 text-[10px] text-muted-foreground">
                      {f._count.documents} 份
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </FormDialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button onClick={submit} disabled={isPending || !folders || folders.length === 0}>
            {isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
