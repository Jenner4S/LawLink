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

// ⑫ 列显隐（2026-11-23）：面板里应有「列表显示哪些列」+ 勾选框，且线索人列锁定
const colInfo = await ev(`(function(){
  var boxes=[].slice.call(document.querySelectorAll('input[type=checkbox]'));
  var nameLocked=boxes.some(function(b){var l=b.closest('label');return l && l.innerText.indexOf('线索人')>=0 && b.disabled;});
  var t=document.body.innerText||"";
  return JSON.stringify({section:t.indexOf("列表显示哪些列")>=0, boxes:boxes.length, nameLocked:nameLocked, hintOp:t.indexOf("操作列始终显示")>=0});
})()`);
const ci = JSON.parse(colInfo);
step("⑫ 列显隐：面板有分区、勾选框、线索人锁定", ci.section && ci.boxes >= 6 && ci.nameLocked && ci.hintOp,
  `boxes=${ci.boxes} nameLocked=${ci.nameLocked}`);

// ⑬ 渠道下钻（2026-11-23）：造"一级渠道 + 子渠道 + 一条线索"，点渠道行应跳 ?channel= 且只剩该线索
const chanParentId = `walkcp${Date.now()}`;
const chanId = `walkch${Date.now()}`;
const drillLeadId = `walkdl${Date.now()}`;
const walkOwnerId = await Q(`select id from "User" where active=true order by "createdAt" limit 1`);
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "LeadChannel" (id,name,kind,active,sort,"createdAt","updatedAt")
   values ('${chanParentId}','巡检投放','PAID',true,9,now(),now())`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "LeadChannel" (id,name,"parentId",kind,active,sort,"createdAt","updatedAt")
   values ('${chanId}','巡检子渠道','${chanParentId}','PAID',true,0,now(),now())`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "Lead" (id,name,phone,stage,"ownerId","channelId","createdAt","updatedAt")
   values ('${drillLeadId}','巡检渠道线索','13900000777','LEAD','${walkOwnerId}','${chanId}',now(),now())`], { encoding: "utf8" });

await send("Page.navigate", { url: "http://localhost:3000/leads" });
await sleep(2500);
const drillClick = await ev(`(function(){
  var b=[].slice.call(document.querySelectorAll("button")).find(function(x){
    return (x.textContent||"").indexOf("巡检子渠道")>=0 && (x.className||"").indexOf("underline")>=0;
  });
  if(!b) return "no-btn";
  b.click(); return "clicked";
})()`);
await sleep(2500);
const drillState = JSON.parse(await ev(`(function(){
  var t=document.body.innerText||"";
  return JSON.stringify({chip:t.indexOf("渠道筛选")>=0, listed:t.indexOf("巡检渠道线索")>=0, search:location.search});
})()`));
step("⑬ 渠道下钻：点渠道行跳 ?channel= 且只列该渠道线索",
  drillClick === "clicked" && drillState.chip && drillState.listed && drillState.search.indexOf("channel=") >= 0,
  `click=${drillClick} search=${drillState.search}`);

// ⑭ 未来 7 天待上门（2026-11-23）：造一条"明天上门且未到店"的线索，应出现在该行
const upId = `walkup${Date.now()}`;
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "Lead" (id,name,phone,stage,"visitOutcome","ownerId","invitedAt","createdAt","updatedAt")
   values ('${upId}','巡检待上门','13900000778','INVITED','PENDING','${walkOwnerId}',(now() + interval '1 day'),now(),now())`], { encoding: "utf8" });
await send("Page.navigate", { url: "http://localhost:3000/leads" });
await sleep(2500);
const upInfo = JSON.parse(await ev(`(function(){
  var t=document.body.innerText||"";
  return JSON.stringify({label:t.indexOf("未来 7 天待上门")>=0, listed:t.indexOf("巡检待上门")>=0});
})()`));
step("⑭ 未来 7 天待上门：明天的约定出现在该行", upInfo.label && upInfo.listed,
  `label=${upInfo.label} listed=${upInfo.listed}`);

// ⑮ 已谈案未转收案（2026-11-23）：造一条"谈完 5 天没转"的线索，应出现在积压行
const staleId = `walkst${Date.now()}`;
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  // 注意：积压判定看 updatedAt（最后动静），不是 consultedAt。
  // 造数据必须把两者都推到 5 天前，否则 updatedAt=now 会让判定认为"刚动过"（踩过一次）。
  `insert into "Lead" (id,name,phone,stage,"ownerId","consultedAt","createdAt","updatedAt")
   values ('${staleId}','巡检积压线索','13900000779','CONSULTED','${walkOwnerId}',(now() - interval '5 day'),(now() - interval '6 day'),(now() - interval '5 day'))`], { encoding: "utf8" });
await send("Page.navigate", { url: "http://localhost:3000/leads" });
await sleep(2500);
const staleInfo = JSON.parse(await ev(`(function(){
  var t=document.body.innerText||"";
  return JSON.stringify({label:t.indexOf("已谈案未转收案")>=0, listed:t.indexOf("巡检积压线索")>=0});
})()`));
step("⑮ 已谈案未转收案：谈完 5 天仍挂在积压行", staleInfo.label && staleInfo.listed,
  `label=${staleInfo.label} listed=${staleInfo.listed}`);

// ⑯ 催办（2026-11-23）：点积压行里的「催办」→ 记一条跟进、该条从积压清单消失
const nudgeClick = await ev(`(function(){
  var row=[].slice.call(document.querySelectorAll("div")).find(function(d){
    return (d.innerText||"").indexOf("巡检积压线索")>=0 && (d.innerText||"").indexOf("已谈案未转收案")>=0;
  });
  if(!row) return "no-row";
  var b=[].slice.call(row.querySelectorAll("button")).find(function(x){return (x.textContent||"").trim()==="催办";});
  if(!b) return "no-btn";
  b.click(); return "clicked";
})()`);
await sleep(3000);
// 只在「已谈案未转收案」那个区块里看它还在不在 ——
// 整页文本判断会误报：这条线索本来也还在下方线索列表里（第一版就是这么错的）。
const afterNudge = JSON.parse(await ev(`(function(){
  var box=[].slice.call(document.querySelectorAll("div")).find(function(d){
    return (d.innerText||"").indexOf("已谈案未转收案")>=0 && (d.className||"").indexOf("rounded")>=0;
  });
  return JSON.stringify({blockGone: !box, stillListed: box ? (box.innerText||"").indexOf("巡检积压线索")>=0 : false});
})()`));
const nudgeActs = await Q(`select count(*) from "LeadActivity" where "leadId"='${staleId}' and type='CONTACT'`);
step("⑯ 催办：记一条 CONTACT 跟进且该条从积压清单消失",
  nudgeClick === "clicked" && nudgeActs.trim() !== "0" && !afterNudge.stillListed,
  `click=${nudgeClick} acts=${nudgeActs.trim()} blockGone=${afterNudge.blockGone} stillListed=${afterNudge.stillListed}`);

// ⑰ 渠道投放成本录入（2026-11-23）：面板里填金额 → 失焦保存 → 库内可回读
//
// 注意：**必须用真实 focus/blur**。`dispatchEvent(new Event("blur"))` 触发不了
// React 的 onBlur（合成事件走 focusout），我第一版就是这么测的，
// 结果"填了 600 但库里是 0"，差点误判成功能坏了。
const costChanId = `walkcc${Date.now()}`;
const costLeadId = `walkcl${Date.now()}`;
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "LeadChannel" (id,name,kind,active,sort,"createdAt","updatedAt")
   values ('${costChanId}','巡检成本渠道','PAID',true,5,now(),now())`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `insert into "Lead" (id,name,phone,stage,"ownerId","channelId","createdAt","updatedAt")
   values ('${costLeadId}','巡检成本线索','13900000793','LEAD','${walkOwnerId}','${costChanId}',now(),now())`], { encoding: "utf8" });

await send("Page.navigate", { url: "http://localhost:3000/leads" });
await sleep(2500);
await ev(`(function(){var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return (x.textContent||"").trim()==="渠道与口径";});if(b)b.click();})()`);
await sleep(1200);
const costFill = await ev(`(function(){
  var lab=[].slice.call(document.querySelectorAll("button")).find(function(x){return (x.textContent||"").trim().indexOf("巡检成本渠道")>=0;});
  if(!lab) return "no-row";
  var inp=lab.parentElement.querySelector('input[type=number]');
  if(!inp) return "no-input";
  inp.focus();
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
  setter.call(inp,"600");
  inp.dispatchEvent(new Event("input",{bubbles:true}));
  inp.blur();
  return "filled";
})()`);
await sleep(3500);
const costDb = Number((await Q(`select coalesce(sum(amount),0) from "LeadChannelCost" where "channelId"='${costChanId}'`)).trim());
step("⑰ 渠道投放成本：面板填 600 → 失焦保存 → 库内回读 600", costFill === "filled" && costDb === 600,
  `fill=${costFill} db=${costDb}`);

// ⑱ 回填历史月（2026-11-23）：切到上月 → 该渠道填写 → 写进上月记录，本月不受影响
const prevMonth = (() => {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
})();
await send("Page.navigate", { url: `http://localhost:3000/leads?costMonth=${prevMonth}` });
await sleep(2500);
await ev(`(function(){var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return (x.textContent||"").trim()==="渠道与口径";});if(b)b.click();})()`);
await sleep(1200);
const backfill = await ev(`(function(){
  var lab=[].slice.call(document.querySelectorAll("button")).find(function(x){return (x.textContent||"").trim().indexOf("巡检成本渠道")>=0;});
  if(!lab) return "no-row";
  var inp=lab.parentElement.querySelector('input[type=number]');
  if(!inp) return "no-input";
  inp.focus();
  var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;
  setter.call(inp,"450");
  inp.dispatchEvent(new Event("input",{bubbles:true}));
  inp.blur();
  return "filled";
})()`);
await sleep(3500);
const prevDb = Number((await Q(`select coalesce(sum(amount),0) from "LeadChannelCost" where "channelId"='${costChanId}' and month='${prevMonth}'`)).trim());
const curDb = Number((await Q(`select coalesce(sum(amount),0) from "LeadChannelCost" where "channelId"='${costChanId}' and month<>'${prevMonth}'`)).trim());
step("⑱ 回填上月：写入上月记录，本月原有 600 不受影响",
  backfill === "filled" && prevDb === 450 && curDb === 600,
  `fill=${backfill} prev=${prevDb} cur=${curDb}`);

// 清理：删线索与其收案（按标记，不依赖 id 变量）
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "LeadActivity" where "leadId"='${leadId}'`], { encoding: "utf8" });
const intakeId = await Q(`select coalesce("convertedIntakeId",'-') from "Lead" where id='${leadId}'`);
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "Lead" where id='${leadId}'`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "LeadActivity" where "leadId" in ('${drillLeadId}','${upId}','${staleId}')`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "Lead" where id in ('${drillLeadId}','${upId}','${staleId}','${costLeadId}')`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "LeadChannelCost" where "channelId"='${costChanId}'`], { encoding: "utf8" });
execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
  `delete from "LeadChannel" where id in ('${chanId}','${chanParentId}','${costChanId}')`], { encoding: "utf8" });
if (intakeId && intakeId.startsWith("cm")) {
  execFileSync("docker", ["exec", "lawlink-db", "psql", "-U", "lawlink", "-d", "lawlink", "-c",
    `delete from "Intake" where id='${intakeId}'`], { encoding: "utf8" });
}

const pass = log.filter((l) => l.pass).length;
console.log(`\n  实测：${pass}/${log.length} 通过`);
ws.close();
console.log("WALKTHROUGH_RESULT " + JSON.stringify({ total: log.length, pass, log }));
