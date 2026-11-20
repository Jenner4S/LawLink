// @vitest-environment node
/**
 * 归档材料取阅策略（真库，2026-11-21）
 *
 * 这是对第八轮之后发现的「借阅链空转」缺陷的**修复验证**：
 *
 * 缺陷：归档不收回团队/主办可见性 → 「案件关系 → 直接下载材料」这条老路
 * 让借阅链空转（借阅授权只对"常规路径不通过"的人生效，而那些人在申请处就被拒）。
 *
 * 修复：归档案件的材料内容取阅，默认要求有效借阅（`REQUIRE_BORROW`），
 * 可通过 SystemSetting 切到 `OPEN` 回到旧行为。
 *
 * 三条边界必须同时成立，缺一条这个修复就是错的：
 *   ① 默认收紧：主办律师对已归档材料**无借阅时不能下载**
 *   ② 借阅打通：同一人申请→审批通过后**能下载**，归还后**又不能**
 *   ③ 不影响元数据：归档案件的详情读取仍按常规可见性放行（否则归档=消失）
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

const { canReadDocument } = await import("@/lib/approvals/documents");
const { assertCanReadMatter } = await import("@/lib/permissions/index");
const { createArchiveBorrow, decideArchiveBorrow, returnArchiveBorrow } = await import("@/server/archive/borrow");
const { getArchiveMaterialPolicy } = await import("@/server/archive/borrow-policy");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const as = (u: { id: string; role: string }) => { sessionUser = u; };

async function seed() {
  const owner = await prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name: "主办", role: "LAWYER", passwordHash: "x", active: true }
  });
  const approver = await prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name: "主任", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  await prisma.approvalPermissionGroup.create({
    data: {
      name: uid("归档审批组"),
      members: { create: [{ userId: approver.id, active: true }] },
      rules: { create: [{ action: "ARCHIVE_APPROVE", caseScope: "ALL_CASES", active: true }] }
    }
  });
  const matter = await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "归档取阅案", category: "CIVIL_COMMERCIAL",
      status: "ARCHIVED", serviceStatus: "SERVICE_COMPLETED",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: owner.id, customValues: {}
    }
  });
  const doc = await prisma.document.create({
    data: {
      matterId: matter.id, name: "判决书.pdf", path: `${uid("s")}/panjue.pdf`,
      category: "OTHER", status: "APPROVED", mimeType: "application/pdf", size: 1024,
      sha256: "a".repeat(64), algorithm: "AES-256-GCM",
      // 上传人也不是主办：canReadDocument 末尾有「上传者 && 非草稿」放行分支，
      // 若主办同时是上传人，测不出「收紧后无借阅不能读」。
      uploadedById: approver.id
    }
  });
  const rec = await prisma.archiveRecord.create({
    data: {
      matterId: matter.id, archiveNo: uid("AR-"), summary: "归档",
      // 归档人**不是**主办：否则 canReadDocument 的归档记录分支会直接放行主办，
      // 测不出「收紧后无借阅不能读」。归档人自己可读是刻意保留的边界（见末例）。
      checklistJson: {}, archivedBy: "主任", archivedById: approver.id, status: "APPROVED"
    }
  });
  return { owner, approver, matter, doc, rec };
}

beforeEach(async () => {
  vi.clearAllMocks();
  sessionUser = null;
  await prisma.systemSetting.deleteMany({});
  await prisma.archiveBorrowRequest.deleteMany({});
  await prisma.reminderDelivery.deleteMany({});
});

describe("归档材料取阅策略", () => {
  it("默认 REQUIRE_BORROW：主办律师对已归档材料无借阅时不能下载", async () => {
    const { owner, doc } = await seed();
    expect(await getArchiveMaterialPolicy()).toBe("REQUIRE_BORROW");
    const readable = await canReadDocument(owner.id, {
      id: doc.id, uploadedById: owner.id, matterId: doc.matterId, intakeId: null, deletedAt: null
    });
    expect(readable).toBe(false);
  });

  it("切到 OPEN：同一份材料恢复可下载（回到 2026-11-21 之前的行为）", async () => {
    const { owner, doc } = await seed();
    await prisma.systemSetting.create({
      data: { key: "archive.materialAccessPolicy", value: { policy: "OPEN" } }
    });
    expect(await getArchiveMaterialPolicy()).toBe("OPEN");
    const readable = await canReadDocument(owner.id, {
      id: doc.id, uploadedById: owner.id, matterId: doc.matterId, intakeId: null, deletedAt: null
    });
    expect(readable).toBe(true);
  });

  it("借阅打通全链：无借阅→不可读；审批通过→可读；归还→又不可读", async () => {
    const { owner, approver, doc, rec } = await seed();

    const args = { id: doc.id, uploadedById: owner.id, matterId: doc.matterId, intakeId: null, deletedAt: null };
    expect(await canReadDocument(owner.id, args)).toBe(false);

    // 主办律师对本案有常规可见性 → 有资格申请
    as(owner);
    const created = await createArchiveBorrow({ archiveRecordId: rec.id, reason: "归档后复核判决书", scope: "WHOLE_VOLUME" });
    const pending = await prisma.archiveBorrowRequest.findUniqueOrThrow({ where: { id: created.id } });
    expect(await canReadDocument(owner.id, args)).toBe(false); // 待审批还没权限

    as(approver);
    await decideArchiveBorrow({ id: pending.id, revision: pending.revision, decision: "APPROVED", days: 5 });
    expect(await canReadDocument(owner.id, args)).toBe(true); // 授权生效

    as(owner);
    await returnArchiveBorrow(pending.id);
    expect(await canReadDocument(owner.id, args)).toBe(false); // 归还即收回
  });

  it("边界：不影响案件元数据读取（否则归档等于消失）", async () => {
    const { owner, matter } = await seed();
    // 归档案件仍可读元数据 —— 策略只作用于材料内容
    await expect(assertCanReadMatter(owner.id, "LAWYER", matter.id)).resolves.toBeUndefined();
  });

  it("边界：归档人仍可打开自己归档的材料（不因收紧把自己锁在外面）", async () => {
    const { approver, doc, rec } = await seed();
    // 归档记录分支：archivedById === userId → 放行。收紧不能把归档人自己锁在外面，
    // 否则「谁归档谁再也看不到」——那样没人愿意做归档这件事。
    const readable = await canReadDocument(approver.id, {
      id: doc.id, uploadedById: approver.id, matterId: doc.matterId, intakeId: null, deletedAt: null
    });
    expect(readable).toBe(true);
    expect(rec.archivedById).toBe(approver.id);
  });
});
