// @vitest-environment node
/**
 * 客户联系人并发编辑不得产生重复（2026-11-21 补，P2 回归守卫）。
 *
 * ## 被修的那个 bug
 *
 * `updateClient` 的策略是「删光该客户全部联系人 + 按提交内容重建」。
 * 两人同时编辑同一客户时，READ COMMITTED 下各自走一遍：
 *
 *   A: DELETE contacts（锁住被删的旧行）→ INSERT A 的联系人 → COMMIT
 *   B: DELETE contacts（等 A 提交）→ 只删掉了**旧行**（A 新插的不在 B 的语句快照里）
 *      → INSERT B 的联系人 → COMMIT
 *
 * 结果：该客户同时留着 A 的和 B 的联系人，**还都标了各自的主联系人**。
 *
 * ## 修法
 *
 * 事务一开始就对客户行加锁 `SELECT ... FOR UPDATE`，把同一客户的联系人编辑串行化。
 * B 会等 A 提交后才继续；那时它的 DELETE 是新语句、新快照，能看见 A 插的行一并删掉。
 *
 * **为什么不用唯一索引**：联系人允许同名同电话（同一个人在两个项目里可能挂不同头衔），
 * 唯一约束会误伤正常数据。行锁只解决并发，不改变业务允许的形态。
 *
 * ## 这里测什么
 *
 * 直接验证行锁的效果：两个并发事务都拿同一客户的行锁，
 * 后一个必须等前一个提交；再断言最终只有一方留下的联系人。
 *
 * 隔离：自建临时库 `lawlink_contact_test_*` → migrate deploy → DROP。
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

// 并发用例的超时保护（2026-11-23）：全量并行跑时（199 个测试文件同打一个库），
// 连接池争用会让「多路并发写同一行」这类用例超过默认 5s。
// 单跑都很快，全量跑偶发超时——`login-lockout` 就因此让整条门禁红过一次。
// 放宽到 30s，但**不降低并发数**：这些用例的价值正是"并发下仍然正确"。
vi.setConfig({ testTimeout: 30_000 });


const NAME = vi.hoisted(() => {
  const host = process.env.FIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.FIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.FIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  process.env.DATABASE_URL = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  return name;
});

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;

const CURRENT_USER = "contact-test-user";

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  await prisma.user.create({
    data: { id: CURRENT_USER, email: "contact@t.local", name: "编辑人", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  console.info(`[client-contacts] 临时库：${NAME}`);
}, 180_000);

afterAll(async () => {
  await dropDb?.();
}, 60_000);

vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({ user: { id: CURRENT_USER, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/server/audit", () => ({ audit: async () => {}, auditTx: async () => {} }));

const { updateClient } = await import("@/server/clients/actions");

async function seedClient() {
  return prisma.client.create({
    data: {
      type: "COMPANY" as never, name: `联系人测试客户${Date.now().toString(36)}`,
      contacts: { create: [{ name: "初始联系人", isPrimary: true }] }
    }
  });
}

describe("updateClient · 联系人并发编辑不得重复（真库）", () => {
  it("串行两次编辑：只保留最后一次提交的联系人（基线）", async () => {
    const c = await seedClient();
    await updateClient({ id: c.id, name: c.name, type: "COMPANY", contacts: [{ name: "张三", isPrimary: true }] } as never);
    await updateClient({ id: c.id, name: c.name, type: "COMPANY", contacts: [{ name: "李四", isPrimary: true }] } as never);
    const contacts = await prisma.contact.findMany({ where: { clientId: c.id }, select: { name: true } });
    expect(contacts.map((x) => x.name)).toEqual(["李四"]);
  });

  it("【结构性守卫】updateClient 的事务体里确实取了客户行锁", async () => {
    // 为什么用结构性断言而不是并发复现：
    // updateClient 自己管事务，测试无法在它的两条语句之间插入延时，
    // 于是「A 删完、B 才删」这个关键交错复现不了 —— 实测去掉锁这条并发用例照样绿。
    // 真正验证锁语义的是下面那条（手工两条连接、显式交错）。
    // 这条只负责一件事：**防止有人删掉那一行**。
    // 它守不住「换成一个语义不同但同样有锁的写法」，那种只能靠评审。
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/server/clients/actions.ts", "utf8");
    const body = src.slice(src.indexOf("export async function updateClient"));
    expect(body).toMatch(/SELECT 1 AS locked FROM "Client" WHERE id = \$\{id\} FOR UPDATE/);
  });

  it("并发两次编辑：最终只剩一方提交的联系人，不会两批都留下", async () => {
    const c = await seedClient();
    const results = await Promise.allSettled([
      updateClient({ id: c.id, name: c.name, type: "COMPANY", contacts: [{ name: "并发A", isPrimary: true }] } as never),
      updateClient({ id: c.id, name: c.name, type: "COMPANY", contacts: [{ name: "并发B", isPrimary: true }] } as never)
    ]);

    // 两方都可能成功（后提交覆盖），但**绝不能留下四五个联系人**
    const contacts = await prisma.contact.findMany({ where: { clientId: c.id }, select: { name: true, isPrimary: true } });
    expect(contacts.length).toBe(1);
    expect(["并发A", "并发B"]).toContain(contacts[0].name);
    // 主联系人恰好一个
    expect(contacts.filter((x) => x.isPrimary).length).toBe(1);

    // 若有一方失败，失败原因应是可理解的（这里不强制都成功）
    for (const r of results) {
      if (r.status === "rejected") {
        expect(String((r.reason as Error)?.message ?? r.reason)).not.toMatch(/prisma|\/Users\/|\.ts:/i);
      }
    }
  });

  it("行锁真的在等：持锁期间第二个事务必须阻塞，不会读到中间态", async () => {
    // 直接验证锁语义：手动开两个连接，A 拿锁不提交，B 拿同一行锁必须等。
    const c = await seedClient();
    const other = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    // 注：这条手工开两条连接、显式交错，复现的正是 updateClient 里那段
    // 「删光重建」的竞态（实测无锁时最终会留下 ["A","B"] 两条）。

    const locked = await prisma.$transaction(async (db) => {
      await db.$queryRaw`SELECT 1 AS locked FROM "Client" WHERE id = ${c.id} FOR UPDATE`;
      // 锁内插入一条，模拟 A 正在改
      await db.contact.deleteMany({ where: { clientId: c.id } });
      await db.contact.create({ data: { clientId: c.id, name: "锁内A", isPrimary: true } });

      // B 尝试拿同一行锁 —— 给 300ms，正常情况下它必须还在等
      let bFinished = false;
      const b = other
        .$transaction(async (db2) => {
          await db2.$queryRaw`SELECT 1 AS locked FROM "Client" WHERE id = ${c.id} FOR UPDATE`;
          await db2.contact.deleteMany({ where: { clientId: c.id } });
          await db2.contact.create({ data: { clientId: c.id, name: "锁内B", isPrimary: true } });
        })
        .then(() => { bFinished = true; })
        .catch(() => { bFinished = true; });

      await new Promise((r) => setTimeout(r, 300));
      expect(bFinished).toBe(false); // B 还在等锁

      // 让 A 提交，B 才能继续
      return { b };
    });

    await locked.b;
    const contacts = await prisma.contact.findMany({ where: { clientId: c.id }, select: { name: true } });
    // 串行化之后，B 看见并删掉了 A 的行 → 只剩 B 的
    expect(contacts.map((x) => x.name)).toEqual(["锁内B"]);
    await other.$disconnect();
  });
});
