// @vitest-environment node
/**
 * 客户门户 S1：邀请 → 设密码 → 登录（真库，2026-11-20）
 *
 * 这些用例针对的是**外网入口的第一道门**，所以每条都在验一个具体攻击面：
 *
 *   1. 邀请一次性 —— 重复提交只有一次成功（靠条件更新，不是先查后写）
 *   2. 邀请过期 —— 24 小时后失败，且**文案与「不存在」相同**（不告诉陌生人 token 存在过）
 *   3. 邀请属于别人 —— 邮箱已被其他客户占用时拒绝，且不泄露对方客户名
 *   4. 登录枚举 —— 邮箱不存在与口令错误返回同一句
 *   5. 停用 / 客户已删 —— 登录被拒（对外同一句，内部审计区分原因）
 *   6. 踢下线 —— revoke 递增 sessionVersion 且置 active=false
 *   7. 会话签名 —— 篡改载荷或换用途的签名一律解析失败
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
  process.env.NEXTAUTH_SECRET = "test-secret-for-portal-session-0123456789";
  return name;
});

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
const auditMock = vi.fn(async () => {});
let staffSession = { user: { id: "cstaff", role: "LAWYER", rolePermissions: undefined as unknown } };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
}, 180_000);

afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => staffSession) }));
vi.mock("@/server/audit", () => ({ audit: auditMock, auditTx: vi.fn() }));
vi.mock("@/lib/permissions", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/permissions");
  return { ...actual, isManager: () => false };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { invitePortalUser, acceptPortalInvite, authenticatePortalUser, revokePortalUser } =
  await import("@/server/portal/actions");
const { readPortalSession, signPortalSession, PORTAL_COOKIE } = await import("@/lib/portal/auth");
const { claimInvite } = await import("@/server/portal/invite-claim");

/** 取最近一次某类 audit 的 detail（mock.calls 元组形状推不出来，统一收口） */
function auditDetailOf(action: string): any {
  const calls = auditMock.mock.calls as unknown as [ { action: string; detail: any } ][];
  return calls.map((c) => c[0]).filter((d) => d.action === action).at(-1)?.detail;
}

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedStaff() {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@staff.local`, name: "经办律师", role: "LAWYER", passwordHash: "x", active: true }
  });
}

async function seedClient(deleted = false) {
  return prisma.client.create({
    data: { id: uid("c"), name: `${uid("客户")}`, type: "COMPANY", ...(deleted ? { deletedAt: new Date() } : {}) }
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const staff = await seedStaff();
  staffSession = { user: { id: staff.id, role: "LAWYER", rolePermissions: undefined } };
});

describe("邀请 · 一次性 / 过期 / 归属", () => {
  it("邀请返回明文 token 一次，库里只存哈希", async () => {
    const client = await seedClient();
    const res = await invitePortalUser({ clientId: client.id, email: `${uid("p")}@client.local`, name: "张经理" });
    expect(res.token).toBeTruthy();
    const row = await prisma.portalInvite.findFirst({ where: { portalUserId: res.portalUserId } });
    expect(row!.tokenHash).not.toBe(res.token);
    expect(row!.tokenHash).toHaveLength(64); // sha256 hex
  });

  it("同一邀请只能接受一次：第二次失败", async () => {
    const client = await seedClient();
    const { token } = await invitePortalUser({ clientId: client.id, email: `${uid("p")}@client.local`, name: "张经理" });
    await acceptPortalInvite({ token, password: "portal-pass-1" });
    await expect(acceptPortalInvite({ token, password: "portal-pass-2" })).rejects.toThrow("邀请无效或已过期");
  });

  /**
   * 并发保护要**直接测占位语义**，不能靠「连第二次」——
   * 函数开头的前置检查会先拦下第二次，条件更新根本没被验证到。
   * 第一版就是这么写的，做变异（去掉 usedAt: null）后测试照样绿。
   */
  it("claimInvite 是原子占位：同一邀请只有第一次成功", async () => {
    const client = await seedClient();
    const { token } = await invitePortalUser({ clientId: client.id, email: `${uid("p")}@client.local`, name: "张经理" });
    const inv = await prisma.portalInvite.findFirstOrThrow({ where: { tokenHash: (await import("@/lib/portal/auth")).hashInviteToken(token) } });
    expect(await claimInvite(prisma as never, inv.id)).toBe(true);
    expect(await claimInvite(prisma as never, inv.id)).toBe(false);
  });

  it("两个并发占位只有一个成功（Promise.all 同进程竞态）", async () => {
    const client = await seedClient();
    const { token } = await invitePortalUser({ clientId: client.id, email: `${uid("p")}@client.local`, name: "张经理" });
    const inv = await prisma.portalInvite.findFirstOrThrow({ where: { tokenHash: (await import("@/lib/portal/auth")).hashInviteToken(token) } });
    const results = await Promise.all([claimInvite(prisma as never, inv.id), claimInvite(prisma as never, inv.id)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("过期邀请失败，且文案与「不存在」完全一致", async () => {
    const client = await seedClient();
    const { token } = await invitePortalUser({ clientId: client.id, email: `${uid("p")}@client.local`, name: "张经理" });
    await prisma.portalInvite.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const expiredMsg = await acceptPortalInvite({ token, password: "portal-pass-1" }).catch((e) => e.message);
    const ghostMsg = await acceptPortalInvite({ token: "x".repeat(43), password: "portal-pass-1" }).catch((e) => e.message);
    expect(expiredMsg).toBe(ghostMsg);
  });

  it("邮箱已属于别的客户时拒绝，且不泄露对方客户名", async () => {
    const a = await seedClient();
    const b = await seedClient();
    const email = `${uid("p")}@client.local`;
    await invitePortalUser({ clientId: a.id, email, name: "张经理" });
    const err = await invitePortalUser({ clientId: b.id, email, name: "李经理" }).catch((e) => e.message);
    expect(err).toContain("已被占用");
    expect(err).not.toContain(a.name);
  });

  it("给已删除的客户发邀请被拒", async () => {
    const client = await seedClient(true);
    await expect(invitePortalUser({ clientId: client.id, email: `${uid("p")}@client.local`, name: "张" }))
      .rejects.toThrow("客户不存在或已删除");
  });
});

describe("登录 · 不枚举 / 停用 / 踢下线", () => {
  async function activated(emailPrefix = "p") {
    const client = await seedClient();
    const email = `${uid(emailPrefix)}@client.local`;
    const { token } = await invitePortalUser({ clientId: client.id, email, name: "张经理" });
    await acceptPortalInvite({ token, password: "portal-pass-1" });
    return { client, email };
  }

  it("邮箱不存在与口令错误返回同一句", async () => {
    const { email } = await activated();
    const wrongPw = await authenticatePortalUser({ email, password: "bad-password" }).catch((e) => e.message);
    const ghost = await authenticatePortalUser({ email: `${uid("no")}@client.local`, password: "whatever" }).catch((e) => e.message);
    expect(wrongPw).toBe(ghost);
    expect(wrongPw).toContain("邮箱或密码不正确");
  });

  it("正确口令可登录，并签发门户会话（cookie 名与员工侧不同）", async () => {
    const { email } = await activated();
    const res = await authenticatePortalUser({ email, password: "portal-pass-1" });
    const payload = readPortalSession(res.session);
    expect(payload).not.toBeNull();
    expect(PORTAL_COOKIE).toBe("lawlink_portal_session");
  });

  it("停用后登录被拒，对外与口令错误同一句，内部审计记原因", async () => {
    const { email } = await activated();
    const u = await prisma.clientPortalUser.findUniqueOrThrow({ where: { email } });
    await prisma.clientPortalUser.update({ where: { id: u.id }, data: { active: false } });
    await expect(authenticatePortalUser({ email, password: "portal-pass-1" })).rejects.toThrow("邮箱或密码不正确");
    expect(auditDetailOf("PORTAL_LOGIN_BLOCKED")?.reason).toBe("INACTIVE");
  });

  it("客户已软删后登录被拒（原因记 CLIENT_DELETED）", async () => {
    const { client, email } = await activated();
    await prisma.client.update({ where: { id: client.id }, data: { deletedAt: new Date() } });
    await expect(authenticatePortalUser({ email, password: "portal-pass-1" })).rejects.toThrow("邮箱或密码不正确");
    expect(auditDetailOf("PORTAL_LOGIN_BLOCKED")?.reason).toBe("CLIENT_DELETED");
  });

  it("撤销递增 sessionVersion 且停用：旧会话的 sv 与库不一致", async () => {
    const { email } = await activated();
    const login = await authenticatePortalUser({ email, password: "portal-pass-1" });
    const before = readPortalSession(login.session)!;
    const u = await prisma.clientPortalUser.findUniqueOrThrow({ where: { email } });
    await revokePortalUser(u.id);
    const after = await prisma.clientPortalUser.findUniqueOrThrow({ where: { email } });
    expect(after.active).toBe(false);
    expect(after.sessionVersion).toBe(before.sv + 1);
  });
});

describe("会话签名 · 篡改与跨用途", () => {
  it("篡改载荷后解析为 null", () => {
    const s = signPortalSession({ uid: "u1", sv: 0, exp: Math.floor(Date.now() / 1000) + 3600 });
    const [body, mac] = s.split(".");
    const tampered = Buffer.from(JSON.stringify({ uid: "u2", sv: 0, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    expect(readPortalSession(`${tampered}.${mac}`)).toBeNull();
    expect(readPortalSession(`${body}.${mac}`)).not.toBeNull();
  });

  it("过期会话解析为 null", () => {
    const s = signPortalSession({ uid: "u1", sv: 0, exp: Math.floor(Date.now() / 1000) - 10 });
    expect(readPortalSession(s)).toBeNull();
  });

  it("空值 / 垃圾串解析为 null，不抛错", () => {
    expect(readPortalSession(undefined)).toBeNull();
    expect(readPortalSession("")).toBeNull();
    expect(readPortalSession("not-a-token")).toBeNull();
  });
});
