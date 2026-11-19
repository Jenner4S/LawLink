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

# 探针无效：不算失败也不算通过，单列一类。
#
# 2026-11-21 第 19 条误判就是这种情况：M5 的探针写成 `export const x = 1`，
# 导出的常量不算 unused，eslint 不报 warning，于是 deploy.sh 正常通过，
# 脚本报「M5 失败」—— 错误指向了 deploy.sh，而真正坏的是探针。
#
# 现在探针必须先证明自己能触发信号，否则报「⚠️ 探针无效」并单独计数。
INVALID=0
report_invalid() {
  local label="$1" why="$2"
  echo "  ⚠️ ${label}：探针无效 —— ${why}"
  echo "      （这不是被测对象的问题，是变异脚本自己的问题，本条未计入通过/失败）"
  INVALID=$((INVALID + 1))
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
  # 探针自检：确认文档里真的没有原值了（否则 sed/perl 没生效，测的是原文档）
  if grep -q "${ORIG} passed" "$DOC"; then
    report_invalid "数字写错时退出码" "文档里仍有 ${ORIG} passed，说明替换没生效"
  else
    node scripts/check-doc-numbers.mjs >/dev/null 2>&1
    report "数字写错时退出码" "1" "$?"
  fi
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
  report_invalid "数字被删后 --fix 补回" "文档里仍能读到 \"${BEFORE}\"，说明删除没生效"
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
if grep -q "\*\*${LEDGER_N} 条\*\*" "$DOC"; then
  report_invalid "台账数写错时退出码" "文档里仍是 ${LEDGER_N} 条，说明替换没生效"
else
  node scripts/check-doc-numbers.mjs >/dev/null 2>&1
  report "台账数写错时退出码" "1" "$?"
fi
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
  # 探针自检：先单独跑 tsc，确认探针真的会报类型错误
  if npx tsc --noEmit 2>&1 | grep -q "__mutationProbe"; then
    ./scripts/deploy.sh --skip-tests >/dev/null 2>&1
    CODE=$?
    report "tsc 错误时 deploy.sh 退出码" "1" "$CODE"
  else
    report_invalid "tsc 错误时 deploy.sh 退出码" "探针没让 tsc 报错（__mutationProbe 未出现在输出里）"
  fi
  rm -f "$PROBE"

  echo
  echo "[M5] 故意加 eslint warning，deploy.sh 应明确拦住"
  # 2026-11-21：探针必须是【未使用的局部变量】。
  # 第一版写的是 `export const __mutationProbe2 = 1;` —— 导出的常量不算 unused，
  # eslint 不报 warning，deploy.sh 正常通过，于是脚本误报「M5 失败」。
  # 那是变异脚本自己的 bug，不是 deploy.sh 的问题。
  # 实测确认：`export const x = 1;` 零 warning；`const x = 1; export const keep = 2;` 报 unused。
  printf 'const __mutationProbe2 = 1;\nexport const __keep = 2;\n' > "$PROBE"
  # 探针自检：先单独跑 eslint，确认探针真的会报 warning。
  # 这正是第 19 条误判的补丁 —— 探针无效时必须报「探针无效」，
  # 而不是把 deploy.sh 正常通过误报成「M5 失败」。
  if npx eslint "$PROBE" 2>&1 | grep -q "never used"; then
    ./scripts/deploy.sh --skip-tests >/dev/null 2>&1
    CODE=$?
    report "eslint warning 时 deploy.sh 退出码" "1" "$CODE"
  else
    report_invalid "eslint warning 时 deploy.sh 退出码" "探针没触发 eslint warning"
  fi
  rm -f "$PROBE"
else
  echo
  echo "[M4/M5] 跳过 deploy.sh 变异（加 --slow 才跑，每次约 5-10 分钟）"
fi

# ---------------------------------------------------------------
# [S1] 脚本语言细节守卫（2026-11-21）
#
# `$var` 后面紧跟全角字符（（）：、等）时，bash 在部分 locale 下会把多字节
# 字符并入变量名，报 "xxx?: unbound variable"，脚本在那一行崩掉。
# 这是写中文输出时才会踩的坑 —— 2026-11-21 一轮之内连踩两次（backup.sh、
# drill-backup-restore.sh），第一次还让脚本**错误地返回了 0**。
# 规则：变量紧邻中文标点时一律用 ${var}。
echo
echo "[S1] 扫描 scripts/*.sh 中「\$var 紧跟全角字符」"
S1_BAD=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "  ❌ ${hit}"
  S1_BAD=$((S1_BAD+1))
done < <(python3 - <<'PYSCAN'
import pathlib, re
pat = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)([\u3000-\u303f\uff00-\uffef])")
for f in sorted(pathlib.Path("scripts").glob("*.sh")):
    for i, line in enumerate(f.read_text().split("\n"), 1):
        if line.lstrip().startswith("#"):
            continue
        for m in pat.finditer(line):
            print(f"{f.as_posix()}:{i}  ${m.group(1)}{m.group(2)}")
PYSCAN
)
report "S1 脚本无全角标点吞变量名" "0" "${S1_BAD}"

# [S2] 文档里的迁移条数必须与实际一致（2026-11-21）
#
# 起因：README 长期写「migrate deploy 建 12 个迁移的表结构」，实际已是 15 条。
# 数字漂移不报错、不影响运行，但它会误导第一次部署的人去数到底该有几条 ——
# 而「文档说 12、实际 15」正是让人怀疑「是不是漏跑了三条」的开始。
# check-doc-numbers.mjs 只核 DELIVERY-STATUS 一份，README 这类说明文档不在范围内，
# 所以这里补一道轻量守卫：只扫「描述当前状态」的文档（见下方白名单说明）。
echo
echo "[S2] 核对文档中的迁移条数"
ACTUAL_MIGRATIONS=$(ls -d prisma/migrations/*/ 2>/dev/null | wc -l | tr -d ' ')
S2_BAD=0
while IFS= read -r hit; do
  [ -z "$hit" ] && continue
  echo "  ❌ ${hit}"
  S2_BAD=$((S2_BAD+1))
done < <(python3 - "${ACTUAL_MIGRATIONS}" <<'PYSCAN'
import pathlib, re, sys
actual = int(sys.argv[1])
# 两种语序都要覆盖：
#   ①「建 12 个迁移的表结构」  —— 数字在前（旧写法）
#   ②「全部迁移（当前 15 条）」 —— 迁移在前（2026-11-21 改写后的写法）
# 第一次写这条守卫时只覆盖 ①；README 换了措辞后它变成**静默空转** ——
# 变异测试（把 15 改回 12）居然不报才发现。所以加了 checked 计数：
# 一个断言都没跑到时报「守卫无效」，而不是「通过」。
pat = re.compile(r"(\d+)\s*(?:个|条)\s*迁移|迁移[（(]当前\s*(\d+)\s*条")
checked = 0
# **只核「描述当前状态」的文档**，不核历史记录。
#
# README 与 DELIVERY-STATUS 说的是「现在有几条迁移」，写错会误导第一次部署的人。
# 而审计报告（SYSTEM-AUDIT-*）、发布验证（RELEASE-VALIDATION-*）、
# 逐日台账（BACKLOG-*）里的数字是**当时的事实**，改它等于篡改历史 ——
# 2026-11-21 首次跑这条守卫时，三处命中全是这类历史文档（写 12 / 3 / 73 条），
# 一条都不该改。所以这里用白名单而不是全目录扫描。
docs = [pathlib.Path("README.md")] + sorted(pathlib.Path("docs").glob("DELIVERY-STATUS-*.md"))
for f in docs:
    if not f.exists():
        continue
    for i, line in enumerate(f.read_text().split("\n"), 1):
        for m in pat.finditer(line):
            checked += 1
            n = int(m.group(1) or m.group(2))
            if n != actual:
                print(f"{f.as_posix()}:{i}  写 {n} 条，实际 {actual} 条")
if checked == 0:
    print("__NO_ASSERTION__ 没有匹配到任何「迁移条数」表述 —— 守卫空转")
PYSCAN
)
report "S2 文档迁移条数一致" "0" "${S2_BAD}"

echo
echo "==> 结果：通过 ${PASS}，失败 ${FAIL}，探针无效 ${INVALID}"
# 探针无效也返回非零：它意味着「本次没验成」，不能当通过。
[ "$FAIL" -eq 0 ] && [ "$INVALID" -eq 0 ] || exit 1
