// @vitest-environment node
/**
 * 归档借阅的「时效判定」真库验证（2026-11-21 补，F-6 的读取路径）。
 *
 * ## 为什么这条路径值得单独测
 *
 * `assertCanReadMatter` 在常规可见性不通过时，会检查「该用户对该案有没有
 * 有效借阅单」——这是**唯一一条绕过常规权限的读取通道**。它的判定是：
 *
 *   applicantId: userId
 *   status: "APPROVED"
 *   accessUntil: { gte: new Date() }
 *   archiveRecord: { status: "APPROVED", matterId }
 *
 * 注释写的是「已批准、未归还、未到期」。这几个条件里任何一个写松，
 * 都会让「借阅到期后仍能读全卷」或「批准一个人、全所都能读」。
 *
 * 两个容易漏的点，这组测试专门守住：
 *
 * 1. **归还判定靠 `status`，不靠 `returnedAt`**：
 *    归还时 status 改成 RETURNED，而条件是 `status: "APPROVED"`，
 *    所以已归还的单子自然不匹配。`returnedAt` 只是留痕字段。
 *    若哪天有人「优化」成只查 `returnedAt IS NULL`，status=RETURNED 但
 *    returnedAt 没写的单子就会漏——本组的「已归还」用例会变红。
 *
 * 2. **`accessUntil` 可空**：Prisma 的 `{ gte: ... }` 不匹配 null，
 *    所以没设到期时间的单子会被拒——这是保守方向，符合「借阅限时可读」。
 *
 * 隔离：自建临时库 `lawlink_borrow_test_*` → migrate deploy → DROP。
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
  console.info(`[archive-borrow-access] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

const { assertCanReadMatter } = await import("@/lib/permissions/index");
const { ActionError } = await import("@/lib/action-error");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 造两个人：owner 是案件主办，outsider 与该案无任何关系 */
async function seedFixture() {
  const owner = await prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name: "主办", role: "LAWYER", passwordHash: "x", active: true }
  });
  const outsider = await prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name: "借阅人", role: "LAWYER", passwordHash: "x", active: true }
  });
  const matter = await prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("LL-"), title: "借阅测试案", category: "CIVIL_COMMERCIAL",
      status: "ARCHIVED", serviceStatus: "SERVICE_COMPLETED",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: owner.id, customValues: {}
    }
  });
  const rec = await prisma.archiveRecord.create({
    data: {
      id: uid("ar"), matterId: matter.id, archiveNo: uid("AR-"),
      summary: "归档摘要", checklistJson: {}, archivedBy: "主办", archivedById: owner.id,
      status: "APPROVED"
    }
  });
  return { owner, outsider, matter, rec };
}

function borrowData(args: {
  recId: string; applicantId: string; approverId: string;
  status?: string; accessUntil?: Date | null; returnedAt?: Date | null;
}) {
  return {
    id: uid("br"), archiveRecordId: args.recId, applicantId: args.applicantId,
    reason: "查阅卷宗", approverId: args.approverId, decidedAt: new Date(),
    status: args.status ?? "APPROVED",
    accessUntil: args.accessUntil === undefined ? new Date(Date.now() + 86_400_000) : args.accessUntil,
    returnedAt: args.returnedAt ?? null
  };
}

beforeEach(async () => {
  await prisma.archiveBorrowRequest.deleteMany({});
  await prisma.archiveRecord.deleteMany({});
});

describe("assertCanReadMatter · 归档借阅的时效判定（真库）", () => {
  it("无借阅单：与该案无关的人被拒（基线）", async () => {
    const { outsider, matter } = await seedFixture();
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("有效借阅（APPROVED + 未到期）：放行", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    await prisma.archiveBorrowRequest.create({
      data: borrowData({ recId: rec.id, applicantId: outsider.id, approverId: owner.id })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).resolves.toBeUndefined();
  });

  it("已到期（accessUntil 在过去）：拒绝 —— 到期即失效，不靠隐藏入口", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    await prisma.archiveBorrowRequest.create({
      data: borrowData({
        recId: rec.id, applicantId: outsider.id, approverId: owner.id,
        accessUntil: new Date(Date.now() - 1000) // 一秒前过期
      })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("accessUntil 为空：拒绝（Prisma 的 gte 不匹配 null，保守方向）", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    await prisma.archiveBorrowRequest.create({
      data: borrowData({ recId: rec.id, applicantId: outsider.id, approverId: owner.id, accessUntil: null })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("已归还（status=RETURNED）：拒绝 —— 归还判定靠 status，不靠 returnedAt", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    await prisma.archiveBorrowRequest.create({
      data: borrowData({
        recId: rec.id, applicantId: outsider.id, approverId: owner.id,
        status: "RETURNED", returnedAt: new Date()
      })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("已归还但 returnedAt 为空（status 才是权威）：仍拒绝", async () => {
    // 这条专门守「改成只查 returnedAt IS NULL」的退化：
    // 若有人把条件换成 returnedAt: null，这种「status=RETURNED 但 returnedAt 没写」的单子就会漏。
    const { owner, outsider, matter, rec } = await seedFixture();
    await prisma.archiveBorrowRequest.create({
      data: borrowData({
        recId: rec.id, applicantId: outsider.id, approverId: owner.id,
        status: "RETURNED", returnedAt: null
      })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("尚未批准（PENDING / REJECTED）：拒绝", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    for (const status of ["PENDING", "REJECTED"]) {
      await prisma.archiveBorrowRequest.deleteMany({});
      await prisma.archiveBorrowRequest.create({
        data: borrowData({ recId: rec.id, applicantId: outsider.id, approverId: owner.id, status })
      });
      await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
    }
  });

  it("别人的借阅单不生效（applicantId 必须是自己）", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    const third = await prisma.user.create({
      data: { id: uid("u"), email: `${uid("e")}@t.local`, name: "第三人", role: "LAWYER", passwordHash: "x", active: true }
    });
    // 借阅单批给了 third，outsider 没有
    await prisma.archiveBorrowRequest.create({
      data: borrowData({ recId: rec.id, applicantId: third.id, approverId: owner.id })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
    // 被批准的人可以
    await expect(assertCanReadMatter(third.id, "LAWYER", matter.id)).resolves.toBeUndefined();
  });

  it("归档记录未批准时，借阅单不生效", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    await prisma.archiveRecord.update({ where: { id: rec.id }, data: { status: "PENDING_REVIEW" } });
    await prisma.archiveBorrowRequest.create({
      data: borrowData({ recId: rec.id, applicantId: outsider.id, approverId: owner.id })
    });
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).rejects.toBeInstanceOf(ActionError);
  });

  it("借阅单只对它所指向的案件生效，不波及其他案件", async () => {
    const { owner, outsider, matter, rec } = await seedFixture();
    const other = await prisma.matter.create({
      data: {
        id: uid("m"), internalCode: uid("LL-"), title: "另一案", category: "CIVIL_COMMERCIAL",
        status: "ARCHIVED", serviceStatus: "SERVICE_COMPLETED",
        teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
        ownerId: owner.id, customValues: {}
      }
    });
    await prisma.archiveBorrowRequest.create({
      data: borrowData({ recId: rec.id, applicantId: outsider.id, approverId: owner.id })
    });
    // 原案可读
    await expect(assertCanReadMatter(outsider.id, "LAWYER", matter.id)).resolves.toBeUndefined();
    // 另一案仍不可读
    await expect(assertCanReadMatter(outsider.id, "LAWYER", other.id)).rejects.toBeInstanceOf(ActionError);
  });
});
