"use client";

/**
 * 案件详情「邮件」页签（台账 P1-3）。
 *
 * 三件事：① 本案已归档邮件列表（发件人 / 主题 / 时间 / 附件数，按发送时间倒序）；
 * ② 点开看正文（正文可能很长，列表不取，点开再取）；
 * ③ 「粘贴邮件归档」表单——没有 IMAP 接入时的最低成本通道：
 *    subject / from / to / date / body 五个字段 + 可选 Message-ID（用于去重）。
 *
 * 约定：
 *   - 匹配与归属由服务层判定，页面只展示返回的 `matchKind / evidence`，不复制算法；
 *   - 时间展示统一 formatDateTime（上海时区），输入用 datetime-local + 上海墙钟默认值，
 *     不用 getHours() 等本地时区方法（AGENTS 交互原则④）；
 *   - 正文按纯文本渲染（whitespace-pre-wrap），项目全仓不使用 dangerouslySetInnerHTML。
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import { FileText, Loader2, Mail, Plus } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { actionErrorMessage } from "@/lib/action-error";
import { shDayKey, shTime } from "@/lib/ui/sh-time";
import { formatDateTime } from "@/lib/utils";
import {
  archiveEmail,
  getEmailDetail,
  listEmailsForMatter,
  type ArchivedEmailRow,
  type EmailDetail
} from "@/server/emails/actions";

const MATCH_KIND_LABEL: Record<string, string> = {
  MATCHED_BY_CODE: "按案号匹配",
  MATCHED_BY_PARTY: "按当事人匹配",
  MATCHED_BY_ADDRESS: "按邮箱匹配",
  MANUAL: "人工指定",
  UNMATCHED: "未匹配"
};

function nowWallClock(): string {
  const now = new Date();
  return `${shDayKey(now)}T${shTime(now)}`;
}

/** 收件人输入：逗号、分号、顿号、空白都当分隔符（用户习惯各异） */
function splitAddresses(value: string): string[] {
  return value
    .split(/[,;，；、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type FormState = {
  subject: string;
  fromAddress: string;
  fromName: string;
  to: string;
  cc: string;
  sentAt: string;
  bodyText: string;
  messageId: string;
};

function emptyForm(): FormState {
  return {
    subject: "",
    fromAddress: "",
    fromName: "",
    to: "",
    cc: "",
    sentAt: nowWallClock(),
    bodyText: "",
    messageId: ""
  };
}

export function EmailPanel({ matterId, canWrite }: { matterId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<ArchivedEmailRow[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(() => emptyForm());
  const [saving, startSaving] = useTransition();
  const [formError, setFormError] = useState("");

  const [detail, setDetail] = useState<EmailDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const next = await listEmailsForMatter(matterId);
      setRows(next);
    } catch (error) {
      setRows([]);
      setLoadError(actionErrorMessage(error));
    }
  }, [matterId]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setDetailError("");
    setDetail(null);
    try {
      setDetail(await getEmailDetail(id));
    } catch (error) {
      setDetailError(actionErrorMessage(error));
    } finally {
      setDetailLoading(false);
    }
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function openForm() {
    setForm(emptyForm());
    setFormError("");
    setFormOpen(true);
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setFormError("");
    startSaving(async () => {
      try {
        const result = await archiveEmail({
          subject: form.subject,
          fromAddress: form.fromAddress,
          fromName: form.fromName || null,
          toAddresses: splitAddresses(form.to),
          ccAddresses: splitAddresses(form.cc),
          sentAt: form.sentAt,
          bodyText: form.bodyText,
          messageId: form.messageId || null
        });

        if (result.matterId) {
          toast.success(`邮件已归档，归属 ${result.matterCode ?? "本案"}`, {
            description: result.evidence
          });
        } else {
          toast.info("邮件已归档，但未能确定归属", {
            description: `${result.evidence}。可在管理后台「待归档邮件」中人工指定。`
          });
        }

        setFormOpen(false);
        if (result.matterId === matterId) setReloadToken((token) => token + 1);
      } catch (error) {
        setFormError(actionErrorMessage(error));
      }
    });
  }

  return (
    <div className="dos-main">
      <section className="card">
        <div className="panel-head">
          <div className="panel-title">
            <Mail className="ic" strokeWidth={1.8} />
            邮件往来
            {rows ? (
              <span className="badge b-white" style={{ marginLeft: 2 }}>
                {rows.length}
              </span>
            ) : null}
          </div>
          {canWrite ? (
            <Button size="sm" variant="secondary" className="h-7 gap-1 text-[12px]" onClick={openForm}>
              <Plus className="h-3.5 w-3.5" />
              粘贴邮件归档
            </Button>
          ) : null}
        </div>

        {rows === null ? (
          <p className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在加载邮件…
          </p>
        ) : loadError ? (
          <div className="px-3 py-6 text-sm">
            <p role="alert" className="text-destructive">{loadError}</p>
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setReloadToken((token) => token + 1)}>
              重新加载
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-10 text-center">
            <Mail className="mx-auto h-6 w-6 text-muted-foreground" strokeWidth={1.6} />
            <p className="mt-2 text-sm text-muted-foreground">
              本案尚未归档邮件。把客户与法院的往来邮件粘贴进来，承办律师更换时历史沟通不会断档。
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {rows.map((row) => (
              <button
                key={row.id}
                type="button"
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/40"
                onClick={() => void openDetail(row.id)}
              >
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[var(--teal)]" strokeWidth={1.8} />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-[13px] font-medium">{row.subject || "（无主题）"}</span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                    {row.fromName ? `${row.fromName} · ` : ""}
                    {row.fromAddress} · {formatDateTime(row.sentAt)}
                  </span>
                </span>
                <Badge variant="outline" className="shrink-0 gap-1 text-[11px]">
                  <FileText className="h-3 w-3" />
                  附件 {row.attachmentCount}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 粘贴归档 */}
      <Dialog open={formOpen} onOpenChange={(open) => { if (!open && !saving) setFormOpen(false); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>粘贴邮件归档</DialogTitle>
            <DialogDescription>
              粘贴邮件的关键信息即可留档。系统会按案号、当事人与邮箱自动匹配案件；命中多个案件时不会替你决定，可在管理后台「待归档邮件」中人工指定。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="email-subject">主题</Label>
              <Input
                id="email-subject"
                value={form.subject}
                onChange={(event) => update("subject", event.target.value)}
                maxLength={500}
                required
                placeholder="如：关于（2026）沪0105民初1234号开庭安排"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email-from">发件人邮箱</Label>
                <Input
                  id="email-from"
                  type="email"
                  value={form.fromAddress}
                  onChange={(event) => update("fromAddress", event.target.value)}
                  maxLength={254}
                  required
                  placeholder="name@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email-from-name">发件人姓名（可选）</Label>
                <Input
                  id="email-from-name"
                  value={form.fromName}
                  onChange={(event) => update("fromName", event.target.value)}
                  maxLength={120}
                  placeholder="如：李思梅"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email-to">收件人（多个用逗号分隔）</Label>
                <Input
                  id="email-to"
                  value={form.to}
                  onChange={(event) => update("to", event.target.value)}
                  placeholder="a@example.com, b@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email-cc">抄送（可选）</Label>
                <Input
                  id="email-cc"
                  value={form.cc}
                  onChange={(event) => update("cc", event.target.value)}
                  placeholder="cc@example.com"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="email-sent-at">发送时间</Label>
                <Input
                  id="email-sent-at"
                  type="datetime-local"
                  value={form.sentAt}
                  onChange={(event) => update("sentAt", event.target.value)}
                  required
                />
                <p className="text-[11px] text-muted-foreground">按上海时间填写。</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email-message-id">Message-ID（可选）</Label>
                <Input
                  id="email-message-id"
                  value={form.messageId}
                  onChange={(event) => update("messageId", event.target.value)}
                  maxLength={998}
                  placeholder="用于去重，如 <abc@example.com>"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email-body">正文</Label>
              <Textarea
                id="email-body"
                value={form.bodyText}
                onChange={(event) => update("bodyText", event.target.value)}
                rows={10}
                required
                placeholder="粘贴邮件正文（含案号、当事人姓名或发件人邮箱时，系统才能自动匹配）"
              />
            </div>

            {formError ? (
              <p role="alert" className="text-sm text-destructive">{formError}</p>
            ) : null}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setFormOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "正在归档…" : "归档并匹配"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* 正文 */}
      <Dialog open={detailLoading || Boolean(detail) || Boolean(detailError)} onOpenChange={(open) => { if (!open) { setDetail(null); setDetailError(""); } }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle className="pr-6">{detail?.subject || (detailLoading ? "正在读取邮件…" : "邮件正文")}</DialogTitle>
            {detail ? (
              <DialogDescription asChild>
                <div className="space-y-1 text-[12px] text-muted-foreground">
                  <div>发件人：{detail.fromName ? `${detail.fromName} ` : ""}&lt;{detail.fromAddress}&gt;</div>
                  {detail.toAddresses.length ? <div>收件人：{detail.toAddresses.join("、")}</div> : null}
                  {detail.ccAddresses.length ? <div>抄送：{detail.ccAddresses.join("、")}</div> : null}
                  <div>
                    时间：{formatDateTime(detail.sentAt)} · 归档人：{detail.archivedByName}
                    {detail.matter ? ` · 归属：${detail.matter.internalCode ?? detail.matter.title}` : ""}
                  </div>
                  <div>
                    匹配依据：
                    {MATCH_KIND_LABEL[detail.matchKind] ?? detail.matchKind}
                    {detail.matchEvidence ? `（${detail.matchEvidence}）` : ""}
                  </div>
                </div>
              </DialogDescription>
            ) : null}
          </DialogHeader>

          {detailLoading ? (
            <p className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在加载…
            </p>
          ) : detailError ? (
            <p role="alert" className="py-4 text-sm text-destructive">{detailError}</p>
          ) : detail ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-[12.5px] leading-[1.7]">
              {detail.bodyText || "（无正文）"}
            </pre>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
