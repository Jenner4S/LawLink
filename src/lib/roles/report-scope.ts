import type { Prisma } from "@prisma/client";
import { customMatterFilter, matterFinanceVisibilityFilter, matterReadVisibilityFilter } from "@/lib/permissions";
import type { RoleUser } from "./catalog";
import { ethicalWallExclusion } from "@/lib/permissions/ethical-wall";
export type ReportAccess = { matters: Prisma.MatterWhereInput; finance: Prisma.MatterWhereInput };
export function reportAccess(user: RoleUser & { id: string }, exporting = false): ReportAccess {
  // 2026-11-20 补隔离墙：此前内置角色直接返回 {}（全所不过滤），只有 CUSTOM 走
  // matterReadVisibilityFilter（含墙）。于是被墙隔离的案件，其**案号、案件标题
  // （通常含当事人全称）、委托客户名称**会随报表导出带出系统。
  //
  // 修法上刻意只叠加「墙」、不叠加完整可见性过滤：
  // 内置角色的报表口径本来就是全所（合伙人/财务看全部），若改成
  // matterReadVisibilityFilter 会把 LAWYER 的报表缩到只剩本人案件 ——
  // 那是产品语义变化，不是修 bug。这里只把墙这一条合规要求补上。
  if (user.role !== "CUSTOM") {
    const wall = ethicalWallExclusion(user.id, user.role);
    return { matters: wall, finance: wall };
  }
  const scope = customMatterFilter(user.id, user.rolePermissions, exporting ? "reports.export" : "reports.read", false);
  return {
    matters: { AND: [scope, matterReadVisibilityFilter(user.id, user.role, user.rolePermissions)] },
    finance: { AND: [scope, matterFinanceVisibilityFilter(user.id, user.role, user.rolePermissions)] },
  };
}
