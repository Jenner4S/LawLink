"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Mail, Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invitePortalUser } from "@/server/portal/actions";
import { actionErrorMessage } from "@/lib/action-error";

/**
 * 员工侧「邀请客户开通门户」（2026-11-20，门户 S1）
 *
 * 设计要点：
 *   · 邀请链接**明文只显示这一次**（库里只存哈希）。所以成功后不关弹窗，
 *     把链接摊在眼前并给「复制」按钮——关掉就再也拿不到了。
 *   · 明确写出「本版本不自动发邮件」：系统没有对客户的邮件通道，
 *     假装"已发送"会让律师以为客户收到了，实际没发。
 *   · 邀请 24 小时过期、一次性。过期后重新发起即可（同一邮箱复用账号）。
 */
export function PortalInviteButton({ clientId, clientName }: { clientId: string; clientName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setLink(null);
    setExpiresAt(null);
    setCopied(false);
    setEmail("");
    setName("");
  };

  const submit = () => {
    if (!email.trim() || !name.trim()) {
      toast.error("请填写联系人姓名与邮箱");
      return;
    }
    startTransition(async () => {
      try {
        const res = await invitePortalUser({ clientId, email: email.trim(), name: name.trim() });
        const url = `${window.location.origin}/portal/invite/${res.token}`;
        setLink(url);
        setExpiresAt(res.expiresAt);
        router.refresh();
      } catch (err) {
        toast.error("邀请失败", { description: actionErrorMessage(err) });
      }
    });
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast.success("已复制邀请链接");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn btn-ghost btn-sm gap-1"
        onClick={() => { reset(); setOpen(true); }}
        title="邀请该客户开通门户账号"
      >
        <Mail className="h-3.5 w-3.5" />
        邀请开通门户
      </button>

      <Dialog
        open={open}
        onOpenChange={(o) => {
          // 链接只显示一次：关掉就丢，所以关闭时提醒一句（已复制则不问）
          if (!o && link && !copied) {
            toast.warning("邀请链接已关闭，未复制就需要重新发起邀请");
          }
          setOpen(o);
          if (!o) reset();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>邀请「{clientName}」开通门户</DialogTitle>
            <DialogDescription className="text-xs">
              客户凭邀请链接设置密码后即可登录门户。链接 <b>24 小时有效、只能用一次</b>，
              并且<b>只显示这一次</b>。
            </DialogDescription>
          </DialogHeader>

          <FormDialogBody>
            {link ? (
              <>
                <div className="space-y-1.5">
                  <Label>邀请链接（请复制后发给客户）</Label>
                  <div className="flex gap-2">
                    <Input value={link} readOnly onFocus={(e) => e.currentTarget.select()} className="font-mono text-[11px]" />
                    <Button variant="outline" onClick={copy} className="shrink-0 gap-1">
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] leading-relaxed text-[var(--amber)]">
                  本版本<b>不会自动给客户发邮件</b>——请自行通过邮件或微信把链接发给对方。
                  过期后重新点「邀请开通门户」即可，同一邮箱会复用原账号。
                </p>
                {expiresAt ? (
                  <p className="text-[11px] text-[var(--t-muted)]">
                    有效期至 {new Date(expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="pi-name">客户方联系人姓名</Label>
                  <Input id="pi-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如：张经理" maxLength={50} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pi-email">对方邮箱</Label>
                  <Input
                    id="pi-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="客户本人的邮箱，将成为登录账号"
                    maxLength={200}
                  />
                  <p className="text-[11px] text-[var(--t-muted)]">
                    同一邮箱只能绑定一个客户；若该邮箱已属于其他客户，系统会拒绝（不显示是谁）。
                  </p>
                </div>
              </>
            )}
          </FormDialogBody>

          <DialogFooter>
            {link ? (
              <Button onClick={() => { setOpen(false); reset(); }}>完成</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setOpen(false)} disabled={isPending}>
                  取消
                </Button>
                <Button onClick={submit} disabled={isPending} className="gap-1">
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  生成邀请链接
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
