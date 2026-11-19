"use client";

import { useState, useTransition } from "react";

import { revealClientIdNumber, revealContactPhone } from "@/server/clients/insights";

/**
 * 敏感字段按需揭示（2026-11-19）。
 *
 * 背景：客户详情页此前直接 `decryptIdNumber()` 后把身份证号渲染进 HTML，
 * 打开页面即完成一次敏感信息读取，**没有任何审计**。而项目里早已有带审计的
 * `revealClientIdNumber` / `revealContactPhone`（写 CLIENT_ID_REVEAL / CONTACT_PHONE_REVEAL），
 * 只是界面上没人调用——正确实现存在，却被绕过。
 *
 * 本组件把展示口径改为：默认脱敏，点「查看」才触发服务端揭示并写审计。
 * 依据《个人信息保护法》第 51 条：处理敏感个人信息应留痕可追溯。
 */
export function RevealField({
  kind,
  targetId,
  masked,
  emptyText = "未登记"
}: {
  kind: "clientIdNumber" | "contactPhone";
  targetId: string;
  /** 默认展示的脱敏文本；为空表示该字段未登记 */
  masked: string | null;
  emptyText?: string;
}) {
  const [revealed, setRevealed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!masked && !revealed) {
    return <span className="v t-faint">{emptyText}</span>;
  }

  if (revealed) {
    return <span className="v mono">{revealed || emptyText}</span>;
  }

  return (
    <span className="v mono flex items-center gap-2">
      <span>{masked}</span>
      <button
        type="button"
        className="btn btn-ghost btn-xs"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              const value =
                kind === "clientIdNumber"
                  ? await revealClientIdNumber(targetId)
                  : await revealContactPhone(targetId);
              setRevealed(value ?? "");
            } catch (err) {
              setError(err instanceof Error ? err.message : "查看失败");
            }
          });
        }}
      >
        {pending ? "读取中…" : "查看"}
      </button>
      {error ? <span className="text-destructive text-[11px]">{error}</span> : null}
    </span>
  );
}

/** 把身份证号/统一社会信用代码脱敏：保留前 4 位与后 4 位 */
export function maskIdNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}${"*".repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}
