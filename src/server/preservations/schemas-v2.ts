import { z } from "zod";

const presTypes = ["PRE_LITIGATION", "LITIGATION", "ENFORCEMENT"] as const;
const propertyTypes = ["BANK_DEPOSIT", "REAL_ESTATE", "VEHICLE", "EQUITY", "IP", "OTHER"] as const;
const guaranteeTypes = ["CASH_DEPOSIT", "GUARANTEE_LETTER", "PROPERTY", "NONE"] as const;

// ── Case ──

export const caseCreateSchema = z.object({
  matterId: z.string().cuid().optional().nullable(),
  type: z.enum(presTypes),
  court: z.string().max(80).optional().or(z.literal("")),
  rulingNumber: z.string().max(80).optional().or(z.literal("")),
  guaranteeType: z.enum(guaranteeTypes).optional().nullable(),
  appliedAt: z.coerce.date().optional().nullable(),
  note: z.string().max(500).optional().or(z.literal("")),
  ownerId: z.string().cuid().optional().nullable(),
  remindDays: z.array(z.coerce.number().int().positive()).default([30, 15, 7, 3, 1]),
  // inline first target + property for convenience
  firstTarget: z.string().max(200).optional().or(z.literal("")),
  firstPropertyType: z.enum(propertyTypes).optional(),
  firstPropertyDetail: z.string().max(500).optional().or(z.literal("")),
  firstAmount: z.coerce.number().nonnegative().optional().nullable(),
  firstStartDate: z.coerce.date().optional(),
  firstDuration: z.coerce.number().int().positive().max(3650).optional(),
  firstExpiryDate: z.coerce.date().optional(),
});

export const caseUpdateSchema = z.object({
  id: z.string().cuid(),
  matterId: z.string().cuid().optional().nullable(),
  type: z.enum(presTypes).optional(),
  court: z.string().max(80).optional().or(z.literal("")),
  rulingNumber: z.string().max(80).optional().or(z.literal("")),
  guaranteeType: z.enum(guaranteeTypes).optional().nullable(),
  appliedAt: z.coerce.date().optional().nullable(),
  note: z.string().max(500).optional().or(z.literal("")),
  ownerId: z.string().cuid().optional().nullable(),
  remindDays: z.array(z.coerce.number().int().positive()).optional(),
});

// ── Target ──

export const targetCreateSchema = z.object({
  caseId: z.string().cuid(),
  name: z.string().min(1, "被保全人名称必填").max(200),
  note: z.string().max(300).optional().or(z.literal("")),
});

export const targetUpdateSchema = z.object({
  id: z.string().cuid(),
  name: z.string().min(1).max(200).optional(),
  note: z.string().max(300).optional().or(z.literal("")),
});

// ── Property ──

export const propertyCreateSchema = z.object({
  targetId: z.string().cuid(),
  propertyType: z.enum(propertyTypes),
  propertyDetail: z.string().max(500).optional().or(z.literal("")),
  amount: z.coerce.number().nonnegative().optional().nullable(),
  startDate: z.coerce.date(),
  duration: z.coerce.number().int().positive().max(3650),
  expiryDate: z.coerce.date(),
});

// 直改仅覆盖事实性字段：状态与到期日必须走续期（renew）或到期扫描，
// 否则会绕过续期台账与审计（2026-09-19 体检 P2）。
export const propertyUpdateSchema = z.object({
  id: z.string().cuid(),
  propertyType: z.enum(propertyTypes).optional(),
  propertyDetail: z.string().max(500).optional().or(z.literal("")),
  amount: z.coerce.number().nonnegative().optional().nullable(),
});

/**
 * 续保入参（2026-11-19 改）
 *
 * 此前由调用方传 newExpiryDate，服务端只做「必须晚于原到期日」的比较——
 * 日期怎么算完全取决于调用方。UI 用 `原到期日 + 天数 × 86400000` 推进，
 * 跨闰年会少一天：2027-06-15 续保 365 天得 2028-06-14，而法定一年是 2028-06-15。
 * 方向偏早虽不越法定期限，但对客户是少保护一天，且台账写「续保 365 天」与实际不符。
 *
 * 现在只收「数值 + 单位」，由服务端用 computeDeadlineDate 计算（与默认到期日同一函数，
 * 月末钳制/跨闰年都正确）。调用方无法再传入一个算错的日期。
 */
export const propertyRenewSchema = z.object({
  propertyId: z.string().cuid(),
  renewalDuration: z.coerce.number().int().positive().max(3600),
  // 必须显式指定单位：不给默认值。否则旧载荷 { renewalDuration: 365 }（语义是天）
  // 会被 zod 默认成 365 年（zod 默认 YEARS 与 DB 默认 DAYS 倒置），到期日跳到 2393 年。
  renewalUnit: z.enum(["DAYS", "MONTHS", "YEARS"]),
  note: z.string().max(300).optional().or(z.literal("")),
});

// ── List filter ──

export const caseListFilterSchema = z.object({
  status: z.enum(["ACTIVE", "RENEWED", "EXPIRED", "LIFTED", "ALL"]).default("ALL"),
  matterId: z.string().cuid().optional(),
  search: z.string().max(80).optional().or(z.literal(""))
});

// ── Delete ──

export const deleteSchema = z.object({ id: z.string().cuid() });

export type CaseCreateInput = z.infer<typeof caseCreateSchema>;
export type CaseUpdateInput = z.infer<typeof caseUpdateSchema>;
export type TargetCreateInput = z.infer<typeof targetCreateSchema>;
export type PropertyCreateInput = z.infer<typeof propertyCreateSchema>;
export type PropertyRenewInput = z.infer<typeof propertyRenewSchema>;
