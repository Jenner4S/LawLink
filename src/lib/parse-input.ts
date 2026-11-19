import type { ZodType } from "zod";

import { ActionError } from "./action-error";

/**
 * 统一的输入校验入口：schema 校验失败时抛 **ActionError**，而不是让 ZodError 冒泡。
 *
 * 为什么不是直接用 `schema.parse()`：
 *
 *   1. Next.js 生产环境会通过 React Flight 脱敏抛出的错误，客户端只看到
 *      "Minified React error #441"，用户完全不知道哪个字段填错了。
 *   2. 项目现有做法是给 ZodError.prototype 装 digest getter 把中文消息透出去，
 *      但 **zod 4 下这条路走不通**（2026-11-19 实测）：`z.parse()` 抛出的实例
 *      原型链是 `ZodError → Error → Object`，与 `import { ZodError } from "zod"`
 *      拿到的那个类不是同一个对象（`instanceof` 为 true 是靠 `Symbol.hasInstance`），
 *      给它装 getter 对实际实例无效，`e.digest` 恒为 undefined。
 *   3. ActionError 自带 digest 通道（`ACTION_ERROR:` 前缀），已验证有效，
 *      所以统一收敛到这里，不再依赖对第三方库原型的改造。
 *
 * 语义与 `schema.parse()` 完全一致：成功返回解析后的数据（含默认值、transform），
 * 失败抛错。只是错误类型从 ZodError 换成带中文消息的 ActionError。
 */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  // 取前两条，与既有 digest 通道的口径一致（避免一次抛出一屏错误）
  const messages = result.error.issues
    .slice(0, 2)
    .map((issue) => issue.message)
    .filter(Boolean);

  throw new ActionError(messages.join("；") || "输入信息有误，请检查后重试");
}
