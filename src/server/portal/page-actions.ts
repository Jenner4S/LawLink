"use server";

/**
 * 门户页面的表单动作（2026-11-20，门户 S1）
 *
 * 与 `server/portal/actions.ts` 的分工：
 *   · 那边是**业务动作**（邀请/接受/登录/撤销），只返回数据，不碰 cookie
 *   · 这边是**页面动作**，唯一职责是「把业务动作的结果写进 cookie 并跳转」
 *
 * 这样拆的原因是 cookie 只能在 Server Action / Route Handler 里写，
 * 而业务动作被测试直接调用时不希望带 cookie 副作用。
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { acceptPortalInvite, authenticatePortalUser } from "./actions";
import { PORTAL_COOKIE, PORTAL_SESSION_TTL_SECONDS } from "@/lib/portal/auth";

function putSession(value: string) {
  return cookies().then((jar) =>
    jar.set(PORTAL_COOKIE, value, {
      httpOnly: true,
      // 与员工侧同口径：生产走 HTTPS。门户是外部入口，这里更不能放松。
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/portal",
      maxAge: PORTAL_SESSION_TTL_SECONDS
    })
  );
}

/** 登录表单提交。失败时把文案回传页面（不抛，避免整页错误页）。 */
export async function portalLoginAction(_prev: { error?: string } | null, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  try {
    const res = await authenticatePortalUser({ email, password });
    await putSession(res.session);
  } catch (e) {
    // 统一文案：不区分「邮箱不存在」「口令错」「账号停用」
    return { error: e instanceof Error ? e.message : "邮箱或密码不正确" };
  }
  redirect(next && next.startsWith("/portal") ? next : "/portal");
}

/** 接受邀请并设置密码；成功后直接进入门户。 */
export async function portalAcceptInviteAction(_prev: { error?: string } | null, formData: FormData) {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password !== confirm) return { error: "两次输入的密码不一致" };

  try {
    const res = await acceptPortalInvite({ token, password });
    await putSession(res.session);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "邀请无效或已过期" };
  }
  redirect("/portal");
}

/** 退出门户：清 cookie 并回登录页 */
export async function portalLogoutAction() {
  const jar = await cookies();
  jar.delete({ name: PORTAL_COOKIE, path: "/portal" });
  redirect("/portal/login");
}
