// @vitest-environment node
/**
 * 分成角色（真库，2026-11-22，D 段）
 *
 * 客户现行系统把一次成交的功劳拆给三个人：案源人 / 邀约人 / 面谈签约人。
 * 这不是同一字段的三种叫法，是**三笔绩效**。
 * 此前 label 是自由文本——能写，但统计不了（按"邀约"/"约人"匹配必然出错）。
 *
 * 四条口径：
 *  ① **同一角色只能有一人**（两个案源人，这笔绩效无法归属）
 *  ② **同一人只能占一行**（现有约束；一人兼两角色要分开走流程，不在此扩展）
 *  ③ **比例不足 100% 允许**（部分角色分成，余额归所内）
 *  ④ **建议只预填、不自动写**（分成直接决定钱怎么分，误记要走财务更正）
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
const A = { id: "" };
const B = { id: "" };
const C = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  for (const [slot, name] of [[A, "甲律师"], [B, "乙律师"], [C, "丙律师"]] as [typeof A, string][]) {
    const u = await prisma.user.create({
      data: { email: `${name}@t.local`, name, role: "LAWYER", passwordHash: "x", active: true }
    });
    slot.id = u.id;
  }
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: A.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/lib/archive/guard", () => ({ assertMatterWritable: vi.fn(async () => {}) }));
vi.mock("@/server/permissions/lead", () => ({ assertCanLeadMatter: vi.fn(async () => {}) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn(async () => {}) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { commissionPlanSetSchema } = await import("@/server/finance/schemas");
const { setCommissionPlan } = await import("@/server/finance/actions");
const { suggestCommissionRoles } = await import("@/server/finance/commission-roles");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const MATTER = { id: "" };

beforeAll(async () => {
  const client = await prisma.client.create({ data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" } });
  const m = await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "角色分成案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: A.id, primaryClientId: client.id, customValues: {}
    }
  });
  MATTER.id = m.id;
}, 60_000);

describe("角色校验", () => {
  it("同一角色不能指定两人——案源人只能是「谁带来的」", () => {
    const r = commissionPlanSetSchema.safeParse({
      matterId: MATTER.id,
      items: [
        { userId: A.id, percent: 20, role: "REFERRER" },
        { userId: B.id, percent: 10, role: "REFERRER" }
      ]
    });
    expect(r.success).toBe(false);
  });

  it("不同角色可以并存，合计不足 100 也允许", () => {
    const r = commissionPlanSetSchema.safeParse({
      matterId: MATTER.id,
      items: [
        { userId: A.id, percent: 30, role: "REFERRER" },
        { userId: B.id, percent: 20, role: "INVITER" },
        { userId: C.id, percent: 10, role: "CLOSER" }
      ]
    });
    expect(r.success).toBe(true);
  });

  it("同一人仍只能有一行", () => {
    const r = commissionPlanSetSchema.safeParse({
      matterId: MATTER.id,
      items: [
        { userId: A.id, percent: 10, role: "REFERRER" },
        { userId: A.id, percent: 10, role: "INVITER" }
      ]
    });
    expect(r.success).toBe(false);
  });

  it("OTHER 不受唯一性限制（协作分成本来可以多人）", () => {
    const r = commissionPlanSetSchema.safeParse({
      matterId: MATTER.id,
      items: [
        { userId: A.id, percent: 10, role: "OTHER" },
        { userId: B.id, percent: 10, role: "OTHER" }
      ]
    });
    expect(r.success).toBe(true);
  });
});

describe("落库与审计", () => {
  it("角色写入数据库，并在审计里带上角色列表", async () => {
    const { auditTx } = await import("@/server/audit");
    await setCommissionPlan({
      matterId: MATTER.id,
      items: [
        { userId: A.id, percent: 30, role: "REFERRER", label: "转介绍" },
        { userId: B.id, percent: 20, role: "INVITER", label: "" }
      ]
    });
    const rows = await prisma.commissionPlan.findMany({ where: { matterId: MATTER.id }, orderBy: { percent: "desc" } });
    expect(rows.map((r) => r.role)).toEqual(["REFERRER", "INVITER"]);
    expect(rows[0].label).toBe("转介绍");

    const call = vi.mocked(auditTx).mock.calls.at(-1)?.[1] as { detail?: { roles?: unknown } };
    expect(call.detail?.roles).toEqual(["REFERRER", "INVITER"]);
  });

  it("未标角色时 role 存 null（不默认成 OTHER，避免污染统计）", async () => {
    await setCommissionPlan({ matterId: MATTER.id, items: [{ userId: C.id, percent: 10 }] });
    const row = await prisma.commissionPlan.findFirstOrThrow({ where: { matterId: MATTER.id } });
    expect(row.role).toBeNull();
  });
});

describe("角色建议", () => {
  it("案件由线索转化而来时，建议邀约人＝线索负责人", async () => {
    // 造一条线索 → 收案 → 案件
    const client = await prisma.client.create({ data: { name: uid("线索客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" } });
    const intake = await prisma.intake.create({
      data: {
        title: uid("收案"), category: "CIVIL_COMMERCIAL", contactName: "张三",
        contactPhone: "13900000001", status: "CONVERTED", createdById: B.id,
        clientId: client.id
      }
    });
    await prisma.lead.create({
      data: { name: uid("线索"), phone: "13900000002", stage: "CONVERTED", ownerId: B.id, convertedIntakeId: intake.id }
    });
    const matter = await prisma.matter.create({
      data: {
        internalCode: uid("LL-"), title: "线索转化案", category: "CIVIL_COMMERCIAL",
        status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
        teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
        ownerId: A.id, primaryClientId: client.id, intakeId: intake.id, customValues: {}
      }
    });

    const s = await suggestCommissionRoles(matter.id);
    expect(s).toHaveLength(1);
    expect(s[0].role).toBe("INVITER");
    expect(s[0].userId).toBe(B.id);
    expect(s[0].reason).toContain("转化");
  });

  it("案件不是线索转化来的 → 不编造建议", async () => {
    const s = await suggestCommissionRoles(MATTER.id);
    expect(s).toHaveLength(0);
  });
});
