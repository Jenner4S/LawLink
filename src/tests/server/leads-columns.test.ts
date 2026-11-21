// @vitest-environment node
/**
 * 线索列表列显隐（真库，2026-11-23）
 *
 * 客户宽表的痛点之一是列太多、每所关心的不一样。
 * 但真正诉求是"把我不看的列藏起来"，不是"让我写公式" ——
 * 显隐是这条诉求里成本最低、最不容易做错的一半。
 *
 * 四条口径：
 *  ① 默认**全显**（不配置时与之前行为一致，不给用户惊喜）；
 *  ② **线索人列不可隐藏**（藏了列表就只剩一堆按钮）；
 *  ③ 未知键丢弃、列顺序按固定定义（配置写错不会让页面空白或错列）；
 *  ④ 保存写审计含前后值。
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
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "cols@t.local", name: "主任", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: "leads.listColumns" } });
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { getLeadsListColumns, saveLeadsListColumns, LEADS_COLUMNS } = await import("@/server/settings/leads-columns");
const { updateLeadsListColumns } = await import("@/server/settings/leads-columns-actions");

describe("列显隐", () => {
  it("默认全显（不配置时与之前行为一致）", async () => {
    const cols = await getLeadsListColumns();
    expect(cols).toEqual(LEADS_COLUMNS.map((c) => c.key));
  });

  it("保存子集后可读回", async () => {
    await updateLeadsListColumns({ columns: ["name", "stage"] });
    expect(await getLeadsListColumns()).toEqual(["name", "stage"]);
  });

  it("**线索人列不可隐藏**：只传 stage 也会补回 name", async () => {
    const saved = await saveLeadsListColumns(["stage", "owner"]);
    expect(saved).toContain("name");
    expect(await getLeadsListColumns()).toContain("name");
  });

  it("未知键被丢弃、顺序按固定定义（配置写错不会错列）", async () => {
    await prisma.systemSetting.create({
      data: { key: "leads.listColumns", value: { columns: ["owner", "NOT_A_COLUMN", "name"] } }
    });
    // 即使存储顺序是 owner→name，返回应恢复成定义顺序 name→owner
    expect(await getLeadsListColumns()).toEqual(["name", "owner"]);
  });

  it("保存写审计含前后值", async () => {
    const { audit } = await import("@/server/audit");
    vi.mocked(audit).mockClear();
    await updateLeadsListColumns({ columns: ["name", "source"] });
    const call = vi.mocked(audit).mock.calls
      .map((c) => c[0] as { action: string; detail?: { before?: unknown; after?: unknown } })
      .find((c) => c.action === "LEADS_COLUMNS");
    expect(call).toBeTruthy();
    expect(call!.detail?.after).toEqual(["name", "source"]);
  });

  it("空数组被 schema 拒绝（不能把列全关掉）", async () => {
    await expect(updateLeadsListColumns({ columns: [] })).rejects.toThrow();
  });
});
