import { userRoleLabel } from "@/lib/enums";

import type { DenyType } from "./schemas";

/**
 * 隔离墙的展示层：状态推导与中文标签。
 *
 * 状态不是数据库字段，而是由 active / expiresAt 推导出来的——两者各自独立，
 * 「已解除」（active=false）与「已过期」（active=true 但 expiresAt 已过）在合规口径上
 * 是两件事：前者是有人签字解除了，后者只是自动失效、记录仍待正式解除。
 * 因此这里不把 EXPIRED 折进 LIFTED。
 */

export type WallStatus = "ACTIVE" | "LIFTED" | "EXPIRED";

export const wallStatusLabel: Record<WallStatus, string> = {
  ACTIVE: "生效中",
  LIFTED: "已解除",
  EXPIRED: "已过期"
};

export function wallStatusOf(
  wall: { active: boolean; expiresAt: Date | null },
  now: Date = new Date()
): WallStatus {
  if (!wall.active) return "LIFTED";
  if (wall.expiresAt && wall.expiresAt.getTime() <= now.getTime()) return "EXPIRED";
  return "ACTIVE";
}

export const denyTypeLabel: Record<DenyType, string> = {
  USER: "人员",
  TEAM: "团队",
  ROLE: "岗位"
};

/** 被隔离对象在列表里的一行摘要（人员/团队带上姓名与状态，岗位直接给中文岗位名） */
export function denialTargetLabel(input: {
  denyType: DenyType;
  userName?: string | null;
  userActive?: boolean | null;
  userRole?: string | null;
  teamName?: string | null;
  teamActive?: boolean | null;
  role?: string | null;
}): string {
  if (input.denyType === "USER") {
    const name = input.userName ?? "（人员已删除）";
    return input.userActive === false ? `${name}（账号停用）` : name;
  }
  if (input.denyType === "TEAM") {
    const name = input.teamName ?? "（团队已删除）";
    return input.teamActive === false ? `${name}（团队停用）` : `${name}（团队）`;
  }
  const role = input.role as keyof typeof userRoleLabel | null | undefined;
  return `全所「${(role && userRoleLabel[role]) || "未知岗位"}」`;
}
