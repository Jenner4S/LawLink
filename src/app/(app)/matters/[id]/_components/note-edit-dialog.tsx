"use client";

import { FormDialogContent as DialogContent, FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { updateNote } from "@/server/notes/actions";
import { civilKey, shParts } from "@/lib/ui/sh-time";
import { actionErrorMessage } from "@/lib/action-error";

export type EditableNote = {
  id: string;
  matterId: string;
  content: string;
  occurredAt: Date;
  /** 以下三项**必须原样回传**：updateNote 收全量，缺项会被覆盖成默认值 */
  channel: string;
  withWhom: string | null;
  tags: string[];
};

/**
 * 经办记录编辑（2026-11-22）
 *
 * `updateNote` 一直存在但**没有界面入口**（可达性审计里挂了很久）。
 * 律师沟通记录打错字、补一句关键信息时只能作废整条重记，而记录是
 * 案件卷宗的一部分，重记会丢原始时间线。
 *
 * 只改内容与发生时间：渠道、相对人、标签原样带上（见 EditableNote 注释）。
 * 服务端另有「只能编辑自己的沟通记录」的本人校验，所以入口只对作者本人显示。
 */
export function NoteEditDialog({
  open,
  onOpenChange,
  note
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  note: EditableNote | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [content, setContent] = useState("");
  const [dateKey, setDateKey] = useState("");
  const [time, setTime] = useState("09:00");

  useEffect(() => {
    if (!open || !note) return;
    setContent(note.content);
    const p = shParts(note.occurredAt);
    setDateKey(civilKey(note.occurredAt));
    setTime(`${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`);
  }, [open, note]);

  const submit = () => {
    if (!note) return;
    if (!content.trim()) {
      toast.error("内容不能为空");
      return;
    }
    // 境外浏览器会把时刻挪到别的日界，统一用 +08:00 拼接
    const occurredAt = new Date(`${dateKey}T${time || "09:00"}:00+08:00`);

    startTransition(async () => {
      try {
        await updateNote({
          id: note.id,
          matterId: note.matterId,
          content: content.trim(),
          occurredAt,
          // 原样回传，见 EditableNote 注释
          channel: note.channel as never,
          withWhom: note.withWhom ?? "",
          tags: note.tags
        });
        toast.success("记录已更新");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("保存失败", { description: actionErrorMessage(err) });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑记录</DialogTitle>
          <DialogDescription className="text-xs">
            渠道、相对人与环节标签保持不变，只改内容与发生时间
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="note-edit-content">内容</Label>
            <Textarea
              id="note-edit-content"
              value={content}
              rows={6}
              maxLength={5000}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="note-edit-date">发生日期</Label>
              <Input
                id="note-edit-date"
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="note-edit-time">时刻</Label>
              <Input
                id="note-edit-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>
        </FormDialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button onClick={submit} disabled={isPending}>
            {isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
