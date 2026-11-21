/**
 * 线索列表的列定义（2026-11-23）
 *
 * 单独放在 `src/lib` 而不是 `src/server/settings`：**客户端组件要用它渲染表头**，
 * 而 `src/server/settings/leads-columns.ts` 里 import 了 prisma。
 * 让客户端 import 那个模块会把 server-only 代码拖进浏览器包 ——
 * 构建能过、运行时页面直接崩（本项目为此踩过两次，这是第三次，记在这里）。
 *
 * 本文件只允许放纯常量与类型，不得 import prisma / next-headers 等 server-only 模块。
 */

export const LEADS_COLUMNS = [
  { key: "name", label: "线索人" },
  { key: "source", label: "来源" },
  { key: "stage", label: "阶段" },
  { key: "activity", label: "跟进" },
  { key: "owner", label: "负责人" },
  { key: "updatedAt", label: "最近更新" }
] as const;

export type LeadsColumnKey = (typeof LEADS_COLUMNS)[number]["key"];
