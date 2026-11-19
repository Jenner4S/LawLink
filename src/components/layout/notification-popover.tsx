"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Bell } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  getNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/server/notifications/actions";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { actionErrorMessage } from "@/lib/action-error";

const typeIcons: Record<string, string> = {
  PRESERVATION_EXPIRY: "🛡️",
  HEARING_REMINDER: "⚖️",
  DEADLINE_REMINDER: "⏰",
  SEAL_STATUS_CHANGE: "🔖",
  SMS_ARRIVAL: "📩",
  TASK_ASSIGNED: "🔔",
  SYSTEM: "🔔",
  ARCHIVE_APPROVED: "📦",
  ARCHIVE_REJECTED: "📦",
};

const typeLabels: Record<string, string> = {
  PRESERVATION_EXPIRY: "保全到期",
  HEARING_REMINDER: "庭审",
  DEADLINE_REMINDER: "期限",
  SEAL_STATUS_CHANGE: "用章",
  SMS_ARRIVAL: "短信",
  TASK_ASSIGNED: "系统",
  SYSTEM: "系统",
  ARCHIVE_APPROVED: "归档",
  ARCHIVE_REJECTED: "归档",
};

const priorityColors: Record<string, string> = {
  URGENT: "text-[var(--red)]",
  HIGH: "text-[var(--amber)]",
  NORMAL: "",
  LOW: "text-muted-foreground",
};

export function NotificationPopover() {
  const [unread, setUnread] = useState(0);
  const [notifications, setNotifications] = useState<Awaited<ReturnType<typeof getNotifications>>>([]);
  const [open, setOpen] = useState(false);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  // 轮询连续失败次数（2026-11-21）：见 poll() 的注释 —— 静默吞掉会让用户
  // 以为「没有新通知」，而实际上只是刷不出来。连续 2 次才提示，避免抖动骚扰。
  const [pollFailures, setPollFailures] = useState(0);
  const router = useRouter();

  // 已弹过桌面通知的 id（含挂载时已存在的，避免刷新页面就刷屏）
  const seenIds = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);

  // 轮询：刷新未读数 + 对新到的未读通知弹浏览器桌面通知
  const poll = useCallback(async () => {
    try {
      const [count, list] = await Promise.all([
        getUnreadCount(),
        getNotifications({ limit: 20 })
      ]);
      setUnread(count);
      setNotifications(list);
      setPollFailures(0);

      const unreadList = list.filter((n) => !n.read);
      if (!seededRef.current) {
        // 首次轮询：只记录现有 id，不弹（否则每次进站都炸一堆系统通知）
        unreadList.forEach((n) => seenIds.current.add(n.id));
        seededRef.current = true;
        return;
      }
      const canNotify =
        typeof window !== "undefined" &&
        "Notification" in window &&
        Notification.permission === "granted";
      for (const n of unreadList) {
        if (seenIds.current.has(n.id)) continue;
        seenIds.current.add(n.id);
        if (canNotify) {
          const notif = new Notification(n.title, {
            body: n.content ?? undefined,
            tag: n.id,
            icon: "/favicon.ico"
          });
          if (n.href) {
            notif.onclick = () => {
              window.focus();
              router.push(n.href as string);
              notif.close();
            };
          }
        }
      }
    } catch (err) {
      // 2026-11-21 修复（P2，多智能体审计「错误处理」维度）：
      // 原来这里是 `catch {}` —— 轮询失败完全无声。用户看到的是「铃铛一直没动静」，
      // 会以为是「没有新通知」，而实际上只是拉不到。对一个靠提醒盯期限的系统，
      // 这等于一条期限提醒被静默吞掉，和 Round 125 修的「点了没反应」是同一类病。
      //
      // 但不能每次失败都弹 toast（60 秒一次会很吵）。做法：只累计次数，
      // 由铃铛上的小角标提示；连续 2 次才显示，瞬时抖动不打扰。
      // 错误详情只在控制台留一行，供排障。
      console.warn("[notification] 轮询失败", err);
      setPollFailures((n) => n + 1);
    }
  }, [router]);

  useEffect(() => {
    // 请求桌面通知授权（用户可拒绝；拒绝后仅站内铃铛生效）
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
    poll();
    const timer = setInterval(poll, 60_000);
    return () => clearInterval(timer);
  }, [poll]);

  /**
   * 2026-11-21 修复（P2，多智能体审计「错误处理」维度）：
   * 这三个处理器原来都是裸 `async`，`onClick` 直接绑定。
   * React 会丢弃返回的 Promise，任何异常都变成 unhandled rejection ——
   * 用户看到的是「点了没反应」：铃铛不弹、红点不消、点通知不跳转，
   * 屏幕上没有任何解释。对靠提醒盯期限的律师，等于一条期限提醒被静默吞掉。
   *
   * 现在统一 try/catch + toast。**注意两个刻意的取舍**：
   *   · 标记已读失败时**仍然跳转** —— 用户点通知是想看内容，
   *     不能因为「已读状态没写进去」就把人拦在原地；未读数保持原样才是正确的。
   *   · 拉取通知失败时保留上一次的列表，不清空 —— 清空等于告诉用户「没有通知」，
   *     那比显示旧数据更误导。
   */
  const handleOpen = async (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) return;
    try {
      const list = await getNotifications({ limit: 20 });
      setNotifications(list);
    } catch (err) {
      toast.error("通知列表加载失败", { description: actionErrorMessage(err) });
    }
  };

  const handleMarkRead = async (id: string, href?: string | null) => {
    try {
      await markNotificationRead(id);
      setUnread((prev) => Math.max(0, prev - 1));
      setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, read: true, readAt: new Date() } : n));
    } catch (err) {
      // 已读没写成，红点保持 —— 但不要拦住用户去看内容
      toast.error("标记已读失败", { description: actionErrorMessage(err) });
    }
    if (href) {
      setOpen(false);
      router.push(href);
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setUnread(0);
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true, readAt: new Date() })));
    } catch (err) {
      toast.error("全部标记已读失败", { description: actionErrorMessage(err) });
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpen}>
      <PopoverTrigger asChild>
        <button
          className="btn btn-secondary btn-icon relative"
          aria-label={
            pollFailures >= 2
              ? `通知（刷新失败，显示的可能不是最新）${unread > 0 ? `，${unread} 条未读` : ""}`
              : unread > 0 ? `通知（${unread} 条未读）` : "通知"
          }
          title={pollFailures >= 2 ? "通知刷新失败，正在自动重试" : undefined}
        >
          <Bell strokeWidth={1.8} />
          {unread > 0 && (
            <span className="absolute right-[7px] top-[7px] h-[7px] w-[7px] rounded-full border-[1.5px] border-white bg-[var(--red)]" aria-hidden />
          )}
          {/* 连续刷新失败时的角标：不用 toast（60 秒一次会吵），用静态提示。
              位置放在左下，与未读红点（右上）区分开，两者可同时出现。 */}
          {pollFailures >= 2 && (
            <span
              className="absolute bottom-[5px] left-[5px] h-[6px] w-[6px] rounded-full bg-[var(--amber,#f59e0b)]"
              aria-hidden
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-medium">通知</span>
          {unread > 0 && (
            <button
              onClick={handleMarkAllRead}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              全部已读
            </button>
          )}
        </div>
        {(() => {
          const presentTypes = Array.from(new Set(notifications.map((n) => n.type)));
          if (presentTypes.length <= 1) return null;
          return (
            <div className="flex flex-wrap gap-1 border-b px-3 py-1.5">
              <button
                onClick={() => setTypeFilter(null)}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                  typeFilter === null
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:border-input hover:bg-muted hover:text-foreground"
                )}
              >
                全部
              </button>
              {presentTypes.map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(t === typeFilter ? null : t)}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                    typeFilter === t
                      ? "border-primary bg-primary/15 text-primary"
                      : "border-border text-muted-foreground hover:border-input hover:bg-muted hover:text-foreground"
                  )}
                >
                  {typeIcons[t] ?? "🔔"} {typeLabels[t] ?? t}
                </button>
              ))}
            </div>
          );
        })()}
        <div className="max-h-80 overflow-y-auto">
          {(() => {
            const list = typeFilter
              ? notifications.filter((n) => n.type === typeFilter)
              : notifications;
            if (list.length === 0) {
              return (
                <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                  {typeFilter ? `没有「${typeLabels[typeFilter] ?? typeFilter}」类通知` : "暂无通知"}
                </div>
              );
            }
            return list.map((n) => (
              <button
                key={n.id}
                onClick={() => handleMarkRead(n.id, n.href)}
                className={cn(
                  "flex w-full gap-2.5 border-b px-3 py-2.5 text-left transition-colors hover:bg-muted",
                  !n.read && "bg-primary/5"
                )}
              >
                <span className="mt-0.5 text-sm">{typeIcons[n.type] ?? "🔔"}</span>
                <div className="min-w-0 flex-1">
                  <div className={cn("text-[13px] leading-snug", !n.read && "font-medium", priorityColors[n.priority])}>
                    {n.title}
                  </div>
                  {n.content && (
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {n.content}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-muted-foreground/60">
                    {formatTime(n.createdAt)}
                  </div>
                </div>
                {!n.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
              </button>
            ));
          })()}
        </div>
        {notifications.length > 0 && (
          <div className="border-t px-3 py-2">
            <Link href="/notifications" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setOpen(false)}>
              查看全部通知
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function formatTime(date: Date | string): string {
  const d = new Date(date);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", timeZone: "Asia/Shanghai" });
}
