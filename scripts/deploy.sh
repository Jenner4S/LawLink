#!/usr/bin/env bash
#
# LawLink 部署脚本
#
# 为什么要有这个脚本：
#   2026-11-20 我踩过两次「以为部署了、其实没部署」：
#     ① docker compose build 打印 "Built" 但 npm run build 其实是失败的
#     ② BUILD_ID 靠手动 export，分两个 shell 执行时第二个拿不到，部署出 buildId=dev
#   而 BUILD_ID=dev 会让「页面已过期」检测失效 —— 用户可能撞到
#   Failed to find Server Action（Server Action ID 随构建变化）。
#
#   所以把「构建 → 三重验证 → 部署 → 复验」固化成一条路径。
#   验证不是可选项：任一步失败就退出，不继续部署。
#
# 用法：
#   ./scripts/deploy.sh              # 完整部署
#   ./scripts/deploy.sh --skip-tests # 跳过测试（只在确认可跳过时用）
#
set -euo pipefail

cd "$(dirname "$0")/.."

SKIP_TESTS=0
[ "${1:-}" = "--skip-tests" ] && SKIP_TESTS=1

BUILD_ID="b$(date +%Y%m%d%H%M%S)"
export BUILD_ID

echo "==> BUILD_ID = ${BUILD_ID}"

# ---------------------------------------------------------------
echo
echo "==> [1/5] 静态检查"
# ---------------------------------------------------------------
# 2026-11-21：原先这一行只写 `npx tsc --noEmit` 然后无条件 echo「类型 0 错误」——
# tsc 失败时脚本仍然宣称零错误，只是靠 set -e 意外退出、没有明确提示。
# 变异验证（故意引入类型错误）发现了它：退出码是 tsc 的 2，日志里只有原始的
# TS2322，看不到「静态检查失败」。现在显式判退出码。
if ! npx tsc --noEmit; then
  echo "    ❌ 类型检查失败，终止。先跑：npx tsc --noEmit" >&2
  exit 1
fi
echo "    类型 0 错误"
if npx eslint src 2>&1 | grep -qE "error|warning"; then
  echo "    ❌ eslint 未归零，终止。先跑：npx eslint src" >&2
  exit 1
fi
echo "    eslint 0 problems"

# ---------------------------------------------------------------
echo
echo "==> [2/5] 测试"
# ---------------------------------------------------------------
if [ "$SKIP_TESTS" -eq 1 ]; then
  echo "    （--skip-tests，已跳过）"
else
  set -a; . ./.env; set +a
  export DATABASE_URL="${DATABASE_URL:-postgresql://lawlink:lawlink_dev_2026@localhost:55432/lawlink?schema=public}"
  if ! npx vitest run 2>&1 | tee /tmp/lawlink-test.log | grep -qE "Test Files.*passed"; then
    echo "    ❌ 测试未全绿，终止。日志：/tmp/lawlink-test.log" >&2
    tail -20 /tmp/lawlink-test.log >&2
    exit 1
  fi
  grep -E "Test Files|Tests " /tmp/lawlink-test.log | sed 's/^/    /'
fi

# ---------------------------------------------------------------
echo
echo "==> [3/5] 应用构建（此步最容易被误判为成功，必须看 exit code）"
# ---------------------------------------------------------------
if ! npm run build >/tmp/lawlink-build.log 2>&1; then
  echo "    ❌ npm run build 失败。日志：/tmp/lawlink-build.log" >&2
  tail -30 /tmp/lawlink-build.log >&2
  exit 1
fi
echo "    build exit=0"

# ---------------------------------------------------------------
echo
echo "==> [4/5] Docker 构建与启动"
# ---------------------------------------------------------------
PREV_IMAGE=$(docker images lawlink-app --format "{{.ID}}" | head -1 || true)
docker compose --profile full build app
# 只重建 app，不动 db ——
# `up -d --force-recreate` 会重建所有服务的容器，包括 postgres。
# 实测（2026-11-20）它确实把 lawlink-db 一起 Recreate 了：数据卷还在所以没丢，
# 但每次部署都重启数据库毫无必要，而且万一哪天卷配置变了就是事故。
# --no-deps 保证 db 若是健康的就原样复用。
docker compose --profile full up -d --force-recreate --no-deps app

echo "    等待健康..."
for i in $(seq 1 30); do
  if curl -s --max-time 3 http://localhost:3000/api/version >/dev/null 2>&1; then break; fi
  sleep 2
done

# ---------------------------------------------------------------
echo
echo "==> [5/5] 三重验证（镜像 ID 变了 / BUILD_ID 是真实值 / 页面可达）"
# ---------------------------------------------------------------
NEW_IMAGE=$(docker images lawlink-app --format "{{.ID}}" | head -1)
ACTUAL_BUILD_ID=$(curl -s --max-time 8 http://localhost:3000/api/version | sed 's/.*"buildId":"\([^"]*\)".*/\1/')

echo "    镜像: ${PREV_IMAGE:-（无）} → ${NEW_IMAGE}"
echo "    BUILD_ID: 期望 ${BUILD_ID}，实际 ${ACTUAL_BUILD_ID}"

FAIL=0
[ "$NEW_IMAGE" = "${PREV_IMAGE:-}" ] && { echo "    ❌ 镜像 ID 未变化，说明没有真正重建" >&2; FAIL=1; }
[ "$ACTUAL_BUILD_ID" = "dev" ] && { echo "    ❌ BUILD_ID 是 dev，进程未拿到构建标识" >&2; FAIL=1; }
[ "$ACTUAL_BUILD_ID" != "$BUILD_ID" ] && { echo "    ❌ BUILD_ID 不匹配（期望 ${BUILD_ID}）" >&2; FAIL=1; }
[ "$FAIL" -eq 1 ] && exit 1

echo
echo "==> 部署完成：${NEW_IMAGE} / ${ACTUAL_BUILD_ID}"
echo "    下一步建议：node scripts/verify-ui.mjs all"
