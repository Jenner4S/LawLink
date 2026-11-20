# LawLink 应用容器
# 多阶段构建：deps → builder → runner
#
# ## 构建期网络（2026-11-21 补充）
#
# Alpine 官方 CDN（dl-cdn.alpinelinux.org）与 npm registry 在中国大陆常不可达。
# 本项目面向中国律所自部署，这不是个例。因此把镜像源做成**可覆盖的 build arg**：
# 默认仍是官方源（不改变任何现有用户的构建行为），需要时这样构建：
#
#   docker compose build \
#     --build-arg ALPINE_MIRROR=mirrors.aliyun.com \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com
#
# 实测（2026-11-21）：aliyun / tuna 可达（200），alpinelinux CDN、npmjs、github 均超时。
ARG ALPINE_MIRROR=dl-cdn.alpinelinux.org
ARG NPM_REGISTRY=https://registry.npmjs.org

FROM node:22-alpine AS deps
# 若指定了备用 Alpine 镜像，先改写 /etc/apk/repositories
ARG ALPINE_MIRROR
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi
WORKDIR /app
# openssl 必须显式安装（2026-09-21 Docker 部署验证暴露）：node:22-alpine 只带
# libssl3，不带 openssl 命令行；Prisma 在安装/生成时用它探测 OpenSSL 版本，探测
# 失败会回退选择 openssl-1.1.x 的引擎二进制，而运行环境只有 libssl3 —— 引擎加载
# 失败，容器内 migrate/seed 与应用查询全部不可用。见 AGENTS §五 6.2。
RUN apk add --no-cache libc6-compat openssl
COPY package*.json ./
COPY prisma ./prisma
ARG NPM_REGISTRY
# 国内网络常连不上 binaries.prisma.sh（实测 TLS 连接被重置），
# 引擎下载改走 npmmirror 镜像；官方源可达时该变量指向的镜像同样可用。
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
RUN npm ci --registry="${NPM_REGISTRY}"

FROM node:22-alpine AS builder
ARG ALPINE_MIRROR
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi

# 构建标识必须在此阶段注入，否则客户端 chunk 里拿不到值（预渲染页在 build 时求值）
ARG BUILD_ID=dev
ENV NEXT_PUBLIC_BUILD_ID=${BUILD_ID}
WORKDIR /app
ARG PRISMA_ENGINES_MIRROR=https://registry.npmmirror.com/-/binary/prisma
ENV PRISMA_ENGINES_MIRROR=${PRISMA_ENGINES_MIRROR}
# 同 deps：prisma generate 同样按探测到的 OpenSSL 版本选引擎
RUN apk add --no-cache openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

# 把 seed 打成单文件（2026-11-21）：生产镜像没有 src/ 也没有 tsx，
# 而 prisma/seed.ts 会相对引用 src/lib/template-builder 等应用代码。
# 只留 node_modules 里必然存在的包为 external，其余全部内联。
# 产物 prisma/seed.bundle.cjs 随下方 `COPY --from=builder /app/prisma` 进镜像。
RUN npx esbuild prisma/seed.ts \
      --bundle --platform=node --format=cjs \
      --outfile=prisma/seed.bundle.cjs \
      --external:@prisma/client --external:bcryptjs \
      --log-level=warning \
 && ls -lh prisma/seed.bundle.cjs

# 生产依赖裁剪（2026-11-19 法务清查发现）：此前 runner 直接复制 builder 的
# node_modules，把 402 个开发依赖（typescript / eslint / vitest / tailwind 链等）
# 一起打进镜像——不影响运行，但扩大合规面（许可证清单要覆盖这些包）与镜像体积。
# 这里在 builder 之后 prune 一次：.prisma 引擎已生成，prisma CLI 已移入 dependencies
# 供运维在容器内执行 migrate，dev-only 包全部移除。
#
# 2026-11-21：seed 改为**构建期打包**，所以这里仍然可以放心 prune。
#
# 起因：`prisma db seed` 在生产镜像里根本跑不起来 ——
#   ① tsx 在 devDependencies 被 prune 掉，连带 esbuild 平台二进制消失
#      （Cannot find module '@esbuild/linux-arm64'）
#   ② 修掉①后又撞上 prisma/seeds 里 `../../src/lib/template-builder` 的相对引用，
#      而 runner **不复制 src/**（Cannot find module '../../src/lib/template-builder'）
# 而 fresh install 必须跑 seed 才有第一个管理员 —— 按文档操作会卡在最后一米。
#
# 解法在 builder 阶段（见下方 esbuild 那步）：把 prisma/seed.ts 连同它引用的
# src 代码打成一个 CJS 单文件 prisma/seed.bundle.cjs，随 prisma 目录一起进镜像。
# 生产只需要 node，不需要 tsx，也不需要 src/。
FROM builder AS prod-deps
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine AS runner
ARG ALPINE_MIRROR
RUN if [ "$ALPINE_MIRROR" != "dl-cdn.alpinelinux.org" ]; then \
      sed -i "s|dl-cdn.alpinelinux.org|${ALPINE_MIRROR}|g" /etc/apk/repositories; \
    fi
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# 构建标识：前端据此判断页面是否已过期（Server Action ID 随构建变化）
ARG BUILD_ID=dev
ENV BUILD_ID=${BUILD_ID}

# 自动备份链依赖（2026-09-20 第六轮体检 P1-1）：backup.sh 以 bash 运行并调用
# pg_dump。postgresql16-client 对齐 db 服务的 postgres:16（pg_dump 客户端主版本
# 须等于或高于服务器）。缺了这两样，镜像里备份每天失败。
# openssl：运行时 Prisma Client 加载 query engine 需要（同 deps 阶段说明）
RUN apk add --no-cache bash postgresql16-client openssl

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next-build ./.next-build
COPY --from=prod-deps --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
# next.config.mjs 必须进镜像（2026-09-21 Docker 部署验证暴露）：其中 distDir 读
# NEXT_DIST_DIR（构建产物在 .next-build 而非默认 .next），缺了它 next start 会去
# 找 .next 并报 "Could not find a production build"，容器无限重启。该文件还带着
# serverExternalPackages（缺则 /matters 等路由 500）、serverActions 25MB 上传上限
# 与全站安全响应头——即便能启动，缺配置同样是错的。见 AGENTS §五 6.3。
COPY --from=builder --chown=nextjs:nodejs /app/next.config.mjs ./next.config.mjs
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
# 备份脚本必须进镜像：cron job 通过 process.cwd()/scripts/backup.sh 调用
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts

# backups 目录预先建好并授权：命名卷首次挂载会继承镜像内目录属主，
# 运行用户 nextjs 才能写入（BACKUP_DIR 默认 /app/backups）
RUN mkdir -p /app/storage /app/backups && chown -R nextjs:nodejs /app/storage /app/backups

USER nextjs
EXPOSE 3000
CMD ["npm", "run", "start"]
