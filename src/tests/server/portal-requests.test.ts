// @vitest-environment node
/**
 * 客户门户 S3：工单与满意度（真库，2026-11-21）
 *
 * 守三条：
 *   ① **跨客户隔离**——过滤条件永远是 clientId，不是「同一个律师」。
 *      B 客户不仅读不到 A 的工单，连"是否存在"都不该被推断出来。
 *   ② **协作者可见性档位生效**——OWN_SUBMISSIONS 只看自己的；
 *      主账号永远看全部；默认 ALL（Q3 默认档）。
 *   ③ **匿名评价真的匿名**——portalUserId 置空、clientId 保留。
 *      若两者都清空，律所就无法知道是哪家客户；若都保留，"匿名"是假的。
 */
import { beforeEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
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
const auditMock = vi.fn(async () => {});
const STAFF = { id: "" };
/** 当前"登录"的门户账号（getPortalViewer 的 mock 来源） */
let viewer: { portalUserId: string; clientId: string; clientName: string; name: string; email: string } | null = null;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "staff@s3.local", name: "经办律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: auditMock, auditTx: vi.fn() }));
vi.mock("@/lib/permissions", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/permissions");
  return { ...actual, assertCanHandleMatter: vi.fn(async () => {}) };
});
vi.mock("@/lib/portal/session", () => ({ getPortalViewer: vi.fn(async () => viewer) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { submitPortalRequest, listMyPortalRequests, answerPortalRequest, listPortalRequestsForStaff, submitPortalSatisfaction } =
  await import("@/server/portal/requests");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedClient() {
  return prisma.client.create({ data: { id: uid("c"), name: uid("客户"), type: "COMPANY" } });
}
async function seedPortalUser(clientId: string, opts: { isPrimary?: boolean; visibility?: "ALL" | "OWN_SUBMISSIONS" } = {}) {
  const u = await prisma.clientPortalUser.create({
    data: {
      clientId,
      email: `${uid("p")}@client.local`,
      name: uid("账号"),
      passwordHash: "!x",
      isPrimary: opts.isPrimary ?? true,
      visibility: opts.visibility ?? "ALL"
    }
  });
  return u;
}
async function seedMatter(clientId: string) {
  return prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "S3 案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: clientId, customValues: {}
    }
  });
}

beforeEach(() => { vi.clearAllMocks(); viewer = null; });

describe("工单跨客户隔离", () => {
  it("A 客户提交后，B 客户看不到任何工单", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const ua = await seedPortalUser(a.id, { isPrimary: true });
    const ub = await seedPortalUser(b.id, { isPrimary: true });

    viewer = { portalUserId: ua.id, clientId: a.id, clientName: "A", name: "A 对接人", email: ua.email };
    await submitPortalRequest({ subject: "进度问询", body: "想了解一审进展" });

    viewer = { portalUserId: ub.id, clientId: b.id, clientName: "B", name: "B 对接人", email: ub.email };
    expect(await listMyPortalRequests()).toHaveLength(0);

    viewer = { portalUserId: ua.id, clientId: a.id, clientName: "A", name: "A 对接人", email: ua.email };
    expect(await listMyPortalRequests()).toHaveLength(1);
  });
});

describe("协作者可见性（Q3 第二档）", () => {
  it("默认 ALL：协作者能看到同客户其他账号提交的工单", async () => {
    const c = await seedClient();
    const primary = await seedPortalUser(c.id, { isPrimary: true });
    const collab = await seedPortalUser(c.id, { isPrimary: false, visibility: "ALL" });

    viewer = { portalUserId: primary.id, clientId: c.id, clientName: "C", name: "主", email: primary.email };
    await submitPortalRequest({ subject: "主账号提问", body: "主账号的问题描述" });

    viewer = { portalUserId: collab.id, clientId: c.id, clientName: "C", name: "协", email: collab.email };
    const rows = await listMyPortalRequests();
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe("主账号提问");
  });

  it("OWN_SUBMISSIONS：协作者只看自己提交的", async () => {
    const c = await seedClient();
    const primary = await seedPortalUser(c.id, { isPrimary: true });
    const collab = await seedPortalUser(c.id, { isPrimary: false, visibility: "OWN_SUBMISSIONS" });

    viewer = { portalUserId: primary.id, clientId: c.id, clientName: "C", name: "主", email: primary.email };
    await submitPortalRequest({ subject: "主账号提问", body: "主账号的问题描述" });

    viewer = { portalUserId: collab.id, clientId: c.id, clientName: "C", name: "协", email: collab.email };
    expect(await listMyPortalRequests()).toHaveLength(0);
    await submitPortalRequest({ subject: "协作者自己的问题", body: "只有我能看到这条" });
    const mine = await listMyPortalRequests();
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toBe("协作者自己的问题");
  });

  it("主账号即使被设成 OWN_SUBMISSIONS 也看全部（档位只约束协作者）", async () => {
    const c = await seedClient();
    const primary = await seedPortalUser(c.id, { isPrimary: true, visibility: "OWN_SUBMISSIONS" });
    const collab = await seedPortalUser(c.id, { isPrimary: false, visibility: "OWN_SUBMISSIONS" });

    viewer = { portalUserId: collab.id, clientId: c.id, clientName: "C", name: "协", email: collab.email };
    await submitPortalRequest({ subject: "协作者的提问", body: "协作者提交的问题" });

    viewer = { portalUserId: primary.id, clientId: c.id, clientName: "C", name: "主", email: primary.email };
    expect(await listMyPortalRequests()).toHaveLength(1);
  });
});

describe("员工回复与超期标记", () => {
  it("回复落 answerBody/answeredAt，状态变 ANSWERED；可一并关闭", async () => {
    const c = await seedClient();
    const u = await seedPortalUser(c.id);
    viewer = { portalUserId: u.id, clientId: c.id, clientName: "C", name: "客户", email: u.email };
    const { id } = await submitPortalRequest({ subject: "问进度", body: "想了解进展" });
    viewer = null;

    await answerPortalRequest({ requestId: id, answer: "已开庭，判决预计下月送达" });
    let row = await prisma.portalRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("ANSWERED");
    expect(row.answerBody).toContain("判决预计");
    expect(row.answeredById).toBe(STAFF.id);

    await answerPortalRequest({ requestId: id, answer: "补充：已收到判决", closeIt: true });
    row = await prisma.portalRequest.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe("CLOSED");
    expect(row.answerBody).toContain("补充");
  });

  it("过了 dueAt 仍未回复 → 员工列表里 overdue=true", async () => {
    const c = await seedClient();
    const u = await seedPortalUser(c.id);
    viewer = { portalUserId: u.id, clientId: c.id, clientName: "C", name: "客户", email: u.email };
    const { id } = await submitPortalRequest({ subject: "急事", body: "希望尽快回复" });
    viewer = null;
    await prisma.portalRequest.update({ where: { id }, data: { dueAt: new Date(Date.now() - 3600_000) } });

    const rows = await listPortalRequestsForStaff(c.id);
    expect(rows.find((r) => r.id === id)?.overdue).toBe(true);
  });

  it("员工列表按客户隔离：查 A 客户不会带出 B 的工单", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const ua = await seedPortalUser(a.id);
    const ub = await seedPortalUser(b.id);
    viewer = { portalUserId: ua.id, clientId: a.id, clientName: "A", name: "A", email: ua.email };
    await submitPortalRequest({ subject: "A 的问题", body: "A 客户提问内容" });
    viewer = { portalUserId: ub.id, clientId: b.id, clientName: "B", name: "B", email: ub.email };
    await submitPortalRequest({ subject: "B 的问题", body: "B 客户提问内容" });
    viewer = null;

    expect((await listPortalRequestsForStaff(a.id)).map((r) => r.subject)).toEqual(["A 的问题"]);
  });
});

describe("满意度（一案件一次 / 匿名真的匿名）", () => {
  async function seedSharedMatter() {
    const c = await seedClient();
    const u = await seedPortalUser(c.id);
    const m = await seedMatter(c.id);
    await prisma.portalShare.create({
      data: { clientId: c.id, shareType: "MATTER_SUMMARY", matterId: m.id, sharedById: STAFF.id }
    });
    viewer = { portalUserId: u.id, clientId: c.id, clientName: "C", name: "客户", email: u.email };
    return { client: c, user: u, matter: m };
  }

  it("匿名提交：portalUserId 置空但 clientId 保留", async () => {
    const { client, matter } = await seedSharedMatter();
    await submitPortalSatisfaction({ matterId: matter.id, score: 4, anonymous: true });
    const row = await prisma.portalSatisfaction.findFirstOrThrow({ where: { matterId: matter.id } });
    expect(row.portalUserId).toBeNull();
    expect(row.clientId).toBe(client.id);
    expect(row.anonymous).toBe(true);
  });

  it("一案件一次：第二次提交被拒绝", async () => {
    const { matter } = await seedSharedMatter();
    await submitPortalSatisfaction({ matterId: matter.id, score: 5 });
    await expect(submitPortalSatisfaction({ matterId: matter.id, score: 3 })).rejects.toThrow("已提交过评价");
  });

  it("案件未开放给该客户时不能评价（防拿 id 猜）", async () => {
    const c = await seedClient();
    const u = await seedPortalUser(c.id);
    const m = await seedMatter(c.id); // 没有 PortalShare
    viewer = { portalUserId: u.id, clientId: c.id, clientName: "C", name: "客户", email: u.email };
    await expect(submitPortalSatisfaction({ matterId: m.id, score: 5 })).rejects.toThrow("尚未向你开放");
  });
});
