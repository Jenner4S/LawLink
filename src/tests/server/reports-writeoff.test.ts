// @vitest-environment node
/**
 * 报表与坏账口径对齐（真库，2026-11-22 P0-5 收尾）
 *
 * 钉的是「客户应收余额在报表里也扣掉了已批准坏账」，
 * 同时钉住「应收发生额不受影响」——否则又变成把处置写进事实。
 *
 * 为什么不走 getReportData 全链路：应收来自独立账本表（ledger），
 * 全链路过重且容易测到错分支（第一版就栽在这）。抽成纯函数后直接测这一步。
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
    data: { email: "rep@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { applyApprovedWriteOffs } = await import("@/server/reports/writeoff-align");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

async function seedCase() {
  const client = await prisma.client.create({
    data: { name: uid("报表客户"), type: "COMPANY", cooperationStatus: "SIGNED" }
  });
  const matter = await prisma.matter.create({
    data: {
      internalCode: uid("LL-"), title: "报表坏账案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId: STAFF.id, primaryClientId: client.id, customValues: {}
    }
  });
  return { client, matter };
}

const row = (clientId: string, balance = 10_000) => ({ clientId, writeOff: 0, balance, receivable: 10_000 });

describe("报表客户余额扣减坏账", () => {
  it("PENDING 不扣；APPROVED 才扣，且 receivable 不变", async () => {
    const { client, matter } = await seedCase();
    const pending = await prisma.receivableWriteOff.create({
      data: { matterId: matter.id, amount: 3000, reason: "OTHER", requestedById: STAFF.id }
    });

    let r = row(client.id);
    await applyApprovedWriteOffs([r]);
    expect(r.writeOff).toBe(0);
    expect(r.balance).toBe(10_000);

    await prisma.receivableWriteOff.update({
      where: { id: pending.id },
      data: { status: "APPROVED", decidedById: STAFF.id, decidedAt: new Date() }
    });

    r = row(client.id);
    await applyApprovedWriteOffs([r]);
    expect(r.writeOff).toBe(3000);
    expect(r.balance).toBe(7000);
    // 应收发生额不变：坏账是处置，不是历史
    expect(r.receivable).toBe(10_000);
  });

  it("坏账超过余额时钳到 0（不出现负数应收）", async () => {
    const { client, matter } = await seedCase();
    await prisma.receivableWriteOff.create({
      data: {
        matterId: matter.id, amount: 25_000, reason: "WAIVED",
        status: "APPROVED", requestedById: STAFF.id, decidedById: STAFF.id, decidedAt: new Date()
      }
    });
    const r = row(client.id);
    await applyApprovedWriteOffs([r]);
    expect(r.balance).toBe(0);
  });

  it("多笔已批准坏账累加", async () => {
    const { client, matter } = await seedCase();
    for (const amt of [1000, 2000]) {
      await prisma.receivableWriteOff.create({
        data: {
          matterId: matter.id, amount: amt, reason: "OTHER",
          status: "APPROVED", requestedById: STAFF.id, decidedById: STAFF.id, decidedAt: new Date()
        }
      });
    }
    const r = row(client.id);
    await applyApprovedWriteOffs([r]);
    expect(r.writeOff).toBe(3000);
    expect(r.balance).toBe(7000);
  });

  it("没有坏账的客户不受影响（不写 0 覆盖原值）", async () => {
    const { client } = await seedCase();
    const r = row(client.id, 8888);
    await applyApprovedWriteOffs([r]);
    expect(r.writeOff).toBe(0);
    expect(r.balance).toBe(8888);
  });

  it("空数组直接返回（不查库）", async () => {
    await expect(applyApprovedWriteOffs([])).resolves.toEqual([]);
  });
});
