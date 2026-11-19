import { NextResponse } from "next/server";
import { actionErrorMessage } from "@/lib/action-error";
import { isWebAuthnConfigured } from "@/lib/auth/webauthn";
import { beginLogin } from "@/server/auth/webauthn-service";

/**
 * Passkey 登录第一步：取认证选项（挑战已落库，5 分钟）。
 *
 * 为什么是 Route Handler 而不是 server action：调用方是**未登录**的登录页。
 * server action 依赖 Next 的 action id 与 RSC 上下文，把它暴露给未登录页面
 * 等于多开一个没有会话前提的 RPC 面；Route Handler 的语义与限制都更清楚。
 *
 * 未配置 WebAuthn 时返回 503（**不降级**为"按请求头凑一个 origin"）。
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(request: Request) {
  if (!isWebAuthnConfigured()) {
    return NextResponse.json(
      { ok: false, code: "NOT_CONFIGURED", message: "通行密钥登录未启用（管理员未配置站点与 RP ID）" },
      { status: 503, headers: NO_STORE }
    );
  }

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const options = await beginLogin(body);
    return NextResponse.json({ ok: true, options }, { headers: NO_STORE });
  } catch (err) {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: actionErrorMessage(err) },
      { status: 400, headers: NO_STORE }
    );
  }
}
