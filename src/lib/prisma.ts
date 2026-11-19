import { PrismaClient } from "@prisma/client";
import { computeAuditHash } from "./audit-chain";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaBase: PrismaClient | undefined;
};

function createBase(): PrismaClient {
  return new PrismaClient({
    // Prisma 的自动错误日志可能包含完整写入参数；业务错误由调用方脱敏处理。
    log: ["warn"]
  });
}

const base = globalForPrisma.prismaBase ?? createBase();

/**
 * 链式审计扩展（借鉴 LexNebulis）：
 * 在所有 auditLog.create 上自动补 integrityHash / previousHash，调用方无需改动。
 *
 * 说明：
 *   - 用 query 扩展而非中间件，事务内 tx.auditLog.create 同样生效（tx 从扩展后的 client 派生）。
 *   - 上一条摘要按 createdAt 取最新一条「已有摘要」的记录；历史记录（加字段前写入）没有摘要，
 *     不参与链接，链从第一条带摘要的记录开始。
 *   - 并发写入可能取到同一个 previousHash（审计写入频率低，未加数据库级锁）；
 *     如需强一致，可在事务内对本表加 advisory lock。
 */
const extended = base.$extends({
  query: {
    auditLog: {
      async create({ args, query }) {
        const prev = await base.auditLog.findFirst({
          where: { integrityHash: { not: null } },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { integrityHash: true }
        });
        const previousHash = prev?.integrityHash ?? null;
        const createdAt =
          args.data.createdAt instanceof Date ? args.data.createdAt : new Date();
        const data = args.data as Record<string, unknown>;
        const integrityHash = computeAuditHash({
          userId: (data.userId as string | null) ?? null,
          action: String(data.action ?? ""),
          targetType: (data.targetType as string | null) ?? null,
          targetId: (data.targetId as string | null) ?? null,
          detail: data.detail,
          ip: (data.ip as string | null) ?? null,
          userAgent: (data.userAgent as string | null) ?? null,
          createdAt,
          previousHash
        });
        args.data = { ...data, createdAt, integrityHash, previousHash } as typeof args.data;

        // 链的唯一性由数据库保证（@@unique([previousHash])）：并发下若另一请求
        // 抢先占用了同一个前驱，本条会被拒绝。这里重算一次前驱再试——
        // 重试期间前驱已变，新哈希自然指向真正的最新记录。
        try {
          return await query(args);
        } catch (err) {
          const isUniqueViolation =
            typeof err === "object" &&
            err !== null &&
            (err as { code?: string }).code === "P2002";
          if (!isUniqueViolation) throw err;

          const latest = await base.auditLog.findFirst({
            where: { integrityHash: { not: null } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            select: { integrityHash: true }
          });
          const retryPrev = latest?.integrityHash ?? null;
          const retryHash = computeAuditHash({
            userId: (data.userId as string | null) ?? null,
            action: String(data.action ?? ""),
            targetType: (data.targetType as string | null) ?? null,
            targetId: (data.targetId as string | null) ?? null,
            detail: data.detail,
            ip: (data.ip as string | null) ?? null,
            userAgent: (data.userAgent as string | null) ?? null,
            createdAt,
            previousHash: retryPrev
          });
          args.data = {
            ...data,
            createdAt,
            integrityHash: retryHash,
            previousHash: retryPrev
          } as typeof args.data;
          return query(args);
        }
      }
    }
  }
});

export const prisma = (globalForPrisma.prisma ?? extended) as unknown as PrismaClient & {
  $base: PrismaClient;
};

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaBase = base;
}
