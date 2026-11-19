// @vitest-environment node
/**
 * 三个「接了隔离墙但零测试引用」的入口（2026-11-20 补）。
 *
 * 背景：Round 91 核验上一轮的论断「其余墙入口已有针对性测试」时发现
 * 这句话不成立 —— 四个入口其实零测试引用：
 *
 *   canReviewDocument       AI 全文外发前的审查资格（Round 45 接墙）
 *   buildMatterWhere        案件工作簿导出的 where（Round 46 接墙）
 *   approvalRecordAccess    审批记录的可见性（Round 79 接墙）
 *   getWorkBoard            个人工作台（Round 77 接墙，需 session，本文件不覆盖）
 *
 * 前三个是纯参数 / 纯函数，测起来最便宜；本文件覆盖它们。
 *
 * 隔离：canReviewDocument 与 approvalRecordAccess 走真库（自建临时库），
 * buildMatterWhere 是纯函数不需要库。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_miscwall_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

import { canReviewDocument } from "@/server/ai/document-access";
import { buildMatterWhere } from "@/server/matters/export-query";
import { approvalRecordAccess, type ApprovalRecord } from "@/server/approval-permissions/records";

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
  console.info(`[misc-wall] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[misc-wall] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser(name: string, role: "LAWYER" | "PRINCIPAL_LAWYER" | "FINANCE" = "LAWYER") {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name, role, passwordHash: "x", active: true }
  });
}

async function seedMatter(ownerId: string) {
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("LL-"), title: "零散入口验证案",
      category: "CIVIL_COMMERCIAL", status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId, customValues: {}
    }
  });
}

async function seedWall(matterId: string, createdById: string, userIds: string[]) {
  return prisma.ethicalWall.create({
    data: {
      id: uid("wall"), matterId, reason: "利益冲突",
      createdById,
      denials: { create: userIds.map((userId) => ({ denyType: "USER" as const, userId })) }
    }
  });
}

/* ================================================================== *
 * canReviewDocument —— AI 全文外发资格（Round 45 接墙）
 * ================================================================== */
describe("canReviewDocument · 隔离墙", () => {
  it("案件材料的审查资格被墙拦住（合伙人也不例外）", async () => {
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(principal.id);
    const doc = { id: uid("d"), uploadedById: principal.id, matterId: matter.id, intakeId: null };

    // 无墙时合伙人有资格
    await expect(canReviewDocument(principal.id, doc)).resolves.toBe(true);

    await seedWall(matter.id, principal.id, [principal.id]);

    // 有墙后必须拒绝 —— Round 45 的 bug 是 `if (isManager(...)) return true` 排在墙前面，
    // 导致合伙人直接穿透。这条断言就是那个 bug 的回归守卫。
    await expect(canReviewDocument(principal.id, doc)).resolves.toBe(false);
  });

  it("非案件材料（无 matterId）不受墙影响", async () => {
    const lawyer = await seedUser("承办");
    const doc = { id: uid("d"), uploadedById: lawyer.id, matterId: null, intakeId: null };
    // 无 matterId 时按上传者判定
    await expect(canReviewDocument(lawyer.id, doc)).resolves.toBe(true);
  });
});

/* ================================================================== *
 * approvalRecordAccess —— 审批记录可见性（Round 79 接墙）
 * ================================================================== */
describe("approvalRecordAccess · 隔离墙", () => {
  const baseRow = (matterId: string | null, requesterId: string): ApprovalRecord => ({
    id: "a1", action: "SEAL_APPROVE", title: "用章申请", requester: "申请人",
    matter: "案件", matterId, status: "PENDING", submittedAt: new Date(),
    processedAt: null, processor: null, history: [], participantIds: [],
    requesterId
  });

  it("申请人是被墙者时不可读（关系型判据被墙压过）", async () => {
    const requester = await seedUser("申请人");
    const principal = await seedUser("主任", "PRINCIPAL_LAWYER");
    const matter = await seedMatter(requester.id);
    const row = baseRow(matter.id, requester.id);
    await seedWall(matter.id, principal.id, [requester.id]);

    // 有墙：即使自己是申请人也不可读 —— Round 79 的 bug 是 readable 判据全是
    // 关系型（申请人/主办/参与人/有任务），没有一条看墙。
    //
    // 注：这里只断言「有墙→不可读」这一侧。墙检查在函数最前面、命中即
    // `return { task: null, readable: false }`，不会走到后续那些需要真实
    // SealRequest / Document 实体的判定；而「无墙→放行」那一侧要造齐整条
    // 审批链夹具，与本次要验证的墙无关，不在这里做（避免为测墙而造半个业务）。
    await expect(approvalRecordAccess({ id: requester.id, role: "LAWYER", systemRole: "NONE" }, row))
      .resolves.toMatchObject({ readable: false, task: null });
  });
});

/* ================================================================== *
 * buildMatterWhere —— 案件工作簿导出的 where（Round 46 接墙）
 * ================================================================== */
describe("buildMatterWhere · 隔离墙", () => {
  const params = { tab: "basic" } as never;

  it("导出的 where 里带隔离墙片段（合伙人也带）", () => {
    const where = buildMatterWhere(params, { id: "u1", role: "PRINCIPAL_LAWYER", managerAuthorized: false } as never);
    // 结构断言：AND 里必须有含 ethicalWalls 的那一段
    const json = JSON.stringify(where);
    expect(json).toContain("ethicalWalls");
    expect(json).toContain("denials");
    // 且不能是空条件 —— 导出 contains 当事人证件与联系方式，不能整所导出
    expect(json).not.toBe("{}");
  });

  it("普通律师的 where 同时含经办关联与墙", () => {
    const where = buildMatterWhere(params, { id: "u2", role: "LAWYER", managerAuthorized: false } as never);
    const json = JSON.stringify(where);
    expect(json).toContain("ethicalWalls");
    // 经办关联（ownerId 或 members）也应在
    expect(json.includes("ownerId") || json.includes("members")).toBe(true);
  });
});
