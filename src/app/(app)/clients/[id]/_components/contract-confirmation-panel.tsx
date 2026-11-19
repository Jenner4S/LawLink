"use client";

/**
 * 合同确认留痕（P1-4 降级实现）—— 律师侧面板。
 *
 * 合规文案纪律（硬要求）：
 *   - 列名用「确认状态」，按钮用「确认 / 阅知」，不出现「签署 / 签名 / 签订」；
 *   - 显著提示：本功能不构成电子签名，不能替代签字盖章；
 *   - token 明文只在创建/重新生成的那一刻返回一次，库中只有 SHA-256，
 *     因此「复制链接」只能重新生成，不能找回旧链接。
 *
 * 客户详情页与案件「委托与财务」页签共用此面板。
 */
import { useCallback, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCopy, FileCheck2, Loader2, Plus, RefreshCcw, ShieldAlert, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { actionErrorMessage } from "@/lib/action-error";
import { CONTRACT_CONFIRMATION_DISCLAIMER } from "@/server/contracts/compliance";
import { formatDateTime } from "@/lib/utils";
import {
  createContractConfirmation,
  listContractConfirmations,
  listEngagementsForConfirmation,
  regenerateContractConfirmation,
  revokeContractConfirmation
} from "@/server/contracts/actions";

type ConfirmationStatus = "PENDING" | "CONFIRMED" | "EXPIRED" | "REVOKED";

export type ContractConfirmationRow = {
  id: string;
  status: ConfirmationStatus;
  createdAt: Date | string;
  expiresAt: Date | string;
  confirmedAt: Date | string | null;
  confirmedIp: string | null;
  confirmedUa: string | null;
  confirmerName: string | null;
  contentHash: string;
  contentLength: number;
  revokedAt: Date | string | null;
  revokedReason: string | null;
  engagementId: string | null;
  engagementTitle: string | null;
  createdByName: string | null;
};

const STATUS_LABEL: Record<ConfirmationStatus, string> = {
  PENDING: "待确认",
  CONFIRMED: "已确认",
  EXPIRED: "已过期",
  REVOKED: "已撤销"
};

const STATUS_TONE: Record<ConfirmationStatus, string> = {
  PENDING: "border-[#D8C79A] bg-[#FBF6E9] text-[#6B5218]",
  CONFIRMED: "border-[#B7D8D6] bg-[#E4F1F0] text-[#005054]",
  EXPIRED: "border-border bg-muted text-muted-foreground",
  REVOKED: "border-[#E3C4C4] bg-[#FBEDED] text-[#8A2C2C]"
};

const fmt = (v: Date | string | null) => (v ? formatDateTime(new Date(v)) : "—");

export function ContractConfirmationPanel({
  clientId,
  matterId,
  canManage
}: {
  clientId: string;
  matterId?: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<ContractConfirmationRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "revoke" | "link" | null>(null);
  const [isPending, startTransition] = useTransition();

  // 创建表单
  const [content, setContent] = useState("");
  const [days, setDays] = useState("7");
  const [engagementId, setEngagementId] = useState("");
  const [engagements, setEngagements] = useState<{ id: string; title: string }[]>([]);

  // 撤销
  const [revokeTarget, setRevokeTarget] = useState<ContractConfirmationRow | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  // 链接结果 / 重新生成
  const [linkInfo, setLinkInfo] = useState<{ url: string; expiresAt: Date | string } | null>(null);
  const [linkTarget, setLinkTarget] = useState<ContractConfirmationRow | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listContractConfirmations(
        matterId ? { clientId, matterId } : { clientId }
      );
      setRows(data as ContractConfirmationRow[]);
      setLoadError(null);
    } catch (err) {
      setLoadError(actionErrorMessage(err));
    }
  }, [clientId, matterId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (dialog !== "create") return;
    let cancelled = false;
    listEngagementsForConfirmation(clientId)
      .then((list) => { if (!cancelled) setEngagements(list); })
      .catch(() => { if (!cancelled) setEngagements([]); });
    return () => { cancelled = true; };
  }, [dialog, clientId]);

  const absoluteUrl = useMemo(() => {
    if (!linkInfo) return "";
    if (typeof window === "undefined") return linkInfo.url;
    return `${window.location.origin}${linkInfo.url}`;
  }, [linkInfo]);

  function resetCreate() {
    setContent("");
    setDays("7");
    setEngagementId("");
  }

  function closeDialog() {
    setDialog(null);
    setLinkInfo(null);
    setLinkTarget(null);
    setRevokeTarget(null);
    setRevokeReason("");
    resetCreate();
  }

  function submitCreate() {
    if (!content.trim()) { toast.warning("请填写合同正文"); return; }
    const parsedDays = Number(days);
    if (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 30) {
      toast.warning("有效期须为 1–30 天的整数");
      return;
    }
    startTransition(async () => {
      try {
        const res = await createContractConfirmation({
          clientId,
          matterId,
          engagementId: engagementId || undefined,
          contentSnapshot: content.trim(),
          expiresInDays: parsedDays
        });
        setLinkInfo({ url: res.url, expiresAt: res.expiresAt });
        setLinkTarget(null);
        setDialog("link");
        resetCreate();
        await load();
        toast.success("确认链接已生成");
        router.refresh();
      } catch (err) {
        toast.error("生成失败", { description: actionErrorMessage(err) });
      }
    });
  }

  function submitRevoke() {
    if (!revokeTarget) return;
    if (revokeReason.trim().length < 2) { toast.warning("请填写撤销理由"); return; }
    startTransition(async () => {
      try {
        await revokeContractConfirmation({ id: revokeTarget.id, reason: revokeReason.trim() });
        toast.success("已撤销该确认请求");
        closeDialog();
        await load();
        router.refresh();
      } catch (err) {
        toast.error("撤销失败", { description: actionErrorMessage(err) });
      }
    });
  }

  function submitRegenerate(target: ContractConfirmationRow) {
    startTransition(async () => {
      try {
        const res = await regenerateContractConfirmation({ id: target.id, expiresInDays: 7 });
        setLinkInfo({ url: res.url, expiresAt: res.expiresAt });
        setDialog("link");
        await load();
        toast.success("已生成新链接，旧链接同时作废");
        router.refresh();
      } catch (err) {
        toast.error("生成失败", { description: actionErrorMessage(err) });
      }
    });
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(absoluteUrl);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败", { description: "请手动选中链接复制" });
    }
  }

  return (
    <section className="card">
      <div className="panel-head">
        <div className="panel-title">
          <FileCheck2 className="ic" strokeWidth={1.8} />
          合同阅知确认
          <span className="badge b-white" style={{ marginLeft: 2 }}>{rows?.length ?? 0}</span>
        </div>
        {canManage ? (
          <Button variant="ghost" size="sm" className="h-7 gap-1" onClick={() => { resetCreate(); setDialog("create"); }}>
            <Plus className="h-3 w-3" />
            发起确认
          </Button>
        ) : null}
      </div>

      <div className="flex items-start gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5 text-[11.5px] leading-relaxed text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#8A6D1F]" />
        <span data-testid="contract-confirmation-disclaimer">{CONTRACT_CONFIRMATION_DISCLAIMER}</span>
      </div>

      {loadError ? (
        <p className="px-4 py-5 text-xs text-destructive">{loadError}</p>
      ) : rows === null ? (
        <p className="px-4 py-5 text-center text-xs text-muted-foreground">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-5 text-center text-xs text-muted-foreground">
          暂无确认记录{canManage ? "，可点右上「发起确认」生成一次性链接发给客户" : ""}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="border-b border-border/60 text-[11px] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">确认状态</th>
                <th className="px-2 py-2 font-medium">关联委托</th>
                <th className="px-2 py-2 font-medium">发起 / 有效期</th>
                <th className="px-2 py-2 font-medium">确认时间 · IP</th>
                <th className="px-2 py-2 font-medium">正文哈希</th>
                <th className="px-4 py-2 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-2.5">
                    <span className={`inline-flex rounded-full border px-1.5 py-px text-[10.5px] ${STATUS_TONE[row.status]}`}>
                      {STATUS_LABEL[row.status]}
                    </span>
                    {row.confirmerName ? (
                      <div className="mt-1 text-[10.5px] text-muted-foreground">确认人：{row.confirmerName}</div>
                    ) : null}
                  </td>
                  <td className="max-w-[140px] px-2 py-2.5 text-muted-foreground">
                    {row.engagementTitle ?? "—"}
                  </td>
                  <td className="px-2 py-2.5 font-mono text-[10.5px] tabular text-muted-foreground">
                    <div>{fmt(row.createdAt)}</div>
                    <div>至 {fmt(row.expiresAt)}</div>
                  </td>
                  <td className="px-2 py-2.5 text-muted-foreground">
                    {row.confirmedAt ? (
                      <>
                        <div className="font-mono text-[10.5px] tabular">{fmt(row.confirmedAt)}</div>
                        <div className="font-mono text-[10.5px] tabular">{row.confirmedIp ?? "IP 未记录"}</div>
                        {row.confirmedUa ? (
                          <div className="max-w-[200px] truncate" title={row.confirmedUa}>{row.confirmedUa}</div>
                        ) : null}
                      </>
                    ) : row.revokedReason ? (
                      <span className="text-[#8A2C2C]">撤销：{row.revokedReason}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-2 py-2.5 font-mono text-[10.5px] tabular text-muted-foreground" title={row.contentHash}>
                    {row.contentHash.slice(0, 12)}…
                    <div className="font-sans">{row.contentLength} 字</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={isPending}
                        onClick={() => {
                          if (row.status === "CONFIRMED") {
                            toast.info("已确认的记录不能重新生成链接", { description: "如内容有误，请新建一条确认记录并保留原记录。" });
                            return;
                          }
                          setLinkTarget(row);
                          setLinkInfo(null);
                          setDialog("link");
                        }}
                      >
                        <ClipboardCopy className="h-3 w-3" />
                        复制链接
                      </Button>
                      {canManage && (row.status === "PENDING" || row.status === "EXPIRED") ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px]"
                            disabled={isPending}
                            onClick={() => submitRegenerate(row)}
                          >
                            <RefreshCcw className="h-3 w-3" />
                            重新生成
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-[11px] text-muted-foreground hover:text-destructive"
                            disabled={isPending}
                            onClick={() => { setRevokeTarget(row); setRevokeReason(""); setDialog("revoke"); }}
                          >
                            <Undo2 className="h-3 w-3" />
                            撤销
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 发起确认 */}
      <Dialog open={dialog === "create"} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>发起合同阅知确认</DialogTitle>
            <DialogDescription>
              系统会保存正文快照与 SHA-256 哈希，并生成一次性链接。客户凭链接即可打开，无需登录。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">关联委托（可选）</Label>
              <Select value={engagementId || "none"} onValueChange={(v) => setEngagementId(v === "none" ? "" : v)}>
                <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="不关联委托" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">不关联委托</SelectItem>
                  {engagements.map((e) => (
                    <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">合同正文 <span className="text-destructive">*</span></Label>
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={10}
                maxLength={200_000}
                placeholder="粘贴将发给客户查阅的合同正文全文。系统按此内容生成哈希，客户确认的就是这一版。"
                className="text-xs leading-relaxed"
              />
              <p className="text-[11px] text-muted-foreground">{content.trim().length} 字（至少 20 字）</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">链接有效期（天）</Label>
              <Input
                type="number"
                min={1}
                max={30}
                value={days}
                onChange={(e) => setDays(e.target.value)}
                className="h-9 w-28 text-xs"
              />
              <p className="text-[11px] text-muted-foreground">1–30 天，默认 7 天；过期后链接自动失效。</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={isPending}>取消</Button>
            <Button onClick={submitCreate} disabled={isPending}>
              {isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              生成确认链接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 链接（新建 / 重新生成） */}
      <Dialog open={dialog === "link"} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认链接</DialogTitle>
            <DialogDescription>
              链接中的令牌只在此刻出现一次，系统中仅保存其哈希，关闭后无法再次查看。
            </DialogDescription>
          </DialogHeader>
          {linkInfo ? (
            <div className="space-y-3">
              <div className="break-all rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11.5px]">
                {absoluteUrl}
              </div>
              <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                有效期至 {fmt(linkInfo.expiresAt)}。请通过可信渠道发给客户；链接即凭证，转发范围请自行控制。
              </p>
              <Button variant="secondary" className="w-full gap-1.5" onClick={copyLink}>
                <ClipboardCopy className="h-3.5 w-3.5" />
                复制链接
              </Button>
            </div>
          ) : (
            <div className="space-y-3 text-[12px] leading-relaxed text-muted-foreground">
              <p>
                令牌明文在生成后不再保存，无法找回旧链接。如需再次发送，只能重新生成——新链接生效的同时旧链接作废。
              </p>
              {linkTarget ? (
                <Button
                  className="w-full gap-1.5"
                  disabled={isPending}
                  onClick={() => submitRegenerate(linkTarget)}
                >
                  {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCcw className="h-3.5 w-3.5" />}
                  重新生成链接
                </Button>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 撤销 */}
      <Dialog open={dialog === "revoke"} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>撤销确认请求</DialogTitle>
            <DialogDescription>
              撤销后该链接立即失效。已确认的记录不能撤销——确认事实是证据链的一部分。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs">撤销理由 <span className="text-destructive">*</span></Label>
            <Textarea
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              rows={3}
              maxLength={200}
              placeholder="如：合同条款需重新协商，原链接作废"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog} disabled={isPending}>取消</Button>
            <Button variant="destructive" onClick={submitRevoke} disabled={isPending}>
              {isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              确认撤销
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
