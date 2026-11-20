"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ScanLine, ScanText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
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
import { formatDateTime } from "@/lib/utils";
import { cn } from "@/lib/utils";
import {
  addDeadline,
  addHearing,
  addProcedureMemo
} from "@/server/procedures/actions";
import type { DeadlineCreateInput } from "@/server/procedures/schemas";
import { createExpress } from "@/server/express/actions";
import { parseExpressLabel } from "@/server/ai/parse-express";
import { parseSummons } from "@/server/ai/parse-summons";
import { actionErrorMessage } from "@/lib/action-error";

export type ImportantCategory = "hearing" | "deadline" | "express" | "memo";
// ============ 统一添加重要事项 ============

// importantTypeMeta / CN_NUM / toDateInput / toDateTimeInput 已抽到 ./important-item-shared
// （2026-11-20 结构治理第一层：只搬无状态部分）
import { CN_NUM, ImportantField, ProcedureSelect, importantTypeMeta, toDateInput, toDateTimeInput } from "./important-item-shared";
export function ImportantItemDialog({
  open,
  onOpenChange,
  matterId,
  defaultType,
  procedures,
  defaultProcedureId,
  hearingCounts,
  proceduresDetail,
  types = ["hearing", "deadline", "express"]
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  matterId: string;
  defaultType: ImportantCategory;
  /** 可选分类；默认不含「备忘」（2026-09-15 起备忘不再新增，等同无截止日的任务） */
  types?: ImportantCategory[];
  procedures: { id: string; label: string }[];
  defaultProcedureId: string;
  hearingCounts: Record<string, number>;
  proceduresDetail: Record<string, { handlingAgency?: string | null; panel?: string | null; jurisdiction?: string | null }>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [summonsPending, startSummons] = useTransition();
  const [expressOcrPending, startExpressOcr] = useTransition();
  const summonsRef = useRef<HTMLInputElement>(null);
  const expressRef = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<ImportantCategory>(defaultType);
  const [hearingProcedureId, setHearingProcedureId] = useState(defaultProcedureId);
  const [hearingTitle, setHearingTitle] = useState("");
  const [hearingStartsAt, setHearingStartsAt] = useState(toDateTimeInput());
  const [hearingRoom, setHearingRoom] = useState("");
  const [hearingAddress, setHearingAddress] = useState("");
  const [hearingJudge, setHearingJudge] = useState("");
  const [hearingContact, setHearingContact] = useState("");
  const [hearingNotes, setHearingNotes] = useState("");

  const [deadlineProcedureId, setDeadlineProcedureId] = useState(defaultProcedureId);
  const [deadlineTitle, setDeadlineTitle] = useState("");
  const [deadlineCategory, setDeadlineCategory] =
    useState<DeadlineCreateInput["category"]>("CUSTOM");
  const [deadlineDueAt, setDeadlineDueAt] = useState(toDateInput());
  const [deadlineBasis, setDeadlineBasis] = useState("");
  const [deadlineRemindDays, setDeadlineRemindDays] = useState(3);

  const [trackingNo, setTrackingNo] = useState("");
  const [companyCode, setCompanyCode] = useState("");
  const [direction, setDirection] = useState<"OUTBOUND" | "INBOUND">("OUTBOUND");
  const [purpose, setPurpose] = useState("");
  const [recipient, setRecipient] = useState("");
  const [recipientPhone, setRecipientPhone] = useState("");

  const [memoProcedureId, setMemoProcedureId] = useState(defaultProcedureId);
  const [memoContent, setMemoContent] = useState("");

  useEffect(() => {
    if (!open) return;
    const procId = defaultProcedureId || procedures[0]?.id || "";
    const proc = procedures.find((p) => p.id === procId);
    const count = (hearingCounts[procId] ?? 0) + 1;
    const numStr = CN_NUM[count] ?? String(count);
    setType(defaultType);
    setHearingProcedureId(procId);
    setHearingTitle(proc ? `${proc.label}第${numStr}次开庭` : "");
    setHearingStartsAt(toDateTimeInput());
    setHearingRoom("");
    setHearingAddress("");
    setHearingJudge("");
    setHearingContact("");
    setHearingNotes("");
    setDeadlineProcedureId(procId);
    setDeadlineTitle("");
    setDeadlineCategory("CUSTOM");
    setDeadlineDueAt(toDateInput());
    setDeadlineBasis("");
    setDeadlineRemindDays(3);
    setTrackingNo("");
    setCompanyCode("");
    setDirection("OUTBOUND");
    setPurpose("");
    setRecipient("");
    setRecipientPhone("");
    setMemoProcedureId(procId);
    setMemoContent("");
    if (summonsRef.current) summonsRef.current.value = "";
    if (expressRef.current) expressRef.current.value = "";
  }, [open, defaultType, defaultProcedureId, procedures, hearingCounts]);

  function autoHearingTitle(procId: string) {
    const proc = procedures.find((p) => p.id === procId);
    if (!proc) return;
    const count = (hearingCounts[procId] ?? 0) + 1;
    const numStr = CN_NUM[count] ?? String(count);
    setHearingTitle(`${proc.label}第${numStr}次开庭`);
  }

  function handleSummonsUpload(file: File) {
    startSummons(async () => {
      try {
        const fd = new FormData();
        fd.append("file", file);
        const result = await parseSummons(fd);
        if (result.hearingDate && result.hearingTime) {
          setHearingStartsAt(`${result.hearingDate}T${result.hearingTime}`);
        } else if (result.hearingDate) {
          setHearingStartsAt(`${result.hearingDate}T09:00`);
        }
        if (result.courtRoom) setHearingRoom(result.courtRoom);
        if (result.judge) setHearingJudge(result.judge);
        if (result.caseNumber || result.parties) {
          const parts: string[] = [];
          if (result.caseNumber) parts.push(`案号：${result.caseNumber}`);
          if (result.parties?.length) parts.push(`当事人：${result.parties.join("、")}`);
          setHearingNotes(parts.join("\n"));
        }
        toast.success("传票识别完成，请核对信息");
      } catch (err) {
        toast.error("传票识别失败", {
          description: err instanceof Error ? actionErrorMessage(err) : "请手动填写"
        });
      } finally {
        if (summonsRef.current) summonsRef.current.value = "";
      }
    });
  }

  function handleExpressOcr(file: File) {
    startExpressOcr(async () => {
      try {
        const fd = new FormData();
        fd.set("file", file);
        const result = await parseExpressLabel(fd);
        if (result.trackingNo) {
          setTrackingNo(result.trackingNo);
          toast.success(`已识别单号：${result.trackingNo}`);
        } else {
          toast.warning("未识别到单号，请手动输入");
        }
        if (result.companyCode) setCompanyCode(result.companyCode);
      } catch (err) {
        toast.error("识别失败", {
          description: actionErrorMessage(err)
        });
      } finally {
        if (expressRef.current) expressRef.current.value = "";
      }
    });
  }

  function submitHearing() {
    if (!hearingProcedureId) {
      toast.error("请先选择所处程序");
      return;
    }
    if (!hearingTitle.trim()) {
      toast.error("请填写开庭主题");
      return;
    }
    const startsAt = new Date(`${hearingStartsAt}:00+08:00`);
    if (Number.isNaN(startsAt.getTime())) {
      toast.error("请填写有效开庭时间");
      return;
    }
    startTransition(async () => {
      try {
        const created = await addHearing({
          procedureId: hearingProcedureId,
          title: hearingTitle.trim(),
          startsAt,
          endsAt: undefined,
          room: hearingRoom.trim(),
          address: hearingAddress.trim(),
          judge: hearingJudge.trim(),
          contact: hearingContact.trim(),
          notes: hearingNotes.trim()
        });
        // 2026-11-21 排期冲突：**警告但不拦截**——开庭时间由法院定。
        // 用 warning 而不是 error：录入是成功的，只是提示律师核对行程。
        if (created.conflicts.length > 0) {
          const first = created.conflicts[0];
          const more = created.conflicts.length > 1 ? `等 ${created.conflicts.length} 项` : "";
          toast.warning("该时段已有其他开庭", {
            duration: 8000,
            description: `${formatDateTime(first.startsAt)}–${formatDateTime(first.endsAt)}${first.estimated ? "（结束时间为估算）" : ""} · ${first.matterCode} ${first.title}${more}。开庭时间由法院确定，请自行核对行程与路程。`
          });
        } else {
          toast.success("开庭安排已添加");
        }
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("添加失败", {
          description: actionErrorMessage(err)
        });
      }
    });
  }

  function submitDeadline() {
    if (!deadlineProcedureId) {
      toast.error("请先选择所处程序");
      return;
    }
    if (!deadlineTitle.trim()) {
      toast.error("请填写期限名称");
      return;
    }
    const dueAt = new Date(`${deadlineDueAt}T00:00+08:00`);
    if (Number.isNaN(dueAt.getTime())) {
      toast.error("请填写有效到期日");
      return;
    }
    startTransition(async () => {
      try {
        await addDeadline({
          procedureId: deadlineProcedureId,
          title: deadlineTitle.trim(),
          category: deadlineCategory,
          dueAt,
          basis: deadlineBasis.trim(),
          remindDays: deadlineRemindDays
        });
        toast.success("期限已添加");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("添加失败", {
          description: actionErrorMessage(err)
        });
      }
    });
  }

  function submitExpress() {
    if (!trackingNo.trim()) {
      toast.error("请填写或识别快递单号");
      return;
    }
    if (!purpose.trim()) {
      toast.error("请填写快递用途");
      return;
    }
    startTransition(async () => {
      try {
        await createExpress({
          trackingNo: trackingNo.trim(),
          companyCode: companyCode.trim(),
          direction,
          matterId,
          purpose: purpose.trim(),
          recipient: recipient.trim(),
          recipientPhone: recipientPhone.trim()
        });
        toast.success("快递记录已添加");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("添加失败", {
          description: actionErrorMessage(err)
        });
      }
    });
  }

  function submitMemo() {
    if (!memoProcedureId) {
      toast.error("请先选择所处程序");
      return;
    }
    if (!memoContent.trim()) {
      toast.error("请填写备忘内容");
      return;
    }
    startTransition(async () => {
      try {
        await addProcedureMemo({
          procedureId: memoProcedureId,
          content: memoContent.trim()
        });
        toast.success("其他备忘已添加");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("添加失败", {
          description: actionErrorMessage(err)
        });
      }
    });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (type === "hearing") submitHearing();
    if (type === "deadline") submitDeadline();
    if (type === "express") submitExpress();
    if (type === "memo") submitMemo();
  }

  const needsProcedure = type !== "express";
  const procedureMissing = needsProcedure && procedures.length === 0;
  const submitLabel = `添加${importantTypeMeta[type].label}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle>{types.includes("express") && types.length === 1 ? "添加记录 · 快递" : "添加事项"}</DialogTitle>
          <DialogDescription className="text-xs">
            {types.includes("express") && types.length === 1 ? "填写快递单号与用途，物流状态由接口更新" : "选择分类后填写信息；开庭与期限同时进入日程与提醒"}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-1 flex-col overflow-hidden">
          <div className="border-b border-border px-6 py-3">
            <div className={cn("grid gap-2", types.length > 2 ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2")}>
              {types.map((key) => {
                const Icon = importantTypeMeta[key].icon;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setType(key)}
                    className={cn(
                      "flex h-9 items-center justify-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                      type === key
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {importantTypeMeta[key].label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-6 py-5">
            {procedureMissing && (
              <div className="rounded-md border border-[var(--amber-line)] bg-[var(--amber-bg)] px-3 py-2 text-xs text-[var(--amber)]">
                请先添加案件程序后，再录入开庭安排、重要时限或其他备忘。
              </div>
            )}

            {type === "hearing" && (
              <>
                <div className="flex items-center gap-2">
                  <input
                    ref={summonsRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/heic"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleSummonsUpload(file);
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    disabled={summonsPending || procedureMissing}
                    onClick={() => summonsRef.current?.click()}
                  >
                    {summonsPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ScanText className="h-3.5 w-3.5" />
                    )}
                    {summonsPending ? "识别中…" : "上传传票识别"}
                  </Button>
                  <span className="text-[11px] text-muted-foreground">
                    上传传票照片，自动填充开庭信息
                  </span>
                </div>
                <ImportantField label="主题" required>
                  <Input
                    value={hearingTitle}
                    onChange={(e) => setHearingTitle(e.target.value)}
                    placeholder="如：第一次开庭"
                    disabled={procedureMissing}
                  />
                </ImportantField>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ImportantField label="所处程序" required>
                    <ProcedureSelect
                      value={hearingProcedureId}
                      procedures={procedures}
                      disabled={procedureMissing}
                      onChange={(value) => {
                        setHearingProcedureId(value);
                        autoHearingTitle(value);
                      }}
                    />
                  </ImportantField>
                  <ImportantField label="审理法院">
                    <Input
                      readOnly
                      value={proceduresDetail[hearingProcedureId]?.handlingAgency ?? "—"}
                      className="bg-muted/50 text-muted-foreground"
                    />
                  </ImportantField>
                  <ImportantField label="开庭时间" required>
                    <Input
                      type="datetime-local"
                      value={hearingStartsAt}
                      onChange={(e) => setHearingStartsAt(e.target.value)}
                      disabled={procedureMissing}
                    />
                  </ImportantField>
                  <ImportantField label="法庭">
                    <Input
                      value={hearingRoom}
                      onChange={(e) => setHearingRoom(e.target.value)}
                      placeholder="如：第三法庭"
                      disabled={procedureMissing}
                    />
                  </ImportantField>
                  <ImportantField label="主审 / 仲裁员">
                    <Input
                      value={hearingJudge}
                      onChange={(e) => setHearingJudge(e.target.value)}
                      disabled={procedureMissing}
                    />
                  </ImportantField>
                  <ImportantField label="联系方式">
                    <Input
                      value={hearingContact}
                      onChange={(e) => setHearingContact(e.target.value)}
                      placeholder="法官/书记员电话"
                      disabled={procedureMissing}
                    />
                  </ImportantField>
                </div>
                <ImportantField label="开庭地址">
                  <Input
                    value={hearingAddress}
                    onChange={(e) => setHearingAddress(e.target.value)}
                    placeholder="如：XX路XX号XX法院"
                    disabled={procedureMissing}
                  />
                </ImportantField>
                <ImportantField label="备注">
                  <Textarea
                    rows={4}
                    value={hearingNotes}
                    onChange={(e) => setHearingNotes(e.target.value)}
                    disabled={procedureMissing}
                  />
                </ImportantField>
              </>
            )}

            {type === "deadline" && (
              <>
                <ImportantField label="所处程序" required>
                  <ProcedureSelect
                    value={deadlineProcedureId}
                    procedures={procedures}
                    disabled={procedureMissing}
                    onChange={setDeadlineProcedureId}
                  />
                </ImportantField>
                <ImportantField label="期限名称" required>
                  <Input
                    value={deadlineTitle}
                    onChange={(e) => setDeadlineTitle(e.target.value)}
                    placeholder="如：举证截止 / 上诉到期日"
                    disabled={procedureMissing}
                  />
                </ImportantField>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ImportantField label="期限类型">
                    <Select
                      value={deadlineCategory}
                      onValueChange={(value) =>
                        setDeadlineCategory(value as DeadlineCreateInput["category"])
                      }
                      disabled={procedureMissing}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(deadlineCategoryLabel).map(([key, label]) => (
                          <SelectItem key={key} value={key}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </ImportantField>
                  <ImportantField label="到期日" required>
                    <Input
                      type="date"
                      value={deadlineDueAt}
                      onChange={(e) => setDeadlineDueAt(e.target.value)}
                      disabled={procedureMissing}
                    />
                  </ImportantField>
                </div>
                <ImportantField label="计算依据">
                  <Input
                    value={deadlineBasis}
                    onChange={(e) => setDeadlineBasis(e.target.value)}
                    placeholder="如：判决书送达日 2026-05-01 + 15 日"
                    disabled={procedureMissing}
                  />
                </ImportantField>
                <ImportantField label="提前提醒（天）">
                  <Input
                    type="number"
                    min={0}
                    max={60}
                    className="font-mono tabular"
                    value={deadlineRemindDays}
                    onChange={(e) => setDeadlineRemindDays(Number(e.target.value))}
                    disabled={procedureMissing}
                  />
                </ImportantField>
              </>
            )}

            {type === "express" && (
              <>
                <ImportantField label="单号" required>
                  <div className="flex gap-1">
                    <Input
                      value={trackingNo}
                      onChange={(e) => setTrackingNo(e.target.value)}
                      placeholder="可手动输入或上传图片识别"
                      className="font-mono"
                    />
                    <input
                      ref={expressRef}
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) handleExpressOcr(file);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => expressRef.current?.click()}
                      disabled={expressOcrPending}
                      className="h-9 shrink-0 gap-1"
                    >
                      {expressOcrPending ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <ScanLine className="h-3 w-3" />
                      )}
                      识别
                    </Button>
                  </div>
                </ImportantField>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ImportantField label="快递公司">
                    <Input
                      value={companyCode}
                      onChange={(e) => setCompanyCode(e.target.value)}
                      placeholder="留空则自动识别"
                    />
                  </ImportantField>
                  <ImportantField label="方向">
                    <Select
                      value={direction}
                      onValueChange={(value) => setDirection(value as "OUTBOUND" | "INBOUND")}
                    >
                      <SelectTrigger className="bg-background">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="OUTBOUND">寄出（我方→外）</SelectItem>
                        <SelectItem value="INBOUND">收件（外→我方）</SelectItem>
                      </SelectContent>
                    </Select>
                  </ImportantField>
                </div>
                <ImportantField label="用途" required>
                  <Input
                    value={purpose}
                    onChange={(e) => setPurpose(e.target.value)}
                    placeholder="如：起诉状寄朝阳法院"
                  />
                </ImportantField>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <ImportantField label="收件人 / 单位">
                    <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
                  </ImportantField>
                  <ImportantField label="收件电话">
                    <Input
                      value={recipientPhone}
                      onChange={(e) => setRecipientPhone(e.target.value)}
                      className="font-mono"
                    />
                  </ImportantField>
                </div>
              </>
            )}

            {type === "memo" && (
              <>
                <ImportantField label="所处程序" required>
                  <ProcedureSelect
                    value={memoProcedureId}
                    procedures={procedures}
                    disabled={procedureMissing}
                    onChange={setMemoProcedureId}
                  />
                </ImportantField>
                <ImportantField label="备忘内容" required>
                  <Textarea
                    rows={6}
                    value={memoContent}
                    onChange={(e) => setMemoContent(e.target.value)}
                    placeholder="输入备忘内容..."
                    disabled={procedureMissing}
                  />
                </ImportantField>
              </>
            )}
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={isPending || summonsPending || expressOcrPending || procedureMissing}
              className="gap-1.5"
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}


