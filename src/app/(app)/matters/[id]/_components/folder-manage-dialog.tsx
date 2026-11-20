"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FolderCog, Loader2, Pencil, Trash2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { listFoldersByMatter, renameFolder, deleteFolder } from "@/server/document-folders/actions";
import { confirmDialog, promptDialog } from "@/components/patterns/confirm-dialog";
import { actionErrorMessage } from "@/lib/action-error";

type FolderRow = { id: string; name: string; isDefault: boolean; _count?: { documents: number } };

/**
 * 卷宗目录管理（2026-11-20）
 *
 * `renameFolder` / `deleteFolder` 一直存在但零引用，而**删目录的报错里写着**
 * 「默认卷宗不可删除，只能改名」—— **改名却没有任何入口**。用户按系统给的
 * 提示去找改名，找不到。
 *
 * 按服务端已有的语义做界面，不改语义：
 * · **任何目录都可改名**（`renameFolder` 本身没有 isDefault 限制；
 *   默认目录名是行业惯例，各所叫法不同，正是最需要改的）
 * · **默认目录不可删**（`deleteFolder` 显式拒绝）；非默认可删
 * · 删目录**不会删材料**：卷内材料会被移到「散件」（folderId=null），
 *   删前文案把这个说清楚，并把份数报给用户
 *
 * 不提供「新建目录」与「排序」：默认目录由 `default-folders` 按结案/归档
 * 自动创建，与国内律所卷宗目录惯例一致（`createFolder` / `reorderFolders`
 * 仍为有意保留，见可达性判定表）。
 */
export function FolderManageDialog({
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
  const [folders, setFolders] = useState<FolderRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const reload = () => {
    startTransition(async () => {
      try {
        const rows = await listFoldersByMatter(matterId);
        setFolders(rows as FolderRow[]);
      } catch {
        setFolders([]);
      }
    });
  };

  useEffect(() => {
    if (!open) return;
    setFolders(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, matterId]);

  const doRename = async (f: FolderRow) => {
    const name = await promptDialog({
      title: `重命名卷宗目录「${f.name}」`,
      description: f.isDefault
        ? "这是系统默认建立的目录。各所叫法不同，可以改成你们习惯的叫法；改名不影响卷内材料。"
        : "改名不影响卷内材料，也不能与本案其他目录重名。",
      label: "新的目录名",
      placeholder: f.name,
      confirmText: "保存"
    });
    if (!name || name.trim() === f.name) return;
    setBusyId(f.id);
    startTransition(async () => {
      try {
        await renameFolder({ id: f.id, name: name.trim() });
        toast.success("已改名");
        router.refresh();
        reload();
      } catch (err) {
        toast.error("改名失败", { description: actionErrorMessage(err) });
      } finally {
        setBusyId(null);
      }
    });
  };

  const doDelete = async (f: FolderRow) => {
    const count = f._count?.documents ?? 0;
    const ok = await confirmDialog({
      title: `删除卷宗目录「${f.name}」？`,
      description:
        count > 0
          ? `目录本身会删除，但**里面的 ${count} 份材料不会被删除**，会移到「散件」（不归入任何目录），之后可以重新归入其他目录。`
          : "目录本身会删除；这个目录里目前没有材料。",
      confirmText: "删除目录",
      danger: true
    });
    if (!ok) return;
    setBusyId(f.id);
    startTransition(async () => {
      try {
        await deleteFolder({ id: f.id });
        toast.success(count > 0 ? `已删除目录，${count} 份材料移到散件` : "已删除目录");
        router.refresh();
        reload();
      } catch (err) {
        toast.error("删除失败", { description: actionErrorMessage(err) });
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
            <FolderCog className="h-4 w-4" />
            卷宗目录
          </DialogTitle>
          <DialogDescription className="text-xs">
            目录由系统按结案/归档自动建立；这里可以改名，也可以删除自建的多余目录。
            <b>任何目录都能改名</b>，但默认目录不能删。
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
              本案还没有卷宗目录。归档或结案时系统会自动建立默认目录。
            </p>
          ) : (
            <div className="space-y-1">
              {folders.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2 rounded-md border border-[var(--line)] px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium" title={f.name}>
                    {f.name}
                  </span>
                  {f.isDefault ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-0.5 rounded border border-[var(--line)] px-1 text-[9px] text-[var(--t-muted)]"
                      title="系统默认目录：可改名，不可删除"
                    >
                      <Lock className="h-2 w-2" />
                      默认
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {f._count?.documents ?? 0} 份
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    disabled={isPending || busyId === f.id}
                    onClick={() => doRename(f)}
                    title="改名"
                  >
                    {busyId === f.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Pencil className="h-3.5 w-3.5" />}
                  </button>
                  {!f.isDefault ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                      disabled={isPending || busyId === f.id}
                      onClick={() => doDelete(f)}
                      title="删除目录"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
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
