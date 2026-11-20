"use client";

import { Hourglass, XCircle, Archive } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ArchiveStatus = "PENDING_REVIEW" | "REJECTED" | "APPROVED";

interface ArchiveRecord {
  id: string;
  archiveNo: string;
  status: ArchiveStatus;
  reviewedAt: Date | null;
  reviewNote: string | null;
  archivedBy: string;
  missingItems: string[];
}

interface Props {
  record: ArchiveRecord | null;
  onReArchive?: () => void;
}

export function ArchiveStatusBanner({ record, onReArchive }: Props) {
  // 2026-11-21：已归档也要有提示。
  //
  // 归档材料收紧之后（归档取阅需借阅），用户在材料区点下载会被拒；
  // 若页面一句解释都没有，他只会以为"系统坏了"。
  // 这条 banner 就是那条可走的路：告诉他为什么、去哪儿申请。
  if (record && record.status === "APPROVED") {
    return (
      <div className="flex items-start gap-3 rounded-[10px] border border-[var(--line)] bg-[var(--surface-sunken,rgba(0,0,0,.02))] px-4 py-3">
        <Archive className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t-muted)]" />
        <div className="min-w-0 text-[12px] leading-relaxed">
          <span className="font-medium">本案已归档（{record.archiveNo}）· 只读</span>
          <span className="ml-1 text-[var(--t-muted)]">
            材料取阅需申请借阅（限时、留痕、可归还）。
          </span>
          <a className="ml-1 underline" href="/archive#borrow">
            去「案卷借阅」申请
          </a>
        </div>
      </div>
    );
  }
  if (!record) return null;

  const isRejected = record.status === "REJECTED";

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-[10px] border px-4 py-3",
        isRejected
          ? "border-[var(--red-line)] bg-[var(--red-bg)]"
          : "border-[var(--bronze-line)] bg-[var(--bronze-bg)]"
      )}
    >
      <div className={cn("mt-0.5", isRejected ? "text-[var(--red)]" : "text-[var(--bronze)]")}>
        {isRejected ? <XCircle className="h-4 w-4" /> : <Hourglass className="h-4 w-4" />}
      </div>
      <div className="flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <span className={cn("text-sm font-medium", isRejected ? "text-[var(--red)]" : "text-[var(--bronze)]")}>
            {isRejected ? "归档申请被驳回" : "归档申请审批中"}
          </span>
          <Badge
            variant="outline"
            className={cn(
              "text-[10px]",
              isRejected
                ? "border-[var(--red-line)] text-[var(--red)]"
                : "border-[var(--bronze-line)] text-[var(--bronze)]"
            )}
          >
            {record.archiveNo}
          </Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          {isRejected
            ? record.reviewNote
              ? `驳回原因：${record.reviewNote}`
              : "管理员未填写驳回原因"
            : "归档申请已提交，等待有归档审批权限的人员审批；审批通过后案件转为只读。"}
        </div>
        {isRejected && record.missingItems.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            上次缺项：{record.missingItems.join("、")}
          </div>
        )}
      </div>
      {isRejected && onReArchive && (
        <button
          type="button"
          onClick={onReArchive}
          className="mt-0.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted/80"
        >
          <Archive className="h-3 w-3" />
          重新归档
        </button>
      )}
    </div>
  );
}
