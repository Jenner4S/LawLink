import { customOrLegacy } from "@/lib/roles/catalog";
import { isManager } from "@/lib/permissions";
import { reportAccess } from "@/lib/roles/report-scope";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { audit } from "@/server/audit";
import { buildReportWorkbook } from "@/server/reports/export-xlsx";
import { getReportData } from "@/server/reports/queries";
import { resolveReportPeriod } from "@/server/reports/resolve-period";
import { shDayKey } from "@/lib/ui/sh-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 集团汇总元数据（2026-11-20）
 *
 * 本接口为「多实例部署 + 集团汇总」提供机器可读出口（架构见
 * docs/客户门户架构方案、定价见 docs/源码交付定价修正与销售端应对）。
 *
 * **为什么要带这份元数据**：集团方最常犯的错是把各实例的 `archiveRate` 直接相加
 * ——它是派生比率（已归档 ÷ 已结案），相加没有意义。同理 `userId` / `clientId`
 * 是各实例本地主键，跨实例不可配对，只能按名称合并。
 *
 * 这些不是注释而是接口契约：字段进 JSON，消费方可程序化正确处理。
 */
export const MERGE_GUIDE = {
  /** 直接相加 */
  summable: [
    "kpis.newIntake",
    "kpis.inProgress",
    "kpis.closed",
    "kpis.archived",
    "byCategory[].count",
    "byLawyer[].ownedCount",
    "byLawyer[].closedCount",
    "byLawyer[].receivedAmount",
    "byClientReceivable[].receivable",
    "byClientReceivable[].received",
    "byClientReceivable[].balance",
    "byClientSource[].count",
    "byClientSource[].intakeCount"
  ],
  /** 派生值，必须用合计重算，不可相加 */
  derived: {
    "kpis.archiveRate": "Σ kpis.archived ÷ Σ kpis.closed（分母为 0 时取 0）"
  },
  /** 实例本地主键，跨实例不可配对，须按人/客户名称合并 */
  instanceLocalKeys: {
    "byLawyer[].userId": "按 byLawyer[].name 合并；同名律师会被合并为一行",
    "byClientReceivable[].clientId": "按 byClientReceivable[].name 合并；同名客户会被合并为一行"
  },
  /** 布尔取与：任一实例为 false 则集团为 false */
  booleanAnd: ["financeReady"],
  /** 分组键 */
  groupBy: {
    byCategory: "category",
    byLawyer: "name",
    byClientReceivable: "name",
    byClientSource: "source"
  }
} as const;

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  if (!customOrLegacy(session.user, "reports.export", isManager(session.user))) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }

  const url = new URL(req.url);
  const resolved = resolveReportPeriod({
    period: url.searchParams.get("period") ?? undefined,
    start: url.searchParams.get("start") ?? undefined,
    end: url.searchParams.get("end") ?? undefined
  });
  if (resolved.error) {
    return NextResponse.json({ error: resolved.error }, { status: 400 });
  }
  const { period, periodKey } = resolved;

  const format = url.searchParams.get("format") ?? "xlsx";
  if (format !== "xlsx" && format !== "json") {
    return NextResponse.json({ error: "format 仅支持 xlsx 或 json" }, { status: 400 });
  }

  const access = reportAccess(session.user, true);

  // ── JSON：给集团汇总用的机器可读出口 ──
  if (format === "json") {
    let data: Awaited<ReturnType<typeof getReportData>>;
    try {
      data = await getReportData(period, access);
    } catch (err) {
      console.error("[reports/export] JSON 生成失败：", err);
      return NextResponse.json({ error: "导出失败" }, { status: 500 });
    }

    await audit({
      userId: session.user.id,
      action: "REPORT_EXPORT",
      targetType: "Report",
      targetId: periodKey,
      detail: { periodLabel: period.label, periodKey, format: "json" }
    });

    return NextResponse.json(
      {
        schemaVersion: 1,
        format: "json",
        // 期间边界用上海日历（shDayKey），避免各实例时区不同导致窗口错位
        periodKey,
        periodLabel: period.label,
        start: shDayKey(period.start),
        end: shDayKey(period.end),
        generatedAt: new Date().toISOString(),
        mergeGuide: MERGE_GUIDE,
        data: {
          financeReady: data.financeReady,
          kpis: data.kpis,
          byCategory: data.byCategory,
          byLawyer: data.byLawyer,
          byClientReceivable: data.byClientReceivable,
          byClientSource: data.byClientSource
        }
      },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  }

  // ── xlsx：原有行为，保持不变 ──
  let buf: Buffer;
  try {
    buf = await buildReportWorkbook(period, access);
  } catch (err) {
    console.error("[reports/export] 生成失败：", err);
    return NextResponse.json({ error: "导出失败" }, { status: 500 });
  }

  await audit({
    userId: session.user.id,
    action: "REPORT_EXPORT",
    targetType: "Report",
    targetId: periodKey,
    detail: { periodLabel: period.label, periodKey, bytes: buf.byteLength }
  });

  const startTag = shDayKey(period.start);
  const filename = `lawlink-report-${periodKey}-${startTag}.xlsx`;
  const arr = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  return new NextResponse(arr, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Length": String(buf.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`
    }
  });
}
