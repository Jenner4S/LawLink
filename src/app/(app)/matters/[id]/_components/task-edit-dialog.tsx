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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { updateTask } from "@/server/tasks/actions";
import { civilKey, shParts } from "@/lib/ui/sh-time";
import { actionErrorMessage } from "@/lib/action-error";

export type EditableTask = {
  id: string;
  matterId: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  priority: number;
  stageId: string | null;
  /** **必须原样回传**：updateTask 会比对该字段，省略或改动都会抛交接提示 */
  assigneeId: string | null;
};

/**
 * 事项编辑对话框（2026-11-22）
 *
 * 为什么单独一个组件：`updateTask` 一直存在但**没有任何界面入口**
 * （可达性审计里挂了很久的零引用动作）。律师建错标题、填错日期或要调优先级时，
 * 只能删掉重建 —— 而删除在责任面板启用后是被拒绝的（见 deleteTask 的守卫），
 * 于是实际是「建错了就改不了」。
 *
 * **不含责任人字段**：`updateTask` 明确禁止在这里换人
 * （"变更责任人请从事项责任面板发起交接，接收后生效"），
 * 换人要走责任面板的交接流程。这里把 assigneeId 原样带上，只是为了让校验通过。
 */
export function TaskEditDialog({
  open,
  onOpenChange,
  task
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  task: EditableTask | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dateKey, setDateKey] = useState("");
  const [time, setTime] = useState("09:00");
  const [priority, setPriority] = useState<0 | 1 | 2>(0);

  // 每次打开都按当前任务重置，避免上一个任务的残留值
  useEffect(() => {
    if (!open || !task) return;
    setTitle(task.title);
    setDescription(task.description ?? "");
    setPriority((task.priority as 0 | 1 | 2) ?? 0);
    if (task.dueAt) {
      const p = shParts(task.dueAt);
      setDateKey(civilKey(task.dueAt));
      setTime(`${String(p.hh).padStart(2, "0")}:${String(p.mm).padStart(2, "0")}`);
    } else {
      setDateKey("");
      setTime("09:00");
    }
  }, [open, task]);

  const submit = () => {
    if (!task) return;
    if (!title.trim()) {
      toast.error("标题不能为空");
      return;
    }
    // 日期保持原样（不填则不动）。境外浏览器会把时刻挪到别的日界，统一用 +08:00 拼接。
    const dueAt = dateKey
      ? new Date(`${dateKey}T${time || "09:00"}:00+08:00`)
      : task.dueAt ?? undefined;

    startTransition(async () => {
      try {
        await updateTask({
          id: task.id,
          matterId: task.matterId,
          title: title.trim(),
          description,
          // 原样回传，见组件注释
          assigneeId: task.assigneeId ?? "",
          dueAt,
          priority,
          stageId: task.stageId ?? ""
        });
        toast.success("已保存");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("保存失败", { description: actionErrorMessage(err) });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>编辑事项</DialogTitle>
          <DialogDescription className="text-xs">
            责任人变更请从事项责任面板发起交接，此处只改内容与时间
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="task-edit-title">标题</Label>
            <Input
              id="task-edit-title"
              value={title}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如：整理证据目录"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-edit-desc">说明</Label>
            <Textarea
              id="task-edit-desc"
              value={description}
              maxLength={2000}
              rows={3}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可留空"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="task-edit-date">截止日期</Label>
              <Input
                id="task-edit-date"
                type="date"
                value={dateKey}
                onChange={(e) => setDateKey(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="task-edit-time">时刻</Label>
              <Input
                id="task-edit-time"
                type="time"
                value={time}
                disabled={!dateKey}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>优先级</Label>
            <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v) as 0 | 1 | 2)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="0">普通</SelectItem>
                <SelectItem value="1">重要</SelectItem>
                <SelectItem value="2">紧急</SelectItem>
              </SelectContent>
            </Select>
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
