#!/usr/bin/env node
/**
 * 时区口径审计（2026-11-23）
 *
 * ## 背景
 *
 * 容器跑在 **UTC**，业务口径是**上海（+08:00）**。
 * 直接用 `date.getFullYear()/getMonth()/getDate()` 取字段来构造日期边界，
 * 在 UTC 下会得到上海 08:00 —— 跨日算出的日期**差一天**。
 *
 * 已有一次真实事故：线索质量环比的月界按本地字段算，
 * 「上海本月 00:00 登记的线索」被判成上月，环比全是 null，
 * 投放成本月份也错开一个月。
 *
 * ## 这个脚本做什么
 *
 * 静态扫描 `src/` 里对本地日历字段的使用，输出**清单并要求逐条处置**：
 *   · 业务口径（统计、月界、期限、保全）→ 必须用 `@/lib/tz` 或 `shMonthStart`
 *   · 纯展示 → 用 `formatDate`（已固定 Asia/Shanghai）
 *   · 无所谓（日志耗时、排序无关）→ 登记到本文件的白名单里并写理由
 *
 * 白名单里的每条都必须有一句"为什么这里不用改"，否则等于没审。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SRC = path.join(ROOT, "src");

/** 已审过、确认无需改的位置（路径片段 → 理由） */
const ALLOWED = new Map([
  ["lib/tz.ts", "时区工具本身：这里就必须用 UTC getter 读偏移后的时刻"],
  ["lib/utils.ts", "formatDate 已显式 timeZone: Asia/Shanghai"],
  ["app/(app)/schedule/_components/schedule-view.tsx", "日历游标只用于取月份标题与网格起点，展示层按浏览器本地；已在文档登记为已知差异"],
  ["app/(admin)/admin/reminders/page.tsx", "只取年份做节假日表标题；跨年时多显示一行不影响数据（已在文档登记）"],
  ["lib/deadline-rules.ts", "已改用 civilFromKey(shDayKey()) 正午载体，文件内无本地字段（2026-11-23）"],
  ["lib/preservation-defaults.ts", "defaultDurationDays/addDays 已与期限引擎同源（正午载体）"],
  ["lib/legal-calc.ts", "addDays 已走正午载体；工作日循环按日期键比较（修过一次死循环）"],
  ["lib/ui/sh-time.ts", "civilKey 取的是正午载体的本地字段：正午 12:00(+08)=04:00Z，UTC 部署下即正确日；若将来跨 LA 等时区部署需改（已在文档登记）"],
  ["lib/storage/local.ts", "yyyymm 只用于分月目录名，差 8 小时最多让少量文件进上月目录，不影响功能"],
  ["lib/storage/s3.ts", "同上（S3 key 分月前缀）"],
  ["server/reports/weekly.ts", "在正午载体（04:00Z）上用本地字段推进周界：UTC 部署下 UTC 日期即上海日，正确"]
]);

/** 只看这几类"取字段"的调用 —— 它们最容易把本地时区带进业务口径 */
const PATTERNS = [
  { re: /\.getFullYear\s*\(/g, what: "getFullYear" },
  { re: /\.getMonth\s*\(/g, what: "getMonth" },
  { re: /\.getDate\s*\(/g, what: "getDate" }
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC);
const hits = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  const allowedReason = [...ALLOWED.entries()].find(([k]) => rel.includes(k));
  if (allowedReason) continue;
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    // 跳过整行注释
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;
    for (const { re, what } of PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) hits.push({ file: rel, line: i + 1, what, code: trimmed.slice(0, 100) });
    }
  });
}

if (hits.length === 0) {
  console.log("✅ 时区审计通过：未发现未登记的本地日历字段用法");
  process.exit(0);
}

console.log(`⚠️  发现 ${hits.length} 处未登记的本地日历字段用法（容器是 UTC，业务口径是上海）：`);
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}  ${h.what}  ${h.code}`);
}
console.log("\n处置方式（三选一，不要沉默）：");
console.log("  1. 业务口径 → 改用 @/lib/tz（shStartOfDay / shAddDays / shAddMonthsClamped / shDateString）");
console.log("     或 @/server/finance/facts 的 shMonthStart（月界）");
console.log("  2. 纯展示   → 用 @/lib/utils 的 formatDate / formatDateTime（已固定 Asia/Shanghai）");
console.log("  3. 确实无所谓 → 在 scripts/audit-timezone.mjs 的 ALLOWED 里登记一行并写理由");
process.exit(1);
