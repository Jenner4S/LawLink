"use client";

import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import type { Client, Contact } from "@prisma/client";
import { ClientSheet } from "@/app/(app)/clients/_components/client-sheet";
import { revealClientIdNumber } from "@/server/clients/insights";

/**
 * v0.39: 客户详情页「编辑信息」入口。
 * 详情页是服务端组件，这里包一层客户端 state 复用现有 ClientSheet（含编辑 + 联系人）。
 */
export function ClientEditButton({
  client
}: {
  client: Client & { contacts?: Contact[] };
}) {
  const [open, setOpen] = useState(false);
  // 2026-11-19：证件号不再由服务端首屏传入（会出现在 HTML/RSC payload 里）。
  // 点「编辑资料」时才通过 revealClientIdNumber 拉取并写 CLIENT_ID_REVEAL 审计。
  // 这样既不泄露首屏，也不会因表单空值把证件号覆盖成 null
  //（updateClient 对未传 idNumber 的语义是清空，见 actions.ts:289）。
  const [plainIdNumber, setPlainIdNumber] = useState<string | null | undefined>(undefined);
  const [loadingId, startLoadingId] = useTransition();

  const openEditor = () => {
    setOpen(true);
    if (plainIdNumber !== undefined) return;
    startLoadingId(async () => {
      try {
        setPlainIdNumber((await revealClientIdNumber(client.id)) ?? null);
      } catch {
        // 拉取失败：仍可编辑其他字段，证件号留空但不提交（由 sheet 侧保持原值语义）
        setPlainIdNumber(null);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        disabled={loadingId}
        className="btn btn-secondary btn-sm"
      >
        <Pencil />
        {loadingId ? "读取中…" : "编辑资料"}
      </button>
      <ClientSheet
        open={open}
        onOpenChange={setOpen}
        editingClient={
          plainIdNumber === undefined
            ? client
            : { ...client, idNumber: plainIdNumber }
        }
      />
    </>
  );
}
