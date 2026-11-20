/**
 * 排期冲突检测（2026-11-21，产品计划 阶段 1 · D09）
 *
 * 产品计划点名：「排期冲突检测（同一律师同一时段两个庭）」。
 * 此前完全没有——律师同一天被排在两个法院，只能靠人自己发现。
 *
 * ## 三条设计决定（都有取舍，写在这里）
 *
 * ① **只警告，不阻断**。
 *    开庭时间是**法院定的**，不是律所排的。系统拒绝录入，只会让人把真实开庭
 *    记到别处（便签、日历），反而更危险。所以 `addHearing` 照常写入，
 *    把冲突作为返回值带回给界面提示。
 *
 * ② **时段重叠用「显式 endsAt 优先，否则给一个默认时长」**。
 *    Hearing.endsAt 是可空的（很多法院排期不告结束时间）。
 *    没有 endsAt 时按 `DEFAULT_HEARING_MINUTES` 估一段，并在结果里标
 *    `estimated: true`——估算就是估算，不能让它看起来像事实。
 *
 * ③ **只比「同一律师」**，比的是承办关系（Matter.ownerId）。
 *    不按案件、不按法院——冲突的定义是人的时间，不是案子的时间。
 *    （同一律师在 A 案开庭与 B 案开庭撞车，正是要发现的那种。）
 *
 * ## 已知边界
 *
 * · 不做跨时区换算：本系统时间统一按上海处理（sh-time），故直接比较绝对时刻。
 * · 不做路程/间隔余量：两个庭隔 30 分钟在现实里也来不及，但系统不知道
 *   法院之间距离，硬加余量是拍脑袋。留给使用人判断。
 * · 只看承办律师；团队成员（协办）之间的撞车不在本检测范围。
 */

import { prisma } from "@/lib/prisma";

/** 开庭未填 endsAt 时，按此估算占用时长 */
export const DEFAULT_HEARING_MINUTES = 120;

export type HearingConflict = {
  hearingId: string;
  matterId: string;
  matterCode: string;
  matterTitle: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  /** 该条结束时间是否由默认时长估算而来（不是库里的事实） */
  estimated: boolean;
  /** 承办律师 */
  lawyerId: string;
  lawyerName: string;
};

type Args = {
  /** 承办律师（当前案件的 ownerId） */
  lawyerId: string;
  startsAt: Date;
  endsAt?: Date | null;
  /** 编辑场景下排除自身 */
  excludeHearingId?: string;
};

function endOf(startsAt: Date, endsAt: Date | null | undefined) {
  if (endsAt) return { end: endsAt, estimated: false };
  return { end: new Date(startsAt.getTime() + DEFAULT_HEARING_MINUTES * 60_000), estimated: true };
}

/**
 * 查找与给定时段重叠的、同一律师的其他开庭。
 * 重叠判定：`aStart < bEnd && bStart < aEnd`（半开区间，首尾相接不算冲突）。
 */
export async function findHearingConflicts({ lawyerId, startsAt, endsAt, excludeHearingId }: Args): Promise<HearingConflict[]> {
  const self = endOf(startsAt, endsAt);

  // 只扫同一律师承办案件的、可能重叠的开庭。
  // 用「同一天 ±1 天」预筛，避免全表扫描（跨日开庭由精确比较兜住）。
  const windowStart = new Date(self.end.getTime() - 24 * 60 * 60 * 1000);
  const windowEnd = new Date(startsAt.getTime() + 24 * 60 * 60 * 1000);

  const rows = await prisma.hearing.findMany({
    where: {
      procedure: { matter: { ownerId: lawyerId, deletedAt: null } },
      startsAt: { gte: windowStart, lte: windowEnd },
      ...(excludeHearingId ? { id: { not: excludeHearingId } } : {})
    },
    select: {
      id: true,
      title: true,
      startsAt: true,
      endsAt: true,
      procedure: {
        select: {
          matter: {
            select: { id: true, internalCode: true, title: true, ownerId: true, owner: { select: { name: true } } }
          }
        }
      }
    }
  });

  const conflicts: HearingConflict[] = [];
  for (const row of rows) {
    const other = endOf(row.startsAt, row.endsAt);
    // 半开区间重叠：首尾相接（一个 10:00 结束、另一个 10:00 开始）不算冲突
    const overlap = startsAt.getTime() < other.end.getTime() && row.startsAt.getTime() < self.end.getTime();
    if (!overlap) continue;
    conflicts.push({
      hearingId: row.id,
      matterId: row.procedure.matter.id,
      matterCode: row.procedure.matter.internalCode,
      matterTitle: row.procedure.matter.title,
      title: row.title,
      startsAt: row.startsAt,
      endsAt: other.end,
      estimated: other.estimated,
      lawyerId,
      lawyerName: row.procedure.matter.owner.name
    });
  }
  return conflicts.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
