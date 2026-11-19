import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { shDaysFromToday } from "@/lib/ui/sh-time";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, options?: { compact?: boolean; precision?: number }) {
  if (options?.compact && Math.abs(amount) >= 10000) {
    return `¥${(amount / 10000).toFixed(1)}万`;
  }
  // 默认两位小数：金额是两位小数录入（step 0.01），按 0 位四舍五入会把 ¥0.60 显示成 ¥1、¥0.40 显示成 ¥0
  const digits = options?.precision ?? 2;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(amount);
}

/**
 * 统一日期格式（上海时区）。
 *
 * 2026-11-20：入参接受 null/undefined，空值返回 "—"。
 * 原因是各处调用点此前都写了同一段包装：
 *     function formatDate(v) { if (!v) return "—"; return fmtDate(new Date(v)); }
 * 在冲突弹窗、冲突区块、案件列表三处重复出现——同一段空值处理写了三遍。
 * 把语义收进统一函数后，调用点直接用，不再各自造壳。
 */
export function formatDate(
  date: Date | string | null | undefined,
  fmt: "full" | "short" | "month-day" = "short"
): string {
  if (date === null || date === undefined || date === "") return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  // 三个分支统一固定上海时区：客户端组件复用时服务器与浏览器渲染一致，否则水合失败
  if (fmt === "full") {
    return d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "long",
      timeZone: "Asia/Shanghai"
    });
  }
  if (fmt === "month-day") {
    return d.toLocaleDateString("zh-CN", { month: "long", day: "numeric", timeZone: "Asia/Shanghai" });
  }
  // 系统统一日期格式 YYYY-MM-DD（上海时区），避免 2026/9/6 与 2026-09-06 混用
  return d.toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

/** 系统统一日期时间格式 YYYY-MM-DD HH:mm（上海时区）；空值返回 "—" */
export function formatDateTime(date: Date | string | null | undefined): string {
  if (date === null || date === undefined || date === "") return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }).slice(0, 16);
}

/** 距上海「今天」的日历天数（不修改入参；与服务器/浏览器所在时区无关） */
export function daysUntil(date: Date | string): number {
  return shDaysFromToday(date);
}
