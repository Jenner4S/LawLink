#!/bin/bash
# LawLink 数据库 + 文件存储备份脚本
# 用法: ./scripts/backup.sh [/备份/目录]
# 默认备份到 ./backups/

set -euo pipefail

BACKUP_DIR="${1:-./backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_PATH="${BACKUP_DIR}/${TIMESTAMP}"

# 从 .env 读取数据库配置
if [ -f .env ]; then
  source .env
fi

DB_URL="${DATABASE_URL:-}"
# 2026-09-20 第六轮体检 P1-1：改读 APP_STORAGE_DIR（与应用和 compose 一致）。
# 此前读 STORAGE_PATH——该变量在应用侧不存在，自定义存储目录时会静默打包空目录。
STORAGE_DIR="${APP_STORAGE_DIR:-./storage}"

if [ -z "$DB_URL" ]; then
  echo "错误: DATABASE_URL 未设置"
  exit 1
fi

# 从 DATABASE_URL 解析连接参数
# 格式: postgresql://user:password@host:port/database
DB_HOST=$(echo "$DB_URL" | sed -E 's/.*@([^:]+):.*/\1/')
DB_PORT=$(echo "$DB_URL" | sed -E 's/.*:([0-9]+)\/.*/\1/')
DB_NAME=$(echo "$DB_URL" | sed -E 's/.*\/([^?]+).*/\1/')
DB_USER=$(echo "$DB_URL" | sed -E 's/.*:\/\/([^:]+):.*/\1/')
DB_PASS=$(echo "$DB_URL" | sed -E 's/.*:\/\/[^:]+:([^@]+)@.*/\1/')

mkdir -p "$BACKUP_PATH"

# ─────────────────────────────────────────────────────────────
# 选择 pg_dump / pg_restore（2026-11-21 修复）
#
# 背景：pg_dump 拒绝导出**比自己新**的服务端。只要宿主的 PostgreSQL 客户端
# 版本低于服务端（macOS Homebrew 常年是 14、Debian stable 是 15，而服务端是 16），
# 备份脚本就会直接失败：
#     pg_dump: error: server version: 16.16; pg_dump version: 14.25
#     pg_dump: error: aborting because of server version mismatch
#
# 后果不是一个失败的任务，而是**这个律所根本没有备份** —— 而且只有在真的需要
# 恢复的那天才知道。所以这里优先用数据库容器里的客户端（版本必然与服务端一致）。
#
# 覆盖方式（按需）：
#   DB_CONTAINER=<名称>   指定容器（默认 lawlink-db）
#   USE_HOST_PG=1         强制用宿主客户端（调试用）
# ─────────────────────────────────────────────────────────────
DB_CONTAINER="${DB_CONTAINER:-lawlink-db}"
PG_MODE="host"

server_major() {
  PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "show server_version_num" 2>/dev/null | tr -d ' ' | cut -c1-2
}

if [ "${USE_HOST_PG:-0}" != "1" ] && command -v docker >/dev/null 2>&1 \
   && docker inspect -f '{{.State.Running}}' "$DB_CONTAINER" >/dev/null 2>&1; then
  PG_MODE="container"
else
  # 没有容器时才回退到宿主，并明确检查版本，避免又一次「静默产出 0 字节 dump」
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "错误: 既没有可用的数据库容器（${DB_CONTAINER}），宿主也没有 pg_dump" >&2
    exit 1
  fi
  SRV_MAJOR=$(server_major)
  CLI_MAJOR=$(pg_dump --version | sed -E 's/.* ([0-9]+)\..*/\1/')
  if [ -n "$SRV_MAJOR" ] && [ "$CLI_MAJOR" != "$SRV_MAJOR" ]; then
    echo "错误: 宿主 pg_dump 是 ${CLI_MAJOR}.x，服务端是 ${SRV_MAJOR}.x —— 版本必须一致。" >&2
    echo "      pg_dump 不会导出比自己新的服务端。请二选一：" >&2
    echo "      1) 启动数据库容器并设置 DB_CONTAINER=<名称>（推荐，版本自然匹配）" >&2
    echo "      2) 安装与服务端同版本的 postgresql-client" >&2
    exit 1
  fi
fi
# 注意：$DB_CONTAINER 后面紧跟全角「）」时，bash 会把全角字符当成变量名的一部分
# （报 "DB_CONTAINER?: unbound variable"）。必须用 ${DB_CONTAINER} 显式界定。
if [ "$PG_MODE" = "container" ]; then
  echo "导出客户端: 容器 ${DB_CONTAINER}（版本与服务端一致）"
else
  echo "导出客户端: 宿主 pg_dump"
fi

echo "=== LawLink 备份 ${TIMESTAMP} ==="
echo "数据库: ${DB_NAME}@${DB_HOST}:${DB_PORT}"
echo "存储目录: ${STORAGE_DIR}"
echo ""

# 1. pg_dump（设置了 BACKUP_PASSPHRASE 时产物整体加密，见第 4 步）
echo "[1/3] 导出数据库..."
if [ "$PG_MODE" = "container" ]; then
  # 容器内导出到 stdout，再由宿主写入文件（避免依赖容器内的路径挂载）
  docker exec -e PGPASSWORD="$DB_PASS" "$DB_CONTAINER" \
    pg_dump -h 127.0.0.1 -p 5432 -U "$DB_USER" -d "$DB_NAME" \
      --format=custom --compress=6 \
    > "${BACKUP_PATH}/database.dump"
else
  PGPASSWORD="$DB_PASS" pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --format=custom \
    --compress=6 \
    -f "${BACKUP_PATH}/database.dump"
fi
echo "  数据库备份完成: $(du -sh "${BACKUP_PATH}/database.dump" | cut -f1)"

# 2. 文件存储
echo "[2/3] 打包文件存储..."
if [ -d "$STORAGE_DIR" ]; then
  tar czf "${BACKUP_PATH}/storage.tar.gz" -C "$(dirname "$STORAGE_DIR")" "$(basename "$STORAGE_DIR")"
  echo "  文件存储备份完成: $(du -sh "${BACKUP_PATH}/storage.tar.gz" | cut -f1)"
else
  echo "  跳过: 存储目录不存在"
fi

# 2.5 存储一致性校验（2026-11-19 新增）
# 背景：容器卷为空而数据库里有文档记录时，备份会「成功」但文书全丢——
# 这是最危险的静默失败：库能恢复，文书打不开。
# 判据：Document.path 的数量应与存储目录的实际文件数相符。
echo "[2.5/3] 校验存储一致性..."
DB_DOC_COUNT=$(PGPASSWORD="$DB_PASS" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
  'select count(*) from "Document" where path is not null' 2>/dev/null | tr -d ' ')
DB_DOC_COUNT=${DB_DOC_COUNT:-0}
STORAGE_FILE_COUNT=$(find "$STORAGE_DIR" -type f ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ')
echo "  数据库文档数: ${DB_DOC_COUNT} | 存储文件数: ${STORAGE_FILE_COUNT}"

if [ "$DB_DOC_COUNT" -gt 0 ] && [ "$STORAGE_FILE_COUNT" -eq 0 ]; then
  echo "" >&2
  echo "错误: 数据库有 ${DB_DOC_COUNT} 份文档，但存储目录 ${STORAGE_DIR} 为空。" >&2
  echo "      继续备份会得到「库能恢复、文书全丢」的假成功，已中止。" >&2
  echo "      请确认 APP_STORAGE_DIR 是否指向应用实际写入的目录" >&2
  echo "      （容器部署时通常是命名卷，而不是宿主机的 ./storage）。" >&2
  rm -rf "$BACKUP_PATH"
  exit 1
fi

if [ "$STORAGE_FILE_COUNT" -lt "$DB_DOC_COUNT" ]; then
  echo "  警告: 存储文件数少于数据库文档数，可能有 ${DB_DOC_COUNT} - ${STORAGE_FILE_COUNT} 份文书缺失" >&2
fi

# 3. 元信息
echo "[3/3] 写入元信息..."
ENCRYPTED="false"
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  ENCRYPTED="true"
fi
cat > "${BACKUP_PATH}/manifest.json" << EOF
{
  "timestamp": "${TIMESTAMP}",
  "date": "$(date -Iseconds)",
  "database": "${DB_NAME}",
  "storage_path": "${STORAGE_DIR}",
  "encrypted": "${ENCRYPTED}",
  "documentCount": ${DB_DOC_COUNT},
  "storageFileCount": ${STORAGE_FILE_COUNT},
  "files": [
    {"name": "database.dump", "type": "pg_dump custom compressed", "sha256": "$(sha256sum "${BACKUP_PATH}/database.dump" 2>/dev/null | cut -d" " -f1)"},
    {"name": "storage.tar.gz", "type": "tar gzip", "sha256": "$(sha256sum "${BACKUP_PATH}/storage.tar.gz" 2>/dev/null | cut -d" " -f1)"}
  ]
}
EOF

# 4. 整包加密（可选但强烈建议）
# 备份含密码哈希、AES-GCM 密文与恢复码哈希；与主密钥同机的明文备份等于
# 全量解密。设置 BACKUP_PASSPHRASE（环境变量或 .env）即用 openssl 加密；
# 恢复命令：openssl enc -d -aes-256-cbc -pbkdf2 -in <file>.enc -out <file>
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  echo "[4/4] 加密备份产物..."
  for f in database.dump storage.tar.gz; do
    if [ -f "${BACKUP_PATH}/${f}" ]; then
      openssl enc -aes-256-cbc -pbkdf2 -salt \
        -in "${BACKUP_PATH}/${f}" \
        -out "${BACKUP_PATH}/${f}.enc" \
        -pass env:BACKUP_PASSPHRASE
      rm "${BACKUP_PATH}/${f}"
      echo "  已加密: ${f}.enc"
    fi
  done
elif [ "${BACKUP_ALLOW_PLAINTEXT:-}" != "true" ]; then
  echo ""
  echo "警告: 未设置 BACKUP_PASSPHRASE，备份以明文保存（含凭据哈希与密文数据）。"
  echo "警告: 设置 BACKUP_PASSPHRASE 可自动加密；确认接受明文请设 BACKUP_ALLOW_PLAINTEXT=true。"
fi

echo ""
echo "=== 备份完成 ==="
echo "路径: ${BACKUP_PATH}"
echo "总大小: $(du -sh "$BACKUP_PATH" | cut -f1)"
echo ""
echo "建议: 将 ${BACKUP_PATH} 上传到异地存储（S3 / OSS / 其他服务器）"
