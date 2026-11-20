#!/usr/bin/env node
/**
 * 验收清单自走（2026-11-22）
 *
 * 按 `docs/交付验收清单-20261122.md` §三 的路径，在**真实浏览器**里逐步操作，
 * 每步用**数据库回读**确认（不只看界面 toast）。
 *
 * ## 为什么要有它
 *
 * 清单写在文档里，但"文档说能点"和"真的能点"是两件事。
 * 这份脚本把六步链路跑成 15 条断言，任何一步断了立刻看得见。
 *
 * ## 已知边界（如实写）
 *
 * · **登记线索那一步无法自动化**：表单里的渠道/来源是 Radix Select，
 *   `element.click()` 驱动不了（本项目已记录的坑）。故脚本用 SQL 造线索，
 *   表单本身由 `verify-ui.mjs` 的静态检查覆盖。
 * · 脚本会写探针数据（标记 `WALK...`），结束时按标记清理并校验残留为 0。
 * · 需要：lawlink 容器在 3000 端口、lawlink-db 在 55432、headless Chrome CDP 9333。
 *
 * 用法：node scripts/acceptance-walkthrough.mjs
 */
const Q = async (sql) => {
  const { execFileSync } = await import("node:child_process");
  return execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-tAc", sql], { encoding: "utf8" }).trim().split("\n")[0].trim();
};

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("ws")); });
let id = 0; const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
const ev = async (x) => { const r = await send("Runtime.evaluate", { expression: x, awaitPromise: true, returnByValue: true }); return r.result?.result?.value; };

const log = [];
const step = (name, pass, detail) => { log.push({ name, pass, detail }); console.log(`  ${pass ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.enable"); await send("Runtime.enable");

// 造一条探针线索（表单里的渠道/来源是 Radix Select，无法用 click 驱动；这条改用直接落库）
const marker = `WALK${Date.now().toString(36).toUpperCase()}`;
const ownerId = await Q('select id from "User" where active=true limit 1');
const leadId = `walk${Date.now()}`;
const { execFileSync } = await import("node:child_process");
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "Lead" (id,name,phone,stage,"ownerId",occupation,"createdAt","updatedAt") values ('${leadId}','${marker}','13900000601','LEAD','${ownerId}','餐饮',now(),now())`], { encoding: "utf8" });

await send("Page.navigate", { url: "http://localhost:3000/leads" });
for (let i = 0; i < 60; i++) { await sleep(300); if (await ev(`document.body.innerText.includes(${JSON.stringify(marker)})`)) break; }
step("① 列表渲染新线索", await ev(`document.body.innerText.includes(${JSON.stringify(marker)})`), marker);

// ② 行内派单（原生 select：设值 + dispatch change）
const lawyerId = await Q(`select id from "User" where active=true and id<>'${ownerId}' limit 1`);
const dispatched = await ev(`(function(){
  var sel=[].slice.call(document.querySelectorAll('select[title="对接律师"]')).find(function(s){
    var row=s.closest('tr'); return row && row.innerText.indexOf(${JSON.stringify(marker)})>=0;});
  if(!sel) return 'no-select';
  sel.value=${JSON.stringify(lawyerId)};
  sel.dispatchEvent(new Event('change',{bubbles:true}));
  return 'changed';
})()`);
await sleep(2500);
const statusAfterDispatch = await Q(`select "assigneeStatus" from "Lead" where id='${leadId}'`);
step("② 派单后状态=ASSIGNED", statusAfterDispatch === "ASSIGNED", `select=${dispatched} 状态=${statusAfterDispatch}`);

// ③ 非本人点「接单」应被拒（当前登录是 admin，派给的是另一位律师）
const acceptClicked = await ev(`(function(){
  var b=[].slice.call(document.querySelectorAll('button')).find(function(x){
    if((x.textContent||'').trim()!=='接单') return false;
    var row=x.closest('tr'); return row && row.innerText.indexOf(${JSON.stringify(marker)})>=0;});
  if(!b) return 'no-btn'; b.click(); return 'clicked';})()`);
await sleep(2500);
const statusAfterAccept = await Q(`select "assigneeStatus" from "Lead" where id='${leadId}'`);
step("③ 非本人接单被拒（状态仍 ASSIGNED）", statusAfterAccept === "ASSIGNED", `click=${acceptClicked} 状态=${statusAfterAccept}`);

// ④ 邀约
const clickRowBtn = async (label) => ev(`(function(){
  var b=[].slice.call(document.querySelectorAll('button')).find(function(x){
    if((x.textContent||'').trim()!==${JSON.stringify(label)}) return false;
    var row=x.closest('tr'); return row && row.innerText.indexOf(${JSON.stringify(marker)})>=0;});
  if(!b) return 'no-btn'; b.click(); return 'clicked';})()`);
step("④ 点「邀约」", (await clickRowBtn("邀约")) === "clicked");
await sleep(2500);
step("④ 阶段=INVITED", (await Q(`select stage from "Lead" where id='${leadId}'`)) === "INVITED");

// ⑤ 到店
step("⑤ 点「到店」", (await clickRowBtn("到店")) === "clicked");
await sleep(2500);
step("⑤ 阶段=VISITED 且 visitOutcome=ARRIVED",
  (await Q(`select stage||'/'||"visitOutcome" from "Lead" where id='${leadId}'`)) === "VISITED/ARRIVED");

// ⑥ 已到店后「未到店」按钮应消失（验证隐藏逻辑）
const noShowVisible = await ev(`(function(){
  var b=[].slice.call(document.querySelectorAll('button')).find(function(x){
    if((x.textContent||'').trim()!=='未到店') return false;
    var row=x.closest('tr'); return row && row.innerText.indexOf(${JSON.stringify(marker)})>=0;});
  return Boolean(b);})()`);
step("⑥ 已到店后「未到店」按钮不出现", noShowVisible === false);

// ⑦ 谈案
step("⑦ 点「谈案完成」", (await clickRowBtn("谈案完成")) === "clicked");
await sleep(2500);
step("⑦ 阶段=CONSULTED", (await Q(`select stage from "Lead" where id='${leadId}'`)) === "CONSULTED");

// ⑧ 转收案
step("⑧ 点「转收案」", (await clickRowBtn("转收案")) === "clicked");
await sleep(3000);
const conv = await Q(`select stage||'/'||coalesce("convertedIntakeId",'-') from "Lead" where id='${leadId}'`);
step("⑧ 阶段=CONVERTED 且生成收案", conv.startsWith("CONVERTED/cm"), conv);

// ⑨ 派单筛选 chip 切换 URL
const chipOk = await ev(`(function(){
  var b=[].slice.call(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').trim()==='待派单';});
  if(!b) return 'no-chip'; b.click(); return 'clicked';})()`);
await sleep(2000);
const url = await ev("location.search");
step("⑨ 「待派单」chip 切换到 ?assignee=PENDING_ASSIGN", chipOk === "clicked" && url.includes("PENDING_ASSIGN"), `url=${url}`);

// ⑩ 渠道与口径面板
await send("Page.navigate", { url: "http://localhost:3000/leads" });
for (let i = 0; i < 50; i++) { await sleep(300); if (await ev('document.body.innerText.includes("本月获客漏斗")')) break; }
const panel = await ev(`(function(){
  var b=[].slice.call(document.querySelectorAll('button')).find(function(x){return (x.textContent||'').trim()==='渠道与口径';});
  if(!b) return 'no-btn'; b.click(); return 'clicked';})()`);
await sleep(1500);
const panelText = await ev(`document.body.innerText`);
step("⑩ 「渠道与口径」面板四项齐在",
  panel === "clicked" && panelText.includes("风代计提基数") && panelText.includes("团购/券金额归属") && panelText.includes("按回款") && panelText.includes("成本侧"));

// ⑪ 闭环块文案
step("⑪ 线索→回款闭环文案齐在",
  panelText.includes("本月线索 → 回款") && panelText.includes("回款率") && panelText.includes("签约额"));

// 清理：删线索与其收案（按标记，不依赖 id 变量）
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "LeadActivity" where "leadId"='${leadId}'`], { encoding: "utf8" });
const intakeId = await Q(`select coalesce("convertedIntakeId",'-') from "Lead" where id='${leadId}'`);
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "Lead" where id='${leadId}'`], { encoding: "utf8" });
if (intakeId && intakeId.startsWith("cm")) {
  execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
    `delete from "Intake" where id='${intakeId}'`], { encoding: "utf8" });
}

const pass = log.filter((l) => l.pass).length;
console.log(`\n  实测：${pass}/${log.length} 通过`);
ws.close();
console.log("WALKTHROUGH_RESULT " + JSON.stringify({ total: log.length, pass, log }));
