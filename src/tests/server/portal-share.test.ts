// @vitest-environment node
/**
 * 门户披露（S2）：默认不可见 / 显式分享 / 撤销即失效（真库，2026-11-20）
 *
 * 这些用例守的是方案 §二 决策 2 的铁律：
 *   **门户里不存在任何「自动可见」的路径。** 没有 PortalShare 里的行，客户什么都看不到。
 *
 * 每条对应一个真实后果：
 *   · 未分享就能读  → 客户的案卷里出现不该给的材料（可能输掉案子）
 *   · 撤销后仍能读  → 「收回」是假的，律师以为撤了其实没撤
 *   · 别人的分享生效 → 客户的 A 案材料被 B 客户看到（跨客户泄露）
 *   · 重复分享产生两行 → 撤销一条后客户仍能看到，且列表出现重复条目
 *
 * 说明：`assertCanHandleMatter` / `assertMatterWritable` 在本文件中被 mock 放行 ——
 * 它们属于员工权限体系，已由其他测试覆盖；这里专注**披露语义**。
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
/** 真实 staff id：matter.ownerId / document.uploadedById 都是外键，不能用假 id */
const STAFF = { id: "cstaffplaceholder00000001" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "staff@share.local", name: "经办律师", role: "LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "LAWYER" } }))
}));
vi.mock("@/server/audit", () => ({ audit: auditMock, auditTx: vi.fn() }));
vi.mock("@/lib/permissions", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/permissions");
  return { ...actual, assertCanHandleMatter: vi.fn(async () => {}) };
});
vi.mock("@/lib/archive/guard", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/archive/guard");
  return { ...actual, assertMatterWritable: vi.fn(async () => {}) };
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
// portalNotFound 用 next/navigation 的 notFound；测试里换成可捕获的异常
vi.mock("next/navigation", () => ({
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); },
  redirect: (u: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;${u}` }); }
}));

const { shareDocumentToPortal, revokePortalShare, listPortalSharesForMatter, shareMatterSummaryToPortal, shareMatterBillingToPortal } = await import("@/server/portal/share");
const { projectMatterSummary } = await import("@/lib/portal/matter-summary");
const { portalCanReadDocument, assertPortalCanDownload } = await import("@/lib/portal/access");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedClient(name = "委托客户") {
  return prisma.client.create({ data: { id: uid("c"), name, type: "COMPANY" } });
}
async function seedMatter(primaryClientId: string | null) {
  return prisma.matter.create({
    data: {
      id: uid("m"), internalCode: uid("LL-"), title: "披露测试案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, customValues: {},
      ...(primaryClientId ? { primaryClientId } : {})
    }
  });
}
async function seedDoc(matterId: string, name = "起诉状.pdf") {
  return prisma.document.create({
    data: {
      id: uid("d"), name, path: `storage/probe/${uid("f")}.pdf`, size: 100,
      mimeType: "application/pdf", matterId, uploadedById: STAFF.id,
      sha256: uid("h"), encrypted: false
    }
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe("默认不可见", () => {
  it("没分享过 → 读不到，下载抛 notFound（不区分「不存在」与「未分享」）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);

    expect(await portalCanReadDocument(client.id, doc.id)).toBe(false);
    await expect(assertPortalCanDownload(client.id, doc.id)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("材料属于 A 客户，B 客户读不到", async () => {
    const a = await seedClient("A 客户");
    const b = await seedClient("B 客户");
    const matter = await seedMatter(a.id);
    const doc = await seedDoc(matter.id);
    await shareDocumentToPortal({ documentId: doc.id });

    expect(await portalCanReadDocument(a.id, doc.id)).toBe(true);
    expect(await portalCanReadDocument(b.id, doc.id)).toBe(false);
  });
});

describe("显式分享", () => {
  it("分享后客户可读，审计记录材料名与客户", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id, "判决书.pdf");

    const res = await shareDocumentToPortal({ documentId: doc.id });
    expect(res.ok).toBe(true);
    expect(await portalCanReadDocument(client.id, doc.id)).toBe(true);

    const calls = auditMock.mock.calls as unknown as [{ action: string; detail: Record<string, unknown> }][];
    const detail = calls.map((c) => c[0]).find((d) => d.action === "PORTAL_SHARE_CREATE")?.detail;
    expect(detail?.documentName).toBe("判决书.pdf");
    expect(detail?.clientId).toBe(client.id);
  });

  it("重复分享不新增行（否则撤销一条后客户仍能看到）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);

    const first = await shareDocumentToPortal({ documentId: doc.id });
    const second = await shareDocumentToPortal({ documentId: doc.id });
    expect(second.alreadyShared).toBe(true);
    expect(second.shareId).toBe(first.shareId);
    expect(await prisma.portalShare.count({ where: { clientId: client.id, documentId: doc.id } })).toBe(1);
  });

  it("案件没有委托方 → 拒绝（不猜该给谁看）", async () => {
    const matter = await seedMatter(null);
    const doc = await seedDoc(matter.id);
    await expect(shareDocumentToPortal({ documentId: doc.id })).rejects.toThrow("未登记委托方");
  });

  it("收案阶段材料（未挂案件）→ 拒绝", async () => {
    const intake = await prisma.intake.create({
      data: {
        id: uid("i"), title: "某收案", category: "CIVIL_COMMERCIAL", status: "INTAKE",
        createdById: STAFF.id
      }
    });
    const doc = await prisma.document.create({
      data: {
        id: uid("d"), name: "收案材料.pdf", path: `storage/probe/${uid("f")}.pdf`, size: 1,
        mimeType: "application/pdf", intakeId: intake.id, uploadedById: STAFF.id,
        sha256: uid("h"), encrypted: false
      }
    });
    await expect(shareDocumentToPortal({ documentId: doc.id })).rejects.toThrow("收案阶段");
  });
});

describe("撤销即失效", () => {
  it("撤销后客户立即读不到（不等缓存、不重新登录）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);

    const { shareId } = await shareDocumentToPortal({ documentId: doc.id });
    expect(await portalCanReadDocument(client.id, doc.id)).toBe(true);

    await revokePortalShare({ shareId, reason: "含内部批注，误发" });

    expect(await portalCanReadDocument(client.id, doc.id)).toBe(false);
    await expect(assertPortalCanDownload(client.id, doc.id)).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("撤销是软删：行仍在，且记下撤销人与理由（硬删答不了「什么时候撤的」）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);
    const { shareId } = await shareDocumentToPortal({ documentId: doc.id });
    await revokePortalShare({ shareId, reason: "客户不该看策略备忘" });

    const row = await prisma.portalShare.findUniqueOrThrow({ where: { id: shareId } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(STAFF.id);

    const calls = auditMock.mock.calls as unknown as [{ action: string; detail: Record<string, unknown> }][];
    const detail = calls.map((c) => c[0]).find((d) => d.action === "PORTAL_SHARE_REVOKE")?.detail;
    expect(detail?.reason).toBe("客户不该看策略备忘");
  });

  it("撤销后再分享会生成新行（旧的已撤销，不复活）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);

    const first = await shareDocumentToPortal({ documentId: doc.id });
    await revokePortalShare({ shareId: first.shareId });
    const second = await shareDocumentToPortal({ documentId: doc.id });

    expect(second.alreadyShared).toBe(false);
    expect(second.shareId).not.toBe(first.shareId);
    expect(await portalCanReadDocument(client.id, doc.id)).toBe(true);
    expect(await prisma.portalShare.count({ where: { clientId: client.id, documentId: doc.id } })).toBe(2);
  });

  it("重复撤销是幂等的", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);
    const { shareId } = await shareDocumentToPortal({ documentId: doc.id });
    await revokePortalShare({ shareId });
    const again = await revokePortalShare({ shareId });
    expect(again.alreadyRevoked).toBe(true);
  });
});

describe("员工侧清单（撤销的前提：看不到就撤不了）", () => {
  it("列出本案全部分享，生效中在前、已撤销在后，并带材料名", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const d1 = await seedDoc(matter.id, "合同.pdf");
    const d2 = await seedDoc(matter.id, "评估意见.pdf");

    const a = await shareDocumentToPortal({ documentId: d1.id });
    await shareDocumentToPortal({ documentId: d2.id });
    await revokePortalShare({ shareId: a.shareId, reason: "误发" });

    const rows = await listPortalSharesForMatter(matter.id);
    expect(rows).toHaveLength(2);
    // 生效中的排在前（revokedAt asc：null 在前）
    expect(rows[0].revokedAt).toBeNull();
    expect(rows[0].documentName).toBe("评估意见.pdf");
    expect(rows[1].revokedAt).not.toBeNull();
    expect(rows[1].documentName).toBe("合同.pdf");
  });

  it("材料已被删除时清单仍列出该分享，并标注（留痕不能因为材料没了就消失）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id, "将删除.pdf");
    await shareDocumentToPortal({ documentId: doc.id });
    await prisma.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });

    const rows = await listPortalSharesForMatter(matter.id);
    expect(rows).toHaveLength(1);
    // 名字保留（留痕要回答「当时分享过什么」），另给一个标记让面板标注
    expect(rows[0].documentName).toBe("将删除.pdf");
    expect(rows[0].documentDeleted).toBe(true);
  });

  it("别的案件看不到本案的分享（清单按 matterId 隔离）", async () => {
    const client = await seedClient();
    const m1 = await seedMatter(client.id);
    const m2 = await seedMatter(client.id);
    const doc = await seedDoc(m1.id);
    await shareDocumentToPortal({ documentId: doc.id });

    expect(await listPortalSharesForMatter(m1.id)).toHaveLength(1);
    expect(await listPortalSharesForMatter(m2.id)).toHaveLength(0);
  });
});

describe("案件进度摘要（方案 §七 Q1：给阶段名，不给百分比）", () => {
  it("投影只含白名单字段——将来 Matter 加内部字段也不会默认泄露", () => {
    const keys = Object.keys(
      projectMatterSummary({
        id: "m1", internalCode: "LL-1", title: "某案", categoryLabel: "民商事",
        statusLabel: "办理中", stageName: "一审", stageStartedAt: null,
        acceptedAt: null, closedAt: null, leadLawyer: "张律师"
      })
    ).sort();
    expect(keys).toEqual(
      ["acceptedAt", "categoryLabel", "closedAt", "internalCode", "leadLawyer", "matterId", "stageName", "stageStartedAt", "statusLabel", "title"].sort()
    );
    // 明确禁止项
    for (const forbidden of ["progress", "percent", "percentComplete", "narrative", "notes", "amount", "fee", "todos", "documents"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("分享进度摘要后可按 matterId 收起，撤销立即失效", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);

    const res = await shareMatterSummaryToPortal({ matterId: matter.id });
    expect(res.ok).toBe(true);
    const rows = await listPortalSharesForMatter(matter.id);
    expect(rows.filter((r) => r.shareType === "MATTER_SUMMARY")).toHaveLength(1);

    await revokePortalShare({ shareId: res.shareId });
    const after = await listPortalSharesForMatter(matter.id);
    expect(after.filter((r) => r.shareType === "MATTER_SUMMARY" && !r.revokedAt)).toHaveLength(0);
  });

  it("重复分享摘要不新增行", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const a = await shareMatterSummaryToPortal({ matterId: matter.id });
    const b = await shareMatterSummaryToPortal({ matterId: matter.id });
    expect(b.alreadyShared).toBe(true);
    expect(b.shareId).toBe(a.shareId);
  });

  it("摘要与材料清单在同一面板可见（律师要能一处看全客户能看到什么）", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const doc = await seedDoc(matter.id);
    await shareDocumentToPortal({ documentId: doc.id });
    await shareMatterSummaryToPortal({ matterId: matter.id });

    const rows = await listPortalSharesForMatter(matter.id);
    const types = rows.map((r) => r.shareType).sort();
    expect(types).toEqual(["DOCUMENT", "MATTER_SUMMARY"]);
  });
});

describe("账单摘要（方案 §七 Q2：金额必须与财务模块同一数据源）", () => {
  it("门户读取不自己查财务表——只调用财务模块的核心计算（结构性断言）", async () => {
    // 这条是 Q2 的落地守卫：门户若自己 sum 一遍 FeeEntry，两处金额迟早漂移，
    // 客户拿门户截图对账时就是信任崩塌。断言方式：源码里不得出现财务表的直接查询。
    const src = (await import("node:fs")).readFileSync(
      "src/server/portal/portal-reads.ts",
      "utf8"
    );
    for (const forbidden of ["feeEntry.", "billing.", "invoiceRequest.", "invoiceAdjustment."]) {
      expect(src, `portal-reads 不得直接查 ${forbidden}——金额必须走 computeMatterFinanceFacts`).not.toContain(forbidden);
    }
    expect(src).toContain("computeMatterFinanceFacts");
  });

  it("分享账单后可按 matterId 收起，撤销立即失效", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const res = await shareMatterBillingToPortal({ matterId: matter.id });
    expect(res.ok).toBe(true);
    const rows = await listPortalSharesForMatter(matter.id);
    expect(rows.filter((r) => r.shareType === "BILLING" && !r.revokedAt)).toHaveLength(1);

    await revokePortalShare({ shareId: res.shareId });
    const after = await listPortalSharesForMatter(matter.id);
    expect(after.filter((r) => r.shareType === "BILLING" && !r.revokedAt)).toHaveLength(0);
  });

  it("重复分享账单不新增行", async () => {
    const client = await seedClient();
    const matter = await seedMatter(client.id);
    const a = await shareMatterBillingToPortal({ matterId: matter.id });
    const b = await shareMatterBillingToPortal({ matterId: matter.id });
    expect(b.alreadyShared).toBe(true);
    expect(b.shareId).toBe(a.shareId);
  });

  it("无委托方的案件不能开放账单", async () => {
    const matter = await seedMatter(null);
    await expect(shareMatterBillingToPortal({ matterId: matter.id })).rejects.toThrow("未登记委托方");
  });
});
