#!/usr/bin/env node
/**
 * `/leads` 取数基线（2026-11-23）
 *
 * ## 为什么要有这个脚本
 *
 * 这个页面背了 13 个并行取数（漏斗、渠道下钻、待上门、积压、投放成本、环比、
 * 列显隐、口径设置、闭环……）。持续加功能时，需要一把尺子回答
 * 「现在到底慢不慢」，而不是靠感觉。
 *
 * ## 一条重要教训（写在这里防止以后被误导）
 *
 * **别拿第一次的数字当基线**。我第一版每项只跑一次，第一项显示 45.3ms、
 * 后面全是 1–3ms —— 那 45ms 是首次连接建立 + 查询计划编译，
 * 不是这个查询的真实成本。热身后（跑 3 次取中位）全项都是 1–9ms。
 *
 * ## 用法
 *
 *   node scripts/bench-leads.mjs          # 默认热身 3 次、采样 5 次取中位
 *   node scripts/bench-leads.mjs --runs 9 # 采样更多
 *
 * 阈值只做提示，不作失败退出（性能受机器影响，硬门槛会变成噪声）。
 */
import { PrismaClient } from "@prisma/client";

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const WARMUP = getArg("warmup", 3);
const RUNS = getArg("runs", 5);
const SLOW_MS = getArg("slow", 50);

const prisma = new PrismaClient();
const now = new Date();
const SH = 8 * 3600_000;
const mStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - SH);
const nextM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - SH);
const prevM = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1) - SH);
const month = `${new Date(mStart.getTime() + SH).getUTCFullYear()}-${String(new Date(mStart.getTime() + SH).getUTCMonth() + 1).padStart(2, "0")}`;

const cases = [
  ["listLeads(200 + owner/channel/_count)", () => prisma.lead.findMany({
    orderBy: { updatedAt: "desc" }, take: 200,
    include: { owner: { select: { name: true } }, channel: { select: { id: true, name: true, parentId: true } }, _count: { select: { activities: true } } }
  })],
  ["getLeadFunnel 源查询(本月全量)", () => prisma.lead.findMany({
    where: { createdAt: { gte: mStart, lt: nextM } },
    select: { id: true, stage: true, source: true, ownerId: true, visitOutcome: true, channelId: true, voucherAmount: true, expectedAmount: true, convertedAt: true, createdAt: true, lostReason: true }
  })],
  ["getChannelQualityComparison(2 期聚合)", async () => {
    await prisma.$queryRaw`SELECT "channelId", count(*) FROM "Lead" WHERE "channelId" IS NOT NULL AND "createdAt" >= ${mStart} AND "createdAt" < ${nextM} GROUP BY "channelId"`;
    await prisma.$queryRaw`SELECT "channelId", count(*) FROM "Lead" WHERE "channelId" IS NOT NULL AND "createdAt" >= ${prevM} AND "createdAt" < ${mStart} GROUP BY "channelId"`;
  }],
  ["channelCost 列表 + 环比(2 次)", async () => {
    await prisma.leadChannelCost.findMany({ where: { month } });
    await prisma.leadChannelCost.findMany({ where: { month: { in: [month, "1970-01"] } } });
  }],
  ["getUpcomingVisits", () => prisma.lead.findMany({ where: { stage: "INVITED", visitOutcome: "PENDING", invitedAt: { gte: mStart, lt: nextM } }, take: 500 })],
  ["getStaleConsultedLeads", () => prisma.lead.findMany({ where: { stage: "CONSULTED", convertedIntakeId: null, updatedAt: { lte: mStart } }, take: 50 })],
  ["listLeadChannels + listLawyerOptions", async () => {
    await prisma.leadChannel.findMany({ orderBy: [{ sort: "asc" }] });
    await prisma.user.findMany({ where: { active: true }, select: { id: true, name: true } });
  }],
  ["设置读 2 次(policy/columns)", async () => {
    await prisma.systemSetting.findUnique({ where: { key: "leadFinancePolicy" } });
    await prisma.systemSetting.findUnique({ where: { key: "leads.listColumns" } });
  }],
  ["getLeadToCash(4 次聚合)", async () => {
    await prisma.lead.count({ where: { createdAt: { gte: mStart, lt: nextM } } });
    await prisma.lead.count({ where: { createdAt: { gte: mStart, lt: nextM }, stage: "CONVERTED" } });
    await prisma.billing.aggregate({ where: { signedAt: { gte: mStart, lt: nextM } }, _sum: { contractAmount: true } });
    await prisma.payment.aggregate({ where: { occurredAt: { gte: mStart, lt: nextM } }, _sum: { amount: true } });
  }]
];

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const counts = {
  lead: await prisma.lead.count(),
  billing: await prisma.billing.count(),
  payment: await prisma.payment.count(),
  channelCost: await prisma.leadChannelCost.count()
};
console.log(`  数据量：Lead=${counts.lead} Billing=${counts.billing} Payment=${counts.payment} ChannelCost=${counts.channelCost}`);
console.log(`  参数：热身 ${WARMUP} 次、采样 ${RUNS} 次取中位、慢阈值 ${SLOW_MS}ms\n`);

const results = [];
for (const [name, fn] of cases) {
  for (let i = 0; i < WARMUP; i++) await fn();       // 热身：排除连接与查询计划编译
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  results.push({ name, ms: Math.round(median(times) * 10) / 10 });
}

results.sort((a, b) => b.ms - a.ms);
for (const r of results) {
  const flag = r.ms > SLOW_MS ? "  ⚠️ 超过阈值" : "";
  console.log(`  ${String(r.ms).padStart(7)} ms  ${r.name}${flag}`);
}
const total = Math.round(results.reduce((n, r) => n + r.ms, 0) * 10) / 10;
console.log(`\n  串行合计 ${total} ms；页面是 Promise.all 并行 → 墙钟≈最慢一项（不含渲染）`);
console.log(`  最长一项：${results[0].name} ${results[0].ms} ms`);

await prisma.$disconnect();
