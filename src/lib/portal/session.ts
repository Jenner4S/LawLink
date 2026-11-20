/**
 * 门户会话的服务端守卫（2026-11-20，门户 S1）
 *
 * 与 `lib/auth/session.ts`（员工侧）**互不引用**：
 *   · 员工侧只读 NextAuth 的 session，根本不看 `lawlink_portal_session`
 *   · 门户侧只读门户 cookie，根本不看员工会话
 * 这条「互不引用」是结构性隔离的落地形态，也由测试守住
 * （见 src/tests/lib/portal-isolation.test.ts）。
 *
 * 每次请求都回库复核三件事，**不信任 cookie 里除 id 之外的任何东西**：
 *   ① 账号仍 active
 *   ② cookie 里的 sessionVersion 与库一致（递增即踢下线）
 *   ③ 所属客户未被软删
 */
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PORTAL_COOKIE, readPortalSession } from "./auth";

export type PortalViewer = {
  portalUserId: string;
  clientId: string;
  clientName: string;
  name: string;
  email: string;
};

/**
 * 读取当前门户身份；未登录/失效返回 null。
 *
 * 失效原因对外**一律当作未登录**（重定向登录页），不在页面上区分
 * 「你的账号被停用了」还是「你没登录」——那会向外部人泄露内部操作。
 * 内部侧由审计（PORTAL_LOGIN_BLOCKED / PORTAL_USER_REVOKE）承担解释。
 */
export async function getPortalViewer(): Promise<PortalViewer | null> {
  const jar = await cookies();
  const payload = readPortalSession(jar.get(PORTAL_COOKIE)?.value);
  if (!payload) return null;

  const user = await prisma.clientPortalUser.findUnique({
    where: { id: payload.uid },
    select: {
      id: true,
      name: true,
      email: true,
      active: true,
      sessionVersion: true,
      clientId: true,
      client: { select: { name: true, deletedAt: true } }
    }
  });
  if (!user) return null;
  if (!user.active) return null;
  if (user.sessionVersion !== payload.sv) return null;
  if (user.client.deletedAt) return null;

  return {
    portalUserId: user.id,
    clientId: user.clientId,
    clientName: user.client.name,
    name: user.name,
    email: user.email
  };
}

/** 要求已登录；未登录跳门户登录页（带回跳地址） */
export async function requirePortalViewer(next?: string): Promise<PortalViewer> {
  const viewer = await getPortalViewer();
  if (!viewer) {
    const qs = next ? `?next=${encodeURIComponent(next)}` : "";
    redirect(`/portal/login${qs}`);
  }
  return viewer;
}

/**
 * 门户页面统一的「未找到」出口。
 *
 * 为什么不用 403：403 等于告诉外部人「这个东西存在，但你无权」。
 * 门户里绝大多数资源是「本客户的材料」，对别的客户应当**连存在性都不可见**。
 */
export function portalNotFound(): never {
  notFound();
}
