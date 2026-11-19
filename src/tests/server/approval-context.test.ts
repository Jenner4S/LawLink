// @vitest-environment node
/**
 * `approvalContextFor` 的真库验证（2026-11-21 补，承接 Round 119 的 canApproveContext）。
 *
 * 为什么这个函数比 canApproveContext 更容易悄悄出错：
 *
 * `canApproveContext` 的第 5 层是「申请人不得自审」，判定依据是 **`context.requesterId`**。
 * 而 `requesterId` 完全由 `approvalContextFor` 从六种实体里各取一个字段得来：
 *
 *   INTAKE_APPROVE     Intake.createdById
 *   DOCUMENT_APPROVE   Document.uploadedById
 *   ARCHIVE_APPROVE    ArchiveRecord.archivedById   ← 注意不是 archivedBy（那是名字字符串）
 *   INVOICE_APPROVE    InvoiceRequest.requestedById
 *   SEAL_APPROVE/STAMP SealRequest.requestedById
 *
 * **取错一个字段（比如拿 `archivedBy` 那个名字字符串当 id），
 * `canApproveContext` 的第 5 层就永远不成立 —— 自审批排除静默失效。**
 * 而 canApproveContext 自己的测试是直接传 requesterId 的，覆盖不到这里。
 *
 * 另外 `ARCHIVE_APPROVE` 的 `archivedById` 在 schema 里可空（`archivedBy` 才是
 * NOT NULL 的名字列）。全新数据都写入 id，但若为空则 requesterId 为 null，
 * 第 5 层同样失效。这里锁住「新写入路径给出的是 id」这个事实。
 *
 * 隔离：自建临时库 `lawlink-ctx_test_*` → migrate deploy → DROP。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_ctx_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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
  console.info(`[approval-context] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[approval-context] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

const { approvalContextFor } = await import("@/lib/approvals/service");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser(name: string) {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name, role: "LAWYER", passwordHash: "x", active: true }
  });
}
async function seedMatter(ownerId: string, category: "CIVIL_COMMERCIAL" | "CRIMINAL" = "CIVIL_COMMERCIAL") {
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("LL-"), title: "上下文测试案", category,
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId, customValues: {}
    }
  });
}

beforeEach(async () => {
  // 每个用例独立建数据，避免互相污染（Round 119 踩过的隔离坑）
  await prisma.archiveRecord.deleteMany({});
  await prisma.sealRequest.deleteMany({});
  await prisma.invoiceRequest.deleteMany({});
  await prisma.document.deleteMany({});
  await prisma.intake.deleteMany({});
});

describe("approvalContextFor · 六种 action 的 requesterId 取值（真库）", () => {
  it("INTAKE_APPROVE：requesterId = Intake.createdById", async () => {
    const creator = await seedUser("收案登记人");
    const intake = await prisma.intake.create({
      data: { id: uid("i"), title: "收案", createdById: creator.id, category: "CIVIL_COMMERCIAL" as never }
    });
    const c = await approvalContextFor("INTAKE_APPROVE", intake.id);
    expect(c.requesterId).toBe(creator.id);
    expect(c.category).toBe("CIVIL_COMMERCIAL");
  });

  it("DOCUMENT_APPROVE：requesterId = Document.uploadedById，category 取案件类别", async () => {
    const uploader = await seedUser("上传人");
    const matter = await seedMatter(uploader.id, "CRIMINAL");
    const doc = await prisma.document.create({
      data: {
        id: uid("d"), matterId: matter.id, name: "起诉状.pdf", path: "s/x.pdf",
        mimeType: "application/pdf", size: 10, sha256: "a".repeat(64),
        algorithm: "AES-256-GCM", uploadedById: uploader.id, status: "DRAFT"
      }
    });
    const c = await approvalContextFor("DOCUMENT_APPROVE", doc.id);
    expect(c.requesterId).toBe(uploader.id);
    expect(c.category).toBe("CRIMINAL");
  });

  it("DOCUMENT_APPROVE：挂在收案上时 category 取收案类别（matter 为空）", async () => {
    const uploader = await seedUser("上传人2");
    const creator = await seedUser("收案人2");
    const intake = await prisma.intake.create({
      data: { id: uid("i"), title: "收案2", createdById: creator.id, category: "LABOR_ARBITRATION" as never }
    });
    const doc = await prisma.document.create({
      data: {
        id: uid("d"), intakeId: intake.id, name: "申请书.pdf", path: "s/y.pdf",
        mimeType: "application/pdf", size: 10, sha256: "b".repeat(64),
        algorithm: "AES-256-GCM", uploadedById: uploader.id, status: "DRAFT"
      }
    });
    const c = await approvalContextFor("DOCUMENT_APPROVE", doc.id);
    expect(c.requesterId).toBe(uploader.id);
    expect(c.category).toBe("LABOR_ARBITRATION");
  });

  it("ARCHIVE_APPROVE：requesterId = ArchiveRecord.archivedById（不是 archivedBy 那个名字）", async () => {
    const archivist = await seedUser("归档人");
    const matter = await seedMatter(archivist.id, "CIVIL_COMMERCIAL");
    const rec = await prisma.archiveRecord.create({
      data: {
        id: uid("ar"), matterId: matter.id, archiveNo: uid("AR-"),
        summary: "归档摘要", checklistJson: {}, archivedBy: "归档人的姓名",
        archivedById: archivist.id
      }
    });
    const c = await approvalContextFor("ARCHIVE_APPROVE", rec.id);
    // 关键断言：拿的是 id，不是 archivedBy 里的名字
    expect(c.requesterId).toBe(archivist.id);
    expect(c.requesterId).not.toBe("归档人的姓名");
    expect(c.category).toBe("CIVIL_COMMERCIAL");
  });

  it("INVOICE_APPROVE：requesterId = InvoiceRequest.requestedById", async () => {
    const requester = await seedUser("开票申请人");
    const matter = await seedMatter(requester.id, "CIVIL_COMMERCIAL");
    const inv = await prisma.invoiceRequest.create({
      data: {
        id: uid("ir"), matterId: matter.id, amount: 1000, requestedById: requester.id,
        status: "PENDING"
      }
    });
    const c = await approvalContextFor("INVOICE_APPROVE", inv.id);
    expect(c.requesterId).toBe(requester.id);
    expect(c.category).toBe("CIVIL_COMMERCIAL");
  });

  it("SEAL_APPROVE：requesterId = SealRequest.requestedById，并带 sealType 与 purposeId", async () => {
    const requester = await seedUser("用章申请人");
    const matter = await seedMatter(requester.id, "CIVIL_COMMERCIAL");
    const purpose = await prisma.sealPurposeConfig.create({
      data: { name: uid("用途"), active: true, allowedSealTypes: ["CONTRACT_SEAL"] as never }
    });
    // draftDocId 有外键到 Document（@relation("SealDraft")），必须造真实文档
    const draft = await prisma.document.create({
      data: {
        id: uid("d"), matterId: matter.id, name: "待盖章合同.pdf", path: "s/seal.pdf",
        mimeType: "application/pdf", size: 10, sha256: "c".repeat(64),
        algorithm: "AES-256-GCM", uploadedById: requester.id, status: "DRAFT"
      }
    });
    const seal = await prisma.sealRequest.create({
      data: {
        id: uid("sr"), code: uid("SR-"), sealType: "CONTRACT_SEAL" as never,
        purpose: "合同签署", purposeConfigId: purpose.id,
        documentTitle: "合同", draftDocId: draft.id,
        requestedById: requester.id, matterId: matter.id, status: "PENDING"
      }
    });
    const c = await approvalContextFor("SEAL_APPROVE", seal.id);
    expect(c.requesterId).toBe(requester.id);
    expect(c.category).toBe("CIVIL_COMMERCIAL");
    expect(c.sealType).toBe("CONTRACT_SEAL");
    expect(c.purposeId).toBe(purpose.id);
  });

  it("id 不存在：抛错（findUniqueOrThrow），不静默返回 null 上下文", async () => {
    // 静默返回 null 上下文会让 canApproveContext 的第 5 层失效（requesterId=null → 直接拒，
    // 但若哪天改成「null 表示不限制」就危险了）。抛错是更安全的契约。
    await expect(approvalContextFor("INTAKE_APPROVE", "no-such-id")).rejects.toThrow();
  });
});
