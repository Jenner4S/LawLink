#!/usr/bin/env node
/**
 * 钱链路审计覆盖审计（2026-11-22）
 *
 * ## 为什么
 *
 * 律所系统的合规红线是「每一笔金额变更都能追到谁、什么时候、为什么」。
 * 2026-11-22 扫了一遍所有写钱表的函数，发现 `createInvoiceRequest`
 * （137 行、会通知审批人、会校验开票依据）**既不写审计也不写时间线** ——
 * 开票是「钱 + 税」的起点，而批准/驳回/开具三条路径都有 `approvalAudit`，
 * 唯独**申请这一步不留痕**。
 *
 * ## 三种等价的审计写法（少认一种就会误报）
 *
 *   audit({...})            —— 通用审计
 *   auditTx(tx, {...})      —— 事务内审计
 *   approvalAudit(tx, ...)  —— 审批域审计（lib/approvals/service）
 *
 * 2026-11-22 第一次跑这个扫描时只认前两种，把三个开票动作全误报成「无审计」；
 * 实际上批准与驳回用的是 approvalAudit。**这是本会话第三次「扫描器正则太窄」**，
 * 所以把三种写法都登记在这里，并且要求任何新增写法同步加进来。
 *
 * ## 棘轮
 *
 * 事务内 helper（`insertFinanceRowTx` / `createInstallments` / …）本身不写审计，
 * 由调用方在同一个事务里写 —— 这是正确设计，登记在 `BASELINE_HELPERS`。
 * 脚本只对**超出基线的新的无审计函数**报错。
 *
 * ## 已知局限（如实记）
 *
 * · 只看函数体内是否出现审计调用，**不验证参数是否正确**（比如 action 名写错）
 * · 不追踪跨函数调用链（A 调 B，B 写审计，A 会被判为无审计）
 * · 只扫 `src/server`，不扫 `src/app` 里的 Route Handler
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LIST_ONLY = process.argv.includes("--list");

const MONEY_MODEL = /(receivable|payment|allocation|commissionSettlement|feeEntry|billing|invoiceRequest|invoicePaymentAllocation|financeCorrection)\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/;
const MONEY_SQL = /(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"(Receivable|Payment|Allocation|CommissionSettlement|FeeEntry|Billing|InvoiceRequest|InvoicePaymentAllocation|FinanceCorrection)"/i;
/**
 * 五种等价的审计写法（2026-11-22 逐个核对全仓后确认）。
 *
 * 每漏一种就会把「已经写审计」的函数误报成缺口 —— 这一天之内我在这上面
 * 误报了四次：先漏 approvalAudit（开票三动作全误报），
 * 再把 `auditTx?` 写成「auditT + 可选 x」连普通 audit 都匹配不到，
 * 然后漏 auditStrict，最后漏 auditLog.create（roles/actions 直接写库）。
 * 新增写法请同步加到这里，否则这个门禁会开始误伤。
 *
 * **不计入**：`runWithFailureAudit` —— 它只在失败时审计（cron/scheduler.ts），
 * 成功路径不留痕，不能算「有审计」。
 */
const AUDIT = /\b(?:audit|auditTx|auditStrict|approvalAudit)\s*\(|\bauditLog\.create\s*\(/;

/** 事务内 helper：审计由调用方在同一事务里写，因此基线豁免 */
const BASELINE_HELPERS = new Set([
  "insertFinanceRowTx",
  "generateReceivableForBilling",
  "generatePaymentForReceivedEntry",
  "createInstallments",
  "applyCorrectionPlan"
]);

function* functions(src) {
  const marks = [...src.matchAll(/^(?:export )?(?:async )?function /gm)].map((m) => m.index);
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1] : src.length;
    const seg = src.slice(start, end);
    const name = /^(?:export )?(?:async )?function (\w+)/.exec(seg)?.[1];
    if (name) yield { name, seg, line: src.slice(0, start).split("\n").length };
  }
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name.endsWith(".ts") && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

const findings = [];
let checked = 0;
for (const abs of walk(path.join(ROOT, "src/server"))) {
  const src = fs.readFileSync(abs, "utf8");
  const rel = path.relative(path.join(ROOT, "src"), abs).split(path.sep).join("/");
  for (const { name, seg, line } of functions(src)) {
    const writesMoney =
      MONEY_MODEL.test(seg) || MONEY_SQL.test(seg) || seg.includes("insertFinanceRowTx");
    if (!writesMoney) continue;
    checked++;
    if (AUDIT.test(seg)) continue;
    if (BASELINE_HELPERS.has(name)) continue;
    findings.push({ rel, line, name });
  }
}

console.log("=== 钱链路审计覆盖审计 ===");
console.log(`写钱表的函数：${checked}`);
console.log(`无审计且不在基线：${findings.length}`);

if (LIST_ONLY) {
  for (const f of findings) console.log(`  ⚠️  ${f.rel}:${f.line}  ${f.name}`);
}

const baselineNames = [...BASELINE_HELPERS];
if (findings.length) {
  console.log("\n❌ 以下函数写钱表但没有写审计（合规红线：金额变更必须可追溯）：");
  for (const f of findings) console.log(`  ${f.rel}:${f.line}  ${f.name}`);
  console.log(
    "\n   请二选一：\n" +
      "     · 补审计：audit({...}) / auditTx(tx, {...}) / approvalAudit(...)；或\n" +
      "     · 若它是事务内 helper，把名字加进本脚本的 BASELINE_HELPERS 并说明。\n" +
      `   当前基线 helper：${baselineNames.join(", ")}`
  );
  process.exit(1);
}

console.log("\n=== 所有写钱函数都有审计（或属已登记的事务内 helper） ===");
