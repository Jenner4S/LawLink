/**
 * WebAuthn 测试用的内存「Prisma 子集」。
 *
 * 为什么不用 vi.fn() 逐个打桩：本任务的硬要求是「challenge / counter / ticket
 * 这三条安全逻辑必须用真逻辑测」。这三条全部依赖 Prisma 的**条件更新语义**
 * （`updateMany(where: { usedAt: null, expiresAt: { gt: now } })` 的原子独占），
 * 用 stub 返回固定值就把要验证的东西验证掉了——测试会过，线上照样能被重放。
 *
 * 所以这里实现一个带真实匹配语义的内存表：
 *   - `updateMany` 按 where 逐条匹配后才改，返回真实 count（一次性消费靠它）；
 *   - 唯一约束（challenge / credentialId）冲突时抛 P2002 形态的错误；
 *   - 查询只支持本项目实际用到的形状，遇到未覆盖的形状直接抛错（避免静默放行）。
 */

type Row = Record<string, unknown> & { id: string };

type ChallengeRow = Row & {
  id: string;
  challenge: string;
  userId: string | null;
  kind: string;
  expiresAt: Date;
  usedAt: Date | null;
};

type CredentialRow = Row & {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: string;
  counter: bigint;
  transports: string[];
  deviceName: string | null;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

type UserRow = Record<string, unknown> & { id: string };

type AuditRow = {
  userId: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown>;
};

class FakePrismaError extends Error {
  code: string;
  constructor(code: string) {
    super(`FakePrismaError ${code}`);
    this.code = code;
  }
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}${String(++seq).padStart(6, "0")}`;

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 极简 where 匹配：只支持本项目实际用到的形状 */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (Array.isArray(cond)) {
      if (!Array.isArray(value) || value.length !== cond.length) return false;
      if (!cond.every((v, i) => v === value[i])) return false;
      continue;
    }
    if (typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("in" in c) {
        const list = c.in as unknown[];
        if (!list.includes(value)) return false;
        continue;
      }
      if ("lt" in c) {
        const bound = c.lt as Date | number;
        const actual = value instanceof Date ? value.getTime() : Number(value);
        const limit = bound instanceof Date ? bound.getTime() : Number(bound);
        if (!(actual < limit)) return false;
        continue;
      }
      if ("lte" in c) {
        const bound = c.lte as Date | number;
        const actual = value instanceof Date ? value.getTime() : Number(value);
        const limit = bound instanceof Date ? bound.getTime() : Number(bound);
        if (!(actual <= limit)) return false;
        continue;
      }
      if ("gt" in c) {
        const bound = c.gt as Date | number;
        const actual = value instanceof Date ? value.getTime() : Number(value);
        const limit = bound instanceof Date ? bound.getTime() : Number(bound);
        if (!(actual > limit)) return false;
        continue;
      }
      if ("not" in c) {
        const excluded = c.not;
        if (value === excluded) return false;
        continue;
      }
      throw new Error(`fake prisma: 未实现的 where 条件 ${key}=${JSON.stringify(cond)}`);
    }
    if (value !== cond) return false;
  }
  return true;
}

export type FakeDb = ReturnType<typeof createFakePrisma>;

export function createFakePrisma(seed?: {
  users?: Array<Record<string, unknown> & { id: string }>;
  credentials?: Array<Partial<CredentialRow> & { userId: string; credentialId: string; publicKey: string }>;
}) {
  const challenges: ChallengeRow[] = [];
  const credentials: CredentialRow[] = [];
  const users: UserRow[] = (seed?.users ?? []).map((u) => ({ ...u }));
  const auditRows: AuditRow[] = [];

  for (const c of seed?.credentials ?? []) {
    credentials.push({
      id: c.id ?? nextId("cred"),
      userId: c.userId,
      credentialId: c.credentialId,
      publicKey: c.publicKey,
      counter: c.counter ?? BigInt(0),
      transports: c.transports ?? [],
      deviceName: c.deviceName ?? null,
      backedUp: c.backedUp ?? false,
      createdAt: c.createdAt ?? new Date("2026-11-01T00:00:00Z"),
      lastUsedAt: c.lastUsedAt ?? null
    });
  }

  const db = {
    webAuthnChallenge: {
      async create({ data }: { data: Partial<ChallengeRow> }) {
        if (challenges.some((c) => c.challenge === data.challenge)) {
          throw new FakePrismaError("P2002"); // challenge 唯一约束
        }
        if (typeof data.challenge !== "string" || typeof data.kind !== "string" || !(data.expiresAt instanceof Date)) {
          throw new Error("fake prisma: challenge create 缺少必填字段");
        }
        const row: ChallengeRow = {
          id: data.id ?? nextId("chal"),
          challenge: data.challenge,
          userId: (data.userId ?? null) as string | null,
          kind: data.kind,
          expiresAt: data.expiresAt,
          usedAt: null
        };
        challenges.push(row);
        return { ...row };
      },
      async findUnique({ where }: { where: { challenge?: string; id?: string } }) {
        const row = challenges.find((c) =>
          where.challenge !== undefined ? c.challenge === where.challenge : c.id === where.id
        );
        return row ? { ...row } : null;
      },
      async updateMany({
        where,
        data
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) {
        let count = 0;
        for (const row of challenges) {
          if (!matches(row as unknown as Record<string, unknown>, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return { count };
      },
      async deleteMany({ where }: { where?: Record<string, unknown> }) {
        let count = 0;
        for (let i = challenges.length - 1; i >= 0; i -= 1) {
          if (!matches(challenges[i] as unknown as Record<string, unknown>, where)) continue;
          challenges.splice(i, 1);
          count += 1;
        }
        return { count };
      }
    },

    webAuthnCredential: {
      async create({ data }: { data: Partial<CredentialRow> }) {
        const credentialId = readString(data.credentialId);
        if (!credentialId) throw new Error("fake prisma: credentialId 必填");
        if (credentials.some((c) => c.credentialId === credentialId)) throw new FakePrismaError("P2002");
        const row: CredentialRow = {
          id: data.id ?? nextId("cred"),
          userId: String(data.userId),
          credentialId,
          publicKey: String(data.publicKey),
          counter: (data.counter ?? BigInt(0)) as bigint,
          transports: (data.transports ?? []) as string[],
          deviceName: (data.deviceName ?? null) as string | null,
          backedUp: Boolean(data.backedUp ?? false),
          createdAt: data.createdAt ?? new Date(),
          lastUsedAt: (data.lastUsedAt ?? null) as Date | null
        };
        credentials.push(row);
        return { ...row };
      },
      async findUnique({ where }: { where: { credentialId?: string; id?: string } }) {
        const row = credentials.find((c) =>
          where.credentialId !== undefined ? c.credentialId === where.credentialId : c.id === where.id
        );
        return row ? { ...row } : null;
      },
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        const row = credentials.find((c) => matches(c as unknown as Record<string, unknown>, where));
        return row ? { ...row } : null;
      },
      async findMany({ where }: { where?: Record<string, unknown>; orderBy?: unknown; select?: unknown } = {}) {
        return credentials
          .filter((c) => matches(c as unknown as Record<string, unknown>, where))
          .map((c) => ({ ...c }));
      },
      async count({ where }: { where?: Record<string, unknown> } = {}) {
        return credentials.filter((c) => matches(c as unknown as Record<string, unknown>, where)).length;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const row = credentials.find((c) => c.id === where.id);
        if (!row) throw new FakePrismaError("P2025");
        Object.assign(row, data);
        return { ...row };
      },
      async delete({ where }: { where: { id: string } }) {
        const idx = credentials.findIndex((c) => c.id === where.id);
        if (idx < 0) throw new FakePrismaError("P2025");
        const [row] = credentials.splice(idx, 1);
        return { ...row };
      }
    },

    user: {
      async findFirst({ where }: { where?: Record<string, unknown> }) {
        const email = (where?.email as { equals?: string } | undefined)?.equals;
        const row = users.find((u) =>
          email !== undefined ? String(u.email ?? "").toLowerCase() === email.toLowerCase() : true
        );
        return row ? { ...row } : null;
      },
      async findUnique({ where }: { where: { id?: string; email?: string } }) {
        const row = users.find((u) =>
          where.id !== undefined ? u.id === where.id : u.email === where.email
        );
        return row ? { ...row } : null;
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const row = users.find((u) => u.id === where.id);
        if (!row) throw new FakePrismaError("P2025");
        if (db.__failUserUpdate) throw new Error("simulated user update failure");
        Object.assign(row, data);
        return { ...row };
      }
    },

    auditLog: {
      async create({ data }: { data: AuditRow }) {
        auditRows.push({ ...data });
        return { id: nextId("audit") };
      }
    },

    /** 测试开关：模拟登录后状态更新失败（LOGIN_POST_UPDATE_FAILED 分支） */
    __failUserUpdate: false,

    // —— 断言用只读入口 ——
    __state: {
      challenges,
      credentials,
      users,
      audits: auditRows
    }
  };

  return db;
}
