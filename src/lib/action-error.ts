/**
 * Server Action 业务错误通道。
 *
 * 背景（2026-09-21 production 实测）：Next.js 生产构建下，server action 抛出的
 * Error 经 React Flight 序列化时 message 会被脱敏——客户端 catch 到的
 * err.message 是「Minified React error #441」占位符，而不是服务端写的中文提示。
 * digest 是唯一可靠到达客户端的错误文本通道（Next 官方 error boundary 同样依赖它）。
 *
 * 约定：
 * - 服务端「面向用户的业务校验失败」一律 `throw new ActionError("中文提示")`；
 *   ActionError 构造时把消息同时写入 digest，客户端经 actionErrorMessage 读取。
 * - 内部错误（编程缺陷、数据库异常等）继续 throw 原生 Error——保持生产脱敏，
 *   不向客户端泄漏内部细节。
 * - dev 模式下 message 本身可达，两种 Error 行为一致。
 */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
    // React Flight 在生产构建只透传 digest；把它设为业务消息本身。
    (this as Error & { digest?: string }).digest = `ACTION_ERROR:${message}`;
  }
}

import { ZodError } from "zod";

// ZodError 同样经 React Flight 脱敏（2026-09-21 生产实测：schema.parse 的校验失败
// 在客户端表现为 Minified React error #441）。zod 的 issue message 本仓库全部面向
// 用户（中文），把首条消息经 digest 通道透出；只影响 ZodError 原型，不碰其他 Error。
// 2026-11-19（zod 4 升级）：原实现用 `if (!("digest" in ZodError.prototype))` 做幂等判断，
// 在 zod 4 下该判断与实际安装状态不一致——实测 getter 未生效，导致所有 schema 校验失败
// 在客户端只剩 "Minified React error #441"，用户看不到任何中文提示。
// 改用 Symbol 标记判断是否已安装，并在失败时如实打日志（不静默降级）。
const ZOD_DIGEST_MARK = Symbol.for("lawlink.zodDigestInstalled");
type DigestTarget = { [ZOD_DIGEST_MARK]?: boolean; digest?: string };

(function installZodDigest(proto: DigestTarget) {
  if (!proto || proto[ZOD_DIGEST_MARK]) return;
  try {
    Object.defineProperty(proto, "digest", {
      get(this: InstanceType<typeof ZodError>) {
        const msgs = this.issues.slice(0, 2).map((i) => i.message).filter(Boolean);
        return `ACTION_ERROR:${msgs.join("；") || "输入信息有误，请检查后重试"}`;
      },
      configurable: true
    });
    proto[ZOD_DIGEST_MARK] = true;
  } catch (err) {
    // 装不上就等于生产环境所有校验提示对用户不可见，必须可见地失败而不是静默
    console.error("[action-error] ZodError.digest 安装失败，校验提示将无法透出：", err);
  }
})(ZodError.prototype as DigestTarget);

const ACTION_ERROR_PREFIX = "ACTION_ERROR:";

/** 提取面向用户的错误文案：优先 ActionError 的 digest 通道，退回 message。 */
export function actionErrorMessage(err: unknown): string {
  // 兜底：即使 digest 通道不可用（开发环境、或 getter 安装失败），
  // ZodError 的 issues 里也带着面向用户的中文消息，直接读出来。
  if (err instanceof ZodError) {
    const msgs = err.issues.slice(0, 2).map((i) => i.message).filter(Boolean);
    if (msgs.length) return msgs.join("；");
  }
  if (err instanceof Error) {
    const digest = (err as Error & { digest?: string }).digest;
    if (typeof digest === "string" && digest.startsWith(ACTION_ERROR_PREFIX)) {
      return digest.slice(ACTION_ERROR_PREFIX.length);
    }
    return err.message;
  }
  return err ? String(err) : "";
}
