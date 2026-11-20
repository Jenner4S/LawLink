// @vitest-environment node
/**
 * 业务口径开关（真库，2026-11-22）
 *
 * 这两个口径只有业主能定。**不能因为没定就卡住开发**：
 * 写死一种等于替业主做决定；两种都做又要等答复。
 * 处置是可配置 + 默认有主张，业主回答后改配置即可。
 *
 * 四条口径：
 *  ① 默认值必须有主张（风代按回款、券金额=成本）
 *  ② 非法值不得污染读取（坏数据回落默认，而不是抛错让页面白屏）
 *  ③ 切换不动历史数据（金额照常保存，只是解读不同）
 *  ④ 保存写审计含前后值（口径直接决定钱怎么算）
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
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "pol@t.local", name: "主任", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
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

const { getLeadFinancePolicy, saveLeadFinancePolicy, LEAD_FINANCE_POLICY_DEFAULTS } =
  await import("@/server/settings/lead-finance-policy");
const { updateLeadFinancePolicy } = await import("@/server/settings/lead-finance-policy-actions");
const { computeContingencyAccruals } = await import("@/server/finance/contingency");

describe("默认值与坏数据", () => {
  it("没有配置时用有主张的默认（按回款 / 券金额=成本）", async () => {
    const p = await getLeadFinancePolicy();
    expect(p).toEqual(LEAD_FINANCE_POLICY_DEFAULTS);
    expect(p.contingencyBasis).toBe("RECEIVED");
    expect(p.voucherAmountSide).toBe("COST");
  });

  it("库里是坏值时回落默认，而不是抛错让页面白屏", async () => {
    await prisma.systemSetting.upsert({
      where: { key: "leadFinancePolicy" },
      create: { key: "leadFinancePolicy", value: { contingencyBasis: "WHATEVER", voucherAmountSide: 123 } },
      update: { value: { contingencyBasis: "WHATEVER", voucherAmountSide: 123 } }
    });
    const p = await getLeadFinancePolicy();
    expect(p).toEqual(LEAD_FINANCE_POLICY_DEFAULTS);
  });
});

describe("保存与审计", () => {
  it("保存后可读回，并写审计含前后值", async () => {
    const { audit } = await import("@/server/audit");
    await saveLeadFinancePolicy(LEAD_FINANCE_POLICY_DEFAULTS);
    vi.mocked(audit).mockClear();

    await updateLeadFinancePolicy({ contingencyBasis: "CONTRACT", voucherAmountSide: "REVENUE" });

    const p = await getLeadFinancePolicy();
    expect(p.contingencyBasis).toBe("CONTRACT");
    expect(p.voucherAmountSide).toBe("REVENUE");

    const call = vi.mocked(audit).mock.calls.map((c) => c[0] as { action: string; detail?: { before?: unknown; after?: unknown } })
      .find((c) => c.action === "LEAD_FINANCE_POLICY");
    expect(call).toBeTruthy();
    expect((call!.detail?.before as { contingencyBasis: string }).contingencyBasis).toBe("RECEIVED");
    expect((call!.detail?.after as { contingencyBasis: string }).contingencyBasis).toBe("CONTRACT");
  });

  it("非法入参被 schema 拒绝", async () => {
    await expect(
      updateLeadFinancePolicy({ contingencyBasis: "WHATEVER" as never, voucherAmountSide: "COST" })
    ).rejects.toThrow();
  });
});

describe("口径切换只改解读，不改数据", () => {
  const billing = {
    id: "b1",
    title: "风代合同",
    contractAmount: 100_000,
    contingencyPercent: 30,
    signedAt: new Date("2026-11-01T10:00:00+08:00")
  };

  it("RECEIVED 口径按回款计提", () => {
    const [p] = computeContingencyAccruals([billing as never], 20_000, "RECEIVED");
    expect(p.basis).toBe(20_000);
    expect(p.accrued).toBe(6_000);
  });

  it("CONTRACT 口径按合同额计提（同一份数据，只是解读不同）", () => {
    const [p] = computeContingencyAccruals([billing as never], 20_000, "CONTRACT");
    expect(p.basis).toBe(100_000);
    expect(p.accrued).toBe(30_000);
  });

  it("两种口径下 contractAmount 字段都不变（历史数据未被改写）", () => {
    const a = computeContingencyAccruals([billing as never], 20_000, "RECEIVED")[0];
    const b = computeContingencyAccruals([billing as never], 20_000, "CONTRACT")[0];
    expect(a.contractAmount).toBe(b.contractAmount);
  });
});
