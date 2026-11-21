/**
 * 线索列表的列显隐（2026-11-23）
 *
 * ## 为什么只做「显隐」，不做公式列/冻结列
 *
 * 客户那张宽表的痛点之一是**列太多、每所关心的不一样**，
 * 但真正的诉求是"把我不看的列藏起来"，不是"让我写公式"。
 * 显隐是这条诉求里成本最低、最不容易做错的一半。
 *
 * ## 三条边界
 *
 * ① **线索人列不可隐藏**：藏了它就只剩一堆操作按钮，列表失去意义；
 * ② **操作列不可隐藏**：那是唯一的操作入口；
 * ③ 未知键直接丢弃（配置里写错不会让页面空白）。
 *
 * 配置按所（SystemSetting 单 key）而非按人：
 * 律所里"看同一份列表"的场景多于"每人一套"，按人存会让交接与排查变复杂。
 */
import { prisma } from "@/lib/prisma";
// 列定义放在 lib（客户端也要用），这里只 re-export，不再本地定义第二份
import { LEADS_COLUMNS, type LeadsColumnKey } from "@/lib/leads-columns";

export { LEADS_COLUMNS };
export type { LeadsColumnKey };

const KEY = "leads.listColumns";

/** 不可隐藏的列（保留它，列表才可用） */
const REQUIRED: LeadsColumnKey = "name";

const ALL: LeadsColumnKey[] = LEADS_COLUMNS.map((c) => c.key);

export async function getLeadsListColumns(): Promise<LeadsColumnKey[]> {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEY } });
  const raw = (row?.value as { columns?: unknown } | null)?.columns;
  if (!Array.isArray(raw)) return ALL;

  // 一次投影同时完成三件事：丢未知键、去重、按 LEADS_COLUMNS 的定义顺序排列。
  // （原先先 filter 出 valid 再 ALL.filter 一次，是重复劳动 ——
  //  变异验证显示去掉前一步行为不变，已合并。）
  const stored = raw.filter((k): k is string => typeof k === "string");
  const picked = ALL.filter((k) => stored.includes(k));
  if (!picked.includes(REQUIRED)) picked.unshift(REQUIRED);
  return picked;
}

export async function saveLeadsListColumns(keys: string[]): Promise<LeadsColumnKey[]> {
  const valid = keys.filter((k): k is LeadsColumnKey => (ALL as string[]).includes(k));
  const picked = ALL.filter((k) => valid.includes(k));
  if (!picked.includes(REQUIRED)) picked.unshift(REQUIRED);
  await prisma.systemSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: { columns: picked } },
    update: { value: { columns: picked } }
  });
  return picked;
}
