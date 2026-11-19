# LawLink 许可证审计报告（LICENSE AUDIT 2026-11-19）

| 项 | 值 |
|---|---|
| 审计对象 | LawLink `2.0.1`（`/Users/Jenner/Documents/律所CRM需求分析/oss-verify/LawLink`） |
| 审计类型 | 第三方开源许可证合规清查（分发前尽调用） |
| 审计日期 | 2026-11-19 |
| 审计方法 | 静态清单 + 逐包实读 + 部署镜像内实读 + 上游仓库联网核验 |
| 覆盖范围 | `package-lock.json` 内全部 **901** 个 `name@version`（生产 499 / 仅开发 402） |
| 配套文件 | `docs/THIRD-PARTY-NOTICES.md`（完整清单与声明载体） |
| 本轮改动 | **仅新增两份文档**，未改代码、未改 `package.json`、未改 `node_modules`、未重建镜像、未提交 git |

---

## 一、审计结论（一句话）

> **结论：可用。**
> 全部 901 个第三方组件均为可商用的宽松许可、文件级 copyleft 或经条件满足的弱 copyleft；
> **未发现 AGPL / SSPL / BUSL / CC-BY-NC / 纯 GPL / 「非商用」类许可**（0 项）；
> **无任何组件构成「不可用」**；存在 **6 个需处置风险项**，其中 1 项（`buffers@0.1.1` 无许可声明）须由法务定口径，其余 5 项为「补齐声明载体」类，不影响分发。

| 判定 | 组件数 | 说明 |
|---|---|---|
| **可用**（无附加义务，仅需保留声明） | **882** | MIT 706 / Apache-2.0 88 / ISC 52 / BSD 22 / 其它宽松 14（0BSD 2、BlueOak 8、CC0 2、Unlicense 1、Python-2.0 1） |
| **有条件可用**（须满足特定条件；条件已满足或可由文档补齐） | **19** | LGPL-3.0-or-later 14（动态链接，须附许可全文）+ MIT-OR-GPL 双许可 2（已择 MIT）+ MPL-2.0 1（未修改故无义务）+ CC-BY-4.0 1（须署名）+ 无许可声明 1（`buffers`，见 §四 P1-1） |
| **不可用**（禁止商用 / 强 copyleft 传染） | **0** | — |
| 合计 | **901** | 与 §三 分布表一致 |

> 分类口径：把「用即需履行特定义务」的组件计入「有条件可用」——弱 copyleft（LGPL）、文件级 copyleft（MPL）、须署名（CC-BY）、须择一（双许可）、须法务定口径（无声明）。「可用」一栏均为无需额外动作的宽松许可。

---

## 二、关键问题直接回答

### 2.1 是否存在禁止商用的许可证？

**没有。** 逐类扫描结果（`package-lock.json` 全文 + 901 个包的 `license` 字段 + 重点包 `LICENSE` 原文通读）：

| 类别 | 命中数 | 具体组件 |
|---|---|---|
| AGPL（任意版本） | **0** | — |
| SSPL | **0** | — |
| BUSL / Business Source License | **0** | — |
| Commons Clause | **0** | — |
| CC-BY-NC / 任何 NonCommercial 变体 | **0** | — |
| Elastic License / 其它「源码可见但禁商用」 | **0** | — |
| 纯 GPL-2.0 / GPL-3.0（非双许可、非 LGPL） | **0** | — |
| `UNLICENSED` / `SEE LICENSE IN` / Proprietary | **0** | — |

复现命令与输出见 §六。

### 2.2 风险项数量

| 等级 | 数量 | 是否阻断分发 |
|---|---|---|
| P1 须处置 / 须法务定口径 | **1** | 否（披露后可按现状分发） |
| P2 须补齐声明载体 | **2** | 否 |
| P3 记录即可 | **3** | 否 |
| **合计** | **6** | **阻断项 0** |

明细见 §四。

---

## 三、许可证分布（实测）

| 许可证家族 | 组件数 | 生产 | 开发 | 判定 |
|---|---|---|---|---|
| MIT（含 MIT-0 / MIT/X11 / MIT AND ISC / MIT AND Zlib） | 706 | 350 | 356 | 可用 |
| Apache-2.0 | 88 | 68 | 20 | 可用（须留 NOTICE、标注修改；本项目未修改） |
| ISC | 52 | 44 | 8 | 可用 |
| BSD（2-Clause / 3-Clause / BSD） | 22 | 11 | 11 | 可用（3-Clause 含「不得背书」条款） |
| MPL-2.0 | 1 | 0 | 1 | 有条件可用（文件级 copyleft，未修改故无义务） |
| LGPL-3.0-or-later | 14 | 14 | 0 | 有条件可用（动态链接，见 §四 P2-1） |
| 其他（0BSD / BlueOak / CC0 / Unlicense / Python-2.0 / CC-BY-4.0 / 双许可 / 无声明） | 18 | 12 | 6 | 逐项见 §四 |
| **合计** | **901** | **499** | **402** | — |

计数口径：`name@version` 去重；`dev` 标记取自 `package-lock.json`（可从 `dependencies` 到达即为生产）。

---

## 四、风险项与处置建议

### P1-1 `buffers@0.1.1` —— 无许可证声明（唯一实质风险）

**实测事实**：

| 检查项 | 结果 | 证据来源 |
|---|---|---|
| `package.json` `license` 字段 | 字段**不存在** | `cat node_modules/buffers/package.json`（全文见下） |
| 包内许可文本 | **无**（仅 `README.markdown`/`index.js`/`package.json`/`examples/`/`test/`） | `ls -la node_modules/buffers` |
| README 中许可段落 | **无**（已通读全文，只有用法与 API） | `cat node_modules/buffers/README.markdown` |
| npm 注册表元数据 | 无 `license` 键；0.1.1 发布于 2011-10-12，维护者 `substack` | `npm view buffers --json` |
| 上游仓库 | `github.com/substack/node-buffers` → **HTTP 404**（本次自行联网核验，非引用他人结论） | `web_fetch` 返回 404 页 |
| 依赖链 | `lawlink → exceljs@4.4.0 → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1` | `npm ls buffers` |
| 是否进镜像 | **是**（`/app/node_modules/buffers`） | `docker run … ls node_modules/buffers` |
| 代码规模 | `index.js` 7,057 字节；唯一使用者 `binary@0.3.0` 自身声明 MIT | 文件实读 |

`package.json` 原文（逐字）：

```json
{
    "name" : "buffers",
    "description" : "Treat a collection of Buffers as a single contiguous partially mutable Buffer.",
    "version" : "0.1.1",
    "repository" : "http://github.com/substack/node-buffers.git",
    "author" : "James Halliday <mail@substack.net> (http://substack.net)",
    "main" : "./index",
    "scripts" : {
        "test" : "expresso"
    },
    "engines" : {
        "node" : ">=0.2.0"
    }
}
```

> 上段为 `node_modules/buffers/package.json` 的逐字复制（未做任何改写）：确认**无 `license` 字段**、无 `licenses` 字段、无 `files`/`homepage`。

**风险性质**：无许可声明在著作权法上默认「保留所有权利」，严格解释不构成分发授权。这是本次审计**唯一**需要法务给口径的点。

**处置建议**：

1. **本轮已做（披露）**：在 `THIRD-PARTY-NOTICES.md` §7.1 单列该组件、来源、链上位置、作者署名与「无许可声明」事实；清单正文亦保留其包名与版本。
2. **建议后续批次（需改 `package.json`，本轮无授权，未执行）**：从依赖树消除该包。可行路径——`exceljs@4.4.0` 经 `unzipper` 使用它；可用 `overrides` 把 `unzipper` 提升到不再依赖 `binary → buffers` 的版本，或评估 `exceljs` 的 xlsx 读写是否可走 `jszip` 路径。**须独立立项并跑全量测试**（当前基线 793 全绿不容破坏）。
3. **法务口径问题（需人工回答）**：一个 2011 年发布、无声明、作者仓库已消失的 30 行工具库，是否按「低风险容忍 + 披露」处理？若不接受，即执行第 2 条。

### P2-1 `@img/sharp-libvips-*` —— LGPL-3.0-or-later，动态链接（14 个变体）

**实测事实**：

- 14 个条目全部 `LGPL-3.0-or-later`：10 个纯 LGPL 的 `@img/sharp-libvips-{platform}@1.3.4`，加 3 个 Windows 变体与 1 个 wasm 变体的组合式声明（`Apache-2.0 AND LGPL-3.0-or-later`、`Apache-2.0 AND LGPL-3.0-or-later AND MIT`）。
- 部署镜像（`node:22-alpine`，musl + arm64）内实际安装的是 `@img/sharp-libvips-linuxmusl-arm64@1.3.4`；形态为**独立共享库文件**：
  `/app/node_modules/@img/sharp-libvips-linuxmusl-arm64/lib/libvips-cpp.so.8.18.7`（18,712,760 字节）。
- 加载方式：由 `sharp@0.35.5` 通过 N-API 运行时加载——**未静态链接、未编入 LawLink 产物、未修改源码**。
- **该包内不带 `LICENSE` 文件**（镜像内实测：目录仅有 `README.md`、`lib/`、`package.json`、`versions.json`）→ LGPL 全文必须由本项目补齐。

**判定**：属 LGPL 明确允许的「动态链接 + 可替换库」形态，**不传染** LawLink 的 MIT 代码；但 LGPL-3.0 要求随分发提供许可证副本并提供可重链接条件。

**处置建议**：

1. 发行物内附 **LGPL-3.0 全文**（建议 `docs/licenses/LGPL-3.0.txt`，本轮因授权范围限制未创建，见 §七 未做项）。
2. 发布说明中写明替换方式（镜像内替换上述 `.so` 后重启容器即可），满足「可重链接」。
3. `sharp`／libvips 升级不引入源码修改，义务不变。
4. 若法务要求彻底规避 LGPL 讨论，可评估自制 libvips 构建或替换图像库——产品决策，超出本轮。

### P2-2 `caniuse-lite@1.0.30001810` —— CC-BY-4.0 署名义务

- 链：`lawlink → next@16.4.6 → caniuse-lite`（生产）；另经 `autoprefixer → browserslist`（开发）。
- CC-BY-4.0 允许商用，**须署名**。`THIRD-PARTY-NOTICES.md` §5.5 已列明并给出建议署名句，随分发即满足。
- 该包自带 `LICENSE`，随分发包保留。

### P3-1 `axe-core@4.11.4` —— MPL-2.0（仅开发依赖）

- 链：`lawlink → eslint-config-next@16.4.6 → eslint-plugin-jsx-a11y@6.10.2 → axe-core@4.11.4`（`npm ls` 实测）。
- 未修改 → MPL 无源码公开义务；保留声明即可。
- **附带发现（与任务书假设不符，见 §五）**：任务书提到的另一个 MPL 组件 `lightningcss` **在本项目中不存在**。

### P3-2 `jszip@3.10.1` / `pizzip@3.2.0` —— MIT OR GPL 双许可，已择 MIT

- 两包 `LICENSE.markdown` 首段均明确：「dual licensed. At your choice you may use it under the MIT license *or* the GPLv3 license」——双许可由被许可方择一。
- **本项目明确选择 MIT 分支**，GPL 义务不产生。链：`jszip` 经 `docx`/`exceljs`/`mammoth`；`pizzip` 为直接依赖（`docxtemplater` 使用）。
- 建议在发布说明保留一句「JSZip / PizZip 采用 MIT 分支」，避免尽调方看到 GPL 字样反复问询。

### P3-3 组合式宽松许可（记录即可）

| 组件 | 声明 | 影响 |
|---|---|---|
| `pako@1.0.11` / `pako@2.1.0` | `(MIT AND Zlib)` | 同时满足 MIT 与 Zlib 要求；二者均宽松，保留声明即可 |
| `victory-vendor@36.9.2` | `MIT AND ISC` | 两份声明均需保留（该包**不带许可文件**，靠本清单承载） |
| `argparse@2.0.1`（仅开发） | `Python-2.0` | 宽松、可商用，保留声明 |
| `chainsaw@0.1.0` / `traverse@0.3.9` | `MIT/X11` | 与 MIT 等价 |
| `duck@0.1.12` | `BSD`（未标版本号） | 按 BSD 处理；该包**不带许可文件** |
| `big-integer@1.6.52` | `Unlicense` | 公共领域奉献，无义务；**不带许可文件** |
| `tslib@1.14.1` / `tslib@2.8.1` | `0BSD` | 零条款，无义务 |
| `BlueOak-1.0.0`（8 个，含生产 `jackspeak`/`minipass`/`path-scurry`/`package-json-from-dist`/`sax@1.6.0`） | 无限制式宽松许可 | 可商用，无署名要求 |
| `CC0-1.0`（`language-subtag-registry`、`mdn-data`，均开发） | 公共领域奉献 | 无义务 |
| `nodemailer@10.6.0`、2 个 `@csstools/*` | `MIT-0` | 免署名 MIT | 

### P3-4 声明载体缺口（32 个生产包不带许可文件）

实测 784 个已安装组件中 **47** 个包目录内不含任何 `LICENSE`/`COPYING`/`NOTICE` 文件（生产 32 个）。这些包的许可信息仅存在于 `package.json` 的 `license` 字段，因此 **`THIRD-PARTY-NOTICES.md` §6 是它们的补充声明载体**。处置：随分发附该清单即满足「保留声明」义务；其中 `@img/sharp-libvips-*` 另需 LGPL 全文（P2-1）。

---

## 五、与任务书前提不一致之处（如实报告）

审计以**实测**为准，以下三处与任务给定的前提不同，据实更正：

| # | 任务书前提 | 实测结果 | 影响 |
|---|---|---|---|
| 1 | 「约 671 个」包 | **901** 个 `name@version`（生产 499 / 仅开发 402）；本机 `node_modules` 865 个包目录、784 个唯一 `name@version`；部署镜像内 878 个包目录、785 个可解析 `name@version` | 数量口径不同。671 可能取自其他口径（如仅生产 + 去重名，实测生产唯一包名 461）。清单按**实测 901** 出 |
| 2 | `lightningcss`（MPL-2.0）为已知风险项 | **本项目不存在该包**。`npm ls lightningcss` → `(empty)`；`package-lock.json` 中 2 处命中仅为 `next` 的可选 `peerDependenciesMeta` 声明，未安装 | 无需处置；MPL 组件实际只有 `axe-core` 一个 |
| 3 | `buffers` 上游仓库 404 | **已独立复核确认**：`https://github.com/substack/node-buffers` 返回 **HTTP 404** | 前提成立，可写入尽调材料 |

补充事实（不在任务书内但影响分发范围）：

| # | 发现 | 证据 | 影响 |
|---|---|---|---|
| 4 | **部署镜像包含开发依赖** | `Dockerfile`：`deps` 阶段裸 `npm ci`（未设 `NODE_ENV=production`），`runner` 阶段整体 `COPY --from=builder /app/node_modules`；镜像内实测 `axe-core@4.11.4`、`typescript@5.9.3` 存在 | 分发包实际含 402 个「仅开发」组件；清单已按「全部」出具以免漏项。裁剪与否见 §六 |
| 5 | `shadcn/ui` 组件以源码形式内嵌 | `src/components/ui/` 20 个文件，采用 shadcn 惯例（`cva` + `cn` 来自 `@/lib/utils` + Radix `Slot`）；**代码内无上游版权头** | shadcn/ui 为 MIT，内嵌副本需保留声明。当前清单按 MIT 计入；建议在 `src/components/ui/` 或 README 增加一行来源署名（本轮无授权改代码，未执行） |

---

## 六、建议纳入后续代码批次的改动（本轮不做，需主控授权）

| 优先级 | 改动 | 理由 | 风险 |
|---|---|---|---|
| P1 | 消除 `buffers@0.1.1`（`overrides` 或换解压实现） | 唯一无许可声明组件 | 触碰 `package.json`，需全量回归 793 测试 |
| P2 | 随发行物附 `docs/licenses/LGPL-3.0.txt` 全文 | 上游 libvips 包不带许可文本 | 纯新增文件，无风险 |
| P2 | 发布说明补 libvips 替换指引 + caniuse-lite 署名句 | 满足 LGPL 可重链接 + CC-BY 署名 | 文档改动 |
| P3 | `Dockerfile` 改为 `npm ci --omit=dev`（或 `prune`）+ 保留构建期 devDeps | 镜像体积与合规面同时收窄（可减少 402 个包的声明义务） | 需实测 `next start` 与 Prisma 引擎、`sharp` 是否仍可用；属部署链改动，须单独验证 |
| P3 | `src/components/ui/` 增加 shadcn/ui 来源署名 | 内嵌 MIT 代码的声明义务 | 注释级改动 |
| P3 | 发布检查单加入「重跑许可清单命令」 | 依赖变更后清单会过期 | 文档改动 |

---

## 七、未做 / 未覆盖（如实声明）

1. **未创建 `docs/licenses/LGPL-3.0.txt`**：本轮授权仅限两个文档文件，LGPL 全文属新增第三个文件，留给后续批次。
2. **未做法律意见**：本报告是工程侧合规清查，LGPL 与 `buffers` 的最终口径须由法务确认。
3. **未逐包通读全部 901 个 `LICENSE` 原文**：采用的是「`license` 字段 + 文件存在性 + 重点包通读」策略。重点通读的包：`jszip`、`pizzip`（双许可判定依据）、`buffers`（README 全文）、`axe-core`（License 存在性）、`@img/sharp-libvips-*`（文件清单）。其余包以 SPDX 标识为准；若尽调要求逐份核验正文，需另开工作量。
4. **未审计非 npm 依赖**：Alpine 基础镜像（`node:22-alpine`）内的系统包（`bash`、`postgresql16-client`、`openssl`、`libc6-compat`）许可未纳入本清单。Alpine 包普遍为 MIT/BSD/GPL 混合，**若尽调要求覆盖容器基础层，需单独出一份 Alpine 包清单**（本轮未做，需运行 `apk info` 采集）。
5. **未审计 `prisma` 引擎二进制**：`@prisma/client` 的 query engine 为 Apache-2.0 声明（已在清单内），但其下载的二进制引擎文件未单独核验（同属 Apache-2.0 发行物）。
6. **未改任何代码/配置**：因此未产生新的测试需求；基线测试结果见 §八。

---

## 八、验收证据

### 8.1 依赖规模（实测）

```
# 唯一 name@version（lockfile）       : 901   （生产 499 / 仅开发 402）
# 唯一包名                            : 810   （生产 461 / 其余仅开发）
# 本机 node_modules 包目录           : 865 个目录 → 784 个唯一 name@version
# 部署镜像内                          : 878 个包目录 → 785 个可解析 name@version
# 镜像内 node_modules 顶层条目        : 546
```

### 8.2 许可证分布（实测，`license` 字段原值统计）

```
 698  MIT                      88  Apache-2.0            52  ISC
  13  BSD-2-Clause             10  LGPL-3.0-or-later      8  BlueOak-1.0.0
   8  BSD-3-Clause              3  MIT-0                  3  Apache-2.0 AND LGPL-3.0-or-later
   2  MIT/X11                   2  CC0-1.0                2  (MIT AND Zlib)
   2  0BSD                      1  Apache-2.0 AND LGPL-3.0-or-later AND MIT
   1  Python-2.0                1  MPL-2.0                1  Unlicense
   1  （无 license 字段）        1  CC-BY-4.0              1  BSD
   1  (MIT OR GPL-3.0-or-later) 1  (MIT OR GPL-3.0)       1  MIT AND ISC
```

### 8.3 禁止商用许可扫描

```bash
$ grep -o -i -E "AGPL|SSPL|BUSL|Commons Clause|CC-BY-NC|Elastic License|noncommercial|NonCommercial" package-lock.json | sort -u
（无输出）
```

### 8.4 关键核验命令与结果

| 命令 | 结果 |
|---|---|
| `grep -c lightningcss package-lock.json` | 2（均为 `next` 的 `peerDependenciesMeta` 可选声明） |
| `npm ls lightningcss` | `└── (empty)` —— 未安装 |
| `npm ls buffers` | `lawlink → exceljs@4.4.0 → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1` |
| `npm ls axe-core` | `lawlink → eslint-config-next@16.4.6 → eslint-plugin-jsx-a11y@6.10.2 → axe-core@4.11.4` |
| `npm ls jszip` | `docx@9.6.1 / exceljs@4.4.0 / mammoth@1.12.0 → jszip@3.10.1` |
| `npm ls caniuse-lite` | `next@16.4.6`（生产）+ `autoprefixer@10.5.0`（开发） |
| `head -3 LICENSE` | `MIT License` / `Copyright (c) 2026 叶森 (Sen Ye)` |
| `docker run … ls node_modules/@img` | `colour / sharp-libvips-linuxmusl-arm64 / sharp-linuxmusl-arm64 / sharp-wasm32` |
| `docker run … ls -l …/lib/*.so*` | `libvips-cpp.so.8.18.7` 18,712,760 字节 |
| `docker run … axe-core license` | `4.11.4 MPL-2.0`（证实镜像含开发依赖） |
| `web_fetch github.com/substack/node-buffers` | HTTP 404 |

### 8.5 基线测试（确认本轮未破坏任何东西）

本轮为纯文档新增（未触碰 `src/`、`prisma/`、`package.json`、`node_modules`），仍跑了一次全量测试作为基线证明：

```bash
cd /Users/Jenner/Documents/律所CRM需求分析/oss-verify/LawLink
set -a && . ./.env && set +a
export DATABASE_URL="postgresql://lawlink:lawlink_dev_2026@localhost:55432/lawlink?schema=public"
npx vitest run
```

```
 Test Files  105 passed (105)
      Tests  793 passed (793)
   Start at  07:52:14
   Duration  10.93s
```

→ **793/793 全绿，与任务给定的基线一致。**


### 8.6 产出文件

| 文件 | 大小 | 说明 |
|---|---|---|
| `docs/THIRD-PARTY-NOTICES.md` | 约 81 KB | 901 个组件完整清单 + 本项目 MIT 声明 + 合规履行声明 + 风险项处置 + 复核命令 |
| `docs/LICENSE-AUDIT-20261119.md` | 本文件 | 审计结论、风险项、与前提不一致处、后续建议、验收证据 |

---

## 九、结论汇总（给主控/法务的一页纸）

1. **能不能分发？** 能。0 个禁止商用许可，0 个不可用组件。
2. **必做动作？** ① 分发时随附 `LICENSE` + `THIRD-PARTY-NOTICES.md`；② 补 LGPL-3.0 全文；③ 发布说明加 caniuse-lite 署名句。
3. **唯一需要人拍板的事？** `buffers@0.1.1` 无许可声明——接受「披露 + 低风险容忍」，还是走「消除依赖」（需改 `package.json` + 全量回归）。
4. **最大意外发现？** 部署镜像里实际打包了 402 个开发依赖（含 MPL 的 `axe-core`、`typescript`），扩大了合规面但不构成违规。
5. **任务书的两处前提不成立**：`lightningcss` 不存在；包数不是 671 而是 901。

---

## 更新（2026-11-19 晚）：buffers 已消除，法务风险项清零

### 处置动作

原 P1 风险项 `buffers@0.1.1`（无 license 字段、上游 `github.com/substack/node-buffers` 已 404）
的成因是依赖链：

```
lawlink → exceljs@4.4.0 → unzipper@0.10.14 → binary@0.3.0 → buffers@0.1.1
```

处置方式不是自研替代，而是**升级中间层**：`unzipper@0.12.5` 已移除 `binary` 依赖，
整条链上的 `buffers` 随之消失。

```json
// package.json
"overrides": { "unzipper": "^0.12.5" }
```

### 验证

| 项 | 结果 |
|---|---|
| `npm ls buffers` | `(empty)` —— 已移除 |
| `npm ls unzipper` | `exceljs@4.4.0 → unzipper@0.12.5`（无 binary） |
| 全量依赖重扫（715 包） | **未知 / AGPL / SSPL / CC-BY-NC / UNLICENSED：0 个** |
| exceljs 真实读写 | 生成模板 8674 字节 → 读回 15 列（含「案号」）→ 写入再读回一致 |
| 测试套件 | 110 files / 863 tests 全绿 |

跨版本风险已实测排除：exceljs@4.4.0 在 unzipper@0.12.5 下 xlsx 解压、读取、写入均正常。

### 结论

**许可证层面已无任何阻断项**（原「无条件可用 / 19 有条件可用 / 0 不可用」中的 1 个 P1 已消除）。
剩余仅有需声明事项（LGPL 的 sharp-libvips、MPL 的 axe-core、CC-BY-4.0 的 caniuse-lite），
均由 `THIRD-PARTY-NOTICES.md` 承担声明义务。
