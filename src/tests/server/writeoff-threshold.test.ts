// @vitest-environment node
/**
 * 坏账自助批准阈值（真库，2026-11-23）
 *
 * ## 为什么做成可配置而不是直接改
 *
 * 「不能自批」是防舞弊最直接的墙。放宽它是**业主的权限，不是实现的自由**。
 * 所以默认保持 `0`（永不自批），需要"小额免复核"时改配置即可，并有审计留痕。
 *
 * ## 四条口径
 *
 * ① 默认 0 → 任何自批都被拒（口径不变）；
 * ② 设 > 0 时，**金额小于**阈值可自批（等于阈值仍要他人复核）；
 * ③ 自批必须在审计里留下 `selfApproved` 与当时阈值 —— 事后能查"哪些是自批的"；
 * ④ 坏配置回落默认（不让页面白屏，也不误放宽）。
 */
import { Prisma, PrismaClient } from "@prisma/client";
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
    data: { email: "th@t.local", name: "财务乙", role: "FINANCE", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.receivableWriteOffItem.deleteMany({});
  await prisma.receivableWriteOff.deleteMany({});
  await prisma.receivable.deleteMany({});
  await prisma.matter.deleteMany({});
  await prisma.client.deleteMany({});
  await prisma.systemSetting.deleteMany({ where: { key: "leadFinancePolicy" } });
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "FINANCE", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { requestWriteOff, decideWriteOff } = await import("@/server/finance/writeoff-actions");
const { saveLeadFinancePolicy, LEAD_FINANCE_POLICY_DEFAULTS, getLeadFinancePolicy } =
  await import("@/server/settings/lead-finance-policy");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedMatterAndWriteOff(amount: number) {
  const client = await prisma.client.create({
    data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
  });
  const matter = await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "阈值案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: client.id, customValues: {}
    }
  });
  await prisma.receivable.create({
    data: {
      matterId: matter.id, title: uid("应收"), amount: new Prisma.Decimal(100_000),
      moneyKind: "LAWYER_FEE", status: "OPEN", dueDate: new Date("2026-01-01")
    }
  });
  const res = await requestWriteOff({ matterId: matter.id, amount, reason: "WAIVED" });
  return { matter, writeOffId: res.id };
}

describe("坏账自批阈值", () => {
  it("默认 0：**任何自批都被拒**（口径不变）", async () => {
    expect(LEAD_FINANCE_POLICY_DEFAULTS.writeOffSelfApproveBelow).toBe(0);
    const { writeOffId } = await seedMatterAndWriteOff(50);
    await expect(
      decideWriteOff({ id: writeOffId, decision: "APPROVED" })
    ).rejects.toThrow(/不能批准自己申报的坏账/);
  });

  it("设 100 后：50 元可自批，且审计记 selfApproved 与阈值", async () => {
    await saveLeadFinancePolicy({ ...LEAD_FINANCE_POLICY_DEFAULTS, writeOffSelfApproveBelow: 100 });
    const { audit } = await import("@/server/audit");
    vi.mocked(audit).mockClear();

    const { writeOffId } = await seedMatterAndWriteOff(50);
    await decideWriteOff({ id: writeOffId, decision: "APPROVED" });

    const row = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: writeOffId } });
    expect(row.status).toBe("APPROVED");

    const call = vi.mocked(audit).mock.calls
      .map((c) => c[0] as { action: string; detail?: Record<string, unknown> })
      .find((c) => c.action === "WRITE_OFF_APPROVE");
    expect(call?.detail?.selfApproved).toBe(true);
    expect(call?.detail?.selfApproveLimit).toBe(100);
  });

  it("**等于阈值仍要他人复核**（严格小于才算小额）", async () => {
    await saveLeadFinancePolicy({ ...LEAD_FINANCE_POLICY_DEFAULTS, writeOffSelfApproveBelow: 100 });
    const { writeOffId } = await seedMatterAndWriteOff(100);
    await expect(
      decideWriteOff({ id: writeOffId, decision: "APPROVED" })
    ).rejects.toThrow(/仅 100 元以下可自批/);
  });

  it("超过阈值被拒，且报错里带上阈值与本笔金额（可自查）", async () => {
    await saveLeadFinancePolicy({ ...LEAD_FINANCE_POLICY_DEFAULTS, writeOffSelfApproveBelow: 100 });
    const { writeOffId } = await seedMatterAndWriteOff(150);
    await expect(
      decideWriteOff({ id: writeOffId, decision: "APPROVED" })
    ).rejects.toThrow(/本笔 150 元/);
  });

  it("非自批（他人审批）在任何阈值下都正常放行", async () => {
    await saveLeadFinancePolicy({ ...LEAD_FINANCE_POLICY_DEFAULTS, writeOffSelfApproveBelow: 0 });
    const { matter } = await seedMatterAndWriteOff(50);
    // 直接造一条"别人申报"的坏账
    const other = await prisma.receivableWriteOff.create({
      data: {
        matterId: matter.id, amount: new Prisma.Decimal(50), reason: "WAIVED",
        requestedById: (await prisma.user.create({
          data: { email: `o${Date.now()}@t.local`, name: "他人", role: "FINANCE", passwordHash: "x", active: true }
        })).id
      }
    });
    await decideWriteOff({ id: other.id, decision: "APPROVED" });
    const row = await prisma.receivableWriteOff.findUniqueOrThrow({ where: { id: other.id } });
    expect(row.status).toBe("APPROVED");
  });

  it("坏配置（负数/非数字）回落默认 0，不误放宽", async () => {
    await prisma.systemSetting.create({
      data: { key: "leadFinancePolicy", value: { writeOffSelfApproveBelow: -5 } }
    });
    expect((await getLeadFinancePolicy()).writeOffSelfApproveBelow).toBe(0);
  });
});
