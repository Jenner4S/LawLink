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

# 2026-11-21：允许外部覆盖，否则第 5 步的三项验证【不可测】。
# 原来无条件生成，导致想验证「BUILD_ID=dev 时能不能拦住」根本做不到 ——
# 传进去的 dev 会被这里覆盖掉。可测性不是装饰：不可测的检查等于没检查。
BUILD_ID="${BUILD_ID:-b$(date +%Y%m%d%H%M%S)}"
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
# 写守卫一致性审计（2026-11-21）：涉及案件的写操作有没有状态守卫。
# 2026-11-21 两天里连着抓到三处「同一条规则、不同写路径各行其是」——
# 材料版本切换、已归档案件的关联关系、已归档案件的证据项。
# 有豁免清单，只对**新增**的漏网报错；每次部署跑一次，防止再长出第四处。
if ! node scripts/audit-write-guards.mjs | tail -2; then
  echo "    ❌ 写守卫审计发现未登记的新漏网，终止。先跑：node scripts/audit-write-guards.mjs --list" >&2
  exit 1
fi
# Server Action 可达性审计（2026-11-21）：清死代码时发现 `fileDocument`
# 是一个 26 行、有权限校验、有审计、有测试的完整动作，却**全仓零调用方**。
# 「导出即能力」是错觉 —— 全量盘点 403 个导出里 63 个前端点不到。
# 基线棘轮：只对超出基线的新名字报警，防止这类「用户点不到的能力」继续增长。
if ! node scripts/audit-reachability.mjs | tail -2; then
  echo "    ❌ 可达性审计发现新的零引用动作，终止。先跑：node scripts/audit-reachability.mjs --list" >&2
  exit 1
fi
# 钱链路审计覆盖（2026-11-22）：写钱表的函数必须写审计 —— 合规红线。
# 起因：开票申请（钱 + 税的起点）提交那一步既不写审计也不写时间线，
# 而批准/驳回/开具三条路径都有 approvalAudit。
if ! node scripts/audit-money-writes.mjs | tail -2; then
  echo "    ❌ 有写钱操作未写审计，终止。先跑：node scripts/audit-money-writes.mjs --list" >&2
  exit 1
fi

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

# 构建期网络（2026-11-21）：Alpine 官方 CDN 与 npm registry 在中国大陆常不可达
# （实测 alpinelinux CDN / npmjs / github 全部超时，aliyun / tuna 正常）。
# Dockerfile 已把镜像源做成 build arg，默认仍是官方源；这里把环境变量透传过去，
# 需要时这样部署：
#   ALPINE_MIRROR=mirrors.aliyun.com NPM_REGISTRY=https://registry.npmmirror.com ./scripts/deploy.sh
BUILD_ARGS=()
if [ -n "${ALPINE_MIRROR:-}" ]; then BUILD_ARGS+=(--build-arg "ALPINE_MIRROR=${ALPINE_MIRROR}"); fi
if [ -n "${NPM_REGISTRY:-}" ]; then BUILD_ARGS+=(--build-arg "NPM_REGISTRY=${NPM_REGISTRY}"); fi
docker compose --profile full build "${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"}" app
# 只重建 app，不动 db ——
# `up -d --force-recreate` 会重建所有服务的容器，包括 postgres。
# 实测（2026-11-20）它确实把 lawlink-db 一起 Recreate 了：数据卷还在所以没丢，
# 但每次部署都重启数据库毫无必要，而且万一哪天卷配置变了就是事故。
# --no-deps 保证 db 若是健康的就原样复用。
docker compose --profile full up -d --force-recreate --no-deps app

# ─────────────────────────────────────────────────────────────
# 数据库迁移（2026-11-21 补）
#
# 此前本脚本**只构建和启动容器，完全不碰数据库** —— 容器 CMD 也只是
# `npm run start`。于是「全新部署跑 deploy.sh」得到的是一台空库上的应用：
# 每个页面都报表不存在、也没有任何账号能登录。
# README 里有手工的两步（migrate deploy / db seed），但脚本名字叫 deploy
# 却不做完整部署，这就是个陷阱 —— 而且只在第一次部署时咬人。
#
# 这里补上迁移：`migrate deploy` 是幂等的，已是最新时只说「无需操作」，
# 所以每次部署都跑是安全的，还能顺带避免「应用已新、库仍旧」这种经典事故。
#
# **不自动 seed**：seed 会创建默认管理员（默认密码）并写入模板/用章配置，
# 这两件事都不该在无人值守的部署里悄悄发生。改为**检测并明确报错**，
# 让第一次部署的人知道下一步该做什么 —— 而不是拿到一台打不开的系统。
# 迁移前先看有没有待办迁移，以及库里有没有数据。
#
# 2026-11-21（Round 140）：本脚本从 Round 138 起会在部署时自动跑
# `migrate deploy`。这解决了「脚本叫 deploy 却不建表」，但也带来一个新风险：
# **自动改结构而没有自动备份**。迁移一旦失败或存在破坏性变更，律所的数据就
# 处在一个没有回退点的状态 —— 而备份脚本明明就在同一个镜像里。
#
# 规则：有待办迁移 **且** 库里已有用户（即这是一次升级，不是首次安装）
# → 先备份；备份失败就**终止部署**，绝不在没有回退点的情况下动结构。
USER_COUNT=$(docker exec lawlink-db psql -U "${POSTGRES_USER:-lawlink}" -d "${POSTGRES_DB:-lawlink}" \
  -tAc 'select count(*) from "User"' 2>/dev/null | tr -d ' ' || echo "")

PENDING_MIGRATIONS=0
if docker exec lawlink-app npx prisma migrate status 2>&1 | grep -q "have not yet been applied"; then
  PENDING_MIGRATIONS=1
fi

if [ "${PENDING_MIGRATIONS}" = "1" ] && [ "${USER_COUNT}" != "0" ] && [ -n "${USER_COUNT}" ]; then
  PRE_TS=$(date +%Y%m%d%H%M%S)
  echo "    检测到待办迁移，先做迁移前备份..."
  if ! docker exec lawlink-app ./scripts/backup.sh "/app/backups/pre-migrate-${PRE_TS}" 2>&1 | tail -4; then
    echo "    ❌ 迁移前备份失败 —— 终止部署。" >&2
    echo "       不允许在没有回退点的情况下改表结构。请先手工确认备份可用：" >&2
    echo "         docker exec -it lawlink-app ./scripts/backup.sh /app/backups/manual-${PRE_TS}" >&2
    exit 1
  fi
  echo "    迁移前备份完成：/app/backups/pre-migrate-${PRE_TS}"
fi

echo "    数据库迁移..."
if ! docker exec lawlink-app npx prisma migrate deploy 2>&1 | tail -3; then
  echo "    ❌ 数据库迁移失败，终止部署" >&2
  exit 1
fi

# 数据不变量体检（2026-11-22）
#
# `scripts/verify-db-invariants.ts` 早就有（Round 137），Round 151 又加了
# 两条跨表一致性（结案案件无未办结事项、归档记录与案件状态同步）。
# 但**它此前只是我手动跑的脚本** —— 验证手段不进流程，等于不存在。
#
# 跑在**宿主机**而不是容器里：生产镜像的 tsx 属构建副产物，不该成为运维依赖。
# 宿主机必然有 node_modules（本脚本刚在上面跑过 tsc 与测试）。
#
# 判定：
#   退出 0 = 全部通过（审计链的历史遗留断点记 ⚠️，不算违反，不阻塞）
#   退出 1 = 有真实数据违反 → 终止部署，但留 SKIP_INVARIANTS=1 逃生门
#   退出 2 = 脚本自身没跑成（不是数据问题），单独提示，同样终止
if [ "${SKIP_INVARIANTS:-}" = "1" ]; then
  echo "    （SKIP_INVARIANTS=1，已跳过数据不变量检查）"
else
  echo "    数据不变量体检..."
  INV_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER:-lawlink}:${POSTGRES_PASSWORD:-}@localhost:${POSTGRES_PORT:-55432}/${POSTGRES_DB:-lawlink}?schema=public}"
  INV_LOG=/tmp/lawlink-invariants.log
  INV_RC=0
  DATABASE_URL="$INV_URL" npx tsx scripts/verify-db-invariants.ts > "$INV_LOG" 2>&1 || INV_RC=$?
  if [ "$INV_RC" -eq 0 ]; then
    grep -cE "^  ✅" "$INV_LOG" | xargs -I{} echo "    不变量 {} 项全过"
    grep -E "^  ⚠️" "$INV_LOG" | sed 's/^/  /' || true
  elif [ "$INV_RC" -eq 2 ]; then
    echo "    ❌ 不变量脚本自身没跑成（不是数据问题），终止。日志：${INV_LOG}" >&2
    tail -5 "$INV_LOG" >&2
    exit 1
  else
    echo "    ❌ 数据库存在不变量违反，终止部署：" >&2
    grep -E "^  ❌" "$INV_LOG" | head -10 | sed 's/^/  /' >&2
    echo "       排查后可临时跳过：SKIP_INVARIANTS=1 ./scripts/deploy.sh ..." >&2
    echo "       日志：${INV_LOG}" >&2
    exit 1
  fi
fi
if [ "${USER_COUNT}" = "0" ]; then
  echo "" >&2
  echo "    ❌ 数据库里没有任何用户 —— 应用虽然起来了，但没有人能登录。" >&2
  echo "       首次部署必须初始化基础数据（管理员 / 案由 / 阶段模板 / 期限规则）：" >&2
  echo "" >&2
  echo "         docker exec -it lawlink-app npx prisma db seed" >&2
  echo "" >&2
  echo "       默认管理员 admin@lawlink.local / ChangeMe!2026，登录后立即改密码。" >&2
  echo "       已有数据时不要重跑 seed：密码不会被覆盖，但模板配置可能被刷新。" >&2
  echo "" >&2
  exit 1
fi

echo "    等待健康..."
HEALTHY=0
for i in $(seq 1 30); do
  if curl -s --max-time 3 http://localhost:3000/api/version >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 2
done
# 2026-11-21：原来超时后静默继续，问题会在第 5 步以「BUILD_ID 不匹配」的面貌出现，
# 让人以为是构建标识的问题而不是「服务根本没起来」。这里显式报出来。
if [ "$HEALTHY" -eq 0 ]; then
  echo "    ❌ 等待 60 秒后 /api/version 仍无响应，服务未起来" >&2
  echo "       排查：docker logs lawlink-app --tail 50" >&2
  exit 1
fi

# ---------------------------------------------------------------
echo
echo "==> [5/5] 三重验证（镜像 ID 变了 / BUILD_ID 是真实值 / 页面可达）"
# ---------------------------------------------------------------
NEW_IMAGE=$(docker images lawlink-app --format "{{.ID}}" | head -1)
ACTUAL_BUILD_ID=$(curl -s --max-time 8 http://localhost:3000/api/version | sed 's/.*"buildId":"\([^"]*\)".*/\1/')

echo "    镜像: ${PREV_IMAGE:-（无）} → ${NEW_IMAGE}"
echo "    BUILD_ID: 期望 ${BUILD_ID}，实际 ${ACTUAL_BUILD_ID}"

FAIL=0
# 2026-11-21：先判「有没有读到值」。否则服务不可达时 ACTUAL_BUILD_ID 为空，
# 会被下面的「不匹配」分支拦住，但提示是「BUILD_ID 不匹配」—— 误导排查方向。
[ -z "$ACTUAL_BUILD_ID" ] && { echo "    ❌ 读不到 /api/version 的 buildId，服务可能不可达" >&2; FAIL=1; }
[ "$NEW_IMAGE" = "${PREV_IMAGE:-}" ] && { echo "    ❌ 镜像 ID 未变化，说明没有真正重建" >&2; FAIL=1; }
[ "$ACTUAL_BUILD_ID" = "dev" ] && { echo "    ❌ BUILD_ID 是 dev，进程未拿到构建标识" >&2; FAIL=1; }
[ "$ACTUAL_BUILD_ID" != "$BUILD_ID" ] && { echo "    ❌ BUILD_ID 不匹配（期望 ${BUILD_ID}）" >&2; FAIL=1; }
[ "$FAIL" -eq 1 ] && exit 1

echo
echo "==> 部署完成：${NEW_IMAGE} / ${ACTUAL_BUILD_ID}"
echo "    下一步建议：node scripts/verify-ui.mjs all"
