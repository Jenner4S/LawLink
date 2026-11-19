/**
 * 真库测试的临时数据库脚手架（2026-11-22）
 *
 * ## 为什么抽出来
 *
 * 2026-11-22 盘点发现：**27 个测试文件各自手抄同一套建库逻辑** ——
 * `vi.hoisted` 里拼 DATABASE_URL、`CREATE DATABASE`、`execFileSync prisma migrate deploy`、
 * `afterAll` 里 `DROP DATABASE ... WITH (FORCE)`，每个文件 60 行上下。
 *
 * 这带来三个具体问题：
 *   ① 改了连接参数要改 27 个地方（`FIN_TEST_PG_*` 这几个变量就是这么散的）；
 *   ② 并发建库偶发失败 —— 全量跑时多个 worker 同时 `CREATE DATABASE`，
 *      会撞上模板库被占用（`source database is being accessed by other users`），
 *      表现为「重跑就过」的偶发红。2026-11-21 全量跑就出现过一次，无法复现；
 *   ③ 新写一个真库测试要复制 60 行，其中任何一行抄错都只会在 CI 偶发暴露。
 *
 * ## 这个 helper 做什么
 *
 *   · 一次调用拿到已迁移好的 PrismaClient
 *   · `CREATE DATABASE` 带**退避重试**（针对模板库占用）
 *   · `DROP DATABASE ... WITH (FORCE)` 兜底清理，失败不掩盖原始测试失败
 *   · 库名带随机后缀，天然隔离并行 worker
 *
 * ## 不做什么
 *
 * 不 seed、不插测试数据 —— 每个用例自己的前置数据自己造，
 * 因为「该造什么数据」是测试本身的语义，不属于脚手架。
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const HOST = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
const USER = process.env.FIN_TEST_PG_USER ?? "lawlink";
const PASSWORD = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";

const urlFor = (database: string) => `postgresql://${USER}:${PASSWORD}@${HOST}/${database}?schema=public`;

/** 生成一个不会与并行 worker 撞车的库名 */
export function tempDbName(prefix = "lawlink_test"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 建库 + 迁移，返回可直接用的 PrismaClient。
 *
 * 同时把 `process.env.DATABASE_URL` 指向新库 —— 被测 Server Action 通过
 * `@/lib/prisma` 读环境变量建 client，必须先设好再 import 被测模块
 *（这也是调用方必须放在 `vi.hoisted` 里的原因）。
 */
export async function createTempDatabase(name: string): Promise<{
  prisma: PrismaClient;
  url: string;
  drop: () => Promise<void>;
}> {
  const url = urlFor(name);
  process.env.DATABASE_URL = url;

  const admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });

  // 退避重试：并发 CREATE DATABASE 会撞模板库占用
  let lastErr: unknown;
  let created = false;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      created = true;
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const retryable = /being accessed by other users|already exists|template/i.test(msg);
      if (!retryable) break;
      if (/already exists/i.test(msg)) {
        created = true; // 同名库已存在（重试时可能前一次其实成功了）
        break;
      }
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (!created) {
    await admin.$disconnect().catch(() => {});
    throw new Error(`临时库创建失败（${name}）：${String(lastErr)}`);
  }

  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe"
  });

  const prisma = new PrismaClient({ datasourceUrl: url });

  const drop = async () => {
    await prisma.$disconnect().catch(() => {});
    try {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await admin.$disconnect().catch(() => {});
    }
  };

  return { prisma, url, drop };
}
