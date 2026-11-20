"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, PieChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { setCommissionPlan } from "@/server/finance/actions";
import { actionErrorMessage } from "@/lib/action-error";

type Row = { userId: string; percent: string; label: string };
type PlanRow = { id: string; percent: number; label: string | null; userId: string; user?: { id: string; name: string } | null };

/**
 * 分成方案设置（2026-11-20）
 *
 * `setCommissionPlan` 一直存在但零引用——**分成方案在界面上配不了**。
 * 结果是：分成必须从实收派生（`CommissionPlan` 是派生依据），
 * 没配方案的案件就不派生分成；而律师要配，只能靠脚本或直接改库。
 *
 * 服务端口径（不在这里重复实现）：
 *   · 仅 `finance.write` + **案件主办/协办**可设置（assertCanLeadMatter）
 *   · **整体替换**：先删光再建（不是增量），所以本对话框提交的是完整方案
 *   · 比例合计 ≤ 100（服务端硬校验，前端只做即时提示）
 *
 * 页面侧按 `canWrite` 决定是否显示入口，服务端仍独立校验。
 */
export function CommissionPlanDialog({
  open,
  onOpenChange,
  matterId,
  userOptions,
  currentPlans
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  matterId: string;
  userOptions: { id: string; name: string }[];
  currentPlans: PlanRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!open) return;
    setRows(
      currentPlans.length
        ? currentPlans.map((p) => ({
            userId: p.userId ?? p.user?.id ?? "",
            percent: String(Number(p.percent)),
            label: p.label ?? ""
          }))
        : [{ userId: "", percent: "", label: "" }]
    );
  }, [open, currentPlans]);

  const total = rows.reduce((sum, r) => {
    const v = Number(r.percent);
    return sum + (Number.isFinite(v) ? v : 0);
  }, 0);
  const over = total > 100 + 1e-8;

  const submit = () => {
    const items = rows
      .filter((r) => r.userId && r.percent.trim() !== "")
      .map((r) => ({
        userId: r.userId,
        percent: Number(r.percent),
        label: r.label.trim() || ""
      }));

    if (items.length === 0) {
      toast.error("至少填一行分成");
      return;
    }
    if (over) {
      toast.error("分成比例合计不得超过 100%");
      return;
    }
    if (items.some((i) => !Number.isFinite(i.percent) || i.percent < 0)) {
      toast.error("比例必须是非负数字");
      return;
    }

    startTransition(async () => {
      try {
        await setCommissionPlan({ matterId, items });
        toast.success("分成方案已保存");
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
          <DialogTitle className="flex items-center gap-1.5">
            <PieChart className="h-4 w-4" />
            分成方案
          </DialogTitle>
          <DialogDescription className="text-xs">
            保存后**整体替换**本案现有方案；分成从已确认实收按比例派生。合计不得超过 100%。
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label className="text-[11px]">成员</Label>
                  <Select
                    value={r.userId || undefined}
                    onValueChange={(v) =>
                      setRows((prev) => prev.map((x, j) => (j === i ? { ...x, userId: v } : x)))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择成员" />
                    </SelectTrigger>
                    <SelectContent>
                      {userOptions.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-24 space-y-1">
                  <Label className="text-[11px]">比例%</Label>
                  <Input
                    value={r.percent}
                    inputMode="decimal"
                    placeholder="0"
                    onChange={(e) =>
                      setRows((prev) => prev.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)))
                    }
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label className="text-[11px]">说明</Label>
                  <Input
                    value={r.label}
                    maxLength={40}
                    placeholder="案源/承办"
                    onChange={(e) =>
                      setRows((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
                    }
                  />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mb-0.5"
                  onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}
                  title="删除此行"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1 text-xs"
            onClick={() => setRows((prev) => [...prev, { userId: "", percent: "", label: "" }])}
          >
            <Plus className="h-3 w-3" /> 增加一行
          </Button>
          <p className={over ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
            合计 {total.toFixed(2)}%{over ? "（超过 100%，无法保存）" : ""}
          </p>
        </FormDialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button onClick={submit} disabled={isPending || over}>
            {isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
