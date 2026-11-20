"use client";

/**
 * 客户与联系人的删除入口（2026-11-20）
 *
 * `softDeleteClient` 与 `deleteContact` 一直存在但零引用：
 * 客户重复建档了删不掉、联系人录错了删不掉——而这两件事在日常建档里天天发生。
 *
 * 两者的权限口径都是「合伙人 / 管理员 / 获授权自定岗位」，所以按钮由调用方
 * 用 canManage 控制可见；服务端仍会独立校验（不做只靠 UI 的权限）。
 *
 * 客户是**软删**（deletedAt），联系人按现有实现是硬删；
 * 两者的 confirmDialog 文案把这个差别说清楚，不让用户以为都能恢复。
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2, Loader2 } from "lucide-react";
import { deleteContact, softDeleteClient } from "@/server/clients/actions";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import { actionErrorMessage } from "@/lib/action-error";

export function DeleteContactButton({
  contactId,
  contactName
}: {
  contactId: string;
  contactName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  if (gone) return null;

  return (
    <button
      type="button"
      title="删除联系人"
      disabled={pending}
      onClick={async () => {
        const ok = await confirmDialog({
          title: `删除联系人「${contactName}」？`,
          description: "删除后该联系人不再出现在客户档案里，不可恢复。若只是信息有误，请联系管理员核对。",
          confirmText: "删除",
          danger: true
        });
        if (!ok) return;
        startTransition(async () => {
          try {
            const res = await deleteContact(contactId);
            if (!res.ok) {
              toast.error("联系人已不存在");
              setGone(true);
              return;
            }
            toast.success("已删除");
            setGone(true);
            router.refresh();
          } catch (err) {
            toast.error("删除失败", { description: actionErrorMessage(err) });
          }
        });
      }}
      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
    >
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
    </button>
  );
}

export function DeleteClientButton({
  clientId,
  clientName
}: {
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  if (gone) return null;

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm text-[var(--t-muted)]"
      disabled={pending}
      onClick={async () => {
        const ok = await confirmDialog({
          title: `停用客户「${clientName}」？`,
          description:
            "客户档案将被标记为已删除并从列表移除，其关联案件、财务记录与历史沟通不受影响（这是软删除，数据仍在库中）。若只是重复建档，建议改用「合并」。",
          confirmText: "停用并移除",
          danger: true
        });
        if (!ok) return;
        startTransition(async () => {
          try {
            await softDeleteClient(clientId);
            toast.success("客户已停用");
            setGone(true);
            router.push("/clients");
          } catch (err) {
            toast.error("操作失败", { description: actionErrorMessage(err) });
          }
        });
      }}
    >
      {pending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
      停用客户
    </button>
  );
}
