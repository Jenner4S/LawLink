# 验证方法论（Playbook）

> 这份文档记录**我怎么验证**，以及**我在验证上犯过的错**。
> 规则不是凭空写的，每一条都对应一次真实的误判。

---

## 一、为什么需要这份文档

前 31 轮我在 `/tmp` 里写了 **124 个**几乎相同的验证脚本——同样的 CDP 连接、同样的登录流程、同样的 `send/ev` 辅助函数。这本身就在「重复造轮子」，而我这 30 多轮一直在做的事情之一，正是消灭项目里的重复造轮子。

更严重的是，那些临时脚本让我犯了 **4 次同类错误**，全部是**验证方法不精确**，不是产品缺陷：

| # | 我的做法 | 得到的结论 | 真相 |
|---|---|---|---|
| 1 | 用 `el.focus()` 测焦点可见性 | 12 个元素里 11 个不可见 | `:focus-visible` 只在键盘交互时激活，程序化聚焦不触发，读到 `outline` 恒为 `none`。浏览器默认焦点环一直在工作 |
| 2 | 取列表页第一个 `a[href*="/matters/"]` | 信号条消失、程序栏没了 | 取到的是 `/api/matters/export?`（导出按钮），导航到 API 当然没有页面结构 |
| 3 | 取第一个客户验证证件号脱敏 | 脱敏失效 | 该客户 `idNumber` 本就为空，「未登记」是正确行为 |
| 4 | 断言页面含「本案」「案卷」 | 客户/案件详情缺内容 | 页面实际用词不同，纯属关键词猜错 |

**共同点：我拿「测试写错了」当「产品坏了」。**

如果不把教训编码成机制，它们会随临时脚本一起消失，然后在下一次重犯。

---

## 二、工具

```bash
# 部署：一条命令走完「静态 → 测试 → 构建 → Docker → 三重验证」
./scripts/deploy.sh                   # 任一步失败即 exit 1，不继续
./scripts/deploy.sh --skip-tests      # 只在确认可跳过测试时用

# 前置（只做 UI 巡检、不重新部署时）
sh scripts/verify-ui.sh chrome        # 启动带 CDP 的 Chrome（端口 9333）
docker compose --profile full up -d   # 应用在 3000

# 用法
node scripts/verify-ui.mjs routes     # 40 条路由巡检
node scripts/verify-ui.mjs a11y       # 无障碍基础 + 键盘焦点
node scripts/verify-ui.mjs contrast   # 设计 token 对比度（读实时计算样式）
node scripts/verify-ui.mjs flow       # 业务链走查
node scripts/verify-ui.mjs timing     # 导航性能
node scripts/verify-ui.mjs all        # 全部

# 环境变量
BASE=http://localhost:3000 CDP=9333 \
VERIFY_EMAIL=... VERIFY_PASSWORD=... \
node scripts/verify-ui.mjs all
```

**`deploy.sh` 为什么存在**（2026-11-20）：前 84 轮的部署验证靠自律——先 `export BUILD_ID`、再看 `echo $?`、再核镜像 ID。这三件事各忘过一次：

| 忘掉什么 | 后果 |
|---|---|
| `export BUILD_ID` | 部署出 `buildId=dev`，页面过期检测失效，用户撞 `Failed to find Server Action` |
| 看 `echo $?` | `docker compose build` 打印 "Built" 但 `npm run build` 其实失败了 |
| 核镜像 ID | 「以为部署了其实没部署」 |

**把正确做法变成默认路径，比记住正确做法可靠。**

另：脚本用 `--no-deps app` 只重建应用容器。实测 `up -d --force-recreate` 会把 `lawlink-db` 一起 Recreate——数据卷还在所以没丢，但每次部署重启数据库毫无必要。

退出码：`0` 全通过 / `1` 有失败 / `2` 执行中断（连不上、登录失败）。

工具里已经编码了三条教训：`pick()` 强制排除 `/api/`、焦点检测只提供真实 Tab 键、断言失败时打印「先怀疑选择器」的检查清单。

---

## 三、铁律

### 1. 先怀疑选择器，再怀疑产品

断言失败时的排查顺序：

1. **取到的元素对不对？** 打印 `href` / `textContent` 看一眼。列表页里第一个 `a[href*=X]` 常常是导出/下载按钮。
2. **关键词真的在页面上吗？** 直接 `document.body.innerText` 里 grep 一下真实文案，别猜。
3. **是不是「没有数据」？** 空态不是缺陷。空列表里断言「有内容」必然失败。
4. **最后才怀疑产品。**

### 2. 焦点类断言必须用真实键盘事件

```js
// ❌ 永远不要这样测 :focus-visible
el.focus(); getComputedStyle(el).outline

// ✅ 必须派发真实 Tab 键
Input.dispatchKeyEvent({ type: "rawKeyDown", windowsVirtualKeyCode: 9, key: "Tab" })
Input.dispatchKeyEvent({ type: "keyUp", windowsVirtualKeyCode: 9, key: "Tab" })
// 然后读 document.activeElement 的计算样式
```

`el.focus()` 是程序化聚焦，浏览器不会把它当作键盘交互，`:focus-visible` 不匹配。用它会得出「焦点不可见」的假阳性。

### 3. 数值类断言必须能与手算交叉验证

第 28 轮我按 HSL 逐档手算了对比度（`t-faint` 64% → 2.15、52% → 3.39）。第 32 轮工具跑出同样的数字，我才敢说工具是可信的。

**如果工具算出的值和独立算法对不上，先修工具，不要拿它去指认产品。**

（本轮就撞上过：`toRgb` 对背景传裸 HSL、对前景传 `hsl(...)` 包裹值，导致三次比值完全相同（3.26/3.26/3.26）。三个背景算出同一个数，这本身就是工具坏了的信号。）

### 4. 验证「不误判」比验证「能命中」更重要

- 检查 JSONB 查询时，除了验证「目标 id 能查到」，还必须验证「其他 id 查不到」。
- 检查权限过滤时，除了验证「有权限的能看到」，还必须验证「没权限的看不到」。
- 检查脱敏时，除了验证「有值会打码」，还必须验证「空值显示未登记而不是报错」。

**只测正向，等于没测。**

### 5. 断言要具体到数值、状态、日期

```js
// ❌
expect(result).toBeTruthy()

// ✅
expect(result.settledAmount.toString()).toBe("300")
expect(result.status).toBe("SETTLED")
expect(calendarDay(result.expiryDate)).toBe("2028-06-15")
```

「不抛错」不是通过，是**没触发到**。

### 6. 找不到问题时要如实说「不需要改」

第 30 轮我判定了两件事**不需要改**：

- **加载态**：全站无 `loading.tsx`，看似缺失。但实测导航 202–472ms——300ms 内加骨架屏会变成「骨架闪一下就没」，比不加更乱。
- **错误态**：`toast.error` 覆盖 78 文件、`alert()` 零使用、统一错误提取覆盖 87 文件。已经高度统一。

**「看起来缺什么」和「真的缺什么」是两件事。** 后者需要证据。

### 7. 时区 / 环境的假设必须显式验证

期限计算的缺陷（第 22–23 轮）是这样暴露的：

```
TZ=UTC        → 2026-12-31 + 1 年 = 2027-12-31 ✅
TZ=UTC-8      → 2026-12-31 + 1 年 = 2027-12-30 ❌
```

当前容器碰巧是 `TZ=UTC`，所以一直正确。**「碰巧正确」是最危险的状态**——它让缺陷长期潜伏，直到换环境才爆。

同类：`.focus()` 在多浏览器下行为一致、选择器在数据为空时表现不同。**换一组条件再跑一遍**，是发现这类缺陷的唯一方法。

### 8. 验证不得污染被测数据

我在测试里犯过两次：

- **写主库**：为测审计链并发写了 25 条 `RACE_TEST_` 记录。审计不可删（触发器拦截），永久留在链上。**正确做法是交付前重建库，而不是绕过防删设计。**
- **忘清理**：第一版财务测试用真库建夹具（Client → Matter → User），在 `matter.create` 处失败，但前面的 `client` 已落库。Client 计数从 11 变成 13。

**规则**：真库测试必须建独立临时库并 DROP；不得写主库；失败路径也要清理。

---

## 三点五、区分「缓存」与「真回归」（第 5 次误判的教训）

第 39 轮我把 `Server Action` 失败的报错直接归因为浏览器缓存——因为第 30 轮遇过同样的提示。**那次是真回归。**

| 现象 | 缓存（旧构建） | 真回归 |
|---|---|---|
| 报错 | `Failed to find Server Action` | 同左，**无法靠报错区分** |
| `document.documentElement.lang` | **有值**（页面正常渲染，只是逻辑旧） | **为空**（错误页不设 lang） |
| 页面标题 | 正常 | 可能为 `LawLink — 律师案件管理系统`（fallback） |
| `document.body.innerText` | 有完整内容 | 只有 `This page couldn't load` 之类 |

**判据：`lang` 是否为空。** 错误页不会设置 `lang`。

工具的 `diagnosePage()` 已经把这个判据编码进去了，会直接返回 `verdict`：
`ok` / `error-page` / `not-rendered` / `empty`。**不要自己盯报错文案猜。**

---

## 三点六、防御措施本身也会误判（第 6 次）

我为防误判写了 `diagnosePage()`，**它第一次运行就误报了**：

```js
// ❌ 我写的
isServerError: /500|server error/i.test(t)

// 结果：/admin/express（内容完全正常）被判成错误页，
// 因为页面里任何含 "500" 的数字（金额、条数）都会命中。
```

**教训：判断条件里的裸数字是最危险的正则。**

```js
// ✅ 只认完整短语
isServerError: /Internal Server Error|Application error: a server-side exception/i.test(t)
```

**同型风险清单**（写检查规则时逐条自查）：
- 裸数字 `500` / `404` / `0` —— 会命中业务数据
- 裸单词 `error` / `fail` —— 会命中正常文案（"失败率""错误日志"）
- 关键字猜测（"本案" vs 实际用词"案件"）—— 第 31 轮踩过

**规则：宁可用完整短语、宁可漏报（漏报会被下一条规则补上），也不要宽匹配。**

---

## 四、检查清单（每次提交前）

- [ ] `npx vitest run` 全绿
- [ ] `npx tsc --noEmit` 0 错误
- [ ] `node scripts/verify-ui.mjs all` 全通过
- [ ] 若改了 UI：硬刷新（`Network.clearBrowserCache`）后再验，否则会把缓存问题当代码问题
- [ ] 若改了迁移：`migrate deploy` 后**用 `information_schema` 确认列真的存在**（空迁移文件也会报「成功」）
- [ ] 若改了数据：`pg_dump` 先备份，并全表扫描确认无测试残留
- [ ] 断言失败时先按「铁律 1」排查，再改产品

---

## 五、我还没做到的（如实声明）

- **写操作闭环未验证**：新建收案 → 冲突检索 → 转正式案件 → 登记期限 → 结案 → 归档，这一串真实点击没有跑过（会在库中产生业务数据，应在独立演练库执行）。
- **多用户并发未实测**：所有验证都是单会话。
- **真实外部依赖未打通**：真实 IdP、真实认证器（Touch ID / Windows Hello）、真实 CAPTCHA、真实 IMAP。
- **跨浏览器未验证**：只在 Chromium 上跑过。

---

*本文档随验证工具一同维护。新增教训时，先想清楚能否编码进工具——能编码的就不要只写在这里。*
