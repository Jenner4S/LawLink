import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { builtinRoleName } from "./presentation";
import { MANAGER_GRANTS, validGrants, scopeFor, type PermissionKey, type RoleUser } from "./catalog";
import { ActionError } from "@/lib/action-error";
export async function resolveRoleUser(userId: string, role: string, db: Prisma.TransactionClient = prisma): Promise<RoleUser & { enabled: boolean; managerAuthorized?: boolean }> {
  if (role !== "CUSTOM") {
    // 业务管理权按人授予，与岗位无关；每次会话解析实时读取
    const row = await db.user.findUnique({ where: { id: userId }, select: { managerAuthorized: true } });
    const managerAuthorized = row?.managerAuthorized === true;
    return { role, enabled: true, roleName: await builtinRoleName(role, db), managerAuthorized, rolePermissions: managerAuthorized ? MANAGER_GRANTS.map(grant => ({ ...grant })) : undefined };
  }
  const row = await db.user.findUnique({ where: { id: userId }, select: { active: true, role: true, roleDefinition: { include: { permissions: true } } } });
  const definition = row?.roleDefinition;
  if (!row?.active || row.role !== "CUSTOM" || !definition?.active) return { role: "CUSTOM", enabled: false, rolePermissions: [] };
  return { role: "CUSTOM", enabled: true, roleName: definition.name, rolePermissions: validGrants(definition.permissions) };
}
// assertCustomPermission 已于 2026-11-20 删除：零调用（含测试）。
// 自定义角色的权限判定实际走 scopeFor / hasCustomPermission / customOrLegacy，
// 这个 async 断言从未接入任何调用点。同上：没人调用的权限断言会制造
// 「这里已经校验过」的错觉。

/** 角色配置表是否就绪（部署早期表可能尚未建） */
export async function roleTablesReady() {
  const rows = await prisma.$queryRaw<{ ready: boolean }[]>`SELECT to_regclass('public."RoleDefinition"') IS NOT NULL AND to_regclass('public."RolePermission"') IS NOT NULL AS ready`;
  return rows[0]?.ready === true;
}

/** 与角色配置共用事务锁，使撤权和业务写入按提交顺序生效。内置角色保留原事务路径。 */
export async function checkRoleMutation(db: Prisma.TransactionClient, user: RoleUser & { id: string }, key: PermissionKey) {
  if (user.role !== "CUSTOM") return;
  await db.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(72606101)`;
  const current = await resolveRoleUser(user.id, user.role, db);
  const currentScope = current.enabled ? scopeFor(current, key) : undefined;
  if (!currentScope || currentScope !== scopeFor(user, key)) throw new ActionError("当前角色无权执行此操作，或授权范围已变化，请刷新后重试");
}
export async function roleMutation<T>(user: RoleUser & { id: string }, key: PermissionKey, write: (db: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  if (user.role !== "CUSTOM") return write(prisma);
  return prisma.$transaction(async db => {
    await checkRoleMutation(db, user, key);
    return write(db);
  }, { isolationLevel: "Serializable", timeout: 20000 });
}
