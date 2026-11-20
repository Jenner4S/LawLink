"use server";

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { parseInput } from "@/lib/parse-input";

import { ActionError } from "@/lib/action-error";
import { assertMatterWritable } from "@/lib/archive/guard";
import { requireSession } from "@/lib/auth/session";
import { decimalToNumber } from "@/lib/decimal";
import { assertCanHandleMatter, assertCanReadMatter } from "@/lib/permissions";
import { civilFromKey, civilKey, shDayKey } from "@/lib/ui/sh-time";
import { audit } from "@/server/audit";
import { revalidateMatter } from "@/server/matters/route";
import { prisma } from "@/lib/prisma";
import { createTimeEntry, getMatterTimeSummary } from "./entries";
import { resolveRate, billableMinutesOf, amountOf } from "./rate";

/**
 * 工时登记的 Server Action（P0-1 阶段 1-b）。
 *
 * 分工：
 *   - 本层：参数校验（zod，中文提示经 ActionError/ZodError 的 digest 通道到达客户端）、
 *     权限（与案件其他写操作同一口径）、审计、revalidate；
 *   - `./entries.ts`：费率解析、计费进位、金额四舍五入与费率快照——业务计算只在服务层做一次，
 *     页面不复制任何金额算法（AGENTS §三「业务规则一律沉淀到 src/lib 或 src/server」）。
 *
 * 权限复用而非自造：`assertCanHandleMatter`（合伙人全所/其余须经办）是 2026-09-20 A 批
 * 统一后的案件写入口径，工时不是例外；归档案件只读由 `assertMatterWritable` 兜住。
 */

const MAX_MINUTES = 24 * 60;

/** 单条工时的录入参数（分钟为唯一时长口径，小时+分钟在表单侧换算） */
const timeEntryCreateSchema = z
  .object({
    matterId: z.string().trim().min(1, "缺少案件标识"),
    workDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD"),
    minutes: z
      .number({ error: "时长必须是数字" })
      .int({ message: "时长须按整分钟填写" })
      .positive({ message: "时长必须大于 0 分钟" })
      .max(MAX_MINUTES, { message: "单条工时不得超过 24 小时" }),
    narrative: z
      .string()
      .trim()
      .min(1, "工作内容必填")
      .max(2000, "工作内容不超过 2000 字"),
    taskCode: z.string().trim().max(40, "任务分类不超过 40 字").optional().nullable(),
    billable: z.boolean().default(true),
    noChargeReason: z.string().trim().max(200, "不可计费原因不超过 200 字").optional().nullable()
  })
  .refine((v) => v.billable || Boolean((v.noChargeReason ?? "").trim()), {
    message: "标记为不可计费时必须填写原因",
    path: ["noChargeReason"]
  });

export type TimeEntryCreateInput = z.input<typeof timeEntryCreateSchema>;

export type TimeEntryMutationResult = {
  ok: true;
  id: string;
  minutes: number;
  billableMinutes: number;
  amount: number;
  /** 命中的费率层级；NONE 表示全所尚未配置任何费率（金额按 0 记） */
  rateScope: string;
};

export type MatterTimeEntryRow = {
  id: string;
  workDate: Date;
  minutes: number;
  billableMinutes: number;
  narrative: string;
  taskCode: string | null;
  billable: boolean;
  noChargeReason: string | null;
  hourlyRateSnapshot: number;
  amount: number;
  status: string;
  userName: string | null;
  createdAt: Date;
};

export type MatterTimeBoard = {
  entries: MatterTimeEntryRow[];
  summary: {
    entryCount: number;
    actualMinutes: number;
    billableMinutes: number;
    billableAmount: number;
    nonChargeableMinutes: number;
    collectedAmount: number;
  };
};

/** 登记一条工时 */
export async function addTimeEntry(input: TimeEntryCreateInput): Promise<TimeEntryMutationResult> {
  const session = await requireSession("matters.write");
  const data = parseInput(timeEntryCreateSchema, input);

  await assertCanHandleMatter(session.user, data.matterId);
  // 归档只读门禁。allowPrincipal 与上面的 assertCanHandleMatter 同口径（合伙人可办全所案件）：
  // guard 默认只认 owner/member，不加此项会出现「handle 放行、writable 拦住」的自相矛盾。
  await assertMatterWritable(data.matterId, { allowPrincipal: true });

  // 日期合法性用「上海日历日 → 本地正午载体 → 反解」校验：2026-02-31 这类
  // 形式合法但日期不存在的输入会被 Date 归一成 03-03，反解不一致即拒绝。
  const workDate = civilFromKey(data.workDate);
  if (civilKey(workDate) !== data.workDate) throw new ActionError("日期无效，请重新选择");
  if (data.workDate > shDayKey(Date.now())) throw new ActionError("不能登记未来日期的工时");

  // createTimeEntry 的入参校验与上面 zod 完全同规则，此处的 Error 只可能是
  // 并发期间案件被删这类内部异常，交由上层按内部错误处理（不转成用户提示）。
  const created = await createTimeEntry({
    matterId: data.matterId,
    userId: session.user.id,
    userRole: session.user.role,
    workDate,
    minutes: data.minutes,
    narrative: data.narrative,
    taskCode: data.taskCode ?? null,
    billable: data.billable,
    noChargeReason: data.noChargeReason ?? null
  });

  await audit({
    userId: session.user.id,
    action: "TIME_ENTRY_CREATE",
    targetType: "TimeEntry",
    targetId: created.id,
    detail: {
      matterId: data.matterId,
      workDate: data.workDate,
      minutes: created.minutes,
      billableMinutes: created.billableMinutes,
      billable: data.billable,
      noChargeReason: data.noChargeReason ?? null,
      amount: created.amount.toFixed(2),
      rateScope: created.rateScope
    }
  });

  await revalidateMatter(data.matterId);

  return {
    ok: true,
    id: created.id,
    minutes: created.minutes,
    billableMinutes: created.billableMinutes,
    amount: decimalToNumber(created.amount),
    rateScope: created.rateScope
  };
}

/**
 * 可改可删的状态白名单（2026-11-20）
 *
 * 只允许 DRAFT / SUBMITTED。
 *   · APPROVED —— 审批人已经核对过这条工时，改它等于改已认证事实；
 *   · BILLED   —— 已经进账单，改它会让账单金额与工时明细对不上；
 *   · WRITTEN_OFF —— 已作废，留着是审计痕迹。
 * 三种都只能走「作废 + 重新登记」，不允许原地改。
 */
const EDITABLE_STATUSES: readonly string[] = ["DRAFT", "SUBMITTED"];

/** 改工时入参：与登记同规则，但不含 matterId（不允许改挂案件，那会让两个案件的工时账都错） */
const timeEntryUpdateSchema = z
  .object({
    id: z.string().trim().min(1, "缺少工时标识"),
    workDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式应为 YYYY-MM-DD"),
    minutes: z
      .coerce.number()
      .int("分钟数应为整数")
      .min(1, "至少 1 分钟")
      .max(MAX_MINUTES, "单条工时不得到超过 24 小时"),
    narrative: z.string().trim().min(1, "工作内容必填").max(2000, "工作内容不超过 2000 字"),
    taskCode: z.string().trim().max(40).optional().or(z.literal("")),
    billable: z.boolean(),
    noChargeReason: z.string().trim().max(200).optional().or(z.literal("")),
    /** 说明为什么改（非必填，但写进审计便于回溯） */
    changeNote: z.string().trim().max(200).optional().or(z.literal(""))
  })
  .refine((v) => v.billable || (v.noChargeReason ?? "").trim().length > 0, {
    message: "标记为不可计费时必须填写原因",
    path: ["noChargeReason"]
  });

/**
 * 修改一条工时（2026-11-20，P0-1 ⑥）
 *
 * 权限与登记同口径（`assertCanHandleMatter` + `assertMatterWritable`），
 * 但**额外**要求状态可改（见 EDITABLE_STATUSES）。
 *
 * 改动会**重新解析费率并重算金额**——不沿用旧快照：
 * 改了工作日期就可能跨到另一个费率生效期，沿用旧快照会让金额与费率表脱节。
 * 审计里同时记录改前改后，含金额与费率，便于对账时解释差异。
 *
 * 非本人操作时 detail 记 `onBehalfOf`：合伙人代改他人工时是允许的，
 * 但必须能一眼看出「这条不是作者自己改的」。
 */
export async function updateTimeEntry(input: z.input<typeof timeEntryUpdateSchema>) {
  const session = await requireSession("matters.write");
  const data = parseInput(timeEntryUpdateSchema, input);

  const existing = await prisma.timeEntry.findUnique({
    where: { id: data.id },
    select: {
      id: true,
      matterId: true,
      userId: true,
      status: true,
      minutes: true,
      billableMinutes: true,
      billable: true,
      narrative: true,
      workDate: true,
      amount: true,
      hourlyRateSnapshot: true
    }
  });
  if (!existing) throw new ActionError("工时不存在或已被删除");

  await assertCanHandleMatter(session.user, existing.matterId);
  await assertMatterWritable(existing.matterId, { allowPrincipal: true });

  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new ActionError(
      existing.status === "BILLED"
        ? "这条工时已进账单，不能直接修改；如需更正请作废后重新登记"
        : existing.status === "APPROVED"
          ? "这条工时已审批，不能直接修改；如需更正请作废后重新登记"
          : "当前状态不可修改"
    );
  }

  const workDate = civilFromKey(data.workDate);
  if (civilKey(workDate) !== data.workDate) throw new ActionError("日期无效，请重新选择");
  if (data.workDate > shDayKey(Date.now())) throw new ActionError("不能登记未来日期的工时");

  const matter = await prisma.matter.findFirst({
    where: { id: existing.matterId, deletedAt: null },
    select: { primaryClientId: true }
  });
  if (!matter) throw new ActionError("案件不存在或已删除");

  const rate = await resolveRate({
    matterId: existing.matterId,
    clientId: matter.primaryClientId,
    userId: existing.userId,
    role: session.user.role,
    workDate
  });
  const billableMinutes = data.billable ? billableMinutesOf(data.minutes, rate.billingIncrement) : 0;
  const amount = data.billable && rate.configured ? amountOf(billableMinutes, rate.hourlyRate) : new Prisma.Decimal(0);

  await prisma.timeEntry.update({
    where: { id: data.id },
    data: {
      workDate,
      minutes: data.minutes,
      billableMinutes,
      narrative: data.narrative.trim(),
      taskCode: data.taskCode?.trim() || null,
      billable: data.billable,
      noChargeReason: data.billable ? null : (data.noChargeReason ?? "").trim(),
      rateScheduleId: rate.scheduleId,
      hourlyRateSnapshot: rate.hourlyRate,
      amount
    }
  });

  await audit({
    userId: session.user.id,
    action: "TIME_ENTRY_UPDATE",
    targetType: "TimeEntry",
    targetId: data.id,
    detail: {
      matterId: existing.matterId,
      authorId: existing.userId,
      // 非本人操作时留痕：合伙人可代改，但必须看得出不是作者自己改的
      ...(existing.userId === session.user.id ? {} : { onBehalfOf: existing.userId }),
      before: {
        workDate: civilKey(existing.workDate),
        minutes: existing.minutes,
        billableMinutes: existing.billableMinutes,
        billable: existing.billable,
        narrative: existing.narrative.slice(0, 200),
        amount: existing.amount.toFixed(2),
        hourlyRate: existing.hourlyRateSnapshot.toFixed(2)
      },
      after: {
        workDate: data.workDate,
        minutes: data.minutes,
        billableMinutes,
        billable: data.billable,
        narrative: data.narrative.trim().slice(0, 200),
        amount: amount.toFixed(2),
        hourlyRate: rate.hourlyRate.toFixed(2)
      },
      changeNote: data.changeNote?.trim() || null
    }
  });

  await revalidateMatter(existing.matterId);
  return { ok: true as const, amount: decimalToNumber(amount), billableMinutes };
}

/**
 * 删除一条工时（2026-11-20，P0-1 ⑥）
 *
 * 同样是硬删除 + 状态守卫。删除是**物理删除**，所以审计里必须留下
 * 足以重建这条记录的全部字段（工时、金额、费率、内容）——
 * 否则「删了一条工时」在事后无法解释，而这正是工时争议最常见的问题。
 */
export async function deleteTimeEntry(id: string) {
  const session = await requireSession("matters.write");
  const entryId = String(id ?? "").trim();
  if (!entryId) throw new ActionError("缺少工时标识");

  const existing = await prisma.timeEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      matterId: true,
      userId: true,
      status: true,
      workDate: true,
      minutes: true,
      billableMinutes: true,
      billable: true,
      narrative: true,
      taskCode: true,
      noChargeReason: true,
      amount: true,
      hourlyRateSnapshot: true
    }
  });
  if (!existing) throw new ActionError("工时不存在或已被删除");

  await assertCanHandleMatter(session.user, existing.matterId);
  await assertMatterWritable(existing.matterId, { allowPrincipal: true });

  if (!EDITABLE_STATUSES.includes(existing.status)) {
    throw new ActionError(
      existing.status === "BILLED"
        ? "这条工时已进账单，不能删除；如需更正请作废后重新登记"
        : existing.status === "APPROVED"
          ? "这条工时已审批，不能删除；如需更正请作废后重新登记"
          : "当前状态不可删除"
    );
  }

  await prisma.timeEntry.delete({ where: { id: entryId } });

  await audit({
    userId: session.user.id,
    action: "TIME_ENTRY_DELETE",
    targetType: "TimeEntry",
    targetId: entryId,
    detail: {
      matterId: existing.matterId,
      authorId: existing.userId,
      ...(existing.userId === session.user.id ? {} : { onBehalfOf: existing.userId }),
      // 硬删除：留足重建所需字段
      deleted: {
        workDate: civilKey(existing.workDate),
        minutes: existing.minutes,
        billableMinutes: existing.billableMinutes,
        billable: existing.billable,
        narrative: existing.narrative.slice(0, 500),
        taskCode: existing.taskCode,
        noChargeReason: existing.noChargeReason,
        amount: existing.amount.toFixed(2),
        hourlyRate: existing.hourlyRateSnapshot.toFixed(2),
        status: existing.status
      }
    }
  });

  await revalidateMatter(existing.matterId);
  return { ok: true as const };
}

/**
 * 案件工时页签的取数：列表 + 三角汇总（已投入 / 折算金额 / 已收）。
 *
 * 可见性跟随案件：`assertCanReadMatter` 与案件详情页同一断言（含归档借阅兜底分支），
 * 不另造可见性规则。
 */
export async function getMatterTimeBoard(matterId: string): Promise<MatterTimeBoard> {
  const session = await requireSession("matters.read");
  await assertCanReadMatter(session.user.id, session.user.role, matterId, session.user.rolePermissions);

  const [rows, summary] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { matterId },
      orderBy: [{ workDate: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        workDate: true,
        minutes: true,
        billableMinutes: true,
        narrative: true,
        taskCode: true,
        billable: true,
        noChargeReason: true,
        hourlyRateSnapshot: true,
        amount: true,
        status: true,
        createdAt: true,
        user: { select: { name: true } }
      }
    }),
    getMatterTimeSummary(matterId)
  ]);

  return {
    entries: rows.map((r) => ({
      id: r.id,
      workDate: r.workDate,
      minutes: r.minutes,
      billableMinutes: r.billableMinutes,
      narrative: r.narrative,
      taskCode: r.taskCode,
      billable: r.billable,
      noChargeReason: r.noChargeReason,
      hourlyRateSnapshot: decimalToNumber(r.hourlyRateSnapshot),
      amount: decimalToNumber(r.amount),
      status: r.status,
      userName: r.user?.name ?? null,
      createdAt: r.createdAt
    })),
    summary: {
      entryCount: summary.entryCount,
      actualMinutes: summary.actualMinutes,
      billableMinutes: summary.billableMinutes,
      billableAmount: decimalToNumber(summary.billableAmount),
      nonChargeableMinutes: summary.nonChargeableMinutes,
      collectedAmount: decimalToNumber(summary.collectedAmount)
    }
  };
}
