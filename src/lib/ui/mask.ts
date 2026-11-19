/**
 * 脱敏工具（纯函数，服务端与客户端通用）。
 *
 * 2026-11-19：初版把 maskIdNumber 放在 "use client" 的组件文件里，服务端组件
 * （客户详情页）调用时报 "Attempted to call ... from the server but ... is on the client"。
 * 纯函数不属于任何渲染层，必须放在无 "use client" 的模块里。
 */

/** 身份证号 / 统一社会信用代码：保留前 4 位与后 4 位，中间打码 */
export function maskIdNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 8) return "****";
  return `${s.slice(0, 4)}${"*".repeat(Math.max(4, s.length - 8))}${s.slice(-4)}`;
}

/** 手机号：保留前 3 位与后 2 位 */
export function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 5) return "****";
  return `${s.slice(0, 3)}****${s.slice(-2)}`;
}
