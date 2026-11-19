/**
 * Prisma 错误判定小助手（2026-11-21）。
 *
 * 为什么抽出这个文件：
 *
 * 全仓原本有 6 处各自手写同一段判断：
 *
 *   if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") { ... }
 *
 * 这个表达式的**语义有三个容易记错的点**，散着写必然有人写错：
 *
 *   1. 必须同时判 `instanceof` 与 `code` —— 只看 `code` 会把任何带 code 字段的
 *      普通对象（比如某些 SDK 的错误）也当成 Prisma 错误；
 *   2. `meta.target` 的类型在 Prisma 5 里既可能是字符串数组，也可能是拼接后的字符串
 *      （不同 driver 不同），所以取唯一约束字段名要两种都兜；
 *   3. P2002 的 target 可能是复合唯一键，必须按「是否包含某字段」判断，
 *      不能整体相等比较。
 *
 * 这里只提供判定与取值，**不提供统一文案** —— 因为「名称已存在」与
 * 「归档号被占用，请重试」对用户是完全不同的指令，必须由调用方自己写。
 * 统一的错误翻译是产品决策，不是工具的事。
 */

/** 是否是带特定 code 的 Prisma 已知错误 */
export function isPrismaError(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "PrismaClientKnownRequestError" &&
    (err as { code?: string }).code === code
  );
}

/** P2002（唯一约束冲突）命中的字段名；无法解析时返回空数组 */
export function uniqueViolationTargets(err: unknown): string[] {
  if (typeof err !== "object" || err === null) return [];
  const meta = (err as { meta?: { target?: unknown } }).meta;
  if (!meta) return [];
  const target = meta.target;
  if (Array.isArray(target)) return target.map(String);
  if (typeof target === "string") {
    // 形如「Unique constraint failed on the fields: (`archiveNo`)」或 "Field name"
    const paren = target.match(/\(([^)]+)\)/);
    const raw = paren ? paren[1] : target;
    return raw
      .split(/[,\s]+/)
      .map((s) => s.replace(/[`"']/g, "").trim())
      .filter(Boolean);
  }
  return [];
}

/** 该唯一约束冲突是否涉及某字段 */
export function uniqueViolationOn(err: unknown, field: string): boolean {
  return uniqueViolationTargets(err).includes(field);
}
