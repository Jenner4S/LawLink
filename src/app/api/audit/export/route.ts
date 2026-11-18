import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";

import { authOptions } from "@/lib/auth/options";
import { isSystemAdmin } from "@/lib/auth/system-role";
import { isManager } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { toCef, toSyslog, toJsonExport, type ExportRow } from "@/server/audit/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 单次导出上限，避免一次拉爆内存；超出时提示分段导出 */
const MAX_ROWS = 5000;

/**
 * 审计日志导出（SIEM 对接）
 *
 * 支持三种格式：
 *   - cef     ArcSight / Splunk / QRadar 通用的 Common Event Format
 *   - json    结构化数组，便于自建管道
 *   - syslog  RFC 5424
 *
 * 每条记录都带 integrityHash，接收方可据此校验审计链完整性。
 * 导出动作本身写审计（AUDIT_EXPORT），避免「导出」成为不可追溯的数据出口。
 */
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  if (!isSystemAdmin(session.user) && !isManager(session.user)) {
    return NextResponse.json({ error: "无权导出审计日志" }, { status: 403 });
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") ?? "json").toLowerCase();
  if (!["cef", "json", "syslog"].includes(format)) {
    return NextResponse.json({ error: "format 仅支持 cef / json / syslog" }, { status: 400 });
  }

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");
  const from = fromParam ? new Date(fromParam) : null;
  const to = toParam ? new Date(toParam) : null;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
    return NextResponse.json({ error: "from / to 需为可解析的日期" }, { status: 400 });
  }

  const rows = await prisma.auditLog.findMany({
    where: {
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {})
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: MAX_ROWS + 1,
    select: {
      id: true, userId: true, action: true, targetType: true, targetId: true,
      detail: true, ip: true, userAgent: true, integrityHash: true, createdAt: true
    }
  });

  const truncated = rows.length > MAX_ROWS;
  const sliced = truncated ? rows.slice(0, MAX_ROWS) : rows;

  // 取用户邮箱，CEF 里用 suuser（subject user）比裸 id 可读
  const userIds = [...new Set(sliced.map((r) => r.userId).filter((v): v is string => !!v))];
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } })
    : [];
  const emailById = new Map(users.map((u) => [u.id, u.email]));

  const exportRows: ExportRow[] = sliced.map((r) => ({
    ...r,
    userEmail: r.userId ? (emailById.get(r.userId) ?? null) : null
  }));

  // 导出留痕（失败不阻断导出，但会记在服务端日志）
  await prisma.auditLog
    .create({
      data: {
        userId: session.user.id,
        action: "AUDIT_EXPORT",
        targetType: "AuditLog",
        detail: { format, count: exportRows.length, truncated, from: fromParam, to: toParam }
      }
    })
    .catch((err) => console.error("[audit-export] 留痕失败：", err));

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
  const filename = `lawlink-audit-${stamp}.${format === "json" ? "json" : "log"}`;
  const contentType =
    format === "json" ? "application/json; charset=utf-8" : "text/plain; charset=utf-8";

  let body: string;
  if (format === "cef") body = exportRows.map(toCef).join("\n") + "\n";
  else if (format === "syslog") body = exportRows.map(toSyslog).join("\n") + "\n";
  else body = JSON.stringify(toJsonExport(exportRows, { truncated, maxRows: MAX_ROWS }), null, 2);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      // 让调用方知道是否被截断
      "X-Audit-Truncated": truncated ? "true" : "false",
      "X-Audit-Rows": String(exportRows.length)
    }
  });
}
