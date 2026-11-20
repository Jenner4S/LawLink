// @vitest-environment node
/**
 * 卷宗归档完整性校验（src/server/archive/verification.ts）——此前零覆盖。
 *
 * 为什么用真库：这一组函数的全部价值都在「快照基线与真实文件字节」的比对关系上——
 * 快照哈希取自解密后的原件（`document.sha256` 登记值也是原件哈希，见 documents/actions.ts
 * 上传口径），校验时又要回读存储、解密、重新哈希，再与 checklistJson 里冻结的快照逐份比对。
 * mock 掉 SQL 或 mock 掉 `sha256()`，就等于「断言我调用了某个函数」，改动的检测准不准完全测不出。
 *
 * 隔离：
 *   - 本文件自建临时库 `lawlink_arch_verify_test_*`（lawlink-db:55432），只跑
 *     `prisma migrate deploy` 建结构，运行结束 `DROP DATABASE ... WITH (FORCE)`。
 *     **绝不写主库 lawlink。**
 *   - `@/lib/prisma` 用 Proxy 转发到本文件的临时库 client（模块级单例在 import 期就绑定
 *     DATABASE_URL，不能靠 beforeAll 改环境变量）。
 *   - `@/lib/storage` 换成「真磁盘、根目录为系统临时目录」的 shim：存储根在生产里也是
 *     模块级常量，替换后仍走真实 fs 读写与真实路径语义（缺失文件同样抛 ENOENT）。
 *     **加解密与哈希不作任何 mock**，走真实 AES-256-GCM 与 node:crypto。
 *
 * 前置条件：lawlink-db 容器可用（docker compose 的 55432 端口）。
 */
import { promises as fsp, rmSync } from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

// ---------------------------------------------------------------------------
// 测试库持有者：Proxy 让被测模块的 `prisma` 始终指向本次临时库
// ---------------------------------------------------------------------------

const holder = vi.hoisted(() => ({ db: null as unknown as PrismaClient }));

vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get(_target, prop) {
        if (!holder.db) throw new Error("测试库尚未初始化（beforeAll 未完成）");
        const value = (holder.db as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(holder.db)
          : value;
      }
    }
  )
}));

// 真磁盘存储 shim：根目录建在系统临时目录，语义对齐 LocalStorageProvider（含防穿越）
vi.mock("@/lib/storage", async () => {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const os = await import("node:os");
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "lawlink-arch-verify-"));
  const resolve = (rel: string) => {
    const full = nodePath.resolve(root, rel);
    if (!full.startsWith(root)) throw new Error("非法路径");
    return full;
  };
  return {
    __storageRoot: root,
    storage: {
      readFile: (rel: string) => fs.readFile(resolve(rel)),
      writeFile: async (scope: string, data: Buffer) => {
        const rel = nodePath.posix.join(scope, `${Date.now()}${Math.random().toString(36).slice(2, 8)}.bin`);
        await fs.mkdir(nodePath.dirname(resolve(rel)), { recursive: true });
        await fs.writeFile(resolve(rel), data);
        return rel;
      },
      deleteFile: async (rel: string) => {
        await fs.rm(resolve(rel), { force: true });
      }
    }
  };
});

import { encryptBuffer, sha256 } from "@/lib/storage/crypto";
import {
  ARCHIVE_SNAPSHOT_VERSION,
  parseArchiveSnapshot,
  type ArchiveDocumentSnapshot,
  type ArchiveReviewSnapshot
} from "@/lib/archive/snapshot";
import {
  assertDocumentNotInPendingArchive,
  createArchiveDocumentSnapshots,
  readArchiveDocument,
  verifyArchivePolicySource,
  verifyArchiveSnapshotDocuments
} from "@/server/archive/verification";

const DB_NAME = `lawlink_arch_verify_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

let db: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
let storageRoot: string;

beforeAll(async () => {
  // 加解密需要密钥；.env 通常已注入，缺失时给一个固定 32 字节测试密钥
  if (!process.env.STORAGE_ENCRYPTION_KEY) {
    process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  }
  storageRoot = (await import("@/lib/storage") as unknown as { __storageRoot: string }).__storageRoot;

  // 建库 + 迁移统一交给 helper（退避重试 + 强制清理，见 src/tests/helpers/temp-db.ts）
  const temp = await createTempDatabase(DB_NAME);
  dropDb = temp.drop;
  db = temp.prisma;
  holder.db = db;
  console.info(`[archive-verification] 临时库：${DB_NAME}`);
}, 240_000);

afterAll(async () => {
  await db?.$disconnect();
  await dropDb?.();
  if (storageRoot) rmSync(storageRoot, { recursive: true, force: true });
}, 60_000);

// ---------------------------------------------------------------------------
// 夹具：id 必须满足快照 schema 的 `z.string().cuid()`（c + 8 位以上无空格横线）
// ---------------------------------------------------------------------------

let seq = 0;
const cuid = (prefix: string) => {
  seq += 1;
  const tail = `${Date.now().toString(36)}${seq.toString(36)}`.replace(/[^a-z0-9]/g, "");
  return `c${prefix}${tail}`;
};
const asBuffer = (content: Buffer | string) => (Buffer.isBuffer(content) ? content : Buffer.from(content));

async function putFile(rel: string, data: Buffer) {
  const full = path.join(storageRoot, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, data);
  return rel;
}

const seedUser = (role: "LAWYER" | "PRINCIPAL_LAWYER" | "FINANCE" = "LAWYER") =>
  db.user.create({
    data: { id: cuid("u"), name: "归档测试律师", email: `${cuid("mail")}@example.test`, passwordHash: "x", role }
  });

const seedMatter = (ownerId: string, title = "归档校验案件") =>
  db.matter.create({ data: { id: cuid("m"), internalCode: cuid("MS"), title, ownerId } });

const seedFolder = (matterId: string, name: string) =>
  db.documentFolder.create({ data: { id: cuid("fd"), matterId, name } });

/** 生成一份材料：写入真实文件 + 落 Document 行（sha256 登记的是「原件」哈希，与上传口径一致） */
async function seedDocument(input: {
  matterId: string | null;
  uploadedById: string;
  name: string;
  content: Buffer | string;
  category?: "EVIDENCE" | "PLEADING" | "PROCEDURE" | "JUDGMENT" | "CONTRACT" | "OTHER";
  encrypted?: boolean;
  folderId?: string | null;
  /** undefined = 登记原件哈希；null = 不登记；字符串 = 指定一个（可能不正确的）登记值 */
  registerSha256?: string | null;
  status?: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "FILED";
  storePath?: string;
}) {
  const plain = asBuffer(input.content);
  const scope = input.matterId ? `m_${input.matterId}` : "i_intake";
  const rel = input.storePath ?? path.posix.join(scope, `${cuid("f")}.bin`);
  const iv = input.encrypted ? encryptBuffer(plain) : null;
  await putFile(rel, iv ? iv.ciphertext : plain);
  return db.document.create({
    data: {
      id: cuid("d"),
      matterId: input.matterId,
      uploadedById: input.uploadedById,
      name: input.name,
      category: input.category ?? "EVIDENCE",
      status: input.status ?? "FILED",
      path: rel,
      mimeType: "application/pdf",
      size: plain.byteLength,
      sha256: input.registerSha256 === undefined ? sha256(plain) : input.registerSha256,
      encrypted: Boolean(input.encrypted),
      algorithm: iv ? iv.algorithm : null,
      iv: iv ? iv.iv.toString("base64") : null,
      authTag: iv ? iv.authTag.toString("base64") : null,
      folderId: input.folderId ?? null
    }
  });
}

async function seedPolicyFile(ownerId: string, content: Buffer | string, name = "归档制度2026.pdf") {
  const buf = asBuffer(content);
  const rel = path.posix.join(`firm_${cuid("pf")}`, `${cuid("f")}.bin`);
  await putFile(rel, buf);
  return db.firmFile.create({
    data: {
      id: cuid("ff"),
      name,
      category: "POLICY",
      path: rel,
      mimeType: "application/pdf",
      size: buf.byteLength,
      sha256: sha256(buf),
      uploadedById: ownerId
    }
  });
}

/** 把一行 Document 转成快照里的单份材料记录（生产由 createArchiveDocumentSnapshots 生成） */
function docSnapshotOf(
  doc: {
    id: string; name: string; category: string; status: string; version: number; isLatest: boolean;
    mimeType: string | null; sha256: string | null;
  },
  order: number,
  overrides: Partial<ArchiveDocumentSnapshot> = {}
): ArchiveDocumentSnapshot {
  return {
    id: doc.id,
    name: doc.name,
    category: doc.category,
    workflowStatus: doc.status,
    version: doc.version,
    isLatest: doc.isLatest,
    folderName: null,
    mimeType: doc.mimeType,
    size: 0,
    sha256: doc.sha256 ?? "",
    checklistItemIds: [],
    order,
    ...overrides
  };
}

/** 经生产 schema 校验过的 v2 快照（避免手写夹具与真实结构漂移） */
function makeSnapshot(input: {
  policyFileId: string;
  policySha256: string;
  documents: ArchiveDocumentSnapshot[];
  documentIds?: string[];
}): ArchiveReviewSnapshot {
  const raw = {
    schemaVersion: ARCHIVE_SNAPSHOT_VERSION,
    policy: {
      configured: true as const,
      name: "卷宗归档制度",
      version: "2026.1",
      effectiveAt: "2026-01-01",
      sourceFileId: input.policyFileId,
      sourceFileName: "归档制度2026.pdf",
      sourceFileSha256: input.policySha256
    },
    checklist: {
      kind: "CIVIL_COMMERCIAL",
      title: "民事卷宗目录",
      items: [
        {
          id: "archive_cover",
          label: "卷宗封皮",
          required: true,
          autoGenerated: true,
          status: "AUTO_GENERATED" as const,
          note: "系统按本次送审材料生成",
          documentIds: input.documents.slice(0, 1).map((d) => d.id)
        }
      ]
    },
    manualChecks: [],
    documents: input.documents,
    excludedDocuments: [],
    documentIds: input.documentIds ?? input.documents.map((d) => d.id),
    submittedAt: new Date("2026-11-01T10:00:00.000Z").toISOString(),
    previousRecordId: null
  };
  const parsed = parseArchiveSnapshot(raw);
  if (!parsed) throw new Error(`测试快照不符合生产 schema：${JSON.stringify(raw).slice(0, 300)}`);
  return parsed;
}

async function seedArchiveRecord(
  matterId: string,
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED",
  checklistJson: unknown,
  archiveNo = `AR-${cuid("no")}`
) {
  return db.archiveRecord.create({
    data: {
      id: cuid("ar"),
      matterId,
      archiveNo,
      summary: "本案已结案，材料齐备。",
      checklistJson: checklistJson as Prisma.InputJsonValue,
      missingItems: [],
      archivedBy: "归档测试律师",
      status
    }
  });
}

/** 捕获错误并断言「确实抛了」 */
async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (err) {
    return err as Error;
  }
  throw new Error("期望调用被拒绝，但实际成功了");
}

// ---------------------------------------------------------------------------
// 1. createArchiveDocumentSnapshots
// ---------------------------------------------------------------------------

describe("createArchiveDocumentSnapshots", () => {
  it("快照哈希 = 源文件字节的 sha256，size 取原件长度，order 按送审顺序，checklistItemIds 来自映射表", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const folder = await seedFolder(matter.id, "起诉材料");
    const a = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "起诉状.pdf", content: "原告：甲\n被告：乙", folderId: folder.id });
    const b = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "合同.pdf", content: "第一条 委托事项", category: "CONTRACT" });

    const snapshots = await createArchiveDocumentSnapshots({
      matterId: matter.id,
      orderedDocumentIds: [b.id, a.id],
      itemIdsByDocumentId: new Map([[a.id, ["evidence", "originals_handled"]]])
    });

    expect(snapshots).toHaveLength(2);
    const [first, second] = snapshots;
    // 顺序即送审顺序（封皮/目录靠 order 排）
    expect(first.id).toBe(b.id);
    expect(first.order).toBe(1);
    expect(second.id).toBe(a.id);
    expect(second.order).toBe(2);
    // 哈希与长度都取自原件字节
    expect(first.sha256).toBe(sha256(Buffer.from("第一条 委托事项")));
    expect(first.size).toBe(Buffer.byteLength("第一条 委托事项"));
    expect(second.sha256).toBe(sha256(Buffer.from("原告：甲\n被告：乙")));
    expect(first.sha256).not.toBe(second.sha256);
    // 元数据取自数据库行
    expect(second.folderName).toBe("起诉材料");
    expect(first.category).toBe("CONTRACT");
    expect(first.workflowStatus).toBe("FILED");
    expect(first.version).toBe(1);
    expect(first.isLatest).toBe(true);
    expect(first.mimeType).toBe("application/pdf");
    // 清单项映射：有映射取映射，无映射给空数组
    expect(second.checklistItemIds).toEqual(["evidence", "originals_handled"]);
    expect(first.checklistItemIds).toEqual([]);
  });

  it("加密材料：快照哈希是明文哈希（与上传登记口径一致），不是密文哈希", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const plain = Buffer.from("加密保全申请书：请求查封被申请人名下房产");
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "保全申请.pdf", content: plain, encrypted: true });
    const ciphertext = await fsp.readFile(path.join(storageRoot, doc.path));

    const [snapshot] = await createArchiveDocumentSnapshots({
      matterId: matter.id,
      orderedDocumentIds: [doc.id],
      itemIdsByDocumentId: new Map()
    });

    expect(snapshot.sha256).toBe(sha256(plain));
    expect(snapshot.sha256).not.toBe(sha256(ciphertext));
    expect(snapshot.size).toBe(plain.byteLength);
  });

  it("重复调用幂等：两次结果完全相同，且不写任何表（Document 未被改动）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const a = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "证据1.pdf", content: "证据一" });
    const b = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "证据2.pdf", content: "证据二" });
    const before = await db.document.findMany({ where: { matterId: matter.id }, orderBy: { id: "asc" } });

    const input = { matterId: matter.id, orderedDocumentIds: [a.id, b.id], itemIdsByDocumentId: new Map([[a.id, ["evidence"]]]) };
    const first = await createArchiveDocumentSnapshots(input);
    const second = await createArchiveDocumentSnapshots(input);

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect((await db.document.count({ where: { matterId: matter.id } }))).toBe(before.length);
    const after = await db.document.findMany({ where: { matterId: matter.id }, orderBy: { id: "asc" } });
    expect(after.map((d) => d.updatedAt.getTime())).toEqual(before.map((d) => d.updatedAt.getTime()));
  });

  it("重复 id 去重后只出现一次，order 连续", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const a = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "重复.pdf", content: "同一份" });
    const snapshots = await createArchiveDocumentSnapshots({
      matterId: matter.id,
      orderedDocumentIds: [a.id, a.id, a.id],
      itemIdsByDocumentId: new Map()
    });
    expect(snapshots.map((s) => [s.id, s.order])).toEqual([[a.id, 1]]);
  });

  it("空材料列表直接返回空数组（不查库、不报错）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    await expect(
      createArchiveDocumentSnapshots({ matterId: matter.id, orderedDocumentIds: [], itemIdsByDocumentId: new Map() })
    ).resolves.toEqual([]);
  });

  it("跨案材料 → 拒绝（防止把别案材料塞进本案卷宗）", async () => {
    const user = await seedUser();
    const matterA = await seedMatter(user.id, "本案");
    const matterB = await seedMatter(user.id, "他案");
    const mine = await seedDocument({ matterId: matterA.id, uploadedById: user.id, name: "本案证据.pdf", content: "本案" });
    const other = await seedDocument({ matterId: matterB.id, uploadedById: user.id, name: "他案证据.pdf", content: "他案" });

    const err = await captureError(() =>
      createArchiveDocumentSnapshots({
        matterId: matterA.id,
        orderedDocumentIds: [mine.id, other.id],
        itemIdsByDocumentId: new Map()
      })
    );
    expect(err.name).toBe("ActionError");
    expect(err.message).toBe("部分归档材料不存在、已删除或不属于本案");
  });

  it("软删材料 → 拒绝", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "已删材料.pdf", content: "x" });
    await db.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });

    const err = await captureError(() =>
      createArchiveDocumentSnapshots({ matterId: matter.id, orderedDocumentIds: [doc.id], itemIdsByDocumentId: new Map() })
    );
    expect(err.message).toBe("部分归档材料不存在、已删除或不属于本案");
  });

  it("文件内容与登记校验值不一致 → 拒绝并点名该材料（归档前第一道防线）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const good = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "正常材料.pdf", content: "正常内容" });
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "被替换的材料.pdf", content: "原始内容" });
    // 绕过应用直接覆写磁盘（模拟磁盘损坏/外部替换）
    await putFile(doc.path, Buffer.from("被篡改后的内容"));

    const err = await captureError(() =>
      createArchiveDocumentSnapshots({
        matterId: matter.id,
        orderedDocumentIds: [good.id, doc.id],
        itemIdsByDocumentId: new Map()
      })
    );
    expect(err.name).toBe("ActionError");
    expect(err.message).toBe("材料“被替换的材料.pdf”的内容与登记校验值不一致");
  });

  it("未登记 sha256 的历史材料不因缺登记值被拒（只按实际内容生成快照）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({
      matterId: matter.id, uploadedById: user.id, name: "历史材料.pdf", content: "历史内容", registerSha256: null
    });
    const [snapshot] = await createArchiveDocumentSnapshots({
      matterId: matter.id, orderedDocumentIds: [doc.id], itemIdsByDocumentId: new Map()
    });
    expect(snapshot.sha256).toBe(sha256(Buffer.from("历史内容")));
  });
});

// ---------------------------------------------------------------------------
// 2. verifyArchiveSnapshotDocuments
// ---------------------------------------------------------------------------

describe("verifyArchiveSnapshotDocuments", () => {
  it("全部一致 → 通过，返回可按 id 取用的行与原件字节", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const a = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "判决书.pdf", content: "判决如下", category: "JUDGMENT" });
    const b = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "委托合同.pdf", content: "委托合同正文", encrypted: true });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [
        docSnapshotOf(a, 1, { sha256: sha256(Buffer.from("判决如下")), size: Buffer.byteLength("判决如下") }),
        docSnapshotOf(b, 2, { sha256: sha256(Buffer.from("委托合同正文")), size: Buffer.byteLength("委托合同正文") })
      ]
    });

    const verified = await verifyArchiveSnapshotDocuments(snapshot, matter.id);

    expect([...verified.documents.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(verified.buffers.get(a.id)!.toString()).toBe("判决如下");
    // 加密材料返回解密后原件（归档包必须能还原律师交付的内容）
    expect(verified.buffers.get(b.id)!.toString()).toBe("委托合同正文");
  });

  it("源文件被改动（登记值未同步）→ 拒绝，并指出是哪一份", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const intact = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "未动材料.pdf", content: "未动" });
    const changed = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "被改的材料.pdf", content: "送审时的内容" });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [
        docSnapshotOf(intact, 1, { sha256: sha256(Buffer.from("未动")), size: Buffer.byteLength("未动") }),
        docSnapshotOf(changed, 2, { sha256: sha256(Buffer.from("送审时的内容")), size: Buffer.byteLength("送审时的内容") })
      ]
    });
    await putFile(changed.path, Buffer.from("审批期间被改成了别的内容"));

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    expect(err.name).toBe("ActionError");
    expect(err.message).toBe("送审材料“被改的材料.pdf”内容已变化，请退回补正");
    // 只点名被改的那一份
    expect(err.message).not.toContain("未动材料.pdf");
  });

  it("源文件被替换且数据库登记哈希同步更新 → 仍然拒绝（比对基线是快照，不是登记值）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "重新上传的材料.pdf", content: "第一版" });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [docSnapshotOf(doc, 1, { sha256: sha256(Buffer.from("第一版")), size: Buffer.byteLength("第一版") })]
    });
    // 模拟「删旧传新」之外的最坏情况：原地覆写并把登记值一起改掉
    const replaced = Buffer.from("第二版");
    await putFile(doc.path, replaced);
    await db.document.update({ where: { id: doc.id }, data: { sha256: sha256(replaced), size: replaced.byteLength } });

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    expect(err.message).toBe("送审材料“重新上传的材料.pdf”内容已变化，请退回补正");
  });

  it("同长度不同内容也能识别（不是只比 size）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const original = Buffer.from("AAAA-1111");
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "等长替换.pdf", content: original });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [docSnapshotOf(doc, 1, { sha256: sha256(original), size: original.byteLength })]
    });
    const sameLength = Buffer.from("AAAA-2222");
    expect(sameLength.byteLength).toBe(original.byteLength);
    await putFile(doc.path, sameLength);

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    expect(err.message).toContain("内容已变化");
  });

  it("送审材料被软删 → 拒绝并提示退回补正", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "将被删除的材料.pdf", content: "内容" });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [docSnapshotOf(doc, 1, { sha256: sha256(Buffer.from("内容")), size: Buffer.byteLength("内容") })]
    });
    await db.document.update({ where: { id: doc.id }, data: { deletedAt: new Date() } });

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    expect(err.message).toBe("送审材料已缺失、删除或不再属于本案，请退回补正");
  });

  it("材料被移出本案（matterId 变更）→ 拒绝", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id, "原案");
    const other = await seedMatter(user.id, "移入案");
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "被移走的材料.pdf", content: "内容" });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [docSnapshotOf(doc, 1, { sha256: sha256(Buffer.from("内容")), size: Buffer.byteLength("内容") })]
    });
    await db.document.update({ where: { id: doc.id }, data: { matterId: other.id } });

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    expect(err.message).toBe("送审材料已缺失、删除或不再属于本案，请退回补正");
  });

  it("快照结构与 documentIds 不一致 → 拒绝（快照本身损坏）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const a = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "A.pdf", content: "A" });
    const b = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "B.pdf", content: "B" });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [docSnapshotOf(a, 1, { sha256: sha256(Buffer.from("A")), size: 1 })],
      documentIds: [a.id, b.id] // documentIds 有两份，documents 只有一份
    });

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    expect(err.name).toBe("ActionError");
    expect(err.message).toBe("归档材料快照结构不完整，请退回补正");
  });

  it("加密材料密文被篡改 → 抛 ActionError 并给出中文可行动文案（2026-11-19 已修 D3）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const plain = Buffer.from("加密的起诉状正文");
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "加密起诉状.pdf", content: plain, encrypted: true });
    const snapshot = makeSnapshot({
      policyFileId: cuid("ff"),
      policySha256: "policy",
      documents: [docSnapshotOf(doc, 1, { sha256: sha256(plain), size: plain.byteLength })]
    });
    const ciphertext = Buffer.from(await fsp.readFile(path.join(storageRoot, doc.path)));
    ciphertext[0] = ciphertext[0] ^ 0xff;
    await putFile(doc.path, ciphertext);

    const err = await captureError(() => verifyArchiveSnapshotDocuments(snapshot, matter.id));
    // 修复前：抛原生 Error（GCM 认证失败），Flight 脱敏后审批人只看到
    // "Minified React error #441"。现在统一转 ActionError，文案指出损坏/密钥更换。
    expect(err.name).toBe("ActionError");
    expect(String(err.message)).toMatch(/解密失败.*内容可能已损坏或加密密钥已更换/);
    // digest 通道：生产脱敏下客户端能看到的正是这条
    expect((err as { digest?: string }).digest).toMatch(/^ACTION_ERROR:/);
  });
});

// ---------------------------------------------------------------------------
// 3. verifyArchivePolicySource
// ---------------------------------------------------------------------------

describe("verifyArchivePolicySource", () => {
  it("制度原文与快照一致 → 通过（无返回值）", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "第一条 归档范围……");
    const snapshot = makeSnapshot({
      policyFileId: policy.id,
      policySha256: sha256(Buffer.from("第一条 归档范围……")),
      documents: []
    });
    await expect(verifyArchivePolicySource(snapshot)).resolves.toBeUndefined();
  });

  it("制度原文已不存在 → 拒绝", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "制度原文");
    const snapshot = makeSnapshot({ policyFileId: policy.id, policySha256: sha256(Buffer.from("制度原文")), documents: [] });
    await db.firmFile.delete({ where: { id: policy.id } });

    const err = await captureError(() => verifyArchivePolicySource(snapshot));
    expect(err.name).toBe("ActionError");
    expect(err.message).toBe("送审所依据的归档制度原文已不存在，请退回补正");
  });

  it("制度原文内容被替换 → 拒绝（依据已非送审时那一版）", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "旧版制度正文");
    const snapshot = makeSnapshot({ policyFileId: policy.id, policySha256: sha256(Buffer.from("旧版制度正文")), documents: [] });
    // 同一条记录指向新内容（例如上传时被覆盖）
    const newBody = Buffer.from("新版制度正文：归档范围扩大至电子证据");
    await putFile(policy.path, newBody);
    await db.firmFile.update({ where: { id: policy.id }, data: { sha256: sha256(newBody), size: newBody.byteLength } });

    const err = await captureError(() => verifyArchivePolicySource(snapshot));
    expect(err.message).toBe("归档制度原文内容已变化，请退回补正并重新提交");
  });

  it("快照记录的制度哈希与文件不符（快照基线被改）→ 拒绝", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "制度正文");
    const snapshot = makeSnapshot({ policyFileId: policy.id, policySha256: sha256(Buffer.from("另一版制度正文")), documents: [] });

    const err = await captureError(() => verifyArchivePolicySource(snapshot));
    expect(err.message).toBe("归档制度原文内容已变化，请退回补正并重新提交");
  });

  it("数据库登记哈希与文件内容不符（双源交叉校验）→ 拒绝", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "制度正文");
    await db.firmFile.update({ where: { id: policy.id }, data: { sha256: sha256(Buffer.from("错误的登记值")) } });
    const snapshot = makeSnapshot({ policyFileId: policy.id, policySha256: sha256(Buffer.from("制度正文")), documents: [] });

    const err = await captureError(() => verifyArchivePolicySource(snapshot));
    expect(err.message).toBe("归档制度原文内容已变化，请退回补正并重新提交");
  });

  it("制度原文已作废（archivedAt 非空）但内容未变 → 仍通过（缺陷 D2：作废/被新版替代不被拦截）", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "制度正文");
    const snapshot = makeSnapshot({ policyFileId: policy.id, policySha256: sha256(Buffer.from("制度正文")), documents: [] });
    await db.firmFile.update({ where: { id: policy.id }, data: { archivedAt: new Date("2026-10-01T00:00:00Z") } });

    await expect(verifyArchivePolicySource(snapshot)).resolves.toBeUndefined();
  });

  it("记录在册但磁盘文件缺失 → 拒绝（当前抛 ENOENT 原生错误，见报告 D3）", async () => {
    const user = await seedUser();
    const policy = await seedPolicyFile(user.id, "制度正文");
    const snapshot = makeSnapshot({ policyFileId: policy.id, policySha256: sha256(Buffer.from("制度正文")), documents: [] });
    rmSync(path.join(storageRoot, policy.path), { force: true });

    const err = await captureError(() => verifyArchivePolicySource(snapshot));
    // 说明：verifyArchivePolicySource 读制度文件走的是 policy 模块自己的读取路径，
    // 本轮未纳入统一转义（见报告「未覆盖」），故此处仍是原生 Error。
    // 若后续把该路径也接入 readDecryptedBlob，本断言应改为 ActionError。
    expect(String(err.message)).toMatch(/ENOENT|读取失败/);
  });
});

// ---------------------------------------------------------------------------
// 4. assertDocumentNotInPendingArchive
// ---------------------------------------------------------------------------

describe("assertDocumentNotInPendingArchive", () => {
  it("文档被待审归档引用 → 拒绝，并给出归档号（防止审批期间材料被删改）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "待审卷宗材料.pdf", content: "内容" });
    const archived = await seedArchiveRecord(
      matter.id,
      "PENDING_REVIEW",
      makeSnapshot({
        policyFileId: cuid("ff"),
        policySha256: "policy",
        documents: [docSnapshotOf(doc, 1, { sha256: sha256(Buffer.from("内容")), size: Buffer.byteLength("内容") })]
      }),
      "AR-2026-0007"
    );

    const err = await captureError(() => assertDocumentNotInPendingArchive(doc.id));
    expect(err.name).toBe("ActionError");
    expect(err.message).toBe(`该材料已列入待审归档申请 ${archived.archiveNo}，请先驳回或处理该申请`);
  });

  it("无任何归档引用 → 通过", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const free = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "自由材料.pdf", content: "内容" });
    const other = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "已归档材料.pdf", content: "内容" });
    await seedArchiveRecord(
      matter.id,
      "PENDING_REVIEW",
      makeSnapshot({
        policyFileId: cuid("ff"),
        policySha256: "policy",
        documents: [docSnapshotOf(other, 1, { sha256: sha256(Buffer.from("内容")), size: Buffer.byteLength("内容") })]
      })
    );

    await expect(assertDocumentNotInPendingArchive(free.id)).resolves.toBeUndefined();
  });

  it("只被已批准归档引用 → 通过（冻结件不再阻止，案件本身已按归档态锁定）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "已归档材料.pdf", content: "内容" });
    await seedArchiveRecord(
      matter.id,
      "APPROVED",
      makeSnapshot({
        policyFileId: cuid("ff"),
        policySha256: "policy",
        documents: [docSnapshotOf(doc, 1, { sha256: sha256(Buffer.from("内容")), size: Buffer.byteLength("内容") })]
      })
    );

    await expect(assertDocumentNotInPendingArchive(doc.id)).resolves.toBeUndefined();
  });

  it("多条待审归档并存时，只按真正引用它的那条归档号拒绝", async () => {
    const user = await seedUser();
    const matterA = await seedMatter(user.id, "甲案");
    const matterB = await seedMatter(user.id, "乙案");
    const shared = await seedDocument({ matterId: matterA.id, uploadedById: user.id, name: "乙案材料.pdf", content: "乙案内容" });
    const insensitive = await seedDocument({ matterId: matterB.id, uploadedById: user.id, name: "无关材料.pdf", content: "无关" });
    await seedArchiveRecord(
      matterA.id,
      "PENDING_REVIEW",
      makeSnapshot({
        policyFileId: cuid("ff"),
        policySha256: "policy",
        documents: [docSnapshotOf(insensitive, 1, { sha256: sha256(Buffer.from("无关")), size: Buffer.byteLength("无关") })]
      }),
      "AR-甲-01"
    );
    await seedArchiveRecord(
      matterB.id,
      "PENDING_REVIEW",
      makeSnapshot({
        policyFileId: cuid("ff"),
        policySha256: "policy",
        documents: [docSnapshotOf(shared, 1, { sha256: sha256(Buffer.from("乙案内容")), size: Buffer.byteLength("乙案内容") })]
      }),
      "AR-乙-02"
    );

    const err = await captureError(() => assertDocumentNotInPendingArchive(shared.id));
    expect(err.message).toContain("AR-乙-02");
    expect(err.message).not.toContain("AR-甲-01");
  });

  it("历史脏数据（无法解析的 checklistJson）不误拒，也不影响合法待审单的拦截", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "本案材料.pdf", content: "内容" });
    // v1 时代的归档申请：没有 schemaVersion 2 结构
    await seedArchiveRecord(matter.id, "PENDING_REVIEW", { schemaVersion: 1, attachments: ["legacy-1"], note: "旧版" });

    await expect(assertDocumentNotInPendingArchive(doc.id)).resolves.toBeUndefined();

    await seedArchiveRecord(
      matter.id,
      "PENDING_REVIEW",
      makeSnapshot({
        policyFileId: cuid("ff"),
        policySha256: "policy",
        documents: [docSnapshotOf(doc, 1, { sha256: sha256(Buffer.from("内容")), size: Buffer.byteLength("内容") })]
      }),
      "AR-NEW-01"
    );
    const err = await captureError(() => assertDocumentNotInPendingArchive(doc.id));
    expect(err.message).toContain("AR-NEW-01");
  });
});

// ---------------------------------------------------------------------------
// 5. readArchiveDocument
// ---------------------------------------------------------------------------

describe("readArchiveDocument", () => {
  it("明文材料原样返回字节（逐字节一致）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const plain = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "截屏.png", content: plain });

    const buf = await readArchiveDocument(doc as never);
    expect(buf.equals(plain)).toBe(true);
    expect(buf.byteLength).toBe(plain.byteLength);
  });

  it("加密材料解密还原为原件字节（真实 AES-256-GCM）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const plain = Buffer.from("代理词：请求驳回原告全部诉讼请求。");
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "代理词.docx", content: plain, encrypted: true });

    const buf = await readArchiveDocument(doc as never);
    expect(buf.toString()).toBe("代理词：请求驳回原告全部诉讼请求。");
    expect(sha256(buf)).toBe(sha256(plain));
  });

  it("加密元数据损坏（缺 iv 或 authTag）→ 拒绝并点名材料", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const plain = Buffer.from("材料正文");
    const missingIv = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "缺IV.pdf", content: plain, encrypted: true });
    const missingTag = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "缺Tag.pdf", content: plain, encrypted: true });
    await db.document.update({ where: { id: missingIv.id }, data: { iv: null } });
    await db.document.update({ where: { id: missingTag.id }, data: { authTag: null } });
    const rowIv = await db.document.findUniqueOrThrow({ where: { id: missingIv.id } });
    const rowTag = await db.document.findUniqueOrThrow({ where: { id: missingTag.id } });

    const errIv = await captureError(() => readArchiveDocument(rowIv as never));
    expect(errIv.name).toBe("ActionError");
    expect(errIv.message).toBe("材料“缺IV.pdf”的加密元数据损坏，请联系管理员");

    const errTag = await captureError(() => readArchiveDocument(rowTag as never));
    expect(errTag.message).toBe("材料“缺Tag.pdf”的加密元数据损坏，请联系管理员");
  });

  it("密文被篡改 → 抛 ActionError，且绝不返回错误内容（2026-11-19 已统一转义）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "被篡改.pdf", content: "原件内容", encrypted: true });
    const ciphertext = Buffer.from(await fsp.readFile(path.join(storageRoot, doc.path)));
    ciphertext[3] = ciphertext[3] ^ 0x01;
    await putFile(doc.path, ciphertext);

    const err = await captureError(() => readArchiveDocument(doc as never));
    expect(err.name).toBe("ActionError");
    expect(String(err.message)).toMatch(/解密失败.*内容可能已损坏或加密密钥已更换/);
  });

  it("不承载任何权限判断：孤立材料（无案件归属）与跨案路径同样可读，可见性只能由调用方保证", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    // 一份挂在别案目录下的材料，行上 matterId 为 null
    const foreign = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "别案材料.pdf", content: "别案正文" });
    const orphan = await db.document.create({
      data: {
        id: cuid("d"),
        matterId: null,
        uploadedById: user.id,
        name: "孤立材料.pdf",
        category: "OTHER",
        path: foreign.path, // 直接指向别案的文件路径
        size: Buffer.byteLength("别案正文"),
        sha256: sha256(Buffer.from("别案正文"))
      }
    });

    const buf = await readArchiveDocument(orphan as never);
    expect(buf.toString()).toBe("别案正文");
    // 函数签名只吃 Document 行，没有任何 userId / session / matterId 入参——正是
    // export-bundle / buildArchiveZip 必须在调用前自行 assertCanReadMatter 的原因。
    expect(readArchiveDocument.length).toBe(1);
  });

  it("存储文件缺失 → 抛 ActionError 并提示文件可能已被移动或删除（2026-11-19 已修 D3）", async () => {
    const user = await seedUser();
    const matter = await seedMatter(user.id);
    const doc = await seedDocument({ matterId: matter.id, uploadedById: user.id, name: "丢失材料.pdf", content: "内容" });
    rmSync(path.join(storageRoot, doc.path), { force: true });

    const err = await captureError(() => readArchiveDocument(doc as never));
    expect(err.name).toBe("ActionError");
    expect(String(err.message)).toMatch(/读取失败.*文件可能已被移动或删除/);
  });
});
