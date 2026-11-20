// @vitest-environment node
/**
 * 手机号归一与重复咨询识别（真库，2026-11-22，对标分析 P0-2）
 *
 * 客户现行系统里专门有一列「联系方式-是否重复」。同一客户会多次来电、多平台来单，
 * 不识别就会：两个销售撞单、老客户被当新客户重新教育、投放重复计费。
 *
 * 三条口径各能搞错，逐条钉住：
 *  ① **归一化**：库里存的是原始输入（「186 5538 2185」「+8618655382185」），
 *     不归一就查不出同一个人
 *  ② **只提示不阻断**：同号可能是家人代接/公司总机，硬拦会挡掉真实新客户
 *  ③ **跨实体**：只查线索会漏掉「老客户又来问」——那才是最该识别的情形
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
const STAFF = { id: "" };

beforeAll(async () => {
  const db = await createTempDatabase(NAME);
  prisma = db.prisma;
  dropDb = db.drop;
  const u = await prisma.user.create({
    data: { email: "dedupe@t.local", name: "张律师", role: "PRINCIPAL_LAWYER", passwordHash: "x", active: true }
  });
  STAFF.id = u.id;
}, 180_000);
afterAll(async () => { await dropDb?.(); }, 60_000);

vi.mock("@/lib/prisma", () => ({ get prisma() { return prisma; } }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => ({ user: { id: STAFF.id, role: "PRINCIPAL_LAWYER", rolePermissions: undefined } }))
}));
vi.mock("@/server/audit", () => ({ audit: vi.fn(async () => {}), auditTx: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));

const { normalizePhone, findPhoneDuplicates } = await import("@/server/leads/phone");
const { createLead, listLeads } = await import("@/server/leads/actions");

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

describe("归一化", () => {
  it("空格/横线/括号/国际区号/前导 0 都能归一到同一串", () => {
    const expected = "18655382185";
    for (const raw of ["18655382185", "186 5538 2185", "186-5538-2185", "+86 18655382185", "008618655382185", "(186)55382185"]) {
      expect(normalizePhone(raw), raw).toBe(expected);
    }
  });

  it("空值与非手机号返回空串（不误判）", () => {
    expect(normalizePhone(null)).toBe("");
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("")).toBe("");
  });
});

describe("跨实体查重", () => {
  it("同号的其它线索会被找到（不同书写法也算）", async () => {
    await prisma.lead.create({ data: { name: uid("老的"), phone: "186 5538 2185", ownerId: STAFF.id } });
    const hits = await findPhoneDuplicates("+8618655382185");
    expect(hits.some((h) => h.kind === "LEAD")).toBe(true);
  });

  it("客户档案联系人同号也能找到（老客户又来问的情形）", async () => {
    const client = await prisma.client.create({
      data: { name: uid("老客户公司"), type: "COMPANY", cooperationStatus: "SIGNED" }
    });
    await prisma.contact.create({
      data: { clientId: client.id, name: "王主任", phone: "13800001234", isPrimary: true }
    });
    const hits = await findPhoneDuplicates("13800001234");
    const hit = hits.find((h) => h.kind === "CLIENT");
    expect(hit).toBeTruthy();
    expect(hit!.name).toContain("老客户公司");
  });

  it("尾号相同但整体不同 → **不误报**（SQL 粗筛后还有精确比对）", async () => {
    await prisma.lead.create({ data: { name: uid("尾号巧合"), phone: "19900002185", ownerId: STAFF.id } });
    const hits = await findPhoneDuplicates("18655382185");
    // 19900002185 的后四位也是 2185，但不该被当成同一个号
    expect(hits.every((h) => !h.name.includes("尾号巧合"))).toBe(true);
  });

  it("编辑场景可排除自身", async () => {
    const lead = await prisma.lead.create({ data: { name: uid("自己"), phone: "13700007777", ownerId: STAFF.id } });
    const withSelf = await findPhoneDuplicates("13700007777");
    expect(withSelf.some((h) => h.id === lead.id)).toBe(true);
    const without = await findPhoneDuplicates("13700007777", { excludeLeadId: lead.id });
    expect(without.some((h) => h.id === lead.id)).toBe(false);
  });
});

describe("登记时只提示不阻断", () => {
  it("同号仍能登记成功，且把命中摘要返回给界面", async () => {
    const name = uid("第二次咨询");
    const res = await createLead({ name, phone: "13600008888" });
    expect(res.ok).toBe(true);

    const again = await createLead({ name: uid("又一单"), phone: "136 0000 8888" });
    expect(again.ok, "同号不该阻断登记").toBe(true);
    expect(again.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(again.duplicates.some((d) => d.kind === "LEAD")).toBe(true);
  });

  it("无重复时不返回命中（避免每次都弹提示）", async () => {
    const res = await createLead({ name: uid("唯一号"), phone: "13500009999" });
    expect(res.duplicates).toHaveLength(0);
  });

  it("列表内同号会标出重复数", async () => {
    await createLead({ name: uid("甲"), phone: "13300001111" });
    await createLead({ name: uid("乙"), phone: "133 0000 1111" });
    const rows = await listLeads({ stage: "ALL" });
    const marked = rows.filter((r) => normalizePhone(r.phone) === "13300001111");
    expect(marked.length).toBe(2);
    expect(marked.every((r) => r.phoneDuplicateCount >= 1)).toBe(true);
  });
});
