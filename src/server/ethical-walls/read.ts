import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import { denialTargetLabel, wallStatusOf } from "./labels";
import type { DenyType } from "./schemas";

/**
 * 隔离墙（Ethical Wall）的**读取侧摘要**——给「能看这个案子的人」看的知情提示。
 *
 * 与三个相邻模块的分工：
 *   - `src/lib/permissions/ethical-wall.ts`：**拦截**。把墙叠加进 MatterWhereInput，
 *     被隔离者查不到案件、直访 404（不泄露案件存在性，这是对的）。
 *   - `src/server/ethical-walls/actions.ts`：**维护**。建墙 / 解除 / 管理列表，含权限与审计。
 *   - 本模块：**知情**。回答「这个案子现在有没有墙、挡了谁」，供案件详情页在页首标注。
 *
 * 为什么需要这一层（业务后果，不是锦上添花）：
 *   隔离墙只挡住「看」，挡不住「说」。能看案的律师不知道有墙，就会把材料转给被隔离的同事、
 *   或者在群里讨论——隔离形同虚设；管理者也不知道哪些案子处于隔离状态，无法巡检。
 *   被隔离者继续只看到 404（不泄露），但有权看案的人应当知道「发材料前要小心」。
 *
 * 三条口径：
 *   1. **只统计生效中的墙**：`active=true` 且未过期。已解除的（有人签字解封）与已过期的
 *      （自动失效）都不进摘要——它们不是当前的限制，写进提示条等于制造假警报。
 *   2. **不返回任何 id**。前端只需要一句中文，不需要 userId/teamId；少给一个字段就少一条
 *      可被复制出去的线索（这也是隔离墙「最小披露」原则的延续）。
 *   3. **本函数不做权限判断**。调用方（案件详情页）必须已经通过 getMatterById 完成读鉴权，
 *      否则「谁能读案」的两套口径会分叉。这里只按 matterId 取数。
 */

export type EthicalWallSummary = {
  /** 该案是否存在生效中的隔离墙 */
  hasWall: boolean;
  /** 生效中的墙数量（一堵墙可以同时挡多人/多团队/多岗位） */
  wallCount: number;
  /** 生效中墙的隔离理由（去重，按建墙时间先后）。多堵墙时按序返回，供页面展示首条 + 「等 N 条」 */
  reasons: string[];
  /** 被隔离对象的中文可读描述，去重。如「李东豪」「商事争议团队（团队）」「全所「授薪律师」」 */
  deniedSummary: string[];
};

/** 空摘要：无墙时页面直接不渲染提示条。每次返回新对象，避免调用方改写共享常量。 */
function emptySummary(): EthicalWallSummary {
  return { hasWall: false, wallCount: 0, reasons: [], deniedSummary: [] };
}

/**
 * 查摘要用的选择集：刻意**不选** userId / teamId / wallId。
 * 只取展示需要的中文名与状态（人员/团队的 active 用于标注「账号停用」）。
 */
const WALL_SUMMARY_SELECT = {
  reason: true,
  active: true,
  expiresAt: true,
  denials: {
    select: {
      denyType: true,
      role: true,
      user: { select: { name: true, active: true } },
      team: { select: { name: true, active: true } }
    }
  }
} satisfies Prisma.EthicalWallSelect;

/** 保序去重：提示条里同一人被两堵墙挡住只该出现一次 */
function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * 取该案当前生效的隔离墙摘要。
 *
 * @param matterId 案件 id（调用方已鉴权）
 * @param options.now 判定时刻，默认当前。提出来是为了让测试能注入固定时刻——
 *   否则「已过期」的边界（expiresAt 恰好等于 now）每次跑都可能落在不同侧。
 */
export async function getWallSummaryForMatter(
  matterId: string,
  options: { now?: Date } = {}
): Promise<EthicalWallSummary> {
  if (!matterId) return emptySummary();

  const now = options.now ?? new Date();

  const rows = await prisma.ethicalWall.findMany({
    where: {
      matterId,
      active: true,
      // 有效期口径与 ethicalWallExclusion 一致：为空＝永久，否则必须晚于 now
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    },
    // id 作为次级排序键：同一毫秒建的两堵墙也要有稳定顺序，
    // 否则理由列表在两次渲染间可能互换（提示条只展示首条）
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: WALL_SUMMARY_SELECT
  });

  // 数据库条件已下推，这里再按同一个 now 复核一次：边界（expiresAt 恰好等于 now）
  // 在 SQL 的 gt 与 JS 的 <= 之间必须同侧，且测试注入 now 时可验证这层语义。
  const live = rows.filter((row) => wallStatusOf(row, now) === "ACTIVE");
  if (live.length === 0) return emptySummary();

  const reasons = uniqueInOrder(live.map((row) => row.reason.trim()));

  const deniedSummary = uniqueInOrder(
    live.flatMap((row) =>
      row.denials.map((denial) =>
        denialTargetLabel({
          denyType: denial.denyType as DenyType,
          userName: denial.user?.name,
          userActive: denial.user?.active,
          teamName: denial.team?.name,
          teamActive: denial.team?.active,
          role: denial.role
        })
      )
    )
  );

  return {
    // 只要有一堵生效的墙即为真——哪怕 denials 为空（数据异常，界面会在计数上留白，
    // 不假装「没人受限」：空 denials 的墙挡不住任何人，但记录本身仍需被管理者看到）
    hasWall: live.length > 0,
    wallCount: live.length,
    reasons,
    deniedSummary
  };
}
