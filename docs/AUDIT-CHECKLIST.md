# 审计模式清单

> 用途：列出本项目**反复出现的缺陷类型**，每种给出「长什么样」「怎么查」「查到后怎么修」。
> 来源：2026-11 月 82 轮审计中实际踩到的坑，不是理论推演。
> 配套：`VERIFICATION-PLAYBOOK.md` 讲**怎么验证**，本文讲**该查什么**。

---

## 一、隔离墙漏接（12 个入口，最反复）

**症状**：被隔离在某个案件的人，仍能读到/改到该案的数据。

**根因**：`isMatterWalledFor` 与 `ethicalWallExclusion` 建好了，但**每次新加功能都可能忘记接线**。墙只挂在「列表读取」这一条路上，写路径、导出路径、AI 路径各走各的。

**怎么查**：

```bash
# 1) 找出所有以 Matter 为对象的断言
rg -n "^export (async )?function assert.*Matter" src/lib/permissions/index.ts

# 2) 逐个看它内部用的是什么 filter
#    含墙的：matterReadVisibilityFilter / matterFinanceVisibilityFilter / ethicalWallExclusion
#    不含墙的：matterAssociationFilter（只查 owner/members）、裸 { id, deletedAt: null }

# 3) 对每个「接受 matterId 参数」的函数做同样检查
rg -n "export (async )?function [a-zA-Z]+\([^)]*matterId" -g '*.ts' -g '!*.test.*' src/
```

**已修的 12 个入口**（新增功能时对照，别再漏）：

| 入口 | 位置 |
|---|---|
| 财务写 | `finance/ledger-access.ts` `assertLedgerWrite` |
| 文档写 | `archive/guard.ts`（内部 `findWritableMatter`，经 `assertMatterWritable` / `assertDocumentWritable` 对外） |
| 材料下载/预览 | `approvals/documents.ts` `canReadDocument` |
| AI 全文外发 | `ai/document-access.ts` `canReviewDocument` |
| 工作簿导出 | `matters/export-query.ts` `buildMatterWhere` |
| 完整卷宗导出 | `api/archive/[matterId]/export/route.ts` |
| 报表导出 | `lib/roles/report-scope.ts` `reportAccess` |
| 案件办理断言 | `permissions/index.ts` `assertCanHandleMatter` |
| 主办/协办断言 | `assertCanLeadMatter` / `assertCanOwnMatter` / `assertCanModifyMatter` |
| 个人工作台 | `reminders/work-actions.ts` `getWorkBoard` |
| 审批记录可见性 | `approval-permissions/records.ts` `approvalRecordAccess` |

**未修的 1 个（已登记）**：通知（`notifications/actions.ts`）——`refType` 多态，修复需重构提醒链路。见 `DELIVERY-STATUS` 已知限制。

**修的时候用哪种写法**：

```ts
// ✅ 首选：拼进 where（零额外查询，不引入新依赖，测试 mock 不受影响）
where: { ..., ...ethicalWallExclusion(userId, role) }

// ✅ 需要判「是否命中」时用对象级判定
if (await isMatterWalledFor(prisma, { matterId, userId, role })) throw new ActionError("...")

// ❌ 不要把墙放进「角色分支」里 —— 墙对全所生效（含合伙人/管理员），
//    被 isManager 的 {} 短路掉就等于没接
```

**踩过的坑**：`role` 传空字符串会让 Prisma 把 `{ denyType: "ROLE", role: "" }` 当无效枚举抛 `PrismaClientValidationError`。空角色时应**不生成** ROLE 条件。

---

## 二、日期静默滚动（5 处，同一个 bug 换位置）

**症状**：`2026-02-30` 被接受，存成 3 月 2 日；`2026.13.01` 滚成 12 月 31 日。

**根因**：`new Date(y, m, d)` / `Date.UTC(y, m, d)` / `new Date("2026-02-30T00:00:00+08:00")` **都不报错**，V8 会顺延。`Number.isNaN(getTime())` 对滚动后的日期返回 **false**，拦不住。

**怎么查**：

```bash
# 手写的日期构造（最高风险）
rg -n 'new Date\(`|new Date\(Number\(|Date\.UTC\(' -g '*.ts' -g '!*.test.*' src/

# 逐个确认：解析后有没有拿 shDayKey 回验？
```

**必须用统一函数**（`src/lib/ui/sh-time.ts`）：

```ts
parseShDayStart("2026-09-20")   // → 上海 9/20 00:00，日期不存在返回 null
parseShDayEnd("2026-09-20")     // → 上海 9/20 23:59:59.999
parseShDateTime("2026-09-20", "10:00")  // 日期 + 时刻都验
```

**一个额外陷阱**：`new Date(y, m, d)` 按**运行时区**解释。容器是 UTC，写 `new Date(2026, 8, 20)` 会得到「上海 08:00」而不是「上海 00:00」——**整体偏 8 小时**。必须走 `+08:00` 拼接。

**已修 5 处**：导出筛选边界 / 短信解析 / 文书日期登记 / 隔离墙失效日期 / 案件批量导入。

---

## 三、同一逻辑写了多遍，只修对一处

**症状**：两份实现行为不一致，或一份修好了另一份没动。

**已发现的三组**：

| 逻辑 | 写的次数 | 结果 |
|---|---|---|
| 日期回验 | 4 处 | 2 处漏了月日 → 已收拢为 `sh-time` 三个函数 |
| 案件类别标签 | 3 种叫法（民商诉讼 / 民商事 / 民诉） | 已统一到 `enums.ts`；剩下的是编号前缀等合理用途 |
| 金额累加 | 5 处 `acc + Number(x)` | 已统一为 `Decimal.plus` |

**怎么查**：

```bash
# 找同一业务概念的多处手写字面量
rg -n '"民商诉讼"|"劳动仲裁"|"刑事诉讼"' -g '*.ts' -g '!*.test.*' src/ | grep -v enums.ts

# 找同一校验形态的多份实现
rg -n 'Number.isNaN\(.*getTime\(\)\)' -g '*.ts' -g '!*.test.*' src/
rg -n 'acc \+ Number\(' -g '*.ts' -g '!*.test.*' src/
```

**判断标准**：**能被别处复用的才该抽**。编号前缀（"民"）、程序代码（"CC"）、可配置类词（"民诉"）是**不同用途**，不抽。

---

## 四、软删 / 硬删口径不一致

**症状**：列表看不到某个案件，但知道 ID 就能下载它的材料；或删材料把审核记录一起删了。

**怎么查**：对每个「按 matterId 取数」的查询，确认 `where` 里有没有 `deletedAt: null`：

```bash
rg -n "matterId" -A3 src/lib/approvals/documents.ts | grep -E "deletedAt|count|findFirst"
```

**两个已修的点**：

- `canReadDocument` 的 matter 分支此前**没有** `deletedAt: null`（`listMatters` / `assertCanReadMatter` 都有）
- `hardDeleteDocument` 会经 `onDelete: Cascade` 抹掉 `ReviewRecord`（合规证据）→ 已加运行时保护：有审核记录的材料禁止硬删

**判断原则**：软删可恢复，所以「恢复后材料自动重新可下载」不算冲突；但**审核留痕不该因删材料而消失**。

---

## 五、错误类型与文案

**三个具体问题**：

1. **抛 `new Error` 而非 `ActionError`** → `actionErrorMessage` 不识别，用户看到 Next.js 通用错误页而不是那句中文提示
2. **zod 默认 message 是英文**（`"Too small: expected string to have >=2 characters"`）→ `parseInput` 已加中文兜底
3. **技术错误误导**：发票重复凭据编号落到 `P2010(23505)`，被翻译成「账务或授权已变化，请刷新后重试」——对「编号已登记过」完全是误导

**怎么查**：

```bash
# 业务断言抛 Error 而非 ActionError
rg -n "throw new Error\(" -g '*.ts' -g '!*.test.*' src/

# schema.parse（会漏英文结构）vs parseInput（中文可读）
rg -n "\.parse\(" -g '*.ts' -g '!*.test.*' src/server | grep -v "JSON.parse"
```

---

## 六、我自己的误判模式（15 次，最该防的）

**比缺陷更难防的是「用对的工具读错的信号」。**

| # | 误判 | 正确做法 |
|---|---|---|
| 1–5 | 把浏览器缓存当代码回归（或反之） | **看 `lang` 属性**：空 ⇒ 错误页 ⇒ 真回归；有值 ⇒ 可能是旧构建 |
| 6 | 防御措施误报（`/500/i` 匹配了含 "500" 的正常页面） | 正则要**精确到完整错误串** |
| 7 | "某处缺少 X" 的中途结论 | 必须**读完数据流出口**才能断言 |
| 8 | 把「文件里所有 export function」当成「调用该断言的函数」 | 用 `awk` 定位**调用行所属函数**，不是文件级列表 |
| 9 | 统计零引用时**漏掉 `src/tests/`** | 有测试覆盖 = 有意保留，是保留判断的第一手证据 |
| 10 | `rg -l` 命中文件就判「符号存在」 | **看具体行**（`rg -n`）——命中的可能是我自己写的注释 |
| 11 | 用 `disabled={pending}` 精确匹配，漏掉 `busyId === id` 等写法 | 判断「有没有保护」必须看**实际形态**，不能套单一模式 |
| 12 | `rg -L` 语义误解（那是跟随符号链接，不是"不含匹配"） | 用 `--files-without-match` 或逐行判断 |
| 13 | **批量正则替换误伤同类字符串**（给 select 加 `matterId` 时打中了没有该字段的 Intake） | 批量替换前**确认目标串唯一**；宁可逐处改 |
| 14 | **把「主流测过」说成「其余都有测试」**（Round 90 声称其余墙入口已覆盖，Round 91 逐个查发现 4 个零测试） | **说「其余都有」之前必须逐个查**。「主流」与「其余」是两个集合，「主流测过」不蕴含「其余没漏」 |
| 15 | **变异验证的锚点没匹配上，却当成验证通过**（Round 91/92 各一次：`AssertionError: 锚点未匹配` 被忽略，测试「通过」其实没被证明能失败） | 变异脚本必须**断言锚点命中**；`Tests passed` 在变异未生效时是假信号 |

**共同点**：都是「工具用对了，信号读错了」。

### 按类型归类：15 条压成 6 类

逐条记不够——同类的下一次会换个面貌出现。按类型记，防范才有针对性：

| 类型 | 条目 | 统一防范 |
|---|---|---|
| **A · 缓存/环境混淆** | 1–5 | 判断「是不是回归」前，先确认**看到的是哪一次构建的产物**（`lang` 属性 / 镜像 ID / BUILD_ID） |
| **B · 工具语义误解** | 9、10、12 | 用不熟的 flag 之前**先验一次反向用例**（`rg -l` 命中一个我确定不含的串，看它是否也命中） |
| **C · 检测方式单一** | 6、11 | 任何「有没有 X」的问题，先用**两种不同方式**各查一遍，结果不一致时以更宽的那种为准 |
| **D · 结论过早** | 7、14 | 说「没有」「都有」之前，把**检测范围完整走完**（读完函数出口、逐个枚举集合） |
| **E · 替换/变异失手** | 13、15 | 任何批量替换/变异操作，**先断言目标串命中且唯一**，命中数不对就停 |
| **F · 函数归属混乱** | 8 | 统计「谁调用了 X」前，先确认统计的**粒度**（文件 / 符号 / 调用行） |

**最通用的一条**：任何"我发现 X" 的结论，先问——**我是怎么知道的？我的检测方式会不会误报？**

**哪一类最常犯？样本不足以排序。** 用台账关键词粗统计：D 类（过度概括/中途结论）2 次、
A 类（缓存混淆）2 次、E 类（替换/变异失手）1 次——**只说得出「A 与 D 出现得较多」，
说不出「D 最多」**。

（这一句本身差点又犯了 D 类：初稿写的是「最常犯的是 D 类」，写的时候并没有数过。
数完才发现 A 与 D 并列。**在写「防结论过早」的段落里做结论过早的断言** —— 记在这里当例子。）

---

## 七、每次审计的固定动作

### 部署：`./scripts/deploy.sh`（2026-11-20 起）

**正常部署一律走脚本**，不要手敲那串命令：

```bash
./scripts/deploy.sh              # 静态 → 测试 → 构建 → Docker → 三重验证
./scripts/deploy.sh --skip-tests # 只在确认可跳过测试时用
```

脚本做的事（任一步失败即 `exit 1`，不继续部署）：

| 步 | 内容 | 防的是什么 |
|---|---|---|
| 1/5 | `tsc --noEmit` + 全量 `eslint src` 归零 | 「只 lint 改动文件」的盲区 |
| 2/5 | `npx vitest run` 全绿 | 带病上线 |
| 3/5 | `npm run build` 看 **exit code** | 「打印 Built 但实际失败」 |
| 4/5 | `docker compose build` + 自动注入 `BUILD_ID` | 忘了 export 导致 `buildId=dev` |
| 5/5 | 镜像 ID 变化 + `BUILD_ID` 真实且匹配 | 「以为部署了其实没部署」 |

**为什么要有第 5 步**：`BUILD_ID` 是「页面已过期」检测的依据。`dev` 会让检测失效，用户可能撞到 `Failed to find Server Action`。而它靠人工 export 时必然会忘——本项目在 84 轮就忘过一次。

**为什么用 `--no-deps app`**：`up -d --force-recreate` 会重建**所有**服务的容器，包括 postgres。实测（2026-11-20）它确实把 `lawlink-db` 一起 Recreate 了——数据卷还在所以没丢，但每次部署重启数据库毫无必要，且万一哪天卷配置变过就是事故。

### 文档数字：`./scripts/check-doc-numbers.sh`

**文档里的数字是手写的，每次加测试/加台账条目都会落后。**

2026-11-21 五方对齐时发现「测试 1399 vs 实际 1420」「台账 313 vs 实际 387」都过期了。
手动同步必然会漏，所以做成可随时执行的核对：

```bash
./scripts/check-doc-numbers.sh
#   测试数    文档 1420   实际 1420   ✅
#   台账条目  文档 387    实际 387    ✅
#   迁移数    文档 15     实际 15     ✅
#   schema 漂移 -- This is an empty migration. ✅
# 退出码：0 = 一致，1 = 有不一致
```

已做变异验证：把文档改成 9999 后退出码变 1，说明它真能发现不一致。

**加 `--fix` 自动同步**：手写数字跟不上的问题是持续的——2026-11-21 一天内连踩两次
（改准 387 → 又加台账变 390 → 又加变 391）。光检查会陷入「改准→又落后」的循环，
所以脚本支持 `./scripts/check-doc-numbers.sh --fix` 把实际值写回文档。

**`--fix` 之后不要 `exec` 重跑整脚本**：那会再跑一遍测试（几分钟），
且曾因输出缓冲导致提取到 `?`。现在 `--fix` 完成后直接 exit 0，
本次测得的结果即最终结果。

### 手工核对（脚本之外偶尔要用）

```bash
# 数据：schema 与库是否漂移
npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
                        --to-schema-datamodel prisma/schema.prisma --script
# 期望 "This is an empty migration."

npx prisma migrate status        # 期望 "Database schema is up to date!"

# 真机：83 项 UI 巡检
sh scripts/verify-ui.sh chrome && node scripts/verify-ui.mjs all

# 部署后（脚本已自动做，手工排查时用）
docker images lawlink-app --format "{{.ID}} {{.CreatedAt}}"
curl -s http://localhost:3000/api/version    # 期望 b2026...，不是 dev
```

---

## 八、这份清单怎么用

**新增功能时**：
1. 走一遍第一节（隔离墙）——问「这个新入口要不要墙」
2. 涉及日期解析 → 用 `sh-time` 的函数，自己别写 `new Date`
3. 涉及金额 → 用 `Decimal.plus`，别 `acc + Number(x)`
4. 抛出业务错误 → `ActionError`，不是 `Error`
5. 表单校验 → `parseInput`，不是 `schema.parse`

**做审计时**：
- 从第一节往下扫，每节都给了 grep 命令
- 结论前先过第六节（我自己的误判模式）

**这份清单不保证穷尽**——它只记录已经踩过的坑。新坑出现了就补进来。
