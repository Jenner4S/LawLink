// @vitest-environment node
/**
 * 排期冲突检测（真库，2026-11-21）
 *
 * 产品计划 阶段 1 · D09：「排期冲突检测（同一律师同一时段两个庭）」。
 *
 * 三条口径各自都能搞错，所以逐条钉住：
 *   ① **只比同一律师**——冲突的定义是人的时间，不是案子的时间。
 *      不同律师同一时段开庭不是冲突。
 *   ② **半开区间**——一个 10:00 结束、另一个 10:00 开始**不算**冲突。
 *      （判成冲突会让律师疲于应付假警报，最后忽略所有提示。）
 *   ③ **endsAt 为空时按默认时长估算，并标记 estimated**——
 *      估算就是估算，不能让调用方以为那是库里的事实。
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

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const { findHearingConflicts, DEFAULT_HEARING_MINUTES } = await import("@/server/procedures/hearing-conflicts");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

const T = (hhmm: string) => new Date(`2026-12-01T${hhmm}:00+08:00`);

async function seedLawyer(name: string) {
  return prisma.user.create({
    data: { email: `${uid("e")}@t.local`, name, role: "LAWYER", passwordHash: "x", active: true }
  });
}

async function seedMatterWithHearing(
  ownerId: string,
  args: { startsAt: Date; endsAt?: Date | null; title?: string; code?: string }
) {
  const matter = await prisma.matter.create({
    data: {
      internalCode: args.code ?? uid("LL-"), title: "冲突测试案", category: "CIVIL_COMMERCIAL",
      status: "IN_PROGRESS", serviceStatus: "SERVICE_ACTIVE",
      teamAccessRestricted: false, counterclaimAsPlaintiff: false, counterclaimAsDefendant: false,
      ownerId, customValues: {}
    }
  });
  const procedure = await prisma.matterProcedure.create({
    data: { matterId: matter.id, type: "FIRST_INSTANCE", engagement: "ENGAGED", order: 1 }
  });
  const hearing = await prisma.hearing.create({
    data: {
      procedureId: procedure.id,
      title: args.title ?? "开庭",
      startsAt: args.startsAt,
      endsAt: args.endsAt ?? null
    }
  });
  return { matter, procedure, hearing };
}

// 不做批量清理：临时库按文件隔离，且每条用例都造独立律师+案件，
// 查询按 lawyerId 过滤，互不干扰。批量删反而会撞外键（hearing 被其它表引用）。
beforeEach(() => { /* no-op：见上 */ });

describe("排期冲突判定", () => {
  it("同一律师时段重叠 → 命中冲突，带案号与案名", async () => {
    const lawyer = await seedLawyer("张律师");
    const existing = await seedMatterWithHearing(lawyer.id, {
      startsAt: T("09:00"), endsAt: T("11:00"), title: "一审开庭", code: "LL-2026-T-001"
    });

    const conflicts = await findHearingConflicts({
      lawyerId: lawyer.id, startsAt: T("10:00"), endsAt: T("12:00")
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].hearingId).toBe(existing.hearing.id);
    expect(conflicts[0].matterCode).toBe("LL-2026-T-001");
    expect(conflicts[0].title).toBe("一审开庭");
    expect(conflicts[0].estimated).toBe(false);
  });

  it("首尾相接不算冲突（半开区间）：10:00 结束 vs 10:00 开始", async () => {
    const lawyer = await seedLawyer("李律师");
    await seedMatterWithHearing(lawyer.id, { startsAt: T("09:00"), endsAt: T("10:00") });

    const conflicts = await findHearingConflicts({
      lawyerId: lawyer.id, startsAt: T("10:00"), endsAt: T("11:00")
    });
    expect(conflicts).toHaveLength(0);
  });

  it("不同律师同一时段不算冲突（冲突是人的时间，不是案子的时间）", async () => {
    const a = await seedLawyer("王律师");
    const b = await seedLawyer("赵律师");
    await seedMatterWithHearing(a.id, { startsAt: T("09:00"), endsAt: T("11:00") });

    const conflicts = await findHearingConflicts({
      lawyerId: b.id, startsAt: T("10:00"), endsAt: T("12:00")
    });
    expect(conflicts).toHaveLength(0);
  });

  it("既有开庭无 endsAt → 按默认时长估算并标记 estimated", async () => {
    const lawyer = await seedLawyer("周律师");
    await seedMatterWithHearing(lawyer.id, { startsAt: T("09:00"), endsAt: null });

    // 默认 120 分钟 → 占 09:00–11:00；查 10:30 起（落在估算窗口内）
    const conflicts = await findHearingConflicts({
      lawyerId: lawyer.id, startsAt: T("10:30"), endsAt: T("11:30")
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].estimated).toBe(true);
    expect(conflicts[0].endsAt.getTime()).toBe(T("09:00").getTime() + DEFAULT_HEARING_MINUTES * 60_000);
  });

  it("编排自身时排除自己（编辑场景不会自我冲突）", async () => {
    const lawyer = await seedLawyer("吴律师");
    const mine = await seedMatterWithHearing(lawyer.id, { startsAt: T("09:00"), endsAt: T("11:00") });

    const withSelf = await findHearingConflicts({
      lawyerId: lawyer.id, startsAt: T("09:30"), endsAt: T("10:30"), excludeHearingId: mine.hearing.id
    });
    expect(withSelf).toHaveLength(0);
  });

  it("多条冲突按开始时间排序返回", async () => {
    const lawyer = await seedLawyer("郑律师");
    await seedMatterWithHearing(lawyer.id, { startsAt: T("11:00"), endsAt: T("13:00"), title: "第二个庭" });
    await seedMatterWithHearing(lawyer.id, { startsAt: T("09:00"), endsAt: T("10:30"), title: "第一个庭" });

    const conflicts = await findHearingConflicts({
      lawyerId: lawyer.id, startsAt: T("09:30"), endsAt: T("12:00")
    });
    expect(conflicts.map((c) => c.title)).toEqual(["第一个庭", "第二个庭"]);
  });
});
