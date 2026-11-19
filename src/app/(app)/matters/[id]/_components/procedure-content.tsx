"use client";

import { useState, useTransition } from "react";
import {
  Calendar,
  AlertTriangle,
  Plus,
  Check,
  Trash2,
  StickyNote,
  ArrowDownToLine,
  ArrowUpFromLine
} from "lucide-react";
import type {
  Deadline,
  Hearing,
  MatterStage,
  MatterProcedure,
  ProcedureMemo
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { deadlineCategoryLabel } from "@/lib/enums";
import { confirmDeadline, adjustDeadline } from "@/server/deadlines/confirm";
import { cn, daysUntil, formatDate } from "@/lib/utils";
import { procedureTypeLabel } from "@/lib/enums";
import {
  toggleDeadlineCompleted,
  deleteDeadline,
  deleteHearing,
  deleteProcedureMemo
} from "@/server/procedures/actions";
import { deleteExpress } from "@/server/express/actions";
import type { ExpressItem } from "./info-extras";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import { shDayKey, shMonthDayTime } from "@/lib/ui/sh-time";
import { actionErrorMessage } from "@/lib/action-error";
import { ImportantItemDialog, type ImportantCategory } from "./important-item-dialog";

type ProcedureWithChildren = MatterProcedure & {
  deadlines: Deadline[];
  hearings: Hearing[];
  stages: MatterStage[];
  memos: ProcedureMemo[];
};

// 聚合后带程序标签的行类型
type HearingRowItem = Hearing & { procLabel: string };
type DeadlineRowItem = Deadline & { procLabel: string };

function formatIsoDate(d: Date | string) {
  return shDayKey(d);
}
type MemoRowItem = ProcedureMemo & { procLabel: string };
type ImportantFilter = "all" | ImportantCategory;
type AllImportantItem =
  | { id: string; type: "hearing"; sortAt: Date; item: HearingRowItem }
  | { id: string; type: "deadline"; sortAt: Date; item: DeadlineRowItem }
  | { id: string; type: "express"; sortAt: Date; item: ExpressItem }
  | { id: string; type: "memo"; sortAt: Date; item: MemoRowItem };

const procLabelOf = (p: MatterProcedure) =>
  p.customLabel ?? procedureTypeLabel[p.type];

/**
 * v0.46：「重要事项」全案聚合（开庭安排 + 重要时限 + 快递记录 + 其他备忘）。
 */
export function ProcedureRemindersAndMemos({
  matterId,
  procedures,
  currentProcedureId,
  expresses,
  canManage,
  kinds
}: {
  matterId: string;
  procedures: ProcedureWithChildren[];
  currentProcedureId: string;
  expresses: ExpressItem[];
  canManage: boolean;
  /** 只展示部分类别（案卷工作台「办案进程」只放快递与备忘，期限与开庭在待办 / 经办记录） */
  kinds?: ImportantCategory[];
}) {
  const allow = (k: ImportantCategory) => !kinds || kinds.includes(k);
  const multiProc = procedures.length > 1;
  const procOptions = procedures.map((p) => ({ id: p.id, label: procLabelOf(p) }));

  const hearings: HearingRowItem[] = !allow("hearing") ? [] : procedures.flatMap((p) =>
    p.hearings.map((h) => ({ ...h, procLabel: procLabelOf(p) }))
  );
  const deadlines: DeadlineRowItem[] = !allow("deadline") ? [] : procedures.flatMap((p) =>
    p.deadlines.map((d) => ({ ...d, procLabel: procLabelOf(p) }))
  );
  const memos: MemoRowItem[] = !allow("memo") ? [] : procedures
    .flatMap((p) => p.memos.map((m) => ({ ...m, procLabel: procLabelOf(p) })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <ImportantItemsCard
      matterId={matterId}
      deadlines={deadlines}
      hearings={hearings}
      expresses={allow("express") ? expresses : []}
      memos={memos}
      kinds={kinds}
      procedures={procOptions}
      defaultProcedureId={currentProcedureId}
      hearingCounts={Object.fromEntries(procedures.map((p) => [p.id, p.hearings.length]))}
      proceduresDetail={Object.fromEntries(
        procedures.map((p) => [
          p.id,
          { handlingAgency: p.handlingAgency, panel: p.panel, jurisdiction: p.jurisdiction }
        ])
      )}
      multiProc={multiProc}
      canManage={canManage}
    />
  );
}

// ============ 重要事项（四类统一展示）============

function ImportantItemsCard({
  matterId,
  deadlines,
  hearings,
  expresses,
  memos,
  procedures,
  defaultProcedureId,
  hearingCounts,
  proceduresDetail,
  multiProc,
  canManage,
  kinds
}: {
  kinds?: ImportantCategory[];
  matterId: string;
  deadlines: DeadlineRowItem[];
  hearings: HearingRowItem[];
  expresses: ExpressItem[];
  memos: MemoRowItem[];
  procedures: { id: string; label: string }[];
  defaultProcedureId: string;
  hearingCounts: Record<string, number>;
  proceduresDetail: Record<string, { handlingAgency?: string | null; panel?: string | null; jurisdiction?: string | null }>;
  multiProc: boolean;
  canManage: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [filter, setFilter] = useState<ImportantFilter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [addType, setAddType] = useState<ImportantCategory>("hearing");
  const [adjusting, setAdjusting] = useState<DeadlineRowItem | null>(null);

  function handleToggle(id: string) {
    startTransition(async () => {
      try {
        await toggleDeadlineCompleted(id);
      } catch {
        toast.error("操作失败");
      }
    });
  }

  async function handleDeleteDeadline(id: string) {
    if (!(await confirmDialog({ title: "删除这条期限？", description: "删除后不再提醒，操作记入审计。", confirmText: "删除", danger: true }))) return;
    startTransition(async () => {
      try {
        await deleteDeadline(id);
        toast.success("已删除");
      } catch {
        toast.error("删除失败");
      }
    });
  }

  // v1.x P0-8: 待确认期限的确认（起算事实与规则结果就此固定）
  function handleConfirmDeadline(id: string) {
    startTransition(async () => {
      try {
        await confirmDeadline({ id });
        toast.success("期限已确认");
      } catch (err) {
        toast.error("确认失败", { description: actionErrorMessage(err) });
      }
    });
  }

  // v1.x P0-8: 人工调整到期日（写已调整 + 留痕；规则重算不再覆盖）
  function handleAdjustDeadline(d: DeadlineRowItem) {
    setAdjusting(d);
  }

  async function handleDeleteHearing(id: string) {
    if (!(await confirmDialog({ title: "删除这条开庭记录？", confirmText: "删除", danger: true }))) return;
    startTransition(async () => {
      try {
        await deleteHearing(id);
        toast.success("已删除");
      } catch {
        toast.error("删除失败");
      }
    });
  }

  async function handleDeleteExpress(id: string) {
    if (!(await confirmDialog({ title: "删除这条快递记录？", confirmText: "删除", danger: true }))) return;
    startTransition(async () => {
      try {
        await deleteExpress({ id });
        toast.success("已删除");
      } catch {
        toast.error("删除失败");
      }
    });
  }

  function handleDeleteMemo(id: string) {
    startTransition(async () => {
      try {
        await deleteProcedureMemo(id);
      } catch {
        toast.error("删除失败");
      }
    });
  }

  const total = hearings.length + deadlines.length + expresses.length + memos.length;
  const allItems = buildAllImportantItems({ hearings, deadlines, expresses, memos });
  const filters: { value: ImportantFilter; label: string; count: number }[] = ([
    { value: "all", label: "全部", count: total },
    { value: "hearing", label: "开庭", count: hearings.length },
    { value: "deadline", label: "期限", count: deadlines.length },
    { value: "express", label: "快递", count: expresses.length },
    { value: "memo", label: "备忘", count: memos.length }
  ] as { value: ImportantFilter; label: string; count: number }[]).filter((f) => f.value === "all" || !kinds || kinds.includes(f.value as ImportantCategory));

  const currentCount = filters.find((f) => f.value === filter)?.count ?? 0;
  const currentLabel = filters.find((f) => f.value === filter)?.label ?? "重要事项";

  function openAddDialog() {
    setAddType(filter === "all" ? (kinds?.[0] ?? "hearing") : filter);
    setAddOpen(true);
  }

  return (
    <section className="flex max-h-[460px] min-h-[160px] flex-col card">
      <header className="panel-head shrink-0 flex-wrap">
        <span className="panel-title">
          <AlertTriangle className="ic" />
          {kinds ? kinds.map((k) => ({ hearing: "开庭", deadline: "期限", express: "快递", memo: "备忘" })[k]).join("与") : "期限、开庭与备忘"}
          <span className="mo-count">{total}</span>
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {/* 分类分段 */}
          <div className="segmented" role="tablist">
            {filters.map((f) => (
              <button
                key={f.value}
                type="button"
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cn("seg", filter === f.value && "active")}
              >
                {f.label}
                <span className="count">{f.count}</span>
              </button>
            ))}
          </div>
          {canManage && (
            <button type="button" onClick={openAddDialog} className="btn btn-secondary btn-sm">
              <Plus />
              添加
            </button>
          )}
        </div>
      </header>

      {currentCount === 0 ? (
        <p className="flex flex-1 items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground">
          {canManage ? `暂无${currentLabel}，点右上「添加」录入第一条。` : `暂无${currentLabel}。`}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto px-4 py-2">
          {filter === "hearing" &&
            hearings.map((h) => (
              <HearingRow
                key={h.id}
                h={h}
                multiProc={multiProc}
                onDelete={() => handleDeleteHearing(h.id)}
                canManage={canManage}
              />
            ))}
          {filter === "all" &&
            allItems.map((entry) => (
              <AllImportantRow
                key={`${entry.type}-${entry.id}`}
                entry={entry}
                multiProc={multiProc}
                onToggle={
                  entry.type === "deadline"
                    ? () => handleToggle(entry.item.id)
                    : undefined
                }
                onConfirm={
                  entry.type === "deadline"
                    ? () => handleConfirmDeadline(entry.item.id)
                    : undefined
                }
                onAdjust={
                  entry.type === "deadline"
                    ? () => handleAdjustDeadline(entry.item)
                    : undefined
                }
                onDelete={() => {
                  if (entry.type === "hearing") handleDeleteHearing(entry.item.id);
                  if (entry.type === "deadline") handleDeleteDeadline(entry.item.id);
                  if (entry.type === "express") handleDeleteExpress(entry.item.id);
                  if (entry.type === "memo") handleDeleteMemo(entry.item.id);
                }}
                pending={isPending}
                canManage={canManage}
              />
            ))}
          {filter === "deadline" &&
            deadlines.map((d) => (
              <DeadlineRow
                key={d.id}
                d={d}
                multiProc={multiProc}
                onToggle={() => handleToggle(d.id)}
                onDelete={() => handleDeleteDeadline(d.id)}
                onConfirm={() => handleConfirmDeadline(d.id)}
                onAdjust={() => handleAdjustDeadline(d)}
                pending={isPending}
                canManage={canManage}
              />
            ))}
          {filter === "express" &&
            expresses.map((e) => (
              <ExpressRow
                key={e.id}
                item={e}
                onDelete={() => handleDeleteExpress(e.id)}
                canManage={canManage}
              />
            ))}
          {filter === "memo" &&
            memos.map((m) => (
              <MemoRow
                key={m.id}
                memo={m}
                multiProc={multiProc}
                onDelete={() => handleDeleteMemo(m.id)}
                canManage={canManage}
              />
            ))}
        </ul>
      )}

      {canManage && (
        <ImportantItemDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          matterId={matterId}
          defaultType={addType}
          procedures={procedures}
          defaultProcedureId={defaultProcedureId}
          hearingCounts={hearingCounts}
          proceduresDetail={proceduresDetail}
        />
      )}
      {adjusting ? <AdjustDeadlineDialog deadline={adjusting} onClose={() => setAdjusting(null)} /> : null}
    </section>
  );
}

/** v1.x P0-8: 人工调整到期日（写已调整 + 留痕；规则重算不再覆盖）——日期控件 + 必填原因 */
export function AdjustDeadlineDialog({ deadline, onClose }: { deadline: { id: string; title: string; dueAt: Date }; onClose: () => void }) {
  const [date, setDate] = useState(formatIsoDate(deadline.dueAt));
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    // 落库瞬间统一上海午夜（P1-6）：不再用浏览器本地午夜，UTC 容器/异时区浏览器下口径一致
    const dueAt = new Date(`${date}T00:00:00+08:00`);
    if (!date || Number.isNaN(dueAt.getTime())) return setError("请选择调整后的到期日");
    if (!reason.trim()) return setError("请填写调整原因（将记入审计）");
    setError(null);
    startTransition(async () => {
      try {
        await adjustDeadline({ id: deadline.id, dueAt, reason: reason.trim() });
        toast.success("期限已调整");
        onClose();
      } catch (err) {
        setError(err instanceof Error ? actionErrorMessage(err) : "调整失败");
      }
    });
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !pending) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>调整到期日</DialogTitle>
          <DialogDescription>「{deadline.title}」原到期日 {formatIsoDate(deadline.dueAt)}。人工调整后标记为「已调整」，规则重算不再覆盖。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>调整后的到期日 *</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="font-mono" />
          </div>
          <div className="space-y-1.5">
            <Label>调整原因 *</Label>
            <Textarea rows={3} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="如：法院通知书载明举证期限延长至…" />
          </div>
          {error ? <div className="text-[12px] text-[var(--red)]">{error}</div> : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose} disabled={pending}>取消</Button>
          <Button onClick={submit} disabled={pending}>保存调整</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function buildAllImportantItems({
  hearings,
  deadlines,
  expresses,
  memos
}: {
  hearings: HearingRowItem[];
  deadlines: DeadlineRowItem[];
  expresses: ExpressItem[];
  memos: MemoRowItem[];
}) {
  const now = Date.now();
  const items: AllImportantItem[] = [
    ...deadlines.map((item) => ({
      id: item.id,
      type: "deadline" as const,
      sortAt: item.dueAt,
      item
    })),
    ...hearings.map((item) => ({
      id: item.id,
      type: "hearing" as const,
      sortAt: item.startsAt,
      item
    })),
    ...expresses.map((item) => ({
      id: item.id,
      type: "express" as const,
      sortAt: item.lastUpdateAt ?? item.createdAt,
      item
    })),
    ...memos.map((item) => ({
      id: item.id,
      type: "memo" as const,
      sortAt: item.createdAt,
      item
    }))
  ];

  return items.sort((a, b) => {
    const aTime = new Date(a.sortAt).getTime();
    const bTime = new Date(b.sortAt).getTime();
    const aUpcoming =
      (a.type === "deadline" && !a.item.completed) ||
      (a.type === "hearing" && aTime >= now);
    const bUpcoming =
      (b.type === "deadline" && !b.item.completed) ||
      (b.type === "hearing" && bTime >= now);

    if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
    if (aUpcoming && bUpcoming) return aTime - bTime;
    return bTime - aTime;
  });
}

function AllImportantRow({
  entry,
  multiProc,
  onToggle,
  onDelete,
  onConfirm,
  onAdjust,
  pending,
  canManage
}: {
  entry: AllImportantItem;
  multiProc: boolean;
  onToggle?: () => void;
  onDelete: () => void;
  onConfirm?: () => void;
  onAdjust?: () => void;
  pending: boolean;
  canManage: boolean;
}) {
  if (entry.type === "hearing") {
    return (
      <HearingRow
        h={entry.item}
        multiProc={multiProc}
        onDelete={onDelete}
        canManage={canManage}
      />
    );
  }
  if (entry.type === "deadline") {
    return (
      <DeadlineRow
        d={entry.item}
        multiProc={multiProc}
        onToggle={onToggle ?? (() => {})}
        onDelete={onDelete}
        onConfirm={onConfirm ?? (() => {})}
        onAdjust={onAdjust ?? (() => {})}
        pending={pending}
        canManage={canManage}
      />
    );
  }
  if (entry.type === "express") {
    return (
      <ExpressRow
        item={entry.item}
        onDelete={onDelete}
        canManage={canManage}
      />
    );
  }
  return (
    <MemoRow
      memo={entry.item}
      multiProc={multiProc}
      onDelete={onDelete}
      canManage={canManage}
    />
  );
}

// 程序标签小徽章（仅多程序时显示，标明该条属于哪个程序）
function ProcTag({ label }: { label: string }) {
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-border bg-muted/40 px-1 text-[9px] font-normal text-muted-foreground"
    >
      {label}
    </Badge>
  );
}

function DeadlineRow({
  d,
  multiProc,
  onToggle,
  onDelete,
  onConfirm,
  onAdjust,
  pending,
  canManage
}: {
  d: DeadlineRowItem;
  multiProc: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onConfirm: () => void;
  onAdjust: () => void;
  pending: boolean;
  canManage: boolean;
}) {
  const days = daysUntil(d.dueAt);
  const isOverdue = !d.completed && days < 0;
  const isWarn = !d.completed && days <= d.remindDays && days >= 0;
  return (
    <li
      className={cn(
        "group flex items-center gap-3 py-2 text-xs transition-colors",
        d.completed && "opacity-50"
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        disabled={pending || !canManage}
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
          d.completed
            ? "border-primary bg-primary text-primary-foreground"
            : "border-input hover:border-primary"
        )}
        aria-label={d.completed ? "标记未完成" : "标记完成"}
      >
        {d.completed && <Check className="h-2.5 w-2.5" />}
      </button>

      <div className="flex-1 overflow-hidden">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              "truncate text-[12.5px] font-medium",
              d.completed && "line-through text-muted-foreground"
            )}
          >
            {d.title}
          </span>
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[9px]">
            {deadlineCategoryLabel[d.category]}
          </Badge>
          {d.confirmStatus === "PENDING" && (
            <Badge className="h-5 shrink-0 bg-[var(--amber-bg)] px-1.5 text-[9px] text-[var(--amber)] hover:bg-[var(--amber-bg)]">
              待确认
            </Badge>
          )}
          {d.confirmStatus === "ADJUSTED" && (
            <Badge variant="outline" className="h-5 shrink-0 border-[var(--blue-line)] px-1.5 text-[9px] text-[var(--blue)]">
              已调整
            </Badge>
          )}
          {multiProc && <ProcTag label={d.procLabel} />}
        </div>
        {d.startFact && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">起算：{d.startFact}</div>
        )}
        {d.basis && (
          <div className="mt-0.5 text-[11px] text-muted-foreground">{d.basis}</div>
        )}
      </div>

      <div className="flex flex-col items-end gap-1 text-right">
        <div className="font-mono text-xs tabular">
          {d.completed ? (
            "已完成"
          ) : isOverdue ? (
            <span className="text-destructive">逾期 {-days}d</span>
          ) : days === 0 ? (
            <span className="text-[var(--amber)]">今天</span>
          ) : isWarn ? (
            <span className="text-[var(--amber)]">{days}d</span>
          ) : (
            <span>{days}d</span>
          )}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground tabular">
          {formatDate(new Date(d.dueAt))}
        </div>
      </div>

      {canManage && !d.completed && (
        <div className="flex shrink-0 items-center gap-1">
          {d.confirmStatus === "PENDING" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={pending}
              className="rounded border border-[var(--amber-line)] px-1.5 py-0.5 text-[10px] text-[var(--amber)] hover:bg-[var(--amber-bg)]"
              title="核对起算事实后确认该期限"
            >
              确认
            </button>
          )}
          <button
            type="button"
            onClick={onAdjust}
            disabled={pending}
            className="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-accent"
            title="调整到期日（记录原因，规则重算不再覆盖）"
          >
            调整
          </button>
        </div>
      )}

      {canManage && (
        <button
          type="button"
          onClick={onDelete}
          className="opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="删除"
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </li>
  );
}

function HearingRow({
  h,
  multiProc,
  onDelete,
  canManage
}: {
  h: HearingRowItem;
  multiProc: boolean;
  onDelete: () => void;
  canManage: boolean;
}) {
  const upcoming = new Date(h.startsAt) > new Date();
  return (
    <li className="group flex items-center gap-3 py-2 text-xs">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <Calendar className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium">{h.title}</span>
          {multiProc && <ProcTag label={h.procLabel} />}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          {h.room || h.address || h.judge
            ? [h.room, h.address, h.judge].filter(Boolean).join(" · ")
            : "未填写法庭信息"}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <Badge variant="outline" className="h-5 px-1.5 text-[9px]">
          {upcoming ? "未召开" : "已召开"}
        </Badge>
        <span className="font-mono text-[10px] tabular text-muted-foreground">
          {shMonthDayTime(h.startsAt)}
        </span>
      </div>
      {canManage && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </li>
  );
}

function ExpressRow({
  item,
  onDelete,
  canManage
}: {
  item: ExpressItem;
  onDelete: () => void;
  canManage: boolean;
}) {
  const isOutbound = item.direction === "OUTBOUND";
  return (
    <li className="group flex items-center gap-3 py-2 text-xs">
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          isOutbound
            ? "bg-[var(--amber-bg)] text-[var(--amber)]"
            : "bg-[var(--green-bg)] text-[var(--green)]"
        )}
      >
        {isOutbound ? (
          <ArrowUpFromLine className="h-3.5 w-3.5" strokeWidth={1.8} />
        ) : (
          <ArrowDownToLine className="h-3.5 w-3.5" strokeWidth={1.8} />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px] font-medium">{item.purpose}</span>
          <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[9px]">
            {isOutbound ? "寄出" : "收件"}
          </Badge>
        </div>
        <div className="mt-0.5 truncate font-mono text-[11px] tabular text-muted-foreground">
          {item.companyCode ?? "待识别"} · {item.trackingNo}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1 text-right">
        <div className="max-w-[96px] truncate text-[11px] text-foreground/80">
          {item.lastState ?? "待跟踪"}
        </div>
        <div className="font-mono text-[10px] tabular text-muted-foreground">
          {item.lastUpdateAt
            ? formatDate(new Date(item.lastUpdateAt))
            : formatDate(new Date(item.createdAt))}
        </div>
      </div>
      {canManage && (
        <button
          type="button"
          onClick={onDelete}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="删除"
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </li>
  );
}

function MemoRow({
  memo,
  multiProc,
  onDelete,
  canManage
}: {
  memo: MemoRowItem;
  multiProc: boolean;
  onDelete: () => void;
  canManage: boolean;
}) {
  return (
    <li className="group flex items-start gap-3 py-2 text-xs">
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        <StickyNote className="h-3.5 w-3.5" strokeWidth={1.8} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
          {memo.content}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {multiProc && <ProcTag label={memo.procLabel} />}
          <span className="font-mono tabular">
            {formatDate(new Date(memo.createdAt))}
          </span>
        </div>
      </div>
      {canManage && (
        <button
          type="button"
          onClick={onDelete}
          className="mt-1 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-label="删除"
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </li>
  );
}

export { ImportantItemDialog };
export type { ImportantCategory };
