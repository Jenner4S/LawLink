// @vitest-environment node
/**
 * 已谈案未转收案的积压（真库，2026-11-23）
 *
 * 漏斗里「已谈案」是中间态：谈完不等于签下。
 * 提醒链只管邀约到店之前，**谈案之后没有任何机制** ——
 * 谈完当场没签，忙起来就忘了，三个月后还挂在"已谈案"。
 *
 * 四条口径：
 *  ① 只看 stage=CONSULTED 且未转收案；
 *  ② 以 consultedAt 起算，缺则用 updatedAt 兜底（历史数据可能没记谈案时间）；
 *  ③ 只列等待 ≥ days 天（默认 3：当天谈完当天转是正常节奏）；
 *  ④ 按等待天数从长到短（最该催的排最前）。
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
    data: { email: "sc@t.local", name: "张三", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => { await prisma.lead.deleteMany({}); });

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { getStaleConsultedLeads } = await import("@/server/leads/stale-consulted");
const { addLeadActivity } = await import("@/server/leads/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;
const NOW = new Date("2026-11-23T09:00:00+08:00");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

async function seed(opts: { consultedAt?: Date | null; stage?: string; name?: string; convertedIntakeId?: string | null; updatedAt?: Date }) {
  const consultedAt = opts.consultedAt === undefined ? daysAgo(5) : opts.consultedAt;
  return prisma.lead.create({
    data: {
      name: opts.name ?? uid("线索"),
      phone: `1390000${String(9500 + seq)}`,
      ownerId: STAFF.id,
      stage: (opts.stage ?? "CONSULTED") as never,
      consultedAt,
      // 关键：真实场景里"谈完就没再动"，说明谈案那次 update 也把 updatedAt 推到了谈案时间。
      // 第一版没设它，Prisma 默认给了 now()，于是"最后动静"是刚刚 → 判定不该积压（测试全绿变全红）。
      updatedAt: opts.updatedAt ?? (consultedAt ?? daysAgo(5))
      ,
      ...(opts.convertedIntakeId === undefined ? {} : { convertedIntakeId: opts.convertedIntakeId })
    }
  });
}

describe("已谈案未转收案", () => {
  it("谈了 5 天的列出来，等 5 天", async () => {
    const l = await seed({ consultedAt: daysAgo(5), name: "五天后" });
    const rows = await getStaleConsultedLeads(3, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(l.id);
    expect(rows[0].waitingDays).toBe(5);
  });

  it("**刚谈完不到 3 天的不列**（当天谈完当天转是正常节奏）", async () => {
    await seed({ consultedAt: daysAgo(1) });
    expect(await getStaleConsultedLeads(3, NOW)).toHaveLength(0);
  });

  it("**已转收案的不列**（已经不是漏损候选）", async () => {
    const client = await prisma.client.create({
      data: { name: uid("客户"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
    });
    const intake = await prisma.intake.create({
      data: { title: uid("收案"), category: "CIVIL_COMMERCIAL", status: "PENDING_CONFIRMATION", createdById: STAFF.id, clientId: client.id }
    });
    await seed({ consultedAt: daysAgo(9), convertedIntakeId: intake.id });
    expect(await getStaleConsultedLeads(3, NOW)).toHaveLength(0);
  });

  it("**非「已谈案」阶段不列**（到店/邀约归未来待上门那套）", async () => {
    await seed({ stage: "VISITED", consultedAt: daysAgo(9) });
    await seed({ stage: "INVITED", consultedAt: daysAgo(9) });
    expect(await getStaleConsultedLeads(3, NOW)).toHaveLength(0);
  });

  it("**没记谈案时间的老数据用 updatedAt 兜底**（不然会永远看不见）", async () => {
    const l = await prisma.lead.create({
      data: {
        name: uid("老线索"), phone: "13900009601", ownerId: STAFF.id,
        stage: "CONSULTED" as never, consultedAt: null,
        createdAt: daysAgo(30), updatedAt: daysAgo(7)
      }
    });
    const rows = await getStaleConsultedLeads(3, NOW);
    expect(rows.map((r) => r.id)).toContain(l.id);
    expect(rows.find((r) => r.id === l.id)!.waitingDays).toBe(7);
  });

  it("按等待天数从长到短（最该催的排最前）", async () => {
    await seed({ consultedAt: daysAgo(4), name: "四天" });
    await seed({ consultedAt: daysAgo(20), name: "二十天" });
    await seed({ consultedAt: daysAgo(9), name: "九天" });
    const rows = await getStaleConsultedLeads(3, NOW);
    expect(rows.map((r) => r.waitingDays)).toEqual([20, 9, 4]);
  });
});

/**
 * 催办（2026-11-23）：积压行上的「催办」按钮走的是既有 `addLeadActivity(CONTACT)`。
 *
 * 这里验证它的**副作用正好等于催办的含义**：
 *  · 记一条跟进（可追溯"我催过"）；
 *  · **不改阶段**（催办不是谈案也不是转案）；
 *  · 刷新 `updatedAt`，于是该线索自然从"超 3 天没动静"里掉出去。
 */
describe("催办副作用", () => {
  it("催办后：记一条 CONTACT、阶段不变、从积压清单消失", async () => {
    const l = await seed({ consultedAt: daysAgo(5), name: "待催甲" });
    expect((await getStaleConsultedLeads(3, NOW)).map((r) => r.id)).toContain(l.id);

    await addLeadActivity({ leadId: l.id, type: "CONTACT", note: "催办：谈案后 5 天仍未转收案" });

    const after = await prisma.lead.findUniqueOrThrow({ where: { id: l.id } });
    expect(after.stage).toBe("CONSULTED");          // 阶段不变
    expect(after.consultedAt?.getTime()).toBe(l.consultedAt!.getTime()); // 谈案时间不被覆盖

    const acts = await prisma.leadActivity.findMany({ where: { leadId: l.id } });
    expect(acts.some((a) => a.type === "CONTACT" && (a.note ?? "").includes("催办"))).toBe(true);

    // updatedAt 被刷新 → 用 now 再查积压，该线索不再出现
    const now2 = new Date();
    expect((await getStaleConsultedLeads(3, now2)).map((r) => r.id)).not.toContain(l.id);
  });

  it("已转收案的线索催办被拒（不在积压里，也不该再记跟进）", async () => {
    const client = await prisma.client.create({
      data: { name: uid("客户2"), type: "INDIVIDUAL", cooperationStatus: "SIGNED" }
    });
    const intake = await prisma.intake.create({
      data: { title: uid("收案2"), category: "CIVIL_COMMERCIAL", status: "PENDING_CONFIRMATION", createdById: STAFF.id, clientId: client.id }
    });
    // 真实形态：转案时 stage 同步为 CONVERTED（不只是填 convertedIntakeId）。
    // 我第一版只填了 intakeId、stage 仍是 CONSULTED，测出来"没被拒"——
    // 那不是实现漏了拒绝，是我造的数据不符合真实状态。
    const l = await prisma.lead.create({
      data: {
        name: uid("已转案"), phone: `1390000${String(9800 + seq)}`, ownerId: STAFF.id,
        stage: "CONVERTED" as never, consultedAt: daysAgo(9), convertedIntakeId: intake.id
      }
    });
    await expect(
      addLeadActivity({ leadId: l.id, type: "CONTACT", note: "催办" })
    ).rejects.toThrow(/已转为收案/);
  });
});
