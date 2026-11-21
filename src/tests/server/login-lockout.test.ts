// @vitest-environment node
/**
 * 登录失败锁定的真库验证（2026-11-21 补，多智能体审计 A-5）。
 *
 * 为什么必须用真库：
 *
 * `recordLoginFailure` 的全部逻辑都在**一条 SQL** 里：
 *
 *   UPDATE "User"
 *   SET "failedLoginAttempts" = "failedLoginAttempts" + 1,
 *       "lockedUntil" = CASE
 *         WHEN "failedLoginAttempts" + 1 >= ${threshold}
 *           THEN now() + (${lockMinutes} * interval '1 minute')
 *         ELSE "lockedUntil"
 *       END
 *   WHERE id = ${userId}
 *   RETURNING "failedLoginAttempts"
 *
 * mock 掉 `$queryRaw` 就等于把被测逻辑整个换掉 —— 上一轮补 TOTP 测试时
 * `db.$queryRaw` 是 `vi.fn(async () => [{ attempts: 1 }])`，**返回值是编的**。
 * 真实的 SQL 语义（原子递增、阈值边界、锁定是否被延长）一条都没验过。
 *
 * 这段代码的历史：2026-09-19 从「读出 → JS 加一 → 写回」改成单条 UPDATE，
 * 因为并发请求读同一旧值各自写回，计数永远停在 1，阈值可被并行请求绕过。
 * 那条修复本身也需要测试守住 —— 改回非原子实现时这里必须变红。
 *
 * 隔离：自建临时库 `lawlink_lockout_test_*` → `prisma migrate deploy` →
 * 结束 `DROP DATABASE … WITH (FORCE)`。**绝不写主库。**
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

const NAME = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  console.info(`[login-lockout] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

// `recordLoginFailure` 内部用 `@/lib/prisma` 单例；vi.hoisted 已把 DATABASE_URL
// 指到临时库，所以这里直接 import 生产实现即可。
const { recordLoginFailure } = await import("@/lib/auth/login-lockout");

const THRESHOLD = 5;
const LOCK_MIN = 15;

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser() {
  return prisma.user.create({
    data: {
      id: uid("u"), email: `${uid("e")}@t.local`, name: "锁定测试",
      role: "LAWYER", passwordHash: "x", active: true,
      failedLoginAttempts: 0, lockedUntil: null
    }
  });
}

const read = (id: string) =>
  prisma.user.findUniqueOrThrow({
    where: { id },
    select: { failedLoginAttempts: true, lockedUntil: true }
  });

describe("recordLoginFailure · 原子递增与阈值锁定（真库）", () => {
  it("前 4 次失败：计数递增，不置锁", async () => {
    const u = await seedUser();
    for (let i = 1; i <= 4; i++) {
      const attempts = await recordLoginFailure(u.id, THRESHOLD, LOCK_MIN);
      expect(attempts).toBe(i);
      const row = await read(u.id);
      expect(row.failedLoginAttempts).toBe(i);
      expect(row.lockedUntil).toBeNull();
    }
  });

  it("第 5 次（达阈值）：计数=5 且置锁约 15 分钟后", async () => {
    const u = await seedUser();
    for (let i = 1; i < THRESHOLD; i++) await recordLoginFailure(u.id, THRESHOLD, LOCK_MIN);

    const before = Date.now();
    const attempts = await recordLoginFailure(u.id, THRESHOLD, LOCK_MIN);
    expect(attempts).toBe(THRESHOLD);

    const row = await read(u.id);
    expect(row.failedLoginAttempts).toBe(THRESHOLD);
    expect(row.lockedUntil).not.toBeNull();
    const deltaMs = row.lockedUntil!.getTime() - before;
    // now() + 15 分钟，给 60 秒容差（迁移/连接开销）
    expect(deltaMs).toBeGreaterThan(LOCK_MIN * 60_000 - 60_000);
    expect(deltaMs).toBeLessThan(LOCK_MIN * 60_000 + 60_000);
  });

  it("超过阈值继续失败：计数继续增，锁定【被重置】为新的 now()+15min", async () => {
    // 这条钉住 CASE 的真实语义：`>= threshold` 而非 `== threshold`。
    // 锁定期间 authorize 会直接拒绝、不会调到这里；但锁定过期后再次失败时，
    // 应当重新锁定（而不是沿用已过期的 lockedUntil）。
    const u = await seedUser();
    for (let i = 0; i < THRESHOLD; i++) await recordLoginFailure(u.id, THRESHOLD, LOCK_MIN);
    const firstLock = (await read(u.id)).lockedUntil!;

    // 模拟锁定已过期
    await prisma.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });

    const attempts = await recordLoginFailure(u.id, THRESHOLD, LOCK_MIN);
    expect(attempts).toBe(THRESHOLD + 1);
    const row = await read(u.id);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(firstLock.getTime()); // 是新的锁定时刻
  });

  it("并发 8 次失败：计数恰好 +8（原子性，非「读出-加一-写回」）", async () => {
    // 这是 2026-09-19 那条修复的回归守卫：
    // 旧实现并发读到同一旧值各自写回，8 次并发后计数可能仍是 1。
    const u = await seedUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => recordLoginFailure(u.id, 999, LOCK_MIN)) // 阈值调高，避免锁定干扰
    );
    // 8 个返回值应恰好覆盖 1..8（同一批并发各自拿到不同序号）
    expect(new Set(results).size).toBe(8);
    expect(Math.max(...results)).toBe(8);
    const row = await read(u.id);
    expect(row.failedLoginAttempts).toBe(8);
    // 超时放宽到 30s（2026-11-23）：全量并行跑（199 个测试文件同时打同一个库）时，
    // 这条会因连接池争用超过默认 5s 而偶发超时——单跑约 0.3s。
    // 不降低并发数：这个用例的价值正是"8 路并发下计数仍然精确"，
    // 削弱并发等于把原子性回归守卫变成摆设。
  }, 30_000);

  it("账号不存在：返回 0（RETURNING 空集），不抛错", async () => {
    const attempts = await recordLoginFailure("nonexistent-user-id", THRESHOLD, LOCK_MIN);
    expect(attempts).toBe(0);
  });
});
