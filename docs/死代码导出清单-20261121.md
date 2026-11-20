# 零引用导出清单（2026-11-21）

> 用途：记录**全仓零引用**的导出，供后续审计与清理决策。
> 结论先行：**这些都不是缺陷，也不是安全风险**——见下方「为什么留着」。
> 生成本清单的判定方法写在最后一节，可复现。

## 统计

```
src/ 下导出总数        1559
其中零引用              97
  ├─ 'use server' 文件    50   ← Server Action
  └─ 其他文件             47
```

## 为什么不删

**三条理由，按重要性排：**

1. **AGENTS.md 明文：「效果图未画到的旧模块须归位不得删除」。**
   本项目有过先例：`Matter.serviceStatus` 字段与 `completeMatterService`
   保留下来、无 UI 入口即不生效，等将来统计确需区分时再启用。

2. **零引用 ≠ 零风险，也 ≠ 零价值。**
   删掉要重写；留着只是"看起来还活着"，会误导审计。
   **代价是认知成本，收益是可复用**——加标注比删掉更平衡。

3. **Server Action 零 UI 但仍可 RPC 调用。**
   所以判断"能不能删"之前必须先看**有没有权限守卫**——
   不能因为"没人用"就假设"没风险"。

## 已核实有完整权限守卫的（不是安全风险）

抽了 6 个最像风险的（删除类）：

| action | 守卫 | 备注 |
|---|---|---|
| `deleteTask` | `requireSession("schedule.write")` + `assertCanAssociateMatter` + `assertMatterWritable` | **且在责任面板模式下直接拒绝**："请在事项责任面板取消任务并填写原因，原记录保留" —— 这是有意保留的兼容入口，不是遗漏 |
| `softDeleteClient` | `requireSession("clients.write")` + 角色检查 + `assertCustomClientWrite` | 权限齐全，只是无 UI |
| `deleteContact` | `requireSession("clients.write")` + 角色检查 + `assertCustomClientWrite` | 同上 |

**结论：这些是「可达但未接线」，不是「可达且无防护」。**

## 已加标注的

| 位置 | 内容 |
|---|---|
| `src/server/document-folders/actions.ts` | 文件头已注明「当前无 UI 入口，6 个 action 零引用，保留待接线」 |

## 待处理清单（按模块）

### Server Action（50 个）

| 模块 | 数量 | 说明 |
|---|---|---|
| `document-folders/actions.ts` | 6 | ✅ 已标注 |
| `seals/actions.ts` | 3 | **已逐个核实（2026-11-21）**：<br>`getSealApprovalCapabilities` **⚠️ 危险死代码** —— 不查真实权限就直接 `return { canApprove: true, canViewFirmQueue: true }`。零引用下无害，但将来谁拿它做守卫等于绕过用印审批。已在源码加警告注释，**启用前必须重写**。<br>`getSealRequest` 功能对但低效（拉全量再 find），已加注释说明接线时应改写法。<br>`getSealStats` 是旧版用印独立页的遗留统计；用印已整合进 `/approvals?type=SEAL_APPROVE`，那里有通用统计（待我审批/我已处理/我的申请），**专项统计判定不需要** |
| `cron/manual-triggers.ts` | 2 | `triggerWeeklyReportNow` / `triggerAuditCleanupNow`。<br>**已核实：两个都有 `requireAdmin()` 守卫**，不是安全风险。<br>**`triggerWeeklyReportNow` 已接线（2026-11-21）**：管理后台提醒维护页「邮件通道」卡片新增「立即推送周报」按钮（`weekly-push-button.tsx`），SMTP 未配置时 disabled 并提示原因。<br>**`triggerAuditCleanupNow` 仍无 UI**：审计清理是纯运维动作，cron 每日 03:10 自动跑，手动触发价值低，**判定不需要 UI**（不是遗漏） |
| `sms/actions.ts` | 2 | `getSmsMessage` / `parseDateString` |
| `clients/actions.ts` | 2 | `softDeleteClient` / `deleteContact` |
| 其余 | 35 | 未逐个核实 |

### 其他（47 个）

| 位置 | 例 |
|---|---|
| `lib/enums.ts` | `matterServiceStatusLabel`（serviceStatus 无 UI，label 自然没人用） |
| `lib/ui/moan-tones.ts` | `countdownTone` / `countdownLabel` / `approvalActionTone` |
| `lib/storage/*` | `getStorageProvider` / `deleteStoredFile` |
| `components/dashboard/alerts-list.tsx` | `AlertsList` |
| 其余 | 未逐个核实 |

**注意**：`app/confirm/[token]/page.tsx` 的 `dynamic` 是 Next.js 框架约定的导出（`export const dynamic = ...`），**不是死代码**——这类框架约定必须排除。

## 判定方法（可复现）

```bash
# 1) 列出所有导出
rg -l "^export (async )?(function|const) " -g '*.ts' -g '*.tsx' -g '!*.test.*' src/

# 2) 对每个名字统计全仓引用（含 src/tests/），排除定义行本身
rg -n "\bNAME\b" -g '*.ts' -g '*.tsx' src/

# 3) 必须排除的假阳性
#    - export const dynamic / revalidate / metadata（Next.js 约定）
#    - 被 re-export 的（export { x } from）
#    - 只在注释里出现的（看具体行内容，不能只看文件命中）
```

## 下一步

1. **不建议一次性清理**。真要清理，按模块分批：先 `document-folders`（已标注）、
   再 `seals`、`cron/manual-triggers`（这两个可能是漏接线，值得先查是不是忘接了）。
2. 每个模块清理前**先确认不是漏接线**——`triggerWeeklyReportNow` 这类
   "管理后台手动触发"如果真没人调，可能是 UI 漏了按钮而不是后端多余。
3. 清理时必须 `rg` 三遍：全仓、测试、注释。
