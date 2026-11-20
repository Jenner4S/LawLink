"use client";

/**
 * 案件详情「工时」页签（P0-1 阶段 1-b）。
 *
 * 三件事：① 顶部三角汇总（已投入小时 / 折算金额 / 已收金额，数据来自
 * getMatterTimeSummary）；② 本案工时列表（日期 / 律师 / 时长 / 内容 / 计费金额 / 状态）；
 * ③ 「登记工时」弹窗。
 *
 * 口径约定（不在此处发明）：
 *   - 金额、进位、费率快照全部由服务端计算并落库，页面只展示返回值；
 *   - 「已收」只算已确认的实收（与财务页同口径，待确认款不计入）；
 *   - 时长唯一口径是分钟，表单里的「小时 + 分钟」只是输入方式；
 *   - 日期展示用 formatDate（上海时区，AGENTS 交互原则④），不用 getDate/getHours。
 */

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Clock3, Loader2, Plus } from "lucide-react";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioChips } from "@/components/ui/radio-chips";
import { Textarea } from "@/components/ui/textarea";
import { actionErrorMessage } from "@/lib/action-error";
import { shDayKey } from "@/lib/ui/sh-time";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { addTimeEntry, updateTimeEntry, deleteTimeEntry, type MatterTimeBoard } from "@/server/time/actions";

/** 与服务端 EDITABLE_STATUSES 同口径：已核定/已出账/已核销不可原地改删 */
const EDITABLE_STATUSES = new Set(["DRAFT", "SUBMITTED"]);

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "草稿",
  SUBMITTED: "已提交",
  APPROVED: "已核定",
  BILLED: "已出账",
  WRITTEN_OFF: "已核销"
};

/** 分钟 → 小时文本（1 位小数，整数不带 .0） */
function hoursText(minutes: number): string {
  const h = minutes / 60;
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

const TASK_CODES = [
  { value: "", label: "不限" },
  { value: "阅卷", label: "阅卷" },
  { value: "起草", label: "起草" },
  { value: "开庭", label: "开庭" },
  { value: "沟通", label: "沟通" },
  { value: "差旅", label: "差旅" }
];

export function TimePanel({
  matterId,
  board,
  canWrite
}: {
  matterId: string;
  board: MatterTimeBoard;
  /** 与案件其他写操作同一口径：经办（含合伙人）+ 案件未归档 */
  canWrite: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [editEntry, setEditEntry] = useState<MatterTimeBoard["entries"][number] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const { summary, entries } = board;

  const cells: { label: string; value: string; tone?: string; hint?: string }[] = [
    {
      label: "已投入",
      value: `${hoursText(summary.actualMinutes)} 小时`,
      hint: summary.entryCount > 0 ? `共 ${summary.entryCount} 条` : "尚未登记"
    },
    {
      label: "折算金额",
      value: formatCurrency(summary.billableAmount),
      tone: "green",
      hint: `计费 ${hoursText(summary.billableMinutes)} 小时`
    },
    {
      label: "已收金额",
      value: formatCurrency(summary.collectedAmount),
      tone: "amber",
      hint: "仅计已确认实收"
    }
  ];

  return (
    <div className="dos-main">
      <section className="card dos-fin-hero" aria-label="工时汇总">
        <div className="dos-fin-cells">
          {cells.map((c) => (
            <div key={c.label} className={cn("dos-fin-cell", c.tone)}>
              <span className="k">{c.label}</span>
              <span className="v">{c.value}</span>
              {c.hint ? <span className="t-xs t-mute">{c.hint}</span> : null}
            </div>
          ))}
        </div>
        {summary.nonChargeableMinutes > 0 ? (
          <p className="t-xs t-mute" style={{ margin: "10px 0 0" }}>
            其中不可计费 {hoursText(summary.nonChargeableMinutes)} 小时，原因见各条记录。
          </p>
        ) : null}
      </section>

      <section className="card">
        <div className="panel-head">
          <div className="panel-title">
            <Clock3 className="ic" strokeWidth={1.8} />
            工时记录
            <span className="badge b-white" style={{ marginLeft: 2 }}>
              {entries.length}
            </span>
          </div>
          {canWrite ? (
            <Button size="sm" variant="secondary" className="h-7 gap-1 text-[12px]" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              登记工时
            </Button>
          ) : null}
        </div>

        {entries.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {canWrite ? "本案还没有工时记录，点右上「登记工时」记第一条。" : "本案还没有工时记录。"}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {entries.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5 text-[12.5px]">
                <span className="shrink-0 font-mono text-[11.5px] tabular text-muted-foreground">
                  {formatDate(new Date(e.workDate))}
                </span>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{e.userName ?? "—"}</span>
                <span className="shrink-0 font-mono text-[12px] tabular font-medium">
                  {hoursText(e.minutes)}h
                  {e.billableMinutes !== e.minutes ? (
                    <span className="ml-1 text-[10.5px] font-normal text-muted-foreground">
                      计 {hoursText(e.billableMinutes)}h
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate" title={e.narrative}>
                  {e.narrative}
                </span>
                {e.taskCode ? <span className="badge b-white shrink-0">{e.taskCode}</span> : null}
                {!e.billable ? (
                  <span className="badge b-amber shrink-0" title={e.noChargeReason ?? "不可计费"}>
                    不计费
                  </span>
                ) : null}
                <span className="shrink-0 font-mono text-[12px] tabular text-[var(--green)]">
                  {e.amount > 0 ? formatCurrency(e.amount) : "—"}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {STATUS_LABEL[e.status] ?? e.status}
                </span>
                {/* 2026-11-20（P0-1 ⑥）：只有草稿/已提交可原地改删——已核定是审批人核对过的事实，
                    已出账改动会让账单与工时对不上，已核销是审计痕迹。 */}
                {canWrite && EDITABLE_STATUSES.has(e.status) ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      disabled={busyId === e.id}
                      onClick={() => setEditEntry(e)}
                    >
                      改
                    </button>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground hover:text-destructive"
                      disabled={busyId === e.id}
                      onClick={async () => {
                        const ok = await confirmDialog({
                          title: `删除这条工时（${hoursText(e.minutes)} 小时）？`,
                          description: `${e.narrative.slice(0, 40)}${e.narrative.length > 40 ? "…" : ""}\n\n删除后不可恢复。审计会保留这条工时的全部字段（时长、金额、费率、内容），事后仍可追溯。`,
                          confirmText: "删除",
                          danger: true
                        });
                        if (!ok) return;
                        setBusyId(e.id);
                        startTransition(async () => {
                          try {
                            await deleteTimeEntry(e.id);
                            toast.success("已删除");
                            router.refresh();
                          } catch (err) {
                            toast.error("删除失败", { description: actionErrorMessage(err) });
                          } finally {
                            setBusyId(null);
                          }
                        });
                      }}
                    >
                      删
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canWrite ? <AddTimeEntryDialog open={addOpen} onOpenChange={setAddOpen} matterId={matterId} /> : null}
      {canWrite ? (
        <AddTimeEntryDialog
          open={editEntry !== null}
          onOpenChange={(o) => { if (!o) setEditEntry(null); }}
          matterId={matterId}
          entry={editEntry}
        />
      ) : null}
    </div>
  );
}

/** 登记工时弹窗：日期 / 时长（小时+分钟）/ 工作内容 / 是否计费 / 不可计费原因 / 任务分类 */
function AddTimeEntryDialog({
  open,
  onOpenChange,
  matterId,
  entry
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matterId: string;
  /** 传入即为编辑模式（2026-11-20，P0-1 ⑥） */
  entry?: {
    id: string;
    workDate: Date | string;
    minutes: number;
    narrative: string;
    taskCode: string | null;
    billable: boolean;
    noChargeReason: string | null;
  } | null;
}) {
  const isEdit = !!entry;
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [workDate, setWorkDate] = useState("");
  const [hours, setHours] = useState("1");
  const [mins, setMins] = useState("0");
  const [narrative, setNarrative] = useState("");
  const [billable, setBillable] = useState<"billable" | "free">("billable");
  const [noChargeReason, setNoChargeReason] = useState("");
  const [taskCode, setTaskCode] = useState("");

  // 默认日期取上海「今天」：只在浏览器端设置，避免服务端/浏览器时区不同导致水合不一致
  useEffect(() => setWorkDate(shDayKey(new Date())), []);

  // 编辑模式：打开时按传入记录预填（日期取上海日历日，与服务端口径一致）
  useEffect(() => {
    if (!open || !entry) return;
    setWorkDate(shDayKey(new Date(entry.workDate)));
    setHours(String(Math.floor(entry.minutes / 60)));
    setMins(String(entry.minutes % 60));
    setNarrative(entry.narrative);
    setBillable(entry.billable ? "billable" : "free");
    setNoChargeReason(entry.noChargeReason ?? "");
    setTaskCode(entry.taskCode ?? "");
  }, [open, entry]);

  const totalMinutes = (Number(hours) || 0) * 60 + (Number(mins) || 0);

  function reset() {
    setHours("1");
    setMins("0");
    setNarrative("");
    setBillable("billable");
    setNoChargeReason("");
    setTaskCode("");
  }

  function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!Number.isInteger(totalMinutes) || totalMinutes <= 0) {
      toast.error("请填写有效时长（小时 + 分钟）");
      return;
    }
    if (!narrative.trim()) {
      toast.error("工作内容必填");
      return;
    }
    if (billable === "free" && !noChargeReason.trim()) {
      toast.error("标记为不可计费时必须填写原因");
      return;
    }
    startTransition(async () => {
      try {
        if (isEdit && entry) {
          // 编辑会重算费率与金额（改日期可能跨费率期），不沿用旧快照
          const res = await updateTimeEntry({
            id: entry.id,
            workDate,
            minutes: totalMinutes,
            narrative,
            taskCode: taskCode || "",
            billable: billable === "billable",
            noChargeReason: billable === "free" ? noChargeReason : ""
          });
          toast.success(
            `已更新 · ${hoursText(totalMinutes)} 小时` +
              (res.amount > 0 ? ` · 折算 ${formatCurrency(res.amount)}` : "")
          );
          onOpenChange(false);
          router.refresh();
          return;
        }
        const res = await addTimeEntry({
          matterId,
          workDate,
          minutes: totalMinutes,
          narrative,
          taskCode: taskCode || null,
          billable: billable === "billable",
          noChargeReason: billable === "free" ? noChargeReason : null
        });
        if (res.rateScope === "NONE") {
          toast.warning("已登记，但本所尚未配置费率，本条折算金额记为 0", {
            description: "请管理员在费率配置中设置所内默认费率（或本案协议价）"
          });
        } else {
          toast.success(
            `已登记 ${hoursText(res.minutes)} 小时` + (res.amount > 0 ? ` · 折算 ${formatCurrency(res.amount)}` : "")
          );
        }
        reset();
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("登记失败", { description: actionErrorMessage(err) });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[92vw] max-w-xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{isEdit ? "编辑工时" : "登记工时"}</DialogTitle>
          <DialogDescription className="text-xs">
            {isEdit
              ? "保存后按当前费率与日期重新计算金额（改日期可能跨到另一个费率生效期）。已核定或已出账的工时不能改。"
              : "折算金额按录入时生效的费率计算并锁定快照，此后调整费率不会改动这条记录。"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-1 flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
            <Field label="日期" required>
              <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} required />
            </Field>

            <Field label="时长" required hint={`折合 ${totalMinutes > 0 ? totalMinutes : 0} 分钟`}>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={24}
                  inputMode="numeric"
                  className="w-20 font-mono tabular"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                  aria-label="小时"
                />
                <span className="text-xs text-muted-foreground">小时</span>
                <Input
                  type="number"
                  min={0}
                  max={59}
                  inputMode="numeric"
                  className="w-20 font-mono tabular"
                  value={mins}
                  onChange={(e) => setMins(e.target.value)}
                  aria-label="分钟"
                />
                <span className="text-xs text-muted-foreground">分钟</span>
              </div>
            </Field>

            <Field label="工作内容" required>
              <Textarea
                rows={3}
                placeholder="如：阅卷并梳理证据目录，起草质证意见初稿"
                value={narrative}
                onChange={(e) => setNarrative(e.target.value)}
                maxLength={2000}
              />
            </Field>

            <Field label="任务分类">
              <RadioChips
                size="sm"
                items={TASK_CODES}
                value={taskCode}
                onChange={(v) => setTaskCode(v)}
              />
            </Field>

            <Field label="是否计费">
              <RadioChips
                size="sm"
                items={[
                  { value: "billable", label: "计费" },
                  { value: "free", label: "不可计费" }
                ]}
                value={billable}
                onChange={(v) => setBillable(v as "billable" | "free")}
              />
            </Field>

            {billable === "free" ? (
              <Field label="不可计费原因" required hint="必填：无理由的不可计费等于隐藏工作量，管理上要能看出来">
                <Input
                  placeholder="如：所内案件讨论、公益咨询、客户维护"
                  value={noChargeReason}
                  onChange={(e) => setNoChargeReason(e.target.value)}
                  maxLength={200}
                />
              </Field>
            ) : null}
          </div>

          <DialogFooter className="border-t border-border px-6 py-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={isPending}>
              取消
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  hint,
  children
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-xs">
        {label}
        {required ? <span className="text-destructive">*</span> : null}
      </Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
