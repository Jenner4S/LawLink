"use client";

import { useEffect, useState } from "react";

/**
 * 版本守卫：防止「旧页面 + 新服务端」导致的 Server Action ID 失配。
 *
 * 背景：Next.js 的 Server Action ID 在构建时生成，镜像一换 ID 就变。
 * 用户开着的旧页面点按钮，会得到
 *   `Failed to find Server Action "…". This request might be from an older or newer deployment.`
 * 这个错误对使用者毫无意义，且刷新即可解决——所以主动检测并提示。
 *
 * 机制：
 *   1. 服务端渲染时把当次构建的 BUILD_ID 作为 prop 注入；
 *   2. 客户端定期（及页面重新可见时）请求 /api/version 比对；
 *   3. 不一致说明「这个页面是旧构建渲染的」→ 顶部提示刷新。
 *
 * 不做自动刷新：律师可能正在填表，强制刷新会丢输入。
 */
export function VersionGuard() {
  const [stale, setStale] = useState(false);
  // 编译期内联：这个值固化在本页面的 JS chunk 里，代表「渲染这个页面时的构建」。
  // 与运行时 /api/version 返回的当前部署值相比，不一致即为旧页面。
  const buildId = process.env.NEXT_PUBLIC_BUILD_ID ?? "";

  useEffect(() => {
    if (!buildId) return;
    let stopped = false;

    const check = async () => {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (!stopped && data.buildId && data.buildId !== buildId) setStale(true);
      } catch {
        // 网络抖动不提示，等下一次
      }
    };

    void check();
    const timer = setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [buildId]);

  if (!stale) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-[9999] flex items-center justify-center gap-3 bg-amber-500/95 px-4 py-2 text-sm text-white shadow-md"
    >
      <span>系统已更新，当前页面是旧版本。刷新后继续操作，以免提交失败。</span>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="rounded-md bg-white/20 px-3 py-1 font-medium hover:bg-white/30"
      >
        立即刷新
      </button>
    </div>
  );
}
