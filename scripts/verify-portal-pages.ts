#!/usr/bin/env node
/**
 * 门户页面运行时校验（2026-11-20，门户 S2）
 *
 * ## 为什么需要它
 *
 * 门户页面（/portal、/portal/cases、/portal/materials）都是「登录后才渲染」的，
 * 用员工会话打不开（员工身份不被门户承认，这是设计如此）。
 * 于是这些页面的真实渲染**没有任何自动化手段覆盖**——只能靠人去点，
 * 而「没人点过」正是历史上 500 错误漏到线上的原因（见 AGENTS §七 金线走查）。
 *
 * ## 它做什么
 *
 *   1. 在库里临时建一个门户账号 + 一条进度摘要分享 + 一条材料分享
 *   2. 用与服务端同一个 `signPortalSession` 签出会话 cookie
 *   3. 逐页 HTTP 请求，断言状态 200、无错误标记、关键文案在、**百分比不在**
 *   4. `finally` 里删掉临时数据（无论断言是否失败）
 *
 * ## 它不做什么
 *
 * · 不校验写操作（分享/撤销已由真库单测覆盖）
 * · 不模拟真实客户浏览器行为（只做服务端渲染回读）
 *
 * 用法：npx tsx scripts/verify-portal-pages.ts
 * 依赖：本地站点在 BASE（默认 http://localhost:3000）可访问
 */

import { PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";

const BASE = process.env.BASE ?? "http://localhost:3000";
const prisma = new PrismaClient();

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✅ ${name} ${detail}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${detail}`);
  }
}

/** 与 src/lib/portal/auth.ts 同算法（脚本不走 bundler，直接复刻 20 行） */
function signSession(uid: string, sv: number, expSeconds: number): string {
  const base = process.env.NEXTAUTH_SECRET;
  if (!base) throw new Error("缺少 NEXTAUTH_SECRET");
  const key = process.env.PORTAL_SESSION_SECRET?.trim()
    ? process.env.PORTAL_SESSION_SECRET.trim()
    : createHmac("sha256", base).update("lawlink.portal.session.v1").digest("hex");
  const body = Buffer.from(JSON.stringify({ uid, sv, exp: expSeconds }), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

async function main() {
  // 先找**有委托方**的案件再反查客户：反过来的顺序会选中一个没有案件的客户
  // （第一版就是 client.findFirst 撞上这种客户，脚本报「名下没有案件」）
  const matter = await prisma.matter.findFirst({
    where: { deletedAt: null, primaryClientId: { not: null } },
    select: { id: true, internalCode: true, title: true, primaryClientId: true }
  });
  if (!matter?.primaryClientId) throw new Error("库里没有带委托方的案件，无法构造门户场景");

  const client = await prisma.client.findUniqueOrThrow({
    where: { id: matter.primaryClientId },
    select: { id: true, name: true }
  });

  const staff = await prisma.user.findFirst({ where: { active: true }, select: { id: true } });
  if (!staff) throw new Error("库里没有员工账号");

  const email = `probe-${Date.now()}@portal-verify.local`;
  const user = await prisma.clientPortalUser.create({
    data: { clientId: client.id, email, name: "验证用客户", passwordHash: "!unusable:probe" }
  });

  // 用 create 而不是 createMany：要拿到**这一条**的 id，
  // 清理时按 id 删。按条件删（clientId + matterId + shareType）会连带删掉
  // 真实存在的同形分享——校验脚本绝不能动真实数据。
  const share = await prisma.portalShare.create({
    data: { clientId: client.id, shareType: "MATTER_SUMMARY", matterId: matter.id, sharedById: staff.id },
    select: { id: true }
  });
  const billingShare = await prisma.portalShare.create({
    data: { clientId: client.id, shareType: "BILLING", matterId: matter.id, sharedById: staff.id },
    select: { id: true }
  });

  try {
    const cookie = signSession(user.id, user.sessionVersion, Math.floor(Date.now() / 1000) + 600);
    console.log(`\n=== 门户页面运行时校验 ===`);
    console.log(`  客户：${client.name} · 案件：${matter.internalCode}\n`);

    const pages: { path: string; mustHave: string[]; mustNotHave?: string[] }[] = [
      { path: "/portal", mustHave: ["案件进度", "我的材料", "账单", "我的提问", "退出"] },
      {
        path: "/portal/cases",
        mustHave: ["案件进度", matter.internalCode, "当前阶段", "主办律师"],
        // 方案 §七 Q1：不提供百分比。若这里出现「%」，说明有人顺手加了进度估算
        mustNotHave: ["进度百分比", "完成度", "%"]
      },
      {
        path: "/portal/bills",
        mustHave: ["账单", "合同金额", "应收", "已收", "待收"],
        // Q2：不显示工时明细；也不该出现内部口径（成本/分成）
        mustNotHave: ["工时明细", "分成", "成本"]
      },
      { path: "/portal/materials", mustHave: ["我的材料"] },
      {
        path: "/portal/requests",
        mustHave: ["我的提问", "提一个新问题", "标题", "提交"]
      }
    ];

    for (const p of pages) {
      const res = await fetch(`${BASE}${p.path}`, {
        headers: { cookie: `lawlink_portal_session=${cookie}` },
        redirect: "manual"
      });
      const html = await res.text();
      // 禁止词检查要排除页面自己的「不含什么」说明段（data-portal-disclaimer）。
      // 否则说明文字里的「工时明细」会把断言弄红，而为了过断言去改文案，
      // 等于让这项检查失去意义。
      //
      // 排除两类「不算渲染内容」的东西：
      //   ① data-portal-disclaimer 段落 —— 页面自己说明「不含什么」
      //   ② <script> 块 —— Next 的 RSC flight 载荷把同一棵树再序列化一遍，
      //      文本会第二次出现。它只是 DOM 的复述，不会独立泄露任何东西；
      //      真实泄露必然同时出现在 DOM 里，排除它不会掩盖问题。
      const body = html
        .replace(/<p[^>]*data-portal-disclaimer[^>]*>[\s\S]*?<\/p>/g, "")
        .replace(/<script[\s\S]*?<\/script>/g, "");
      check(`${p.path} 状态 200`, res.status === 200, `实际 ${res.status}`);
      check(`${p.path} 无错误标记`, !/Application error|Internal Server Error/.test(html));
      for (const kw of p.mustHave) check(`${p.path} 含「${kw}」`, html.includes(kw));
      for (const kw of p.mustNotHave ?? []) {
        const at = body.indexOf(kw);
        // 失败时带上下文：只报「出现了」会让人再猜一遍是哪个组件渲染的
        check(`${p.path} 不含「${kw}」`, at < 0, at >= 0 ? `…${body.slice(Math.max(0, at - 50), at + kw.length + 50)}…` : "");
      }
    }

    // 未登录必须被弹到门户登录页（而非员工登录页）
    const anon = await fetch(`${BASE}/portal/cases`, { redirect: "manual" });
    const loc = anon.headers.get("location") ?? "";
    check("未登录跳门户登录页", anon.status === 307 && loc.includes("/portal/login"), `实际 ${anon.status} ${loc}`);
  } finally {
    await prisma.portalShare.delete({ where: { id: share.id } }).catch(() => {});
    await prisma.portalShare.delete({ where: { id: billingShare.id } }).catch(() => {});
    await prisma.clientPortalUser.delete({ where: { id: user.id } }).catch(() => {});
    console.log(`\n  临时数据已清理（账号 ${email} 与本次分享记录）`);
  }

  console.log(`\n=== 结果：通过 ${pass}，失败 ${fail} ===`);
  if (fail > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("校验脚本异常：", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
