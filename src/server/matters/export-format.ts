import type ExcelJS from "exceljs";
import type {
  LitigationStanding,
  PartyRole,
  PartyType,
  ProcedureEngagement,
  ProcedureOutcome,
  ProcedureStatus,
  Prisma
} from "@prisma/client";
import { shDayKey, shTime } from "@/lib/ui/sh-time";
import { litigationStandingLabel, partyTypeLabel, procedureTypeLabel } from "@/lib/enums";
import type { MatterExportRow, MattersExportTab } from "./export-query";

/**
 * 案件工作簿导出的纯格式化函数。
 *
 * 只做「值 → 单元格文本」的转换：不查询、不写库、不改状态。
 * 与 export-xlsx.ts 之间仅有类型级依赖（MatterExportRow / MattersExportTab 用 import type 引入，
 * 编译期擦除，运行时依赖方向始终是 export-xlsx → export-format，不存在运行时循环）。
 */

const partyRoleLabel: Record<PartyRole, string> = {
  CLIENT_PARTY: "委托方",
  OPPOSING_PARTY: "对方",
  THIRD_PARTY: "第三人",
  CO_LITIGANT: "共同当事人",
  AGENT: "代理人",
  WITNESS: "证人",
  OTHER: "其他"
};

export const procedureStatusLabel: Record<ProcedureStatus, string> = {
  PENDING: "未开始",
  IN_PROGRESS: "进行中",
  CONCLUDED: "已结束"
};

export const procedureEngagementLabel: Record<ProcedureEngagement, string> = {
  ENGAGED: "承办",
  INFORMATIONAL: "仅登记"
};

export const procedureOutcomeLabel: Record<ProcedureOutcome, string> = {
  WON: "胜诉",
  PARTIAL_WON: "部分胜诉",
  LOST: "败诉",
  MEDIATED: "调解",
  WITHDRAWN: "撤诉",
  DISMISSED: "驳回",
  COMPLETED: "完成",
  TRANSFERRED: "移送",
  OTHER: "其他"
};

const TAB_FILE_KEY: Record<MattersExportTab, string> = {
  all: "all",
  intake: "intake",
  active: "active",
  revision: "revision",
  archived: "archived"
};

export function formatProcedureSummary(procedures: MatterExportRow["procedures"]) {
  return procedures
    .map((procedure) =>
      [
        label(procedureTypeLabel, procedure.type),
        procedure.customLabel,
        procedure.caseNumber,
        procedure.handlingAgency,
        procedure.status ? procedureStatusLabel[procedure.status] : "",
        procedure.acceptedAt ? `受理:${formatDate(procedure.acceptedAt)}` : "",
        procedure.concludedAt ? `结案:${formatDate(procedure.concludedAt)}` : "",
        procedure.outcome ? `结果:${procedureOutcomeLabel[procedure.outcome]}` : ""
      ].filter(Boolean).join(" / ")
    )
    .join("；");
}

export function formatParties(parties: { role: PartyRole; standing: LitigationStanding | null; partyType: PartyType; name: string; idNumber: string | null; enterpriseSocialCode: string | null; phone: string | null; address: string | null; legalRep: string | null; contactName: string | null; notes: string | null }[]) {
  return parties
    .map((party) => `${partyRoleLabel[party.role]}：${formatParty(party)}`)
    .join("；");
}

export function formatParty(party: {
  standing?: LitigationStanding | null;
  partyType: PartyType;
  name: string;
  idNumber?: string | null;
  enterpriseSocialCode?: string | null;
  phone?: string | null;
  address?: string | null;
  legalRep?: string | null;
  contactName?: string | null;
  notes?: string | null;
}) {
  const detail = [
    label(litigationStandingLabel, party.standing),
    partyTypeLabel[party.partyType],
    party.idNumber ? `证件:${party.idNumber}` : "",
    party.enterpriseSocialCode ? `代码:${party.enterpriseSocialCode}` : "",
    party.phone ? `电话:${party.phone}` : "",
    party.legalRep ? `法定代表人:${party.legalRep}` : "",
    party.contactName ? `联系人:${party.contactName}` : "",
    party.address ? `地址:${party.address}` : "",
    party.notes ? `备注:${party.notes}` : ""
  ].filter(Boolean);
  return detail.length > 0 ? `${party.name}（${detail.join("，")}）` : party.name;
}

export function formatContacts(
  contacts: { name: string; title: string | null; phone: string | null; email: string | null; isPrimary: boolean }[]
) {
  return contacts
    .map((contact) =>
      [
        contact.isPrimary ? "主" : "",
        contact.name,
        contact.title,
        contact.phone,
        contact.email
      ].filter(Boolean).join(" / ")
    )
    .join("；");
}

export function formatDocuments(documents: { name: string; category: string; createdAt: Date }[]) {
  return documents
    .map((doc) => `${doc.name}（${doc.category}，${formatDate(doc.createdAt)}）`)
    .join("；");
}

export function formatRelatedMatters(matter: MatterExportRow) {
  const from = matter.linksFrom.map((link) => link.relatedMatter);
  const to = matter.linksTo.map((link) => link.matter);
  return [...from, ...to]
    .map((row) => `${row.firmCaseNo ?? row.internalCode} ${row.title}`)
    .join("；");
}

export function polishSheet(sheet: ExcelJS.Worksheet, moneyColumnKeys: string[]) {
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).alignment = { vertical: "middle" };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: sheet.columnCount }
  };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) {
      row.alignment = { vertical: "top", wrapText: true };
    }
  });
  const columnKeys = new Set(sheet.columns.map((column) => column.key).filter(Boolean));
  for (const key of moneyColumnKeys) {
    if (columnKeys.has(key)) {
      sheet.getColumn(key).numFmt = "#,##0.00";
    }
  }
}

export function buildFilename(tab: MattersExportTab) {
  return `lawlink-matters-${TAB_FILE_KEY[tab]}-${formatDate(new Date())}.xlsx`;
}

export function sheetName(name: string) {
  return name.replace(/[\\/:*?\[\]]/g, "").slice(0, 31) || "Sheet";
}

export function cleanText(input: string | null) {
  const value = input?.trim();
  return value || undefined;
}

export function cleanDateText(input: string | null) {
  const value = cleanText(input);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
}

export function resolveDateBoundary(input: string | undefined, endOfDay: boolean) {
  if (!input) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return undefined;
  // 2026-09-20 第五轮审计时区修复：导出过滤边界按上海日界（此前服务器本地构造，
  // UTC 容器用户选 2026-09-20 实际筛上海 09-20 08:00 起，漏当日 0-8 点）
  const at = endOfDay ? `${input}T23:59:59.999+08:00` : `${input}T00:00:00+08:00`;
  const parsed = new Date(at);
  // 2026-11-20：格式合规但**日期不存在**的输入会被 V8 静默滚动，必须回验。
  // 实测 `2026-02-30` → 上海 3 月 2 日、`2026-02-29`（非闰年）→ 3 月 1 日、
  // `2026-04-31` → 5 月 1 日。界面用的是 <input type="date">，浏览器会拦住，
  // 但直接调接口（脚本、导入、桌面端）不经过那一层 —— 于是用户以为筛的是
  // 2 月 30 日，实际拿到别的日期区间，且没有任何提示。
  // 回验方式：把解析结果按上海日取回 key，必须与输入逐字相同。
  if (Number.isNaN(parsed.getTime()) || shDayKey(parsed) !== input) return undefined;
  return parsed;
}

export function formatDate(date: Date | null | undefined) {
  if (!date) return "";
  return shDayKey(date);
}

export function formatDateTime(date: Date | null | undefined) {
  if (!date) return "";
  return `${shDayKey(date)} ${shTime(date)}`;
}

export function decimalNumber(value: Prisma.Decimal | number | null | undefined) {
  if (value === null || value === undefined) return "";
  return Number(value);
}

export function yesNo(value: boolean | null | undefined) {
  return value ? "是" : "否";
}

export function label<T extends string>(
  labels: Partial<Record<T, string>>,
  value: T | null | undefined
) {
  return value ? labels[value] ?? value : "";
}

export function formatJson(value: Prisma.JsonValue) {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.length > 0 ? JSON.stringify(value) : "";
  if (typeof value === "object") {
    return Object.keys(value).length > 0 ? JSON.stringify(value) : "";
  }
  return String(value);
}
