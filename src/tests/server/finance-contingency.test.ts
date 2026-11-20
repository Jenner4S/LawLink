// @vitest-environment node
/**
 * 风险代理计提（2026-11-22，对标分析 P0-4）
 *
 * 客户现行系统有「风代比例 / 风代金额」两列，LawLink 此前只有一段自由文本——
 * 算不出、统计不了。
 *
 * 四条口径各能搞错：
 *  ① **计提基数是回款，不是合同额**（风代后收费）
 *  ② **未签署的合同不参与计提**（还没生效的约定不能拿去算钱）
 *  ③ **金额不落库、读时派生**（落库必然与实收打架）
 *  ④ **比例变更必须留痕**（它直接决定能提多少钱）
 */
import { Prisma, PrismaClient } from "@prisma/client";
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
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "cp@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { computeContingencyAccruals, sumContingencyAccruals } = await import("@/server/finance/contingency");
const { setBillingContingency } = await import("@/server/finance/actions");
const { audit } = await import("@/server/audit");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

const billing = (over: Partial<{ id: string; title: string; contractAmount: number; contingencyPercent: number | null; signedAt: Date | null }> = {}) => ({
  id: over.id ?? uid("b"),
  title: over.title ?? "风险代理合同",
  contractAmount: new Prisma.Decimal(over.contractAmount ?? 100_000),
  contingencyPercent: over.contingencyPercent === undefined ? new Prisma.Decimal(30) : (over.contingencyPercent === null ? null : new Prisma.Decimal(over.contingencyPercent)),
  signedAt: over.signedAt === undefined ? new Date("2026-11-01T10:00:00+08:00") : over.signedAt
});

describe("计提口径", () => {
  it("基数是回款不是合同额：实收 2 万 × 30% = 6 千（合同额 10 万不参与）", () => {
    const plans = computeContingencyAccruals([billing()], 20_000);
    expect(plans).toHaveLength(1);
    expect(plans[0].basis).toBe(20_000);
    expect(plans[0].accrued).toBe(6_000);
    expect(plans[0].contractAmount).toBe(100_000);
  });

  it("未签署的合同不参与计提（还没生效的约定不能拿去算钱）", () => {
    const plans = computeContingencyAccruals([billing({ signedAt: null })], 50_000);
    expect(plans[0].basis).toBe(0);
    expect(plans[0].accrued).toBe(0);
  });

  it("未设比例（普通收费）的合同被排除", () => {
    expect(computeContingencyAccruals([billing({ contingencyPercent: null })], 50_000)).toHaveLength(0);
  });

  it("未回款时计提为 0（不是按合同额预提）", () => {
    expect(computeContingencyAccruals([billing()], 0)[0].accrued).toBe(0);
  });

  it("金额四舍五入到分，且合计等于各项之和", () => {
    const plans = computeContingencyAccruals(
      [billing({ contingencyPercent: 33.33 }), billing({ contingencyPercent: 15 })],
      10_000
    );
    // 10000 × 33.33% = 3333；10000 × 15% = 1500
    expect(plans.map((p) => p.accrued).sort((a, b) => a - b)).toEqual([1500, 3333]);
    expect(sumContingencyAccruals(plans)).toBe(4833);
  });

  it("多个风代合同按计提额倒序（律师先看大额）", () => {
    const plans = computeContingencyAccruals(
      [billing({ contingencyPercent: 10 }), billing({ contingencyPercent: 40 })],
      10_000
    );
    expect(plans[0].percent).toBe(40);
  });
});

describe("比例变更留痕", () => {
  async function seedMatterWithBilling(percent: number | null) {
    const client = await prisma.client.create({ data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" } });
    const matter = await prisma.matter.create({
      data: {
        internalCode: uid("LL-"), title: "风代案", category: "CIVIL_COMMERCIAL",
        status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
        teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
        ownerId: STAFF.id, primaryClientId: client.id, customValues: {}
      }
    });
    const b = await prisma.billing.create({
      data: {
        matterId: matter.id, title: "风代合同",
        contractAmount: new Prisma.Decimal(100_000),
        status: "ACTIVE", moneyKind: "LAWYER_FEE",
        contingencyPercent: percent === null ? null : new Prisma.Decimal(percent!)
      }
    });
    return { matter, billing: b };
  }

  it("设置比例写审计，含新旧值", async () => {
    const { billing: b } = await seedMatterWithBilling(20);
    vi.mocked(audit).mockClear();
    await setBillingContingency({ billingId: b.id, percent: 35 });

    const row = await prisma.billing.findUniqueOrThrow({ where: { id: b.id }, select: { contingencyPercent: true } });
    expect(Number(row.contingencyPercent)).toBe(35);

    const call = vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; detail?: { before?: number; after?: number } })
      .find((c) => c.action === "BILLING_CONTINGENCY");
    expect(call).toBeTruthy();
    expect(call!.detail?.before).toBe(20);
    expect(call!.detail?.after).toBe(35);
  });

  it("传 null 可清除（改回普通收费）", async () => {
    const { billing: b } = await seedMatterWithBilling(30);
    await setBillingContingency({ billingId: b.id, percent: null });
    const row = await prisma.billing.findUniqueOrThrow({ where: { id: b.id }, select: { contingencyPercent: true } });
    expect(row.contingencyPercent).toBeNull();
  });

  it("超出 0–100 被拒（比例直接决定能提多少钱，不能录错）", async () => {
    const { billing: b } = await seedMatterWithBilling(30);
    await expect(setBillingContingency({ billingId: b.id, percent: 120 })).rejects.toThrow("0–100");
    await expect(setBillingContingency({ billingId: b.id, percent: -1 })).rejects.toThrow("0–100");
  });
});
