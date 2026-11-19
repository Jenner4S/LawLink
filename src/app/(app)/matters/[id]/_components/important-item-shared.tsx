"use client";

/**
 * 重要事项对话框的共享常量与无状态工具（2026-11-20 拆出）。
 *
 * 从 important-item-dialog.tsx（769 行）抽出的第一层：
 * 只搬「无状态、无业务分支」的部分——类型元数据、中文序号、上海墙钟转换。
 * 这样对话框本身能少 30 行，且这些工具未来可被别的入口复用
 * （如工作台的事项卡也要按类型显示标签与图标）。
 *
 * 没有一次抽到底（四个表单区块 hearing/deadline/express/memo 各 70-110 行）
 * 的原因：那四块共享对话框的 23 个 useState。强行按表单切成组件，
 * 会产生「十几个 props 的组件」——那是把一个大文件换成四个难用的组件，
 * 不是变好。真要拆必须先重构状态结构（按类分组或 useReducer），
 * 属于另一件事，不宜在结构治理里顺手做。
 */
import { AlertTriangle, Gavel, Package, StickyNote } from "lucide-react";
import { shDayKey, shTime } from "@/lib/ui/sh-time";
import type { ImportantCategory } from "./important-item-dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const importantTypeMeta: Record<ImportantCategory, { label: string; icon: React.ElementType }> = {
  hearing: { label: "开庭", icon: Gavel },
  deadline: { label: "期限", icon: AlertTriangle },
  express: { label: "快递", icon: Package },
  memo: { label: "备忘", icon: StickyNote }
};

export const CN_NUM: Record<number, string> = {
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
  6: "六",
  7: "七",
  8: "八",
  9: "九",
  10: "十"
};

/** 输入框值是上海墙钟；默认「现在的上海日期/时刻」，解析统一按 +08:00 固定偏移 */
export function toDateInput(date = new Date()) {
  return shDayKey(date);
}

export function toDateTimeInput(date = new Date()) {
  return `${shDayKey(date)}T${shTime(date)}`;
}

export function ProcedureSelect({
  value,
  procedures,
  disabled,
  onChange
}: {
  value: string;
  procedures: { id: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder="选择所处程序" />
      </SelectTrigger>
      <SelectContent>
        {procedures.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ImportantField({
  label,
  required,
  children
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-xs">
        {label}
        {required && <span className="text-destructive">*</span>}
      </Label>
      {children}
    </div>
  );
}
