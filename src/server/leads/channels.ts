/**
 * 获客渠道（2026-11-22，对标分析 P0-1）
 *
 * ## 为什么要有这一层
 *
 * 客户现行系统里「渠道 / 二级渠道」都是**单选**（本地生活 / 大众点评）。
 * 单选的意义在于聚合：能回答「大众点评这个月来 40 条、到店 12 条、成交 3 单」。
 * LawLink 此前只有固定枚举 + 一段自由文本，导不出按平台的 ROI——
 * 而那正是他做这张表的初衷（决定钱往哪投）。
 *
 * ## 三条默认与口径
 *
 * ① **只做两级**（客户截图也只有两级）。再多一层在这个规模上没有收益，
 *    却会让「选渠道」变成表单负担。
 * ② **预置常用渠道**（本地生活/大众点评、抖音本地生活、转介绍、官网、公众号）。
 *    预置而不是让管理员从空白开始填——空表意味着没人建，等于没这个功能。
 * ③ **停用不删除**：历史线索仍指向它，聚合照旧；只是新建线索时不再出现。
 */

import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import type { LeadChannelKind } from "@prisma/client";

export type ChannelNode = {
  id: string;
  name: string;
  kind: LeadChannelKind;
  active: boolean;
  children: { id: string; name: string; active: boolean }[];
};

/** 渠道树（一级 + 二级）。含停用项：编辑历史线索时仍需要显示名字。 */
export async function listLeadChannels(): Promise<ChannelNode[]> {
  await requireSession("clients.read");
  const rows = await prisma.leadChannel.findMany({
    orderBy: [{ sort: "asc" }, { name: "asc" }],
    select: { id: true, name: true, parentId: true, kind: true, active: true }
  });
  const parents = rows.filter((r) => !r.parentId);
  return parents.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    active: p.active,
    children: rows.filter((r) => r.parentId === p.id).map((c) => ({ id: c.id, name: c.name, active: c.active }))
  }));
}

/**
 * 预置渠道（2026-11-22 P0-1）。
 *
 * 放在查询文件而不是 `"use server"` 动作文件里：后者只能导出 async 函数，
 * 导出常量对象会在 next build 阶段直接失败（"A use server file can only export
 * async functions, found object"）。
 */
export const DEFAULT_CHANNELS: { name: string; kind: LeadChannelKind; children: string[] }[] = [
  { name: "本地生活平台", kind: "PAID", children: ["大众点评", "抖音本地生活", "美团"] },
  { name: "搜索与广告", kind: "PAID", children: ["百度推广", "信息流广告"] },
  { name: "自然流量", kind: "ORGANIC", children: ["官网", "微信公众号", "视频号"] },
  { name: "转介绍", kind: "REFERRAL", children: ["老客户介绍", "同行介绍"] },
  { name: "合作机构", kind: "PARTNER", children: [] }
];
