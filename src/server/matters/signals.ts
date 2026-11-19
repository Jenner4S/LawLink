import { prisma } from "@/lib/prisma";

/**
 * 案件信号条数据（墨案 04 ②）。
 *
 * 为什么不复用案件详情里已有的 `procedures` 查询：
 * 那份 select 是为「程序卡片列表」裁剪过的——hearings 只取 1 条且只有 startsAt、
 * deadlines 只取 1 条未完成、stages 不带 tasks。信号条需要「四卡」的完整口径
 * （最近期限的类别与确认状态、下次开庭的法庭、本环节的待办任务），
 * 硬塞进原查询会让列表页为详情页的需求付出代价。
 *
 * 因此这里单独聚合，页面对本函数的结果只用于渲染信号条。
 */

export type SignalDeadline = {
  id: string;
  title: string;
  category: string;
  dueAt: Date;
  completed: boolean;
  basis: string | null;
  confirmStatus: string;
};

export type SignalHearing = { id: string; title: string; startsAt: Date; room: string | null };
export type SignalStage = { status: string; tasks: { title: string; completed: boolean; dueAt: Date | null }[] };

export type SignalProcedure = {
  id: string;
  /** 程序状态：页面据此挑「当前程序」（第一个未结案的），与 MatterDetailTabs 同口径 */
  status: string;
  deadlines: SignalDeadline[];
  hearings: SignalHearing[];
  stages: SignalStage[];
};

export async function getMatterSignals(matterId: string): Promise<{
  procedures: SignalProcedure[];
  invoicePending: number;
}> {
  const [procedures, invoicePending] = await Promise.all([
    prisma.matterProcedure.findMany({
      where: { matterId, engagement: "ENGAGED" },
      orderBy: { order: "desc" },
      take: 20,
      select: {
        id: true,
        status: true,
        deadlines: {
          where: { completed: false },
          orderBy: { dueAt: "asc" },
          take: 5,
          select: { id: true, title: true, category: true, dueAt: true, completed: true, basis: true, confirmStatus: true }
        },
        hearings: {
          orderBy: { startsAt: "asc" },
          take: 3,
          select: { id: true, title: true, startsAt: true, room: true }
        },
        stages: {
          where: { status: { not: "HIDDEN" } },
          orderBy: { order: "asc" },
          select: {
            status: true,
            tasks: { select: { title: true, completed: true, dueAt: true }, take: 50 }
          }
        }
      }
    }),
    prisma.invoiceRequest.count({ where: { matterId, status: "PENDING" } }).catch(() => 0)
  ]);

  return {
    procedures: procedures as unknown as SignalProcedure[],
    invoicePending
  };
}
