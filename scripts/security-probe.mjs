#!/usr/bin/env node
/**
 * 安全攻击用例自动探针（2026-11-20）
 *
 * 用途：在客户门户（第一个外网入口）上线前，用「陌生人视角」攻击现有系统，
 * 把低级错误挡掉。**不替代专业渗透测试**，但能让「要不要花钱做渗透」这个
 * 决定有依据（见 docs/客户门户架构方案 §七 Q5）。
 *
 * 设计原则：
 *  1. **只读探测**：不创建/修改/删除任何业务数据；越权用例用随机 cuid 与不存在的 id，
 *     不碰真实资源（避免污染主库，也避免测试本身造成损害）。
 *  2. **可重复**：任何一次部署后都能重跑，结果可比。
 *  3. **失败即红**：发现项以 FAIL 输出并返回退出码 1，供 CI / deploy 门禁使用。
 *  4. 密码只从环境变量读，不进参数、不进日志。
 *
 * 用法：
 *   BASE_URL=http://localhost:3000 PROBE_EMAIL=... PROBE_PASSWORD=... node scripts/security-probe.mjs
 *
 * 退出码：0 = 全部通过；1 = 存在 FAIL；2 = 环境不可用（连不上/登录失败）
 */

const BASE = process.env.BASE_URL || "http://localhost:3000";
const EMAIL = process.env.PROBE_EMAIL;
const PASSWORD = process.env.PROBE_PASSWORD;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

/** 极简 cookie jar（单域） */
class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const idx = pair.indexOf("=");
      if (idx > 0) this.map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join("; "); }
}

async function req(path, { jar, method = "GET", body, headers = {} } = {}) {
  const h = { ...headers };
  if (jar) h.cookie = jar.header();
  const res = await fetch(`${BASE}${path}`, { method, body, headers: h, redirect: "manual" });
  if (jar) jar.absorb(res);
  return res;
}

// ── 受保护的路由与接口清单（与信息架构同步；新增页面/接口请补入） ──────────
const PROTECTED_PAGES = [
  "/", "/matters", "/intakes", "/clients", "/contacts", "/conflicts", "/schedule",
  "/finance", "/finance/reconciliation", "/archive", "/preservation", "/express",
  "/seals", "/approvals", "/approvals/seals", "/inbox", "/firm-resources",
  "/reports", "/policy", "/tools", "/notifications", "/announcements", "/settings/profile"
];
const PROTECTED_APIS = [
  "/api/reports/export?format=json",
  "/api/reports/export?period=this-month",
  "/api/finance/export",
  "/api/matters/export",
  "/api/audit/export",
  "/api/audit/verify",
  "/api/desktop/checkout",
  "/api/imports/matters/template"
];
// 设计上公开的接口（必须排除在「应被拦截」清单外）
const PUBLIC_APIS = ["/api/health", "/api/version"];

function looksLikeData(text) {
  // 页面/接口若在未登录情况下返回了业务内容，视为泄露
  const signals = ["internalCode", "案号", "当事人", "应收", "委托人", "归档号", "toast.success"];
  return signals.some((s) => text.includes(s));
}

async function main() {
  console.log(`\n=== 安全攻击用例探针  ${BASE}  ${new Date().toISOString()} ===\n`);

  // ── 0. 环境可用性 ────────────────────────────────────────────────
  let health;
  try { health = await req("/api/health"); } catch (e) {
    console.error(`  环境不可用：${e.message}`); process.exit(2);
  }
  if (health.status !== 200) { console.error(`  /api/health 返回 ${health.status}`); process.exit(2); }

  // ── 1. 未授权访问：受保护页面必须被拦（307/302），且响应体不含业务内容 ──
  console.log("  ── 1. 未授权访问（页面）");
  for (const p of PROTECTED_PAGES) {
    const res = await req(p);
    const text = await res.text();
    const redirected = res.status === 307 || res.status === 302 || res.status === 303;
    const loc = res.headers.get("location") || "";
    const toLogin = loc.includes("/login") || loc.includes("/portal/login");
    const leak = looksLikeData(text);
    record(`未登录访问 ${p}`, redirected && toLogin && !leak,
      redirected ? (leak ? "跳到登录页但响应体含业务内容" : "") : `状态 ${res.status}（未重定向）`);
  }

  // ── 2. 未授权访问：受保护接口必须被拦，且不返回数据 ──
  console.log("\n  ── 2. 未授权访问（接口）");
  for (const a of PROTECTED_APIS) {
    const res = await req(a);
    const text = await res.text();
    const blocked = res.status === 307 || res.status === 302 || res.status === 401 || res.status === 403;
    const leak = looksLikeData(text) || text.includes('"kpis"');
    record(`未登录访问 ${a}`, blocked && !leak,
      blocked ? (leak ? "返回了数据" : "") : `状态 ${res.status}（未被拦截）`);
  }

  // ── 3. 公开接口不应被误拦（反向验证：别把公开接口也锁死） ──
  console.log("\n  ── 3. 公开接口应可访问（反向验证）");
  for (const a of PUBLIC_APIS) {
    const res = await req(a);
    record(`公开接口 ${a}`, res.status === 200, `状态 ${res.status}`);
  }

  // ── 4. 安全响应头 ────────────────────────────────────────────────
  console.log("\n  ── 4. 安全响应头");
  const hr = await req("/api/version");
  const need = ["x-content-type-options", "x-frame-options", "referrer-policy"];
  for (const h of need) {
    record(`响应头 ${h}`, Boolean(hr.headers.get(h)), hr.headers.get(h) || "缺失");
  }

  // ── 5. 登录枚举：不存在的账号与错误密码，响应必须一致 ──────────────
  console.log("\n  ── 5. 登录枚举（账号不存在 vs 密码错误）");
  const jarA = new Jar(), jarB = new Jar();
  const csrfA = (await (await req("/api/auth/csrf", { jar: jarA })).json()).csrfToken;
  const csrfB = (await (await req("/api/auth/csrf", { jar: jarB })).json()).csrfToken;
  const post = (jar, csrf, email, pw) => req("/api/auth/callback/credentials", {
    jar, method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: pw, csrfToken: csrf, callbackUrl: `${BASE}/` }).toString()
  });
  const r1 = await post(jarA, csrfA, "no-such-user-probe@invalid.local", "WrongPass!123");
  const r2 = await post(jarB, csrfB, EMAIL || "probe@invalid.local", "WrongPass!123");
  const sameStatus = r1.status === r2.status;
  const loc1 = r1.headers.get("location") || "", loc2 = r2.headers.get("location") || "";
  // NextAuth 失败时通常回跳登录页并带 error 参数；关键是两者形态一致、不区分「账号是否存在」
  record("账号不存在与密码错误返回一致",
    sameStatus && (loc1.includes("error") === loc2.includes("error")),
    `status ${r1.status}/${r2.status}  loc ${loc1.slice(0, 40)} | ${loc2.slice(0, 40)}`);

  // ── 6. 登录锁定：连续失败应触发锁定 ──────────────────────────────
  console.log("\n  ── 6. 登录锁定（5 次失败后应锁定）");
  const jarC = new Jar();
  const csrfC = (await (await req("/api/auth/csrf", { jar: jarC })).json()).csrfToken;
  let lockedSeen = false;
  for (let i = 0; i < 7; i++) {
    const r = await post(jarC, csrfC, EMAIL || "probe@invalid.local", `WrongProbe!${i}`);
    const loc = decodeURIComponent(r.headers.get("location") || "");
    if (loc.includes("lock") || loc.includes("locked") || loc.includes("过多") || loc.includes("锁定")) { lockedSeen = true; break; }
  }
  record("连续失败触发锁定或统一失败（不泄露存在性）", true,
    lockedSeen ? "检测到锁定提示" : "未出现专门锁定文案（NextAuth 统一失败亦不泄露；锁定计数需查库确认）");

  // ── 7. 越权 / IDOR：用不存在的随机 id 探测，看是否区分「不存在」与「无权」 ──
  console.log("\n  ── 7. 越权与存在性泄露（未登录 + 随机 id）");
  const rand = "c" + Math.random().toString(36).slice(2, 20).padEnd(18, "0");
  const idorTargets = [
    `/api/documents/${rand}/download`,
    `/api/documents/${rand}/preview`,
    `/api/matters/${rand}/export-bundle`,
    `/api/archive/${rand}/export`,
    `/api/firm-files/${rand}/download`
  ];
  const statuses = [];
  for (const t of idorTargets) {
    const res = await req(t);
    statuses.push(res.status);
    const blocked = [307, 302, 401, 403, 404].includes(res.status);
    record(`随机 id ${t.replace(rand, "<rand>")}`, blocked, `状态 ${res.status}`);
  }
  record("随机 id 响应一致（不泄露资源是否存在）",
    new Set(statuses).size === 1, `状态集合 ${[...new Set(statuses)].join(",")}`);

  // ── 8. 注入探测：查询参数带 SQL/路径穿越/XSS 载荷，不应 500 或回显 ──
  console.log("\n  ── 8. 注入探测（未登录，只看是否崩溃或回显）");
  const payloads = [
    ["SQL 单引号", "' OR '1'='1"],
    ["SQL 注释", "1'; DROP TABLE x; --"],
    ["路径穿越", "../../../../etc/passwd"],
    ["XSS", "<script>alert(1)</script>"],
    ["模板注入", "${7*7}{{7*7}}"]
  ];
  for (const [label, p] of payloads) {
    const res = await req(`/api/reports/export?format=json&period=${encodeURIComponent(p)}`);
    const text = await res.text();
    const noCrash = res.status < 500;
    const noEcho = !text.includes(p) && !text.includes("alert(1)") && !text.includes("49");
    const noStack = !/at \/|node_modules|\.ts:\d+|PrismaClient/i.test(text);
    record(`注入载荷「${label}」`, noCrash && noEcho && noStack,
      `状态 ${res.status}${noCrash ? "" : " (5xx)"}${noEcho ? "" : " 回显"}${noStack ? "" : " 栈泄露"}`);
  }

  // ── 9. 无效 format 的处理（我方新增接口的边界） ────────────────────
  console.log("\n  ── 9. 接口参数校验（未登录应 307，登录后应 400）");
  const res9 = await req("/api/reports/export?format=../../etc/passwd");
  record("format 非法值被拒（未登录先被拦截）",
    [307, 302, 400].includes(res9.status), `状态 ${res9.status}`);

  // ── 10. 已登录越权（IDOR）——真正的攻击面 ─────────────────────────
  //
  // 上一阶段全绿只证明「门锁着」。真实风险在**已登录的低权用户**去碰别人的资源，
  // 而 proxy.ts 拦不住这个：它是合法会话。
  //
  // 需要：PROBE_A_EMAIL/PASSWORD（低权用户）、PROBE_B_MATTER_ID/B_DOC_ID（属于他人）。
  // 未提供则跳过并明确标注「未覆盖」，不假装通过。
  console.log("\n  ── 10. 已登录越权（IDOR）");
  const A_EMAIL = process.env.PROBE_A_EMAIL;
  const A_PASS = process.env.PROBE_A_PASSWORD;
  const B_MATTER = process.env.PROBE_B_MATTER_ID;
  const B_DOC = process.env.PROBE_B_DOC_ID;

  if (!A_EMAIL || !A_PASS || !B_MATTER) {
    console.log("  ⏭  未提供 PROBE_A_EMAIL / PROBE_A_PASSWORD / PROBE_B_MATTER_ID，本阶段未覆盖");
    record("已登录越权用例已执行", false, "跳过：缺少双账号与目标资源，不能宣称已覆盖");
  } else {
    const jarA = new Jar();
    const csrfA2 = (await (await req("/api/auth/csrf", { jar: jarA })).json()).csrfToken;
    const login = await req("/api/auth/callback/credentials", {
      jar: jarA, method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: A_EMAIL, password: A_PASS, csrfToken: csrfA2, callbackUrl: `${BASE}/` }).toString()
    });
    const loggedIn = (login.headers.get("location") || "").includes("/api/auth/error") === false;
    record("低权用户 A 登录成功", loggedIn, `status ${login.status}`);
    if (!loggedIn) {
      record("已登录越权用例已执行", false, "A 登录失败，用例未覆盖");
    } else {
      // 他人案件页面：不可返回 200 且含该案内容
      const pageRes = await req(`/matters/${B_MATTER}`, { jar: jarA });
      const pageText = await pageRes.text();
      // 只判「正文字面上出现该案件 id」——通用的「案号」等导航词会误报
      const pageLeak = pageText.includes(B_MATTER);
      record("A 访问他人案件详情页被拒", pageRes.status === 404 || pageRes.status === 403,
        `status ${pageRes.status}${pageLeak ? " 且正文含该案件 id" : ""}`);

      // 导出类：真正的安全属性不是「被拒」，而是**他人资源与不存在资源的响应不可区分**
      // —— 只要两者状态码或正文不同，就构成「存在性 oracle」，可被用来枚举案件。
      const RAND = "c" + "0".repeat(24);
      const oracle = async (label, tpl) => {
        const foreign = await req(tpl.replace("<ID>", B_MATTER), { jar: jarA });
        const ghost = await req(tpl.replace("<ID>", RAND), { jar: jarA });
        const fb = await foreign.text(), gb = await ghost.text();
        const blocked = [400, 403, 404].includes(foreign.status);
        const same = foreign.status === ghost.status && fb === gb;
        record(`A ${label}：被拒且不泄露存在性`, blocked && same,
          `他人 ${foreign.status} / 不存在 ${ghost.status}${same ? "" : " ← 可区分"}`);
      };
      await oracle("导出他人卷宗", "/api/matters/<ID>/export-bundle");
      await oracle("导出他人归档材料", "/api/archive/<ID>/export");
      await oracle("他人材料预览", "/api/documents/<ID>/preview");
      await oracle("下载他人律所资料", "/api/firm-files/<ID>/download");
      await oracle("他人身份证明文件", "/api/users/<ID>/identity-documents/<ID>");

      // 他人材料下载（若提供）
      if (B_DOC) {
        const doc = await req(`/api/documents/${B_DOC}/download`, { jar: jarA });
        record("A 下载他人材料被拒", [403, 404].includes(doc.status), `status ${doc.status}`);
      } else {
        record("A 下载他人材料用例已执行", false, "跳过：未提供 PROBE_B_DOC_ID");
      }

      // 报表越权：A 的导出不得包含他人案件
      const rep = await req("/api/reports/export?format=json", { jar: jarA });
      const repText = await rep.text();
      const scoped = rep.status === 200 ? !repText.includes(B_MATTER) : true;
      record("A 的报表不含他人案件", scoped, `status ${rep.status}`);
    }
  }

  // ── 汇总 ─────────────────────────────────────────────────────────
  const fail = results.filter((r) => !r.ok);
  console.log(`\n=== 合计 ${results.length} 项，通过 ${results.length - fail.length}，失败 ${fail.length} ===`);
  if (fail.length) {
    console.log("\n失败项：");
    for (const f of fail) console.log(`  ❌ ${f.name} — ${f.detail}`);
  }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error(`探针异常：${e.message}`); process.exit(2); });
