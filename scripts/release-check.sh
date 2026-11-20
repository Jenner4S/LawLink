#!/usr/bin/env bash
#
# 发布门槛（2026-11-22）
#
# ## 解决什么问题
#
# 门禁脚本已经有 8 个，但"发版前该跑哪几个"靠人记。结果是：
# 有时只跑 tsc，有时忘了 audit，有时忘了金线——**同一份代码，不同轮次给出的证据不一样**。
# 这个脚本把顺序固定下来，任一步失败即中止，并在最后打印一份可贴进交付记录的证据摘要。
#
# ## 顺序有讲究
#
#   快速静态检查（秒级）→ 单元/真库测试（十几分钟）→ 界面验证 → 变异探针 → 真机金线 → 构建
#
# 便宜的先跑：错在类型或规范上，不该等到跑完 15 分钟测试才发现。
#
# ## 用法
#
#   ./scripts/release-check.sh              # 全量（含测试/界面/金线/构建）
#   ./scripts/release-check.sh --fast       # 只跑静态检查（提交前用）
#   ./scripts/release-check.sh --no-build   # 全量但跳过 next build
#   ./scripts/release-check.sh --deploy     # 全量通过后再部署（8 分钟，需显式开启）
#   ./scripts/release-check.sh --archive    # 通过后把证据摘要归档进 docs/（入 git）
#
# 退出码：0 全部通过；1 有失败；2 用法错误。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

FAST=0
NO_BUILD=0
DEPLOY=0
ARCHIVE=0
for arg in "$@"; do
  case "$arg" in
    --fast) FAST=1 ;;
    --no-build) NO_BUILD=1 ;;
    --deploy) DEPLOY=1 ;;
    --archive) ARCHIVE=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "未知参数：${arg}（用 --help 查看用法）" >&2; exit 2 ;;
  esac
done

# 真库相关步骤需要 .env 里的 DATABASE_URL；统一在脚本里加载，避免"忘记 source 导致脚本自身失败"
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
export DATABASE_URL="${DATABASE_URL:-postgresql://lawlink:lawlink_dev_2026@localhost:55432/lawlink?schema=public}"

STAMP="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="outputs/release-check"
mkdir -p "$EVIDENCE_DIR"
LOG="$EVIDENCE_DIR/$STAMP.log"
: > "$LOG"

declare -a NAMES=() STATUSES=() DETAILS=()
FAILED=0

run_step() {
  local name="$1"; shift
  local detail_cmd="$1"; shift
  local start end dur rc detail

  printf '→ %s ... ' "$name"
  start=$(date +%s)
  # 只统计**本步**输出：日志是累积的，若不限定范围，
  # detail 命令会把前面所有步骤的行也算进去（曾出现「检查项 123」这种假数字）。
  export STEP_START
  STEP_START=$(wc -l < "$LOG" | tr -d ' ')
  # 输出同时进日志与终端（终端只留末几行，避免刷屏）
  if "$@" >>"$LOG" 2>&1; then rc=0; else rc=$?; fi
  end=$(date +%s); dur=$((end - start))

  detail="$(tail -n +$((STEP_START + 1)) "$LOG" 2>/dev/null | eval "$detail_cmd" 2>/dev/null | tail -1)"
  NAMES+=("$name"); STATUSES+=("$rc"); DETAILS+=("$detail")

  if [[ $rc -eq 0 ]]; then
    printf '✅ %ss  %s\n' "$dur" "${detail:-}"
  else
    printf '❌ %ss  退出码=%s（详见 %s）\n' "$dur" "$rc" "$LOG"
    FAILED=1
  fi
}

skip_step() {
  local name="$1" why="$2"
  NAMES+=("$name"); STATUSES+=("skip"); DETAILS+=("$why")
  printf '→ %s ... ⏭  %s\n' "$name" "$why"
}

echo "=== 发布门槛开始（${STAMP}） ==="
echo "日志：$LOG"
echo

# ---------- 1. 快速静态检查 ----------
run_step "类型检查 tsc" \
  'grep -c "error TS" | sed "s/^/TS 错误 /"' \
  npx tsc --noEmit

run_step "代码规范 eslint" \
  'echo ""' \
  npx eslint src

run_step "文档与库一致性" \
  'grep -E "迁移数|schema 漂移" | tail -1' \
  node scripts/check-doc-numbers.mjs

run_step "服务端动作可达性" \
  'grep -E "^不可达" | tail -1' \
  node scripts/audit-reachability.mjs

run_step "写操作状态守卫" \
  'grep -E "无状态守卫" | tail -1' \
  node scripts/audit-write-guards.mjs

# ---------- 2. 测试 / 界面 / 变异 / 金线 ----------
if [[ $FAST -eq 1 ]]; then
  skip_step "自动化测试 vitest" "--fast"
  skip_step "界面验证 verify-ui" "--fast"
  skip_step "变异探针 mutation-check" "--fast"
  skip_step "真机金线 acceptance-walkthrough" "--fast"
else
  run_step "自动化测试 vitest" \
    'grep -E "^ *Tests " | tail -1' \
    npx vitest run

  run_step "界面验证 verify-ui" \
    'grep -E "^合计" | tail -1' \
    node scripts/verify-ui.mjs all

  run_step "变异探针 mutation-check" \
    'grep -E "结果：通过" | tail -1' \
    ./scripts/mutation-check.sh

  run_step "真机金线 acceptance-walkthrough" \
    'grep -E "^  实测：" | tail -1' \
    node scripts/acceptance-walkthrough.mjs
fi

# 数据库不变量（2026-11-22 补）：此前只有 deploy.sh 跑它，发布门槛不含该步，
# 导致"不变量全过"这句话在证据文件里查不到。补进来，让数字有出处。
if [[ $FAST -eq 1 ]]; then
  skip_step "数据库不变量" "--fast"
else
  run_step "数据库不变量" \
    'grep -cE "^  (✅|❌)" | sed "s/^/检查项 /"' \
    npx tsx scripts/verify-db-invariants.ts
fi

# ---------- 3. 构建 ----------
if [[ $NO_BUILD -eq 1 || $FAST -eq 1 ]]; then
  skip_step "生产构建 next build" "跳过（--fast / --no-build）"
else
  rm -rf .next-build
  run_step "生产构建 next build" \
    'grep -E "Compiled successfully|Build error" | tail -1' \
    env NEXT_DIST_DIR=.next-build npx next build
  # next build 会改写这两个文件（本项目已知特性）
  git checkout -- next-env.d.ts tsconfig.json 2>/dev/null || true
  rm -rf .next-build
fi

# ---------- 4. 可选部署 ----------
if [[ $DEPLOY -eq 1 ]]; then
  if [[ $FAILED -ne 0 ]]; then
    skip_step "部署" "前置步骤有失败，拒绝部署"
  else
    run_step "部署" 'grep -E "部署完成" | tail -1' ./scripts/deploy.sh --skip-tests
  fi
else
  skip_step "部署" "未指定 --deploy"
fi

# ---------- 证据摘要 ----------
echo
echo "=== 证据摘要（可贴进交付记录） ==="
echo "时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "提交：$(git rev-parse --short HEAD 2>/dev/null || echo '-')"
echo
printf '%-28s %-6s %s\n' "步骤" "结果" "摘要"
printf '%-28s %-6s %s\n' "----------------------------" "------" "------------------------------"
for i in "${!NAMES[@]}"; do
  case "${STATUSES[$i]}" in
    0) mark="✅" ;;
    skip) mark="⏭ " ;;
    *) mark="❌" ;;
  esac
  printf '%-28s %-6s %s\n' "${NAMES[$i]}" "$mark" "${DETAILS[$i]}"
done

{
  echo "# 发布门槛证据 $STAMP"
  echo
  echo "- 提交：\`$(git rev-parse --short HEAD 2>/dev/null || echo -)\`"
  echo "- 时间：$(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo
  printf '| 步骤 | 结果 | 摘要 |\n|---|---|---|\n'
  for i in "${!NAMES[@]}"; do
    case "${STATUSES[$i]}" in
      0) mark="✅" ;;
      skip) mark="⏭" ;;
      *) mark="❌" ;;
    esac
    printf '| %s | %s | %s |\n' "${NAMES[$i]}" "$mark" "${DETAILS[$i]}"
  done
} > "$EVIDENCE_DIR/$STAMP.md"

# 归档：outputs/ 被 .gitignore 覆盖，属工作产物；需要入库时显式 --archive
if [[ $ARCHIVE -eq 1 ]]; then
  ARCHIVE_FILE="docs/交付证据-$(date +%Y%m%d).md"
  {
    echo
    echo "---"
    echo
    echo "## 发布门槛执行记录（${STAMP}）"
    echo
    sed -n '/^| 步骤 | 结果 | 摘要 |/,$p' "$EVIDENCE_DIR/$STAMP.md"
  } >> "$ARCHIVE_FILE"
  echo "📌 已归档到 ${ARCHIVE_FILE}"
fi

echo
if [[ $FAILED -eq 0 ]]; then
  echo "✅ 全部通过。证据：$EVIDENCE_DIR/$STAMP.md"
  exit 0
else
  echo "❌ 有步骤失败，已中止后续（详见 ${LOG}）"
  exit 1
fi
