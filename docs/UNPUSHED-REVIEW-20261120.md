# 未推送提交审查清单（192 个）

## 一、需要你重点看的 14 个

### 数据层（改了 schema / 迁移，推上去别人升级会跑）

| 提交 | 说明 |
|---|---|
| `a809f21` | **破坏性**：材料版本链加唯一约束，修复并发写出的重复版本 |
| `de535ca` | **破坏性**：撤销我此前引入的 previousHash 唯一索引（那个索引导致无法建案） |
| `70eae22` | 审计链并发分叉：用唯一索引根治 |
| `0959f0c` | 补齐 schema 声明但库中缺失的 previousHash 索引 |
| `e8826cb` | 审计按对象查询加索引（14.9ms → 3.0ms） |
| `35a6564` | 保全续保按日历单位算，修跨闰年少一天 |

> ⚠️ `a809f21` 与 `de535ca` 会改动**已有数据的约束**。如果别人已经部署过，升级前需要备份。

### 部署链（这几条决定「别人能不能装起来」）

| 提交 | 说明 |
|---|---|
| `87a8ed3` | deploy.sh 补上数据库迁移 + 首次部署检测 |
| `0809be4` | 生产镜像里 `prisma db seed` 从来跑不通（两个独立原因） |
| `a3656f7` | 自动迁移必须先自动备份 |
| `fdf9b89` | Docker 构建支持可替换 Alpine/npm 镜像源（中国大陆可达） |
| `4551c92` / `06f3224` | deploy.sh 的 tsc 退出码判断、变异验证 |
| `adfc181` | 新增部署脚本本身 |

> 没有 `87a8ed3` + `0809be4`，**新部署出来是一个空库、且没有管理员账号**。这是这批里最重要的两条。

### 大功能（不是修 bug，是新增能力）

| 提交 | 说明 |
|---|---|
| `f1f6015` | 隔离墙 Ethical Wall（权限层 + 端到端验证） |
| `da5dab9` | WebAuthn / Passkey 登录 |
| `386de17` | 邮件归档与自动匹配案件 |
| `1b54d86` | 合同确认留痕（**降级实现，不是电子签名**） |
| `df0b375` | 权限修复、链式审计、外发加固、工时费率、SIEM 导出（混合大提交） |

---

## 二、按领域全量清单


生成时间：2026-11-20 09:15　基准：`origin/main..HEAD`

- 总计 **192** 个提交
- 触及生产代码（`src/`）**128** 个
- 仅文档/脚本/测试 **64** 个

> 审查建议：先看「触及生产代码」的部分；`src/` 之外的提交只看是否要留。

---

## 部署与运维（55 个，其中 18 个改代码）

- `dae9035` 11-20 feat(notes): 补经办记录改/删入口（updateNote / deleteNote 此前零引用）
- `ba07a37` 11-20 feat(tasks): 补事项编辑入口；判定 deleteTask 是设计性死代码
- `8b27ce4` 11-20 perf: 建计时基准并据此否掉一条优化（附实测数据与回滚说明）
- `272ce22` 11-20 fix(audit): 补齐审计扫描的 5 种写法（连误报 5 次后的修正）
- `7e9493a` 11-20 fix(finance): 开票申请提交不留痕（钱链路审计覆盖扫描的唯一真缺口）
- `13d6a75` 11-20 feat(invariants): 分成链路两条（第 14/15 条）+ 改掉「空转的绿」的做法
- `a5d170d` 11-20 feat(invariants): 发票侧两条上界（第 12/13 条）+ 结清「应收 vs 合同额」的调查
- `73dbf86` 11-20 feat(invariants): 实收与来源流水一致性（第 11 条），并主动放弃一条想当然的
- `c3ac1bc` 11-20 feat(invariants): 金额链路两条不变量（冗余汇总 vs 明细漂移）
- `97b60f3` 11-20 chore(ops): 数据不变量接进部署流程（此前只是手动脚本）
- `9cc6c10` 11-20 feat(invariants): 增加跨表状态一致性两项检查（并砍掉一条自己想当然的）
- `a35b7c5` 11-20 refactor(tests): 收敛可达性判定至 27 条 + 抽出真库测试脚手架
- `15acc82` 11-20 chore(audit): Server Action 可达性盘点（403 个导出里 63 个前端点不到）
- `25dde00` 11-20 chore(guards): 写守卫审计工具化（棘轮式）+ 删除死代码 fileDocument
- `a3656f7` 11-20 fix(ops): 自动迁移必须先自动备份
- `0809be4` 11-20 fix(seed): 生产镜像里 `prisma db seed` 从来跑不通（两个独立原因）
- `87a8ed3` 11-20 fix(ops): deploy.sh 补上数据库迁移与首次部署检测 + 迁移链重放验证
- `cd86a86` 11-20 fix(ops): 修正不变量脚本的 ChainVerifyResult 字段名
- `f0ce082` 11-20 feat(ops): 数据库不变量检查 + 接入灾备演练（从「数据一样」到「应用能用」）
- `3fcad9e` 11-20 fix(ops): 备份脚本因客户端版本不匹配而静默失效 + 加入可重复的灾备演练
- `fdf9b89` 11-20 build: Docker 构建支持可覆盖的 Alpine/npm 镜像源（中国大陆可达）
- `d92d3fe` 11-20 fix(scripts): check-doc-numbers 三态输出 + 测试运行锁
- `e66dc4b` 11-20 chore(scripts): check-doc-numbers 读不到测试数时报明原因
- `1df3c6d` 11-19 feat(mutation-check): 每个变异加探针自检，结果分三态
- `a3e9c12` 11-19 fix(mutation-check): M5 探针改成未使用的局部变量（原来那版报假失败）
- `86e4ee4` 11-19 chore: 新增 scripts/mutation-check.sh，把变异验证做成可重复执行
- `06f3224` 11-19 fix(deploy): 第 5 步三重验证做变异验证；修两处「会拦住但说错话」
- `e1ad09a` 11-19 fix(scripts): check-doc-numbers 自给环境依赖；漂移检测区分「漂移」与「命令失败」
- `4551c92` 11-19 fix(deploy): tsc 检查补判退出码；给 deploy.sh 做变异验证
- `330235b` 11-19 chore: check-doc-numbers 从 bash+perl 重写为 node
- `228ea7e` 11-19 docs: 零引用导出清单（97 个）+ check-doc-numbers.sh 加空值保护
- `085b62d` 11-19 chore: check-doc-numbers.sh 加 --fix 自动同步
- `c4b84f1` 11-19 chore: 新增文档数字核对脚本；修正两处已过期的数字
- `97f8eea` 11-19 chore: 删除测试文件里未使用的 Prisma 导入（deploy.sh 拦下的）
- `0cb5b22` 11-19 fix(scripts): 另两个写库脚本加 dry-run 防护；修掉我自己写的假 dry-run
- `ea4a358` 11-19 fix(scripts): 回填脚本默认改为 dry-run，误跑不再直接改数据
- `e52e84d` 11-19 docs+chore: deploy.sh 写入两份文档；verify-ui 不带参数改为显示用法
- `adfc181` 11-19 chore(deploy): 新增部署脚本，把「构建+三重验证」固化为默认路径
- `0959f0c` 11-19 fix(migrations): 补齐 schema 声明但库中缺失的 previousHash 索引
- `e8826cb` 11-19 perf(audit): 加 (targetId, targetType) 索引，按对象查审计从 14.9ms 降到 3.0ms
- `a809f21` 11-19 fix(data)!: 材料版本链加唯一约束，修复并发写出的重复版本（H1）
- `a6fa5a7` 11-19 docs(upgrade): 给增量脚本补前置检查说明，并记录升级路径的验证边界
- `1b41b71` 11-19 feat(verify): 把「读错信号」编码成机制，而不是再写一条规则
- `de535ca` 11-19 fix(audit)!: 撤销 previousHash 唯一索引——修复我引入的「无法建案」P0
- `c4dd591` 11-19 chore(verify): 把 32 轮的验证教训沉淀成工具与 playbook
- `35a6564` 11-19 fix(preservation): 续保按日历单位计算，根治跨闰年少一天
- `70eae22` 11-19 fix(audit): 用唯一索引根治审计链并发分叉
- `1b54d86` 11-19 feat(contracts): 合同确认留痕（P1-4 降级实现，非电子签）
- `da5dab9` 11-19 feat(auth): WebAuthn/Passkey 登录（P2-2 后半）
- `386de17` 11-19 feat(crm): 邮件归档与自动匹配案件（P1-3）
- `123c9e4` 11-19 feat(security,test): 隔离墙管理 UI、修测试 flake、消除元测试盲区
- `f1f6015` 11-19 feat(security): 隔离墙 Ethical Wall（权限层 + 端到端验证）
- `e302fcc` 11-19 fix(ops,ui): 导入结果显示冲突、镜像裁剪 dev 依赖、清理测试污染
- `e3dceb7` 11-19 feat(crm,ops): 工时 UI、导入利冲、备份一致性校验、法务清查
- `df0b375` 11-19 feat(security,crm): 权限修复、链式审计、外发加固、工时费率、SIEM 导出

## 财务/金额（19 个，其中 18 个改代码）

- `f6acd30` 11-20 fix(tests): 8 个未迁移的临时库测试补退避重试（修掉偶发门禁）
- `48ca08f` 11-20 refactor(tests): 16 个真库测试迁到 temp-db 脚手架（测试总行数 -289）
- `4452977` 11-20 fix(ui): 三处静默失败改为可感知（通知轮询 / 财务弹窗 / 审查历史）
- `1d09157` 11-19 fix: 批量导入批次留痕、搜索失败区分、证件照片错误日志（agent 报告的 B-5/B-6）
- `4fde2cc` 11-19 test(finance): 真实库补齐金额 Decimal 累加的验证（Round 65 的缺口）
- `2376994` 11-19 perf(finance): 开票依据校验的两次查询合并为一次；重测 SQL 条数类结论
- `7b71492` 11-19 fix(security)!: 补齐三个 Matter 断言的隔离墙，并修正错误类型
- `9142a79` 11-19 test+fix(finance): 补三个零覆盖财务 Tx 的 47 例测试，修凭据编号误导文案
- `06becdf` 11-19 fix(finance): 金额累加统一走 Decimal，消除 5 处 float 累加
- `9573577` 11-19 fix(ux)!: zod 校验错误不再漏英文给用户，统一中文化
- `ec843fe` 11-19 perf(finance): 消除开票依据校验的 N+1，5 份依据 6 条 SQL → 1 条
- `8a41ccc` 11-19 fix(security)!: 隔离墙接上财务写路径——此前律师被隔离但钱能被动
- `ed1f572` 11-19 test(finance): 补 18 例覆盖三个零测试的财务函数，修掉一处真崩溃
- `1be8736` 11-19 refactor(money): 统一 10 处手写金额，修掉两个真实显示缺陷
- `cf3dbc2` 11-19 feat(ux): 空态从「暂无」改为「为什么空 + 怎么填」，统一 32 处
- `22f5cb0` 11-19 fix(finance): 核销明细一致性护栏下沉到核销分支，解除与票据关联的耦合
- `63afa74` 11-19 test(finance): 补财务核销测试 45 例，并修掉加锁顺序 locale 依赖
- `676bb43` 11-19 refactor(validation): parseInput 统一校验入口，替代 ZodError 原型改造
- `3e4b572` 11-19 chore(deps): zod 4.6.7 升级 + npm audit 清零

## 案件与程序（28 个，其中 28 个改代码）

- `f051e2d` 11-20 fix(matters): 有待审归档申请的案件可被删除，导致归档记录静默消失
- `503716a` 11-20 fix(matters): 已归档案件的关联关系仍可增删（违反「归档即冻结」）
- `36679dd` 11-20 refactor(matters): 抽出经办记录聚合与材料环节匹配，再补 15 例（面板 3489 → 2627）
- `aff7d36` 11-20 refactor(matters): 抽出纯派生层并首次补上 15 例测试（面板 3489 → 2786）
- `0151fae` 11-20 refactor(matters): procedure-workflow-panel 拆出类型与数据表（3489 → 2938 行）
- `7907dd6` 11-20 fix(procedures): 并发添加同名环节会建两条（P2）
- `994674b` 11-19 refactor(enums): 程序结果/委托标签收进 lib/enums.ts；如实记录一次搬运失误
- `7083ce4` 11-19 fix: 多智能体三路审计后的三处修复（用户可见英文 / 同坑漏修 / 契约断言）
- `7c0887f` 11-19 perf(archive): archiveMatter 的两次 matter 查询合并为一次
- `b478c8d` 11-19 chore(lint): 全量 eslint 归零，并实现审计链的不可达记录定位
- `adfa0b0` 11-19 fix(imports)!: 案件导入的日期改用上海墙钟解析——UTC 容器里此前整体偏 8 小时
- `5b72a7c` 11-19 fix(security)!: assertCanHandleMatter 接上隔离墙——59 处写操作此前对被墙者敞开
- `2941a30` 11-19 refactor(date): 日期回验抽成共用函数，四处手写实现收拢为一处
- `8151694` 11-19 test+fix(export): 补导出格式化 37 例测试，并修掉日期静默滚动
- `90111c1` 11-19 perf(matters): 案件列表分页下推到数据库，并修掉分页漂移
- `030a7af` 11-19 refactor(matters): 抽出事项对话框共享层，769→688 行（仍未达标）
- `e54e79f` 11-19 refactor(matters): 拆出重要事项对话框，主文件 1598→860 行
- `e0eed07` 11-19 fix(security)!: 两个导出出口接上隔离墙（工作簿 + 完整卷宗）
- `e6614c7` 11-19 refactor(date): 消除 9 处重复的日期格式化包装
- `019ae51` 11-19 refactor(export): 三刀拆完，主文件 866→194 行，依赖图完全单向无环
- `c9014b1` 11-19 refactor(export): 拆出格式化函数层，验证大文件治理方法（1069→866）
- `6315d84` 11-19 fix(a11y): 提升辅助文字对比度至 WCAG 标准，修表头硬编码旧色
- `25131b3` 11-19 fix(deadline): 期限计算归一到上海日历日，消除进程时区依赖
- `34402f2` 11-19 feat(matters): 信号条接入非诉服务期限（并更正一次误判）
- `024f7be` 11-19 feat(engagements): 接线委托管理区块（后端有、UI 无入口）
- `eafe02c` 11-19 feat(matters): 接线墨案 04 信号条（此前从未渲染）
- `96d8854` 11-19 feat(security,ops): 团队视图隔离墙提示 + 责任移交验证脚本跑通
- `15cfdcf` 11-19 feat(compliance,ui): 隔离墙知情标注、buffers 消除、修剩余 flake

## 归档与保全（14 个，其中 14 个改代码）

- `8eaf301` 11-20 fix(preservations): 解除/删除/续封保全此前完全没有审计留痕
- `754ba01` 11-20 fix(archive): 借阅在途去重改用行锁 + 统一 6 处 P2002 判断
- `822a457` 11-20 fix(archive): 归档号撞号时错误不可读 + 抽出 Prisma 错误判定助手
- `415b26f` 11-20 refactor(roles): roleMutation 加 atomic 选项，修掉「内置岗位无事务」的根因
- `b4e7e3f` 11-20 fix(test): 删掉保全续封测试里未使用的 uid（部署 eslint 守卫第三次拦下）
- `57326da` 11-20 fix: 保全续封并发丢失续期（P1）+ 通知操作静默失败（P2）
- `2eb4b6f` 11-20 test(authz): 归档借阅的时效判定真库验证（唯一绕过常规权限的读取通道）
- `444ee36` 11-19 test(security): 隔离墙写路径补真库行为验证（101 处影响的底座）
- `c3576f3` 11-19 chore(archive): 删除两个过时的清单函数，并纠正我上轮的误判
- `421c146` 11-19 fix(security)!: 隔离墙在写路径底座一刀切，扩散面排查全部闭合
- `6a03338` 11-19 fix(security): 文档写路径接上隔离墙，并排查扩散面
- `99e9e7c` 11-19 perf(archive): 待审归档查询下推数据库，去掉全表 JSON 解析
- `3be91f5` 11-19 fix(storage): 存储读取异常统一转 ActionError，审批人不再看到乱码
- `b8ef0b3` 11-19 test(preservation,archive): 补 91 例测试，修孤儿保全沉默失效

## 短信与AI（5 个，其中 5 个改代码）

- `f3401d6` 11-20 fix(sms): 并发分析同一文件会落两批相同的整理建议（P2）
- `d71a0ff` 11-20 fix(sms): 一键生成开庭/期限在并发下会重复创建（P2）
- `274a3ca` 11-19 fix(sms): 文书日期补月日回验，全仓日期解析路径闭合
- `9fda91c` 11-19 fix(sms)!: 短信日期不再静默滚动——错误日期会直接进案件数据
- `978fb13` 11-19 fix(security)!: AI 外发与材料下载接上隔离墙——两处 P0 泄露面

## 权限与隔离（18 个，其中 18 个改代码）

- `84ece1f` 11-20 test(permissions): 钉住「不泄露案件存在性」这条安全性质
- `bb5f84a` 11-20 test(authz): hasHandledApproval 的 JSON 附件关联真库验证
- `a65a103` 11-20 test(authz): approvalContextFor 六种 action 的 requesterId 取值（真库）
- `cfcc523` 11-20 test(authz): canApproveContext 六层判定的真库验证
- `d155559` 11-20 perf(search): 权限判定的三项共享数据也纳入预取（380 → 106 次查询，-72%）
- `e8f9a16` 11-20 perf(search): 全局搜索的逐条权限判定改为批量预取（P1-2）
- `51fc937` 11-20 fix(auth): 登录失败锁定永远返回 0（真库测试抓到的 P2）
- `91e92aa` 11-20 test(auth): 补 TOTP 动态码错误分支的测试（多智能体审计 A-4）
- `3526e04` 11-20 fix(ui): 自确认开关不显示状态（P1）+ 三处 CSS token 用错
- `a3a2145` 11-19 test(security): 补 getWorkBoard 墙测试；修正两处「假变异验证」
- `5e4bae0` 11-19 test(security): 补三个零测试墙入口的验证（修正上一轮的过度概括）
- `a212d4f` 11-19 test(security): 权限断言层补 9 例真库墙验证
- `d1325f7` 11-19 fix(security): 审批工作台的记录可见性接上隔离墙
- `2541f3b` 11-19 chore(security): 删除 3 个零调用的权限断言
- `550ac7c` 11-19 fix(security)!: 报表导出接上隔离墙，隔离墙扩散面排查闭合
- `c4f1790` 11-19 fix(perm)!: 修复我引入的首页白屏——isManager 拆到客户端安全模块
- `e4d84bb` 11-19 fix(auth): 公开确认页被 middleware 拦截导致客户无法访问
- `5e3a473` 11-19 feat(auth): OIDC 单点登录（P2-2 前半）

## 客户与文档（8 个，其中 8 个改代码）

- `c89d879` 11-20 fix(clients): 并发编辑联系人会留下两批（P2）
- `be703e0` 11-20 fix(documents): 材料新版本上传失败会让整族失去 isLatest（P1）
- `98b436b` 11-19 docs: 新增零引用导出清单（97 个），并核实不是安全风险
- `5b72651` 11-19 refactor(enums): 统一两处手写的案件类别标签，消除三种叫法
- `a4a5f04` 11-19 fix(compliance): 软删案件的材料不再可下载；有审核记录的材料禁止硬删
- `8f7598c` 11-19 fix(privacy): 证件号明文不再进首屏，改为点编辑时按需拉取
- `d6973ca` 11-19 fix(privacy): 修复服务端/客户端边界错误，纯函数移入 lib/ui/mask
- `863502a` 11-19 fix(privacy): 敏感字段改为按需揭示并写审计（PIPL 合规）

## 测试与测试基建（8 个，其中 8 个改代码）

- `1a8a09d` 11-20 fix(evidence): 已归档案件仍可新增证据项（同「归档即冻结」漏网）
- `5244c1c` 11-20 refactor(seals): 用印流水号改用统一发号器（去掉未同步的副本）
- `67f38be` 11-20 fix(test): 删掉 handled-approval 测试里未使用的占位常量
- `8b2f0de` 11-20 test: 修掉一处恒真式测试与一处重复 mock（多智能体审计 A-14/A-15）
- `5f0599e` 11-19 fix(audit): 全图遍历让审计覆盖从 82% 提到 99.3%，并修掉 hash 误报根因
- `5ed7773` 11-19 fix(build): 修测试类型错误，恢复生产构建
- `14d7694` 11-19 fix(audit): 覆盖账口径修正 + 测试按修复后行为重写（1240 全绿）
- `15b2e08` 11-19 chore(clean): 删除遗留空壳组件，死代码清零

## 文档与台账（36 个，其中 10 个改代码）

- `d5d85c0` 11-20 docs(checklist): 新增 H 类「把刻意设计当缺陷」+ 性能实测口径
- `26a6b1a` 11-20 docs(checklist): 「同一意图多种写法」清单（6 类形态，写扫描器前必查）
- `4b88fcd` 11-20 docs: 测试数 1515→1530（上一轮 --fix 因并发跑测试拿不到数、拒绝写空值，符合三态设计）
- `7a93d63` 11-20 docs: 补上测试数 1497→1500（上次 --fix 未跑成，核对工具抓到）
- `ec6c6ad` 11-20 docs: 记录本轮部署遇 Alpine 拉包 TLS 失败（环境性，代码未受影响）
- `e7ca005` 11-20 docs: 补上搜索优化的真量化（上轮未能测出）
- `f751f61` 11-20 docs: 记录自确认开关的 CDP 点击验证（含点错 checkbox 的矫正）
- `901efb5` 11-20 docs(seals): 标注一处危险死代码；核实三项零引用导出的处置
- `e634bb9` 11-20 feat(admin): 提醒维护页加「立即推送周报」按钮（补上真缺的入口）
- `2072185` 11-19 docs: 误判模式补第 16/17 条，归类表同步（D 加 16、E 加 17）
- `1d3bd48` 11-19 docs: 同步台账数
- `53a0919` 11-19 docs: 同步台账数（check-doc-numbers.sh --fix）
- `72eaa05` 11-19 docs: 15 条误判模式按类型归类；修正一处无数据支撑的断言
- `3b256b8` 11-19 docs: 同步台账数（390），check-doc-numbers.sh 上线即抓到遗漏
- `f78f0b0` 11-19 docs: 重测审计索引性能，把 C 级结论换成可复现的数字
- `9588461` 11-19 docs: 给交付总览加证据等级声明，区分「自动测试」与「一次性实测」
- `9ac1797` 11-19 docs: 新增审计模式清单，把 82 轮踩过的坑整理成可复用检查表
- `675b36f` 11-19 docs(security): 通知不按隔离墙过滤——如实登记为已知限制
- `51b3fa4` 11-19 docs: 交付总览更新到 Round 78，新增三节阶段总结
- `2c4224c` 11-19 docs: 交付总览更新到 Round 69，四者一致性核对完成
- `c7527a4` 11-19 chore(concurrency): 完成多进程并发验证，确认无进程内状态
- `c247541` 11-19 fix(audit): 审计链卡片不再把「有分叉」说成「一条链」
- `1f20f99` 11-19 fix(build): 显式指定 turbopack.root，消除宿主 lock 干扰项目根的警告
- `0316da7` 11-19 chore: 核查表单防重复提交，并撤掉一个我造的假阳性检查
- `035f260` 11-19 docs: 交付状态总览更新到 Round 57
- `7eb8941` 11-19 docs(readme): 补开箱状态说明，并首次验证全新部署可行
- `0ef4b96` 11-19 docs: 交付状态总览，并逐项实测核对数字
- `c65db8a` 11-19 refactor(perm): 统一三处手写的 isManager，并确认一处「不一致」是有意设计
- `e59d55b` 11-19 feat(audit): 管理后台展示审计链完整性——算了但没人看见等于没算
- `d610c0b` 11-19 feat(audit): 校验结果翻成人话，运维看得到缺口从哪来
- `d0524a4` 11-19 docs(backlog): 业务链完整性审计结果（引用完整性 7 项全 0）
- `70692db` 11-19 style(a11y): 焦点环统一为品牌色（并纠正我自己的一个误判）
- `7f4672b` 11-19 chore(verify): 27 轮回归验证，并清理自己的测试污染
- `854c11d` 11-19 fix(audit): 校验器改为按链遍历，不再依赖 createdAt 排序
- `eb29190` 11-19 fix(data): 清洗企查查导入残留，法定代表人迁入结构化字段
- `992dd69` 11-19 docs: 记录团队视图隔离墙提示的真机验证缺口

## 其他（1 个，其中 1 个改代码）

- `9583a72` 11-19 fix(security): 工作台案件列表接上隔离墙；工时汇总补鉴权说明
