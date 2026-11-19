import { UserRole } from "@prisma/client";
import { z } from "zod";

import { ActionError } from "@/lib/action-error";

/**
 * 隔离墙（Ethical Wall）录入 schema。
 *
 * 与利益冲突检索（ConflictCheck）的分工见 prisma/schema.prisma 末尾注释：
 * 利冲管「接不接」，隔离墙管「接了之后谁不能看」，对全所生效（含合伙人/管理员）。
 *
 * 这里的校验只管「参数形状与自洽性」；实体是否存在、权限是否足够在 actions.ts 里查。
 * 三选一的规则刻意在该层再强制一次：zod 只能保证字段类型，保证不了
 * 「denyType=USER 时恰好只给 userId」——而写歪的隔离墙会静默失去隔离效果
 * （denyType=TEAM 但没有 teamId 的条目在 Prisma 条件里永远不命中任何人），
 * 这种「看起来建了、实际不设防」的失败最危险，所以必须在写库前硬拦。
 */

export const DENY_TYPES = ["USER", "TEAM", "ROLE"] as const;
export type DenyType = (typeof DENY_TYPES)[number];

/** 可被整体隔离的岗位（UserRole 全量；CUSTOM 表示自定义角色群体） */
export const DENIABLE_ROLES: UserRole[] = [
  UserRole.CUSTOM,
  UserRole.PRINCIPAL_LAWYER,
  UserRole.INDEPENDENT_LAWYER,
  UserRole.LAWYER,
  UserRole.ASSISTANT,
  UserRole.FINANCE
];

const dateKeySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "失效日期格式应为 YYYY-MM-DD");

export const denyInputSchema = z.object({
  denyType: z.enum(DENY_TYPES, {
    error: "被隔离对象类别只能是人员、团队或角色"
  }),
  userId: z.string().trim().min(1).nullish(),
  teamId: z.string().trim().min(1).nullish(),
  role: z.nativeEnum(UserRole, {
    error: "按角色隔离时岗位不合法"
  }).nullish()
});

export type DenyInput = z.input<typeof denyInputSchema>;

export const createWallSchema = z.object({
  matterId: z.string().trim().min(1, "请选择要隔离的案件"),
  // 隔离墙是执业合规留痕，理由写不清楚事后无法自证：10 字下限只是最低要求
  reason: z
    .string()
    .trim()
    .min(10, "隔离理由至少 10 个字（说明隔离原因与涉及哪一方）")
    .max(2000, "隔离理由不超过 2000 字"),
  /** 空串 / null / 不传 = 永久生效，直到手动解除 */
  expiresAt: z.union([dateKeySchema, z.literal(""), z.null()]).optional(),
  denials: z.array(denyInputSchema).min(1, "至少选择一个被隔离对象")
});

export type CreateWallInput = z.input<typeof createWallSchema>;

export const liftWallSchema = z.object({
  id: z.string().trim().min(1, "缺少隔离墙标识"),
  liftReason: z
    .string()
    .trim()
    .min(4, "解除理由至少 4 个字")
    .max(500, "解除理由不超过 500 字")
});

export type LiftWallInput = z.input<typeof liftWallSchema>;

/** 归一化后的被隔离对象：三个 id 字段里恰好一个非空 */
export type NormalizedDenial = {
  denyType: DenyType;
  userId: string | null;
  teamId: string | null;
  role: UserRole | null;
};

/**
 * 把表单条目收紧成「每项只带一个目标 id」。
 *
 * 同时承担去重：同一次提交里重复勾选同一对象（例如同一人既经人员又经团队选中，
 * 但 denyType 不同则不去重——那是两条独立的隔离依据，各自的语义不同）。
 */
export function normalizeDenials(denials: DenyInput[]): NormalizedDenial[] {
  const normalized: NormalizedDenial[] = [];
  const seen = new Set<string>();

  for (const item of denials) {
    const userId = (item.userId ?? "").trim();
    const teamId = (item.teamId ?? "").trim();
    const role = item.role ?? null;
    let row: NormalizedDenial;

    if (item.denyType === "USER") {
      if (!userId) throw new ActionError("按人员隔离时必须选择具体人员");
      if (teamId || role) throw new ActionError("按人员隔离时不能同时指定团队或角色");
      row = { denyType: "USER", userId, teamId: null, role: null };
    } else if (item.denyType === "TEAM") {
      if (!teamId) throw new ActionError("按团队隔离时必须选择具体团队");
      if (userId || role) throw new ActionError("按团队隔离时不能同时指定人员或角色");
      row = { denyType: "TEAM", userId: null, teamId, role: null };
    } else if (item.denyType === "ROLE") {
      if (!role) throw new ActionError("按角色隔离时必须选择具体岗位");
      if (!DENIABLE_ROLES.includes(role)) throw new ActionError("按角色隔离的岗位不合法");
      if (userId || teamId) throw new ActionError("按角色隔离时不能同时指定人员或团队");
      row = { denyType: "ROLE", userId: null, teamId: null, role };
    } else {
      throw new ActionError("被隔离对象类别只能是人员、团队或角色");
    }

    const key = `${row.denyType}:${row.userId ?? row.teamId ?? row.role ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(row);
  }

  if (normalized.length === 0) throw new ActionError("至少选择一个被隔离对象");
  return normalized;
}
