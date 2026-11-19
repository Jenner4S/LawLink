// @vitest-environment node
/**
 * 已归档案件不得再新增证据项（2026-11-21）
 *
 * ## 怎么发现的
 *
 * Round 144 修完「已归档案件仍可增删关联」后，把同一个问法扩到全仓：
 * 扫出 108 个「涉及案件的写操作」，其中 32 个不含任何状态守卫。
 * 逐个triage 后，多数是合理豁免（审批动作的对象本就是已提交申请、
 * 创建类动作没有已存在的案件可锁），但 `createEvidenceItem` 属真缺口：
 *
 *   await assertCanHandleMatter(session.user, data.matterId);   // 只查角色
 *   ... tx.evidenceItem.create(...)                             // 不看案件状态
 *
 * 证据项是案件正文内容（办案进程 → 材料里展示），归档快照在归档那一刻冻结，
 * 归档后再往里加证据项，等于「已封存的卷宗还能长出新材料」。
 *
 * ## 与 Round 144 的关系
 *
 * 同一个业务规则（归档即冻结），两种不同的漏网方式：
 *   · 关联关系 → `assertCanAssociateMatter` 不看状态
 *   · 证据项   → `assertCanHandleMatter` 只看角色
 * 这说明**规则没有集中表达**——每个写路径各自决定要不要查状态。
 * 集中化（例如让 assertCanHandleMatter 内部也查）影响面太大，
 * 这里先按路径逐一补，并把 triage 结果记在台账里。
 *
 * 隔离：自建临时库 `lawlink_evguard_test_*` → migrate deploy → DROP。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const HOLDER = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_evguard_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  process.env.DATABASE_URL = url;
  return { host, user, password, name, url };
});

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let prisma: PrismaClient;
let admin: PrismaClient;
const CURRENT_USER = "ev-guard-user";

beforeAll(async () => {
  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  try {
    await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
  } catch (err) {
    throw new Error(`临时库创建失败：${String(err)}`);
  }
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: HOLDER.url }, stdio: "pipe"
  });
  prisma = new PrismaClient({ datasourceUrl: HOLDER.url });
  await prisma.user.create({
    data: { id: CURRENT_USER, email: "ev@t.local", name: "办案人", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  console.info(`[evidence-write-guard] 临时库：${HOLDER.name}`);
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[evidence-write-guard] 已 DROP 临时库：${HOLDER.name}`);
  }
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const { createEvidenceItem } = await import("@/server/evidence/actions");

async function seedMatter(status: "IN_PROGRESS" | "ARCHIVED") {
  return prisma.matter.create({
    data: {
      internalCode: `LL-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      title: `${status} 案`,
      category: "CIVIL_COMMERCIAL" as never,
      status,
      serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false,
      counterclaimAsPlaintiff: false,
      counterclaimAsDefendant: false,
      ownerId: CURRENT_USER,
      customValues: {}
    }
  });
}

const item = (matterId: string) => ({
  matterId,
  title: "证据要点",
  content: "内容",
  kind: "FACT" as const
});

describe("已归档案件不得新增证据项", () => {
  it("已归档案件新增证据项：拒绝，且不落库、不留审计", async () => {
    const m = await seedMatter("ARCHIVED");
    await expect(createEvidenceItem(item(m.id) as never)).rejects.toThrow(/归档/);
    expect(await prisma.evidenceItem.count({ where: { matterId: m.id } })).toBe(0);
  });

  it("**在办**案件新增证据项不受影响（基线：守卫不能误伤正常动线）", async () => {
    const m = await seedMatter("IN_PROGRESS");
    const r = await createEvidenceItem(item(m.id) as never);
    expect(r.ok).toBe(true);
    expect(await prisma.evidenceItem.count({ where: { matterId: m.id } })).toBe(1);
  });
});
