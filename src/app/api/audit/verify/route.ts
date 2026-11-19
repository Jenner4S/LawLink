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
      note: buildNote(result)
    },
    { status: result.ok ? 200 : 409 }
  );
}

/**
 * 把校验结果翻译成一句人能读懂的话（2026-11-19）。
 *
 * 只有 skippedLegacy 时说明历史段；出现 unchecked 时必须解释缺口从哪来——
 * 否则运维看到 409 和一个 unchecked 数字，不知道该担心还是该忽略。
 */
function buildNote(result: {
  skippedLegacy: number;
  unchecked: number;
  forks: unknown[] | null;
  brokenAt: { action: string; reason: string } | null;
}): string | undefined {
  const parts: string[] = [];
  if (result.skippedLegacy > 0) {
    parts.push(`有 ${result.skippedLegacy} 条记录写入于启用链式审计之前，无摘要，未参与校验`);
  }
  if (result.forks?.length) {
    parts.push(
      `链在 ${result.forks.length} 处存在分叉（同一前驱有多条后继）：这是「同一事务内写多条审计」的已知形态，` +
        `不影响可用性，分支已全部校验`
    );
  }
  if (result.unchecked > 0) {
    parts.push(
      `有 ${result.unchecked} 条未通过校验` +
        (result.brokenAt
          ? `（首个为 ${result.brokenAt.action}：${result.brokenAt.reason}）。` +
            `若该记录写入于 2026-11-19 之前，可能是旧版序列化对 undefined 字段处理不一致所致，` +
            `新写入不受影响`
          : "")
    );
  }
  return parts.length ? parts.join("；") : undefined;
}
