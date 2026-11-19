// @vitest-environment node
/**
 * 材料版本切换的「唯一切换」不变量（2026-11-21 补，真 P1 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `uploadNewVersion` 原本是两步独立提交：
 *
 *   1. `updateMany({ familyId, isLatest: true }, { isLatest: false })`   ← 清空全族
 *   2. `document.create({ ..., version: top+1, isLatest: true })`        ← 建新版本
 *
 * 看起来有 `documentMutation` 包着，但 `roleMutation` 对**内置岗位直接
 * `write(prisma)`、不建事务**（`roles/service.ts:38`）—— 而律所里所有人
 * 都是内置岗位（LAWYER / PRINCIPAL_LAWYER / FINANCE …）。
 *
 * 所以第 1 步与第 2 步是两个独立提交。第 2 步一旦失败（P2002 撞版本号、
 * DB 抖动、任何异常），**整族文档没有任何一条 isLatest=true**：
 *
 *   - 材料列表按 isLatest 取 → 该材料从列表消失
 *   - `export-bundle.ts:37` 的卷宗导出按 isLatest 取 → 导出漏件
 *   - 没有自愈路径 —— 除非有人手工改库
 *
 * ## 修法与这里测什么
 *
 * 改成不依赖事务的两步：先 `create({ isLatest: false })`（完全不碰老数据），
 * 再用**一条** UPDATE 原子地完成「本条 true、同族其它 false」。
 *
 * 本文件不调那个 Server Action（它要 session / File / 存储 / 权限，端到端构造成本
 * 远大于收益），而是直接验证**那个不变量与那段 SQL**：
 *   · 新顺序在「create 后、翻转前」中断 → 族里仍有恰好一条 isLatest（老版本）
 *   · 旧顺序在「清空后、create 前」中断 → 族里零条 isLatest（复现 bug）
 *   · 原子 UPDATE 在多族混存时只影响目标族
 *
 * 隔离：自建临时库 `lawlink-ver_test_*` → migrate deploy → DROP。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  console.info(`[doc-version-invariant] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedUser() {
  return prisma.user.create({
    data: { id: uid("u"), email: `${uid("e")}@t.local`, name: "上传者", role: "LAWYER", passwordHash: "x", active: true }
  });
}

/** 建一个文档族：n 个历史版本，最后一个是 latest */
async function seedFamily(uploaderId: string, versions: number) {
  const familyId = uid("fam");
  const rows = [];
  for (let v = 1; v <= versions; v++) {
    rows.push(await prisma.document.create({
      data: {
        id: uid("d"), matterId: null, intakeId: null,
        name: `文书v${v}.pdf`, path: `s/${uid("f")}.pdf`, mimeType: "application/pdf",
        size: 10, sha256: "e".repeat(64), algorithm: "AES-256-GCM",
        familyId, version: v, isLatest: v === versions,
        uploadedById: uploaderId, status: "DRAFT"
      }
    }));
  }
  return { familyId, rows };
}

/** 生产代码里那段原子切换 */
async function flipLatest(db: PrismaClient, familyId: string, newId: string) {
  await db.$executeRaw`
    UPDATE "Document" SET "isLatest" = (id = ${newId}) WHERE "familyId" = ${familyId}
  `;
}

const latestOf = (familyId: string) =>
  prisma.document.findMany({ where: { familyId, isLatest: true }, select: { id: true, version: true } });

describe("材料版本切换 · 唯一切换不变量（真库）", () => {
  it("新顺序正常路径：create(isLatest:false) + 原子 UPDATE → 恰好新版本为 latest", async () => {
    const u = await seedUser();
    const { familyId, rows } = await seedFamily(u.id, 3);
    expect((await latestOf(familyId)).map((r) => r.version)).toEqual([3]);

    const next = await prisma.document.create({
      data: {
        id: uid("d"), matterId: null, intakeId: null, name: "文书v4.pdf",
        path: `s/${uid("f")}.pdf`, mimeType: "application/pdf", size: 10,
        sha256: "f".repeat(64), algorithm: "AES-256-GCM",
        familyId, version: 4, isLatest: false, uploadedById: u.id, status: "DRAFT"
      }
    });
    await flipLatest(prisma, familyId, next.id);

    const latest = await latestOf(familyId);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(next.id);
    expect(latest[0].version).toBe(4);
    // 历史版本仍在，只是不再是 latest
    const all = await prisma.document.count({ where: { familyId } });
    expect(all).toBe(4);
    expect(rows).toHaveLength(3);
  });

  it("新顺序在「create 之后、翻转之前」中断 → 族里仍有老版本为 latest（材料不丢）", async () => {
    // 关键回归：create 成功但翻转失败（模拟 UPDATE 报错/进程崩溃）。
    const u = await seedUser();
    const { familyId } = await seedFamily(u.id, 2);
    await prisma.document.create({
      data: {
        id: uid("d"), matterId: null, intakeId: null, name: "文书v3.pdf",
        path: `s/${uid("f")}.pdf`, mimeType: "application/pdf", size: 10,
        sha256: "1".repeat(64), algorithm: "AES-256-GCM",
        familyId, version: 3, isLatest: false, uploadedById: u.id, status: "DRAFT"
      }
    });
    // 不调用 flipLatest —— 模拟失败
    const latest = await latestOf(familyId);
    expect(latest).toHaveLength(1);          // 不变量成立
    expect(latest[0].version).toBe(2);       // 老版本仍可见
  });

  it("旧顺序（清空后 create 前中断）→ 族里零条 latest —— 复现被修掉的 bug", async () => {
    // 这条是「反面教材」：它证明旧顺序确实会造成整族无 latest。
    // 如果哪天有人把顺序改回去，上面那条不会红，但这条会提醒你后果。
    const u = await seedUser();
    const { familyId } = await seedFamily(u.id, 2);

    // 旧顺序第一步：清空全族
    await prisma.document.updateMany({ where: { familyId, isLatest: true }, data: { isLatest: false } });
    // 旧顺序第二步本应 create —— 模拟它失败（P2002 / DB 抖动 / 任何异常）

    const latest = await latestOf(familyId);
    expect(latest).toHaveLength(0);          // ← 这就是 bug 的形态：整族没有 latest
    // 4. 后果：按 isLatest 取的读取路径（列表 / export-bundle）会漏掉这份材料
    const visibleViaExportPath = await prisma.document.findMany({
      where: { familyId, isLatest: true }, select: { id: true }
    });
    expect(visibleViaExportPath).toHaveLength(0);
  });

  it("原子切换只影响目标族，不波及其他族的 latest", async () => {
    const u = await seedUser();
    const a = await seedFamily(u.id, 2);
    const b = await seedFamily(u.id, 3);

    const nextA = await prisma.document.create({
      data: {
        id: uid("d"), matterId: null, intakeId: null, name: "A-v3.pdf",
        path: `s/${uid("f")}.pdf`, mimeType: "application/pdf", size: 10,
        sha256: "2".repeat(64), algorithm: "AES-256-GCM",
        familyId: a.familyId, version: 3, isLatest: false, uploadedById: u.id, status: "DRAFT"
      }
    });
    await flipLatest(prisma, a.familyId, nextA.id);

    expect((await latestOf(a.familyId)).map((r) => r.id)).toEqual([nextA.id]);
    // B 族完全不受影响
    expect((await latestOf(b.familyId)).map((r) => r.version)).toEqual([3]);
  });

  it("重复执行原子切换是幂等的（同 id 再跑一次结果不变）", async () => {
    // 真实场景：用户重试上传、或 worker 重跑。切换语句本身不累积副作用。
    const u = await seedUser();
    const { familyId } = await seedFamily(u.id, 2);
    const next = await prisma.document.create({
      data: {
        id: uid("d"), matterId: null, intakeId: null, name: "v3.pdf",
        path: `s/${uid("f")}.pdf`, mimeType: "application/pdf", size: 10,
        sha256: "3".repeat(64), algorithm: "AES-256-GCM",
        familyId, version: 3, isLatest: false, uploadedById: u.id, status: "DRAFT"
      }
    });
    await flipLatest(prisma, familyId, next.id);
    await flipLatest(prisma, familyId, next.id);
    const latest = await latestOf(familyId);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(next.id);
  });
});


/* ==================================================================
 * 下半部分：真调 `uploadNewVersion`（2026-11-21 补）
 *
 * 上面那 5 条只验证「不变量 + 那段 SQL」，**guard 不到生产代码** ——
 * 实测把 uploadDocumentNewVersion 改回旧顺序，那 5 条仍然全绿。
 * 所以这里 mock 掉会话 / 存储 / 权限（它们与本 bug 无关），
 * 保留真 prisma，直接调生产函数，用「预置一条 version+1 的记录」
 * 逼 create 撞 P2002，再看族里还有没有 latest。
 * ================================================================== */

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "LAWYER", rolePermissions: undefined } })
}));
vi.mock("@/lib/permissions", async (orig) => ({
  ...(await orig<any>()),
  assertCanHandleMatter: async () => {},
  assertCanLeadMatter: async () => {}
}));
vi.mock("@/lib/archive/guard", () => ({ assertDocumentWritable: async () => {} }));
vi.mock("@/lib/storage", () => ({
  storage: {
    writeFile: async () => `tmp/${Math.random().toString(36).slice(2)}`,
    readFile: async () => Buffer.alloc(0),
    deleteFile: async () => {}
  }
}));

// 会话 mock 返回的 userId 必须在库里真实存在 —— Document.uploadedById 有外键。
const CURRENT_USER = "doc-version-test-user";

const { uploadNewVersion } = await import("@/server/documents/actions");
const { ActionError } = await import("@/lib/action-error");

function fakeFile(name: string) {
  return new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, { type: "application/pdf" });
}

describe("uploadNewVersion · create 失败时整族仍保留 latest（真调生产函数）", () => {
  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: CURRENT_USER },
      create: { id: CURRENT_USER, email: "docver@t.local", name: "上传者", role: "LAWYER", passwordHash: "x", active: true },
      update: {}
    });
  });

  it("正常上传：老版本置 false、新版本置 true，族内恰好一条 latest", async () => {
    const u = await seedUser();
    const { familyId, rows } = await seedFamily(u.id, 2);
    const prior = rows[rows.length - 1];

    const res = await uploadNewVersion({ documentId: prior.id, file: fakeFile("v3.pdf") } as never);
    expect(res.ok).toBe(true);
    expect(res.version).toBe(3);

    const latest = await latestOf(familyId);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(res.id);
  });

  it("create 失败时：**族里仍有一条 latest**（老版本），材料不丢", async () => {
    // 怎么「确定性地」让 create 失败？
    // 一开始试过预置一条 version+1 的记录去撞 @@unique([familyId, version]) ——
    // **思路是错的**：函数算的是「族内最大版本 + 1」，永远避开已存在的版本号。
    // 真正的撞号只发生在 findFirst 与 create 之间的并发窗口里，没法稳定构造。
    //
    // 改成在临时库里装一个只对本用例生效的触发器：往 Document 插 name='FORCE_FAIL.pdf'
    // 就抛异常。这样 create 必失败，而且失败点正是生产代码里那一步。
    const u = await seedUser();
    const { familyId } = await seedFamily(u.id, 2);
    const prior = await prisma.document.findFirstOrThrow({ where: { familyId, version: 2 } });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION doc_fail_probe() RETURNS trigger AS $$
      BEGIN
        IF NEW.name = 'FORCE_FAIL.pdf' THEN
          RAISE EXCEPTION 'forced failure for invariant test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER doc_fail_probe_trg BEFORE INSERT ON "Document"
      FOR EACH ROW EXECUTE FUNCTION doc_fail_probe();
    `);

    try {
      await expect(
        uploadNewVersion({ documentId: prior.id, file: fakeFile("FORCE_FAIL.pdf") } as never)
      ).rejects.toBeTruthy();

      // 关键断言：create 失败后，族里**仍然**有恰好一条 latest，且是老版本
      const latest = await latestOf(familyId);
      expect(latest).toHaveLength(1);
      expect(latest[0].version).toBe(2);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS doc_fail_probe_trg ON "Document"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS doc_fail_probe()`);
    }
  });

  it("原材料的 isLatest 为 false 时直接拒绝，不做任何改动", async () => {
    const u = await seedUser();
    const { familyId, rows } = await seedFamily(u.id, 3);
    const notLatest = rows[0]; // version 1, isLatest=false

    await expect(
      uploadNewVersion({ documentId: notLatest.id, file: fakeFile("x.pdf") } as never)
    ).rejects.toBeInstanceOf(ActionError);

    const latest = await latestOf(familyId);
    expect(latest).toHaveLength(1);
    expect(latest[0].version).toBe(3);
  });
});
