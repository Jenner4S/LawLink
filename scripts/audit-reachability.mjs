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
  "mergeClients",
  "batchApproveArchiveRecords",
  "batchRejectArchiveRecords",
  "checkLoginRequiresTotp",
  "completeMatterService",
  "createFolder",
  "createMatter",
  "deleteBilling",
  "deleteDocument",
  "deleteFeeEntry",
  "deleteFolder",
  "deleteTask",
  "getCauseById",
  "getDashboardKpis",
  "getEnterpriseSummaryByParty",
  "getExpress",
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
  "listInvoiceRequestsByMatter",
  "listMyPasskeys",
  "listSealRequests",
  "listSmsSuggestions",
  "listTemplates",
  "parseDateString",
  "recordFinanceCorrection",
  "renameFolder",
  "reorderFolders",
  "softDeleteMatter",
  "triggerAuditCleanupNow",
]);

const VERDICT = {
  // ── 有意：AGENTS 明确规定服务轴 UI 已整体移除 ──
  completeMatterService: ["intentional", "AGENTS：服务轴 UI 已整体移除，字段与动作保留，无入口即不生效"],
  activateMatterService: ["intentional", "同上"],

  // ── 有意：财务页明示「已入账记录不可直接删除」，更正走冲正/退回 ──
  deleteFeeEntry: ["intentional", "财务页明示已入账不可直接删除；更正走 rejectFeeEntry / 冲正"],
  // 2026-11-22 判定：不是缺口。responsibilityReady 只查 WorkResponsibility 表是否存在，
  // 该表由 0_init 迁移创建、生产恒为真 → deleteTask 第一句就抛错。
  // 取消任务走责任面板 CANCEL。给它补按钮只会得到一个永远失败的按钮。
  deleteTask: ["dead", "责任面板启用后被 CANCEL 取代；首句守卫恒抛错，函数体不可达。应删除而非补入口"],
  // 2026-11-20 核实：batchApproveArchiveRecords 的**整个函数体就是一句 throw**
  // （archive/actions.ts:707-708「归档申请必须逐件核对制度、材料和人工核验事项，不能批量通过」）。
  // 它不是"缺入口"，是刻意禁用——补 UI 只会得到一个永远失败的按钮。
  batchApproveArchiveRecords: ["dead", "函数体恒抛「不能批量通过」；刻意禁用，补 UI 只会得到永远失败的按钮。应删除"],
  // ── 2026-11-20 第二批判定：页面已用「不带 Action 后缀」或「内联查询」的替代路径 ──
  getWebhookSettingsAction: ["dead", "重复包装：/admin/reminders 直接调 getWebhookSettings()，本 action 无调用方"],
  getWorkflowTogglesAction: ["dead", "重复包装：/admin/firm-profile 直接调 getWorkflowToggles()，本 action 无调用方"],
  listSmsSuggestions: ["dead", "重复查询：收件箱页在 prisma.smsMessage 查询里内联 include suggestions，本 lister 无调用方"],
  listExpiringProperties: ["dead", "重复实现：保全页在客户端由 allProperties 算 expiring30（KPI 卡「30天内到期」），本 action 无调用方"],
  // ── 2026-11-20 第三批：用章线按「台账页未单独建」定性（代码注释亦已说明） ──
  // seals/actions.ts:125-133 明写 getSealApprovalCapabilities 是**陷阱**：
  // requireSession("approval") 后把 canApprove/canViewFirmQueue 硬编码 true，
  // 「看起来能用、用起来会放行」。现用印审批走 /approvals?type=SEAL_APPROVE 由
  // requireApprovalRoute + canDecide 逐条判定，零引用下无害；保留但要启用必须先重写。
  getSealApprovalCapabilities: ["intentional", "陷阱函数：硬编码 canApprove=true，启用前必须按真实权限重写（代码注释已警告）"],
  getSealRequest: ["intentional", "功能正确但低效（拉全所队列再 find），用章台账页未单独建，保留待接线"],
  getSealStats: ["intentional", "依赖同样未接线的 listSealRequests；用章台账页未建，保留待接线"],
  // 卷宗目录由 default-folders 自动创建并给定 orderIndex，不开放手工排序
  reorderFolders: ["intentional", "卷宗目录顺序由 default-folders 决定，不开放手工排序（建/删目录本就未开放）"],
  // 2026-11-20：绑定/解绑已补入口（当事人卡片「绑定工商 / 改绑 / 解绑」）。
  // 企业概览**刻意不自动调用**——元典按 10 POINT/次计费，渲染时就发请求等于悄悄烧钱；
  // 保留待「显式点击才查」的入口，不在列表/详情渲染路径上挂。
  getEnterpriseSummaryByParty: ["intentional", "元典按 10 POINT/次计费，刻意不做自动查询；待显式「查看企业概览」入口"],
  deleteBilling: ["intentional", "合同删除未开放，避免破坏已签署事实与分成依据"],

  // ── 有意：建案动线是「收案 → 转正式案件」 ──
  createMatter: ["intentional", "建案统一走 convertIntakeToMatter；直接建案入口不开放"],
  // 2026-11-20 核实：mergeClients 是**内部函数**，不是缺入口。
  // dedup.ts:85 由可达的 mergeClientsByCode 在同一事务内调用（注释即写明「页面入口用」），
  // 客户详情页已有「按客户编号合并」入口。之前挂在待定是因为只看了它自身零 UI 引用。
  mergeClients: ["intentional", "由可达的 mergeClientsByCode 内部调用（dedup.ts:85），页面入口已存在"],
  // 2026-11-20 核实：这两条**不是缺口**，是刻意的兼容层。
  // allocatePayment 在账本就绪时直接转调可达的 allocateLedger（allocation.ts:45-48），
  // 只在「旧库（账本未就绪）」或「旧客户端未传 revision」时走自身旧实现。
  allocatePayment: ["intentional", "账本就绪时转调可达的 allocateLedger；仅旧库/旧客户端未传 revision 时走自身路径"],
  // recordFinanceCorrection 在账本就绪时**主动抛错并指引**去「退款与账务更正区」提交申请
  // （allocation.ts:144），即「旧入口不直接更改余额」——留着只为老库降级可用。
  recordFinanceCorrection: ["intentional", "旧入口：账本就绪时主动拒绝并指引新路径，保留供老库降级"],

  // ── 死代码：确认无任何引用，且无产品依据要求保留 ──
  hasActiveBorrowGrant: ["dead", "借阅资格的内部判定，未被任何调用方使用"],
  parseDateString: ["dead", "短信日期解析的旧工具函数，解析已改走结构化管线"],

  // ── 2026-11-22 收敛（Round 149）：按「同文件/同模块内是否已有可达同类」判定 ──
  //   判定依据只有两条，不猜产品意图：
  //     ① 同一模块内已有可达的同类动作（改名残留 / 被新版取代）→ dead
  //     ② 有意为之且能指出依据（AGENTS 规定 / 界面文案 / 自动创建）→ intentional
  checkLoginRequiresTotp: ["dead", "同文件 checkLoginTotpEnforcement 已可达，本函数为旧名残留"],
  listMyPasskeys: ["dead", "passkey 列表已由 webauthn-service 的 listCredentials + listCredentials 动作提供"],
  getExpress: ["dead", "同文件 listExpress 已可达，单条读取无调用方"],
  getSmsMessage: ["dead", "同文件 listSmsMessages 已可达，单条读取无调用方"],
  listTemplates: ["dead", "同文件 listTemplatesForAdmin 已可达，本条为旧版"],
  getTemplate: ["dead", "模板渲染走 renderTemplate（可达），单条读取无调用方"],
  getCauseById: ["dead", "案由检索走 searchCauses（可达）"],
  listCauseL2: ["dead", "案由二级列表并入 searchCauses（可达）"],
  getDashboardKpis: ["dead", "工作台改由 7 个专用 getter 拼装（均可达），聚合版无调用方"],
  getMatterAllocationSummary: ["dead", "案件财务汇总走 getMatterFinance（可达）"],
  listInvoiceRequestsByMatter: ["dead", "案件开票上下文走 getMatterInvoiceContext（可达）"],
  hasActiveBorrowGrant: ["dead", "借阅资格判定已内联进 borrow.ts 的读取路径"],
  parseDateString: ["dead", "短信日期解析改走结构化管线，旧工具函数无调用方"],
  triggerAuditCleanupNow: ["dead", "审计清理仅由 cron 调度；手动触发入口只对归档扫描与周报开放"],
  createFolder: ["intentional", "卷宗文件夹由 default-folders 自动创建（结案/归档等），不开放手动建"],
  renameFolder: ["intentional", "同上：默认卷宗不允许改名"],
  deleteFolder: ["intentional", "同上：默认卷宗不允许删除"],
  createMatter: ["intentional", "建案统一走 convertIntakeToMatter"],
  softDeleteMatter: ["intentional", "案件删除未对外开放，终态走归档；动作保留供运维与测试"],
  deleteDocument: ["intentional", "材料删除未开放，避免破坏已归档卷宗与版本链"],
  hardDeleteDocument: ["intentional", "硬删除仅运维使用，不开放 UI"],
  deleteFeeEntry: ["intentional", "财务页明示已入账不可直接删除，更正走冲正"],
  deleteBilling: ["intentional", "合同删除未开放，避免破坏已签署事实"],
  completeMatterService: ["intentional", "AGENTS：服务轴 UI 已整体移除"],
  activateMatterService: ["intentional", "同上"],
  listArchiveBorrows: ["intentional", "借阅列表在 /archive 页面用 listArchivePageData 一并取（可达）"],
  listSealRequests: ["intentional", "用印列表由审批收件箱与案件页直接取数（可达路径），本函数为旧入口"],

  // ── 仍需产品决定（本脚本不替产品拍板，如实留待定） ──
  //
  //   下面这些**没有可达的同类替代**，也就是说：功能写好了，但用户点不到。
  //   需要维护者决定「补入口」还是「删掉」，本脚本不预设答案：
  //
  //   · updateTask —— **2026-11-22 已补入口**（案件办案进程待办行的「改」按钮，
  //       见 task-edit-dialog.tsx）；已从 BASELINE 移除，将来 UI 被删会重新报警。
  //   · deleteTask —— **不是缺口，是设计性死代码**：`responsibilityReady` 只判断
  //       `WorkResponsibility` 表是否存在，该表由 0_init 迁移创建、生产恒为真，
  //       所以 deleteTask 第一句就抛「请在事项责任面板取消任务并填写原因，原记录保留」。
  //       取消任务要走责任面板的 CANCEL 动作。**不要给它补按钮**（会是一个永远失败的按钮），
  //       真正的处理是删掉这个函数或让它退役。
  //   · updateNote / deleteNote —— **2026-11-22 已补入口**（经办记录行的「改/删除」，
  //       只对作者本人显示；见 note-edit-dialog.tsx）。
  //       已从 BASELINE 移除，将来 UI 被删会重新报警。
  //   · updateFirmFile / getFirmFileVersionHistory —— **2026-11-20 已补入口**（律所资料行加「历史」与「编辑」，
  //       见 firm-file-history-dialog.tsx / firm-file-edit-dialog.tsx）。已从 BASELINE 移除。
  //   · bindPartyToEnterprise / unbindPartyEnterprise / getEnterpriseSummaryByParty —— 工商绑定只写在服务层
  //   · updatePreservationCase / updateTarget / deleteTarget / updateProperty / deleteProperty
  //       / listExpiringProperties —— 保全只能新建、续封、解除，改与删无入口
  //   · moveDocumentToFolder / reorderFolders —— 文件夹排序与移动无入口（默认卷宗自动建）
  //   · batchApproveArchiveRecords / batchRejectArchiveRecords / listRejectedArchiveRecords —— 批量审批无入口
  //   · draftDocument（AI 起草）—— 其余 AI 动作均可达
  //   · allocatePayment / recordFinanceCorrection / setCommissionPlan —— 与可达的
  //       allocateLedger / submitCorrection+decideCorrection / settleCommission 是否同义待确认
  //   · mergeClients —— **已核实为内部函数**：由可达的 mergeClientsByCode 在同一事务内调用
  //       （dedup.ts:85，注释写明「页面入口用」）。页面入口本就存在，不是缺口。
  //   · deleteContact —— 联系人只能加不能删
  //   · deleteHoliday —— 放假安排只能批量保存（可能已含删除）
  //   · getWebhookSettingsAction / getWorkflowTogglesAction —— 只有保存可达，读取走服务端直读
  //   · checkLoginRequiresTotp 之外的 sms.listSmsSuggestions —— 建议列表由收件箱一并取
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
