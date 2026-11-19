import { hasCustomPermission } from "@/lib/roles/catalog";
import { isManager } from "@/lib/permissions";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { prisma } from "@/lib/prisma";
import { audit } from "@/server/audit";
import { buildArchiveZip } from "@/server/archive/export";
import { storage } from "@/lib/storage";
import { actionErrorMessage } from "@/lib/action-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ matterId: string }> }
) {
  const { matterId } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "未登录" }, { status: 401 });
  }
  if (!hasCustomPermission(session.user, "matters.export")) return NextResponse.json({ error: "无导出权限" }, { status: 403 });
  if (!hasCustomPermission(session.user, "matters.read") || !hasCustomPermission(session.user, "archive.read") || !hasCustomPermission(session.user, "documents.download")) return NextResponse.json({ error: "导出归档材料需要案件查看、归档查看和材料下载权限" }, { status: 403 });

  // 权限：主任律师或案件成员
  const matter = await prisma.matter.findUnique({
    where: { id: matterId },
    select: { id: true, status: true, internalCode: true }
  });
  if (!matter) return NextResponse.json({ error: "案件不存在" }, { status: 404 });
  // 隔离墙（2026-11-20 补）：本路由打包的是**完整卷宗**（材料 + 记录 + 财务摘要），
  // 是本系统数据密度最高的出口。上面的权限检查齐全，但从不查墙，
  // 且 isManager 会跳过成员校验 —— 于是被隔离在墙内的案件，合伙人可整包导出。
  // 返回 404 而非 403：与「案件不存在」同文案，不泄露该案件是否存在。
  {
    const { isMatterWalledFor } = await import("@/lib/permissions/ethical-wall");
    if (await isMatterWalledFor(prisma, { matterId: matter.id, userId: session.user.id, role: session.user.role })) {
      return NextResponse.json({ error: "案件不存在" }, { status: 404 });
    }
  }
  if (matter.status !== "ARCHIVED") {
    return NextResponse.json({ error: "案件尚未归档" }, { status: 400 });
  }

  const requestedArchiveId = new URL(req.url).searchParams.get("archiveId");
  const archive = await prisma.archiveRecord.findFirst({
    where: {
      matterId: matter.id,
      status: "APPROVED",
      ...(requestedArchiveId ? { id: requestedArchiveId } : {})
    },
    orderBy: { reviewedAt: "desc" },
    select: { id: true, archiveNo: true }
  });
  if (!archive) return NextResponse.json({ error: "指定归档记录不存在或尚未批准" }, { status: 404 });

  if (!isManager(session.user)) {
    const member = await prisma.matterMember.findUnique({
      where: { matterId_userId: { matterId: matter.id, userId: session.user.id } }
    });
    if (!member) {
      return NextResponse.json({ error: "无权访问" }, { status: 403 });
    }
  }

  let result;
  try {
    result = await buildArchiveZip(archive.id);
  } catch (err) {
    console.error("[archive export] 构建失败：", err);
    return NextResponse.json(
      { error: err instanceof Error ? actionErrorMessage(err) : "导出失败" },
      { status: 500 }
    );
  }

  // 持久化路径 + checksum 回填到最新 ArchiveRecord
  try {
    const storagePath = await storage.writeFile(`archive_${matter.id}`, result.buffer);
    await prisma.archiveRecord.update({
      where: { id: archive.id },
      data: { exportPath: storagePath, checksum: result.checksum }
    });
  } catch (err) {
    console.error("[archive export] 落盘失败（不阻断下载）：", err);
  }

  await audit({
    userId: session.user.id,
    action: "ARCHIVE_EXPORT",
    targetType: "ArchiveRecord",
    targetId: archive.id,
    detail: { matterId: matter.id, archiveNo: archive.archiveNo, size: result.size, checksum: result.checksum }
  });

  const ab = result.buffer.buffer.slice(
    result.buffer.byteOffset,
    result.buffer.byteOffset + result.buffer.byteLength
  ) as ArrayBuffer;

  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(result.size),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`
    }
  });
}
