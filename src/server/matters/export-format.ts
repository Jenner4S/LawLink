import type ExcelJS from "exceljs";
import type {
  LitigationStanding,
  PartyRole,
  PartyType,
  Prisma
} from "@prisma/client";
import { parseShDayEnd, parseShDayStart, shDayKey, shTime } from "@/lib/ui/sh-time";
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

// 2026-11-21：定义已移到 lib/enums.ts（界面层也要用），此处保留 re-export 不破既有 import。
import { procedureStatusLabel as _psl, procedureOutcomeLabel as _pol } from "@/lib/enums";
export { procedureStatusLabel } from "@/lib/enums";

export { procedureEngagementLabel } from "@/lib/enums";

export { procedureOutcomeLabel } from "@/lib/enums";

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
        procedure.status ? _psl[procedure.status] : "",
        procedure.acceptedAt ? `受理:${formatDate(procedure.acceptedAt)}` : "",
        procedure.concludedAt ? `结案:${formatDate(procedure.concludedAt)}` : "",
        procedure.outcome ? `结果:${_pol[procedure.outcome]}` : ""
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
  // 2026-11-20：日期回验统一走 lib/ui/sh-time 的 parseShDayStart / parseShDayEnd。
  // 此前这里手写过一份回验（`shDayKey(parsed) !== input`），而同样的校验在
  // emails / ethical-walls / sms 三处也各有一份 —— 四份实现里两份漏了月日，
  // 导致 `2026-02-30` 被静默滚成 3 月 2 日。收成一处就不再有「哪份没跟上」。
  return endOfDay ? parseShDayEnd(input) ?? undefined : parseShDayStart(input) ?? undefined;
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
