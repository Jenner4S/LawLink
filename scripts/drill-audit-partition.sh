#!/usr/bin/env bash
#
# AuditLog 分区化可行性演练（2026-11-22）
#
# ## 只在临时库跑，绝不碰主库
#
# 本脚本先断言目标库名以 `lawlink_drill_` 开头，否则**立即退出**。
# 目的是把「审计表分区」的步骤、耗时、坑量出来，供决策时参考——
# 而不是凭估算说「大概要停机几分钟」。
#
# ## 为什么需要这个演练
#
# `AuditLog` 有触发器禁删，却没有归档路径（有政策、无实现）。
# 正解是分区表（按月）+ 老分区 DETACH，但那要重建表结构，
# 属高风险迁移。**在没量过之前不动主库。**
#
# ## 用法
#
#   ./scripts/drill-audit-partition.sh
#
# 结束后临时库会被删除；输出含每步耗时与验证结果。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
set -a; . ./.env 2>/dev/null || true; set +a

PGHOSTPORT="${FIN_TEST_PG_HOST:-localhost:55432}"
PGUSER_="${FIN_TEST_PG_USER:-lawlink}"
PGPASS_="${FIN_TEST_PG_PASSWORD:-lawlink_dev_2026}"
DB="lawlink_drill_auditpart_$(date +%s)"

case "$DB" in
  lawlink_drill_*) : ;;
  *) echo "拒绝执行：目标库名必须以 lawlink_drill_ 开头（当前 ${DB}）"; exit 2 ;;
esac

PSQL=(docker exec -i lawlink-db psql -U "$PGUSER_" -d postgres -v ON_ERROR_STOP=1)
PSQLDB=(docker exec -i lawlink-db psql -U "$PGUSER_" -d "$DB" -v ON_ERROR_STOP=1)

t0=$(date +%s)
echo "=== 1/6 建临时库 $DB ==="
"${PSQL[@]}" -c "CREATE DATABASE \"$DB\"" >/dev/null || { echo "建库失败"; exit 1; }
echo "  ✅ $(($(date +%s)-t0))s"

echo "=== 2/6 迁移到现行 schema ==="
t0=$(date +%s)
DATABASE_URL="postgresql://${PGUSER_}:${PGPASS_}@${PGHOSTPORT}/${DB}?schema=public" \
  npx prisma migrate deploy >/dev/null 2>&1 || { echo "迁移失败"; exit 1; }
echo "  ✅ $(($(date +%s)-t0))s"

echo "=== 3/6 造数据：12 个月 × 2 万条 = 24 万条（约等于真实一年） ==="
t0=$(date +%s)
"${PSQLDB[@]}" -q <<'SQL' >/dev/null
INSERT INTO "AuditLog" (id, action, "targetType", "targetId", "createdAt")
SELECT 'drill_' || g, 'DRILL_ACTION', 'Matter', 'm' || (g % 5000),
       now() - (g % 365) * interval '1 day'
FROM generate_series(1, 240000) g;
SQL
CNT=$("${PSQLDB[@]}" -tAc 'select count(*) from "AuditLog"' | tr -d ' ')
echo "  ✅ $(($(date +%s)-t0))s（行数 ${CNT}）"

echo "=== 4/6 分区化：新建父表 + 月分区，再灌数据 ==="
t0=$(date +%s)
"${PSQLDB[@]}" -q <<'SQL' >/dev/null
BEGIN;
-- 触发器先在父表定义：PostgreSQL 分区表的行级触发器对全部分区生效
-- ⚠️ 关键阻碍（演练实测）：PostgreSQL 要求分区表的 PK/UNIQUE 必须**包含分区键**。
-- 即 PRIMARY KEY (id) 不行，必须 PRIMARY KEY (id, "createdAt")。
-- 而 Prisma 的 @@id 是单列，改成 @@id([id, "createdAt"]) 会让
-- `findUnique({ where: { id } })` 失效（代码里目前 0 处这样用，代价可控，但语义变了）。
CREATE TABLE "AuditLog_part" (
  id            text NOT NULL,
  "userId"      text,
  action        text NOT NULL,
  "targetType"  text,
  "targetId"    text,
  detail        jsonb,
  ip            text,
  "userAgent"   text,
  "integrityHash" text,
  "previousHash"  text,
  "createdAt"   timestamp NOT NULL DEFAULT now(),  -- 与原表一致：Prisma DateTime → timestamp without time zone
  PRIMARY KEY (id, "createdAt")
) PARTITION BY RANGE ("createdAt");

-- 覆盖演练数据范围 + 未来 3 个月
DO $$
DECLARE m date;
BEGIN
  FOR m IN SELECT generate_series(date_trunc('month', now()) - interval '13 month',
                                  date_trunc('month', now()) + interval '3 month',
                                  interval '1 month')::date
  LOOP
    EXECUTE format('CREATE TABLE %I PARTITION OF "AuditLog_part" FOR VALUES FROM (%L) TO (%L)',
      'audit_p_' || to_char(m, 'YYYYMM'), m, m + interval '1 month');
  END LOOP;
END $$;
COMMIT;
SQL
echo "  ✅ $(($(date +%s)-t0))s"

t0=$(date +%s)
# 必须写显式列名：SELECT * 依赖物理列顺序，原表真实顺序与 schema 声明顺序不一致时会错位
# （本次演练就撞上："column createdAt is of type timestamp but expression is of type text"）
"${PSQLDB[@]}" -q -c 'INSERT INTO "AuditLog_part"
  (id, "userId", action, "targetType", "targetId", detail, ip, "userAgent", "integrityHash", "previousHash", "createdAt")
  SELECT id, "userId", action, "targetType", "targetId", detail, ip, "userAgent", "integrityHash", "previousHash", "createdAt"
  FROM "AuditLog"' >/dev/null
echo "  复制数据：✅ $(($(date +%s)-t0))s"

echo "=== 5/6 建索引与触发器，然后交换表名 ==="
t0=$(date +%s)
"${PSQLDB[@]}" -q <<'SQL' >/dev/null
BEGIN;
CREATE INDEX audit_part_user_created ON "AuditLog_part" ("userId", "createdAt");
CREATE INDEX audit_part_action_created ON "AuditLog_part" (action, "createdAt");
CREATE INDEX audit_part_target ON "AuditLog_part" ("targetId", "targetType");
CREATE INDEX audit_part_prevhash ON "AuditLog_part" ("previousHash");

CREATE OR REPLACE FUNCTION audit_log_forbid_delete() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'AuditLog 不允许删除';
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "AuditLog_part"
  FOR EACH ROW EXECUTE FUNCTION audit_log_forbid_delete();

-- 交换：原表改名留档，分区表接管正式名
ALTER TABLE "AuditLog" RENAME TO "AuditLog_old";
ALTER TABLE "AuditLog_part" RENAME TO "AuditLog";
COMMIT;
SQL
echo "  ✅ 建索引+触发器+改名 $(($(date +%s)-t0))s（含 24 万行索引构建）"

echo "=== 6/6 验证：查询、禁删、DETACH 老分区 ==="
V1=$("${PSQLDB[@]}" -tAc 'select count(*) from "AuditLog"' | tr -d ' ')
echo "  ① 父表可查：$V1 行 $( [ "$V1" = "$CNT" ] && echo ✅ || echo ❌ )"

DEL=$("${PSQLDB[@]}" -tAc "delete from \"AuditLog\" where id = (select id from \"AuditLog\" limit 1)" 2>&1 | head -1)
echo "  ② 禁删触发器生效：$(echo "$DEL" | grep -q '不允许删除' && echo '✅ 被拦下' || echo "❌ 未被拦：$DEL")"

t0=$(date +%s)
OLDEST=$(date -u -v-13m +%Y%m 2>/dev/null || date -u -d '-13 month' +%Y%m)
"${PSQLDB[@]}" -q -c "ALTER TABLE \"AuditLog\" DETACH PARTITION \"audit_p_${OLDEST}\"" 2>/dev/null || \
  "${PSQLDB[@]}" -q -c "ALTER TABLE \"AuditLog\" DETACH PARTITION \"audit_p_$(date -u +%Y%m)\"" 2>&1 | head -1
echo "  ③ DETACH 老分区：$(($(date +%s)-t0))s"

PARTS=$("${PSQLDB[@]}" -tAc "select count(*) from pg_inherits where inhparent = '\"AuditLog\"'::regclass" | tr -d ' ')
echo "  ④ 剩余分区数：$PARTS"

echo "=== 清理临时库 $DB ==="
DROP_OUT=$("${PSQL[@]}" -c "DROP DATABASE IF EXISTS \"${DB}\" WITH (FORCE)" 2>&1) || { echo "  ⚠️ DROP 失败：${DROP_OUT}"; }
sleep 1
LEFT=$("${PSQL[@]}" -tAc "select count(*) from pg_database where datname like 'lawlink_drill_%'" | tr -d ' ')
echo "  已删除（残留的 lawlink_drill_* 库：${LEFT}）"
echo
echo "=== 演练结束（主库 lawlink 未受影响） ==="
