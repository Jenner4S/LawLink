// @vitest-environment node
/**
 * 客户职业（真库，2026-11-23）
 *
 * 线索阶段已在 `Lead.occupation` 采集职业；客户档案侧此前只有 industry（行业），
 * 个人客户常"只有职业、没有行业"，档案里记不下来。
 *
 * 三条口径：
 *  ① 与 `industry` **并存**，不互相覆盖（企业客户两个都有，个人客户常有职业无行业）；
 *  ② 只接受 ≤60 字，空串归一为 null（不留 ""，避免统计时把空串当一类）；
 *  ③ 创建与更新都写库（编辑能改）。
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
    data: { email: "occ@t.local", name: "主任", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => { await prisma.client.deleteMany({}); });

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { createClient, updateClient } = await import("@/server/clients/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

describe("客户职业", () => {
  it("创建时写入 occupation，且与 industry 并存", async () => {
    const res = await createClient({
      name: uid("客户"), type: "INDIVIDUAL",
      industry: "餐饮", occupation: "店主"
    } as never);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: (res as { id: string }).id } });
    expect(row.occupation).toBe("店主");
    expect(row.industry).toBe("餐饮");
  });

  it("空串归一为 null（不留空字符串，避免统计把空串当一类）", async () => {
    const res = await createClient({ name: uid("客户"), type: "INDIVIDUAL", occupation: "" } as never);
    const row = await prisma.client.findUniqueOrThrow({ where: { id: (res as { id: string }).id } });
    expect(row.occupation).toBeNull();
  });

  it("编辑可改职业（并保留行业）", async () => {
    const res = await createClient({ name: uid("客户"), type: "INDIVIDUAL", industry: "教育", occupation: "教师" } as never);
    const id = (res as { id: string }).id;
    await updateClient({ id, name: uid("客户"), type: "INDIVIDUAL", industry: "教育", occupation: "校长", contacts: [] } as never);
    const row = await prisma.client.findUniqueOrThrow({ where: { id } });
    expect(row.occupation).toBe("校长");
    expect(row.industry).toBe("教育");
  });

  it("超 60 字被拒（与 industry 同一约束）", async () => {
    await expect(
      createClient({ name: uid("客户"), type: "INDIVIDUAL", occupation: "职".repeat(61) } as never)
    ).rejects.toThrow();
  });
});
