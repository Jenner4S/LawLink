import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/options";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { decryptBuffer } from "@/lib/storage/crypto";
import { auditStrict } from "@/server/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ userId: string; fileId: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });
  const actor = await prisma.user.findUnique({ where: { id: session.user.id }, select: { active: true, systemRole: true } });
  if (!actor?.active) return NextResponse.json({ error: "账号不可用" }, { status: 401 });
  const { userId, fileId } = await params;
  if (actor.systemRole !== "SUPER_ADMIN" && session.user.id !== userId) {
    return NextResponse.json({ error: "无权查看该证件照片" }, { status: 403 });
  }
  const file = await prisma.userIdentityDocument.findFirst({ where: { id: fileId, userId, active: true } });
  if (!file) return NextResponse.json({ error: "证件照片不存在" }, { status: 404 });

  try {
    const ciphertext = await storage.readFile(file.path);
    const image = decryptBuffer(ciphertext, file.iv, file.authTag);
    // P0-7：证件明文查看属关键动作，审计失败即失败——不得出现
    // "照片已返回但无审计记录"的不可核验状态（严格版审计抛错）。
    await auditStrict({
      userId: session.user.id,
      action: "USER_IDENTITY_PHOTO_VIEW",
      targetType: "UserIdentityDocument",
      targetId: file.id,
      detail: { ownerUserId: userId, pageKind: file.pageKind }
    });
    return new NextResponse(new Uint8Array(image), {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Disposition": "inline",
        "Cache-Control": "no-store, private, max-age=0",
        "X-Content-Type-Options": "nosniff"
      }
    });
  } catch (err) {
    // 2026-11-21（审计发现）：原先是裸 `catch {}` —— 一个 catch 同时包住
    // 解密读取与 auditStrict，两者都返回「证件照片读取失败」且**没有任何日志**。
    // 后果：审计写失败时，运维既看不到日志，界面上也只会说是"读取失败"，
    // 无法定位是存储问题还是审计表问题。
    //
    // 修法：日志里带上错误类型，响应仍用统一中文（不把内部细节给到前端）。
    // 「审计失败即失败」的语义不变 —— 仍然返回 500、仍然不放行照片。
    console.error(
      `[identity-documents] 证件照片读取或审计失败 fileId=${fileId} userId=${userId}`,
      err
    );
    return NextResponse.json({ error: "证件照片读取失败，请稍后重试或联系管理员" }, { status: 500 });
  }
}
