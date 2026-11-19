#!/usr/bin/env node
/**
 * Server Action 可达性审计（2026-11-21）
 *
 * ## 为什么需要
 *
 * 2026-11-21 清理死代码时发现：`documents/actions.ts` 的 `fileDocument`
 * 是一个完整的、带权限校验、写审计、26 行的 Server Action —— **全仓零调用方**。
 * 顺着查下去，`clients/actions.ts` 的 `softDeleteClient` 同样零调用。
 *
 * 于是做了一次全量盘点（403 个 `"use server"` 导出）：
 *
 *   被 UI / 应用代码引用        340
 *   仅被测试引用（生产不可达）   13
 *   完全无引用                  50
 *
 * 「导出即能力」是个错觉：一个写在 `"use server"` 文件里、有测试、有守卫、
 * 有审计的函数，用户可能**根本点不到**。AGENTS 规则⑥要求
 * 「已实现能力须有可达入口」，这条审计就是在量这件事。
 *
 * ## 但不可达 ≠ 缺陷
 *
 * 其中一部分是**有意为之**，例如：
 *   · `completeMatterService` / `activateMatterService` —— AGENTS 已明确规定
 *     「服务轴 UI 已整体移除，字段与动作保留，无 UI 入口即不生效」
 *   · `deleteFeeEntry` / `deleteBilling` —— 财务页明示「已入账记录不可直接删除」
 *   · `createMatter` —— 建案走「收案 → 转正式案件」，不直接建
 *
 * 所以这个脚本**不做删除建议**，只做两件事：
 *   ① 登记每一条不可达动作的**判定**（有意 / 死代码 / 待定），必须给理由；
 *   ② **棘轮**：新写了一个用户点不到的动作时报警，逼作者想清楚
 *      「是还没做入口，还是本来就该删」。
 *
 * ## 用法
 *
 *   node scripts/audit-reachability.mjs          # 有未登记的新不可达则退出 1
 *   node scripts/audit-reachability.mjs --list   # 打印全部（含判定与理由）
 *
 * ## 已知局限（如实记）
 *
 * 只做**静态名字引用**匹配。通过动态派发、字符串配置或 Next.js 内部
 * action manifest 触达的情况识别不到；反过来，名字出现在注释里也会算作
 * 「被引用」（当前实现只排除测试文件，不排除注释）。要更准需要解析 AST，
 * 那超出这个脚本的目的——它要的是「有没有明显没人用的东西」。
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LIST_ONLY = process.argv.includes("--list");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const all = walk(path.join(ROOT, "src"));
const texts = new Map(all.map((f) => [f, fs.readFileSync(f, "utf8")]));

/** 收集所有 `"use server"` 文件里的导出 */
const defs = new Map();
for (const [file, src] of texts) {
  if (file.includes(".test.")) continue;
  if (!src.slice(0, 400).includes("use server")) continue;
  for (const m of src.matchAll(/^export async function (\w+)/gm)) defs.set(m[1], file);
}

const uiCount = new Map();
const testCount = new Map();
for (const [name, def] of defs) {
  let ui = 0;
  let tests = 0;
  for (const [file, src] of texts) {
    if (file === def) continue;
    if (!new RegExp(`\\b${name}\\b`).test(src)) continue;
    if (file.includes(".test.")) tests++;
    else ui++;
  }
  if (ui) uiCount.set(name, ui);
  if (tests) testCount.set(name, tests);
}

const unreachable = [...defs.keys()].filter((n) => !uiCount.has(n)).sort();

/**
 * 不可达动作的判定表。
 *
 * 状态：
 *   intentional —— 有意不给入口（有文档或界面文案依据），保留能力
 *   dead        —— 确认是死代码，应删除（清单一经确认可随时删，本脚本不动代码）
 *   undecided   —— 不可达但**尚未判断**，需要产品/维护者定：补入口，还是删
 *
 * 每一条都必须写理由。没有理由的登记等于把「用户点不到的能力」藏起来。
 */
/**
 * 基线快照（2026-11-21 首次盘点时点）。
 *
 * 棘轮只对**超出基线的新名字**报警。基线内的 63 条不阻塞部署 ——
 * 一次性要求全部补入口或全部删除既不现实也会误伤（其中确实有有意保留的能力）。
 * 每条的实际判定见下方 VERDICT；没登记判定的在 --list 里显示为「待定」，
 * 随每轮复审逐步收敛。
 */
const BASELINE = new Set([
  "activateMatterService",
  "allocatePayment",
  "batchApproveArchiveRecords",
  "batchRejectArchiveRecords",
  "bindPartyToEnterprise",
  "checkLoginRequiresTotp",
  "completeMatterService",
  "createFolder",
  "createMatter",
  "deleteBilling",
  "deleteContact",
  "deleteDocument",
  "deleteFeeEntry",
  "deleteFolder",
  "deleteHoliday",
  "deleteNote",
  "deleteProperty",
  "deleteTarget",
  "deleteTask",
  "draftDocument",
  "getCauseById",
  "getDashboardKpis",
  "getEnterpriseSummaryByParty",
  "getExpress",
  "getFirmFileVersionHistory",
  "getMatterAllocationSummary",
  "getSealApprovalCapabilities",
  "getSealRequest",
  "getSealStats",
  "getSmsMessage",
  "getTemplate",
  "getWebhookSettingsAction",
  "getWorkflowTogglesAction",
  "hardDeleteDocument",
  "hasActiveBorrowGrant",
  "listAllDocuments",
  "listArchiveBorrows",
  "listCauseL2",
  "listExpiringProperties",
  "listFoldersByMatter",
  "listInvoiceRequestsByMatter",
  "listMyPasskeys",
  "listRejectedArchiveRecords",
  "listSealRequests",
  "listSmsSuggestions",
  "listTemplates",
  "mergeClients",
  "moveDocumentToFolder",
  "parseDateString",
  "recordFinanceCorrection",
  "renameFolder",
  "reorderFolders",
  "setCommissionPlan",
  "softDeleteClient",
  "softDeleteMatter",
  "triggerAuditCleanupNow",
  "unbindPartyEnterprise",
  "updateFirmFile",
  "updateNote",
  "updatePreservationCase",
  "updateProperty",
  "updateTarget",
  "updateTask"
]);

const VERDICT = {
  // ── 有意：AGENTS 明确规定服务轴 UI 已整体移除 ──
  completeMatterService: ["intentional", "AGENTS：服务轴 UI 已整体移除，字段与动作保留，无入口即不生效"],
  activateMatterService: ["intentional", "同上"],

  // ── 有意：财务页明示「已入账记录不可直接删除」，更正走冲正/退回 ──
  deleteFeeEntry: ["intentional", "财务页明示已入账不可直接删除；更正走 rejectFeeEntry / 冲正"],
  deleteBilling: ["intentional", "合同删除未开放，避免破坏已签署事实与分成依据"],

  // ── 有意：建案动线是「收案 → 转正式案件」 ──
  createMatter: ["intentional", "建案统一走 convertIntakeToMatter；直接建案入口不开放"],

  // ── 死代码：确认无任何引用，且无产品依据要求保留 ──
  hasActiveBorrowGrant: ["dead", "借阅资格的内部判定，未被任何调用方使用"],
  parseDateString: ["dead", "短信日期解析的旧工具函数，解析已改走结构化管线"],

  // ── 待定：无法从代码与文档判定意图，需维护者定 ──
  //   这些不阻塞部署，但每轮复审时应当逐步收敛为 intentional 或 dead。
};

function verdictOf(name) {
  return VERDICT[name] ?? ["undecided", "尚未判断：是补入口，还是删掉"];
}

const counts = { intentional: 0, dead: 0, undecided: 0 };
for (const n of unreachable) counts[verdictOf(n)[0]]++;

console.log("=== Server Action 可达性审计 ===");
console.log(`导出总数：${defs.size}`);
console.log(`被 UI / 应用代码引用：${defs.size - unreachable.length}`);
console.log(`不可达：${unreachable.length}（有意 ${counts.intentional} / 死代码 ${counts.dead} / 待定 ${counts.undecided}）`);

if (LIST_ONLY) {
  for (const n of unreachable) {
    const [status, why] = verdictOf(n);
    console.log(`  [${status}] ${n}  (${path.relative(ROOT, defs.get(n))})\n       ${why}`);
  }
}

const unknown = unreachable.filter((n) => verdictOf(n)[0] === "undecided");
if (unknown.length && process.argv.includes("--strict")) {
  console.log("\n❌ --strict：仍有待定项：");
  for (const n of unknown) console.log(`  ${n}`);
  process.exit(1);
}

// 棘轮：只对**未登记**的新名字报错（登记者用 --list 看，不阻塞）
const brandNew = unreachable.filter((n) => !BASELINE.has(n));
if (brandNew.length) {
  console.log("\n⚠️ 以下动作在 UI/应用代码中零引用，且未在判定表登记：");
  for (const n of brandNew) console.log(`  ${n}  (${path.relative(ROOT, defs.get(n))})`);
  console.log(
    "\n   请二选一：\n" +
      "     · 补上可达入口（AGENTS 规则⑥：已实现能力须有可达入口）；或\n" +
      "     · 在脚本的 VERDICT 里登记判定与理由（intentional / dead）。\n" +
      "   没有理由的登记等于把「用户点不到的能力」藏起来。"
  );
  process.exit(1);
}

console.log("\n=== 没有未登记的新不可达动作 ===");
