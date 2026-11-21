/**
 * 短信模板渲染（2026-11-23）
 *
 * ## 为什么不直接拼字符串
 *
 * ① **长度**：中文短信按 70 字计费，超了按多条收；拼装不加控制很容易一发三条。
 * ② **签名**：服务商要求签名与报备一致，位置固定在正文前。
 * ③ **信息密度**：提醒短信要让人一眼知道"哪件事、什么时候"，而不是把系统内部字段名塞进去。
 *
 * ## 内容口径
 *
 * 与站内/邮件提醒保持一致（"以下事项临近或已到期"），只是压缩到短信粒度：
 * 前 2 条用「标题+日期」，其余折成「等 N 项」，**不逐条罗列**——
 * 70 字里塞 5 条等于每条都看不清。
 */

export type ReminderSmsItem = { title: string; dueText: string };

/** 正文前的签名，如「【LawLink】」 */
function signPrefix(sign?: string | null): string {
  const s = (sign ?? "").trim();
  if (!s) return "";
  return s.startsWith("【") ? s : `【${s}】`;
}

/**
 * 期限提醒短信。
 *
 * 例：`【律所】张三，您有 3 项事项临近或已到期：① 借款纠纷 11-25；② 股权转让 11-26 等 3 项`
 */
export function renderReminderSms(input: {
  userName: string;
  items: ReminderSmsItem[];
  sign?: string | null;
}): string {
  const { userName, items, sign } = input;
  if (items.length === 0) return `${signPrefix(sign)}${userName}，当前没有临近或已到期的事项`;

  const head = `${signPrefix(sign)}${userName}，您有 ${items.length} 项事项临近或已到期：`;
  // 标题与日期都截断：模板要保证"两条也塞得进 70 字"，否则一发就是三条短信（三条费用）
  const parts = items.slice(0, 2).map((it, i) => {
    const title = it.title.trim().slice(0, 10);
    const due = it.dueText.trim().slice(0, 8);
    return `${i === 0 ? "①" : "②"} ${title} ${due}`;
  });
  const tail = items.length > 2 ? ` 等 ${items.length} 项` : "";
  return `${head}${parts.join("；")}${tail}`;
}

/** 上门提醒短信（基层最常发的一条） */
export function renderVisitReminderSms(input: {
  clientName: string;
  whenText: string;
  lawyerName?: string | null;
  sign?: string | null;
}): string {
  const who = input.lawyerName ? `${input.lawyerName}律师` : "我们";
  return `${signPrefix(input.sign)}${input.clientName}您好，${who}与您约在${input.whenText}面谈，请确认时间；如需改期请直接回复。`;
}

/**
 * 短版提醒（超长时的降级）。
 *
 * 为什么需要：签名 + 姓名 + 两条明细，遇到长签名与长姓名会超过 70 字，
 * 一发就是两条短信（两条费用，且客户收到两条）。
 * 这时候宁可只发一句"您有 N 项，请登录查看"，也不要为凑明细拆成两条。
 *
 * 用法：先渲染明细版，超过一条的分段数再换短版。
 */
export function renderReminderSmsCompact(input: {
  userName: string;
  count: number;
  sign?: string | null;
}): string {
  const name = input.userName.trim().slice(0, 8);
  return `${signPrefix(input.sign)}${name}，您有 ${input.count} 项事项临近或已到期，请登录 LawLink 查看。`;
}
