import ExcelJS from "exceljs";
import { MatterCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { matterCategoryKind, matterCategoryLabel } from "@/lib/enums";

// 纯格式化函数已拆分至 export-format.ts；此处 import 供本文件使用，re-export 保持既有引用不变。
import {
  buildFilename, cleanDateText, cleanText, polishSheet, sheetName
} from "./export-format";

export {
  buildFilename, cleanDateText, cleanText, decimalNumber, formatContacts, formatDate, formatDateTime,
  formatDocuments, formatJson, formatParties, formatParty, formatProcedureSummary, formatRelatedMatters,
  label, polishSheet, resolveDateBoundary, sheetName, yesNo
} from "./export-format";

/**
 * 案件工作簿导出（编排层）。
 *
 * 依赖方向（单向，无环）：
 *   export-xlsx（编排层）
 *     → export-query   （取数：where / include / 排序 / 分组）
 *     → export-rows    （行装配）
 *     → export-columns （静态列元数据）
 *     → export-format  （纯格式化）
 *
 * 共享类型（MattersExportTab / MattersExportParams / ExportUser / 行类型）下沉至 export-query，
 * 避免下层反向 import 本文件。export-format 仅以 `import type` 引用类型，编译期擦除。
 */

import {
  MATTER_CATEGORIES,
  buildIntakeWhere,
  buildMatterWhere,
  defaultSortByForTab,
  groupRowsByCategory,
  intakeInclude,
  intakeOrderBy,
  loadUserNameMap,
  matterInclude,
  normalizeSortByForTab,
  sortMatterRows
} from "./export-query";
import type { ExportUser, MattersExportParams, MattersExportTab } from "./export-query";
import { intakeColumnsForKind, matterColumnsForKind } from "./export-columns";
import { buildIntakeRow, buildMatterRow } from "./export-rows";

// 原本对外导出的类型继续从本模块导出，其他文件（API 路由、测试）无需改动。
export type { MatterExportRow, MattersExportParams, MattersExportTab } from "./export-query";

const EXPORT_TABS: MattersExportTab[] = [
  "intake",
  "active",
  "archived",
  "revision",
  "all"
];

const TAB_LABEL: Record<MattersExportTab, string> = {
  all: "全部案件",
  intake: "待审批",
  active: "进行中",
  revision: "待补正",
  archived: "已归档"
};

export function resolveMattersExportParams(searchParams: URLSearchParams): MattersExportParams {
  const rawTab = searchParams.get("tab");
  const tab = EXPORT_TABS.includes(rawTab as MattersExportTab)
    ? (rawTab as MattersExportTab)
    : "active";
  const rawSortBy = searchParams.get("sortBy");
  const candidateSortBy =
    rawSortBy === "hearing" ||
    rawSortBy === "intakeDate" ||
    rawSortBy === "claimAmount" ||
    rawSortBy === "archivedAt"
      ? rawSortBy
      : undefined;
  const sortBy = normalizeSortByForTab(tab, candidateSortBy ?? defaultSortByForTab(tab));
  const rawCategory = searchParams.get("category");
  const category = MATTER_CATEGORIES.includes(rawCategory as MatterCategory)
    ? (rawCategory as MatterCategory)
    : undefined;

  return {
    tab,
    scope: searchParams.get("scope") === "mine" ? "mine" : searchParams.get("scope") === "team" ? "team" : "all",
    teamId: cleanText(searchParams.get("teamId")),
    ownerId: cleanText(searchParams.get("ownerId")),
    search: cleanText(searchParams.get("search")),
    category,
    status: cleanText(searchParams.get("status")),
    from: cleanDateText(searchParams.get("from")),
    to: cleanDateText(searchParams.get("to")),
    sortBy,
    sortDir: searchParams.get("sortDir") === "asc" ? "asc" : "desc"
  };
}

export async function buildMattersExportWorkbook(
  params: MattersExportParams,
  user: ExportUser
): Promise<{ buffer: Buffer; filename: string; total: number; tabLabel: string }> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "LawLink";
  wb.created = new Date();

  const total =
    params.tab === "intake" || params.tab === "revision"
      ? await addIntakesSheet(wb, params, user)
      : await addMattersSheet(wb, params, user);

  const raw = await wb.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(raw),
    filename: buildFilename(params.tab),
    total,
    tabLabel: TAB_LABEL[params.tab]
  };
}

async function addIntakesSheet(
  wb: ExcelJS.Workbook,
  params: MattersExportParams,
  user: ExportUser
) {
  const where = buildIntakeWhere(params, user);
  const rows = await prisma.intake.findMany({
    where,
    orderBy: intakeOrderBy(params),
    include: intakeInclude
  });
  const coUserNames = await loadUserNameMap(rows.flatMap((row) => row.coUserIds));
  const groups = groupRowsByCategory(rows, params.category);
  if (groups.length === 0) {
    const sheet = wb.addWorksheet("无数据");
    sheet.columns = intakeColumnsForKind("litigation");
    polishSheet(sheet, ["money", "feeAmount"]);
    return 0;
  }
  for (const group of groups) {
    const sheet = wb.addWorksheet(sheetName(`${TAB_LABEL[params.tab]}-${matterCategoryLabel[group.category]}`));
    sheet.columns = intakeColumnsForKind(matterCategoryKind(group.category));
    for (const intake of group.rows) {
      sheet.addRow(buildIntakeRow(intake, coUserNames));
    }
    polishSheet(sheet, ["money", "feeAmount"]);
  }
  return rows.length;
}

async function addMattersSheet(
  wb: ExcelJS.Workbook,
  params: MattersExportParams,
  user: ExportUser
) {
  const where = buildMatterWhere(params, user);
  const rows = sortMatterRows(
    await prisma.matter.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }],
      include: matterInclude
    }),
    params
  );
  const coUserNames = await loadUserNameMap(
    rows.flatMap((row) => row.intake?.coUserIds ?? [])
  );
  const groups = groupRowsByCategory(rows, params.category);
  if (groups.length === 0) {
    const sheet = wb.addWorksheet("无数据");
    sheet.columns = matterColumnsForKind("litigation", 1);
    polishSheet(sheet, ["claimAmount", "sourceClaimAmount", "sourceFeeAmount"]);
    return 0;
  }
  for (const group of groups) {
    const kind = matterCategoryKind(group.category);
    const maxProcedures =
      kind === "litigation"
        ? Math.max(
            1,
            group.rows.reduce((max, row) => Math.max(max, row.procedures.length), 0)
          )
        : 0;
    const sheet = wb.addWorksheet(sheetName(matterCategoryLabel[group.category]));
    sheet.columns = matterColumnsForKind(kind, maxProcedures);
    for (const matter of group.rows) {
      sheet.addRow(buildMatterRow(matter, maxProcedures, coUserNames));
    }
    polishSheet(sheet, ["claimAmount", "sourceClaimAmount", "sourceFeeAmount"]);
  }
  return rows.length;
}
