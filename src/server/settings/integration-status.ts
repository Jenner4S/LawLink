/**
 * 外部接入状态汇总（2026-11-23）
 *
 * ## 为什么要有这一页
 *
 * 三项对接（表单/邮件/短信）的配置都在 `.env`。业主想知道"到哪一步了"，
 * 只能去读文档或问开发——这不合理。这里把状态变成界面可见。
 *
 * ## 一个必须显眼的中间态
 *
 * `configured-unimplemented`：**凭据配了但代码还没实现**。
 * 这是最危险的状态——看起来"配好了"，其实一条也发不出去/收不进来。
 * 所以它在界面上要用警示色，而不是和"已就绪"一个样子。
 */
import { prisma } from "@/lib/prisma";
import { isImapConfigured, missingImapKeys } from "@/server/inbound/imap-source";
import { isSmsConfigured, missingSmsKeys, readSmsEnv } from "@/lib/integrations/sms-channel";

export type IntegrationState =
  | { state: "ready" }                                  // 可用
  | { state: "off"; missing: string[] }                 // 未配置（可接受）
  | { state: "demo" }                                   // 演练模式（fake，不真发）
  | { state: "configured-unimplemented"; note: string }; // ⚠️ 配了但没实现

export type IntegrationStatus = {
  form: IntegrationState & { inboundLeadCount: number };
  imap: IntegrationState;
  sms: IntegrationState;
};

export async function getIntegrationStatus(env: NodeJS.ProcessEnv = process.env): Promise<IntegrationStatus> {
  // 表单：token 配了就可用（接口本身已实现并有测试）
  const formReady = Boolean(env.INBOUND_LEAD_TOKEN?.trim());
  const inboundLeadCount = await prisma.lead.count({ where: { notes: { contains: "[inbound:" } } });

  // 邮件：配了凭据但协议层未实现 → 中间态
  const imapConfigured = isImapConfigured(env);

  // 短信：fake 是合法演练模式；其它 provider 未实现 → 中间态
  const smsEnv = readSmsEnv(env);
  const smsState: IntegrationState = !smsEnv.provider
    ? { state: "off", missing: missingSmsKeys(env) }
    : smsEnv.provider === "fake"
      ? { state: "demo" }
      : isSmsConfigured(env)
        ? { state: "configured-unimplemented", note: `通道 ${smsEnv.provider} 尚未接入，短信发不出去` }
        : { state: "off", missing: missingSmsKeys(env) };

  return {
    form: formReady
      ? { state: "ready", inboundLeadCount }
      : { state: "off", missing: ["INBOUND_LEAD_TOKEN"], inboundLeadCount },
    imap: imapConfigured
      ? { state: "configured-unimplemented", note: "IMAP 凭据已配，但拉取实现未接入（需装 imapflow）" }
      : { state: "off", missing: missingImapKeys(env) },
    sms: smsState
  };
}
