/**
 * 邮件来源适配层（2026-11-23）
 *
 * ## 现状：接口 + 假实现已就绪，真 IMAP 拉取未接
 *
 * 真实现需要 `imapflow`（或等价库）依赖 + 真实邮箱凭据才能联调。
 * **没有凭据就写出来的 IMAP 代码无法验证**——那等于交付了一段"看起来能跑"的黑盒。
 * 所以这里只做两件事，都能验证：
 *
 *   ① 定义来源接口 `MailSource`，并给出可测的 `FakeMailSource`；
 *   ② `createImapSourceFromEnv()` 在配置齐全时**明确报错说明还差什么**，
 *      而不是静默返回空数组（静默失败会让"没收到线索"无人发现）。
 *
 * 业主给凭据后要做的只有：装 imapflow、实现 `createImapSourceFromEnv` 里的 TODO、
 * 跑 `ingestMails` 的既有测试（它们不依赖协议）。
 */
import type { RawMail } from "@/server/inbound/mail-to-lead";

export type MailSource = {
  /** 拉取 `since` 之后的邮件（实现方负责去重，或由调用方按 messageId 幂等） */
  listSince(since: Date): Promise<RawMail[]>;
};

export type ImapEnv = {
  host?: string;
  port?: string;
  user?: string;
  pass?: string;
  /** 只读某个文件夹（默认 INBOX） */
  mailbox?: string;
};

export function readImapEnv(env: NodeJS.ProcessEnv = process.env): ImapEnv {
  return {
    host: env.IMAP_HOST?.trim() || undefined,
    port: env.IMAP_PORT?.trim() || undefined,
    user: env.IMAP_USER?.trim() || undefined,
    pass: env.IMAP_PASS?.trim() || undefined,
    mailbox: env.IMAP_MAILBOX?.trim() || undefined
  };
}

/** 配置是否齐全（缺凭据时调用方应跳过，不算错误） */
export function isImapConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const e = readImapEnv(env);
  return Boolean(e.host && e.user && e.pass);
}

/** 缺哪几项（给「未启用」提示用，不暴露具体值） */
export function missingImapKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const e = readImapEnv(env);
  const missing: string[] = [];
  if (!e.host) missing.push("IMAP_HOST");
  if (!e.user) missing.push("IMAP_USER");
  if (!e.pass) missing.push("IMAP_PASS");
  return missing;
}

/**
 * 由环境变量造来源。
 *
 * · 未配置 → 返回 `null`（调用方按"未启用"跳过，不算失败）
 * · 已配置 → **抛错**并说明还差实现（不能静默返回空，否则"没收到线索"无人发现）
 */
export function createImapSourceFromEnv(env: NodeJS.ProcessEnv = process.env): MailSource | null {
  if (!isImapConfigured(env)) return null;
  throw new Error(
    "IMAP 凭据已配置，但拉取实现尚未接入：需要安装 imapflow 并在 " +
      "src/server/inbound/imap-source.ts 的 createImapSourceFromEnv 里实现 MailSource。" +
      "邮件→线索的转换与落库已就绪（mail-to-lead.ts + create-inbound-lead.ts），无需改动。"
  );
}

/** 假来源：测试与本地演示用（按顺序返回预置邮件，可断言"拉了几次"） */
export class FakeMailSource implements MailSource {
  private readonly mails: RawMail[];
  public calls = 0;

  constructor(mails: RawMail[]) {
    this.mails = mails;
  }

  async listSince(since: Date): Promise<RawMail[]> {
    this.calls += 1;
    return this.mails.filter((m) => m.receivedAt.getTime() >= since.getTime());
  }
}
