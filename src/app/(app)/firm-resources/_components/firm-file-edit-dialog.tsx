"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { FirmFileCategory } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { updateFirmFile } from "@/server/firm-files/actions";
import { actionErrorMessage } from "@/lib/action-error";

export type EditableFirmFile = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  category: FirmFileCategory;
};

const CATEGORY_OPTIONS: { value: FirmFileCategory; label: string }[] = [
  { value: "CONTRACT", label: "合同" },
  { value: "LETTER", label: "函件" },
  { value: "LICENSE", label: "证照" },
  { value: "OTHER_FIRM", label: "其他" }
];

/**
 * 律所文书编辑（2026-11-20）
 *
 * `updateFirmFile` 一直存在但没有界面入口：改名、补简介、改标签、换分类
 * 都只能删了重传——而重传会打断 supersedes 版本链，历史就断了。
 *
 * 只改元数据，不动文件本身（文件替代走「上传新版」）。
 */
export function FirmFileEditDialog({
  open,
  onOpenChange,
  file
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  file: EditableFirmFile | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [category, setCategory] = useState<FirmFileCategory>("OTHER_FIRM");

  useEffect(() => {
    if (!open || !file) return;
    setName(file.name);
    setDescription(file.description ?? "");
    setTags(file.tags.join("、"));
    setCategory(file.category);
  }, [open, file]);

  const submit = () => {
    if (!file) return;
    if (!name.trim()) {
      toast.error("名称不能为空");
      return;
    }
    // 标签支持中英文分隔符，去重去空
    const parsedTags = Array.from(
      new Set(
        tags
          .split(/[、,，\s]+/)
          .map((t) => t.trim())
          .filter(Boolean)
      )
    ).slice(0, 20);

    startTransition(async () => {
      try {
        await updateFirmFile({
          id: file.id,
          name: name.trim(),
          description: description.trim() || null,
          tags: parsedTags,
          category
        });
        toast.success("已更新");
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
          <DialogTitle>编辑资料信息</DialogTitle>
          <DialogDescription className="text-xs">
            只改名称、简介、标签与分类；文件内容请用「上传新版」替代，历史版本会保留
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="firm-file-name">名称</Label>
            <Input
              id="firm-file-name"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="firm-file-desc">简介</Label>
            <Textarea
              id="firm-file-desc"
              value={description}
              rows={3}
              maxLength={1000}
              placeholder="这份文件在什么场景下用（选填）"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="firm-file-tags">标签</Label>
            <Input
              id="firm-file-tags"
              value={tags}
              placeholder="用顿号或逗号分隔，例如：常顾、诉讼、涉外"
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="firm-file-cat">分类</Label>
            <select
              id="firm-file-cat"
              value={category}
              onChange={(e) => setCategory(e.target.value as FirmFileCategory)}
              className="h-9 w-full rounded-md border border-[var(--line)] bg-transparent px-2 text-sm"
            >
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
