/**
 * 业务管理判定（纯函数，客户端与服务端通用）。
 *
 * 2026-11-20：从 `@/lib/permissions/index.ts` 拆出。
 *
 * 原因：`permissions/index.ts` 引用 prisma（14 处），是服务端模块。
 * 客户端组件（如 "use client" 的 sidebar）import 它会导致构建/运行崩溃——
 * 我上一轮把侧栏的手写判断改成 `isManager(user)` 时踩了这个坑，首页直接白屏。
 *
 * 纯函数不属于任何渲染层，放在无 prisma 依赖的模块里，两端都能安全引用。
 * `permissions/index.ts` 继续 re-export 本函数，现有 import 不用改。
 */

/**
 * 业务管理判定：合伙人岗位，或获按人授予的业务管理权（User.managerAuthorized）。
 *
 * 传岗位字符串时仅认合伙人（此时无法得知按人授权，属调用方信息不全）；
 * 有用户对象时请整体传入。
 */
export function isManager(
  roleOrUser: string | { role: string; managerAuthorized?: boolean | null }
): boolean {
  if (typeof roleOrUser === "string") return roleOrUser === "PRINCIPAL_LAWYER";
  return roleOrUser.role === "PRINCIPAL_LAWYER" || roleOrUser.managerAuthorized === true;
}
