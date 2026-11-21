#!/usr/bin/env bash
# 门禁稳定性验证（2026-11-23）
#
# ## 为什么需要
#
# 2026-11-23 修掉一个 flaky：`login-lockout` 的「8 路并发」用例
# 在全量并行跑时超过默认 5s（单跑 0.3s），连锁让 `check-doc-numbers`
# 读不到测试数 → 整条门禁红，看起来像"文档写错了"，实际是时序问题。
#
# 那次是一条条撞出来的。这个脚本把"再撞一次"变成主动动作：
# 连跑 N 次测试与金线，把**偶发失败**暴露在交付之前，而不是交付之后。
#
# ## 用法
#
#   ./scripts/stability-check.sh              # 默认 vitest×3 + 金线×2
#   ./scripts/stability-check.sh 5 3          # vitest×5 + 金线×3
#
# ## 局限（如实说）
#
# 通过 ≠ 没有 flaky。样本有限（默认只跑 5 次），
# 只能说明"在本次机器状态下未复现"。真要排查需连续多次 + 单测隔离复跑。
set -uo pipefail

cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export DATABASE_URL="${DATABASE_URL:-postgresql://lawlink:lawlink_dev_2026@localhost:55432/lawlink?schema=public}"

VITEST_RUNS="${1:-3}"
WALK_RUNS="${2:-2}"
FAIL=0

echo "=== vitest 连跑 ${VITEST_RUNS} 次 ==="
for i in $(seq 1 "$VITEST_RUNS"); do
  out=$(timeout 900 npx vitest run 2>&1 | grep -E "^ +Tests +" | tail -1)
  if [[ -z "$out" ]]; then
    echo "  vitest #$i: ❌ 无输出（超时或崩溃）"; FAIL=1
  elif echo "$out" | grep -q "failed"; then
    echo "  vitest #$i: ❌ $out"; FAIL=1
  else
    echo "  vitest #$i: ✅ $out"
  fi
done

echo "=== 真机金线连跑 ${WALK_RUNS} 次 ==="
for i in $(seq 1 "$WALK_RUNS"); do
  out=$(timeout 900 node scripts/acceptance-walkthrough.mjs 2>&1 | grep -E "实测：" | tail -1)
  if echo "$out" | grep -qE "([0-9]+)/\1"; then
    echo "  walkthrough #$i: ✅ $out"
  else
    echo "  walkthrough #$i: ❌ ${out:-无输出}"; FAIL=1
  fi
done

echo "=== 探针残留检查 ==="
left=$(docker exec lawlink-db psql -U lawlink -d lawlink -tAc \
  "select count(*) from \"Lead\" where name like '巡检%'" 2>/dev/null | head -1 | tr -d ' ')
echo "  巡检线索残留：${left:-?}"
[[ "${left:-1}" == "0" ]] || { echo "  ❌ 探针未清理干净"; FAIL=1; }

echo
if [[ $FAIL -eq 0 ]]; then
  echo "✅ 本轮未复现 flaky（注意：样本有限，不等于证明没有）"
else
  echo "❌ 复现了失败，请看上面哪一轮"
fi
exit $FAIL
