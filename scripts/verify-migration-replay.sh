#!/bin/bash
# LawLink 迁移链从零重放验证（2026-11-21）
#
# ## 为什么需要这个脚本
#
# 「迁移链能否从零重放」是一个**只会在两种时刻暴露**的性质：
#   · 新律所第一次部署（`migrate deploy` 于空库）
#   · 灾难恢复（把备份恢复到全新的库）
#
# 而它平时看起来永远是好的 —— 因为开发机上的库是**逐条迁移累积**出来的，
# 累积路径与「从零重放」是两条不同的路。历史上有过教训：
# 2026-09-19 业务重建时迁移记录是手工登记的，导致链条无法从零重放
# （报 `FeeEntry.confirmState` 不存在），2026-09-21 用 0_init 基线重建解决。
#
# 那次重建之后没有留下**可重复**的验证手段 —— 本脚本补上。
#
# ## 做什么
#
#   1. 建一个全新的空库
#   2. 在空库上 `prisma migrate deploy`（只用仓库里的迁移，不碰任何现有库）
#   3. 与参照库做 `prisma migrate diff`：**必须输出 "This is an empty migration"**
#   4. 逐项比对表/约束/索引/触发器/函数数量
#   5. 在重放库上跑应用级不变量检查（证明 schema 能被现有代码使用）
#   6. DROP 重放库
#
# ## 用法
#
#   ./scripts/verify-migration-replay.sh                 # 参照库 = .env 里的主库
#   REFERENCE_DB=lawlink_prod ./scripts/verify-migration-replay.sh
#
# 退出码: 0 = 零漂移且不变量通过；1 = 有差异；2 = 脚本自身失败

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  source .env
fi
if [ -z "${DATABASE_URL:-}" ] && [ -n "${POSTGRES_USER:-}" ]; then
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD:-}@localhost:${POSTGRES_PORT:-55432}/${POSTGRES_DB:-lawlink}?schema=public"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "错误: 未找到 DATABASE_URL（也没有 POSTGRES_* 可拼）" >&2
  exit 2
fi

DB_CONTAINER="${DB_CONTAINER:-lawlink-db}"
PG_USER="${POSTGRES_USER:-lawlink}"
REF_DB="${REFERENCE_DB:-$(echo "$DATABASE_URL" | sed -E 's/.*\/([^?]+).*/\1/')}"
RT_DB="lawlink_replay_$(date +%Y%m%d%H%M%S)"
BASE="postgresql://${PG_USER}:${POSTGRES_PASSWORD:-}@localhost:${POSTGRES_PORT:-55432}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/lawlink-replay.XXXXXX")

FAIL=0
fail() { echo "  ❌ $*"; FAIL=1; }
pass() { echo "  ✅ $*"; }

cleanup() {
  docker exec "$DB_CONTAINER" psql -U "$PG_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$RT_DB\" WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== 迁移链从零重放验证 ==="
echo "参照库: ${REF_DB}    重放库: ${RT_DB}"
echo "迁移条数: $(ls -d prisma/migrations/*/ 2>/dev/null | wc -l | tr -d ' ')"
echo ""

# ── 1. 建空库 ────────────────────────────────────────────
echo "[1/5] 建空库"
if ! docker exec "$DB_CONTAINER" psql -U "$PG_USER" -d postgres \
     -c "CREATE DATABASE \"$RT_DB\"" >/dev/null 2>&1; then
  echo "  ❌ 建库失败（容器 ${DB_CONTAINER} 是否在跑？）" >&2
  exit 2
fi
pass "空库已建"

# ── 2. 从零 deploy ───────────────────────────────────────
echo "[2/5] 在空库上 prisma migrate deploy"
if ! DATABASE_URL="${BASE}/${RT_DB}?schema=public" \
     npx prisma migrate deploy > "$WORK/deploy.log" 2>&1; then
  echo "  ❌ 迁移链无法从零重放。日志尾部：" >&2
  tail -20 "$WORK/deploy.log" >&2
  exit 1
fi
pass "全部迁移应用成功"

# ── 3. schema diff ───────────────────────────────────────
echo "[3/5] 重放库 vs 参照库 schema 差异"
if ! npx prisma migrate diff \
     --from-url "${BASE}/${RT_DB}?schema=public" \
     --to-url "${BASE}/${REF_DB}?schema=public" \
     --script > "$WORK/diff.sql" 2>"$WORK/diff.err"; then
  echo "  ❌ migrate diff 失败：" >&2
  tail -10 "$WORK/diff.err" >&2
  exit 2
fi
# 空差异时 Prisma 输出 "This is an empty migration."
if grep -q "This is an empty migration" "$WORK/diff.sql"; then
  pass "零漂移（diff 为空）"
else
  fail "存在漂移，差异见 ${WORK}/diff.sql（本次保留）"
  cp "$WORK/diff.sql" "/tmp/lawlink-replay-diff-$(date +%s).sql"
  echo "     已另存到 /tmp，便于排查" >&2
fi

# ── 4. 对象计数 ──────────────────────────────────────────
echo "[4/5] 结构对象计数"
cnt() { docker exec "$DB_CONTAINER" psql -U "$PG_USER" -d "$1" -tAc "$2" 2>/dev/null; }
for pair in \
  "表|select count(*) from pg_tables where schemaname='public'" \
  "约束|select count(*) from pg_constraint c join pg_class t on t.oid=c.conrelid join pg_namespace n on n.oid=t.relnamespace where n.nspname='public'" \
  "索引|select count(*) from pg_indexes where schemaname='public'" \
  "触发器|select count(*) from information_schema.triggers where trigger_schema='public'" \
  "函数|select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'"; do
  lbl=${pair%%|*}; sql=${pair#*|}
  a=$(cnt "$REF_DB" "$sql"); b=$(cnt "$RT_DB" "$sql")
  if [ "${a}" = "${b}" ]; then pass "${lbl} ${a}"; else fail "${lbl}: 参照 ${a} / 重放 ${b}"; fi
done

# ── 5. 应用级不变量 ──────────────────────────────────────
echo "[5/5] 在重放库上跑应用级不变量"
if DATABASE_URL="${BASE}/${RT_DB}?schema=public" \
   npx tsx scripts/verify-db-invariants.ts > "$WORK/inv.log" 2>&1; then
  pass "重放库可通过应用级不变量检查"
else
  RC=$?
  if [ "$RC" -eq 2 ]; then
    fail "不变量脚本自身没跑成（不是数据问题）"
  else
    fail "重放库有不变量被破坏（空库本不该有）："
    grep -E "❌" "$WORK/inv.log" | head -5 | sed 's/^/     /'
  fi
fi

# ── 结论 ─────────────────────────────────────────────────
echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "=== 迁移链可从零重放，且与参照库零漂移 ==="
  exit 0
else
  echo "=== 重放验证失败（见上方 ❌） ===" >&2
  exit 1
fi
