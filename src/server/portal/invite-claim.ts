/**
 * 邀请一次性消费的**唯一实现处**（2026-11-20，门户 S1）
 *
 * 为什么单独成文件、而不是写在 `actions.ts` 里：
 *
 * 一开始 `claimInvite` 内联在 `acceptPortalInvite` 里，配套测试是「连续接受两次，
 * 第二次失败」。做变异验证（把 `where: { usedAt: null }` 去掉）后发现**测试照样通过** ——
 * 因为函数开头的前置检查 `if (invite.usedAt) throw` 已经拦下第二次，
 * 条件更新根本没被验证到。也就是说那条测试守的是前置检查，不是并发保护。
 *
 * 并发保护的真实价值只在**两个请求同时通过前置检查**时才体现，
 * 而这种时序在单进程测试里无法稳定构造。所以把占位动作抽成纯函数，
 * 让测试可以直接验证它的语义：
 *
 *   · 同一 token 第一次 claim → true（并写入 usedAt）
 *   · 第二次 claim → false（不受前置检查影响，这里没有前置检查）
 *
 * 这样「去掉 usedAt: null 守卫」会**确定地**让测试变红，而不是靠运气。
 */

/** Prisma 事务客户端的最小形状（只要用到 updateMany） */
type ClaimDb = {
  portalInvite: {
    updateMany: (args: {
      where: { id: string; usedAt: null };
      data: { usedAt: Date };
    }) => Promise<{ count: number }>;
  };
};

/**
 * 原子占位：只有「仍未使用」的邀请能被消费。
 *
 * 返回 true 表示本次调用成功占领；false 表示已被别人抢先（并发）或本就已用。
 * 判定完全交给数据库的条件更新，不做任何票在前置检查里——
 * 前置检查只是省一次事务，不能作为正确性依据。
 */
export async function claimInvite(db: ClaimDb, inviteId: string, now: Date = new Date()): Promise<boolean> {
  const res = await db.portalInvite.updateMany({
    where: { id: inviteId, usedAt: null },
    data: { usedAt: now }
  });
  return res.count === 1;
}
