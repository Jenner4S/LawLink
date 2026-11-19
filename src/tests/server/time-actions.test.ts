// @vitest-environment node
/**
 * 工时登记 Server Action 单测（P0-1 阶段 1-b）。
 *
 * 覆盖点（对应验收「action 的参数校验」）：
 * - 参数校验：分钟数为 0/负数/非整数、超过 24 小时、日期形式非法、日期不存在
 *   （2026-02-30）、未来日期、工作内容为空、不可计费无理由——全部在写库之前拒绝；
 * - 业务计算走服务层：90 分钟按 3000 元/小时 = 4500.00，快照随记录落库；
 * - 未配置费率时金额为 0 且回传 rateScope=NONE（页面据此提示，不假装算出金额）；
 * - 权限复用案件写口径：assertCanHandleMatter / assertMatterWritable 任一拒绝即不写库；
 * - 审计：写 TIME_ENTRY_CREATE 并带金额与费率层级；
 * - 读：getMatterTimeBoard 走 assertCanReadMatter，Decimal 转 number。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const { db, session, perms, guard, auditMock, revalidateMock } = vi.hoisted(() => {
  const db: Record<string, any> = {
    matter: { findFirst: vi.fn(), findUnique: vi.fn() },
    timeEntry: { create: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() },
    feeEntry: { aggregate: vi.fn() },
    rateSchedule: { findFirst: vi.fn() }
  };
  return {
    db,
    session: { user: { id: "clawyer0000000000000000001", role: "LAWYER", rolePermissions: undefined } },
    perms: {
      assertCanHandleMatter: vi.fn(async () => {}),
      assertCanReadMatter: vi.fn(async () => {})
    },
    guard: { assertMatterWritable: vi.fn(async () => {}) },
    auditMock: vi.fn(async () => {}),
    revalidateMock: vi.fn(async () => {})
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => session) }));
vi.mock("@/lib/permissions", () => perms);
vi.mock("@/lib/archive/guard", () => guard);
vi.mock("@/server/audit", () => ({ audit: auditMock, auditTx: vi.fn() }));
vi.mock("@/server/matters/route", () => ({ revalidateMatter: revalidateMock }));

import { ActionError } from "@/lib/action-error";
import { addTimeEntry, getMatterTimeBoard } from "@/server/time/actions";

const MATTER = "cmatter00000000000000000001";
const ENTRY = "ctimeen000000000000000000001";
/** 上海「今天」——用服务端同一函数取，任何运行时区下都不会被判成未来日期 */
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function defaultRate(hourlyRate = "3000.00", billingIncrement = 0) {
  db.rateSchedule.findFirst.mockImplementation(async ({ where }: { where: { scope: string } }) =>
    where.scope === "DEFAULT"
      ? { id: "crate000000000000000000001", hourlyRate: new Prisma.Decimal(hourlyRate), billingIncrement }
      : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  perms.assertCanHandleMatter.mockResolvedValue(undefined);
  perms.assertCanReadMatter.mockResolvedValue(undefined);
  guard.assertMatterWritable.mockResolvedValue(undefined);
  db.matter.findFirst.mockResolvedValue({ id: MATTER, primaryClientId: null });
  db.timeEntry.create.mockResolvedValue({ id: ENTRY });
  db.timeEntry.findMany.mockResolvedValue([]);
  db.timeEntry.aggregate.mockResolvedValue({
    _count: { _all: 0 },
    _sum: { minutes: null, billableMinutes: null, amount: null }
  });
  db.feeEntry.aggregate.mockResolvedValue({ _sum: { amount: null } });
  defaultRate();
});

const baseInput = {
  matterId: MATTER,
  workDate: TODAY,
  minutes: 90,
  narrative: "阅卷并梳理证据目录"
};

describe("工时登记 · 参数校验", () => {
  it("分钟数为 0 被拒绝，且不写库", async () => {
    await expect(addTimeEntry({ ...baseInput, minutes: 0 })).rejects.toThrow("时长必须大于 0 分钟");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("分钟数为负被拒绝", async () => {
    await expect(addTimeEntry({ ...baseInput, minutes: -30 })).rejects.toThrow("时长必须大于 0 分钟");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("分钟数非整数被拒绝（时长唯一口径是整分钟）", async () => {
    await expect(addTimeEntry({ ...baseInput, minutes: 90.5 })).rejects.toThrow("时长须按整分钟填写");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("单条超过 24 小时被拒绝", async () => {
    await expect(addTimeEntry({ ...baseInput, minutes: 1441 })).rejects.toThrow("单条工时不得超过 24 小时");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("不可计费但没填原因被拒绝", async () => {
    await expect(
      addTimeEntry({ ...baseInput, billable: false, noChargeReason: "   " })
    ).rejects.toThrow("标记为不可计费时必须填写原因");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("工作内容为空被拒绝", async () => {
    await expect(addTimeEntry({ ...baseInput, narrative: "   " })).rejects.toThrow("工作内容必填");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("日期形式非法被拒绝", async () => {
    await expect(addTimeEntry({ ...baseInput, workDate: "2026/11/19" })).rejects.toThrow("日期格式应为 YYYY-MM-DD");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("形式合法但日期不存在（2026-02-30）被拒绝", async () => {
    await expect(addTimeEntry({ ...baseInput, workDate: "2026-02-30" })).rejects.toThrow("日期无效，请重新选择");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });

  it("未来日期被拒绝", async () => {
    await expect(addTimeEntry({ ...baseInput, workDate: "2999-01-01" })).rejects.toThrow("不能登记未来日期的工时");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });
});

describe("工时登记 · 计算与落库", () => {
  it("90 分钟 × 3000 元/小时 = 4500.00，快照与金额随记录落库", async () => {
    const res = await addTimeEntry(baseInput);

    expect(res).toMatchObject({ ok: true, id: ENTRY, minutes: 90, billableMinutes: 90, amount: 4500, rateScope: "DEFAULT" });
    expect(db.timeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          matterId: MATTER,
          userId: session.user.id,
          minutes: 90,
          billableMinutes: 90,
          billable: true,
          noChargeReason: null,
          narrative: "阅卷并梳理证据目录"
        })
      })
    );
    const written = db.timeEntry.create.mock.calls[0][0].data;
    expect(written.amount.toFixed(2)).toBe("4500.00");
    expect(written.hourlyRateSnapshot.toFixed(2)).toBe("3000.00");
  });

  it("6 分钟进位生效：95 分钟按 96 分钟计", async () => {
    defaultRate("3000.00", 6);
    const res = await addTimeEntry({ ...baseInput, minutes: 95 });

    expect(res.billableMinutes).toBe(96);
    // 96/60 × 3000 = 4800.00
    expect(res.amount).toBe(4800);
  });

  it("不可计费（有理由）：计费分钟记 0、金额记 0，理由落库", async () => {
    const res = await addTimeEntry({
      ...baseInput,
      minutes: 60,
      billable: false,
      noChargeReason: "所内案件讨论"
    });

    expect(res.billableMinutes).toBe(0);
    expect(res.amount).toBe(0);
    expect(db.timeEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billable: false, billableMinutes: 0, noChargeReason: "所内案件讨论" })
      })
    );
  });

  it("全所未配置费率：金额记 0 并回传 rateScope=NONE（页面据此提示，不假装算出金额）", async () => {
    db.rateSchedule.findFirst.mockResolvedValue(null);
    const res = await addTimeEntry(baseInput);

    expect(res.amount).toBe(0);
    expect(res.rateScope).toBe("NONE");
  });

  it("写审计 TIME_ENTRY_CREATE，detail 含金额与费率层级", async () => {
    await addTimeEntry(baseInput);

    // 归档门禁与 assertCanHandleMatter 同口径（allowPrincipal），否则合伙人办他人案件会被自相矛盾地拦住
    expect(guard.assertMatterWritable).toHaveBeenCalledWith(MATTER, { allowPrincipal: true });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: session.user.id,
        action: "TIME_ENTRY_CREATE",
        targetType: "TimeEntry",
        targetId: ENTRY,
        detail: expect.objectContaining({ matterId: MATTER, minutes: 90, amount: "4500.00", rateScope: "DEFAULT" })
      })
    );
    expect(revalidateMock).toHaveBeenCalledWith(MATTER);
  });
});

describe("工时登记 · 权限与状态", () => {
  it("无经办权（assertCanHandleMatter 拒绝）时不写库", async () => {
    perms.assertCanHandleMatter.mockRejectedValue(new ActionError("案件不存在或无权关联"));

    await expect(addTimeEntry(baseInput)).rejects.toThrow("案件不存在或无权关联");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("已归档案件拒绝登记（assertMatterWritable 拦住）", async () => {
    guard.assertMatterWritable.mockRejectedValue(new ActionError("案件已归档，禁止修改"));

    await expect(addTimeEntry(baseInput)).rejects.toThrow("案件已归档");
    expect(db.timeEntry.create).not.toHaveBeenCalled();
  });
});

describe("工时页签取数", () => {
  it("列表与汇总按案件读取，Decimal 转 number", async () => {
    db.timeEntry.findMany.mockResolvedValue([
      {
        id: ENTRY,
        workDate: new Date("2026-11-18T00:00:00Z"),
        minutes: 95,
        billableMinutes: 96,
        narrative: "开庭准备",
        taskCode: "开庭",
        billable: true,
        noChargeReason: null,
        hourlyRateSnapshot: new Prisma.Decimal("3000.00"),
        amount: new Prisma.Decimal("4800.00"),
        status: "DRAFT",
        createdAt: new Date("2026-11-18T02:00:00Z"),
        user: { name: "叶森" }
      }
    ]);
    db.timeEntry.aggregate
      .mockResolvedValueOnce({ _count: { _all: 1 }, _sum: { minutes: 95, billableMinutes: 96, amount: new Prisma.Decimal("4800.00") } })
      .mockResolvedValueOnce({ _sum: { minutes: 0 } });
    db.feeEntry.aggregate.mockResolvedValue({ _sum: { amount: new Prisma.Decimal("2000.00") } });

    const board = await getMatterTimeBoard(MATTER);

    expect(perms.assertCanReadMatter).toHaveBeenCalledWith(session.user.id, session.user.role, MATTER, session.user.rolePermissions);
    expect(board.entries[0]).toMatchObject({
      id: ENTRY,
      userName: "叶森",
      minutes: 95,
      billableMinutes: 96,
      amount: 4800,
      hourlyRateSnapshot: 3000,
      status: "DRAFT"
    });
    expect(board.summary).toEqual({
      entryCount: 1,
      actualMinutes: 95,
      billableMinutes: 96,
      billableAmount: 4800,
      nonChargeableMinutes: 0,
      collectedAmount: 2000
    });
  });

  it("无权读取（assertCanReadMatter 拒绝）时报错，不返回数据", async () => {
    perms.assertCanReadMatter.mockRejectedValue(new ActionError("案件不存在"));

    await expect(getMatterTimeBoard(MATTER)).rejects.toThrow("案件不存在");
    expect(db.timeEntry.findMany).not.toHaveBeenCalled();
  });
});
