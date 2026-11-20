#!/usr/bin/env node
/**
 * 金线：**写操作**最小闭环（2026-11-21）
 *
 * ## 为什么需要它
 *
 * AGENTS §七 要求「通过构建/测试不等于能用」。第八轮审计 §四点名：
 *   > 金线走查……**仍未做**写操作闭环。
 * 已有的自动化都是**读**（HTTP 断言页面 200 / 关键文案在）。读通不代表写通——
 * 第 39 轮就出现过「Server Action 失效」而页面完全正常的情况。
 *
 * 全链 A→M（收案→冲突→转案→程序→期限→工时→实收→确认→核销→归档→审批）
 * 的**逻辑层**已有真库覆盖（business-chain-e2e.test.ts），本脚本补的是**界面提交**这一层：
 * 浏览器里的表单 → React 校验 → server action → 落库。
 *
 * 选「门户提问」作为写操作样本，因为它只有普通 input/textarea（不含 Radix Select，
 * 后者对合成点击不可靠），能把「写链路是否通」这件事单独隔离出来验证。
 *
 * ## 安全性
 * · 只建一条可精确定位的探针工单（标题含随机标记），结束时按**标记**删除并复验为 0；
 * · 结束前删除临时门户账号与分享；`finally` 保证即使断言失败也清理；
 * · 不触碰任何真实业务数据。
 *
 * 用法：
 *   CDP=9333 node scripts/golden-thread-write.mjs
 * 退出码：0 全通过 / 1 有失败
 */
import { createHmac } from "node:crypto";

const CDP_PORT = process.env.CDP ?? "9333";
const BASE = process.env.BASE ?? "http://localhost:3000";
const MARK = `探针写链-${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name} ${detail}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- CDP */
async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`CDP ${CDP_PORT} 上没有 page target`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP 连接失败")); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  return { send, evaluate, close: () => ws.close() };
}

async function goto(ctx, path, { timeout = 20000 } = {}) {
  await ctx.send("Page.navigate", { url: BASE + path });
  let waited = 0;
  for (;;) {
    await sleep(150);
    waited += 150;
    const ready = await ctx.evaluate(`document.readyState === 'complete' && document.body.innerText.trim().length > 60`);
    if (ready || waited >= timeout) break;
  }
  const diag = await ctx.evaluate(`(function(){
    var t=document.body.innerText||"";
    return JSON.stringify({
      err: /Application error|Internal Server Error|Failed to find Server Action/i.test(t),
      chars: t.trim().length
    });
  })()`);
  return JSON.parse(diag || "{}");
}

/** 聚焦元素并用真实输入事件打字（React 的 onChange 只认真实输入，直接赋 value 不触发） */
async function typeInto(ctx, selector, text) {
  const ok = await ctx.evaluate(`(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  })()`);
  if (!ok) return false;
  await ctx.send("Input.insertText", { text });
  return true;
}

async function clickButtonByText(ctx, text) {
  return ctx.evaluate(`(function(){
    var b = [].slice.call(document.querySelectorAll('button')).find(function(x){
      return x.textContent.trim() === ${JSON.stringify(text)} && !x.disabled;
    });
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

/* ---------------------------------------------------------------- 主流程 */
async function main() {
  // 脚本不走 bundler，直接用 @prisma/client（不要 import 项目里的 .ts）
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();

  const signSession = (uid, sv, expSeconds) => {
    const base = process.env.NEXTAUTH_SECRET;
    if (!base) throw new Error("缺少 NEXTAUTH_SECRET");
    const key = process.env.PORTAL_SESSION_SECRET?.trim()
      ? process.env.PORTAL_SESSION_SECRET.trim()
      : createHmac("sha256", base).update("lawlink.portal.session.v1").digest("hex");
    const body = Buffer.from(JSON.stringify({ uid, sv, exp: expSeconds }), "utf8").toString("base64url");
    const mac = createHmac("sha256", key).update(body).digest("base64url");
    return `${body}.${mac}`;
  };

  let ctx;
  let portalUserId = null;
  let shareId = null;
  try {
    const matter = await db.matter.findFirst({
      where: { deletedAt: null, primaryClientId: { not: null } },
      select: { id: true, primaryClientId: true }
    });
    if (!matter?.primaryClientId) throw new Error("库里没有带委托方的案件，无法构造门户场景");
    const staff = await db.user.findFirstOrThrow({ select: { id: true } });

    const user = await db.clientPortalUser.create({
      data: {
        clientId: matter.primaryClientId,
        email: `golden-write-${Date.now()}@portal-probe.local`,
        name: "写链探针",
        passwordHash: "!x",
        isPrimary: true
      },
      select: { id: true, sessionVersion: true }
    });
    portalUserId = user.id;
    const share = await db.portalShare.create({
      data: { clientId: matter.primaryClientId, shareType: "MATTER_SUMMARY", matterId: matter.id, sharedById: staff.id },
      select: { id: true }
    });
    shareId = share.id;

    ctx = await connect();
    const cookie = signSession(user.id, user.sessionVersion, Math.floor(Date.now() / 1000) + 600);
    await ctx.send("Network.setCookie", {
      name: "lawlink_portal_session", value: cookie, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax"
    });

    console.log(`\n=== 金线写操作：门户提问（标记 ${MARK}） ===`);
    const diag = await goto(ctx, "/portal/requests");
    // 不用「字符数 > N」这种随意阈值（第一版写 100，实际页面 68 字符就完整渲染了）。
    // 断言关键文案在、且无错误标记，才是有意义的判据。
    const pageOk = await ctx.evaluate(`(function(){
      var t = document.body.innerText || "";
      return t.includes("我的提问") && t.includes("提一个新问题");
    })()`);
    check("/portal/requests 可渲染且无错误页（含关键文案）", !diag.err && pageOk === true, JSON.stringify(diag));

    const typedSubject = await typeInto(ctx, "#pr-subject", MARK);
    const typedBody = await typeInto(ctx, "#pr-body", "这是金线写操作探针提交的内容");
    check("标题输入框可聚焦并输入", typedSubject);
    check("内容输入框可聚焦并输入", typedBody);

    const clicked = await clickButtonByText(ctx, "提交");
    check("提交按钮可点击", clicked);

    // 等落库：轮询数据库（比固定 sleep 可靠）
    let row = null;
    for (let i = 0; i < 40; i += 1) {
      row = await db.portalRequest.findFirst({ where: { subject: MARK }, select: { id: true, status: true } });
      if (row) break;
      await sleep(250);
    }
    check("界面提交后**真实落库**（浏览器 → React → server action → DB）", Boolean(row), row ? "" : "10s 内未落库");

    // 界面回读：刷新后应能看到自己刚提的工单（读回写的结果）
    if (row) {
      const after = await goto(ctx, "/portal/requests");
      const visible = await ctx.evaluate(`document.body.innerText.includes(${JSON.stringify(MARK)})`);
      check("刷新后界面可见刚提交的工单", !after.err && visible === true);
    }
  } finally {
    try {
      // 按**内容标记**删除，不依赖 id 变量（历史上变量污染导致残留）
      const del = await db.portalRequest.deleteMany({ where: { subject: MARK } });
      if (del.count) console.log(`  · 已删除探针工单 ${del.count} 条`);
      const left = await db.portalRequest.count({ where: { subject: MARK } });
      if (left !== 0) console.log(`  ❌ 探针工单残留 ${left} 条`);
      if (shareId) await db.portalShare.deleteMany({ where: { id: shareId } });
      if (portalUserId) await db.clientPortalUser.deleteMany({ where: { id: portalUserId } });
    } catch (err) {
      console.log(`  ❌ 清理失败：${err instanceof Error ? err.message : String(err)}`);
    }
    ctx?.close();
    if (typeof db.$disconnect === "function") await db.$disconnect();
  }

  console.log(`\n=== 结果：通过 ${pass}，失败 ${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("脚本异常：", err);
  process.exit(1);
});
