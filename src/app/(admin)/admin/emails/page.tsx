import { listLinkableMatters, listUnmatchedEmails } from "@/server/emails/actions";

import { EmailsAdminView } from "./_components/emails-view";

/**
 * 管理后台 · 邮件归档（台账 P1-3）。
 *
 * 管理侧职责是「分诊」：把自动匹配不了的邮件人工挂到案件上，或直接粘贴归档一封新邮件。
 * 队列范围由服务层决定：管理岗看全所，其他持有 matters.write 的人只看自己归档的未匹配件。
 * 页面本身受 AdminLayout 的 canEnterAdminWorkspace 门禁约束。
 */
export default async function AdminEmailsPage() {
  const [rows, matters] = await Promise.all([listUnmatchedEmails(), listLinkableMatters()]);
  return <EmailsAdminView rows={rows} matters={matters} />;
}
