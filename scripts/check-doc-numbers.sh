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

exit $FAIL
