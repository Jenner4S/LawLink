import { listAuditLogs } from "@/server/settings/actions";
import { listUsers } from "@/server/users/actions";
import { AuditView } from "./_components/audit-view";
import { SsoStatusCard } from "./_components/sso-status-card";

type Props = { searchParams: { action?: string; userId?: string; days?: string } };

export default async function AuditPage({ searchParams }: Props) {
  const [{ items, distinctActions }, users] = await Promise.all([
    listAuditLogs({
      action: searchParams.action,
      userId: searchParams.userId,
      days: searchParams.days ? Number(searchParams.days) : 30
    }),
    listUsers()
  ]);
  return (
    <div className="space-y-4">
      {/* 台账 P2-2：安全与审计下的 SSO 只读状态卡（是否启用 / issuer 主机 / 最近 5 条 SSO 审计） */}
      <SsoStatusCard />
      <AuditView items={items} distinctActions={distinctActions} userOptions={users.map(user => ({ id: user.id, name: user.name }))} initialFilters={{ action: searchParams.action ?? "ALL", userId: searchParams.userId ?? "ALL", days: searchParams.days ?? "30" }} />
    </div>
  );
}
