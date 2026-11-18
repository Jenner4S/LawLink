import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/lib/auth/options";
import { isSystemAdmin } from "@/lib/auth/system-role";
import { isManager } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { verifyAuditChain } from "@/lib/audit-chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 审计链自校验：逐条重算 SHA-256 摘要，报告首个断裂点。
 *
 * 用途：
 *   - 运维定期巡检（可挂 cron 或监控探针）
 *   - 律协/客户检查时自证「审计记录未被改动」
 *
 * 权限：系统管理员或管理岗。返回不含审计正文，只给统计与断裂位置。
 */
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  if (!isSystemAdmin(session.user) && !isManager(session.user)) {
    return NextResponse.json({ error: "无权访问" }, { status: 403 });
  }

  const result = await verifyAuditChain(prisma as never);
  return NextResponse.json(
    {
      ...result,
      checkedAt: new Date().toISOString(),
      note:
        result.skippedLegacy > 0
          ? `有 ${result.skippedLegacy} 条记录写入于启用链式审计之前，无摘要，未参与校验`
          : undefined
    },
    { status: result.ok ? 200 : 409 }
  );
}
