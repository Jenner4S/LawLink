// @vitest-environment node
/**
 * `getWorkBoard` 的隔离墙结构断言（2026-11-20 补）。
 *
 * 为什么用结构断言而不是真库行为测试：
 *
 *   `getWorkBoard` 的墙只有一行 —— 把 `ethicalWallExclusion(...)` 拼进
 *   `db.matter.findMany` 的 where。而 `ethicalWallExclusion` 本身的
 *   **行为**已经在 Round 89/90 用真库验证过两次（`findWritableMatter`、
 *   `assertCanAssociateMatter` 都走同一个函数，建真墙后确实查不到案件）。
 *
 *   所以这里要守的不是「墙能不能拦」，而是「这处有没有把墙拼上去」——
 *   那正是 Round 77 的 bug 形态：两个分支都不含墙，被墙者能在个人工作台
 *   看到墙内案件的标题与待办。
 *
 *   造 `getWorkBoard` 的真库夹具需要 `requireSession` 请求上下文 +
 *   `readWorkRows` 的多表读 + `responsibilityReady` 探测，成本远高于收益；
 *   而这个函数每天都会有人改（工作台是高频迭代区），所以结构断言的价值
 *   在于**改动后立刻变红**，不在于跑通整条链路。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, session, workRows } = vi.hoisted(() => {
  const db: Record<string, any> = {
    matter: { findMany: vi.fn(async () => []) },
    intake: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => []) },
    $queryRaw: vi.fn(async () => []),
    $transaction: vi.fn()
  };
  // $transaction 直接把事务对象传进去，与 Prisma 的交互式事务同形
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  return {
    db,
    workRows: { value: [] as unknown[] },
    session: {
      expires: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        id: "clawyer0000000000000000001",
        role: "LAWYER",
        systemRole: "NONE",
        avatar: null,
        rolePermissions: undefined
      }
    }
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => session) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// readWorkRows / responsibilityReady 来自同目录 responsibility.ts，
// 它们会去读 Task / WorkResponsibility / IntakeUrgentItem 等表 ——
// 这里不关心那些，直接给一个就绪的空工作行集合。
vi.mock("@/server/reminders/responsibility", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/reminders/responsibility")>();
  return {
    ...actual,
    responsibilityReady: vi.fn(async () => true),
    readWorkRows: vi.fn(async () => workRows.value)
  };
});

import { getWorkBoard } from "@/server/reminders/work-actions";

describe("getWorkBoard · 隔离墙", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
    db.matter.findMany = vi.fn(async () => []);
    db.intake.findMany = vi.fn(async () => []);
    db.user.findMany = vi.fn(async () => []);
    db.$queryRaw = vi.fn(async () => []);
    workRows.value = [];
  });

  it("案件查询的 where 里必须含隔离墙片段（Round 77 的 bug 是这里完全没有）", async () => {
    // 让 canRead/emergency 至少有一个成立，否则 matters 查询根本不会执行
    await getWorkBoard();

    expect(db.matter.findMany).toHaveBeenCalled();
    const where = db.matter.findMany.mock.calls[0][0].where;
    const json = JSON.stringify(where);

    // 墙的形态：NOT: { ethicalWalls: { some: { denials: { some: ... } } } }
    expect(json).toContain("ethicalWalls");
    expect(json).toContain("denials");
    // 顺带守住原有条件没被顶掉
    expect(json).toContain("deletedAt");
  });

  it("即使有 matters.transfer 的 emergency（全所可见）也必须叠墙 —— 墙不能被权限短路", async () => {
    // 把用户换成一个具备 transfer:ALL 的角色，走 emergency 分支（where 里原本是 {}）
    const emergencySession = {
      ...session,
      user: { ...session.user, role: "PRINCIPAL_LAWYER", id: "cprincipal00000000000000001" }
    };
    const { requireSession } = await import("@/lib/auth/session");
    vi.mocked(requireSession).mockResolvedValueOnce(emergencySession as never);

    await getWorkBoard();

    expect(db.matter.findMany).toHaveBeenCalled();
    const json = JSON.stringify(db.matter.findMany.mock.calls[0][0].where);
    // 关键：emergency 分支原本给出的是空对象，墙必须独立叠加，
    // 否则「能管全所」就等于「不受隔离墙约束」。
    expect(json).toContain("ethicalWalls");
  });
});
