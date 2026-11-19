import { Prisma } from "@prisma/client";

/**
 * 隔离墙（Ethical Wall）的可见性排除条件。
 *
 * 与利益冲突检索的分工：
 *   利冲回答「这个案子能不能接」（接案前）；
 *   隔离墙回答「接了之后，所内哪些人不能看」（接案后）。
 *
 * 三条设计约束：
 *   1. 对全所生效，不区分角色——合伙人、管理员、超级管理员都可能被隔离。
 *      这是执业合规要求，不是权限设置，因此不能放进 matterReadVisibilityFilter
 *      的 isManager 分支里豁免。
 *   2. 只在「读取」链路上拦截。写操作本就要求主办/成员身份，被隔离的人通常
 *      也不具备，无需重复；但导出、搜索、统计都必须经过读取过滤。
 *   3. 失效条件有两类：active=false（手动解除）、expiresAt 已过（自动失效）。
 *      两者任一成立即不再拦截。
 */

/** 判定传入角色是否命中 ROLE 类隔离 */
export function ethicalWallExclusion(
  userId: string,
  role: string,
  /** 判定时刻，默认当前。提出来是为了让调用方（尤其测试）能注入固定时刻，
   *  否则 new Date() 每次不同，含该条件的 where 无法做深度相等断言。 */
  now: Date = new Date()
): Prisma.MatterWhereInput {
  return {
    NOT: {
      ethicalWalls: {
        some: {
          active: true,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          denials: {
            some: {
              OR: [
                // 按人隔离
                { denyType: "USER", userId },
                // 按团队隔离：当前用户是该团队的活跃成员
                {
                  denyType: "TEAM",
                  team: { members: { some: { userId, active: true } } }
                },
                // 按角色隔离
                { denyType: "ROLE", role: role as never }
              ]
            }
          }
        }
      }
    }
  };
}

/**
 * 对任意 MatterWhereInput 叠加隔离墙排除。
 * 用 AND 包裹，避免与既有 where 的 OR 键互相覆盖（同名键平铺会互相覆盖，
 * 这是本项目第七轮审计踩过的坑）。
 */
// withEthicalWall 已于 2026-11-20 删除：零调用（含测试）。
// 它的形态是「给已有完整 where 包一层 AND」，而实际各处（matterReadVisibilityFilter、
// findWritableMatter、export-query 等）都是「在 where 对象里加一项」，直接写
// ...ethicalWallExclusion(userId, role) 更简洁。留着两个等价入口只会让人
// 以为还有第三条路没走 —— 隔离墙这次出问题，恰恰是因为入口多、接线少。

/**
 * 对象级判定：该案件是否对该用户隔离。
 *
 * 这是隔离墙的**写路径**入口 —— 列表/查询用 ethicalWallExclusion 拼进 where，
 * 而单对象校验（如财务写操作）必须用这个，否则墙只在读的时候有效。
 *
 * `db` 接受 PrismaClient 或 TransactionClient：写路径几乎都在事务内，
 * 参数类型过窄会逼调用方做类型断言（2026-11-20 接线时踩到）。
 */
export async function isMatterWalledFor(
  db: Pick<Prisma.TransactionClient, "ethicalWall">,
  input: { matterId: string; userId: string; role: string }
): Promise<boolean> {
  const now = new Date();
  const hit = await db.ethicalWall.findFirst({
    where: {
      matterId: input.matterId,
      active: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      denials: {
        some: {
          OR: [
            { denyType: "USER", userId: input.userId },
            {
              denyType: "TEAM",
              team: { members: { some: { userId: input.userId, active: true } } }
            },
            { denyType: "ROLE", role: input.role as never }
          ]
        }
      }
    },
    select: { id: true, reason: true }
  });
  return hit !== null;
}
