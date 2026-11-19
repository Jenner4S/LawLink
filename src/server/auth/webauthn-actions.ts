"use server";

/**
 * Passkey 的会话态服务端动作（台账 P2-2 后半）。
 *
 * 这里只做三件事：取会话、调服务层、revalidate。真正的仪式与安全判定全部在
 * src/server/auth/webauthn-service.ts（未标 "use server"，因此不会被当成
 * 可被任意客户端直呼的 RPC 端点——这是 2026-09-19 TOTP 事故的教训）。
 *
 * 注册要求已登录 + 重新输入当前密码（红线 5）；登录验签不走 server action，
 * 走 app/api/auth/webauthn/login/*，因为登录页是未登录状态。
 */
import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import {
  beginRegistration,
  deleteCredential,
  finishRegistration,
  listCredentials,
  type PasskeyCredentialView,
  type WebAuthnActor
} from "./webauthn-service";

function actorOf(session: Awaited<ReturnType<typeof requireSession>>): WebAuthnActor {
  return { id: session.user.id, role: session.user.role };
}

/** 开始注册：返回浏览器要传给 navigator.credentials.create 的 options */
export async function startPasskeyRegistration(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const session = await requireSession("personal");
  return beginRegistration(actorOf(session));
}

/** 完成注册：attestation + 设备备注 + 当前密码二次确认 */
export async function completePasskeyRegistration(input: unknown): Promise<{ id: string; deviceName: string | null }> {
  const session = await requireSession("personal");
  const result = await finishRegistration(actorOf(session), input);
  revalidatePath("/settings/profile");
  return result;
}

/** 当前账号已绑定的通行密钥 */
export async function listMyPasskeys(): Promise<PasskeyCredentialView[]> {
  const session = await requireSession("personal");
  return listCredentials(actorOf(session));
}

/** 删除一台设备的通行密钥（保留至少一种登录方式） */
export async function removePasskey(input: unknown): Promise<{ ok: true }> {
  const session = await requireSession("personal");
  const result = await deleteCredential(actorOf(session), input);
  revalidatePath("/settings/profile");
  return result;
}
