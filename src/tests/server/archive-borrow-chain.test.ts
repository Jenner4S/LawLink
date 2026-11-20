// @vitest-environment node
/**
 * 归档借阅的**完整链条**（真库，2026-11-21）
 *
 * 第八轮审计 §四点名这一环「未做」：
 *   > 借阅申请→审批→归还
 * 已有的真库测试只覆盖单点（时效判定、在途去重），审批/归还的逻辑测试全是 mock。
 * mock 测不出「状态推进之后**读取权限**是否随之变化」——而那正是借阅的全部意义。
 *
 * 本文件走真动作、真库、真权限判定：
 *   基线（无借阅→拒） → 申请（PENDING）→ 审批（APPROVED + accessUntil）
 *   → **可读**（权限真的开了）→ 归还（RETURNED）→ **又不可读**（归还即收回）
 *
 * 最后一跳是最关键的：如果归还只改状态、权限判定还看 ARCHIVED 就放行，
 * 那"限时借阅"就是个摆设。
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
/** 当前登录者（真实动作通过 requireSession 读它） */
let sessionUser: { id: string; role: string; rolePermissions?: unknown } | null = null;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: sessionUser })),
  getSession: vi.fn(async () => ({ user: sessionUser }))
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { assertCanReadMatter } = await import("@/lib/permissions/index");
const { ActionError } = await import("@/lib/action-error");
const { createArchiveBorrow, decideArchiveBorrow, returnArchiveBorrow } = await import("@/server/archive/borrow");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
// 注意：**不要**给 user/matter/archiveRecord 手写 id ——
// 动作的 zod 入参是 z.string().cuid()，手写的 "m..." / "ar..." 会被判 Invalid cuid。
// 让 Prisma 的 @default(cuid()) 生成。

const as = (u: { id: string; role: string }) => { sessionUser = u; };

async function seedFixture() {
  const owner = await prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name: "主办", role: "LAWYER", passwordHash: "x", active: true }
  });
  const outsider = await prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name: "借阅人", role: "LAWYER", passwordHash: "x", active: true }
  });
  // 审批人用主任律师：ARCHIVE_APPROVE 的内置授权口径覆盖该角色
  const approver = await prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name: "主任", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  const matter = await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "借阅链条案", category: "CIVIL_COMMERCIAL",
      status: "ARCHIVED", serviceStatus: "SERVICE_COMPLETED",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: owner.id, customValues: {}
    }
  });
  // 审批资格来自 DB 规则（ApprovalPermissionRule），不是角色硬编码。
  // 不种规则 → canApproveContext 恒 false → 审批永远被拒。
  await prisma.approvalPermissionGroup.create({
    data: {
      name: uid("借阅审批组"),
      members: { create: [{ userId: approver.id, active: true }] },
      rules: { create: [{ action: "ARCHIVE_APPROVE", caseScope: "ALL_CASES", active: true }] }
    }
  });
  const rec = await prisma.archiveRecord.create({
    data: {
      matterId: matter.id, archiveNo: uid("AR-"),
      summary: "归档摘要", checklistJson: {},
      // 归档人不是主办：否则 canReadDocument 的归档记录分支直接放行主办，
      // 「归档材料需借阅」这条测不出来
      archivedBy: "主任", archivedById: approver.id,
      status: "APPROVED"
    }
  });
  return { owner, outsider, approver, matter, rec };
}

/** 与 seedFixture 相同，但额外建一份材料（材料取阅策略用） */
async function seedFixtureWithDoc() {
  const base = await seedFixture();
  const doc = await prisma.document.create({
    data: {
      matterId: base.matter.id, name: "判决书.pdf", path: `${uid("s")}/p.pdf`,
      category: "OTHER", status: "APPROVED", mimeType: "application/pdf", size: 1024,
      sha256: "a".repeat(64), algorithm: "AES-256-GCM",
      uploadedById: base.approver.id
    }
  });
  return { ...base, doc };
}

beforeEach(async () => {
  vi.clearAllMocks();
  sessionUser = null;
  await prisma.archiveBorrowRequest.deleteMany({});
  await prisma.reminderDelivery.deleteMany({});
});

/**
 * ## ⚠️ 本文件同时记录一个**已发现的缺陷**（2026-11-21）
 *
 * 借阅的两端互斥，导致**合法路径上没人能拿到借阅授权**：
 *
 *   · 申请资格（createArchiveBorrow）用的是 `matterReadVisibilityFilter`
 *     —— 主办 / 团队成员 / 同团队可看全员案件的人。
 *   · 借阅授权的效果只发生在 `assertCanReadMatter` 的 fallback 分支
 *     —— 即「常规可见性不通过」的人。
 *
 * 两条路交集为空：
 *   · 有资格申请的人 → `assertCanReadMatter` 本来就已经通过，借阅没有增量；
 *   · 需要借阅的人   → 在 `createArchiveBorrow` 的可见性检查处就被拒。
 *
 * 而且归档**不会**收回团队/主办可见性（approveArchiveRecord 只写
 * status/archivedAt/closedAt），所以「归档后需要借阅才能看」这个前提不成立。
 *
 * 已有测试为什么没发现：archive-borrow*.test.ts 里审批/归还全是 mock，
 * 只有本文件把「真动作 + 真库 + 真权限判定」串起来跑。
 *
 * ### 交给业主定的两个方向（我不擅自改产品语义）
 *   A) 收紧：归档案件对团队/成员不再按常规可见性放行，借阅成为重新访问的正式通道
 *      —— 最符合「归档=收起来」的直觉，但会改变所有归档案件的现有行为；
 *   B) 放宽：申请资格改用「曾与案件有历史关联」（如历史成员），而当前可见性
 *      —— 改动小，但需要在归档时快照可申请人群。
 * 推荐 A：它让「限时借阅」这套机制自洽，且与审计里「归档是终态」的设定一致。
 */
describe("借阅状态机（真库）", () => {
  it("审批→可读→归还→收回：授权生效与失效都真实发生", async () => {
    const { outsider, approver, matter, rec } = await seedFixture();

    // ① 基线：无借阅单 → 与该案无关的人读不到
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);

    // ② 直接落一条 PENDING 申请（绕过 createArchiveBorrow，理由见文件顶部缺陷说明）
    const pending = await prisma.archiveBorrowRequest.create({
      data: {
        archiveRecordId: rec.id, applicantId: outsider.id, reason: "核对归档材料",
        scope: "WHOLE_VOLUME", status: "PENDING", approverId: null
      }
    });
    expect(pending.status).toBe("PENDING");
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);

    // ③ 审批通过：status→APPROVED、accessUntil 落未来时刻
    as(approver);
    await decideArchiveBorrow({ id: pending.id, revision: pending.revision, decision: "APPROVED", days: 7 });
    const approved = await prisma.archiveBorrowRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.accessUntil).not.toBeNull();
    expect(approved.accessUntil!.getTime()).toBeGreaterThan(Date.now());
    expect(approved.approverId).toBe(approver.id);

    // ④ 权限真的开了 —— 这一步是"借阅"的全部意义，mock 测不出
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).resolves.toBeUndefined();

    // ⑤ 归还：status→RETURNED，且**权限立刻收回**
    as(outsider);
    await returnArchiveBorrow(pending.id);
    const returned = await prisma.archiveBorrowRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(returned.status).toBe("RETURNED");
    expect(returned.returnedAt).not.toBeNull();
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("驳回时不开放权限：status=REJECTED，申请人仍读不到", async () => {
    const { outsider, approver, matter, rec } = await seedFixture();
    const pending = await prisma.archiveBorrowRequest.create({
      data: { archiveRecordId: rec.id, applicantId: outsider.id, reason: "再看一眼卷宗", scope: "WHOLE_VOLUME", status: "PENDING" }
    });

    as(approver);
    await decideArchiveBorrow({
      id: pending.id, revision: pending.revision, decision: "REJECTED", rejectReason: "事由不充分"
    });

    const rejected = await prisma.archiveBorrowRequest.findUniqueOrThrow({ where: { id: pending.id } });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.accessUntil).toBeNull();
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("归还后不可再归还（状态机不倒退），且非借阅人/审批人不能标记归还", async () => {
    const { owner, outsider, approver, rec } = await seedFixture();
    const pending = await prisma.archiveBorrowRequest.create({
      data: { archiveRecordId: rec.id, applicantId: outsider.id, reason: "核对材料", scope: "WHOLE_VOLUME", status: "PENDING" }
    });
    as(approver);
    await decideArchiveBorrow({ id: pending.id, revision: pending.revision, decision: "APPROVED", days: 3 });

    // 第三人（案件主办但不是借阅人/审批人）不能标记归还
    as(owner);
    await expect(returnArchiveBorrow(pending.id)).rejects.toThrow("仅借阅人或审批人可标记归还");

    as(outsider);
    await returnArchiveBorrow(pending.id);
    await expect(returnArchiveBorrow(pending.id)).rejects.toThrow("仅已批准的借阅可标记归还");
  });
});

describe("缺陷已修：借阅链在合法路径上闭环（2026-11-21 修复后）", () => {
  /**
   * 修复前这里的断言是**相反的**（「无可见性的人申请被拒」「有可见性的人无借阅也能读」
   * 两条特征化缺陷）。修法见 src/server/archive/borrow-policy.ts：
   * 归档案件的材料取阅默认要求有效借阅（可配置为 OPEN 回到旧行为）。
   *
   * 这两条现在是**正向**断言——如果有人把策略改回旧口径，它们会红。
   */
  it("对该案无常规可见性的人：仍在申请处被拒（借阅只对本案相关人员开放）", async () => {
    const { outsider, rec } = await seedFixture();
    as(outsider);
    await expect(
      createArchiveBorrow({ archiveRecordId: rec.id, reason: "我要查这份卷宗", scope: "WHOLE_VOLUME" })
    ).rejects.toThrow("仅对该案件具备可见性的成员可申请借阅");
  });

  it("对案件有常规可见性的人：材料取阅已按策略要求借阅（不再是「本来就读得到」）", async () => {
    const { owner, matter, doc } = await seedFixtureWithDoc();
    const { canReadDocument } = await import("@/lib/approvals/documents");
    // 元数据仍可读
    await expect(assertCanReadMatter(owner.id, "LAWYER", matter.id)).resolves.toBeUndefined();
    // 但材料内容默认不可读（需借阅）
    const readable = await canReadDocument(owner.id, {
      id: doc.id, uploadedById: doc.uploadedById, matterId: doc.matterId, intakeId: null, deletedAt: null
    });
    expect(readable).toBe(false);
  });
});
