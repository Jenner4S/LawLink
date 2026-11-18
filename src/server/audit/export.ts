import { auditActionLabel, auditTargetLabel } from "@/lib/audit-labels";

/**
 * 审计日志导出格式转换。
 *
 * 三种格式的取舍：
 *   CEF     —— ArcSight 提出、被 Splunk / QRadar / Sentinel 广泛支持，字段语义固定，
 *              适合直接灌进 SOC。自定义字段走 cs1/cs2 这类槽位。
 *   JSON    —— 结构化，字段名自带语义，适合自建管道或落数据湖。
 *   Syslog  —— RFC 5424，老的日志收集器（rsyslog / syslog-ng）直接吃。
 *
 * 共同要求：必须带 integrityHash，接收方才能校验审计链没断。
 */

export interface ExportRow {
  id: string;
  userId: string | null;
  userEmail: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: unknown;
  ip: string | null;
  userAgent: string | null;
  integrityHash: string | null;
  createdAt: Date;
}

/** CEF 扩展字段值需要转义：\ | = 换行 */
function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
}

/**
 * 严重度按动作语义粗分（CEF 要求 0-10）：
 *   删除/终止/强制/停用类 = 7（高危操作）
 *   更正/驳回/退回/解除 = 5（影响既有状态）
 *   其余 = 3（常规）
 * 这不是安全评级，只是让 SIEM 侧能分级筛选。
 */
function severityOf(action: string): number {
  if (/(DELETE|TERMINATE|ENFORCE|DISABLE|REVOKE|VOID|REJECT)/.test(action)) return 7;
  if (/(CORRECTION|ADJUST|MERGE|RETURN|UNBIND|RESET|EXPORT|REVEAL)/.test(action)) return 5;
  return 3;
}

/** CEF:0|Vendor|Product|Version|EventClassID|Name|Severity|Extension */
export function toCef(row: ExportRow): string {
  const act = auditActionLabel(row.action);
  const ext = [
    `rt=${row.createdAt.getTime()}`,
    `suser=${esc(row.userEmail ?? row.userId ?? "system")}`,
    `cs1Label=目标类型`,
    `cs1=${esc(auditTargetLabel(row.targetType))}`,
    row.targetId ? `cs2Label=目标ID cs2=${esc(row.targetId)}` : "",
    row.ip ? `src=${esc(row.ip)}` : "",
    row.integrityHash ? `cs3Label=完整性摘要 cs3=${row.integrityHash}` : "",
    `externalId=${row.id}`
  ]
    .filter(Boolean)
    .join(" ");

  return `CEF:0|LawLink|LawLink|2.0|${esc(row.action)}|${esc(act)}|${severityOf(row.action)}|${ext}`;
}

/** RFC 5424：<PRI>1 TIMESTAMP HOST APP PROCID MSGID [SD] MSG */
export function toSyslog(row: ExportRow): string {
  // PRI = facility(13=log audit) * 8 + severity(6=info)
  const pri = 13 * 8 + 6;
  const ts = row.createdAt.toISOString();
  const act = auditActionLabel(row.action);
  const sd =
    `[lawlink@0 action="${row.action}"` +
    ` actor="${row.userEmail ?? row.userId ?? "system"}"` +
    ` targetType="${row.targetType ?? ""}"` +
    ` targetId="${row.targetId ?? ""}"` +
    (row.integrityHash ? ` integrity="${row.integrityHash}"` : "") +
    `]`;
  return `<${pri}>1 ${ts} lawlink lawlink - ${esc(row.action)} ${sd} ${act}`;
}

export function toJsonExport(rows: ExportRow[], meta: { truncated: boolean; maxRows: number }) {
  return {
    schema: "lawlink.audit.export/v1",
    exportedAt: new Date().toISOString(),
    count: rows.length,
    truncated: meta.truncated,
    maxRows: meta.maxRows,
    note: meta.truncated
      ? `结果超过 ${meta.maxRows} 条已截断，请用 from/to 分段导出`
      : undefined,
    records: rows.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      action: r.action,
      actionLabel: auditActionLabel(r.action),
      actor: r.userEmail ?? r.userId ?? null,
      target: { type: r.targetType, label: auditTargetLabel(r.targetType), id: r.targetId },
      detail: r.detail,
      ip: r.ip,
      userAgent: r.userAgent,
      integrityHash: r.integrityHash
    }))
  };
}
