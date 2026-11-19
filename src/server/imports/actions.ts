"use server";
import { approvalSettings } from "@/lib/approvals/service";
import { isManager } from "@/lib/permissions";

import { revalidatePath } from "next/cache";
import ExcelJS from "exceljs";

import { prisma } from "@/lib/prisma";
import { shDayKey } from "@/lib/ui/sh-time";
import { requireSession } from "@/lib/auth/session";
import { isSystemAdmin } from "@/lib/auth/system-role";
import { audit } from "@/server/audit";
import { seedDefaultFolders } from "@/lib/default-folders";
import { generateInternalCode, generateFirmCaseNo } from "@/server/matters/code-generator";
import { generateClientCode } from "@/server/clients/code-generator";
import { assertCauseAllowedForSelection } from "@/server/causes/validation";
import { normalizeIdNumber, duplicateWhereInput, suggestIdType } from "@/lib/clients/identity";
import { sealIdNumber, blindIdNumber } from "@/lib/clients/id-number-crypto";
import { recordTimelineEvent } from "@/server/timeline/record";
import {
  IMPORT_COLUMNS,
  validateRow,
  buildMatterTitle,
  firstProcedureTypeFor,
  type RawRow,
  type NormalizedRow
} from "@/lib/imports/matter-import";
import { ActionError } from "@/lib/action-error";
import type { ConflictConclusion, ConflictSeverity } from "@prisma/client";
import { recordImportConflictReview } from "./conflict";

async function requireManager() {
  const session = await requireSession();
  if (!isSystemAdmin(session.user) && !isManager(session.user)) {
    throw new ActionError("仅系统超级管理员 / 主任律师可批量导入案件");
  }
  return session;
}

/** Excel 单元格值 → 字符串（日期统一格式化为 YYYY-MM-DD） */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // 2026-09-20 第五轮审计时区修复：ExcelJS 日期单元格是 UTC 午夜真瞬间，
    // 本地取日在西于 UTC 的部署会差一天——统一上海日键
    return shDayKey(value);
  }
  if (typeof value === "object") {
    // 富文本 / 公式结果
    const obj = value as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (obj.richText) return obj.richText.map((r) => r.text).join("");
    if (obj.text !== undefined) return String(obj.text);
    if (obj.result !== undefined) return String(obj.result);
    return "";
  }
  return String(value).trim();
}

/** 解析上传的 xlsx → [{ rowNo, raw }]，rowNo 为 Excel 行号（含表头，从 2 起） */
async function readSheet(file: File): Promise<{ rowNo: number; raw: RawRow }[]> {
  const buf = Buffer.from(await file.arrayBuffer());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new ActionError("文件中没有工作表");

  // 表头 → 列索引（去掉必填星号，匹配 IMPORT_COLUMNS.header）
  const headerByIndex = new Map<number, string>(); // colIndex → field key
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const text = cellToString(cell.value).replace(/\*$/, "").trim();
    const col = IMPORT_COLUMNS.find((c) => c.header === text);
    if (col) headerByIndex.set(colNumber, col.key);
  });
  if (headerByIndex.size === 0) {
    throw new ActionError("未识别到表头，请使用下载的模板填写");
  }

  const rows: { rowNo: number; raw: RawRow }[] = [];
  for (let r = 2; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const raw: RawRow = {};
    let hasAny = false;
    for (const [colIndex, key] of headerByIndex) {
      const v = cellToString(row.getCell(colIndex).value);
      if (v) hasAny = true;
      raw[key] = v;
    }
    if (hasAny) rows.push({ rowNo: r, raw });
  }
  return rows;
}

export interface ImportPreviewRow {
  rowNo: number;
  raw: RawRow;
  errors: string[];
  valid: boolean;
}

export interface ImportPreview {
  columns: { key: string; header: string; required: boolean }[];
  rows: ImportPreviewRow[];
  total: number;
  validCount: number;
}

/** 解析 + 校验（不写库），返回预览表 */
export async function parseMatterImportAction(formData: FormData): Promise<ImportPreview> {
  await requireManager();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new ActionError("缺少文件");

  const parsed = await readSheet(file);
  if (parsed.length === 0) {
    throw new ActionError("未读取到数据行（请在模板第 2 行起填写，并删除示例行）");
  }

  // 预取主办律师邮箱，用于校验
  const emails = [
    ...new Set(parsed.map((p) => (p.raw.ownerEmail ?? "").trim().toLowerCase()).filter(Boolean))
  ];
  const lawyers = emails.length
    ? await prisma.user.findMany({ where: { email: { in: emails } }, select: { email: true } })
    : [];
  const knownEmails = new Set(lawyers.map((l) => l.email.toLowerCase()));

  const rows: ImportPreviewRow[] = parsed.map(({ rowNo, raw }) => {
    const { errors, normalized } = validateRow(raw);
    const errs = [...errors];
    if (normalized?.ownerEmail && !knownEmails.has(normalized.ownerEmail.toLowerCase())) {
      errs.push(`主办律师邮箱「${normalized.ownerEmail}」未匹配到用户`);
    }
    return { rowNo, raw, errors: errs, valid: errs.length === 0 };
  });

  return {
    columns: IMPORT_COLUMNS.map((c) => ({ key: c.key, header: c.header, required: c.required })),
    rows,
    total: rows.length,
    validCount: rows.filter((r) => r.valid).length
  };
}

/** 落库单行：find-or-create 客户 → 建案件(+编号+主办+当事人+首程序+卷宗) */
async function createOneMatter(n: NormalizedRow, currentUserId: string) {
  // 主办律师
  let ownerId = currentUserId;
  if (n.ownerEmail) {
    const lawyer = await prisma.user.findFirst({
      where: { email: { equals: n.ownerEmail, mode: "insensitive" } },
      select: { id: true }
    });
    if (!lawyer) throw new ActionError(`主办律师邮箱「${n.ownerEmail}」未匹配到用户`);
    ownerId = lawyer.id;
  }

  // 案由：精确匹配案由库，否则作为自由文本
  let causeId: string | null = null;
  let causeFreeText: string | null = null;
  let causeDowngradeReason: string | null = null;
  if (n.causeText) {
    const cause = await prisma.causeOfAction.findFirst({
      where: { name: n.causeText },
      select: { id: true }
    });
    if (cause) causeId = cause.id;
    else causeFreeText = n.causeText;
  }

  // v1.2：导入曾是唯一绕过案由校验的写入路径，能造出界面创建不出来的组合
  // （如劳动仲裁案件挂婚姻家庭类案由）。校验基准与创建案件一致：类别 + 首程序类型。
  //
  // 不合规时降级为自由文本、不整行失败：导入是历史数据迁移工具，历史案件按当时
  // 规则立的案由未必符合现行范围，为一个案由把整条案件挡在门外代价过大。
  // 自由文本字段本就不参与联动校验，信息不丢，降级情况在导入结果里逐行列出。
  if (causeId) {
    try {
      await assertCauseAllowedForSelection({
        causeId,
        category: n.category,
        procedureType: firstProcedureTypeFor(n.category)
      });
    } catch (e) {
      causeDowngradeReason = e instanceof Error ? e.message : "案由与案件类别不匹配";
      causeFreeText = n.causeText ?? null;
      causeId = null;
    }
  }

  const internalCode = await generateInternalCode(n.category);
  const firmCaseNo = await generateFirmCaseNo(n.category);

  // v1.x P0-1: find-or-create 客户——先按证件精确（规范化后，含证件类型），
  // 再按名称+证件号；两者皆无才新建并写入证件类型。批量导入不做交互式
  // 查重（行级结果里列出"复用了哪个客户"），但规范化口径与建档入口一致。
  const normalizedClientIdNumber = normalizeIdNumber(n.clientIdNumber);
  const importIdType = suggestIdType(n.clientPartyType === "NATURAL_PERSON" ? "INDIVIDUAL" : "COMPANY");
  let existingClient = normalizedClientIdNumber && importIdType
    ? await prisma.client.findFirst({
        where: duplicateWhereInput({ idType: importIdType, idNumber: normalizedClientIdNumber }),
        select: { id: true }
      })
    : null;
  if (!existingClient) {
    existingClient = await prisma.client.findFirst({
      where: {
        name: n.clientName,
        ...(normalizedClientIdNumber ? { idNumberBlind: blindIdNumber(normalizedClientIdNumber) } : {}),
        deletedAt: null
      },
      select: { id: true }
    });
  }
  const clientCode = existingClient ? null : await generateClientCode();

  const title = buildMatterTitle(n.clientName, n.opposingName, n.causeText);
  const intakeDate = n.intakeDate ?? new Date();

  const clientParty = {
    role: "CLIENT_PARTY" as const,
    ordinal: 1,
    name: n.clientName,
    partyType: n.clientPartyType,
    idNumber: n.clientIdNumber,
    phone: n.clientPhone,
    ...(n.clientPartyType !== "NATURAL_PERSON"
      ? { enterpriseSocialCode: n.clientIdNumber, enterpriseName: n.clientName }
      : {})
  };
  const opposingParty = {
    role: "OPPOSING_PARTY" as const,
    ordinal: 1,
    name: n.opposingName,
    partyType: n.opposingPartyType,
    idNumber: n.opposingIdNumber,
    ...(n.opposingPartyType !== "NATURAL_PERSON"
      ? { enterpriseSocialCode: n.opposingIdNumber, enterpriseName: n.opposingName }
      : {})
  };

  const result = await prisma.$transaction(async (tx) => {
    const clientId =
      existingClient?.id ??
      (
        await tx.client.create({
          data: {
            name: n.clientName,
            type: n.clientType,
            idType: normalizedClientIdNumber ? (importIdType ?? undefined) : undefined,
            ...(normalizedClientIdNumber ? sealIdNumber(normalizedClientIdNumber) : {}),
            phone: n.clientPhone,
            internalCode: clientCode
          },
          select: { id: true }
        })
      ).id;

    const matter = await tx.matter.create({
      data: {
        internalCode,
        firmCaseNo,
        title,
        category: n.category,
        status: n.status,
        ownerId,
        registeredById: currentUserId,
        intakeDate,
        claimAmount: n.claimAmount ?? undefined,
        causeId,
        causeFreeText,
        closedAt: n.status === "CLOSED" ? new Date() : null,
        archivedAt: n.status === "ARCHIVED" ? new Date() : null,
        primaryClientId: clientId,
        members: { create: { userId: ownerId, role: "LEAD" } },
        clientLinks: { create: { clientId, isPrimary: true, label: "主要委托方" } },
        parties: { create: [clientParty, opposingParty] },
        // 办理中按类别自动生成首程序（与收案转化一致）；结案/归档不建
        ...(n.status === "IN_PROGRESS"
          ? {
              procedures: {
                create: {
                  type: firstProcedureTypeFor(n.category),
                  engagement: "ENGAGED",
                  order: 1,
                  status: "IN_PROGRESS",
                  jurisdiction: n.jurisdiction,
                  // 历史案件迁移：法院案号写进首程序，否则列表全显示「暂无案号」
                  ...(n.caseNumber ? { caseNumber: n.caseNumber } : {})
                }
              },
              firstAcceptedAt: intakeDate
            }
          : {})
      },
      select: { id: true, internalCode: true, firmCaseNo: true, title: true }
    });

    await recordTimelineEvent(tx, {
        matterId: matter.id,
        eventType: "MATTER_CREATED",
        title: "案件已创建（批量导入）",
        occurredAt: new Date()
      });

    await seedDefaultFolders(tx, matter.id, n.category);

    // P1-1：导入必须跑利益冲突检索。历史案件迁进来后，所内必须知道本案对方是不是
    // 本所代理过的客户（执业违规风险）。口径与收案转正式案件完全一致——复用
    // recordMatterReviewTx，落 ConflictCheck(matterId) + ConflictHit，不重写算法。
    // 与建案同一事务：检索失败整行回滚，不留「案件已建但从未检索」的半状态。
    const conflict = await recordImportConflictReview(tx, currentUserId, matter.id);

    return { ...matter, conflict };
  });

  return { ...result, causeDowngradeReason };
}

export interface ImportResult {
  succeeded: {
    rowNo: number;
    internalCode: string;
    firmCaseNo: string | null;
    title: string;
    /** 案由与案件类别不匹配、已降级为自由文本；需事后人工核对 */
    causeDowngradeReason?: string;
    /** 本行利益冲突检索记录 ID（P1-1）；老库未启用动态复核时缺省 */
    conflictCheckId?: string;
    /** 命中冲突条数；0 表示系统检索未命中（与收案「未命中（系统自动提示）」同口径） */
    conflictHitCount?: number;
    /** 命中中的最高严重度 */
    conflictMaxSeverity?: ConflictSeverity;
    /** 检索结论：未命中自动 DIFFERENT；有命中停在 PENDING 等律师复核 */
    conflictConclusion?: ConflictConclusion;
    /** 中文一行摘要，命中时写明「命中 N 条冲突」 */
    conflictSummary?: string;
  }[];
  failed: { rowNo: number; error: string }[];
  /** 本次导入的利益冲突检索汇总（P1-1）：检出/未检出/跳过（老库未启用） */
  conflictTotals?: { checked: number; hitRows: number; hitCount: number; skipped: number };
}

/** 确认导入：逐行事务、失败不阻断，返回成功/失败清单 */
export async function commitMatterImportAction(input: {
  rows: { rowNo: number; raw: RawRow }[];
}): Promise<ImportResult> {
  const session = await requireManager();
  // 历史数据迁移专用开关：approvalSettings().enabled 硬编码为 true，原逻辑会让批量导入
  // 永久不可达。迁移场景下逐件走审批不现实，故允许通过环境变量显式放行——
  // 默认行为不变，只有部署方主动设置 LAWLINK_ALLOW_BULK_IMPORT=1 才放行。
  const bulkImportBypass = process.env.LAWLINK_ALLOW_BULK_IMPORT === "1";
  if (!bulkImportBypass && (await approvalSettings()).enabled) {
    throw new ActionError("按事项审批已启用，批量直接立案已停用，请使用收案审批流程（或在部署环境设置 LAWLINK_ALLOW_BULK_IMPORT=1 以导入历史数据）");
  }
  const succeeded: ImportResult["succeeded"] = [];
  const failed: ImportResult["failed"] = [];

  // 2026-11-21（审计发现）：批次开始即留痕。
  //
  // 原实现只在循环**结束后**写一条 MATTER_IMPORT 审计，而每一行是独立事务
  // （createOneMatter 内 $transaction）。若中途进程被杀/函数超时，
  // 已提交的案件存在，但那条收尾审计永远不会写 —— 出现「有案件、无导入痕迹」，
  // 事后无法回答「这些案件是哪一次导入建的」。
  //
  // 现在开始前先写 MATTER_IMPORT_BEGIN（含行数），结束时照旧写 MATTER_IMPORT。
  // 两者用同一 batchId 关联，中断时至少能凭 BEGIN 查到「有过这次导入、导了多少行」。
  const batchId = `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await audit({
    userId: session.user.id,
    action: "MATTER_IMPORT_BEGIN",
    targetType: "Matter",
    detail: { batchId, rows: input.rows.length }
  });

  for (const { rowNo, raw } of input.rows) {
    try {
      const { errors, normalized } = validateRow(raw);
      if (!normalized) throw new Error(errors.join("；") || "行校验失败");
      const m = await createOneMatter(normalized, session.user.id);
      const c = m.conflict;
      succeeded.push({
        rowNo,
        internalCode: m.internalCode,
        firmCaseNo: m.firmCaseNo,
        title: m.title,
        ...(m.causeDowngradeReason ? { causeDowngradeReason: m.causeDowngradeReason } : {}),
        ...(c
          ? {
              conflictCheckId: c.checkId,
              conflictHitCount: c.hitCount,
              ...(c.maxSeverity ? { conflictMaxSeverity: c.maxSeverity } : {}),
              conflictConclusion: c.conclusion,
              conflictSummary: c.summary
            }
          : {})
      });
    } catch (e) {
      failed.push({ rowNo, error: e instanceof Error ? e.message : "导入失败" });
    }
  }

  const conflictTotals = {
    checked: succeeded.filter((r) => r.conflictCheckId).length,
    hitRows: succeeded.filter((r) => (r.conflictHitCount ?? 0) > 0).length,
    hitCount: succeeded.reduce((sum, r) => sum + (r.conflictHitCount ?? 0), 0),
    skipped: succeeded.filter((r) => !r.conflictCheckId).length
  };

  await audit({
    userId: session.user.id,
    action: "MATTER_IMPORT",
    targetType: "Matter",
    detail: {
      // 与开始那条关联；中断时凭 BEGIN 的 batchId 能对应上
      batchId,
      succeeded: succeeded.length,
      failed: failed.length,
      // 2026-11-21：明细带案号，事后能回答「这次导入建了哪些案件」。
      // 只留案号不留其他字段，避免审计条目膨胀。
      internalCodes: succeeded.map((r) => r.internalCode),
      failedRows: failed.map((r) => ({ rowNo: r.rowNo, error: r.error })).slice(0, 50),
      causeDowngraded: succeeded.filter((r) => r.causeDowngradeReason).length,
      // P1-1：导入触发的冲突检索在顶层审计里也要看得见（逐件明细另记 MATTER_CONFLICT_RUN）
      conflictChecked: conflictTotals.checked,
      conflictHitRows: conflictTotals.hitRows,
      conflictHitCount: conflictTotals.hitCount,
      conflictSkipped: conflictTotals.skipped
    }
  });

  revalidatePath("/matters");
  return { succeeded, failed, conflictTotals };
}
