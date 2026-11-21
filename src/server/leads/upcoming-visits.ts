/**
 * 未来几天该盯谁上门（2026-11-23）
 *
 * ## 为什么单独一块
 *
 * 漏斗回答「这个月怎么样」，渠道回答「钱往哪投」，
 * 但基层每天要回答的是另一个问题：**今天/这周该打给谁**。
 * 提醒台账解决了"到点系统会提醒"，但它不会告诉你"这周三有几家要来"。
 *
 * 这一块只读：把 `Lead.invitedAt`（约定到店时间）落在窗口内、
 * 且 `visitOutcome = PENDING`（还没来也没爽约）的线索，按天分组列出来。
 *
 * ## 口径（三条，都取"宁可少列"）
 *
 * ① 只列 `visitOutcome = PENDING`：已到店（ARRIVED）与爽约（NO_SHOW）都不再是"待上门"；
 * ② 只列**未来**（含今天），过去的约定不追（追逾期是提醒链的事，不是这块）；
 * ③ 只列 `stage = INVITED`：已推进到谈案/转化的线索不再需要"上门"提醒。
 *
 * 不做分页与聚合历史：这是"本周清单"，不是报表。
 */
import { prisma } from "@/lib/prisma";

export type UpcomingVisitDay = {
  /** yyyy-mm-dd（按服务器本地时区，与页面显示一致） */
  date: string;
  /** 当天待上门数 */
  count: number;
  /** 最多 3 条用于摘要显示（再多就只给数字） */
  items: { id: string; name: string; phone: string | null }[];
};

const KEY_LEN = 3;

/** 按 +08:00 出日期串：容器是 UTC，直接取本地字段会让"上海今晚的约定"显示成明天。 */
function ymd(d: Date): string {
  const sh = new Date(d.getTime() + 8 * 3600_000);
  const y = sh.getUTCFullYear();
  const m = String(sh.getUTCMonth() + 1).padStart(2, "0");
  const day = String(sh.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getUpcomingVisits(days = 7, now = new Date()): Promise<UpcomingVisitDay[]> {
  // 起算点是"今天 0 点"。容器时区是 UTC（2026-11-23 实测 `date` = UTC），
  // 用本地构造会得到 UTC 0 点 = 上海 08:00，于是"上海今天上午的约定"被算进昨天。
  // 这里改为按 +08:00 取当天 0 点，与页面显示（上海）一致。
  const shNow = new Date(now.getTime() + 8 * 3600_000);
  const start = new Date(
    Date.UTC(shNow.getUTCFullYear(), shNow.getUTCMonth(), shNow.getUTCDate()) - 8 * 3600_000
  );
  const end = new Date(start.getTime() + days * 86_400_000);

  const rows = await prisma.lead.findMany({
    where: {
      stage: "INVITED",
      visitOutcome: "PENDING",
      invitedAt: { gte: start, lt: end }
    },
    select: { id: true, name: true, phone: true, invitedAt: true },
    orderBy: [{ invitedAt: "asc" }, { name: "asc" }],
    take: 500
  });

  const byDay = new Map<string, UpcomingVisitDay>();
  for (const r of rows) {
    if (!r.invitedAt) continue;
    const key = ymd(r.invitedAt);
    const day = byDay.get(key) ?? { date: key, count: 0, items: [] };
    day.count += 1;
    if (day.items.length < KEY_LEN) day.items.push({ id: r.id, name: r.name, phone: r.phone });
    byDay.set(key, day);
  }

  // 按日期升序（Map 插入顺序即按 invitedAt 排好的顺序，但显式排序更稳）
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}
