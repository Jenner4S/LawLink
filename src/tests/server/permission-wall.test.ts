// @vitest-environment node
/**
 * 隔离墙在「权限断言层」上的真库行为验证（2026-11-20 补）。
 *
 * 为什么单独补这一组：
 *
 *   `assertCanHandleMatter` 是 Round 75 才接上墙的 —— 在那之前它的两条分支
 *   （合伙人走 `assertCanAccessMatter`、其余走 `assertCanAssociateMatter`）
 *   都不查墙，于是 **59 处写操作**（存类案、存 AI 审查结果、证据上传、
 *   程序编辑、短信关联、催收……）对「被墙隔离的人」全部敞开。
 *
 *   接上之后只有结构层面的证据（代码里确实写了 `ethicalWallExclusion`），
 *   没有行为层面的：**没人证明过它真的会拒**。而它影响的调用点比
 *   `assertMatterWritable` 更分散（散在十几个业务模块里），一旦回归，
 *   不会有任何测试变红。
 *
 *   Round 89 用真库验证了写路径底座；这个文件把同一手法用在权限断言层。
 *
 *   顺带验证 Round 76 补的三个断言（Lead / Own / Modify）——它们同样是
 *   「写对了但没人证明过」，且其中两个还修过「抛 Error 而非 ActionError」。
 *
 * 隔离：每次运行建独立临时库 `lawlink_permwall_test_*` → 只跑
 * `prisma migrate deploy` 建结构 → 结束 `DROP DATABASE … WITH (FORCE)`。
 * **绝不写主库 lawlink。**
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

import {
  assertCanAccessMatter,
  assertCanAssociateMatter,
  assertCanHandleMatter,
  assertCanLeadMatter,
  assertCanModifyMatter,
  assertCanOwnMatter
} from "@/lib/permissions/index";
import { ActionError } from "@/lib/action-error";

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  console.info(`[permission-wall] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser(name: string, role: "LAWYER" | "PRINCIPAL_LAWYER" = "LAWYER") {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name, role, passwordHash: "x", active: true }
  });
}

async function seedMatter(ownerId: string) {
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("LL-"), title: "断言墙验证案",
      category: "CIVIL_COMMERCIAL", status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId, customValues: {}
    }
  });
}

async function seedWall(matterId: string, createdById: string, userIds: string[]) {
  return prisma.ethicalWall.create({
    data: {
      id: uid("wall"), matterId, reason: "利益冲突：本所代理相对方",
      createdById,
      denials: { create: userIds.map((userId) => ({ denyType: "USER" as const, userId })) }
    }
  });
}

/* ================================================================== *
 * assertCanHandleMatter —— 59 处写操作的共用断言
 * ================================================================== */
describe("assertCanHandleMatter · 隔离墙", () => {
  it("无墙时承办律师可通过（非合伙人走关联分支）", async () => {
    const lawyer = await seedUser("承办");
    const matter = await seedMatter(lawyer.id);
    await expect(assertCanHandleMatter({ id: lawyer.id, role: "LAWYER" }, matter.id)).resolves.toBeUndefined();
  });

  it("**非合伙人分支**：被墙的承办律师本人被拒", async () => {
    const lawyer = await seedUser("被墙承办");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);

    // lawyer 是 ownerId，按纯归属本该通过 —— 墙必须压过归属
    await expect(assertCanHandleMatter({ id: lawyer.id, role: "LAWYER" }, matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("**合伙人分支**：被墙的合伙人被拒（该分支此前是裸 { id, deletedAt: null }）", async () => {
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(principal.id);
    await seedWall(matter.id, principal.id, [principal.id]);

    // 这条最关键：Round 75 之前合伙人走 assertCanAccessMatter 的 isManager 分支，
    // where 只有 { id, deletedAt: null }，全所可见 —— 墙对其完全没有约束力。
    await expect(assertCanHandleMatter({ id: principal.id, role: "PRINCIPAL_LAWYER" }, matter.id))
      .rejects.toBeInstanceOf(ActionError);
  });

  it("墙只针对被点名的人，未点名的同事仍可通过", async () => {
    const walled = await seedUser("被墙");
    const colleague = await seedUser("同事");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(walled.id);
    // colleague 也是成员
    await prisma.matterMember.create({ data: { matterId: matter.id, userId: colleague.id, role: "ASSISTANT" } });
    await seedWall(matter.id, principal.id, [walled.id]);

    await expect(assertCanHandleMatter({ id: colleague.id, role: "LAWYER" }, matter.id)).resolves.toBeUndefined();
    await expect(assertCanHandleMatter({ id: walled.id, role: "LAWYER" }, matter.id)).rejects.toBeInstanceOf(ActionError);
  });
});

describe("不泄露案件存在性（隔离墙的存在本身即机密）", () => {
  // 2026-11-22 补：此前没有任何测试**直接对比**「案件真不存在」与「案件存在但被墙」
  // 两种情况下的对外文案。现有测试只验「被墙会被拒」，但如果某天有人把被墙分支的
  // 文案改成「无权访问此案件」，测试依然全绿，而**泄露就发生了** ——
  // 因为攻击者由此可以区分「这个 ID 存在于系统里」与「不存在」。
  //
  // 这条性质写在 src/app/(app)/matters/[id]/page.tsx:48 的注释里，
  // 属于**设计决策**而非实现细节，所以必须由测试钉住，而不是只靠注释。

  async function messageOf(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return "<未抛错>";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  it("assertCanHandleMatter：不存在的 id 与被墙的真实案件返回同一条消息", async () => {
    const lawyer = await seedUser("对照承办");
    const principal = await seedUser("对照主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);

    const missing = await messageOf(() =>
      assertCanHandleMatter({ id: lawyer.id, role: "LAWYER" }, "cnotarealmatterid00000")
    );
    const walled = await messageOf(() =>
      assertCanHandleMatter({ id: lawyer.id, role: "LAWYER" }, matter.id)
    );

    expect(missing).toBe(walled);
    // 顺带钉住措辞本身：一旦有人「优化文案」把两者区分开，这里会红
    expect(missing).toContain("不存在");
  });

  it("assertCanAccessMatter：同样不区分「不存在」与「无权」", async () => {
    const lawyer = await seedUser("对照承办2");
    const principal = await seedUser("对照主任2", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);

    const missing = await messageOf(() =>
      assertCanAccessMatter(lawyer.id, "LAWYER", "cnotarealmatterid00001")
    );
    const walled = await messageOf(() => assertCanAccessMatter(lawyer.id, "LAWYER", matter.id));
    expect(missing).toBe(walled);
  });
});

describe("assertCanAccessMatter / assertCanAssociateMatter · 隔离墙", () => {
  it("assertCanAccessMatter 的合伙人分支也查墙", async () => {
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(principal.id);
    await expect(assertCanAccessMatter(principal.id, "PRINCIPAL_LAWYER", matter.id)).resolves.toBeUndefined();
    await seedWall(matter.id, principal.id, [principal.id]);
    await expect(assertCanAccessMatter(principal.id, "PRINCIPAL_LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("assertCanAssociateMatter 不传 role 时仍按 USER 类隔离拒绝", async () => {
    const lawyer = await seedUser("被墙");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);
    // 不传 role：只能按 USER/TEAM 判，USER 类隔离应当仍然命中
    await expect(assertCanAssociateMatter(lawyer.id, matter.id)).rejects.toBeInstanceOf(ActionError);
  });
});

/* ================================================================== *
 * Round 76 补的三条断言 —— 同样是「写对了但没人证明过」
 * ================================================================== */
describe("assertCanLead / Own / ModifyMatter · 隔离墙与错误类型", () => {
  it("assertCanLeadMatter：被墙的主办被拒，且抛 ActionError（不是裸 Error）", async () => {
    const lawyer = await seedUser("被墙主办");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);

    await expect(assertCanLeadMatter(lawyer.id, matter.id, "仅案件主办/协办可操作", "LAWYER"))
      .rejects.toBeInstanceOf(ActionError);
  });

  it("assertCanOwnMatter：被墙的主办被拒，且抛 ActionError", async () => {
    const lawyer = await seedUser("被墙主办");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);

    await expect(assertCanOwnMatter(lawyer.id, matter.id, "仅案件主办律师可操作", "LAWYER"))
      .rejects.toBeInstanceOf(ActionError);
  });

  it("assertCanModifyMatter：被墙成员被拒；未设墙时放行", async () => {
    const lawyer = await seedUser("被墙成员");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);

    await expect(assertCanModifyMatter(lawyer.id, "LAWYER", matter.id)).resolves.toBeUndefined();
    await seedWall(matter.id, principal.id, [lawyer.id]);
    await expect(assertCanModifyMatter(lawyer.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });
});
