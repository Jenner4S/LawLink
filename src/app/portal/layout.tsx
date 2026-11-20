import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "客户门户 — LawLink",
  // 门户是外部入口，明确不允许被搜索引擎收录
  robots: { index: false, follow: false }
};

/**
 * 门户壳（2026-11-20，门户 S1）
 *
 * **刻意不套员工侧的 AppShell**：没有侧栏、没有顶栏搜索、没有通知铃、
 * 没有「更多应用」。外部客户看到的界面里不该出现任何内部功能入口。
 *
 * 守卫不在这一层：`/portal/login` 与 `/portal/invite/[token]` 是公开页，
 * 放进 layout 会让它们也被要求登录。守卫放在需要登录的具体页面里
 * （调用 `requirePortalViewer()`），这样「哪个页面要登录」是显式的。
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-[var(--surface,#fff)]">{children}</div>;
}
