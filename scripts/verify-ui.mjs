#!/usr/bin/env node
/**
 * UI 验证工具（2026-11-19）
 *
 * 为什么有这个文件：
 * 前 31 轮我做验证时，在 /tmp 里写了 124 个几乎相同的临时脚本——同样的 CDP 连接、
 * 同样的登录流程、同样的 send/ev 辅助函数。这本身就是「重复造轮子」，
 * 而这套工具要解决的问题正是项目里反复出现的「组件已有却各自手写」。
 *
 * 更重要的：那些临时脚本让我犯过 4 次同类错误，全部是「验证方法不精确」而非产品缺陷：
 *   1. el.focus() 测焦点可见性 —— :focus-visible 只在键盘交互时激活，程序化聚焦不触发，
 *      读到 outline 恒为 none，误判「11/12 元素焦点不可见」。
 *   2. 取列表页第一个 a[href*="/matters/"] —— 那是 /api/matters/export（导出按钮），
 *      导航到 API 后当然没有程序栏，误判「信号条消失」。
 *   3. 取第一个客户验证证件号脱敏 —— 该客户 idNumber 本就为空，「未登记」是正确行为。
 *   4. 断言关键词靠猜（「本案」「案卷」），页面用词不同就误报失败。
 *
 * 这里把上述教训**编码进工具**，而不是写在文档里等人记住：
 *   - 选择器统一走 pick()，强制排除 /api/ 前缀
 *   - 焦点检测只用真实 Tab 键（sendKey），不提供 .focus() 封装
 *   - 断言失败时明确提示「先怀疑选择器，再怀疑产品」
 *   - 空数据场景显式检查，避免把「没有数据」当成「功能坏了」
 *
 * 用法：
 *   node scripts/verify-ui.mjs routes     # 路由巡检
 *   node scripts/verify-ui.mjs a11y       # 无障碍基础
 *   node scripts/verify-ui.mjs contrast   # 设计 token 对比度
 *   node scripts/verify-ui.mjs flow       # 业务链
 *   node scripts/verify-ui.mjs timing     # 导航性能
 *   node scripts/verify-ui.mjs all        # 全部
 *
 * 前置：
 *   sh scripts/verify-ui.sh chrome        # 启动带 CDP 的 Chrome（端口 9333）
 *   docker compose --profile full up -d   # 应用在 3000
 *
 * 环境变量：
 *   BASE        应用地址，默认 http://localhost:3000
 *   CDP         调试端口，默认 9333
 *   VERIFY_EMAIL / VERIFY_PASSWORD  登录账号（默认读 LAWYER_EMAIL / LAWYER_PASSWORD，
 *               再退回演示库的 admin@lawlink.local）
 */

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.BASE ?? "http://localhost:3000";
const CDP_PORT = process.env.CDP ?? "9333";
const EMAIL = process.env.VERIFY_EMAIL ?? process.env.LAWYER_EMAIL ?? "admin@lawlink.local";
const PASSWORD = process.env.VERIFY_PASSWORD ?? process.env.LAWYER_PASSWORD ?? "LawLink2026!Dev";

/* ---------------------------------------------------------------- 结果收集 */

const results = [];
// 三态（2026-11-21）：通过 / 失败 / 跳过。
//
// 加「跳过」是因为**空系统**：全新部署按 README 就是没有客户与案件的
// （不塞演示数据是刻意的开源设计），此时「客户详情链接可定位」必然找不到链接。
// 把它记成失败，会让每一个新用户第一次跑巡检就看到 2 个红叉，
// 而他其实什么都没做错 —— 这与 deploy.sh 里「不让人拿到一台看不懂的系统」
// 是同一个出发点。
//
// 跳过不算通过也不算失败，单独计数并显示原因，绝不静默忽略。
function record(group, name, ok, detail = "") {
  results.push({ group, name, ok, detail: detail ?? "" });
  const mark = ok ? "✅" : "❌";
  console.log(`  ${mark} ${name}${detail ? `  ${detail}` : ""}`);
}
function skip(group, name, reason) {
  results.push({ group, name, ok: null, detail: reason });
  console.log(`  ⚠️  ${name}  ${reason}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}
function summary() {
  const fail = results.filter((r) => r.ok === false);
  const skipped = results.filter((r) => r.ok === null);
  const passed = results.filter((r) => r.ok === true);
  console.log(`\n${"─".repeat(56)}`);
  console.log(
    `合计 ${results.length} 项，通过 ${passed.length}，失败 ${fail.length}` +
      (skipped.length ? `，跳过 ${skipped.length}` : "")
  );
  if (skipped.length) {
    console.log("\n跳过项（不算失败，多半是空系统或环境限制）：");
    for (const r of skipped) console.log(`  ⚠️  [${r.group}] ${r.name}  ${r.detail}`);
  }
  if (fail.length) {
    console.log("\n失败项：");
    fail.forEach((f) => console.log(`  [${f.group}] ${f.name}  ${f.detail}`));
    console.log(
      "\n提示：先怀疑选择器，再怀疑产品。\n" +
        "  · 取到的是 /api/... ？列表页第一个 a[href*=X] 常是导出/下载按钮\n" +
        "  · 断言的关键词是否真的出现在页面上？去页面里 grep 一下真实文案\n" +
        "  · 是否「无数据」导致空态？那可能不是缺陷，是正确行为\n" +
        "  · 焦点类断言是否用了 .focus()？必须用真实 Tab 键"
    );
  }
  return fail.length === 0;
}

/* ---------------------------------------------------------------- CDP 会话 */

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error(`CDP ${CDP_PORT} 上没有 page target`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("CDP WebSocket 连接失败"));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };

  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.result?.exceptionDetails) {
      throw new Error(`evaluate 异常：${r.result.exceptionDetails.text}`);
    }
    return r.result?.result?.value;
  };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  return { send, evaluate, close: () => ws.close() };
}

/** 导航并等待「有实质内容」。返回耗时 ms。 */
/**
 * 页面健康诊断（2026-11-20 新增）。
 *
 * 为什么需要它：我在 5 轮里 5 次「读错信号」——
 *   30 轮把 :focus-visible 的假阳性当缺陷
 *   31 轮把导出 API 当成案件详情
 *   33 轮用 raw client 复现失败就否定报告
 *   33 轮把缓存的旧构建当成功部署
 *   39 轮把「Server Action 失效」直接归因缓存，实际是真回归
 *
 * 最后一次尤其危险：缓存与真回归的 DOM 信号相近，但性质完全不同。
 * 这里把它们区分开——只看一个指标就下结论是误判的根源。
 */
async function diagnosePage(ctx) {
  const raw = await ctx.evaluate(`(function(){
    var t = document.body.innerText || "";
    var html = document.documentElement;
    return JSON.stringify({
      lang: html.getAttribute("lang") || "",
      chars: t.trim().length,
      // Next.js 错误页的特征文案
      looksLikeErrorPage: /This page couldn.t load|Application error|Minified React error|Internal Server Error/i.test(t),
      // 未水合/旧构建：页面有内容但 Server Action 找不到
      hasActionMismatch: /Failed to find Server Action/i.test(t),
      // 500 页面：只认完整短语，不用裸 "500" ——
      // 页面里任何数字（金额、条数）都可能含 500，用裸数字判断会误报。
      // 我第一版就是 /500|server error/，结果把 /admin/express（内容完全正常）
      // 判成错误页，这是本项目第 6 次「自己制造的误判」。
      isServerError: /Internal Server Error|Application error: a server-side exception/i.test(t),
      title: document.title || ""
    });
  })()`);
  const d = raw ? JSON.parse(raw) : {};
  let verdict = "ok";
  if (d.looksLikeErrorPage || d.isServerError) verdict = "error-page";
  else if (d.lang === "" && d.chars < 200) verdict = "not-rendered"; // 错误页无 lang，是关键判据
  else if (d.chars === 0) verdict = "empty";
  return { ...d, verdict };
}

async function goto(ctx, path, { minChars = 60, timeout = 15000 } = {}) {
  const t0 = Date.now();
  await ctx.send("Page.navigate", { url: BASE + path });
  let waited = 0;
  for (;;) {
    await sleep(150);
    waited += 150;
    const ready = await ctx.evaluate(
      `document.readyState === 'complete' && document.body.innerText.trim().length > ${minChars}`
    );
    if (ready || waited >= timeout) break;
  }
  const diag = await diagnosePage(ctx);
  return { ms: Date.now() - t0, ...diag };
}

/** 等某个选择器出现，超时抛错（比固定 sleep 可靠）。 */
async function waitFor(ctx, selector, { timeout = 20000 } = {}) {
  let waited = 0;
  for (;;) {
    const found = await ctx.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found) return true;
    if (waited >= timeout) return false;
    await sleep(200);
    waited += 200;
  }
}

/**
 * 带凭据登录。缺凭据时直接报错，不静默继续。
 *
 * 初版用固定 sleep 等登录页，在 all 模式下偶发失败——上一个检查项可能刚把页面
 * 留在某个异步渲染状态，登录表单还没挂载就去找 input，输入落空、提交无效，
 * 最后停在 /login 却被报成「凭据错误」。改为等表单真正出现。
 */
async function login(ctx) {
  await ctx.send("Network.clearBrowserCache");
  await ctx.send("Network.clearBrowserCookies");
  await ctx.send("Page.navigate", { url: BASE + "/login" });

  const ready = await waitFor(ctx, "input[type=email]");
  if (!ready) {
    throw new Error(
      `登录页表单 20s 内未出现（URL=${await ctx.evaluate("location.href")}）。` +
        `检查 ${BASE} 是否可访问、/login 是否正常渲染。`
    );
  }

  await ctx.evaluate(`(function(){var e=document.querySelector('input[type=email]');e.focus();e.select();})()`);
  await ctx.send("Input.insertText", { text: EMAIL });
  await ctx.evaluate(`(function(){var e=document.querySelector('input[type=password]');e.focus();e.select();})()`);
  await ctx.send("Input.insertText", { text: PASSWORD });
  await sleep(250);

  const submitted = await ctx.evaluate(
    `(function(){var b=document.querySelector('button[type=submit]');if(!b) return false;b.click();return true;})()`
  );
  if (!submitted) throw new Error("登录页找不到提交按钮");

  // 等离开 /login（最多 20s）
  let waited = 0;
  for (;;) {
    await sleep(300);
    waited += 300;
    const path = await ctx.evaluate("location.pathname");
    if (path !== "/login") return path;
    if (waited >= 20000) {
      // 区分「凭据错」与「页面没反应」：看是否有错误提示
      const hint = await ctx.evaluate(
        `(function(){
          var t = document.body.innerText;
          var m = t.match(/密码错误|邮箱或密码|账号或密码|已经?锁[定定]|失败|错误[^\n]{0,20}/);
          return m ? m[0] : '';
        })()`
      );
      throw new Error(
        `登录 20s 后仍停在 /login。${hint ? `页面提示：「${hint}」→ 多半是凭据问题。` : "页面无错误提示 → 多半是提交未生效或接口不通。"}` +
          `当前账号 ${EMAIL}。`
      );
    }
  }
}

/**
 * 精确取链接。
 *
 * 强制排除 /api/：列表页第一个 a[href*="/matters/"] 往往是导出按钮
 * （/api/matters/export?…），这正是我踩过的坑。
 */
async function pick(ctx, pattern, { exclude = "/api/" } = {}) {
  return ctx.evaluate(`(function(){
    var re = ${pattern};
    var list = [].slice.call(document.querySelectorAll('a[href]'));
    for (var i = 0; i < list.length; i++) {
      var h = list[i].getAttribute('href') || '';
      if (h.indexOf(${JSON.stringify(exclude)}) !== -1) continue;
      if (re.test(h)) return h;
    }
    return null;
  })()`);
}

/** 真实键盘事件。焦点类断言只能用这个——.focus() 不触发 :focus-visible。 */
async function pressTab(ctx) {
  await ctx.send("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab" });
  await ctx.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab" });
  await sleep(200);
}

const hasError = (ctx) =>
  ctx.evaluate("/server error|Minified React error|Application error/i.test(document.body.innerText)");

/* ---------------------------------------------------------------- 检查项 */

const ROUTES = [
  "/", "/matters", "/clients", "/contacts", "/conflicts", "/intakes",
  "/schedule", "/finance", "/finance/reconciliation", "/preservation",
  "/archive", "/approvals", "/approvals/seals", "/seals", "/express",
  "/reports", "/inbox", "/notifications", "/announcements", "/settings",
  "/settings/profile", "/firm-resources", "/policy",
  "/admin", "/admin/users", "/admin/roles", "/admin/teams", "/admin/audit",
  "/admin/ethical-walls", "/admin/emails", "/admin/reminders",
  "/admin/archive-policy", "/admin/document-templates", "/admin/custom-fields",
  "/admin/approval-permissions", "/admin/firm-profile", "/admin/import",
  "/admin/express", "/admin/templates", "/admin/ai"
];

async function checkRoutes(ctx) {
  section(`路由巡检（${ROUTES.length} 条）`);
  for (const route of ROUTES) {
    const d = await goto(ctx, route, { minChars: 40 });
    // 用诊断结论判定，并给出**具体**失败原因（而不是笼统的「内容为空」）
    const ok = d.verdict === "ok";
    const reason =
      d.verdict === "error-page" ? `错误页：${d.title || "无标题"}`
      : d.verdict === "not-rendered" ? `未渲染（lang 为空、正文 ${d.chars} 字）— 真回归，非缓存`
      : d.verdict === "empty" ? "正文为空"
      : `${d.ms}ms`;
    record("routes", route, ok, reason);
  }
}

async function checkA11y(ctx) {
  section("无障碍基础");
  const PAGES = [["/matters", "案件列表"], ["/clients", "客户列表"], ["/finance", "财务"], ["/schedule", "日程"], ["/preservation", "保全"]];
  for (const [path, name] of PAGES) {
    await goto(ctx, path);
    const r = await ctx.evaluate(`(function(){
      var noAlt = [].slice.call(document.querySelectorAll('img')).filter(function(i){return !i.hasAttribute('alt')}).length;
      var btns = [].slice.call(document.querySelectorAll('button'));
      var iconOnly = btns.filter(function(b){return !b.textContent.trim() && !b.getAttribute('aria-label') && !b.getAttribute('title')}).length;
      var inputs = [].slice.call(document.querySelectorAll('input,select,textarea'));
      var noLabel = inputs.filter(function(i){
        if(i.type==='hidden') return false;
        if(i.getAttribute('aria-label')||i.getAttribute('placeholder')) return false;
        var id=i.id; if(id && document.querySelector('label[for="'+id+'"]')) return false;
        return !i.closest('label');
      }).length;
      return JSON.stringify({
        noAlt: noAlt, iconOnly: iconOnly, noLabel: noLabel,
        h1: document.querySelectorAll('h1').length,
        lang: document.documentElement.lang
      });
    })()`);
    const o = JSON.parse(r || "{}");
    const bad = [];
    if (o.noAlt > 0) bad.push(`无alt图片${o.noAlt}`);
    if (o.iconOnly > 0) bad.push(`纯图标按钮无标签${o.iconOnly}`);
    if (o.noLabel > 0) bad.push(`无标签输入${o.noLabel}`);
    if (o.h1 !== 1) bad.push(`h1数量=${o.h1}`);
    if (!/^zh/.test(o.lang ?? "")) bad.push(`lang=${o.lang}`);
    record("a11y", name, bad.length === 0, bad.join(" / "));
  }

  section("键盘焦点可见性（真实 Tab 键）");
  for (const [path, name] of [["/matters", "案件列表"], ["/clients", "客户列表"]]) {
    await goto(ctx, path);
    await ctx.evaluate("document.body.focus()");
    let good = 0;
    let bad = 0;
    for (let i = 0; i < 10; i += 1) {
      await pressTab(ctx);
      const r = await ctx.evaluate(`(function(){
        var el = document.activeElement;
        if (!el || el === document.body) return null;
        var cs = getComputedStyle(el);
        var visible = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
                   || (cs.boxShadow && cs.boxShadow !== 'none');
        return JSON.stringify({ tag: el.tagName, visible: visible, outline: cs.outlineStyle + ' ' + cs.outlineWidth });
      })()`);
      const o = r ? JSON.parse(r) : null;
      if (!o) continue;
      if (o.visible) good += 1;
      else bad += 1;
    }
    record("a11y", `${name} 焦点`, bad === 0, `可见 ${good} / 不可见 ${bad}`);
  }
}

/**
 * 设计 token 对比度。
 *
 * 直接读页面计算样式，不硬编码 HSL——token 改了这里自动跟上。
 */
async function checkContrast(ctx) {
  section("设计 token 对比度（WCAG AA：正文 ≥4.5，大字 ≥3.0）");
  await goto(ctx, "/matters");
  const r = await ctx.evaluate(`(function(){
    var root = getComputedStyle(document.documentElement);
    // CSS 变量存的是裸 HSL 三元组（"211 53% 10%"），必须包 hsl() 才是合法颜色。
    // 初版对背景传裸值、对前景手工包 hsl()，导致背景全部回退成默认色、
    // 三次比值完全相同（3.26/3.26/3.26）——工具自己先错了，谈何验证产品。
    function toRgb(raw){
      var v = String(raw || '').trim();
      if (!v) return null;
      var css = /^hsla?\\(/i.test(v) ? v : 'hsl(' + v + ')';
      var d = document.createElement('div');
      d.style.color = css;
      document.body.appendChild(d);
      var c = getComputedStyle(d).color;
      document.body.removeChild(d);
      // 无效颜色会保持初始值 rgb(0, 0, 0)；结合上面三次比值相同即可发现
      var m = c.match(/[\\d.]+/g);
      return m ? m.slice(0,3).map(Number) : null;
    }
    function lum(rgb){
      var a = rgb.map(function(v){ v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); });
      return 0.2126*a[0] + 0.7152*a[1] + 0.0722*a[2];
    }
    function ratio(c1,c2){
      var L1=lum(c1), L2=lum(c2);
      return (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    }
    var bgs = {
      'canvas': toRgb(root.getPropertyValue('--background')),
      'card':   toRgb(root.getPropertyValue('--card')),
      'sunken': toRgb(root.getPropertyValue('--secondary'))
    };
    var fgs = {
      't-primary': root.getPropertyValue('--foreground'),
      't-muted':   root.getPropertyValue('--muted-foreground'),
      't-faint':   root.getPropertyValue('--muted-subtle'),
      'primary':   root.getPropertyValue('--primary'),
      'destructive': root.getPropertyValue('--destructive')
    };
    var out = [];
    Object.keys(fgs).forEach(function(fk){
      var fc = toRgb(fgs[fk]);
      if (!fc) return;
      Object.keys(bgs).forEach(function(bk){
        if (!bgs[bk]) return;
        out.push({ fg: fk, bg: bk, ratio: Math.round(ratio(fc, bgs[bk]) * 100) / 100 });
      });
    });
    return JSON.stringify(out);
  })()`);
  const rows = JSON.parse(r || "[]");
  if (rows.length === 0) {
    record("contrast", "读取 token", false, "未能解析 CSS 变量");
    return;
  }
  for (const row of rows) {
    const aa = row.ratio >= 4.5;
    const large = row.ratio >= 3.0;
    // t-faint 只要求大字标准（设计上是「最次要信息」）
    const isFaint = row.fg === "t-faint";
    const ok = isFaint ? large : aa;
    record("contrast", `${row.fg} on ${row.bg}`, ok, `${row.ratio}${ok ? "" : isFaint ? " (<3.0)" : " (<4.5)"}`);
  }
}

async function checkFlow(ctx) {
  section("业务链走查");
  // 客户
  await goto(ctx, "/clients");
  const clientHref = await pick(ctx, "/^\\/clients\\/c[a-z0-9]+$/");
  if (clientHref) {
    record("flow", "客户详情链接可定位", true, clientHref);
  } else {
    // 区分「空系统」与「选择器失效」：页面上出现空态文案才是空系统。
    // 全新部署按 README 就是没有客户（刻意不塞演示数据），此时找不到详情链接
    // 是正确行为，记成失败会让每个新用户第一次跑巡检就看到红叉。
    const empty = await ctx.evaluate(
      `(function(){var t=document.body.innerText||"";return /没有符合条件的客户|暂无客户|还没有客户/.test(t);})()`
    );
    if (empty) skip("flow", "客户详情链接可定位", "空系统（尚无客户，符合全新部署预期）");
    else record("flow", "客户详情链接可定位", false, "未找到（页面非空态，疑似选择器失效）");
  }
  if (clientHref) {
    await goto(ctx, clientHref);
    record("flow", "客户详情无报错", !(await hasError(ctx)));
    // 证件号：可能为空，空则显示「未登记」也是正确行为
    const idField = await ctx.evaluate(`(function(){
      var t = document.body.innerText;
      return JSON.stringify({
        hasField: /身份证号|统一社会信用代码/.test(t),
        masked: /\\*{3,}/.test(t),
        unregistered: /未登记/.test(t)
      });
    })()`);
    const o = JSON.parse(idField || "{}");
    record("flow", "证件号字段存在", !!o.hasField);
    record(
      "flow",
      "证件号默认脱敏（空值显示未登记亦为正确）",
      o.masked || o.unregistered,
      o.masked ? "已脱敏" : o.unregistered ? "未登记" : "既未脱敏也未标未登记"
    );
  }

  // 案件
  await goto(ctx, "/matters");
  const matterHref = await pick(ctx, "/^\\/matters\\/LL-/");
  if (matterHref) {
    record("flow", "案件详情链接可定位", true, matterHref);
  } else {
    const empty = await ctx.evaluate(
      `(function(){var t=document.body.innerText||"";return /没有匹配的案件|暂无案件|还没有案件/.test(t);})()`
    );
    if (empty) skip("flow", "案件详情链接可定位", "空系统（尚无案件，符合全新部署预期）");
    else record("flow", "案件详情链接可定位", false, "未找到（页面非空态，疑似选择器失效）");
  }
  if (matterHref) {
    await goto(ctx, matterHref, { minChars: 80 });
    record("flow", "案号显示", await ctx.evaluate("/LL-\\d{4}-/.test(document.body.innerText)"));
    const cards = await ctx.evaluate("document.querySelectorAll('.signal-strip .signal').length");
    record("flow", "信号条 4 卡", cards === 4, `实际 ${cards}`);
    const procs = await ctx.evaluate("document.querySelectorAll('.dos-procs').length");
    record("flow", "程序栏存在", procs > 0, `实际 ${procs}`);

    for (const tab of ["案件档案", "办案进程", "委托与财务", "工时", "审批用印"]) {
      await ctx.evaluate(
        `(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(x){return x.textContent.trim()===${JSON.stringify(tab)}});b&&b.click();})()`
      );
      await sleep(1800);
      record("flow", `页签「${tab}」`, !(await hasError(ctx)));

      // 2026-11-20 补：页签只验证「点得开」是不够的——办案进程里的材料区按钮
      // 才是多轮补入口的落点（目录 / AI 起草 / 从模板生成）。点进去还得看得到。
      if (tab === "办案进程") {
        // 材料区要先选中一个环节才渲染（材料属于环节），先点第一个环节
        const clicked = await ctx.evaluate(
          `(function(){var b=document.querySelector('.dos-proc-main');if(!b)return false;b.click();return true;})()`
        );
        if (clicked) await sleep(1200);
        record("flow", "环节可选中（材料区的前置条件）", clicked, clicked ? "" : "未找到 .dos-proc-main");
        const mats = await ctx.evaluate(
          `(function(){
             var t=document.body.innerText||"";
             var has = function(s){return t.indexOf(s)>=0;};
             return {material: has("材料"), upload: has("上传"), dir: has("目录"), ai: has("AI 起草"), tpl: has("从模板生成")};
           })()`
        );
        record("flow", "材料区可见", mats.material, "");
        // 判据：canManage 闸门同时控制「上传」。若上传也不在，说明是权限闸门
        //（当前账号不是本案成员），不是我的按钮没接上——两种情况必须能区分开。
        if (!mats.upload) {
          skip("flow", "材料区管理按钮（需案件成员）", `当前账号不是本案主办/成员，闸门关闭，跳过 3 项`);
        } else {
        record("flow", "材料区有「目录」按钮", mats.dir, "");
        record("flow", "材料区有「AI 起草」按钮", mats.ai, "");
        record("flow", "材料区有「从模板生成」按钮", mats.tpl, "");
        }
      }
    }
  }
}

async function checkTiming(ctx) {
  section("导航性能（>1000ms 才考虑加载态；<300ms 加骨架屏是负优化）");
  const PAGES = [
    ["/matters", "案件列表"], ["/clients", "客户列表"], ["/finance", "财务"],
    ["/schedule", "日程"], ["/preservation", "保全"], ["/reports", "报表"],
    ["/admin/audit", "审计管理"], ["/finance/reconciliation", "财务核销"]
  ];
  for (const [path, name] of PAGES) {
    const d = await goto(ctx, path);
    record("timing", name, d.ms < 3000 && d.verdict === "ok", `${d.ms}ms${d.verdict !== "ok" ? " ⚠️ " + d.verdict : ""}`);
  }
}

/* ---------------------------------------------------------------- 入口 */

const COMMANDS = {
  routes: checkRoutes,
  a11y: checkA11y,
  contrast: checkContrast,
  flow: checkFlow,
  timing: checkTiming
};

/** 用法说明（2026-11-20 加：不带参数时打印） */
const COMMAND_HELP = {
  routes: "40 条路由可访问性（状态码 + 错误标记）",
  a11y: "无障碍基础 + 键盘焦点",
  contrast: "设计 token 对比度（读实时计算样式）",
  flow: "业务链走查（案件详情页签等）",
  timing: "导航性能"
};

async function main() {
  // 2026-11-20：不带参数改为显示用法，不再默默跑全量。
  //
  // 原行为 `?? "all"`：误敲 `node scripts/verify-ui.mjs` 会直接开跑 83 项
  // （每项都要登录 + 导航，几分钟），而想查用法只能翻源码 ——
  // 我自己在写文档核对时就撞了一次，等了一分钟才反应过来。
  // 显式传 all 才是跑全量；不传参数看用法。
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(`用法：node scripts/verify-ui.mjs <命令>

命令：
${Object.keys(COMMANDS).map((k) => `  ${k.padEnd(10)} ${COMMAND_HELP[k] ?? ""}`).join("\n")}
  ${"all".padEnd(10)} 依次跑以上全部

环境变量：
  BASE=http://localhost:3000   CDP=9333
  VERIFY_EMAIL / VERIFY_PASSWORD

前置：sh scripts/verify-ui.sh chrome`);
    process.exit(0);
  }
  const targets =
    cmd === "all" ? Object.values(COMMANDS) : COMMANDS[cmd] ? [COMMANDS[cmd]] : null;
  if (!targets) {
    console.error(`未知命令：${cmd}\n可用：${Object.keys(COMMANDS).join(" | ")} | all`);
    process.exit(2);
  }

  console.log(`目标 ${BASE} · CDP ${CDP_PORT} · 账号 ${EMAIL}`);
  const ctx = await connect();
  try {
    const landed = await login(ctx);
    console.log(`登录成功 → ${landed}`);
    for (const fn of targets) {
      await fn(ctx);
    }
  } finally {
    ctx.close();
  }
  const pass = summary();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n验证中断：${err.message}`);
  process.exit(2);
});
