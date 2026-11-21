/**
 * 邮件 → 入站线索草稿（2026-11-23）
 *
 * ## 为什么先做这一层
 *
 * IMAP 拉取需要真实凭据才能联调（拿不到就写不出可验证的代码）。
 * 但"拿到邮件之后怎么变线索"是纯逻辑，可以现在做完并钉住——
 * 等业主给凭据时，只差把邮件读进来这一步。
 *
 * ## 抽取规则（保守优先，不猜）
 *
 * · 手机号：正文/主题里第一个合法手机号（复用 `sms-parser` 的同一套正则口径）；
 * · 姓名：优先显式标注（`姓名：张三` / `称呼：张先生`），其次邮件显示名，
 *   最后退回「官网咨询」并用邮箱前缀。**不猜**——猜错的姓名会污染客户库；
 * · externalId：用邮件 `messageId`，天然幂等（同一封邮件重复拉取不会造两条线索）。
 */
import { firstPhoneInText } from "@/lib/sms-parser";

export type RawMail = {
  /** 邮件服务端唯一 id（IMAP 的 UID 或 Message-ID），用于幂等 */
  messageId: string;
  subject: string;
  /** 发件人显示名（可能为空） */
  fromName?: string | null;
  fromAddress: string;
  body: string;
  receivedAt: Date;
};

export type LeadDraft = {
  name: string;
  phone: string | null;
  message: string | null;
  sourceDetail: string;
  externalId: string;
  activityNote: string;
};

/** 正文里显式写的姓名（`姓名：张三` / `称呼：张先生`） */
function explicitName(text: string): string | null {
  const m = text.match(/(?:姓\s*名|称\s*呼)\s*[:：]\s*([^\s，,。；;]{1,20})/);
  return m ? m[1].trim() : null;
}

/** 第一个合法电话（与短信解析同口径；实现里的正则在每次调用时新建，避免 lastIndex 残留） */
export const firstPhone = firstPhoneInText;

function fallbackName(fromName: string | null | undefined, fromAddress: string): string {
  const display = fromName?.trim();
  if (display) return display.slice(0, 40);
  const local = fromAddress.split("@")[0]?.trim();
  return (local ? local.slice(0, 40) : "") || "官网咨询";
}

/**
 * 把一封邮件转成线索草稿。
 *
 * 注意 `message` 只放**客户写的话**（正文前 500 字），不放整封邮件头——
 * 否则线索备注里会塞满 `From:`/`Date:` 这类噪声，值班人看不下去。
 */
export function mailToLeadDraft(mail: RawMail): LeadDraft {
  const text = `${mail.subject}\n${mail.body}`;
  const phone = firstPhone(text);
  const name = explicitName(text) ?? fallbackName(mail.fromName, mail.fromAddress);
  const body = mail.body.trim().replace(/\s*\n\s*/g, " ").slice(0, 500);

  return {
    name,
    phone,
    message: body || mail.subject.trim() || null,
    sourceDetail: `邮件：${mail.fromAddress}`,
    externalId: `mail:${mail.messageId}`,
    activityNote: "邮件咨询（自动入站）"
  };
}
