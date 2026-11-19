#!/usr/bin/env bash
#
# 核对交付文档里的数字与实际是否一致。
#
# 为什么要它：文档里的数字是手写的，每次加测试/加台账条目都会落后。
# 2026-11-21 就发现「测试 1399 vs 实际 1420」「台账 313 vs 实际 387」都过期了。
# 手动同步必然会漏，所以做成可随时执行的核对。
#
# 用法：./scripts/check-doc-numbers.sh
# 退出码：0 = 一致，1 = 有不一致（打印差异）
set -uo pipefail
cd "$(dirname "$0")/.."

FIX=0
[ "${1:-}" = "--fix" ] && FIX=1

DOC="docs/DELIVERY-STATUS-20261120.md"
LEDGER="docs/BACKLOG-20261118.md"
FAIL=0

# 1) 测试数
set -a; . ./.env 2>/dev/null; set +a
export DATABASE_URL="${DATABASE_URL:-postgresql://lawlink:lawlink_dev_2026@localhost:55432/lawlink?schema=public}"
ACTUAL=$(npx vitest run 2>&1 | grep -oE "Tests +[0-9]+ passed" | grep -oE "[0-9]+" | head -1)
DOCN=$(grep -oE "[0-9]+ passed" "$DOC" | grep -oE "[0-9]+" | head -1)
printf "  测试数    文档 %-6s 实际 %-6s " "${DOCN:-?}" "${ACTUAL:-?}"
if [ "${DOCN:-0}" = "${ACTUAL:-1}" ]; then echo "✅"; else echo "❌"; FAIL=1; fi

# 2) 台账条目
ACTUAL_L=$(grep -c "^| 2026" "$LEDGER")
DOC_L=$(grep -oE "\*\*[0-9]+ 条\*\*" "$DOC" | grep -oE "[0-9]+" | head -1)
printf "  台账条目  文档 %-6s 实际 %-6s " "${DOC_L:-?}" "${ACTUAL_L:-?}"
if [ "${DOC_L:-0}" = "${ACTUAL_L:-1}" ]; then echo "✅"; else echo "❌"; FAIL=1; fi

# 3) 迁移数
ACTUAL_M=$(ls prisma/migrations/*/migration.sql 2>/dev/null | wc -l | tr -d ' ')
DOC_M=$(grep -oE "\*\*[0-9]+ 个迁移\*\*" "$DOC" | grep -oE "[0-9]+" | head -1)
printf "  迁移数    文档 %-6s 实际 %-6s " "${DOC_M:-?}" "${ACTUAL_M:-?}"
if [ "${DOC_M:-0}" = "${ACTUAL_M:-1}" ]; then echo "✅"; else echo "❌"; FAIL=1; fi

# 4) schema 漂移
DRIFT=$(npx prisma migrate diff --from-schema-datasource prisma/schema.prisma \
        --to-schema-datamodel prisma/schema.prisma --script 2>&1 | head -1)
printf "  schema 漂移 %-28s " "${DRIFT:0:26}"
echo "$DRIFT" | grep -q "empty migration" && echo "✅" || { echo "❌"; FAIL=1; }

# ---------------------------------------------------------------
# --fix：把测得的实际值写回文档
#
# 为什么需要它：文档里的数字是「快照」，台账是「流水」。
# 每加一条台账，快照就落后一条 —— 光靠检查会陷入
# 「改准 → 又加一条 → 又不准」的循环（2026-11-21 连踩两次）。
# 让它自动同步，人就不用记着改。
# ---------------------------------------------------------------
if [ "$FIX" -eq 1 ]; then
  # 2026-11-21 自伤修复：原先无条件替换，若某个 ACTUAL_* 为空（提取失败），
  # perl 的 s/\d+ passed/${ACTUAL} passed/g 会变成 s/\d+ passed/ passed/g
  # ——**把数字删掉**。实测把 "141 files / 1420 passed" 改成 "141 files /  passed"。
  # 现在每一项都先判空，空了就跳过并报错，绝不写入。
  FIXED=0
  if [ -n "${ACTUAL_L}" ]; then
    perl -0pi -e "s/\*\*\d+ 条\*\*/\*\*${ACTUAL_L} 条\*\*/g" "$DOC"; FIXED=1
  else
    echo "  ⚠️ 台账条目提取失败，跳过该项（不写入空值）" >&2
  fi
  if [ -n "${ACTUAL}" ]; then
    perl -0pi -e "s/\d+ passed/${ACTUAL} passed/g" "$DOC"; FIXED=1
  else
    echo "  ⚠️ 测试数提取失败，跳过该项（不写入空值）" >&2
  fi
  if [ -n "${ACTUAL_M}" ]; then
    perl -0pi -e "s/\*\*\d+ 个迁移\*\*/\*\*${ACTUAL_M} 个迁移\*\*/g" "$DOC"; FIXED=1
  else
    echo "  ⚠️ 迁移数提取失败，跳过该项（不写入空值）" >&2
  fi
  [ "$FIXED" -eq 0 ] && { echo "  ❌ 三项都没提取到，未做任何修改" >&2; exit 1; }
  echo
  echo "  --fix 已写回文档。本次核对结果即为准；"
  echo "  如需复核，直接重跑本脚本（会重新跑一遍测试，约几分钟）。"
  exit 0
fi

exit $FAIL
