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
/**
 * 带授权复核的写操作包装。
 *
 * ## `atomic` 选项（2026-11-21 新增）
 *
 * 内置岗位原本直接 `write(prisma)`，**不建事务**。理由是「内置岗位的授权范围
 * 不会中途变化，不需要 Serializable + advisory lock 那一套」—— 这个理由本身是对的。
 *
 * 但它把两件事混在了一个分支里：
 *
 *   · 要不要**复核授权范围** —— 内置岗位：不要
 *   · 要不要保证**多语句原子性** —— 取决于回调写了几张表，**与角色无关**
 *
 * 结果是：所有内置岗位的多语句写入都没有事务。2026-11-21 连着抓到三处真问题
 * （材料版本切换丢 isLatest、保全续封丢续期、短信一键生成重复建实体），
 * 每一处都会造成真实的数据错误，而且都很难被测试发现——因为「第一部分成功、
 * 第二部分失败」的组合在正常测试里跑不到。
 *
 * 现在需要原子性的调用点显式传 `{ atomic: true }`：
 *   · 内置岗位 → 开普通事务（不需要 Serializable，代价远小于正确性）
 *   · CUSTOM   → 本来就是 Serializable 事务，这个选项对它无影响
 *
 * **不传时行为与改动前完全一致**，81 个既有调用点不受影响。
 *
 * ## 怎么判断要不要传
 *
 * 回调里出现以下任一情况就必须传：
 *   · 两条及以上写语句（create/update/delete/updateMany…）
 *   · 一条写 + 一次辅助函数调用，且那个辅助函数也写库（典型：作废提醒、写审计）
 *   · 「先改状态、再清理关联数据」这类成对的语义
 *
 * 只做单条写入的回调不需要传 —— 单条语句本身原子。
 */
export async function roleMutation<T>(
  user: RoleUser & { id: string },
  key: PermissionKey,
  write: (db: Prisma.TransactionClient) => Promise<T>,
  options?: { atomic?: boolean }
): Promise<T> {
  if (user.role !== "CUSTOM") {
    // 内置岗位：授权范围不会中途变化，不需要 checkRoleMutation；
    // 但多语句回调仍然需要事务 —— 这是两件事，别混。
    return options?.atomic
      ? prisma.$transaction(write, { timeout: 20000 })
      : write(prisma);
  }
  return prisma.$transaction(async db => {
    await checkRoleMutation(db, user, key);
    return write(db);
  }, { isolationLevel: "Serializable", timeout: 20000 });
}
