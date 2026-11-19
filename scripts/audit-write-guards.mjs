#!/usr/bin/env node
/**
 * 写守卫一致性审计（2026-11-21）
 *
 * ## 为什么需要
 *
 * 2026-11-21 两天里连着抓到三处「同一条规则、不同写路径各行其是」：
 *   · 材料版本切换   → 两个独立提交（Round 124）
 *   · 已归档案件的关联关系仍可增删（Round 144）
 *   · 已归档案件仍可新增证据项（Round 145）
 *
 * 每次都是「逐个函数去问同一句话」才发现的。这个脚本把那句话固化下来：
 *
 *   **涉及案件的写操作，有没有状态守卫？**
 *
 * ## 棘轮设计（关键）
 *
 * 存量里有一批**合理豁免**（审批动作的对象本就是已提交申请、创建类动作没有
 * 已存在的案件可锁）。一次性要求全部加守卫会误伤真实动线。
 *
 * 所以采用棘轮：`KNOWN_EXEMPT` 里登记当前已确认可豁免的条目（附理由），
 * 脚本**只对不在清单里的新条目报错**。于是：
 *   · 历史遗留 → 不阻塞
 *   · 新增代码 → 必须显式决定「要不要守卫，不要的话为什么」
 *
 * ## 用法
 *
 *   node scripts/audit-write-guards.mjs           # 有新漏网则退出 1
 *   node scripts/audit-write-guards.mjs --list    # 打印完整清单（含豁免理由）
 *
 * ## 为什么单独成脚本而不并进 mutation-check
 *
 * mutation-check 是「故意破坏 → 看守卫是否报警」的探针集；
 * 这个是**对现状的静态审计**。两者性质不同：前者验证守卫本身，后者盘点覆盖面。
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LIST_ONLY = process.argv.includes("--list");

/** 守卫的四种等价形态 —— 少认一种就会把自己骗过去（2026-11-21 踩过） */
const GUARD = /assertMatterWritable\(|assertDocumentWritable\(|status\s*===\s*["']ARCHIVED["']|status\s*!==\s*["']ARCHIVED["']|assertArchiveNotLocked/;

/**
 * 已确认可豁免的条目（键 = `<相对路径>  <函数名>`）。
 *
 * 每一条都必须写明理由 —— 没有理由的豁免等于把缺陷藏起来。
 * 新增豁免请先想清楚「这个动作作用的对象，是不是一个可能已归档的案件」。
 */
const KNOWN_EXEMPT = {
  // ── 审批类：审批对象本就是已提交的申请；归档审批更必须在归档案件上做 ──
  "archive/actions.ts  approveArchiveRecord": "审批归档申请：对象就是归档案件本身",
  "archive/actions.ts  rejectArchiveRecord": "驳回归档申请：同上",
  "documents/actions.ts  approveDocument": "审批材料：审批人不是经办人，且审批不改案件正文",
  "documents/actions.ts  rejectDocument": "驳回材料：同上",
  "seals/actions.ts  approveSealRequest": "审批用印申请",
  "seals/actions.ts  rejectSealRequest": "驳回用印申请",
  "seals/actions.ts  stampSealRequest": "执行盖章：用印流程的状态推进",
  "seals/actions.ts  cancelSealRequest": "撤销用印申请",
  "invoices/actions.ts  approveInvoiceRequest": "审批开票申请（BUGFIX-20260906 第 11 条：入口已单独查可写）",
  "invoices/actions.ts  rejectInvoiceRequest": "驳回开票申请（同上）",

  // ── 创建类：没有已存在的案件可锁 ──
  "matters/actions.ts  createMatter": "创建案件，此时案件还不存在",
  "engagements/actions.ts  createEngagement": "创建委托，matterIds 仅用于挂链",
  "intakes/actions.ts  convertIntakeToMatter": "收案转正式案件，对象是收案不是案件",
  "conflicts/actions.ts  runCheckAndSave": "冲突检索，写的是检索记录",
  "ethical-walls/actions.ts  createEthicalWall": "管理员配置",
  "ethical-walls/actions.ts  liftEthicalWall": "管理员配置",
  "archive/borrow.ts  createArchiveBorrow": "借阅申请：**已归档案件正是它的目标**",
  "sms/actions.ts  parseAndSaveSms": "收件箱解析，案件归属是后续建议",
  "sms/actions.ts  uploadSmsInboundFile": "收件箱文件上传",
  "sms/extract-core.ts  runSmsAttachmentExtraction": "取件队列内部执行",

  // ── 元数据/记录类：归档后仍可能合法产生（产品口径决定，非缺陷） ──
  "emails/actions.ts  archiveEmail": "邮件归档：归档后仍可能收到法院邮件，属真实动线",
  "emails/actions.ts  linkEmailToMatter": "邮件关案：同上",
  "engagements/actions.ts  linkEngagementMatter": "委托挂链：委托是客户级合同，跨案件存续",
  "engagements/actions.ts  terminateEngagement": "终止委托：结案后仍可能终止并结算",
  "express/actions.ts  refreshExpress": "快递轨迹刷新：外部数据同步",
  "express/actions.ts  deleteExpress": "删除快递记录",
  "clients/dedup.ts  mergeClients": "客户合并，对象是客户不是案件",
  "ai/review-document.ts  reviewDocument": "AI 审查，写的是审查记录",
  "yuandian/enterprise.ts  bindPartyToEnterprise": "当事人工商信息绑定",
  "yuandian/enterprise.ts  unbindPartyEnterprise": "当事人工商信息解绑",
};

function* segments(src) {
  const marks = [...src.matchAll(/^export (?:async )?function /gm)].map((m) => m.index);
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i];
    const end = i + 1 < marks.length ? marks[i + 1] : src.length;
    const seg = src.slice(start, end);
    const name = /^export (?:async )?function (\w+)/.exec(seg)?.[1];
    if (name) yield [name, seg];
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full);
  }
  return out;
}

const found = [];
let checked = 0;
for (const abs of walk(path.join(ROOT, "src/server"))) {
  const src = fs.readFileSync(abs, "utf8");
  if (!src.slice(0, 300).includes("'use server'") && !src.slice(0, 300).includes('"use server"')) continue;
  const rel = path.relative(path.join(ROOT, "src/server"), abs).split(path.sep).join("/");
  for (const [name, seg] of segments(src)) {
    if (!/\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/.test(seg)) continue;
    if (!/matterId|MatterId/.test(seg)) continue;
    checked++;
    if (GUARD.test(seg)) continue;
    found.push(`${rel}  ${name}`);
  }
}

const unknown = found.filter((k) => !(k in KNOWN_EXEMPT));
const stale = Object.keys(KNOWN_EXEMPT).filter((k) => !found.includes(k));

console.log("=== 写守卫一致性审计 ===");
console.log(`涉及案件的写操作：${checked}`);
console.log(`无状态守卫：${found.length}（其中已登记豁免 ${found.length - unknown.length}）`);

if (LIST_ONLY) {
  console.log("\n-- 待决（未登记豁免）--");
  for (const k of unknown) console.log(`  ⚠️  ${k}`);
  console.log("\n-- 已登记豁免 --");
  for (const [k, why] of Object.entries(KNOWN_EXEMPT)) console.log(`  ✓  ${k}\n       ${why}`);
}

if (stale.length) {
  console.log("\n⚠️ 以下豁免条目已不存在（可能被改名或删除），请清理清单：");
  for (const k of stale) console.log(`  ${k}`);
}

if (unknown.length) {
  console.log("\n❌ 有新的写操作既没有状态守卫、也没有登记豁免理由：");
  for (const k of unknown) console.log(`  ${k}`);
  console.log(
    "\n   请二选一：\n" +
      "     · 加 assertMatterWritable(实体所属的 matterId)；或\n" +
      "     · 在脚本的 KNOWN_EXEMPT 里登记，并写清「为什么这个动作不需要」。\n" +
      "   没有理由的豁免等于把缺陷藏起来。"
  );
  process.exit(1);
}

console.log("\n=== 没有未登记的新漏网 ===");
