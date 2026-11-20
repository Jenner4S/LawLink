import { withAuth } from "next-auth/middleware";

/**
 * 全站默认要求登录。
 * `matcher` 显式排除 /login、/api/auth/*、静态资源等公开路径。
 */
export default withAuth({
  pages: {
    signIn: "/login"
  }
});

export const config = {
  matcher: [
    /*
     * 匹配所有路径，但排除：
     *   /login            登录页本身
     *   /api/auth         NextAuth 路由
     *   /api/health       健康检查
     *   /api/calendar     v0.50 ICS 日历订阅（token 即凭证，日历客户端无 cookie）
     *   /api/version      构建标识（仅返回 BUILD_ID，用于前端发现「页面已过期」）
     *   /confirm/*        合同确认公开页（客户没有账号，凭一次性 token 访问——
     *                     漏排会让客户被重定向到登录页，功能对客户完全不可用）
     *   /portal/*         客户门户（2026-11-20 S1）：访客是**外部客户**，身份由
     *                     独立的门户 cookie 承载，员工侧 NextAuth 根本不认。
     *                     漏排的后果与 /confirm 同类但更严重：客户一律被弹到员工登录页，
     *                     门户整体不可用。门户自己的守卫在 (portal) layout 里，不靠中间件。
     *   /_next/*          Next 内部资源（含 HMR websocket）
     *   静态文件（.png .ico .svg 等）
     */
    "/((?!login|confirm|portal|api/auth|api/health|api/calendar|api/version|_next|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)).*)"
  ]
};
