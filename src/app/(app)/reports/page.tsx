import { customOrLegacy } from "@/lib/roles/catalog";
import { isManager } from "@/lib/permissions";
import { reportAccess } from "@/lib/roles/report-scope";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getReportData, periodPresets } from "@/server/reports/queries";
import { resolveReportPeriod } from "@/server/reports/resolve-period";
import {
  getCaseCycleAnalysis,
  getReviewIssueAnalysis,
  getSatisfactionAnalysis
} from "@/server/reports/analytics";
import { ReportsView } from "./_components/reports-view";

export default async function ReportsPage({
  searchParams
}: {
  searchParams: Promise<{ period?: string; start?: string; end?: string }>;
}) {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  if (!customOrLegacy(session.user, "reports.read", isManager(session.user))) {
    redirect("/");
  }

  const resolved = resolveReportPeriod(await searchParams);
  const access = reportAccess(session.user);
  const [data, cycle, reviewAnalysis, satisfaction] = await Promise.all([
    getReportData(resolved.period, access),
    getCaseCycleAnalysis(resolved.period, access),
    getReviewIssueAnalysis(resolved.period, access),
    // 2026-11-21（门户 S3 验收判据「满意度看板：员工侧只读看板」）
    getSatisfactionAnalysis(resolved.period, access)
  ]);
  const presets = periodPresets();

  return (
    <ReportsView
      periodKey={resolved.periodKey}
      periodLabel={resolved.period.label}
      customStart={resolved.startStr}
      customEnd={resolved.endStr}
      resolveError={resolved.error}
      data={data}
      cycle={cycle}
      reviewAnalysis={reviewAnalysis}
      satisfaction={satisfaction}
      presetLabels={{
        month: presets.month.label,
        quarter: presets.quarter.label,
        year: presets.year.label,
        lastYear: presets.lastYear.label
      }}
    />
  );
}
