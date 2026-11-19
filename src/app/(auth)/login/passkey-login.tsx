"use client";

/**
 * Passkey 登录按钮与流程（台账 P2-2 后半）。
 *
 * 为什么不是 CredentialsProvider 直接吃断言：
 *   NextAuth 的 CredentialsProvider 是"表单提交 → authorize"，而 WebAuthn 是
 *   "浏览器 JS 调 navigator.credentials → 拿到断言 → 服务端验签"。两者形状不同，
 *   硬塞进 authorize 只能把断言当密码字符串传（体积大、无法做挑战一次性校验）。
 *
 * 因此走四步（推荐方案）：
 *   1. POST /api/auth/webauthn/login/options  → 拿挑战（已落库）
 *   2. startAuthentication()                  → 浏览器弹生物识别，产出 assertion
 *   3. POST /api/auth/webauthn/login/verify    → 服务端验签 + 计数器校验 + 两步验证
 *                                                → 返回一次性票据（60 秒、绑定 userId）
 *   4. signIn("credentials", { ticket, __passkey: "1" }) → authorize 核销票据建会话
 *
 * 失败文案分四类（用户取消 / 凭证不匹配 / 验签失败 / 计数器异常），措辞不同是因为
 * 用户下一步该做的事不同：取消只需重试，凭证不匹配要去绑定设备，验签失败多半是站点
 * 配置问题要找管理员，计数器异常意味着设备被复制必须找管理员核验。
 */
import { useState } from "react";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { AlertCircle, Fingerprint, Loader2, ShieldCheck } from "lucide-react";

export type PasskeyLoginProps = {
  /** 读取登录表单里已填的邮箱（有则用 allowCredentials 限定该账号，没有则走无用户名发现） */
  getEmail?: () => string;
  callbackUrl: string;
};

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function PasskeyLogin({ getEmail, callbackUrl }: PasskeyLoginProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [totpRequired, setTotpRequired] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  const supported = typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined";

  async function run() {
    setError(null);
    if (!supported) {
      setError("当前浏览器不支持通行密钥（WebAuthn）。请改用下方账号密码登录，或更换 Chrome / Safari / Edge 较新版本。");
      return;
    }
    setPending(true);
    try {
      const email = (getEmail?.() ?? "").trim();
      const optionsRes = await postJson(
        "/api/auth/webauthn/login/options",
        email ? { email } : {}
      );
      if (!optionsRes.ok) {
        setError(
          (optionsRes.json.message as string) ??
            "无法发起通行密钥登录，请稍后重试；也可以改用下方账号密码登录。"
        );
        return;
      }

      // 动态导入：@simplewebauthn/browser 只在用户真的点这个按钮时才需要
      const { startAuthentication } = await import("@simplewebauthn/browser");
      let assertion: unknown;
      try {
        assertion = await startAuthentication({
          optionsJSON: optionsRes.json.options as unknown as PublicKeyCredentialRequestOptionsJSON
        });
      } catch (err) {
        const name = (err as Error | undefined)?.name ?? "";
        if (name === "NotAllowedError" || name === "AbortError") {
          setError("已取消通行密钥验证，或验证超时。可以再试一次，也可以改用下方账号密码登录。");
        } else if (name === "SecurityError") {
          setError(
            "当前页面地址与管理员配置的站点地址不一致，浏览器拒绝了通行密钥请求。请确认访问的是本所正式域名（https），或改用账号密码登录。"
          );
        } else if (name === "NotSupportedError" || name === "InvalidStateError") {
          setError("该设备或浏览器不支持这种通行密钥，请改用账号密码登录，或换一台已绑定设备的电脑。");
        } else {
          setError("通行密钥验证未能完成，请重试；若持续失败，请改用账号密码登录。");
        }
        return;
      }

      const verifyRes = await postJson("/api/auth/webauthn/login/verify", {
        assertion,
        totpCode: totpCode.trim() || undefined
      });

      if (verifyRes.json.totpRequired === true) {
        setTotpRequired(true);
        setError(null);
        return;
      }
      if (!verifyRes.ok || verifyRes.json.ok !== true) {
        setError(
          (verifyRes.json.message as string) ??
            "通行密钥验证未通过，请重试；若持续失败，请改用账号密码登录并联系管理员。"
        );
        return;
      }

      const res = await signIn("credentials", {
        ticket: verifyRes.json.ticket as string,
        __passkey: "1",
        redirect: false
      });
      if (res?.ok) {
        router.replace(callbackUrl);
        router.refresh();
        return;
      }
      setError("通行密钥已验证，但会话创建失败。请重试；若持续失败请联系管理员。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mt-5">
      <div className="mb-4 flex items-center gap-3 text-[11.5px] text-[var(--t-faint)]" aria-hidden>
        <span className="h-px flex-1 bg-[var(--bd-subtle)]" />
        或
        <span className="h-px flex-1 bg-[var(--bd-subtle)]" />
      </div>

      {error ? (
        <div
          role="alert"
          className="mb-3 flex gap-2 rounded-[10px] border border-[var(--red-line)] bg-[var(--red-bg)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--red)]"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {totpRequired ? (
        <div className="mb-3 rounded-[10px] border border-[var(--bd-subtle)] bg-[var(--bd-subtle)]/20 px-3 py-2.5">
          <p className="text-[12px] leading-relaxed text-[var(--t-secondary)]">
            该账号已开启两步验证。请填写验证器 App 的 6 位动态码（或一枚恢复码），再点一次「使用 Passkey 登录」。
          </p>
          <input
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.trim().slice(0, 16))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 位动态码或恢复码"
            aria-label="两步验证码"
            className="mt-2 h-9 w-56 rounded-md border border-[var(--bd-strong)] bg-card px-2 font-mono text-[13px] tracking-[0.08em] outline-none"
          />
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn-secondary btn-login"
        onClick={run}
        disabled={pending}
      >
        {pending ? <Loader2 className="animate-spin" /> : totpRequired ? <ShieldCheck aria-hidden /> : <Fingerprint aria-hidden />}
        {pending ? "正在验证…" : totpRequired ? "使用 Passkey 登录（含两步验证）" : "使用 Passkey 登录"}
      </button>
      <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-[var(--t-faint)]">
        用本机指纹 / 面容 / 设备 PIN 代替密码，无需输入密码，且不会被钓鱼站点骗取。
      </p>
    </div>
  );
}
