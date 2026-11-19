import { prisma } from "@/lib/prisma";

/**
 * 登录失败锁定（v1.x P0-3）——数据库端原子实现。
 *
 * 2026-09-19 审计修复：此前为「读出 failedLoginAttempts → JS 加一 → 写回」，
 * 并发请求读到同一旧值各自写回，计数永远停在 1，锁定阈值可被并行请求绕过。
 * 现改为单条 UPDATE 原子递增并在达到阈值时置锁，返回递增后的失败次数供审计。
 */
/**
 * 2026-11-21 修复的一个隐蔽 bug：`RETURNING "failedLoginAttempts"` 返回的字段名
 * 就是 `failedLoginAttempts`，而原先读的是 `rows[0].attempts` —— 一直是 undefined，
 * 经 `?? 0` 后**永远返回 0**。
 *
 * 后果链：`authorize` 里 `lock = attempts >= LOGIN_LOCKOUT_THRESHOLD` 永远 false，
 * 于是「错码累积到阈值锁定」这个动作永远写成 `LOGIN_TOTP_FAILED`、不写 `LOGIN_LOCKED`，
 * 审计里的 attempts 也恒为 0。锁定本身有效（`lockedUntil` 由 SQL 的 CASE 设置），
 * 坏的是返回值与审计。
 *
 * 为什么藏了这么久：单元测试把 `$queryRaw` mock 成
 * `vi.fn(async () => [{ attempts: 1 }])` —— 返回值是编的，与真实 SQL 不符。
 * 真库测试（`login-lockout.test.ts`）一跑就暴露。修法是给别名 `AS attempts`。
 */
export async function recordLoginFailure(
  userId: string,
  threshold: number,
  lockMinutes: number
): Promise<number> {
  const rows = await prisma.$queryRaw<{ attempts: number }[]>`
    UPDATE "User"
    SET "failedLoginAttempts" = "failedLoginAttempts" + 1,
        "lockedUntil" = CASE
          WHEN "failedLoginAttempts" + 1 >= ${threshold}
            THEN now() + (${lockMinutes} * interval '1 minute')
          ELSE "lockedUntil"
        END
    WHERE id = ${userId}
    RETURNING "failedLoginAttempts" AS attempts`;
  return Number(rows[0]?.attempts ?? 0);
}
