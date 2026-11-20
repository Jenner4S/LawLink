"use client";

/**
 * 坏账登记与审批（2026-11-22，对标分析 P0-5）
 *
 * 客户现行系统把「退款」与「无法收取」合成一列。退款是退给客户，坏账是客户不给/给不了，
 * 成因不同；混在一起既没法追责也没法做风控。
 *
 * 界面三条克制：
 * ① 申报与批准分开显示——申报人看不到「批准」按钮（服务端还会再挡一次自批）；
 * ② 只有已批准才显示「已扣减」，待审批显示「不影响应收」，避免有人以为提了就算数；
 * ③ 驳回必须写理由，走项目统一的 promptDialog。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { promptDialog } from "@/components/patterns/confirm-dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import { actionErrorMessage } from "@/lib/action-error";
import { decideWriteOff, requestWriteOff, type WriteOffRow } from "@/server/finance/writeoff-actions";

const REASON_CN: Record<string, string> = {
  CUSTOMER_UNREACHABLE: "客户失联",
  INABILITY_TO_PAY: "无力支付",
  WAIVED: "主动减免",
  IN_DISPUTE: "争议中无法追偿",
  OTHER: "其他"
};
const STATUS_CN: Record<string, string> = { PENDING: "待审批", APPROVED: "已批准", REJECTED: "已驳回" };

export function WriteOffBlock({
  matterId,
  rows,
  canRequest,
  canDecide,
  currentUserId
}: {
  matterId: string;
  rows: WriteOffRow[];
  canRequest: boolean;
  canDecide: boolean;
  currentUserId: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("CUSTOMER_UNREACHABLE");
  const [note, setNote] = useState("");

  const submit = () => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("请填写大于 0 的坏账金额");
      return;
    }
    startTransition(async () => {
      try {
        await requestWriteOff({ matterId, amount: value, reason: reason as never, note });
        toast.success("已提交，待财务复核");
        setAmount(""); setNote("");
        router.refresh();
      } catch (err) {
        toast.error("提交失败", { description: actionErrorMessage(err) });
      }
    });
  };

  const decide = (row: WriteOffRow, decision: "APPROVED" | "REJECTED") => {
    startTransition(async () => {
      try {
        if (decision === "REJECTED") {
          const why = await promptDialog({
            title: "驳回坏账", description: "驳回理由会记入审计。",
            placeholder: "如：客户仍在分期还款", required: true, maxLength: 200
          });
          if (!why) return;
          await decideWriteOff({ id: row.id, decision, rejectReason: why });
        } else {
          await decideWriteOff({ id: row.id, decision });
        }
        toast.success(decision === "APPROVED" ? "已批准，未收余额已扣减" : "已驳回");
        router.refresh();
      } catch (err) {
        toast.error("操作失败", { description: actionErrorMessage(err) });
      }
    });
  };

  return (
    <section className="card">
      <div className="panel-head">
        <div className="panel-title">坏账</div>
        <span className="t-xs t-mute">只有已批准才扣减未收余额</span>
      </div>

      {rows.length === 0 ? (
        <div className="panel-body t-xs t-mute">暂无坏账记录</div>
      ) : (
        <div className="panel-body space-y-1">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--bd-hair)] py-1 text-[11.5px] last:border-0">
              <span className="font-mono">{formatCurrency(r.amount)}</span>
              <span>{REASON_CN[r.reason] ?? r.reason}</span>
              <span className={r.status === "APPROVED" ? "text-[var(--red)]" : "text-[var(--t-muted)]"}>
                {STATUS_CN[r.status] ?? r.status}
              </span>
              <span className="text-[var(--t-muted)]">
                申报 {r.requestedBy.name} · {formatDate(r.createdAt)}
              </span>
              {r.decidedBy ? (
                <span className="text-[var(--t-muted)]">复核 {r.decidedBy.name}</span>
              ) : null}
              {r.rejectReason ? <span className="text-[var(--red)]">驳回：{r.rejectReason}</span> : null}
              {/* 逐笔冲抵（2026-11-22）：对账时问的是"这笔坏账冲了哪几笔应收" */}
              {r.items.length > 0 ? (
                <span
                  className="text-[10.5px] text-[var(--t-muted)]"
                  title={r.items.map((i) => `${i.receivableTitle} ${formatCurrency(i.amount)}`).join("；")}
                >
                  冲抵 {r.items.length} 笔
                </span>
              ) : null}
              {r.note ? <span className="min-w-0 flex-1 truncate text-[var(--t-muted)]" title={r.note}>{r.note}</span> : null}
              {r.status === "PENDING" && canDecide && r.requestedBy.id !== currentUserId ? (
                <span className="ml-auto flex gap-1">
                  <Button size="sm" variant="ghost" disabled={isPending} onClick={() => decide(r, "REJECTED")}>驳回</Button>
                  <Button size="sm" disabled={isPending} onClick={() => decide(r, "APPROVED")}>批准</Button>
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {canRequest ? (
        <div className="panel-body flex flex-wrap items-center gap-2 border-t border-[var(--bd-hair)]">
          <Input
            className="h-7 w-28 text-[11px]"
            placeholder="金额"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            aria-label="坏账金额"
          />
          <select className="input h-7 text-[11px]" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="坏账原因">
            {Object.entries(REASON_CN).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <Input
            className="h-7 flex-1 text-[11px]"
            placeholder="说明（可不填）"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="坏账说明"
          />
          <Button size="sm" disabled={isPending} onClick={submit}>申报坏账</Button>
        </div>
      ) : null}
    </section>
  );
}
