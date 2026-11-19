import { prisma } from "@/lib/prisma";
import { readOidcConfig, redactIssuer } from "@/lib/auth/oidc";
import { auditActionLabel } from "@/lib/audit-labels";
import { shMonthDayTime } from "@/lib/ui/sh-time";

/**
 * 台账 P2-2：单点登录（OIDC）只读状态卡。
 *
 * 只读是刻意的——配置在环境变量（providers 数组在模块加载时求值），
 * 做写入界面会让部署方以为改的是配置。这里只回答三件事：
 *   1. 现在是开还是关；
 *   2. 指向哪个身份系统（只显示主机名，issuer 路径段常含租户 ID）；
 *   3. 最近 5 次 SSO 登录/拒绝，拒绝要看得到原因（NO_SUCH_USER 等）——
 *      "没登进来"和"为什么没登进来"是两件事，后者才是开通账号的依据。
 */
type SsoAuditRow = {
  id: string;
  action: string;
  createdAt: Date;
  detail: unknown;
  user: { name: string } | null;
};

function detailOf(detail: unknown): Record<string, unknown> {
  return detail && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {};
}

export async function SsoStatusCard() {
  const config = readOidcConfig();

  let recent: SsoAuditRow[] = [];
  try {
    recent = await prisma.auditLog.findMany({
      where: { action: { in: ["SSO_LOGIN", "SSO_LOGIN_REJECT"] } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, action: true, createdAt: true, detail: true, user: { select: { name: true } } }
    });
  } catch {
    // 审计表异常不应让整个安全与审计页打不开
    recent = [];
  }

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">单点登录（OIDC）</h2>
        <span
          className={
            config
              ? "rounded-full bg-[var(--teal-soft)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--teal-deep)]"
              : "rounded-full bg-[var(--bg-hover)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--t-muted)]"
          }
        >
          {config ? "已启用" : "未启用"}
        </span>
      </div>

      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
        {config
          ? `身份系统：${redactIssuer(config.issuer)}　登录页按钮：「${config.displayName}」`
          : "当前只提供账号密码登录，登录页不显示企业登录按钮。"}
      </p>
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
        配置在部署环境变量（AUTH_OIDC_*），本页只读、不提供写入。单点登录只把身份映射到**已存在的本所账号**，
        不会自动开号；已开启两步验证的账号需继续使用账号密码 + 动态码登录。
      </p>

      <div className="mt-4">
        <h3 className="text-[13px] font-semibold">最近 5 条 SSO 登录记录</h3>
        {recent.length === 0 ? (
          <p className="mt-1.5 text-[12px] text-muted-foreground">暂无记录。</p>
        ) : (
          <ul className="mt-2 divide-y divide-[var(--bd-subtle)] text-[12.5px]">
            {recent.map((row) => {
              const detail = detailOf(row.detail);
              const reason = typeof detail.reason === "string" ? detail.reason : null;
              const email = typeof detail.email === "string" ? detail.email : null;
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1.5">
                  <span className="tabular-nums text-muted-foreground">{shMonthDayTime(row.createdAt)}</span>
                  <span
                    className={
                      row.action === "SSO_LOGIN" ? "font-semibold text-[var(--teal-deep)]" : "font-semibold text-[var(--red)]"
                    }
                  >
                    {auditActionLabel(row.action)}
                  </span>
                  <span className="text-muted-foreground">{row.user?.name ?? email ?? "—"}</span>
                  {reason ? (
                    <span className="rounded bg-[var(--bg-hover)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--t-secondary)]">
                      {reason}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
