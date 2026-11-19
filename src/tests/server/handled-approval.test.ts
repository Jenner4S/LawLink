// @vitest-environment node
/**
 * `hasHandledApproval` 的真库验证（2026-11-21 补，第三条绕过通道）。
 *
 * ## 为什么必须真库
 *
 * 它的核心是一句 **JSON 路径查询**：
 *
 *   detail: { path: ["attachmentIds"], array_contains: [documentId] }
 *
 * Prisma 的 JSON 过滤在 PostgreSQL 上编译成 `jsonb` 操作符；mock 掉 prisma 之后，
 * 这句查询退化成「帮我返回一个固定值」，而它要回答的问题——
 * **「这个人处理那次审批时，附件里到底有没有这一份」**——从来没被验证过。
 *
 * ## 它守的是什么
 *
 * 注释写得很清楚：「仅授权实际处理过的申请所关联的原附件，**不传播到其他案件材料**」。
 * 也就是说：律师审批过某次用章，能看那次送审附的那几份材料；
 * **但不能因此看到他没被附上的其他材料**。
 *
 * 判断「有没有附上」靠 `detail.attachmentIds` 里是否含该 docId。
 * 这个条件一旦写松（比如去掉 `array_contains`，只按 targetId 匹配），
 * 后果是「审批过一次用章 → 该用印单下所有材料都能看」，
 * 而那可能包含他没被送审的案情文件。
 *
 * 第二个条件是 `event.decision === true` —— **只有「处理」记录才算，撤回/申请不算**。
 *
 * 隔离：自建临时库 `lawlink_handled_test_*` → migrate deploy → DROP。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_handled_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

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
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: HOLDER.url }, stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  console.info(`[handled-approval] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[handled-approval] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

const { hasHandledApproval } = await import("@/lib/approvals/history-access");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser(name: string) {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name, role: "LAWYER", passwordHash: "x", active: true }
  });
}

/** 写一条审计：某人对某个审批目标做了某动作，附件列表是 attachmentIds */
async function seedAudit(args: {
  userId: string; action: string; targetId: string; targetType: string;
  attachmentIds?: string[]; detail?: Record<string, unknown>;
}) {
  return prisma.auditLog.create({
    data: {
      id: uid("al"), userId: args.userId, action: args.action,
      targetId: args.targetId, targetType: args.targetType,
      detail: (args.detail ?? (args.attachmentIds ? { attachmentIds: args.attachmentIds } : {})) as never
    }
  });
}

/**
 * 这里【不能】用 `beforeEach` 清 AuditLog —— 清不掉，而且这是对的。
 *
 * 2026-11-21 实测：`prisma.auditLog.deleteMany()` 被数据库触发器拦下：
 *   P0001  AuditLog 不允许删除（AGENTS.md §六）：
 *          审计日志只能归档处置，不可由业务代码删除
 *
 * 这是 2026-09-20 那条加固迁移（backups/hardening-migration-20260920/）装上的，
 * 它确实在工作。所以本组改用「每个用例生成全新的 user id 与 targetId」
 * 来保证互不干扰 —— 查询都带精确 id，历史行不可能命中。
 *
 * 顺带说明：这也意味着**审计日志一旦写入就无法在测试里回滚**，
 * 临时库 DROP 是唯一清理方式（afterAll 已做）。
 */
const noCleanupNeeded = "用例间用唯一 id 隔离，不依赖清库";

describe("hasHandledApproval · JSON 附件关联（真库）", () => {
  it("处理过该用印单且附件含该材料 → true", async () => {
    const approver = await seedUser("审批人");
    const sealId = uid("seal");
    const docId = uid("doc");
    await seedAudit({ userId: approver.id, action: "SEAL_APPROVED", targetId: sealId, targetType: "SealRequest", attachmentIds: [docId] });
    expect(await hasHandledApproval(approver.id, "SEAL_APPROVE", sealId, docId)).toBe(true);
  });

  it("处理过但附件是该单下【其他】材料 → false（不传播）", async () => {
    // 这条是整个函数的核心语义：审批过一次用章，不等于能看那份用印单的所有材料。
    const approver = await seedUser("审批人");
    const sealId = uid("seal");
    const attachedDoc = uid("doc");
    const otherDoc = uid("doc");
    await seedAudit({ userId: approver.id, action: "SEAL_APPROVED", targetId: sealId, targetType: "SealRequest", attachmentIds: [attachedDoc] });

    expect(await hasHandledApproval(approver.id, "SEAL_APPROVE", sealId, attachedDoc)).toBe(true);
    expect(await hasHandledApproval(approver.id, "SEAL_APPROVE", sealId, otherDoc)).toBe(false);
  });

  it("别人处理的 → false", async () => {
    const approver = await seedUser("审批人");
    const outsider = await seedUser("旁人");
    const sealId = uid("seal");
    const docId = uid("doc");
    await seedAudit({ userId: approver.id, action: "SEAL_APPROVED", targetId: sealId, targetType: "SealRequest", attachmentIds: [docId] });
    expect(await hasHandledApproval(outsider.id, "SEAL_APPROVE", sealId, docId)).toBe(false);
  });

  it("审计里没有 attachmentIds 字段 → false（不能凭 targetId 就放行）", async () => {
    const approver = await seedUser("审批人");
    const sealId = uid("seal");
    const docId = uid("doc");
    await seedAudit({ userId: approver.id, action: "SEAL_APPROVED", targetId: sealId, targetType: "SealRequest", detail: {} });
    expect(await hasHandledApproval(approver.id, "SEAL_APPROVE", sealId, docId)).toBe(false);
  });

  it("未传 documentId 时只按 targetId + 动作匹配（DOCUMENT_APPROVE 的用法）", async () => {
    const approver = await seedUser("审批人");
    const docId = uid("doc");
    await seedAudit({ userId: approver.id, action: "DOCUMENT_APPROVE", targetId: docId, targetType: "Document" });
    expect(await hasHandledApproval(approver.id, "DOCUMENT_APPROVE", docId)).toBe(true);
    // 换成另一个人就 false
    const outsider = await seedUser("旁人");
    expect(await hasHandledApproval(outsider.id, "DOCUMENT_APPROVE", docId)).toBe(false);
  });

  it("decision=false 的事件（撤回/申请）不算「处理过」", async () => {
    // SEAL_CANCELLED 在 APPROVAL_EVENTS 里是 decision:false，不该扩大读取。
    const user = await seedUser("撤回人");
    const sealId = uid("seal");
    const docId = uid("doc");
    await seedAudit({ userId: user.id, action: "SEAL_CANCELLED", targetId: sealId, targetType: "SealRequest", attachmentIds: [docId] });
    expect(await hasHandledApproval(user.id, "SEAL_APPROVE", sealId, docId)).toBe(false);
  });

  it("不同 action 的事件不串用（用 INTAKE 的记录不能换来 SEAL 的读取权）", async () => {
    const user = await seedUser("审批人");
    const targetId = uid("t");
    const docId = uid("doc");
    await seedAudit({ userId: user.id, action: "INTAKE_APPROVE", targetId, targetType: "Intake", attachmentIds: [docId] });
    expect(await hasHandledApproval(user.id, "INTAKE_APPROVE", targetId, docId)).toBe(true);
    expect(await hasHandledApproval(user.id, "SEAL_APPROVE", targetId, docId)).toBe(false);
  });

  it("legacy 分支：SEAL_LEGACY_CLASSIFY 的 previousApproval 同时命中 userId 与 attachmentIds → true", async () => {
    // 历史数据：早期没有标准审批记录，只有「补充事项并重新送审」里记了上一轮的审批人和附件。
    const prevApprover = await seedUser("旧审批人");
    const operator = await seedUser("补录人");
    const sealId = uid("seal");
    const docId = uid("doc");
    await seedAudit({
      userId: operator.id, action: "SEAL_LEGACY_CLASSIFY", targetId: sealId, targetType: "SealRequest",
      detail: { previousApproval: { userId: prevApprover.id, attachmentIds: [docId] } }
    });
    // 旧审批人可以看
    expect(await hasHandledApproval(prevApprover.id, "SEAL_APPROVE", sealId, docId)).toBe(true);
    // 补录人自己不行 —— previousApproval.userId 才是判据，不是这条审计的 userId
    expect(await hasHandledApproval(operator.id, "SEAL_APPROVE", sealId, docId)).toBe(false);
  });

  it("legacy 分支：previousApproval 有 userId 但附件不含该材料 → false", async () => {
    const prevApprover = await seedUser("旧审批人");
    const operator = await seedUser("补录人");
    const sealId = uid("seal");
    const attached = uid("doc");
    const other = uid("doc");
    await seedAudit({
      userId: operator.id, action: "SEAL_LEGACY_CLASSIFY", targetId: sealId, targetType: "SealRequest",
      detail: { previousApproval: { userId: prevApprover.id, attachmentIds: [attached] } }
    });
    expect(await hasHandledApproval(prevApprover.id, "SEAL_APPROVE", sealId, other)).toBe(false);
  });
});
