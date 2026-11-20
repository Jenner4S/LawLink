"use server";

/**
 * 渠道维护动作（2026-11-22 P0-1）
 *
 * 与 `channels.ts`（只读查询）分开：查询被服务端组件与客户端组件共用类型，
 * 而写动作带 `revalidatePath` 与 `"use server"`，混在一个文件里会让
 * 客户端组件把 server-only 模块拖进浏览器包（构建期直接失败）。
 */

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { parseInput } from "@/lib/parse-input";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";
import type { LeadChannelKind } from "@prisma/client";
import { DEFAULT_CHANNELS } from "./channels";

const createSchema = z.object({
  name: z.string().trim().min(1, "请填写渠道名称").max(30),
  parentId: z.string().trim().optional().or(z.literal("")),
  kind: z.enum(["PAID", "ORGANIC", "REFERRAL", "PARTNER", "OTHER"]).default("OTHER"),
  sort: z.coerce.number().int().min(0).max(999).optional()
});

/**
 * 新建渠道（一级或二级）。
 *
 * 同一父级下同名会被 `@@unique([parentId, name])` 拦下——这里先查一次给出可读文案，
 * 不靠数据库报错往上抛（P2002 的原文对用户毫无意义）。
 */
export async function createLeadChannel(input: z.input<typeof createSchema>) {
  const session = await requireSession("clients.write");
  if (!["ADMIN", "PRINCIPAL_LAWYER"].includes(session.user.role) && session.user.role !== "CUSTOM") {
    throw new ActionError("仅管理员或合伙人可维护渠道");
  }
  const data = parseInput(createSchema, input);
  const parentId = data.parentId?.trim() || null;

  if (parentId) {
    const parent = await prisma.leadChannel.findUnique({ where: { id: parentId }, select: { parentId: true, name: true } });
    if (!parent) throw new ActionError("上级渠道不存在");
    // 只做两级：不允许在二级下再建（三级没有收益，只会让表单更难选）
    if (parent.parentId) throw new ActionError("渠道只支持两级，不能在二级渠道下再建");
  }

  const dup = await prisma.leadChannel.findFirst({
    where: { parentId, name: data.name },
    select: { id: true }
  });
  if (dup) throw new ActionError("同级下已有同名渠道");

  const created = await prisma.leadChannel.create({
    data: { name: data.name, parentId, kind: data.kind as LeadChannelKind, sort: data.sort ?? 100 },
    select: { id: true }
  });
  await audit({
    action: "LEAD_CHANNEL_CREATE",
    targetType: "LeadChannel",
    targetId: created.id,
    detail: { name: data.name, parentId, kind: data.kind }
  });
  revalidatePath("/leads");
  return { ok: true as const, id: created.id };
}

/** 启用/停用（停用不删除：历史线索仍指向它） */
export async function toggleLeadChannel(input: { id: string; active: boolean }) {
  const session = await requireSession("clients.write");
  if (!["ADMIN", "PRINCIPAL_LAWYER"].includes(session.user.role) && session.user.role !== "CUSTOM") {
    throw new ActionError("仅管理员或合伙人可维护渠道");
  }
  const id = String(input?.id ?? "").trim();
  if (!id) throw new ActionError("缺少渠道标识");

  const current = await prisma.leadChannel.findUnique({ where: { id }, select: { name: true, active: true } });
  if (!current) throw new ActionError("渠道不存在");
  if (current.active === input.active) return { ok: true as const };

  await prisma.leadChannel.update({ where: { id }, data: { active: input.active } });
  await audit({
    action: "LEAD_CHANNEL_TOGGLE",
    targetType: "LeadChannel",
    targetId: id,
    detail: { name: current.name, active: input.active }
  });
  revalidatePath("/leads");
  return { ok: true as const };
}

/**
 * 预置渠道（幂等）。由 seed 或首次进入页面时调用。
 *
 * 预置的内容来自客户现行系统的字段值（本地生活 / 大众点评）与律所常见来源，
 * 覆盖「付费投放 → 自然流量 → 转介绍」三类，避免管理员面对空表无从下手。
 */

export async function ensureDefaultChannels(): Promise<{ created: number }> {
  let created = 0;
  for (const [i, group] of DEFAULT_CHANNELS.entries()) {
    const existing = await prisma.leadChannel.findFirst({
      where: { parentId: null, name: group.name },
      select: { id: true }
    });
    let parentId = existing?.id ?? null;
    if (!parentId) {
      const row = await prisma.leadChannel.create({
        data: { name: group.name, kind: group.kind, sort: i * 10 },
        select: { id: true }
      });
      parentId = row.id;
      created += 1;
    }
    for (const [j, child] of group.children.entries()) {
      const dup = await prisma.leadChannel.findFirst({ where: { parentId, name: child }, select: { id: true } });
      if (dup) continue;
      await prisma.leadChannel.create({ data: { name: child, parentId, kind: group.kind, sort: j } });
      created += 1;
    }
  }
  return { created };
}
