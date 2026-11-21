/**
 * 短信通道适配层（2026-11-23）
 *
 * ## 现状：模板与开关就绪，通道未接
 *
 * 与 IMAP 同一个思路：**能验证的做完，不能验证的明确标注**。
 *
 * · 模板渲染、长度控制、手机号校验、发送失败处理 —— 纯逻辑，全部可测；
 * · 真通道（阿里云/腾讯云）需要密钥才能联调，这里只留接口与「明确报错」。
 *
 * ## 两个刻意的设计
 *
 * ① **`SMS_PROVIDER=fake` 是合法选项**，用于演练与测试：
 *    它把短信记进内存并返回成功，不真发。这样"短信链路是否通"可以离线验证，
 *    而不用等到有密钥。
 * ② 配了 provider 但代码没实现时**抛错**，不静默当成功——
 *    否则业主以为"提醒发出去了"，实际一条都没发。
 */

/** 单条短信的字数上限：中文按 70 字一条计费，超过会拆成多条并按多条收费 */
export const SMS_MAX_LEN = 70;

export type SmsSendResult = { ok: true; providerId: string; segments: number } | { ok: false; reason: string };

export type SmsChannel = {
  name: string;
  send(to: string, text: string): Promise<SmsSendResult>;
};

export type SmsEnv = {
  provider?: string;
  key?: string;
  secret?: string;
  /** 短信签名（如「律所」），按服务商要求必须与报备一致 */
  sign?: string;
};

export function readSmsEnv(env: NodeJS.ProcessEnv = process.env): SmsEnv {
  return {
    provider: env.SMS_PROVIDER?.trim().toLowerCase() || undefined,
    key: env.SMS_KEY?.trim() || undefined,
    secret: env.SMS_SECRET?.trim() || undefined,
    sign: env.SMS_SIGN?.trim() || undefined
  };
}

/** 是否可用于真发送（fake 也算"已配置"，因为它能跑通链路） */
export function isSmsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const e = readSmsEnv(env);
  if (e.provider === "fake") return true;
  return Boolean(e.provider && e.key);
}

/** 缺哪几项（给「未启用」提示，不含具体值） */
export function missingSmsKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const e = readSmsEnv(env);
  if (e.provider === "fake") return [];
  const missing: string[] = [];
  if (!e.provider) missing.push("SMS_PROVIDER");
  if (!e.key) missing.push("SMS_KEY");
  return missing;
}

/** 中国大陆手机号（与服务端校验同口径） */
export function isMobilePhone(v: string): boolean {
  return /^1[3-9]\d{9}$/.test(v.trim());
}

/** 按 70 字切分（不做智能断句：短信按 UCS-2 计长，硬切最可预测） */
export function splitSmsText(text: string, max = SMS_MAX_LEN): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += max) out.push(text.slice(i, i + max));
  return out.length ? out : [""];
}

/** 假通道：记录发送内容、返回成功、不真发（演练与测试用） */
export class FakeSmsChannel implements SmsChannel {
  readonly name = "fake";
  public readonly sent: { to: string; text: string; at: Date }[] = [];

  async send(to: string, text: string): Promise<SmsSendResult> {
    this.sent.push({ to, text, at: new Date() });
    return { ok: true, providerId: `fake-${this.sent.length}`, segments: splitSmsText(text).length };
  }
}

/**
 * 由环境变量造通道。
 *
 * · 未配置 → `null`（调用方按"未启用"跳过，不算失败）
 * · `SMS_PROVIDER=fake` → 假通道（可跑通整条链路）
 * · 其它 provider（aliyun/tencent…）→ **抛错**说明还差实现
 */
export function createSmsChannel(env: NodeJS.ProcessEnv = process.env): SmsChannel | null {
  const e = readSmsEnv(env);
  if (!e.provider) return null;
  if (e.provider === "fake") return new FakeSmsChannel();
  throw new Error(
    `短信通道 ${e.provider} 尚未接入：需要在 src/lib/integrations/sms-channel.ts 的 ` +
      `createSmsChannel 里实现 SmsChannel（发送 + 回执解析）。` +
      `模板渲染与长度控制已就绪（sms-template.ts），无需改动。`
  );
}
