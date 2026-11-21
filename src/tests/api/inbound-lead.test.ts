// @vitest-environment node
/**
 * 官网表单入站（2026-11-23）
 *
 * 这是获客环节最后一处断点：之前官网来的线索只能手工抄进系统。
 *
 * 六条口径：
 *  ① 未配置 token → 503 并给出配置方法（不静默放行：等于公网任何人可造线索）
 *  ② token 错 → 401
 *  ③ 字段校验失败 → 400 且返回具体哪一项
 *  ④ 正常 → 201，落库为 LEAD 阶段、ONLINE 来源、**UNASSIGNED**（进待派单视图）
 *  ⑤ 同 externalId 重复提交 → 返回已有 id 且 duplicate=true，不新建
 *  ⑥ **没有 externalId 就不猜重复**（同手机号两次提交是两件事，不能吞）
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

const TOKEN = "test-inbound-token-abc";

let prisma: PrismaClient;
let dropDb: (() => Promise<void>) | undefined;
let POST: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  await prisma.user.create({
    data: { email: "recv@t.local", name: "接收人", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  process.env.INBOUND_LEAD_TOKEN = TOKEN;
  ({ POST } = await import("@/app/api/inbound/lead/route"));
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);
beforeEach(async () => {
  await prisma.leadActivity.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.leadChannel.deleteMany({});
  await prisma.systemSetting.deleteMany({});
  process.env.INBOUND_LEAD_TOKEN = TOKEN;
});

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));

function req(body: unknown, token: string | null = TOKEN, ip = "1.2.3.4") {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": ip };
  if (token !== null) headers["x-inbound-token"] = token;
  return new Request("http://localhost/api/inbound/lead", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

describe("官网表单入站", () => {
  it("**未配置 token → 503 且给出配置方法**（不静默放行）", async () => {
    delete process.env.INBOUND_LEAD_TOKEN;
    const res = await POST(req({ name: "张三" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.howTo).toContain("INBOUND_LEAD_TOKEN");
  });

  it("token 错 → 401；缺 token → 401", async () => {
    expect((await POST(req({ name: "张三" }, "wrong"))).status).toBe(401);
    expect((await POST(req({ name: "张三" }, null))).status).toBe(401);
  });

  it("字段校验失败 → 400 且指出哪一项", async () => {
    const res = await POST(req({ name: "", phone: "123" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    const paths = body.issues.map((i: { path: string }) => i.path);
    expect(paths).toContain("name");
    expect(paths).toContain("phone");
  });

  it("正常入站 → 201、LEAD 阶段、ONLINE 来源、**UNASSIGNED**（进待派单）", async () => {
    const res = await POST(req({ name: "李四", phone: "13900001234", message: "想咨询离婚" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.duplicate).toBe(false);

    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: body.id } });
    expect(lead.stage).toBe("LEAD");
    expect(lead.source).toBe("ONLINE");
    expect(lead.assigneeStatus).toBe("UNASSIGNED");
    expect(lead.notes).toContain("想咨询离婚");
    expect(lead.phone).toBe("13900001234");
  });

  it("**同 externalId 重复提交 → 返回已有 id，不新建**", async () => {
    const first = await (await POST(req({ name: "王五", externalId: "form-001" }))).json();
    const again = await (await POST(req({ name: "王五", externalId: "form-001" }))).json();
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
    expect(await prisma.lead.count()).toBe(1);
  });

  it("**没有 externalId 就不猜重复**（同手机号两次是两件事）", async () => {
    const a = await (await POST(req({ name: "赵六", phone: "13900005678" }))).json();
    const b = await (await POST(req({ name: "赵六", phone: "13900005678" }))).json();
    expect(b.duplicate).toBe(false);
    expect(b.id).not.toBe(a.id);
    expect(await prisma.lead.count()).toBe(2);
  });

  it("渠道名匹配到就挂上；匹配不到不拒单（只是不挂渠道）", async () => {
    const ch = await prisma.leadChannel.create({ data: { name: "大众点评", kind: "PAID" } });
    const hit = await (await POST(req({ name: "钱七", channelName: "大众点评" }))).json();
    const got = await prisma.lead.findUniqueOrThrow({ where: { id: hit.id } });
    expect(got.channelId).toBe(ch.id);

    const miss = await (await POST(req({ name: "孙八", channelName: "不存在的渠道" }))).json();
    const got2 = await prisma.lead.findUniqueOrThrow({ where: { id: miss.id } });
    expect(got2.channelId).toBeNull();
  });

  it("没有可用接收人 → 503（不能硬塞给随机用户）", async () => {
    await prisma.user.updateMany({ data: { active: false } });
    const res = await POST(req({ name: "周九" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.howTo).toContain("leadInboundOwnerId");
  });
});
