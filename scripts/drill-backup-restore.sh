#!/bin/bash
# LawLink 备份/恢复往返演练（2026-11-21）
#
# ## 为什么需要这个脚本
#
# 备份只有在真的需要恢复的那天才验证 —— 而那时已经没有第二次机会。
# 2026-11-21 就撞到一次：宿主 pg_dump 是 14.x、服务端是 16.x，
# `scripts/backup.sh` 直接失败并留下 0 字节的 dump。
# 如果不是当天恰好做了往返演练，这个律所要等到真的出事才会发现「没有备份」。
#
# 本脚本做四件事，全部在临时库里，**绝不碰主库与主存储**：
#   1. 用真实脚本 backup.sh 备份主库到临时目录
#   2. 新建临时库，用真实脚本 restore.sh 恢复进去（存储也恢复到临时目录）
#   3. 逐项比对：表集合 / 每表行数 / 关键表内容摘要 / 序列 / 约束 / 索引 / 触发器 / 函数 / 存储文件哈希
#   4. 清理临时库与临时文件，输出报告
#
# 用法:
#   ./scripts/drill-backup-restore.sh
#   BACKUP_ALLOW_PLAINTEXT=true ./scripts/drill-backup-restore.sh   # 跳过明文警告
#
# 退出码: 0 = 往返一致；1 = 发现差异或演练本身失败
#
# 前置: 数据库容器可访问（默认 lawlink-db），.env 里有 DATABASE_URL 或 POSTGRES_*

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi

# DATABASE_URL 可能只在部署环境里；这里按 POSTGRES_* 也拼一份
if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_USER:-}" ]; then
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD:-}@localhost:${POSTGRES_PORT:-55432}/${POSTGRES_DB:-lawlink}?schema=public"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "错误: 未找到 DATABASE_URL（也没有 POSTGRES_* 可拼）" >&2
  exit 1
fi

DB_CONTAINER="${DB_CONTAINER:-lawlink-db}"
MAIN_DB=$(echo "$DATABASE_URL" | sed -E 's/.*\/([^?]+).*/\1/')
RT_DB="lawlink_drill_$(date +%Y%m%d%H%M%S)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lawlink-drill.XXXXXX")
BACKUP_DIR="$WORK/backup"
STORAGE_OUT="$WORK/storage"

FAIL=0
fail() { echo "  ❌ $*"; FAIL=1; }
pass() { echo "  ✅ $*"; }

cleanup() {
  if docker exec "$DB_CONTAINER" psql -U "${POSTGRES_USER:-lawlink}" -d postgres -tAc \
       "select 1 from pg_database where datname='$RT_DB'" 2>/dev/null | grep -q 1; then
    docker exec "$DB_CONTAINER" psql -U "${POSTGRES_USER:-lawlink}" -d postgres \
      -c "DROP DATABASE IF EXISTS \"$RT_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== LawLink 灾备往返演练 ==="
echo "主库: $MAIN_DB    临时库: $RT_DB"
echo "工作目录: $WORK"
echo ""

# ── 1. 备份 ──────────────────────────────────────────────
echo "[1/5] 用 scripts/backup.sh 备份主库"
if ! BACKUP_ALLOW_PLAINTEXT="${BACKUP_ALLOW_PLAINTEXT:-true}" \
     ./scripts/backup.sh "$BACKUP_DIR" > "$WORK/backup.log" 2>&1; then
  echo "  ❌ 备份脚本失败，演练中止。日志：" >&2
  tail -20 "$WORK/backup.log" >&2
  exit 1
fi
BK=$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)
DUMP_SIZE=$(stat -f%z "$BK/database.dump" 2>/dev/null || stat -c%s "$BK/database.dump" 2>/dev/null || echo 0)
if [ "$DUMP_SIZE" -lt 1024 ]; then
  fail "dump 只有 ${DUMP_SIZE} 字节 —— 备份实际没成功（这就是 2026-11-21 撞到的 0 字节问题）"
  exit 1
fi
pass "备份产物 $(du -sh "$BK" | cut -f1)（dump ${DUMP_SIZE} 字节）"

# ── 2. 建临时库 ───────────────────────────────────────────
echo "[2/5] 建临时库"
docker exec "$DB_CONTAINER" psql -U "${POSTGRES_USER:-lawlink}" -d postgres \
  -c "CREATE DATABASE \"$RT_DB\"" >/dev/null
pass "临时库已建"

# ── 3. 恢复 ──────────────────────────────────────────────
echo "[3/5] 用 scripts/restore.sh 恢复到临时库"
mkdir -p "$STORAGE_OUT"
if ! echo "YES" | DATABASE_URL="postgresql://${POSTGRES_USER:-lawlink}:${POSTGRES_PASSWORD:-}@localhost:${POSTGRES_PORT:-55432}/${RT_DB}?schema=public" \
     APP_STORAGE_DIR="$STORAGE_OUT/storage" \
     ./scripts/restore.sh "$BK" > "$WORK/restore.log" 2>&1; then
  echo "  ❌ 恢复脚本失败，日志：" >&2
  tail -20 "$WORK/restore.log" >&2
  exit 1
fi
pass "恢复完成"

# ── 4. 比对 ──────────────────────────────────────────────
echo "[4/5] 比对"

q_main() { docker exec "$DB_CONTAINER" psql -U "${POSTGRES_USER:-lawlink}" -d "$MAIN_DB" -tAc "$1" 2>/dev/null; }
q_rt()   { docker exec "$DB_CONTAINER" psql -U "${POSTGRES_USER:-lawlink}" -d "$RT_DB"   -tAc "$1" 2>/dev/null; }

# 4.1 表集合
T1=$(q_main "select tablename from pg_tables where schemaname='public' order by 1")
T2=$(q_rt   "select tablename from pg_tables where schemaname='public' order by 1")
if [ "$T1" = "$T2" ]; then
  pass "表集合一致（$(echo "$T1" | wc -l | tr -d ' ') 张）"
else
  fail "表集合不一致（主 $(echo "$T1" | wc -l | tr -d ' ') / 恢复 $(echo "$T2" | wc -l | tr -d ' ')）"
fi

# 4.2 每表行数
BADD=0
while IFS= read -r t; do
  [ -z "$t" ] && continue
  a=$(q_main "select count(*) from \"$t\"" || echo "?")
  b=$(q_rt   "select count(*) from \"$t\"" || echo "?")
  if [ "$a" != "$b" ]; then
    fail "行数不一致 ${t}: 主 ${a} → 恢复 ${b}"
    BADD=$((BADD+1))
  fi
done <<< "$T1"
[ "$BADD" -eq 0 ] && pass "全部 $(echo "$T1" | wc -l | tr -d ' ') 张表行数一致"

# 4.3 关键表内容摘要（逐行 md5 的聚合）
BADD=0
for t in User Matter Document AuditLog Client MatterProcedure Contact Receivable Payment; do
  SQL="select coalesce(md5(string_agg(x, '' order by x)),'EMPTY') from (select md5(t::text) as x from \"$t\" t) s"
  a=$(q_main "$SQL" || echo "?")
  b=$(q_rt   "$SQL" || echo "?")
  if [ "$a" != "$b" ]; then
    fail "内容摘要不一致 ${t}: ${a} → ${b}"
    BADD=$((BADD+1))
  fi
done
[ "$BADD" -eq 0 ] && pass "关键表内容摘要一致（含 AuditLog）"

# 4.4 结构对象
CNT_CONSTRAINT="select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public'"
CNT_INDEX="select count(*) from pg_indexes where schemaname='public'"
CNT_TRIG="select count(*) from information_schema.triggers where trigger_schema='public'"
CNT_FUNC="select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'"
for lbl_sql in "约束|$CNT_CONSTRAINT" "索引|$CNT_INDEX" "触发器|$CNT_TRIG" "函数|$CNT_FUNC"; do
  lbl=${lbl_sql%%|*}; sql=${lbl_sql#*|}
  a=$(q_main "$sql" || echo "?"); b=$(q_rt "$sql" || echo "?")
  if [ "${a}" = "${b}" ]; then pass "${lbl} 一致（${a}）"; else fail "${lbl} 不一致：主 ${a} → 恢复 ${b}"; fi
done

# 4.5 序列 last_value（撞号风险）
SEQS=$(q_main "select sequencename from pg_sequences where schemaname='public' order by 1")
if [ -z "$SEQS" ]; then
  pass "无序列（项目用 cuid，不依赖自增）"
else
  BADD=0
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    a=$(q_main "select last_value from \"$s\"" || echo "?"); b=$(q_rt "select last_value from \"$s\"" || echo "?")
    if [ "$a" != "$b" ]; then fail "序列 ${s} last_value 不一致：${a} → ${b}"; BADD=$((BADD+1)); fi
  done <<< "$SEQS"
  [ "$BADD" -eq 0 ] && pass "全部序列 last_value 一致"
fi

# 4.6 存储文件哈希
ST_MAIN="${APP_STORAGE_DIR:-./storage}"
ST_RT="$STORAGE_OUT/storage"
if [ -d "$ST_MAIN" ]; then
  H1=$(cd "$ST_MAIN" && find . -type f ! -name '.gitkeep' -exec shasum -a 256 {} \; 2>/dev/null | LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1)
  H2=$(cd "$ST_RT" 2>/dev/null && find . -type f ! -name '.gitkeep' -exec shasum -a 256 {} \; 2>/dev/null | LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1)
  N1=$(find "$ST_MAIN" -type f ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$H1" = "$H2" ]; then
    pass "存储文件哈希一致（${N1} 个）"
  else
    fail "存储文件哈希不一致（主 ${N1} 个 / 恢复 $(find "$ST_RT" -type f ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ') 个）"
  fi
else
  echo "  ⚠️  跳过存储比对：${ST_MAIN} 不存在"
fi

# ── 5. 结论 ──────────────────────────────────────────────
echo "[5/5] 结论"
if [ "$FAIL" -eq 0 ]; then
  echo ""
  echo "=== 往返演练通过：备份可以被完整恢复 ==="
  exit 0
else
  echo ""
  echo "=== 往返演练失败：上面的 ❌ 项必须先修 ===" >&2
  exit 1
fi
