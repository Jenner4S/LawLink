/**
 * 批量收件入库（2026-11-23）
 *
 * 把 `MailSource` 拉到的邮件逐封转成线索草稿并落库，返回可核对的统计。
 * 单封失败**不中断整批**（一封格式怪的邮件不该让这一轮全白跑），
 * 失败原因逐封收集，调用方据此告警。
 */
import type { MailSource } from "@/server/inbound/imap-source";
import { mailToLeadDraft } from "@/server/inbound/mail-to-lead";
import { createInboundLead } from "@/server/inbound/create-inbound-lead";

export type IngestResult = {
  fetched: number;
  created: number;
  duplicate: number;
  failed: { messageId: string; reason: string }[];
  /** 没有可用接收人等全局性问题：一旦出现，后续邮件都不必再试 */
  fatal?: string;
};

export async function ingestMails(source: MailSource, since: Date): Promise<IngestResult> {
  const mails = await source.listSince(since);
  const result: IngestResult = { fetched: mails.length, created: 0, duplicate: 0, failed: [] };

  for (const mail of mails) {
    try {
      const draft = mailToLeadDraft(mail);
      const created = await createInboundLead({
        name: draft.name,
        phone: draft.phone,
        externalId: draft.externalId,
        message: draft.message,
        sourceDetail: draft.sourceDetail,
        activityNote: draft.activityNote
      });
      if (!created.ok) {
        // 全局性问题（如没有接收人）：记下来并停止，不逐封重复撞同一个墙
        result.fatal = created.howTo;
        break;
      }
      if (created.duplicate) result.duplicate += 1;
      else result.created += 1;
    } catch (err) {
      result.failed.push({
        messageId: mail.messageId,
        reason: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return result;
}

