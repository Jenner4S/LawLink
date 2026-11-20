"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { PropertyType } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { updateTarget, updateProperty } from "@/server/preservations/actions-v2";
import { actionErrorMessage } from "@/lib/action-error";
import { PROPERTY_TYPE_CN } from "./preservation-types";

export type EditableTarget = { id: string; name: string; note?: string | null };
export type EditableProperty = {
  id: string;
  propertyType: PropertyType;
  propertyDetail: string | null;
  amount: number | null;
};

/**
 * 被保全人编辑（2026-11-20）
 *
 * `updateTarget` 一直存在但零引用——被保全人姓名或备注录错了，只能删掉重加；
 * 而删掉被保全人会连带删掉其名下财产与续保记录（`deleteTarget` 的语义），
 * 等于为了改一个错字把整条保全财产链重建。
 *
 * 注意范围：只改姓名与备注。财产与到期日不在此处（到期日是法院文书载明的
 * 第一事实，改动须走续保或重新登记）。
 */
export function EditTargetDialog({
  open,
  onOpenChange,
  target
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  target: EditableTarget | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open || !target) return;
    setName(target.name);
    setNote(target.note ?? "");
  }, [open, target]);

  const submit = () => {
    if (!target) return;
    if (!name.trim()) {
      toast.error("姓名或名称不能为空");
      return;
    }
    startTransition(async () => {
      try {
        await updateTarget({ id: target.id, name: name.trim(), note: note.trim() });
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>编辑被保全人</DialogTitle>
          <DialogDescription className="text-xs">
            只改姓名与备注；财产与到期日请用「续保」或重新登记
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="pres-target-name">姓名 / 名称</Label>
            <Input id="pres-target-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pres-target-note">备注</Label>
            <Textarea
              id="pres-target-note"
              value={note}
              rows={3}
              maxLength={300}
              placeholder="证件号、联系方式或其他识别信息（选填）"
              onChange={(e) => setNote(e.target.value)}
            />
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

/**
 * 保全财产编辑（2026-11-20）
 *
 * `updateProperty` 零引用——标的类型、说明、金额录错了改不了。
 * 只改这三项：**起算日、期限、到期日不在可改范围**（到期日是法院文书载明的
 * 第一事实，改动走续保；否则台账与法院文书会对不上）。
 */
export function EditPropertyDialog({
  open,
  onOpenChange,
  property
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  property: EditableProperty | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [propertyType, setPropertyType] = useState<PropertyType>("BANK_DEPOSIT");
  const [detail, setDetail] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (!open || !property) return;
    setPropertyType(property.propertyType);
    setDetail(property.propertyDetail ?? "");
    setAmount(property.amount === null ? "" : String(property.amount));
  }, [open, property]);

  const submit = () => {
    if (!property) return;
    const parsed = amount.trim() === "" ? null : Number(amount);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      toast.error("金额必须是非负数字");
      return;
    }
    startTransition(async () => {
      try {
        await updateProperty({
          id: property.id,
          propertyType,
          propertyDetail: detail.trim(),
          amount: parsed
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>编辑保全财产</DialogTitle>
          <DialogDescription className="text-xs">
            只改标的类型、说明与金额；到期日以法院文书为准，调整请用「续保」
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-1.5">
            <Label>标的类型</Label>
            <Select value={propertyType} onValueChange={(v) => setPropertyType(v as PropertyType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROPERTY_TYPE_CN).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pres-prop-amount">金额</Label>
            <Input
              id="pres-prop-amount"
              value={amount}
              inputMode="decimal"
              placeholder="不确定可留空"
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pres-prop-detail">说明</Label>
            <Textarea
              id="pres-prop-detail"
              value={detail}
              rows={3}
              maxLength={500}
              placeholder="账户、账号、坐落或其他识别信息（选填）"
              onChange={(e) => setDetail(e.target.value)}
            />
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
