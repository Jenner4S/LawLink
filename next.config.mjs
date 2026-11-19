/** @type {import('next').NextConfig} */
const nextConfig = {
  // dev 与 build 分开输出，避免生产构建覆盖正在运行的开发缓存导致页面不渲染
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // 2026-11-20：显式指定 Turbopack 的项目根。
  //
  // 起因：构建时出现警告
  //   "Next.js ignored package-lock.json in /Users/Jenner because it is outside
  //    the current Git repository"
  // Turbopack 向上查找最近的 lock 文件推断 root，而宿主的 /Users/Jenner 下
  // 恰好有一个无关的 package-lock.json（2024 年的遗留文件），导致它把
  // /Users/Jenner 当成项目根 —— 当前仓库的 lock 被忽略、模块解析范围被放大。
  //
  // 在容器里构建时 /Users/Jenner 不存在，所以这个警告只在宿主本机构建时出现；
  // 显式指定 root 后两端一致，也避免将来在类似目录结构下出现更难查的解析问题。
  turbopack: {
    root: import.meta.dirname
  },
  // typedRoutes 等 Stage 2 路由稳定后再开启
  typedRoutes: false,
  allowedDevOrigins: ["127.0.0.1"],
  // v0.27: @napi-rs/canvas 是原生 .node 二进制，必须交给 Node 运行时 require
  // 否则构建器会试图 parse 二进制文件，让整个依赖链上的路由 (/matters) 500
  serverExternalPackages: ["@napi-rs/canvas", "unpdf"],
  experimental: {
    serverActions: {
      // 材料上传需要更大的 body 限制（默认 1MB）
      bodySizeLimit: "25mb"
    }
  },
  // 2026-09-19 审计修复：全站基础安全响应头（下载路由另有逐路由头）。
  // 刻意不加整体 CSP：Next.js 运行时依赖内联脚本，需逐页审计后另行引入。
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }
        ]
      }
    ];
  }
};

export default nextConfig;
