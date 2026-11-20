import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { decryptBuffer } from "@/lib/storage/crypto";
import { getPortalViewer } from "@/lib/portal/session";
import { portalCanReadDocument } from "@/lib/portal/access";

/**
 * 门户材料下载（2026-11-20，门户 S2）
 *
 * 与员工侧 `/api/documents/[id]/download` **是两条独立通道**，刻意不共用：
 * 那条通道的第一句是「你是不是这个案的经办/成员」（`canReadDocument`），
 * 客户永远不是。共用会让下一个人为了"修好它"给客户加成员身份——那才是真正的洞。
 *
 * 本通道的判定只有一句：`portalCanReadDocument(clientId, documentId)`
 * 即「存在一条未撤销的 DOCUMENT 分享」。撤销后下一次请求立即 404。
 *
 * 对外不区分「没分享过 / 分享已撤销 / 材料不存在」——一律 404 同一句文案，
 * 否则可用来枚举材料 id 是否存在。
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await getPortalViewer();
  if (!viewer) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const id = (await params).id;
  const notFound = () => NextResponse.json({ error: "材料不存在" }, { status: 404 });

  if (!(await portalCanReadDocument(viewer.clientId, id))) return notFound();

  const doc = await prisma.document.findFirst({
    where: { id, deletedAt: null },
    select: {
      name: true,
      mimeType: true,
      path: true,
      encrypted: true,
      iv: true,
      authTag: true
    }
  });
  if (!doc) return notFound();

  let buf: Buffer;
  try {
    const stored = await storage.readFile(doc.path);
    if (doc.encrypted) {
      if (!doc.iv || !doc.authTag) return NextResponse.json({ error: "加密元数据损坏" }, { status: 500 });
      buf = decryptBuffer(stored, doc.iv, doc.authTag);
    } else {
      buf = stored;
    }
  } catch (err) {
    console.error("[portal download] 读取失败：", err);
    return NextResponse.json({ error: "读取失败" }, { status: 500 });
  }

  // 门户一律附件下载、不做 inline：客户浏览器里渲染 HTML/SVG 是 XSS 面
  const lower = (doc.mimeType ?? "").toLowerCase();
  const dangerous = /html|svg|xml|javascript/.test(lower);

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": dangerous ? "application/octet-stream" : (doc.mimeType ?? "application/octet-stream"),
      "Content-Length": String(buf.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "X-Content-Type-Options": "nosniff",
      // 门户是外部入口：不允许任何缓存层留存客户材料
      "Cache-Control": "private, no-store"
    }
  });
}
