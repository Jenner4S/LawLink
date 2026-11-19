# LawLink 备份与恢复演练报告（2026-11-19）

> 演练目标：证明「备份是可用的」——不只是备份文件存在，而是**能从备份把库恢复出来、数据一致、审计链仍然成立、耗时可控**。
> 演练方式：真实执行（容器内跑 `scripts/backup.sh` → 独立临时库 `pg_restore` → 逐表比对 → 审计链校验 → DROP 清理）。
> 本文只记录实测结果；未实测的内容在「未覆盖」里如实标注。

---

## 0. 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| **数据库备份是否可用** | ✅ **可用**。dump 可读（`pg_restore --list` 770 项）、可完整恢复（87/87 表）、行数与内容一致、审计链在恢复库校验通过、审计防删触发器随备份保留 | §5、§6、§7 |
| **文件（附件/模板）备份是否可用** | ❌ **本环境不可用**：容器内 `/app/storage` 为 0 文件，`storage.tar.gz` 只有 102 B（空目录），而 `Document` 表 22 行指向的 22 个 `.bin` 实际在**宿主** `storage/` 下 | §8 P0-1 |
| **RTO 实测（数据库）** | **1.06 s**（建库 0.09 + 恢复 0.80 + 校验 0.08）；用 `restore.sh` 全流程 1.28 s | §7 |
| **RPO（当前配置）** | 每日 02:30 自动备份一次 → 最坏丢失 24 小时；实测自动链路确实跑过（`DATABASE_BACKUP_CRON` 审计 18:30） | §3.3 |
| **演练是否留垃圾** | 无：临时库已 `DROP`，容器 `/tmp` 中间文件已删 | §9 |

**一句话**：数据库这一侧，备份是真的能恢复的；文件这一侧，现在的备份包里是空的——这是本次演练最重要的发现。

---

## 1. 环境

| 项 | 值 | 采集方式 |
|---|---|---|
| 宿主 | macOS 27.0.1 / arm64（Apple Silicon） | `sw_vers -productVersion`、`uname -m` |
| Docker | 29.9.3 (build 5457199) | `docker --version` |
| 应用容器 | `lawlink-app`，镜像 `sha256:a591eecb40b378da2d5bc8a7037b99347d3504aab9cf9b92beba7918bbd3959e`，构建于 2026-11-18T16:07:09Z | `docker inspect` |
| 应用镜像基底 | `node:22-alpine` runner 阶段，`apk add --no-cache bash postgresql16-client openssl`（`Dockerfile` L40） | `grep Dockerfile` |
| 数据库容器 | `lawlink-db`，镜像 `postgres:16-alpine`（`sha256:dc638cdf…`） | `docker inspect` |
| PostgreSQL | **16.16**（aarch64-unknown-linux-musl） | `select version()` |
| 客户端工具 | 容器内 `pg_dump` / `pg_restore` / `psql` 均为 **16.16**，`bash` 在 `/bin/bash` | `docker exec lawlink-app sh -c 'which pg_dump bash psql pg_restore'` |
| 库大小 | `lawlink` = **15,268,887 B（15 MB）** | `pg_database_size('lawlink')` |
| 表数量 | public schema **87 张表**，合计 **2,151 行** | `pg_tables` + 逐表 `count(*)` |
| 模式对象 | 索引 300 / 外键 188 / CHECK 25 / 触发器 10 / 函数 5 / 枚举 89 | `pg_indexes`、`pg_constraint`、`pg_trigger`、`pg_proc`、`pg_type` |
| 迁移 | 5 条全部 applied：`0_init`、`20260921000004_archive_borrow`、`20260921000005_restore_db_guards`、`20261118000001_audit_chain`、`20261118000002_time_entry` | `_prisma_migrations` |
| 关键数据量 | Client 11 / Matter 7 / Party 14 / User 9 / AuditLog 68（23 条有链摘要，45 条历史记录无摘要）/ TimeEntry 0 / RateSchedule 0 | 逐表 `count(*)` |

> 说明：`TimeEntry` / `RateSchedule` 已建表但为空——P0-1 阶段 1-a 只落了 schema 与服务层，UI 尚未产生数据，与台账记录一致。

---

## 2. 备份能力核查（读代码 + 查容器）

### 2.1 脚本清单

| 文件 | 作用 | 关键事实 |
|---|---|---|
| `scripts/backup.sh`（3657 B） | pg_dump + storage 打包 + manifest +（可选）openssl 加密 | `set -euo pipefail`；`--format=custom --compress=6`；读 `DATABASE_URL` 与 `APP_STORAGE_DIR`；`BACKUP_PASSPHRASE` 存在时 AES-256-CBC 加密并删除明文 |
| `scripts/restore.sh`（1898 B） | `pg_restore --clean --if-exists --no-owner` + 解包 storage | 交互式 `read -p "确认继续？(输入 YES)"` |
| `src/server/cron/jobs/backup-database.ts` | 每日 02:30 调度备份 + 保留 14 份 + 失败通知超管 + 写审计 | `preflightBackup()` 逐项自检：脚本可读 / `bash` 可用 / `pg_dump --version` 成功 / 备份目录可写；`BACKUP_TIMEOUT_MS` = 10 min；`BACKUP_KEEP` 默认 14；只清理 `^\d{8}_\d{6}$` 目录 |

### 2.2 输出位置与命名规则

- 目录：`BACKUP_DIR`，默认 `<cwd>/backups`；compose 下挂命名卷 `lawlink_backups` → `/app/backups`（`docker-compose.yml`）。
- 子目录名：`date +%Y%m%d_%H%M%S` → **UTC 时间**（容器时区为 UTC，与宿主 CST 差 8 小时）。
- 每个备份目录固定三个文件：`database.dump`（custom 格式）、`storage.tar.gz`、`manifest.json`。

### 2.3 自动备份链路已验证（不是"配了就算"）

容器卷内已存在 `20261118_183000` 备份，且库中有对应审计：

```
action = DATABASE_BACKUP_CRON | createdAt = 2026-11-18 18:30:00.216 | detail {"keep":14,"removedOld":0}
```

即 02:30 UTC（= 宿主 02:30 相同命名口径）那次调度**真实执行过**并写了审计，保留策略生效（未删除）。

---

## 3. 备份执行（真实跑一次）

### 3.1 命令

```bash
docker exec -u nextjs lawlink-app bash -c \
  'BACKUP_ALLOW_PLAINTEXT=true bash /app/scripts/backup.sh /app/backups'
```

- 以运行用户 `nextjs` 执行（与 cron 调用的身份一致，能验证目录权限）。
- `BACKUP_ALLOW_PLAINTEXT=true`：本次演练未设 `BACKUP_PASSPHRASE`，显式接受明文物，避免脚本的明文警告干扰输出解析（该默认值本身是 §8 P1-2 的问题）。

### 3.2 输出与耗时

```
=== LawLink 备份 20261118_234809 ===
数据库: lawlink@db:5432
存储目录: /app/storage
[1/3] 导出数据库...
  数据库备份完成: 412.0K
[2/3] 打包文件存储...
  文件存储备份完成: 4.0K
[3/3] 写入元信息...
=== 备份完成 ===
路径: /app/backups/20261118_234809
总大小: 424.0K
```

- **墙钟耗时（含 `docker exec`）：0.22 s**（`/usr/bin/time -p` → `real 0.22`）。
- 会话标注：目录名 `20261118_234809` 是 **UTC**，对应宿主本地 `2026-11-19 07:48:09 +08:00`。

### 3.3 产物与校验

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `database.dump` | **421,617 B（411.7 KiB）** | `1cfc5fd4c1ac82620f6c0e57f5faaa6d5bbb53da9ea27d3f6ba50d8b2b6d5953` |
| `storage.tar.gz` | **102 B** | `6d363a0af1abaa376abbeec6c122322363aca2dd01435742441b6d24f9b73885` |
| `manifest.json` | 296 B | `82e169c19f021b0acb4a674105e461cdb2a49fc4b2aafbed61e3c2483334d3fb` |

**dump 可读性校验**（`pg_restore --list`）：

```
; Archive created at 2026-11-18 23:48:09 UTC
;     dbname: lawlink
;     TOC Entries: 770
;     Compression: gzip
;     Dump Version: 1.15-0
;     Format: CUSTOM
;     Dumped from database version: 16.16
;     Dumped by pg_dump version: 16.16
```

- 文件头 `50 47 44 4d 50`（`PGDMP`）+ `Dump Version 1.15-0`。
- `TABLE DATA` 条目 **87 个 = 生产 87 张表**，无漏表。
- `TRIGGER` 条目 **10 个**，含 `public AuditLog audit_log_no_delete`（审计防删触发器在备份里，§6.4 实测生效）。
- 索引/约束等条目合计 503 条。

**storage.tar.gz 内容**：`tar tzf` 只有一项 `storage/` —— **0 个文件**，见 §8 P0-1。

---

## 4. 恢复演练（真实恢复到独立临时库）

### 4.1 两条路径都测

| 路径 | 命令 | 目的 |
|---|---|---|
| A：直接 `pg_restore` | 见 §4.2 | 精确计时、可复现的最小路径 |
| B：项目自带 `scripts/restore.sh` | 见 §4.3 | 验证**交付给运维的那条脚本**本身可用 |

两条路径都恢复进临时库 `lawlink_restore_drill`（`CREATE DATABASE … TEMPLATE template0 OWNER lawlink`），**没有触碰生产库 `lawlink`**。

### 4.2 路径 A：计时分解

```bash
docker exec lawlink-db psql -U lawlink -d postgres -c "DROP DATABASE IF EXISTS lawlink_restore_drill;"
docker exec lawlink-db psql -U lawlink -d postgres -c "CREATE DATABASE lawlink_restore_drill OWNER lawlink TEMPLATE template0;"
docker exec lawlink-db pg_restore -U lawlink -d lawlink_restore_drill \
  --no-owner --no-privileges --single-transaction --exit-on-error /tmp/drill.dump
```

| 阶段 | 耗时 |
|---|---|
| DROP（若存在） | 0.091 s |
| CREATE DATABASE | 0.093 s |
| **pg_restore（全库 87 表）** | **0.798 s** |
| 行数校验（6 张关键表） | 0.075 s |
| **合计：从"开始恢复"到"可查询"** | **1.056 s** |

`pg_restore` 退出码 0、无任何 WARNING/ERROR（`--exit-on-error` 生效）。

### 4.3 路径 B：`scripts/restore.sh` 全流程

```bash
docker exec -i -u nextjs lawlink-app bash -c \
  'cd /tmp && export DATABASE_URL="postgresql://lawlink:lawlink_dev_2026@db:5432/lawlink_restore_drill?schema=public" \
   && printf "YES\n" | bash /app/scripts/restore.sh /app/backups/20261118_234809'
```

```
=== LawLink 数据恢复 ===
备份: /app/backups/20261118_234809
目标数据库: lawlink_restore_drill@db:5432
[1/2] 恢复数据库...
  数据库恢复完成
[2/2] 恢复文件存储...
  文件存储恢复完成
=== 恢复完成 ===
real 1.28
```

- **墙钟 1.28 s**（含 `docker exec` 与交互确认）。
- 恢复后重跑 87 表行数比对：**87/87 一致**。
- 注意：脚本会在 `$PWD` 解包 `storage.tar.gz`，本次在容器 `/tmp` 下执行，未污染 `/app/storage`；解包后已删除 `/tmp/storage`。

---

## 5. 逐表行数对比（生产 `lawlink` vs 恢复 `lawlink_restore_drill`）

比对方法：对 `pg_tables` 里 87 张表逐表 `count(*)`，两张库各跑一遍，`diff` 全量结果。

```
$ diff tables.txt tables_restore.txt   →  TABLE SET IDENTICAL
$ diff counts_prod.txt counts_restore.txt → ALL ROW COUNTS IDENTICAL
```

**结论：表集合一致（87/87），逐表行数全部一致（合计 2,151 行）。** 下表按行数降序，0 行的表同样纳入了比对。

| # | 表 | 生产 lawlink | 恢复 lawlink_restore_drill | 一致 |
|---|---|---|---|---|
| 1 | `CauseOfAction` | 1729 | 1729 | ✅ |
| 2 | `ExternalCallLog` | 123 | 123 | ✅ |
| 3 | `AuditLog` | 68 | 68 | ✅ |
| 4 | `DocumentFolder` | 57 | 57 | ✅ |
| 5 | `Document` | 22 | 22 | ✅ |
| 6 | `DocumentTemplate` | 22 | 22 | ✅ |
| 7 | `DeadlineRule` | 16 | 16 | ✅ |
| 8 | `Contact` | 15 | 15 | ✅ |
| 9 | `Party` | 14 | 14 | ✅ |
| 10 | `Client` | 11 | 11 | ✅ |
| 11 | `User` | 9 | 9 | ✅ |
| 12 | `TeamMember` | 8 | 8 | ✅ |
| 13 | `Matter` | 7 | 7 | ✅ |
| 14 | `MatterClient` | 7 | 7 | ✅ |
| 15 | `MatterMember` | 7 | 7 | ✅ |
| 16 | `MatterProcedure` | 7 | 7 | ✅ |
| 17 | `SystemSetting` | 7 | 7 | ✅ |
| 18 | `TimelineEvent` | 7 | 7 | ✅ |
| 19 | `SealTypeConfig` | 5 | 5 | ✅ |
| 20 | `_prisma_migrations` | 5 | 5 | ✅ |
| 21 | `StageTemplate` | 4 | 4 | ✅ |
| 22 | `Team` | 1 | 1 | ✅ |
| 23 | `Allocation` | 0 | 0 | ✅ |
| 24 | `Announcement` | 0 | 0 | ✅ |
| 25 | `ApprovalPermissionGroup` | 0 | 0 | ✅ |
| 26 | `ApprovalPermissionMember` | 0 | 0 | ✅ |
| 27 | `ApprovalPermissionRule` | 0 | 0 | ✅ |
| 28 | `ArchiveClosurePlan` | 0 | 0 | ✅ |
| 29 | `ArchiveRecord` | 0 | 0 | ✅ |
| 30 | `Billing` | 0 | 0 | ✅ |
| 31 | `BillingAttachment` | 0 | 0 | ✅ |
| 32 | `BillingProcedureScope` | 0 | 0 | ✅ |
| 33 | `CommissionPlan` | 0 | 0 | ✅ |
| 34 | `CommissionSettlement` | 0 | 0 | ✅ |
| 35 | `ConflictCheck` | 0 | 0 | ✅ |
| 36 | `ConflictHit` | 0 | 0 | ✅ |
| 37 | `CustomFieldDef` | 0 | 0 | ✅ |
| 38 | `Deadline` | 0 | 0 | ✅ |
| 39 | `Engagement` | 0 | 0 | ✅ |
| 40 | `EngagementMatter` | 0 | 0 | ✅ |
| 41 | `EvidenceItem` | 0 | 0 | ✅ |
| 42 | `ExecutionTermination` | 0 | 0 | ✅ |
| 43 | `ExpressTracking` | 0 | 0 | ✅ |
| 44 | `ExternalContact` | 0 | 0 | ✅ |
| 45 | `FeeEntry` | 0 | 0 | ✅ |
| 46 | `FinanceCorrection` | 0 | 0 | ✅ |
| 47 | `FinanceCorrectionEffect` | 0 | 0 | ✅ |
| 48 | `FirmFile` | 0 | 0 | ✅ |
| 49 | `Hearing` | 0 | 0 | ✅ |
| 50 | `Intake` | 0 | 0 | ✅ |
| 51 | `IntakeHandover` | 0 | 0 | ✅ |
| 52 | `IntakeRevision` | 0 | 0 | ✅ |
| 53 | `IntakeUrgentItem` | 0 | 0 | ✅ |
| 54 | `InvoiceAdjustment` | 0 | 0 | ✅ |
| 55 | `InvoicePaymentAllocation` | 0 | 0 | ✅ |
| 56 | `InvoiceRequest` | 0 | 0 | ✅ |
| 57 | `JobQueue` | 0 | 0 | ✅ |
| 58 | `MatterHandover` | 0 | 0 | ✅ |
| 59 | `MatterLink` | 0 | 0 | ✅ |
| 60 | `MatterStage` | 0 | 0 | ✅ |
| 61 | `Note` | 0 | 0 | ✅ |
| 62 | `Notification` | 0 | 0 | ✅ |
| 63 | `Payment` | 0 | 0 | ✅ |
| 64 | `PreservationCase` | 0 | 0 | ✅ |
| 65 | `PreservationProperty` | 0 | 0 | ✅ |
| 66 | `PreservationPropertyRenewal` | 0 | 0 | ✅ |
| 67 | `PreservationTarget` | 0 | 0 | ✅ |
| 68 | `ProcedureMemo` | 0 | 0 | ✅ |
| 69 | `RateSchedule` | 0 | 0 | ✅ |
| 70 | `Receivable` | 0 | 0 | ✅ |
| 71 | `RelatedEntity` | 0 | 0 | ✅ |
| 72 | `ReviewRecord` | 0 | 0 | ✅ |
| 73 | `RoleDefinition` | 0 | 0 | ✅ |
| 74 | `RolePermission` | 0 | 0 | ✅ |
| 75 | `SealPurposeConfig` | 0 | 0 | ✅ |
| 76 | `SealRequest` | 0 | 0 | ✅ |
| 77 | `SmsInboundFile` | 0 | 0 | ✅ |
| 78 | `SmsMessage` | 0 | 0 | ✅ |
| 79 | `SmsSuggestion` | 0 | 0 | ✅ |
| 80 | `Task` | 0 | 0 | ✅ |
| 81 | `TimeEntry` | 0 | 0 | ✅ |
| 82 | `UserIdentityDocument` | 0 | 0 | ✅ |
| 83 | `WorkResponsibility` | 0 | 0 | ✅ |
| 84 | `archive_borrow_request` | 0 | 0 | ✅ |
| 85 | `holiday` | 0 | 0 | ✅ |
| 86 | `procedure_parties` | 0 | 0 | ✅ |
| 87 | `reminder_delivery` | 0 | 0 | ✅ |

### 5.1 内容级校验（不只比行数）

行数相同也可能是"行变了"，所以对 6 张关键表再做**内容指纹**：`md5(string_agg(row::text, '|' order by row::text))`。

| 表 | 生产 | 恢复 | 结果 |
|---|---|---|---|
| `Client` | `e5da5c2935510ff234d54df70366036c` | 同左 | ✅ MATCH |
| `Matter` | `1d4ce3c3e3d7eea187b8ba9b9eeed150` | 同左 | ✅ MATCH |
| `Party` | `25a4d2f73391f39ee21cea6f0ff7bd22` | 同左 | ✅ MATCH |
| `User` | `bc127e660728391973ce45f67fe470f7` | 同左 | ✅ MATCH |
| `AuditLog` | `c4e6c96c31a036c713681f376b63b64d` | 同左 | ✅ MATCH |
| `TimeEntry` | `empty`（无行） | `empty` | ✅ MATCH |

### 5.2 模式（schema）对象对比

| 对象 | 生产 | 恢复 |
|---|---|---|
| public 表 | 87 | 87 |
| 索引 | 300 | 300 |
| 外键 | 188 | 188 |
| CHECK 约束 | 25 | 25 |
| 触发器 | 10 | 10 |
| 函数 | 5 | 5 |
| 枚举 | 89 | 89 |

即：**迁移脚本之外的"手工数据库对象"（触发器/函数/CHECK/部分唯一索引）也被 pg_dump 完整带过来了**——这点很关键，因为 `prisma migrate diff` 生成不了这些对象（AGENTS §六.6.1 记录过同类坑）。

---

## 6. 审计链在恢复库的校验

### 6.1 背景

`src/lib/audit-chain.ts` 的 `verifyAuditChain()`：按 `createdAt, id` 升序逐条重算 `integrityHash`（SHA-256，输入含 `previousHash`），比对摘要与 `previousHash` 的连续性；`integrityHash IS NULL` 的历史记录跳过但计数（`skippedLegacy`），并重置链起点。

### 6.2 用**生产代码**校验恢复库数据（不是自己另写一套算法）

把恢复库的 `AuditLog` 导出为 JSON（`createdAt` 用 `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` 强制 UTC 以匹配 Prisma 的 `Date` 语义），再喂给**仓库里真实的** `verifyAuditChain`：

```ts
import { verifyAuditChain } from "/Users/Jenner/Documents/律所CRM需求分析/oss-verify/LawLink/src/lib/audit-chain.ts";
const rows = JSON.parse(readFileSync("audit_rows.json","utf8")).map(r => ({...r, createdAt: new Date(r.createdAt)}));
const result = await verifyAuditChain({ auditLog: { findMany: async () => rows } });
```

结果：

```json
{
  "rowsFed": 68,
  "result": { "ok": true, "checked": 23, "skippedLegacy": 45, "brokenAt": null }
}
```

- `checked = 23`：恢复库里有 23 条带链摘要的记录，逐条摘要与链序**全部正确**。
- `skippedLegacy = 45`：加字段前的历史记录，按设计跳过、不计为断裂。
- 两次独立恢复（路径 A、路径 B）各跑一遍，结果一致。

### 6.3 独立 SQL 交叉验证（不依赖 TS 代码）

```sql
WITH o AS (
  SELECT id, "integrityHash", "previousHash",
         lag("integrityHash") OVER (ORDER BY "createdAt" ASC, id ASC) AS prev
  FROM "AuditLog"
)
SELECT count(*) FILTER (WHERE "integrityHash" IS NOT NULL) AS hashed,
       count(*) FILTER (WHERE "integrityHash" IS NULL)     AS legacy,
       count(*) FILTER (WHERE "integrityHash" IS NOT NULL
                          AND prev IS DISTINCT FROM "previousHash"
                          AND prev IS NOT NULL)            AS broken_links
FROM o;
```

| 库 | total | hashed | legacy | **broken_links** |
|---|---|---|---|---|
| 生产 `lawlink` | 68 | 23 | 45 | **0** |
| 恢复 `lawlink_restore_drill` | 68 | 23 | 45 | **0** |

### 6.4 负向对照：链校验在恢复库真的会"报警"

为了证明上面的 `ok: true` 不是"永远返回 true"，在恢复库里篡改一条有摘要的记录：

```sql
UPDATE "AuditLog" SET action='TAMPERED_ACTION'
WHERE id=(SELECT id FROM "AuditLog" WHERE "integrityHash" IS NOT NULL
          ORDER BY "createdAt" DESC LIMIT 1);
```

再跑一次生产的 `verifyAuditChain`：

```json
{ "ok": false, "checked": 22, "skippedLegacy": 45,
   "brokenAt": { "id": "cmwmhx4ri000glm7av4yq23sy", "action": "TAMPERED_ACTION",
                  "reason": "记录内容与自身摘要不符（该条被改动）" } }
```

**精确定位到被改的那一条**，说明恢复库里的链数据是可验证的、校验器是有效的（临时库随后即被 DROP，不影响生产）。

### 6.5 附带验证：审计防删触发器随备份恢复

```sql
BEGIN;
DELETE FROM "AuditLog" WHERE id = (SELECT id FROM "AuditLog" ORDER BY id LIMIT 1);
ROLLBACK;
```

```
ERROR:  AuditLog 不允许删除（AGENTS.md §六）：审计日志只能归档处置，不可由业务代码删除
CONTEXT:  PL/pgSQL function audit_log_forbid_delete() line 3 at RAISE
ROLLBACK
audit_rows_after_attempt = 68
```

恢复库不仅数据在，**"审计日志不可删"这条数据库级硬约束也在**（这是 §5.2 里 10 个触发器之一）。

---

## 7. RTO 实测

| 环节 | 实测 |
|---|---|
| 备份导出（pg_dump + storage 打包 + manifest，容器内 `backup.sh`） | **0.22 s** |
| 建库 + `pg_restore` 全库 + 行数校验（路径 A） | **1.06 s** |
| `scripts/restore.sh` 全流程（路径 B，含 `docker exec` 与交互确认） | **1.28 s** |
| **灾难恢复最短路径（备份已存在 → 库可查询）** | **≈ 1.1 s**（0.8 s 恢复 + 0.25 s 建库/校验） |
| **含"现做一次备份"的完整闭环** | **≈ 1.3 s** |

**口径声明（防止误用这个数字）**：

- 这是**同机、同 Docker 网络、15 MB / 412 KB dump** 的实测值；真实律所库到 GB 级、跨机或跨云时，恢复时间主要由 I/O 与网络决定，**不能按线性外推**。
- 恢复耗时未包含"应用重启 + 冒烟验证"。本次只验证到"库可查询、数据一致、审计链通过"。
- 未包含附件文件恢复的真实耗时——因为本环境附件备份是空的（§8 P0-1），无法测。

---

## 8. 发现的问题（按严重度）

### P0-1 附件/模板文件没有进备份，且恢复不出来（本环境实证）

**证据链**：

1. 容器内存储目录为空：`docker exec lawlink-app sh -c 'du -sh /app/storage; find /app/storage -type f | wc -l'` → `4.0K`、`0`。
2. 备份里的 `storage.tar.gz` 只有 **102 B**，`tar tzf` 仅一项 `storage/`。
3. 但数据库里有 22 条 `Document` 记录，`path` 形如 `templates/202611/49c82afb-….bin`，共 22 个不同路径。
4. 这 22 个文件**在宿主仓库的 `storage/` 下真实存在**（`storage/` 共 23 个文件 / 268 KB，逐个校验 `MISSING_HOST=0`）。
5. 容器 `/app/storage` 挂的是命名卷 `lawlink_app_storage`，**与宿主 `storage/` 是两套东西**（`docker inspect` 确认挂载是 volume 而非 bind mount）。

**后果**：以现在的状态做灾难恢复 → 数据库恢复成功，但打开文书/模板会指向不存在的文件；即"库能恢复、业务不能用"。

**根因（两层）**：

- 环境层：本机先在宿主跑了 dev/seed（文件写进宿主 `storage/`），后起容器（独立空卷），两边从未同步。
- 设计层：`backup.sh` 只打包 `APP_STORAGE_DIR`，**不校验"存储文件数 vs `Document` 行数"**，也不校验打包结果非空，所以"备份成功"和"附件全丢"能同时成立。

**建议（交由主控决策，本次未改代码）**：

- 部署侧：把 `/app/storage` 改成 bind mount 到宿主固定目录（或统一迁移进卷），并按"以容器为准"重做一次种子/附件导入。
- 脚本侧：`backup.sh` 增加两道自检——`storage.tar.gz` 解包文件数 > 0 时才算通过；`Document`/`DocumentTemplate` 行数 > 0 而存储文件数为 0 时直接失败并通知超管。
- 演练侧：把"附件可下载"纳入恢复验收（本次无法做，如实标注）。

### P1-1 `manifest.json` 不含校验信息，备份完成即"自证成功"

manifest 只写 `timestamp / date / database / storage_path / encrypted / files[]`，**没有 SHA-256、没有行数、没有 dump 大小**；`backup.sh` 也不跑 `pg_restore --list`。后果：dump 损坏（磁盘满、进程被杀）时，当天仍会显示"备份完成"，直到真恢复才发现。本次的 SHA-256 是我在演练里自己算的，脚本没有产出。

> 附带：`manifest.json` 无条件声明包含 `storage.tar.gz`，即使该文件因存储目录不存在而被跳过——manifest 会与实际产物不符。

### P1-2 备份默认明文落盘

`BACKUP_PASSPHRASE` 未设置时，只打印两行警告；本次备份就是明文（`manifest.encrypted = "false"`）。备份内含密码哈希、AES-GCM 密文、恢复码哈希（脚本注释已言明），而产物与数据同机同卷（§P2-1）。`BACKUP_ALLOW_PLAINTEXT=true` 才"承认明文"的设计是对的，但当前 compose 未设置 `BACKUP_PASSPHRASE`，生产会一直走明文分支。

### P1-3 `restore.sh` 与 `backup.sh` 的存储变量不一致（同一 bug 的另一半）

- `backup.sh`：`STORAGE_DIR="${APP_STORAGE_DIR:-./storage}"`（2026-09-20 修过：此前读 `STORAGE_PATH`，自定义目录会打包空目录）。
- `restore.sh`：`STORAGE_DIR="${STORAGE_PATH:-./storage}"` —— **仍读 `STORAGE_PATH`**，而应用与 compose 用的是 `APP_STORAGE_DIR`。

后果：一旦按文档设置了 `APP_STORAGE_DIR`，恢复时脚本仍会去 `./storage` 解包/比对，属于"备份修了、恢复没修"的对称缺口。本次因容器内 `APP_STORAGE_DIR=/app/storage` 恰好没触发（脚本默认 `./storage`，在 `/tmp` 下解包，只多出一个空目录）。

### P1-4 `restore.sh` 缺少恢复正确性保障

- `pg_restore` 未加 `--exit-on-error` / `--single-transaction`：部分失败会留下"半恢复"库，脚本仍继续走下一步并打印"恢复完成"。
- 恢复后零校验（不比对行数、不验审计链）。
- 只会覆盖 `DATABASE_URL` 指向的库，**没有"恢复到临时库"的模式**——运维演练时极易误伤生产。本次我能安全演练，是靠手写 `CREATE DATABASE lawlink_restore_drill` + 覆盖 `DATABASE_URL`，不是脚本提供的安全阀。

### P2-1 备份与数据同机同卷，无异地副本

备份写 `lawlink_backups` 卷，与 `postgres_data` 在同一 Docker 数据区。脚本结尾只是"建议上传 S3/OSS"。真实灾难（磁盘/主机损坏）会同时带走库和备份。compose 注释已提示"生产应改绑宿主机/异地路径"，但当前部署没改。

### P2-2 没有"备份可用性"的自动巡检

cron 只负责"跑备份 + 清理 + 失败通知"，不负责"验证备份能被恢复"。本次演练是一次性人工动作，没有沉淀成定时任务或 CI 步骤。

### P2-3 备份目录名用 UTC，运维对时间会错位

`20261118_234809` 实际是宿主本地 `2026-11-19 07:48`。核对审计/值班记录时差 8 小时，容易误判"备份是昨天的"。

---

## 9. 清理与现场还原

```bash
$ docker exec lawlink-db psql -U lawlink -d postgres -c "DROP DATABASE IF EXISTS lawlink_restore_drill;"
DROP DATABASE
$ docker exec lawlink-db psql -U lawlink -d postgres -tAc "select string_agg(datname,',' order by datname) from pg_database;"
lawlink,postgres,template0,template1
```

- 临时库 `lawlink_restore_drill` 已删除（残留检查：`select count(*) … where datname='lawlink_restore_drill'` → `0`）。
- 容器 `/tmp` 中间文件（`drill.dump`、SQL 脚本、解包目录）已删除。
- 生产库未被修改：演练前后 `Client/Matter/AuditLog = 11/7/68` 不变；演练只对临时库做 `UPDATE`/`DELETE` 试验。
- **保留**的产物：`/app/backups/20261118_234809`（本次真实备份，含 manifest/dump/storage.tar.gz），作为本轮演练物证；`lawlink_backups` 卷内另有 cron 产生的 `20261118_183000`。

### 9.1 回归确认（本次改动范围）

本次任务**只新增本报告一个文件**，未改任何 `src/`、`prisma/`、`package.json` 与脚本。为确认工作区仍然健康，演练后跑了全量测试：

```
$ npx vitest run
 Test Files  105 passed (105)
      Tests  793 passed (793)
   Duration  10.50s
```

即基线 793 全绿保持不变。

---

## 10. 复现步骤（任何人可重跑）

```bash
# 0) 变量
PROJ=/Users/Jenner/Documents/律所CRM需求分析/oss-verify/LawLink

# 1) 备份（容器内，nextjs 身份）
docker exec -u nextjs lawlink-app bash -c 'BACKUP_ALLOW_PLAINTEXT=true bash /app/scripts/backup.sh /app/backups'

# 2) 取回产物并校验可读
docker cp lawlink-app:/app/backups/<TIMESTAMP> /tmp/backup
shasum -a 256 /tmp/backup/database.dump
docker cp /tmp/backup/database.dump lawlink-db:/tmp/drill.dump
docker exec lawlink-db pg_restore --list /tmp/drill.dump | head

# 3) 恢复进临时库 + 计时
docker exec lawlink-db psql -U lawlink -d postgres -c "CREATE DATABASE lawlink_restore_drill OWNER lawlink TEMPLATE template0;"
time docker exec lawlink-db pg_restore -U lawlink -d lawlink_restore_drill   --no-owner --no-privileges --single-transaction --exit-on-error /tmp/drill.dump

# 4) 逐表行数比对（两个库各跑一遍 diff）
# 5) 审计链：导出 AuditLog → 调 src/lib/audit-chain.ts 的 verifyAuditChain
# 6) 清理
docker exec lawlink-db psql -U lawlink -d postgres -c "DROP DATABASE lawlink_restore_drill;"
docker exec lawlink-db sh -c 'rm -f /tmp/drill.dump'
```

---

## 11. 未覆盖（如实声明）

| 项 | 状态 | 原因 |
|---|---|---|
| 附件/模板文件的真实恢复 | ❌ 未测 | 本环境容器存储卷为空，备份里没有文件可恢复（§8 P0-1） |
| 加密备份（`BACKUP_PASSPHRASE`）的加密/解密闭环 | ❌ 未测 | 未设置口令；openssl 加密分支未执行 |
| 跨机/异地恢复、GB 级数据量 RTO | ❌ 未测 | 单机 15 MB 样本，不具代表性 |
| 02:30 自动备份的长期稳定性 | ⚠️ 部分 | 只确认有 1 次真实 cron 执行（18:30 审计 + 目录），未做多日观察 |
| 应用层恢复后冒烟（登录/打开案件/下载文书） | ❌ 未测 | 本次只验证到数据库层；应用仍指向生产库，未切换 |
| 备份文件单独损坏（截断/位翻转）的检测能力 | ⚠️ 已知缺口 | 无内置 checksum（§P1-1）；本次靠人工 `pg_restore --list` + 全量恢复反向证明 |

---

## 12. 给主控的下一步建议（按性价比排序）

1. **先解决存储分叉**（P0-1）：把 `/app/storage` 改 bind mount 到宿主固定目录并以容器为准重做附件导入；否则"备份可用"只对数据库成立。
2. `backup.sh` 加三行自检：`pg_restore --list` 成功、`storage.tar.gz` 文件数 > 0（当 `Document` 行数 > 0 时）、manifest 写入 dump 的 SHA-256 与字节数。
3. `restore.sh` 修 `STORAGE_PATH` → `APP_STORAGE_DIR`，加 `--exit-on-error --single-transaction`，加"恢复到 `RESTORE_TARGET_DB`（默认指向临时库）"模式，恢复后自动跑行数比对 + `verifyAuditChain`。
4. 生产设 `BACKUP_PASSPHRASE` 并把备份同步到异地（S3/OSS），compose 里改成 bind mount 到宿主独立磁盘。
5. 把本演练固化成 `scripts/verify-backup.ts`（每日或每周跑一次"恢复到临时库 + 行数比对 + 链校验 + DROP"），失败即通知超管——这样"备份可用"才是被持续证明的，而不是某天被人证明过一次。

---

## 附：本次演练的关键数字（速查）

| 指标 | 值 |
|---|---|
| 库大小 / dump 大小 | 15 MB / 421,617 B |
| 表数 / 总行数 | 87 / 2,151 |
| 备份耗时 | 0.22 s |
| 恢复耗时（到可查询） | 1.06 s |
| `restore.sh` 全流程 | 1.28 s |
| 逐表行数一致 | 87/87 ✅ |
| 内容指纹一致 | 6/6 关键表 ✅ |
| 审计链（恢复库） | ok=true，checked=23，legacy=45，broken=0 ✅ |
| 篡改检测（负向对照） | ok=false，精确定位到被改行 ✅ |
| 审计防删触发器 | 恢复库仍拦截 DELETE ✅ |
| 附件文件备份 | ❌ 0 文件（102 B 空包） |
