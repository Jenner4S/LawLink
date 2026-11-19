"use server";

import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";

export async function getNotifications(params?: { unreadOnly?: boolean; limit?: number }) {
  const session = await requireSession("personal");
  const limit = params?.limit ?? 30;

  // 2026-11-20 审计记录（已知限制，非缺陷修复）：
  //
  // 这里**不按隔离墙过滤**。通知的 refType/refId 是多态的
  // （WeeklyReport / ArchiveOverdue / WorkResponsibility / data.refType 动态传入），
  // 要按墙过滤得对每种 refType 分别 join 回 Matter，成本远高于收益：
  //
  //   · 泄露面有限——只有**标题**（"某某案 · 举证期限明日到期"）会出现在列表里；
  //   · 点击即被拦——链接指向 /matters/{id}，进入后 getMatterById 会走
  //     assertCanReadMatter（含墙），被隔离者拿不到案件详情；
  //   · 通知表当前为空（0 行），无法实测修复效果。
  //
  // 另一半更值得注意：**发送侧**同样不查墙——提醒收件人是待办责任人（assigneeId），
  // 责任人若在分配之后被隔离，会持续收到该案件的提醒。修复要改
  // src/server/reminders/urgent.ts:22 那条 INSERT ... SELECT（在 SQL 里 join EthicalWall），
  // 属提醒链路重构，已登记为待办而非本轮改动。
  return prisma.notification.findMany({
    where: {
      userId: session.user.id,
      ...(params?.unreadOnly ? { read: false } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getUnreadCount() {
  const session = await requireSession("personal");
  return prisma.notification.count({
    where: { userId: session.user.id, read: false },
  });
}

export async function markNotificationRead(id: string) {
  const session = await requireSession("personal");
  const notif = await prisma.notification.findFirst({
    where: { id, userId: session.user.id },
  });
  if (!notif) throw new ActionError("通知不存在");

  return prisma.notification.update({
    where: { id },
    data: { read: true, readAt: new Date() },
  });
}

export async function markAllNotificationsRead() {
  const session = await requireSession("personal");
  await prisma.notification.updateMany({
    where: { userId: session.user.id, read: false },
    data: { read: true, readAt: new Date() },
  });
  return { ok: true };
}
