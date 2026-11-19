"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, AlertCircle, Mail, LockKeyhole, ShieldCheck, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { checkLoginTotpEnforcement } from "@/server/auth/totp-actions";
import { PasskeyLogin } from "./passkey-login";

const schema = z.object({
  email: z.string().email("请填写有效邮箱"),
  password: z.string().min(1, "请填写密码"),
  totpCode: z.string().optional()
});

type FormValues = z.infer<typeof schema>;

/** 服务端只传按钮文案与开关；secret 与 issuer 不进客户端 */
export type LoginFormProps = {
  sso?: { displayName: string } | null;
  /** 服务端判定 isWebAuthnConfigured() 的结果：false 时整块 Passkey 入口不渲染 */
  passkey?: boolean;
};

/**
 * 从 URL 读登录失败原因。
 *
 * 两条来源：
 *   - `error`：NextAuth 自身（如 OAuth 回调校验失败、AccessDenied）；
 *   - `sso`：本项目 SSO 拒绝后由 signIn callback 返回的重定向码（见
 *     src/lib/auth/sso-signin.ts 的 ssoRejectRedirectUrl）。
 * 文案只说"该身份未开通/请改密码登录"，不披露本地账号是否存在。
 */
function initialAuthError(params: URLSearchParams): string | null {
  const sso = params.get("sso");
  if (sso === "not_provisioned") {
    return "该身份未在本系统开通，请联系所内管理员开通后重试；已有本所账号的同事可改用下方的账号密码登录。";
  }
  if (sso === "totp") {
    return "该账号已开启两步验证，单点登录无法提交动态码。请使用账号密码 + 两步验证码登录；如已不需要两步验证，请联系管理员。";
  }
  if (sso === "email_unverified") {
    return "企业身份系统返回的邮箱未通过验证，为避免冒用同名账号，本次登录已中止。请在身份系统中完成邮箱验证后重试。";
  }
  if (sso === "config") {
    return "单点登录配置异常（issuer 与身份系统不一致），请联系管理员；账号密码登录不受影响。";
  }

  const error = params.get("error");
  if (!error) return null;
  if (error === "AccessDenied") {
    return "该身份未在本系统开通，或当前账号状态不允许登录。请联系所内管理员，或改用账号密码登录。";
  }
  if (error === "Configuration") {
    return "登录服务配置异常，请联系管理员；账号密码登录不受影响。";
  }
  if (error === "OAuthCallback" || error === "Callback") {
    return "企业身份系统的回调校验失败（可能是状态过期或浏览器拦截 Cookie），请重试；问题持续请联系管理员。";
  }
  return "登录未完成，请重试；问题持续请联系管理员。";
}

export function LoginForm({ sso = null, passkey = false }: LoginFormProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/";
  const [authError, setAuthError] = useState<string | null>(() => initialAuthError(searchParams));
  const [showPassword, setShowPassword] = useState(false);
  const [showTotp, setShowTotp] = useState(false);
  const [ssoPending, setSsoPending] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting }
  } = useForm<FormValues>({
    resolver: zodResolver(schema)
  });
  // Passkey 登录用已填的邮箱限定凭证（留空则走无用户名发现，由浏览器让用户选设备）。
  // 用 getValues 而不是 watch：只在点按钮时取值，不必订阅表单（也就不会触发
  // React Compiler 对 useForm().watch 的「无法安全 memo」跳过提示）。
  const readEmail = () => getValues("email") ?? "";

  async function onSubmit(values: FormValues) {
    setAuthError(null);
    const res = await signIn("credentials", {
      email: values.email,
      password: values.password,
      totpCode: values.totpCode || undefined,
      redirect: false
    });
    if (res?.ok) {
      router.replace(callbackUrl);
      router.refresh();
    } else {
      if (res?.error !== "CredentialsSignin") {
        setAuthError("登录服务暂时异常，请稍后重试或联系管理员；这不代表密码错误。");
        return;
      }
      // 凭据被拒时区分策略性拦截：被管理员要求开启双步验证但尚未绑定的账号
      // 在完成绑定前无法登录（authorize 恒拒）。仅在已失败后查询，避免账号探测。
      try {
        const enforced = await checkLoginTotpEnforcement(values.email);
        if (enforced) {
          setAuthError("该账号已被管理员要求开启双步验证，且尚未完成绑定，暂无法登录。请联系管理员协助完成绑定。");
          return;
        }
      } catch {
        // 预检不可用时不影响通用错误提示
      }
      setAuthError(showTotp ? "邮箱、密码或两步验证码错误" : "邮箱或密码错误；如账号已开启两步验证，请勾选「使用两步验证码」后填写。");
    }
  }

  async function onSso() {
    setAuthError(null);
    setSsoPending(true);
    try {
      // redirect 默认 true：浏览器整页跳转到 IdP 授权端点（PKCE + state 由 NextAuth 生成）
      await signIn("oidc", { callbackUrl });
    } catch {
      setSsoPending(false);
      setAuthError("无法发起企业统一登录，请稍后重试或联系管理员。");
    }
  }

  return (
    <>
      <form method="post" onSubmit={handleSubmit(onSubmit)} noValidate>
      {authError ? (
        <div role="alert" className="mb-4 flex gap-2 rounded-[10px] border border-[var(--red-line)] bg-[var(--red-bg)] px-3 py-2.5 text-[12.5px] leading-relaxed text-[var(--red)]">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{authError}</span>
        </div>
      ) : null}

      <div className="fp-field">
        <label htmlFor="email" className="fp-label">邮箱</label>
        <div className={cn("fp-input", errors.email && "!border-[var(--red)]")}>
          <Mail aria-hidden />
          <input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="name@firm.cn"
            aria-invalid={!!errors.email}
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-[var(--t-primary)] outline-none placeholder:text-[var(--t-faint)]"
            {...register("email")}
          />
        </div>
        {errors.email ? <p className="mt-1.5 text-[11.5px] text-[var(--red)]">{errors.email.message}</p> : null}
      </div>

      <div className="fp-field">
        <label htmlFor="password" className="fp-label">密码</label>
        <div className={cn("fp-input", errors.password && "!border-[var(--red)]")}>
          <LockKeyhole aria-hidden />
          <input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            aria-invalid={!!errors.password}
            className="h-full min-w-0 flex-1 border-0 bg-transparent text-[13.5px] text-[var(--t-primary)] outline-none"
            {...register("password")}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "隐藏密码" : "显示密码"}
            className="ml-auto shrink-0 border-0 bg-transparent text-[12px] text-[var(--t-faint)] hover:text-[var(--t-secondary)]"
          >
            {showPassword ? "隐藏" : "显示"}
          </button>
        </div>
        {errors.password ? <p className="mt-1.5 text-[11.5px] text-[var(--red)]">{errors.password.message}</p> : null}
      </div>

      {showTotp ? (
        <div className="fp-field">
          <label htmlFor="totpCode" className="fp-label">两步验证码</label>
          <div className="fp-input">
            <ShieldCheck aria-hidden />
            <input
              id="totpCode"
              inputMode="numeric"
              maxLength={16}
              autoFocus
              placeholder="6 位动态码或恢复码"
              autoComplete="one-time-code"
              className="h-full min-w-0 flex-1 border-0 bg-transparent font-mono text-[13.5px] tracking-[0.08em] text-[var(--t-primary)] outline-none placeholder:font-sans placeholder:tracking-normal placeholder:text-[var(--t-faint)]"
              {...register("totpCode")}
            />
          </div>
        </div>
      ) : null}

      <div className="fp-row">
        <button type="button" onClick={() => setShowTotp((v) => !v)} className="fp-check border-0 bg-transparent p-0 font-[inherit]" aria-expanded={showTotp}>
          <span className={cn("fp-box", !showTotp && "!border !border-[var(--bd-strong)] !bg-card")}>
            {showTotp ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" aria-hidden>
                <path d="M4 12.5l5 5L20 7" />
              </svg>
            ) : null}
          </span>
          使用两步验证码
        </button>
        <span className="fp-link" title="本系统为自部署实例，密码由所内管理员在管理后台重置">忘记密码？请联系管理员</span>
      </div>

      <button type="submit" className="btn btn-primary btn-login" disabled={isSubmitting}>
        {isSubmitting ? <Loader2 className="animate-spin" /> : null}
        {isSubmitting ? "登录中…" : "登 录"}
      </button>
      </form>

      {/* 台账 P2-2 后半：仅在服务端确认 WebAuthn 已配置时渲染（未配置则整块不存在） */}
      {passkey ? <PasskeyLogin getEmail={readEmail} callbackUrl={callbackUrl} /> : null}

      {/* 台账 P2-2：仅在服务端确认 AUTH_OIDC_ENABLED=1 时渲染（未配置则整块不存在） */}
      {sso ? (
        <div className={passkey ? "mt-3" : "mt-5"}>
          {/* Passkey 块已自带「或」分隔线，两者同时存在时不再重复画一条 */}
          {passkey ? null : (
            <div className="mb-4 flex items-center gap-3 text-[11.5px] text-[var(--t-faint)]" aria-hidden>
              <span className="h-px flex-1 bg-[var(--bd-subtle)]" />
              或
              <span className="h-px flex-1 bg-[var(--bd-subtle)]" />
            </div>
          )}
          <button type="button" className="btn btn-secondary btn-login" onClick={onSso} disabled={ssoPending}>
            {ssoPending ? <Loader2 className="animate-spin" /> : <Building2 aria-hidden />}
            {ssoPending ? "正在跳转…" : sso.displayName}
          </button>
          <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-[var(--t-faint)]">
            使用企业身份系统登录时，账号需由管理员预先在本系统开通。
          </p>
        </div>
      ) : null}
    </>
  );
}
