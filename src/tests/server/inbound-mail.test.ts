// @vitest-environment node
/**
 * 邮件 → 线索（2026-11-23）
 *
 * IMAP 拉取要凭据才能联调，但"拿到邮件之后怎么变线索"是纯逻辑，现在就能钉住。
 *
 * 覆盖：
 *  ① 显式姓名优先于发件人显示名
 *  ② 姓名回退顺序：显示名 → 邮箱前缀 → 「官网咨询」
 *  ③ 手机号取第一个合法值（含座机）
 *  ④ 正文压成一行并截到 500 字（不放邮件头噪声）
 *  ⑤ externalId 用 messageId → 同一封重复拉取不会造两条
 *  ⑥ 未配置 IMAP → 来源为 null（跳过，不算失败）
 *  ⑦ 已配置但实现未接 → **明确抛错**说明还差什么（不静默返回空）
 *  ⑧ ingest 批量：单封失败不中断整批；没有接收人属全局问题会提前停
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDatabase } from "@/tests/helpers/temp-db";

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

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  await prisma.user.create({
    data: { email: "recv2@t.local", name: "接收人", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.leadActivity.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.systemSetting.deleteMany({});
  // 前一个用例可能把用户全停用来验无接收人，这里恢复，避免用例互相污染
  await prisma.user.updateMany({ data: { active: true } });
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));

const { mailToLeadDraft, firstPhone } = await import("@/server/inbound/mail-to-lead");
const { FakeMailSource, isImapConfigured, missingImapKeys, createImapSourceFromEnv } =
  await import("@/server/inbound/imap-source");
const { ingestMails } = await import("@/server/inbound/ingest-mails");

const mail = (over: Partial<Parameters<typeof mailToLeadDraft>[0]> = {}) => ({
  messageId: "m1",
  subject: "法律咨询",
  fromName: "王先生",
  fromAddress: "wang@example.com",
  body: "你好，我想咨询离婚事宜，电话 13900001111",
  receivedAt: new Date("2026-11-23T10:00:00+08:00"),
  ...over
});

describe("邮件转线索草稿", () => {
  it("显式姓名优先于发件人显示名", () => {
    const d = mailToLeadDraft(mail({ body: "姓名：张三\n想咨询劳动仲裁" }));
    expect(d.name).toBe("张三");
  });

  it("姓名回退：显示名 → 邮箱前缀 → 官网咨询", () => {
    expect(mailToLeadDraft(mail()).name).toBe("王先生");
    expect(mailToLeadDraft(mail({ fromName: null, fromAddress: "lisi@example.com" })).name).toBe("lisi");
    expect(mailToLeadDraft(mail({ fromName: "  ", fromAddress: "@example.com" })).name).toBe("官网咨询");
  });

  it("手机号取第一个合法值（手机优先）", () => {
    expect(mailToLeadDraft(mail()).phone).toBe("13900001111");
    expect(firstPhone("座机 010-12345678，手机 13800002222")).toBe("13800002222");
    expect(firstPhone("没有号码")).toBeNull();
  });

  it("正文压成一行并截到 500 字（不放邮件头噪声）", () => {
    const long = "咨询".repeat(400);
    const d = mailToLeadDraft(mail({ body: `第一行\n\n第二行 ${long}` }));
    expect(d.message).not.toContain("\n");
    expect((d.message ?? "").length).toBeLessThanOrEqual(500);
  });

  it("externalId 用 messageId（同一封重复拉取不会造两条）", () => {
    const d = mailToLeadDraft(mail({ messageId: "abc@x" }));
    expect(d.externalId).toBe("mail:abc@x");
  });
});

describe("IMAP 来源适配层", () => {
  it("未配置 → isImapConfigured=false、来源为 null、缺项清单可读", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isImapConfigured(env)).toBe(false);
    expect(createImapSourceFromEnv(env)).toBeNull();
    expect(missingImapKeys(env)).toEqual(["IMAP_HOST", "IMAP_USER", "IMAP_PASS"]);
  });

  it("**已配置但实现未接 → 明确抛错**（不静默返回空数组）", () => {
    const env = { IMAP_HOST: "imap.x.com", IMAP_USER: "u", IMAP_PASS: "p" } as unknown as NodeJS.ProcessEnv;
    expect(isImapConfigured(env)).toBe(true);
    expect(() => createImapSourceFromEnv(env)).toThrow(/imapflow/);
  });
});

describe("批量收件入库", () => {
  it("两封邮件 → 建两条线索；重复拉取 → 全部判定为 duplicate", async () => {
    const source = new FakeMailSource([
      mail({ messageId: "a", body: "姓名：甲，电话 13900001111" }),
      mail({ messageId: "b", body: "姓名：乙，电话 13900002222" })
    ]);
    const since = new Date("2026-11-01T00:00:00+08:00");

    const first = await ingestMails(source, since);
    expect(first).toMatchObject({ fetched: 2, created: 2, duplicate: 0 });
    expect(await prisma.lead.count()).toBe(2);

    const again = await ingestMails(source, since);
    expect(again).toMatchObject({ fetched: 2, created: 0, duplicate: 2 });
    expect(await prisma.lead.count()).toBe(2); // 幂等
  });

  it("**没有可用的入站接收人 → fatal 提前停**（不逐封撞同一面墙）", async () => {
    await prisma.user.updateMany({ data: { active: false } });
    const source = new FakeMailSource([mail({ messageId: "x1" }), mail({ messageId: "x2" })]);
    const res = await ingestMails(source, new Date("2026-11-01T00:00:00+08:00"));
    expect(res.fatal).toContain("leadInboundOwnerId");
    expect(res.created).toBe(0);
    expect(await prisma.lead.count()).toBe(0);
  });

  it("since 过滤生效（早于 since 的邮件不拉）", async () => {
    const source = new FakeMailSource([
      mail({ messageId: "old", receivedAt: new Date("2026-10-01T00:00:00+08:00") }),
      mail({ messageId: "new", receivedAt: new Date("2026-11-23T00:00:00+08:00") })
    ]);
    const res = await ingestMails(source, new Date("2026-11-01T00:00:00+08:00"));
    expect(res.fetched).toBe(1);
    expect(res.created).toBe(1);
  });
});
