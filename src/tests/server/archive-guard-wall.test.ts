// @vitest-environment node
/**
 * 隔离墙在「写路径底座」上的行为验证（2026-11-20 补）。
 *
 * 为什么需要这个文件：
 *
 *   `assertMatterWritable` / `assertDocumentWritable` 经内部 `findWritableMatter`
 *   把 `ethicalWallExclusion(...)` 拼进 where，是全项目影响面最大的一道墙 ——
 *   101 处调用（材料新版本、归档、程序编辑、证据、交接……）都走它。
 *
 *   但此前它只有两类证据：
 *     ① mock 测试里的**结构断言**（"where 里有这个片段"）
 *     ② Round 48 的一次**手工**临时库验证
 *
 *   结构断言回答的是「我拼上了」，不回答「它真能拦住」——mock 的
 *   `findFirst` 不解析 where。而手工验证不进 CI，下次改动不会有人重跑。
 *
 *   所以这里补一个真库行为测试：建真墙 → 断言被拒；拆墙 → 断言放行。
 *
 * 隔离：每次运行建独立临时库 `lawlink_wallguard_test_*`（lawlink-db:55432）→
 * 只跑 `prisma migrate deploy` 建结构 → 结束 `DROP DATABASE … WITH (FORCE)`。
 * **绝不写主库 lawlink。**
 *
 * 注：`vi.hoisted` 必须在任何被测模块求值前改 `DATABASE_URL` ——
 * `assertMatterWritable` 内部走的是 `@/lib/prisma` 单例。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_wallguard_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

import { assertDocumentWritable, assertMatterWritable } from "@/lib/archive/guard";
import { ActionError } from "@/lib/action-error";

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let prisma: PrismaClient;
let admin: PrismaClient;

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
  } catch (err) {
    throw new Error(`临时库创建失败，需先启动 lawlink-db（${HOLDER.host}）：${String(err)}`);
  }
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: HOLDER.url },
    stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  console.info(`[archive-guard-wall] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[archive-guard-wall] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** guard 支持传 actor 绕过 requireSession（无请求上下文的测试必需） */
const actorOf = (u: { id: string; role: string }) => ({ id: u.id, role: u.role });

async function seedUser(name: string, role: "LAWYER" | "PRINCIPAL_LAWYER" = "LAWYER") {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name, role, passwordHash: "x", active: true }
  });
}

async function seedMatter(ownerId: string) {
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("LL-"), title: "墙行为验证案",
      category: "CIVIL_COMMERCIAL", status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId, customValues: {}
    }
  });
}

/** 给指定人对指定案件建一道有效的隔离墙 */
async function seedWall(matterId: string, createdById: string, userIds: string[]) {
  return prisma.ethicalWall.create({
    data: {
      id: uid("wall"), matterId, reason: "本所同时为对方公司提供常年顾问，须隔离本案",
      createdById,
      denials: { create: userIds.map((userId) => ({ denyType: "USER" as const, userId })) }
    }
  });
}

describe("assertMatterWritable · 隔离墙（真库行为）", () => {
  it("无墙时承办律师可写", async () => {
    const lawyer = await seedUser("承办");
    const matter = await seedMatter(lawyer.id);
    await expect(assertMatterWritable(matter.id, { actor: actorOf(lawyer) })).resolves.toBeUndefined();
  });

  it("有墙时**被墙的承办律师本人**也被拒 —— 墙与自己是不是主办无关", async () => {
    const lawyer = await seedUser("被墙承办");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await seedWall(matter.id, principal.id, [lawyer.id]);

    // 关键：lawyer 是该案 ownerId，按纯归属判定本该通过；
    // 墙必须压过归属，否则「主办被隔离后仍能改」等于没隔离。
    await expect(assertMatterWritable(matter.id, { actor: actorOf(lawyer) })).rejects.toBeInstanceOf(ActionError);
  });

  it("墙对合伙人也生效 —— 执业合规要求，不是权限设置", async () => {
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(principal.id);
    await seedWall(matter.id, principal.id, [principal.id]);

    await expect(assertMatterWritable(matter.id, { actor: actorOf(principal) })).rejects.toBeInstanceOf(ActionError);
  });

  it("墙失效（expiresAt 已过）后重新可写", async () => {
    const lawyer = await seedUser("临时被墙");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    await prisma.ethicalWall.create({
      data: {
        id: uid("wall"), matterId: matter.id, reason: "临时隔离",
        createdById: principal.id, expiresAt: new Date(Date.now() - 60_000),
        denials: { create: [{ denyType: "USER", userId: lawyer.id }] }
      }
    });

    await expect(assertMatterWritable(matter.id, { actor: actorOf(lawyer) })).resolves.toBeUndefined();
  });
});

describe("assertDocumentWritable · 隔离墙（真库行为）", () => {
  it("材料挂在被墙案件上时不可写", async () => {
    const lawyer = await seedUser("材料承办");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(lawyer.id);
    const doc = await prisma.document.create({
      data: {
        id: uid("d"), matterId: matter.id, name: "起诉状.pdf", path: "storage/x.pdf",
        mimeType: "application/pdf", size: 10, sha256: "a".repeat(64), algorithm: "AES-256-GCM",
        uploadedById: lawyer.id, status: "DRAFT"
      }
    });

    await expect(assertDocumentWritable(doc.matterId, { kind: "modify", actor: actorOf(lawyer) })).resolves.toBeUndefined();

    await seedWall(matter.id, principal.id, [lawyer.id]);
    await expect(assertDocumentWritable(doc.matterId, { kind: "modify", actor: actorOf(lawyer) })).rejects.toBeInstanceOf(ActionError);
  });
});
