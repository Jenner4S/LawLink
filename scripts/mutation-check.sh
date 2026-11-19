#!/usr/bin/env bash
#
# 变异验证：故意制造失败，看防护工具有没有拦住。
#
# ## 为什么需要这个脚本
#
# 2026-11-21 两天里发现：**"保真"脚本自己不保真**。
#
#   check-doc-numbers（perl 版）
#     空值替换把「141 files / 1420 passed」改成「141 files /  passed」
#     —— 一个防止文档说谎的脚本自己把数字删掉了
#
#   deploy.sh
#     `npx tsc --noEmit` 后面直接 echo「类型 0 错误」，不判退出码
#     —— tsc 失败时脚本仍然宣称零错误
#
# 两个都是**靠变异验证才发现的**（正向跑永远是通过的）。
# 所以把变异做成可重复执行的脚本，而不是一次性手工作业。
#
# ## 用法
#
#   ./scripts/mutation-check.sh           # 只跑快的（默认）
#   ./scripts/mutation-check.sh --slow    # 含 deploy.sh 变异（每次约 5-10 分钟）
#
# ## 安全约定
#
# 每个变异都会备份原文件，并通过 trap 保证**无论成功失败都恢复**。
# 不 commit、不 push、不写主库。
set -uo pipefail
cd "$(dirname "$0")/.."

SLOW=0
[ "${1:-}" = "--slow" ] && SLOW=1

DOC="docs/DELIVERY-STATUS-20261120.md"
BACKUP_DIR=$(mktemp -d /tmp/lawlink-mutation.XXXXXX)
PASS=0
FAIL=0
trap 'rm -rf "$BACKUP_DIR"' EXIT

# 备份并在退出时恢复（用 trap 保证变异不会留下痕迹）
declare -a RESTORE_PATHS=()
backup() {
  local f="$1"
  local b="$BACKUP_DIR/$(echo "$f" | tr '/' '_')"
  cp "$f" "$b"
  RESTORE_PATHS+=("$f:$b")
}
restore_all() {
  for pair in "${RESTORE_PATHS[@]:-}"; do
    [ -z "$pair" ] && continue
    local f="${pair%%:*}" b="${pair##*:}"
    [ -f "$b" ] && cp "$b" "$f"
  done
}
trap 'restore_all; rm -rf "$BACKUP_DIR"' EXIT

report() {
  local label="$1" expect="$2" actual="$3"
  # 2026-11-21：变量必须用 ${} 包起来。`$label（` 里的全角括号是多字节字符，
  # bash 会把它当成变量名的一部分，报 "unbound variable"。
  # 这是写中文输出时才会踩的坑，脚本一跑就崩在这里。
  if [ "${expect}" = "${actual}" ]; then
    echo "  ✅ ${label}（${actual}）"
    PASS=$((PASS + 1))
  else
    echo "  ❌ ${label}：期望 ${expect}，实际 ${actual}"
    FAIL=$((FAIL + 1))
  fi
}

echo "==> 变异验证（快）"

# ---------------------------------------------------------------
# M1：文档数字写错 → 检查脚本必须发现（退出码 1）
# ---------------------------------------------------------------
echo
echo "[M1] 把文档里的测试数改错，检查脚本应报错"
backup "$DOC"
ORIG=$(node -e '
const fs=require("fs");
const m=fs.readFileSync("docs/DELIVERY-STATUS-20261120.md","utf8").match(/(\d+) passed/);
console.log(m?m[1]:"");
')
if [ -z "$ORIG" ]; then
  echo "  ⚠️ 文档里读不到 passed 数字，跳过 M1"
else
  sed -i.bak "s/${ORIG} passed/9999 passed/g" "$DOC" 2>/dev/null || \
    perl -0pi -e "s/${ORIG} passed/9999 passed/g" "$DOC"
  rm -f "${DOC}.bak"
  node scripts/check-doc-numbers.mjs >/dev/null 2>&1
  report "数字写错时退出码" "1" "$?"
  restore_all
fi

# ---------------------------------------------------------------
# M2：文档数字被删掉 → --fix 必须能补回（这是 perl 版做不到的）
# ---------------------------------------------------------------
echo
echo "[M2] 把文档里的数字删掉，--fix 应补回"
backup "$DOC"
sed -i.bak "s|/ ${ORIG} passed|/  passed|g" "$DOC" 2>/dev/null || \
  perl -0pi -e "s|/ ${ORIG} passed|/  passed|g" "$DOC"
rm -f "${DOC}.bak"
BEFORE=$(node -e '
const fs=require("fs");
console.log((fs.readFileSync("docs/DELIVERY-STATUS-20261120.md","utf8").match(/\d+ passed/)||[""])[0]);
')
if [ -n "$BEFORE" ]; then
  echo "  ⚠️ 数字没删掉（文档可能改过写法），跳过 M2"
else
  node scripts/check-doc-numbers.mjs --fix >/dev/null 2>&1
  AFTER=$(node -e '
const fs=require("fs");
const m=fs.readFileSync("docs/DELIVERY-STATUS-20261120.md","utf8").match(/(\d+) passed/);
console.log(m?m[1]:"");
')
  report "数字被删后 --fix 补回" "$ORIG" "$AFTER"
  restore_all
fi

# ---------------------------------------------------------------
# M3：台账条目数写错 → 检查脚本必须发现
# ---------------------------------------------------------------
echo
echo "[M3] 把台账条目数改错，检查脚本应报错"
backup "$DOC"
LEDGER_N=$(grep -c "^| 2026" docs/BACKLOG-20261118.md)
perl -0pi -e "s/\*\*${LEDGER_N} 条\*\*/**1 条**/g" "$DOC" 2>/dev/null || \
  sed -i.bak "s/\*\*${LEDGER_N} 条\*\*/**1 条**/g" "$DOC"
rm -f "${DOC}.bak"
node scripts/check-doc-numbers.mjs >/dev/null 2>&1
report "台账数写错时退出码" "1" "$?"
restore_all

# ---------------------------------------------------------------
# M4（--slow）：deploy.sh 的静态检查变异
# ---------------------------------------------------------------
if [ "$SLOW" -eq 1 ]; then
  echo
  echo "[M4] 故意引入 tsc 错误，deploy.sh 应明确拦住（慢，要跑完整静态检查）"
  PROBE="src/lib/__mutation_probe.ts"
  backup "$PROBE" 2>/dev/null || true
  printf 'export const __mutationProbe: number = "not a number";\n' > "$PROBE"
  set -a; . ./.env 2>/dev/null; set +a
  ./scripts/deploy.sh --skip-tests >/dev/null 2>&1
  CODE=$?
  rm -f "$PROBE"
  report "tsc 错误时 deploy.sh 退出码" "1" "$CODE"

  echo
  echo "[M5] 故意加 eslint warning，deploy.sh 应明确拦住"
  printf 'export const __mutationProbe2 = 1;\n' > "$PROBE"
  ./scripts/deploy.sh --skip-tests >/dev/null 2>&1
  CODE=$?
  rm -f "$PROBE"
  report "eslint warning 时 deploy.sh 退出码" "1" "$CODE"
else
  echo
  echo "[M4/M5] 跳过 deploy.sh 变异（加 --slow 才跑，每次约 5-10 分钟）"
fi

# ---------------------------------------------------------------
echo
echo "==> 结果：通过 ${PASS}，失败 ${FAIL}"
[ "$FAIL" -eq 0 ] || exit 1
