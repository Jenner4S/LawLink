// @vitest-environment node
/**
 * 外部接入状态（2026-11-23）
 *
 * 这一页的价值全在「**configured-unimplemented** 要显眼」：
 * 凭据填了但代码没接，最容易让人以为"已开通"，实际一条也发不出去。
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
let getIntegrationStatus: (env?: NodeJS.ProcessEnv) => Promise<import("@/server/settings/integration-status").IntegrationStatus>;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  await prisma.user.create({
    data: { email: "s@t.local", name: "接收人", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  ({ getIntegrationStatus } = await import("@/server/settings/integration-status"));
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => { await prisma.lead.deleteMany({}); });

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("外部接入状态", () => {
  it("全未配置 → 三项都是 off，且给出缺哪些键", async () => {
    const s = await getIntegrationStatus(env({}));
    expect(s.form.state).toBe("off");
    expect(s.imap.state).toBe("off");
    expect(s.sms.state).toBe("off");
    if (s.imap.state === "off") expect(s.imap.missing).toEqual(["IMAP_HOST", "IMAP_USER", "IMAP_PASS"]);
    if (s.sms.state === "off") expect(s.sms.missing).toEqual(["SMS_PROVIDER", "SMS_KEY"]);
  });

  it("表单 token 配了 → ready，并统计自动入站线索数", async () => {
    await prisma.lead.create({
      data: {
        name: "官网来客", ownerId: (await prisma.user.findFirstOrThrow()).id,
        notes: "客户留言：咨询\n[inbound:form-1]", stage: "LEAD"
      }
    });
    await prisma.lead.create({
      data: { name: "手抄客", ownerId: (await prisma.user.findFirstOrThrow()).id, stage: "LEAD" }
    });

    const s = await getIntegrationStatus(env({ INBOUND_LEAD_TOKEN: "t" }));
    expect(s.form.state).toBe("ready");
    if (s.form.state === "ready") expect(s.form.inboundLeadCount).toBe(1); // 只数自动入站的
  });

  it("**IMAP 配了凭据但未实现 → configured-unimplemented**（不能显示成已就绪）", async () => {
    const s = await getIntegrationStatus(env({ IMAP_HOST: "h", IMAP_USER: "u", IMAP_PASS: "p" }));
    expect(s.imap.state).toBe("configured-unimplemented");
    if (s.imap.state === "configured-unimplemented") expect(s.imap.note).toContain("imapflow");
  });

  it("**SMS_PROVIDER=fake → demo**（演练模式，不真发）", async () => {
    const s = await getIntegrationStatus(env({ SMS_PROVIDER: "fake" }));
    expect(s.sms.state).toBe("demo");
  });

  it("**SMS 配了真 provider 但未实现 → configured-unimplemented**", async () => {
    const s = await getIntegrationStatus(env({ SMS_PROVIDER: "aliyun", SMS_KEY: "k" }));
    expect(s.sms.state).toBe("configured-unimplemented");
    if (s.sms.state === "configured-unimplemented") expect(s.sms.note).toContain("aliyun");
  });

  it("只填了 provider 没填 key → 仍是 off（缺项可读）", async () => {
    const s = await getIntegrationStatus(env({ SMS_PROVIDER: "aliyun" }));
    expect(s.sms.state).toBe("off");
    if (s.sms.state === "off") expect(s.sms.missing).toEqual(["SMS_KEY"]);
  });
});
