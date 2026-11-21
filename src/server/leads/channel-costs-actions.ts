"use server";

/**
 * 录入渠道月度投放成本（2026-11-23）
 *
 * 与只读模块分开（`"use server"` 混进 server-only 模块会把 prisma 拖进客户端包，
 * 本项目为此踩过三次）。金额为 0 时**删除该月记录**而不是留一条 0 ——
 * 0 与"没投"在成本口径里是同一件事，留 0 会让"已录入"与"未录入"看起来一样。
 */
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { parseInput } from "@/lib/parse-input";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";

const schema = z.object({
  channelId: z.string().trim().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "月份格式应为 YYYY-MM"),
  amount: z.coerce.number().min(0).max(1_000_000_000).multipleOf(0.01, "金额最多两位小数"),
  note: z.string().trim().max(200).optional().or(z.literal(""))
});

export async function upsertChannelCost(input: z.input<typeof schema>) {
  const session = await requireSession("clients.write");
  if (!["ADMIN", "PRINCIPAL_LAWYER"].includes(session.user.role) && session.user.role !== "CUSTOM") {
    throw new ActionError("仅管理员或合伙人可录入投放成本");
  }
  const data = parseInput(schema, input);

  const channel = await prisma.leadChannel.findUnique({
    where: { id: data.channelId },
    select: { id: true, name: true }
  });
  if (!channel) throw new ActionError("渠道不存在");

  const before = await prisma.leadChannelCost.findUnique({
    where: { channelId_month: { channelId: data.channelId, month: data.month } },
    select: { amount: true }
  });

  if (data.amount === 0) {
    await prisma.leadChannelCost.deleteMany({
      where: { channelId: data.channelId, month: data.month }
    });
  } else {
    await prisma.leadChannelCost.upsert({
      where: { channelId_month: { channelId: data.channelId, month: data.month } },
      create: {
        channelId: data.channelId,
        month: data.month,
        amount: new Prisma.Decimal(data.amount),
        note: data.note || null,
        createdById: session.user.id
      },
      update: {
        amount: new Prisma.Decimal(data.amount),
        note: data.note || null
      }
    });
  }

  await audit({
    userId: session.user.id,
    action: "LEAD_CHANNEL_COST",
    targetType: "LeadChannelCost",
    targetId: `${data.channelId}:${data.month}`,
    detail: {
      channelName: channel.name,
      month: data.month,
      before: before ? Number(before.amount) : 0,
      after: data.amount
    }
  });
  revalidatePath("/leads");
  return { ok: true as const };
}
