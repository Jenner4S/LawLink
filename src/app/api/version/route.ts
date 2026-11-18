import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 当前部署的构建标识。VersionGuard 用它判断浏览器里的页面是否已过期。
 * 未注入 BUILD_ID 时返回空串，前端据此跳过检测（本地 dev 场景）。
 */
export function GET() {
  return NextResponse.json(
    { buildId: process.env.BUILD_ID ?? "" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
