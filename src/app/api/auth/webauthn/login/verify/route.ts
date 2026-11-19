import { NextResponse } from "next/server";
import { actionErrorMessage } from "@/lib/action-error";
import { isWebAuthnConfigured } from "@/lib/auth/webauthn";
import { finishLogin } from "@/server/auth/webauthn-service";

/**
 * Passkey 登录第二步：验签 → 计数器校验 → 两步验证 → 签发一次性票据（60 秒）。
 *
 * 响应约定：
 *   200 { ok: true, ticket }         —— 前端拿 ticket 调 signIn("credentials", { ticket, __passkey: "1" })
 *   200 { ok: false, totpRequired: true } —— 该账号已开两步验证，需带 totpCode 重来一轮
 *   401 { ok: false, code, message } —— 拒绝（码与文案分流见 webauthn-service.ts）
 *   503                               —— 未配置
 *
 * 不返回任何账号状态细节之外的内部信息：拒绝码分"凭证不存在 / 验签失败 / 计数器异常"
 * 是因为用户下一步该做的事不同（去绑定设备 / 重试 / 找管理员），而 credentialId 本身
 * 是 128 位随机值，无法枚举。
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, code: "BAD_REQUEST", message: "请求格式不正确" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const outcome = await finishLogin(body);
    if (outcome.status === "OK") {
      return NextResponse.json({ ok: true, ticket: outcome.ticket }, { headers: NO_STORE });
    }
    if (outcome.status === "TOTP_REQUIRED") {
      return NextResponse.json(
        {
          ok: false,
          totpRequired: true,
          message: "该账号已开启两步验证，请填写动态码后再次验证通行密钥。"
        },
        { status: 200, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { ok: false, code: outcome.code, message: outcome.message },
      { status: 401, headers: NO_STORE }
    );
  } catch (err) {
    // ActionError（入参校验）走 400 并把中文提示透出；其余按验签失败处理。
    // 非校验类异常**不回传原文**——这里是不需要登录就能打到的端点，Prisma/库的
    // 内部错误文本可能带表名、路径甚至数据片段，一句通用文案足够。
    const isValidation = typeof (err as { digest?: unknown })?.digest === "string";
    const message = isValidation
      ? actionErrorMessage(err)
      : "通行密钥验证未通过，请重试；若持续失败请改用账号密码登录并联系管理员。";
    return NextResponse.json(
      { ok: false, code: isValidation ? "BAD_REQUEST" : "VERIFY_FAILED", message },
      { status: isValidation ? 400 : 401, headers: NO_STORE }
    );
  }
}
