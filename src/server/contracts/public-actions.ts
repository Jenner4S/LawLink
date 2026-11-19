"use server";

/**
 * 合同确认留痕 —— 公开侧动作（无需登录）。
 *
 * 安全：
 *   - 与公开页共用同一 IP 限流配额（60 秒 20 次），防 token 枚举；
 *   - 确认幂等（由 confirmByToken 保证）：已确认再次提交不重复写审计；
 *   - 不返回任何 clientId / matterId / 正文哈希等内部信息，只返回结果状态。
 */
import { headers } from "next/headers";
import { z } from "zod";
import { parseInput } from "@/lib/parse-input";
import {
  checkPublicRateLimit,
  confirmByToken,
  extractClientIp,
  normalizeUserAgent,
  type ConfirmFormState
} from "./service";

const confirmSchema = z.object({
  token: z.string().min(1),
  name: z.string().trim().max(60, "姓名过长").optional().or(z.literal(""))
});

export async function confirmContractFormAction(
  _prev: ConfirmFormState,
  formData: FormData
): Promise<ConfirmFormState> {
  const h = await headers();
  const ip = extractClientIp(h);
  if (!checkPublicRateLimit(ip)) {
    return { ok: false, message: "访问过于频繁，请稍后再试。" };
  }

  let data: z.infer<typeof confirmSchema>;
  try {
    data = parseInput(confirmSchema, {
      token: String(formData.get("token") ?? ""),
      name: String(formData.get("name") ?? "")
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "输入信息有误" };
  }

  const outcome = await confirmByToken({
    token: data.token,
    confirmerName: data.name || null,
    ip,
    ua: normalizeUserAgent(h.get("user-agent"))
  });

  switch (outcome.kind) {
    case "confirmed":
      return {
        ok: true,
        already: outcome.already,
        confirmedAt: outcome.confirmedAt.toISOString(),
        message: outcome.already
          ? "该合同内容此前已完成确认，无需重复提交。"
          : "已完成确认，感谢您。"
      };
    case "invalid":
      return { ok: false, message: "链接无效或已失效，请联系您的律师重新发送。" };
    case "expired":
      return { ok: false, message: "链接已过期，请联系您的律师重新发送。" };
    case "revoked":
      return { ok: false, message: "该确认已被撤销，如有疑问请联系您的律师。" };
    case "tampered":
      return {
        ok: false,
        message: "内容校验未通过：链接指向的正文与签发时不一致，请联系您的律师。"
      };
    default:
      return { ok: false, message: "确认未完成，请稍后重试。" };
  }
}
