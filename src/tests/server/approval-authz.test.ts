// @vitest-environment node
/**
 * 审批授权的真库行为验证（2026-11-21 补，多智能体审计 A-1/A-2/A-3 的核心一项）。
 *
 * 为什么必须用真库：
 *
 * `canApproveContext` 有六层判定，任何一层写错都可能导致「不该批的人批了」
 * 或「该批的人批不了」：
 *
 *   1. user 存在且 active
 *   2. resolveRoleUser().enabled（CUSTOM 角色被停用即拒）
 *   3. approvalSettings() —— 自审批开关
 *   4. 用印分支：sealTypeConfig.enabled、requiresLegalRep/法人章必须法定代表人、
 *      sealPurposeConfig.active + allowedSealTypes
 *   5. mayApproveSelf —— 申请人不得自审（SEAL_STAMP 有单独语义）
 *   6. approvalPermissionRule + group 成员关系 + matchesApprovalRule
 *
 * 而它此前的测试是 `vi.mock("@/lib/prisma", () => ({ prisma: db }))` ——
 * 六层判定全部跑在手工编造的对象上。第 4、6 层的 `includes(...)`、
 * `matchesApprovalRule` 的数组/枚举比较，编出来的 mock 与真实 Prisma
 * 返回的形状是否一致，没人验过。
 *
 * 隔离：自建临时库 `lawlink_approve_test_*` → `prisma migrate deploy` →
 * `DROP DATABASE … WITH (FORCE)`。**绝不写主库。**
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  console.info(`[approval-authz] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

const { canApproveContext } = await import("@/lib/approvals/service");

/**
 * 每个用例前清库（2026-11-21 踩到的：多个 it 共享同一个临时库，
 * 前一个用例建的 SystemSetting（firmLegalRepUserId）/ SealTypeConfig
 * 会污染后一个用例，导致「该通过」的分支被拒）。
 * 这不是代码问题，是测试隔离问题 —— 与 Round 90 真库测试同一类坑。
 */
beforeEach(async () => {
  await prisma.approvalPermissionRule.deleteMany({});
  await prisma.approvalPermissionMember.deleteMany({});
  await prisma.approvalPermissionGroup.deleteMany({});
  await prisma.sealPurposeConfig.deleteMany({});
  await prisma.sealTypeConfig.deleteMany({});
  await prisma.systemSetting.deleteMany({});
});

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser(name: string, role: "LAWYER" | "PRINCIPAL_LAWYER" = "LAWYER") {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name, role, passwordHash: "x", active: true }
  });
}

/** 建一个审批组 + 一条规则 + 一个成员 */
async function seedRuleFor(opts: {
  action: "DOCUMENT_APPROVE" | "SEAL_APPROVE";
  userId: string;
  categories?: string[];
  sealTypes?: string[];
}) {
  const group = await prisma.approvalPermissionGroup.create({
    data: {
      id: uid("g"), name: uid("组"),
      members: { create: [{ userId: opts.userId, active: true }] },
      rules: {
        create: [{
          action: opts.action,
          caseScope: opts.categories?.length ? "CATEGORIES" : "ALL_CASES",
          categories: (opts.categories ?? []) as never,
          sealTypes: (opts.sealTypes ?? []) as never,
          allSealPurposes: true,
          active: true
        }]
      }
    }
  });
  return group;
}

/**
 * 默认 category 必须给真实枚举值。
 *
 * 2026-11-21 踩到的：`matchesApprovalRule` 里
 *   const inScope = rule.caseScope === "NON_CASE" ? context.category === null
 *     : context.category !== null && (...)
 * —— 非 NON_CASE 规则要求 category **非 null**。第一版测试用 category: null，
 * 于是「该通过」的分支全被拒，5 个用例红。
 * 那是测试没搞清业务语义，不是代码 bug。
 */
/**
 * 2026-11-21 第二处踩坑：`requesterId` 不能给 null。
 *
 * `mayApproveSelf` 的实现是
 *   return context.requesterId !== null && (context.requesterId !== userId || allowSelfApproval);
 * —— **申请人未知时直接拒绝**（防御性：不知道谁申请的就不批）。
 * 第一版默认 null，于是所有「该通过」的用例都变成了「拒绝」。
 * 默认给一个与任何人都不同的字符串，需要 null 语义的用例显式传。
 */
const OTHER_REQUESTER = "requester-someone-else";
const ctx = (over: Partial<{ action: "DOCUMENT_APPROVE" | "SEAL_APPROVE"; requesterId: string | null; category: string | null; sealType: string | null }> = {}) => ({
  action: (over.action ?? "DOCUMENT_APPROVE") as never,
  requesterId: (over.requesterId !== undefined ? over.requesterId : OTHER_REQUESTER) as never,
  category: (over.category !== undefined ? over.category : "CIVIL_COMMERCIAL") as never,
  sealType: (over.sealType ?? null) as never,
  purposeId: null
});

describe("canApproveContext · 真库六层判定", () => {
  it("层 1：账号停用 → 拒绝", async () => {
    const u = await seedUser("停用");
    await seedRuleFor({ action: "DOCUMENT_APPROVE", userId: u.id });
    await prisma.user.update({ where: { id: u.id }, data: { active: false } });
    expect(await canApproveContext(u.id, ctx())).toBe(false);
  });

  it("层 5：申请人不得自审（allowSelfApproval 关）", async () => {
    const u = await seedUser("申请人");
    await seedRuleFor({ action: "DOCUMENT_APPROVE", userId: u.id });
    // 非本人申请 → 可批
    expect(await canApproveContext(u.id, ctx({ requesterId: "someone-else" }))).toBe(true);
    // 本人申请 → 拒
    expect(await canApproveContext(u.id, ctx({ requesterId: u.id }))).toBe(false);
  });

  it("层 6：不在任何审批组的用户 → 拒绝（即使有规则也一样）", async () => {
    const u = await seedUser("组外");
    const other = await seedUser("组内");
    await seedRuleFor({ action: "DOCUMENT_APPROVE", userId: other.id });
    expect(await canApproveContext(u.id, ctx())).toBe(false);
    expect(await canApproveContext(other.id, ctx())).toBe(true);
  });

  it("层 6：规则按 action 隔离 —— 有 DOCUMENT_APPROVE 权不等于有 SEAL_APPROVE 权", async () => {
    const u = await seedUser("单权");
    await seedRuleFor({ action: "DOCUMENT_APPROVE", userId: u.id });
    expect(await canApproveContext(u.id, ctx({ action: "DOCUMENT_APPROVE" }))).toBe(true);
    expect(await canApproveContext(u.id, ctx({ action: "SEAL_APPROVE" }))).toBe(false);
  });

  it("层 4：用印类型被停用 → 拒绝", async () => {
    const u = await seedUser("用印审批");
    await seedRuleFor({ action: "SEAL_APPROVE", userId: u.id, sealTypes: ["CONTRACT_SEAL"] });
    // 未配置 sealTypeConfig → config 为 null → 拒
    expect(await canApproveContext(u.id, ctx({ action: "SEAL_APPROVE", sealType: "CONTRACT_SEAL" }))).toBe(false);

    // 配置并启用 → 通过路径打通
    await prisma.sealTypeConfig.create({
      data: { type: "CONTRACT_SEAL" as never, label: "合同章", approverRoles: [], enabled: true, requiresLegalRep: false }
    });
    const purpose = await prisma.sealPurposeConfig.create({
      data: { name: uid("用途"), active: true, allowedSealTypes: ["CONTRACT_SEAL"] as never }
    });
    expect(await canApproveContext(u.id, {
      action: "SEAL_APPROVE" as never, requesterId: OTHER_REQUESTER as never, category: "CIVIL_COMMERCIAL" as never,
      sealType: "CONTRACT_SEAL" as never, purposeId: purpose.id
    })).toBe(true);
  });

  it("层 4：法人章必须由当前法定代表人审批（requiresLegalRep）", async () => {
    const rep = await seedUser("法代", "PRINCIPAL_LAWYER");
    const other = await seedUser("非代", "PRINCIPAL_LAWYER");
    await seedRuleFor({ action: "SEAL_APPROVE", userId: rep.id, sealTypes: ["LEGAL_REP_SEAL"] });
    await seedRuleFor({ action: "SEAL_APPROVE", userId: other.id, sealTypes: ["LEGAL_REP_SEAL"] });
    await prisma.sealTypeConfig.create({
      data: { type: "LEGAL_REP_SEAL" as never, label: "法人章", approverRoles: [], enabled: true, requiresLegalRep: true }
    });
    const purpose = await prisma.sealPurposeConfig.create({
      data: { name: uid("法代用途"), active: true, allowedSealTypes: ["LEGAL_REP_SEAL"] as never }
    });
    // 未指定法定代表人 → 两人都拒
    const sealCtx = (uidStr: string) => ({
      action: "SEAL_APPROVE" as never, requesterId: uidStr as never, category: "CIVIL_COMMERCIAL" as never,
      sealType: "LEGAL_REP_SEAL" as never, purposeId: purpose.id
    });
    // requesterId 用别人的，避免自审批干扰
    const requester = (await seedUser("申请")).id;
    expect(await canApproveContext(rep.id, { ...sealCtx(requester) })).toBe(false);
    expect(await canApproveContext(other.id, { ...sealCtx(requester) })).toBe(false);

    // 指定 rep 为法定代表人 → 只有 rep 能批
    await prisma.systemSetting.create({
      data: { key: "firmLegalRepUserId", value: { value: rep.id } }
    });
    expect(await canApproveContext(rep.id, { ...sealCtx(requester) })).toBe(true);
    expect(await canApproveContext(other.id, { ...sealCtx(requester) })).toBe(false);
  });
});
