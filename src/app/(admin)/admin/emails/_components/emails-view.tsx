"use client";

/**
 * 管理后台「邮件归档」视图（台账 P1-3）。
 *
 * 左侧（主栏）是待归档队列：未匹配邮件 + 系统候选建议 + 人工指定归属；
 * 右侧是一张内联的「粘贴邮件归档」表单——没有 IMAP 时的最低成本通道。
 *
 * 约定：
 *   - 候选建议只做**展示**，点击后先打开确认弹窗再提交，避免误点把邮件挂到错误案件；
 *   - 不复制匹配算法：`matchEvidence` 与 `suggestions` 都来自服务层；
 *   - 时间统一 `formatDateTime`（上海时区），输入用 datetime-local + 上海墙钟默认值。
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Link2, Mail, Plus } from "lucide-react";
import { toast } from "sonner";

import { MatterCombobox } from "@/app/(app)/approvals/seals/_components/matter-combobox";
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
import { AdminPageHeader } from "@/components/layout/admin-page-header";
import { actionErrorMessage } from "@/lib/action-error";
import { shDayKey, shTime } from "@/lib/ui/sh-time";
import { formatDateTime } from "@/lib/utils";
import {
  archiveEmail,
  linkEmailToMatter,
  type LinkableMatter,
  type UnmatchedEmailRow
} from "@/server/emails/actions";

function nowWallClock(): string {
  const now = new Date();
  return `${shDayKey(now)}T${shTime(now)}`;
}

function splitAddresses(value: string): string[] {
  return value
    .split(/[,;，；、\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type PasteForm = {
  subject: string;
  fromAddress: string;
  fromName: string;
  to: string;
  cc: string;
  sentAt: string;
  bodyText: string;
  messageId: string;
};

function emptyForm(): PasteForm {
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

export function EmailsAdminView({ rows, matters }: { rows: UnmatchedEmailRow[]; matters: LinkableMatter[] }) {
  const router = useRouter();
  const [form, setForm] = useState<PasteForm>(() => emptyForm());
  const [formError, setFormError] = useState("");
  const [saving, startSaving] = useTransition();

  const [linking, setLinking] = useState<UnmatchedEmailRow | null>(null);
  const [linkMatterId, setLinkMatterId] = useState("");
  const [linkError, setLinkError] = useState("");
  const [linkPending, startLink] = useTransition();

  function update<K extends keyof PasteForm>(key: K, value: PasteForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function submitPaste(event: React.FormEvent) {
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
          toast.success(`邮件已归档，归属 ${result.matterCode ?? "案件"}`, { description: result.evidence });
        } else {
          toast.info("邮件已归档，但未能确定归属", {
            description: `${result.evidence}。已进入本页待归档队列。`
          });
        }
        setForm(emptyForm());
        router.refresh();
      } catch (error) {
        setFormError(actionErrorMessage(error));
      }
    });
  }

  function openLink(row: UnmatchedEmailRow, presetMatterId = "") {
    setLinking(row);
    setLinkMatterId(presetMatterId);
    setLinkError("");
  }

  function submitLink(event: React.FormEvent) {
    event.preventDefault();
    if (!linking) return;
    setLinkError("");
    startLink(async () => {
      try {
        await linkEmailToMatter({ id: linking.id, matterId: linkMatterId });
        toast.success("已指定归属", { description: "邮件已挂到所选案件，匹配方式记为人工指定。" });
        setLinking(null);
        router.refresh();
      } catch (error) {
        setLinkError(actionErrorMessage(error));
      }
    });
  }

  const comboboxMatters = matters.map((matter) => ({
    id: matter.id,
    internalCode: matter.internalCode ?? "（无编号）",
    title: matter.title
  }));

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title="邮件归档"
        sub={
          <>
            <b>{rows.length}</b> 封待归档邮件。系统按案号、当事人、发件人邮箱给出归属建议；命中多个案件时不替你决定，在此人工指定。
          </>
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <section className="rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Mail className="h-4 w-4 text-[var(--teal)]" strokeWidth={1.8} />
            <h2 className="text-[13.5px] font-semibold">待归档邮件</h2>
            <Badge variant="outline">{rows.length}</Badge>
          </div>

          {rows.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <Mail className="mx-auto h-6 w-6 text-muted-foreground" strokeWidth={1.6} />
              <p className="mt-2 text-sm text-muted-foreground">
                暂无待归档邮件。用右侧表单粘贴一封邮件，或律师在案件详情「邮件」页签归档时未匹配的邮件会出现在这里。
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {rows.map((row) => (
                <li key={row.id} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="line-clamp-1 text-[13px] font-medium">{row.subject || "（无主题）"}</p>
                      <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                        {row.fromName ? `${row.fromName} · ` : ""}
                        {row.fromAddress} · {formatDateTime(row.sentAt)} · 归档人 {row.archivedByName}
                      </p>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--amber)]">
                        {row.matchEvidence ?? "未匹配"}
                      </p>
                      {row.suggestions.length > 0 ? (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground">候选：</span>
                          {row.suggestions.map((suggestion) => (
                            <button
                              key={suggestion.id}
                              type="button"
                              className="rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors hover:border-[var(--teal-line)] hover:text-[var(--teal-deep)]"
                              title="点击后在确认弹窗中指定"
                              onClick={() => openLink(row, suggestion.id)}
                            >
                              {suggestion.label}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1 text-[12px]" onClick={() => openLink(row)}>
                      <Link2 className="h-3.5 w-3.5" />
                      指定归属
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Plus className="h-4 w-4 text-[var(--teal)]" strokeWidth={1.8} />
            <h2 className="text-[13.5px] font-semibold">粘贴邮件归档</h2>
          </div>
          <form onSubmit={submitPaste} className="space-y-3 p-4">
            <div className="space-y-1.5">
              <Label htmlFor="admin-email-subject">主题</Label>
              <Input
                id="admin-email-subject"
                value={form.subject}
                onChange={(event) => update("subject", event.target.value)}
                maxLength={500}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-from">发件人邮箱</Label>
              <Input
                id="admin-email-from"
                type="email"
                value={form.fromAddress}
                onChange={(event) => update("fromAddress", event.target.value)}
                maxLength={254}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-from-name">发件人姓名（可选）</Label>
              <Input
                id="admin-email-from-name"
                value={form.fromName}
                onChange={(event) => update("fromName", event.target.value)}
                maxLength={120}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-to">收件人（多个用逗号分隔）</Label>
              <Input
                id="admin-email-to"
                value={form.to}
                onChange={(event) => update("to", event.target.value)}
                placeholder="a@example.com, b@example.com"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-cc">抄送（可选）</Label>
              <Input
                id="admin-email-cc"
                value={form.cc}
                onChange={(event) => update("cc", event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-sent-at">发送时间</Label>
              <Input
                id="admin-email-sent-at"
                type="datetime-local"
                value={form.sentAt}
                onChange={(event) => update("sentAt", event.target.value)}
                required
              />
              <p className="text-[11px] text-muted-foreground">按上海时间填写。</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-body">正文</Label>
              <Textarea
                id="admin-email-body"
                value={form.bodyText}
                onChange={(event) => update("bodyText", event.target.value)}
                rows={8}
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="admin-email-message-id">Message-ID（可选，用于去重）</Label>
              <Input
                id="admin-email-message-id"
                value={form.messageId}
                onChange={(event) => update("messageId", event.target.value)}
                maxLength={998}
              />
            </div>

            {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}

            <Button type="submit" disabled={saving} className="w-full">
              {saving ? "正在归档…" : "归档并匹配"}
            </Button>
          </form>
        </section>
      </div>

      <Dialog open={Boolean(linking)} onOpenChange={(open) => { if (!open && !linkPending) setLinking(null); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>指定邮件归属</DialogTitle>
            <DialogDescription>
              {linking ? `「${linking.subject || "（无主题）"}」 · 发件人 ${linking.fromAddress}` : ""}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitLink} className="space-y-4">
            {linking?.suggestions.length ? (
              <div className="space-y-1.5">
                <Label>系统候选</Label>
                <div className="flex flex-wrap gap-1.5">
                  {linking.suggestions.map((suggestion) => (
                    <button
                      key={suggestion.id}
                      type="button"
                      className="rounded-full border px-2.5 py-1 font-mono text-[11.5px] transition-colors hover:border-[var(--teal-line)]"
                      onClick={() => setLinkMatterId(suggestion.id)}
                    >
                      {suggestion.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <Label>归属案件</Label>
              <MatterCombobox matters={comboboxMatters} value={linkMatterId} onChange={setLinkMatterId} />
              {comboboxMatters.length === 0 ? (
                <p className="text-xs text-muted-foreground">当前没有可见的案件可选。</p>
              ) : null}
            </div>

            {linkError ? <p role="alert" className="text-sm text-destructive">{linkError}</p> : null}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={linkPending} onClick={() => setLinking(null)}>
                取消
              </Button>
              <Button type="submit" disabled={linkPending || !linkMatterId}>
                {linkPending ? "正在指定…" : "确认归属"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
