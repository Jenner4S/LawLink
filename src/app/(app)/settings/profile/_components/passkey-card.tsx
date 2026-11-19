"use client";

/**
 * 通行密钥（Passkey）管理卡 —— 个人设置 · 登录安全。
 *
 * 三条产品约束：
 *   1. **添加必须重新输入密码**（红线 5）。会话被劫持时，静默绑定攻击者设备等于
 *      永久后门；重新证明"我知道密码"是唯一低成本的拦截点。
 *   2. **删除保留至少一种登录方式**。服务端守卫生效（无密码且只剩一台 → 拒绝），
 *      前端只负责把错误文案透出。
 *   3. 列表展示设备名 / 创建时间 / 最后使用时间——用户要能认出"这台是公司电脑，
 *      那台是家里的旧手机"，否则清理可疑设备无从下手。
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { actionErrorMessage } from "@/lib/action-error";
import { formatDate, formatDateTime } from "@/lib/utils";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import type { PasskeyCredentialView } from "@/server/auth/webauthn-service";
import {
  completePasskeyRegistration,
  removePasskey,
  startPasskeyRegistration
} from "@/server/auth/webauthn-actions";

const TRANSPORT_LABEL: Record<string, string> = {
  internal: "本机生物识别",
  hybrid: "手机 / 跨设备",
  usb: "USB 安全密钥",
  nfc: "NFC 安全密钥",
  ble: "蓝牙安全密钥",
  "smart-card": "智能卡"
};

function transportText(transports: string[]): string {
  const labels = transports.map((t) => TRANSPORT_LABEL[t]).filter(Boolean);
  return labels.length > 0 ? [...new Set(labels)].join(" · ") : "未标注设备类型";
}

export function PasskeyCard({ credentials }: { credentials: PasskeyCredentialView[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState("");

  function submitAdd() {
    if (!password) {
      toast.error("请先输入当前登录密码");
      return;
    }
    startTransition(async () => {
      try {
        // 1) 服务端生成 options（挑战已落库，5 分钟）
        const options = await startPasskeyRegistration();
        // 2) 浏览器弹生物识别；用户取消会抛 NotAllowedError
        const { startRegistration } = await import("@simplewebauthn/browser");
        let attestation: unknown;
        try {
          attestation = await startRegistration({ optionsJSON: options });
        } catch (err) {
          const name = (err as Error | undefined)?.name ?? "";
          toast.error(
            name === "NotAllowedError" || name === "AbortError" ? "已取消添加（或验证超时）" : "本机设备未能完成验证",
            { description: name === "SecurityError" ? "当前访问地址与管理员配置的站点地址不一致，请用正式域名（https）访问" : "可重试，或换一台设备；问题持续请联系管理员" }
          );
          return;
        }
        // 3) 回传 attestation + 密码二次确认
        const created = await completePasskeyRegistration({
          attestation,
          deviceName: deviceName.trim() || undefined,
          password
        });
        toast.success("通行密钥已添加", { description: created.deviceName ?? "下一次登录可用这台设备直接进入" });
        setAdding(false);
        setPassword("");
        setDeviceName("");
        router.refresh();
      } catch (e) {
        toast.error("添加通行密钥失败", { description: actionErrorMessage(e) });
      }
    });
  }

  function remove(id: string, name: string | null) {
    startTransition(async () => {
      const ok = await confirmDialog({
        title: "删除这台设备的通行密钥？",
        description: `${name ?? "未命名设备"} 删除后将无法再用它登录，需要重新添加。`,
        confirmText: "删除",
        danger: true
      });
      if (!ok) return;
      try {
        await removePasskey({ id });
        toast.success("已删除");
        router.refresh();
      } catch (e) {
        toast.error("删除失败", { description: actionErrorMessage(e) });
      }
    });
  }

  return (
    <section className="card p-6">
      <div className="mb-4 flex items-center gap-2">
        <KeyRound className="h-4 w-4 text-primary" />
        <h2 className="text-base font-semibold">通行密钥（Passkey）</h2>
        {credentials.length > 0 ? (
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10.5px] text-primary">已绑定 {credentials.length} 台</span>
        ) : null}
      </div>

      <p className="text-[12px] leading-5 text-muted-foreground">
        用设备的指纹 / 面容 / PIN 代替密码登录。通行密钥绑定本站域名，钓鱼站点拿到的签名无法通过校验，比密码更难被窃取。
      </p>

      {credentials.length > 0 ? (
        <ul className="mt-3 divide-y rounded-lg border">
          {credentials.map((cred) => (
            <li key={cred.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="truncate">{cred.deviceName ?? "未命名设备"}</span>
                  {cred.backedUp ? (
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">可同步</span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">
                  {transportText(cred.transports)} · 添加于 {formatDate(cred.createdAt)}
                  {cred.lastUsedAt ? ` · 最后使用 ${formatDateTime(cred.lastUsedAt)}` : " · 尚未使用"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(cred.id, cred.deviceName)}
                disabled={pending}
                aria-label={`删除 ${cred.deviceName ?? "未命名设备"} 的通行密钥`}
                className="shrink-0 rounded-md border px-2 py-1 text-[12px] text-destructive hover:bg-destructive/10 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 rounded-lg bg-muted/40 px-3 py-2 text-[12px] text-muted-foreground">
          还没有绑定任何设备。建议先绑定日常使用的那台电脑，之后登录就不必再输密码。
        </p>
      )}

      {adding ? (
        <div className="mt-3 space-y-2 rounded-lg bg-muted/40 p-3">
          <p className="text-[12px] leading-5 text-muted-foreground">
            添加设备需要重新输入当前密码确认身份（防止会话被他人接管后偷偷绑定设备）。
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="当前登录密码"
              aria-label="当前登录密码"
              className="w-48 rounded-md border bg-background px-2 py-1.5 text-[12.5px]"
            />
            <input
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value.slice(0, 40))}
              placeholder="设备备注（如：办公台式机）"
              aria-label="设备备注"
              className="w-56 rounded-md border bg-background px-2 py-1.5 text-[12.5px]"
            />
            <button
              type="button"
              onClick={submitAdd}
              disabled={pending || !password}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-[12.5px] text-primary-foreground disabled:opacity-50"
            >
              {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
              开始验证
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setPassword(""); setDeviceName(""); }}
              className="rounded-md border px-2.5 py-1.5 text-[12.5px] text-muted-foreground hover:bg-accent"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          disabled={pending}
          className="mt-3 rounded-md bg-primary px-3 py-1.5 text-[13px] text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          添加通行密钥
        </button>
      )}
    </section>
  );
}
