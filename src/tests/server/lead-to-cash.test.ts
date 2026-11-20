// @vitest-environment node
/**
 * 线索到回款闭环（真库，2026-11-22）
 *
 * 补的是漏斗与财务之间缺失的那一段：业主看到"本月来 40 条、成交 3 单"
 * 和"本月回款 12 万"两个孤立的数，没人能回答"这 12 万里有多少是本月线索带来的"。
 *
 * 三条口径都是「宁可少算，不可多算」：
 *  ① 只统计期间新增线索（否则本期回款被历史线索抬价）
 *  ② 签约只认已签署合同（只建未签的不算）
 *  ③ 回款＝已确认实收减退款，不含"待确认到账"
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
    data: { email: "l2c@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));

const { getLeadToCash } = await import("@/server/leads/lead-to-cash");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const period = () => ({ start: new Date(Date.now() - 3600_000), end: new Date(Date.now() + 3600_000) });

/** 造一条线索（可带收案/案件/合同/实收），返回各层 id */
async function seedChain(opts: {
  converted?: boolean;
  signed?: boolean;
  received?: number;
  refund?: number;
  pendingReceived?: number;
  leadCreatedAt?: Date;
}) {
  const client = await prisma.client.create({
    data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
  });
  const lead = await prisma.lead.create({
    data: {
      name: uid("线索"), phone: `1390000${String(5000 + seq)}`, ownerId: STAFF.id,
      stage: opts.converted ? "CONVERTED" : "LEAD",
      createdAt: opts.leadCreatedAt ?? new Date(),
      updatedAt: new Date()
    }
  });
  if (!opts.converted) return { lead };

  const intake = await prisma.intake.create({
    data: {
      title: uid("收案"), category: "CIVIL_COMMERCIAL", contactName: "张三",
      contactPhone: "13900000000", status: "CONVERTED", createdById: STAFF.id, clientId: client.id
    }
  });
  await prisma.lead.update({ where: { id: lead.id }, data: { convertedIntakeId: intake.id, convertedAt: new Date() } });

  const matter = await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "闭环案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: client.id, intakeId: intake.id, customValues: {}
    }
  });

  let billingId: string | null = null;
  if (opts.signed !== false) {
    const b = await prisma.billing.create({
      data: {
        matterId: matter.id, title: "合同", contractAmount: new Prisma.Decimal(100_000),
        status: "ACTIVE", moneyKind: "LAWYER_FEE", signedAt: new Date()
      }
    });
    billingId = b.id;
  }

  const mk = async (type: "RECEIVED" | "REFUND", amount: number, confirmState: "CONFIRMED" | "PENDING" = "CONFIRMED") =>
    prisma.feeEntry.create({
      data: {
        matter: { connect: { id: matter.id } },
        ...(billingId ? { billing: { connect: { id: billingId } } } : {}),
        recordedBy: { connect: { id: STAFF.id } },
        type, amount: new Prisma.Decimal(amount), occurredAt: new Date(),
        confirmState, moneyKind: "LAWYER_FEE"
      }
    });

  if (opts.received) await mk("RECEIVED", opts.received);
  if (opts.refund) await mk("REFUND", opts.refund);
  if (opts.pendingReceived) await mk("RECEIVED", opts.pendingReceived, "PENDING");

  return { lead, intake, matter };
}

describe("线索到回款", () => {
  it("四段计数与金额：线索→收案→签约→回款，回款率=实收/签约额", async () => {
    const a = await seedChain({ converted: true, received: 30_000 });
    void a;
    const r = await getLeadToCash(period());
    expect(r.leadCount).toBeGreaterThanOrEqual(1);
    expect(r.convertedCount).toBeGreaterThanOrEqual(1);
    expect(r.signedMatterCount).toBeGreaterThanOrEqual(1);
    expect(r.paidMatterCount).toBeGreaterThanOrEqual(1);
    expect(r.contractAmount).toBeGreaterThanOrEqual(100_000);
    expect(r.receivedAmount).toBeGreaterThanOrEqual(30_000);
    expect(r.collectionRate).not.toBeNull();
  });

  it("**退款从实收里扣**（回款率不会因为退过钱而虚高）", async () => {
    const before = await getLeadToCash(period());
    await seedChain({ converted: true, received: 50_000, refund: 20_000 });
    const after = await getLeadToCash(period());
    // 净增 30_000，而不是 50_000
    expect(Math.round(after.receivedAmount - before.receivedAmount)).toBe(30_000);
  });

  it("**待确认到账不计入回款**（那是登记，不是到账）", async () => {
    const before = await getLeadToCash(period());
    await seedChain({ converted: true, pendingReceived: 99_000 });
    const after = await getLeadToCash(period());
    expect(after.receivedAmount).toBe(before.receivedAmount);
    expect(after.paidMatterCount).toBe(before.paidMatterCount);
  });

  it("**只建未签的合同不算签约**", async () => {
    const before = await getLeadToCash(period());
    await seedChain({ converted: true, signed: false, received: 10_000 });
    const after = await getLeadToCash(period());
    expect(after.signedMatterCount).toBe(before.signedMatterCount);
    expect(after.contractAmount).toBe(before.contractAmount);
  });

  it("**期间外的线索不计入**（不能拿历史线索抬本期回款率）", async () => {
    const old = new Date("2020-01-01T10:00:00+08:00");
    await seedChain({ converted: true, received: 88_000, leadCreatedAt: old });
    const r = await getLeadToCash(period());
    // 该线索不在期间内，其 88_000 不应出现在本期实收里
    expect(r.receivedAmount).toBeLessThan(88_000 + 1);
  });

  it("无数据时全 0、比率为 null（不显示 0%）", async () => {
    const empty = await getLeadToCash({
      start: new Date("2030-01-01T00:00:00Z"),
      end: new Date("2030-02-01T00:00:00Z")
    });
    expect(empty.leadCount).toBe(0);
    expect(empty.collectionRate).toBeNull();
    expect(empty.leadToCashRate).toBeNull();
  });
});
