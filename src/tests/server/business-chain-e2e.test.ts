// @vitest-environment node
/**
 * 业务链端到端：客户建档 → 收案 → 冲突检索 → 转案 → 当事人 → 程序 → 期限 → 工时
 * → 实收（登记/确认）→ 收费安排与核销 → 归档送审 → 归档审批（A–M）。
 *
 * 为什么写这一个文件（见 docs/VERIFICATION-PLAYBOOK.md 第五节「我还没做到的」）：
 * 前 32 轮验证了引用完整性、页面可达、权限与财务口径，但每份测试都只覆盖一段；
 * 「链条断在第七步」是所有单点测试都绿的情况下仍然存在的风险。这里按真实业务顺序
 * 走一遍**写操作闭环**，每一步都断言落库结果，最后再验编号链、外键链、审计链与终态一致。
 *
 * 与既有真库测试同一套隔离手法（不自己发明）：
 *   1. 临时库 `lawlink_chain_test_*`（lawlink-db:55432）→ `prisma migrate deploy` → 结束
 *      `DROP DATABASE ... WITH (FORCE)`。**绝不写主库 lawlink**。
 *   2. `DATABASE_URL` 在 `@/lib/prisma` 单例初始化之前落盘（vi.hoisted），且**不 mock**
 *      `@/lib/prisma`——审计链的 integrityHash/previousHash 是 Prisma 客户端扩展写在
 *      create 上的，换成裸 client 就只能验到「null 全跳过」，那样的 ok:true 没有意义。
 *   3. 会话注入：mock `@/lib/auth/session`，用 `as(user)` 切身份（申请人 / 审批人 / 财务）。
 *   4. mock 掉 next/cache 与 @/server/matters/route（revalidate 与页面跳转与本链无关）。
 *   5. 附件与模版落盘走 `APP_STORAGE_DIR` 指向的临时目录（真实 AES-256-GCM 读写，不 mock 存储层）。
 *
 * 入口选择：能用 server action 的一律用 action。一处例外在用例标题里写明：
 *   - 旧 FeeEntry 直登入口（createFeeEntry）在当前 schema 下被硬禁用，实收改走同一业务的
 *     新入口 registerReceipt / confirmReceipt，并单独固化旧入口的拒绝行为。
 *
 * 2026-11-19 生产修复后的口径（本文件已按修复后行为重写，全程不依赖任何环境补丁）：
 *   - 迁移 20261119000006 撤销 AuditLog.previousHash 唯一索引后，同一事务内写多条审计
 *     不再毒化事务，转案（当前唯一建案入口）恢复可用 → D-2 正向验证转案成功；
 *   - D-3 正向验证「同一事务两条审计」都提交、都有摘要，且 previousHash 相同（链在此分叉）。
 *     分叉是**可接受的已知取舍**（可用性优先于「数据库硬拦导致无法建案」），
 *     由 verifyAuditChain 的 forks 字段显式报告 —— 从「静默只走第一条」改为「可查出、可归因」；
 *   - 旧 D-4（先在本文件临时库上手工移除唯一索引才能继续跑下游）整段删除：测试不再改动库结构。
 *
 * 仍存在的已知缺陷（唯一一条，与转案无关）：
 *   D-1 createClient 丢弃 legalRep —— 机构客户的法定代表人一路丢到当事人（见 A / D-2）。
 *
 * 前置：lawlink-db 容器可用（55432），`.env` 提供 STORAGE_ENCRYPTION_KEY。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// 临时库 / 临时存储：必须在 @/lib/prisma 与 @/lib/storage 初始化之前落盘
// ---------------------------------------------------------------------------

const HOLDER = vi.hoisted(() => {
  const host = process.env.CHAIN_TEST_PG_HOST ?? "localhost:55432";
  const user = process.env.CHAIN_TEST_PG_USER ?? "lawlink";
  const password = process.env.CHAIN_TEST_PG_PASSWORD ?? "lawlink_dev_2026";
  const name = `lawlink_chain_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const url = `postgresql://${user}:${password}@${host}/${name}?schema=public`;
  const storageDir = `${process.env.TMPDIR ?? "/tmp"}/lawlink-chain-storage-${name}`;
  const originalUrl = process.env.DATABASE_URL;
  const originalStorage = process.env.APP_STORAGE_DIR;
  process.env.DATABASE_URL = url;
  process.env.APP_STORAGE_DIR = storageDir;
  return {
    host, user, password, name, url, storageDir, originalUrl, originalStorage,
    session: { user: { id: "", name: "", role: "LAWYER" } } as any
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/server/matters/route", () => ({
  revalidateMatter: vi.fn(),
  matterHref: (id: string) => `/matters/${id}`,
  matterHrefById: async (id: string) => `/matters/${id}`,
  resolveMatterRoute: async () => null
}));
// 会话注入：A–M 每一步都在 action 入口 requireSession，用可变 HOLDER.session 切身份
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => HOLDER.session),
  getSession: vi.fn(async () => HOLDER.session),
  requireSystemAdmin: vi.fn(async () => HOLDER.session)
}));

import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { decryptBuffer, sha256 } from "@/lib/storage/crypto";
import { decryptIdNumber, isEncryptedIdNumber } from "@/lib/clients/id-number-crypto";
import { verifyAuditChain } from "@/lib/audit-chain";
import { civilKey, shDayKey } from "@/lib/ui/sh-time";
import { parseArchiveSnapshot, requiredArchiveVerificationIds } from "@/lib/archive/snapshot";
import { seedV08Templates } from "../../../prisma/seeds/v08-templates-and-seals";

import { createClient } from "@/server/clients/actions";
import { createIntake, convertIntakeToMatter, resubmitIntake } from "@/server/intakes/actions";
import { runCheckAndSave } from "@/server/conflicts/actions";
import { updateProcedureInfo } from "@/server/matters/actions";
import { addProcedure, addDeadline, toggleDeadlineCompleted } from "@/server/procedures/actions";
import { addTimeEntry } from "@/server/time/actions";
import { createFeeEntry } from "@/server/finance/actions";
import { registerBilling, registerReceipt, confirmReceipt, allocateLedger } from "@/server/finance/ledger-actions";
import { saveArchivePolicy } from "@/server/archive/policy";
import { saveClosure } from "@/server/archive/closure-actions";
import { archiveMatter, approveArchiveRecord } from "@/server/archive/actions";

const urlFor = (database: string) =>
  `postgresql://${HOLDER.user}:${HOLDER.password}@${HOLDER.host}/${database}?schema=public`;

let admin: PrismaClient;

// ── 身份 ──
type Actor = { id: string; name: string; role: "LAWYER" | "PRINCIPAL_LAWYER" | "FINANCE"; systemRole?: string | null };
let lawyer: Actor;      // 承办律师：建档 / 收案 / 程序 / 期限 / 工时 / 登记实收 / 送审归档
let approver: Actor;    // 主任律师 + 系统管理员：审批收案、审批归档、配置制度
let finance: Actor;     // 财务岗：确认实收、核销

/** 切换当前会话身份（mock 的 requireSession 返回它） */
function as(actor: Actor) {
  HOLDER.session = {
    user: {
      id: actor.id,
      name: actor.name,
      role: actor.role,
      systemRole: actor.systemRole ?? null,
      rolePermissions: undefined,
      managerAuthorized: false
    }
  };
}

// ── 链路状态（按 A→M 顺序填充） ──
let individualClient: { id: string; internalCode: string | null };
let companyClient: { id: string; internalCode: string | null };
let intakeId: string;
let checkId: string;
let matterId: string;
let matterInternalCode: string;
let firstProcedureId: string;   // 转案自动生成的一审
let secondProcedureId: string;  // F 步 addProcedure 追加的程序
let partyClientId: string;
let partyOpposingId: string;
let deadlineId: string;
let timeEntryId: string;
let feeEntryId: string;
let paymentId: string;
let billingId: string;
let receivableId: string;
let archiveId: string;
let archiveNo: string;
let completedAt: Date;

// D-3 探针：同一事务内两条审计共用的前驱摘要（= 分叉点），以及两条审计的 id
let probeForkPrev: string;
let probeIds: string[];

const dec = (value: Prisma.Decimal | string | number) => new Prisma.Decimal(value).toFixed(2);
/**
 * verifyAuditChain 的入参在 src/lib/audit-chain.ts 里只声明了 auditLog.findMany 的窄签名，
 * 与 Prisma 客户端的强类型 findMany 不兼容（项目既有的类型摩擦）。这里收口成一处适配，
 * 运行时用的仍是**扩展后的真客户端**（不 mock），审计摘要/前驱都由扩展写入。
 */
const chainDb = () => prisma as unknown as Parameters<typeof verifyAuditChain>[0];
const countAudit = (action: string) => prisma.auditLog.count({ where: { action } });

beforeAll(async () => {
  if (!process.env.STORAGE_ENCRYPTION_KEY) {
    process.env.STORAGE_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  }
  mkdirSync(HOLDER.storageDir, { recursive: true });

  admin = new PrismaClient({ datasourceUrl: urlFor("postgres") });
  // 并发 CREATE DATABASE 会撞模板库占用（「source database is being accessed by
  // other users」），表现为「重跑就过」的偶发红。这里退避重试；
  // 与 src/tests/helpers/temp-db.ts 同一处理（那 19 个文件已迁到 helper）。
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${HOLDER.name}"`);
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      if (/already exists/i.test(String(err))) { lastErr = undefined; break; }
      if (!/being accessed by other users|template/i.test(String(err))) break;
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  if (lastErr) throw new Error(`临时库创建失败，需先启动 lawlink-db：${String(lastErr)}`);
  execFileSync(path.join(process.cwd(), "node_modules", ".bin", "prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: HOLDER.url },
    stdio: "pipe"
  });

  // 身份夹具：岗位（role）决定业务规则，系统管理员只额外用于配置归档制度
  lawyer = await prisma.user.create({
    data: { name: "承办律师", email: `lawyer-${HOLDER.name}@example.test`, passwordHash: "x", role: "LAWYER", active: true }
  }) as unknown as Actor;
  approver = await prisma.user.create({
    data: {
      name: "主任律师", email: `approver-${HOLDER.name}@example.test`, passwordHash: "x",
      role: "PRINCIPAL_LAWYER", systemRole: "SUPER_ADMIN", active: true
    }
  }) as unknown as Actor;
  finance = await prisma.user.create({
    data: { name: "财务", email: `finance-${HOLDER.name}@example.test`, passwordHash: "x", role: "FINANCE", active: true }
  }) as unknown as Actor;

  // 审批授权：收案审批 + 归档审批（ALL_CASES）。没有这条规则 createIntake / convertIntakeToMatter /
  // archiveMatter 都会在 requireApprovalRoute 处拒绝——这也是链路第一道真实门禁。
  const group = await prisma.approvalPermissionGroup.create({
    data: {
      name: `链路测试审批组-${HOLDER.name}`,
      members: { create: [{ userId: approver.id }] }
    }
  });
  await prisma.approvalPermissionRule.createMany({
    data: [
      { groupId: group.id, action: "INTAKE_APPROVE", caseScope: "ALL_CASES", categories: [], sealTypes: [] },
      { groupId: group.id, action: "ARCHIVE_APPROVE", caseScope: "ALL_CASES", categories: [], sealTypes: [] }
    ]
  });

  // 归档制度原文 + 制度配置（L 步 archiveMatter 要求「可核验的制度」）
  const policyBytes = Buffer.from("LawLink 测试用归档制度 v1.0（链路测试夹具）\n", "utf8");
  const policyPath = await storage.writeFile("firm-files", policyBytes);
  const firmFile = await prisma.firmFile.create({
    data: {
      name: "归档制度(链路测试).txt",
      category: "POLICY",
      path: policyPath,
      mimeType: "text/plain",
      size: policyBytes.length,
      sha256: sha256(policyBytes),
      uploadedById: approver.id
    }
  });
  as(approver);
  await saveArchivePolicy({
    name: "LawLink 归档制度（链路测试）",
    version: "v1.0",
    effectiveAt: "2026-01-01",
    sourceFileId: firmFile.id
  });

  // 内置文书模板（卷宗封皮 / 目录由模板渲染，缺模板 archiveMatter 直接拒绝）
  await seedV08Templates(prisma as unknown as PrismaClient);

  console.info(`[business-chain] 临时库：${HOLDER.name}；存储目录：${HOLDER.storageDir}`);
}, 300_000);

afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
  if (admin) {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${HOLDER.name}" WITH (FORCE)`);
    await admin.$disconnect();
    console.info(`[business-chain] 已 DROP 临时库：${HOLDER.name}`);
  }
  rmSync(HOLDER.storageDir, { recursive: true, force: true });
  if (HOLDER.originalUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = HOLDER.originalUrl;
  if (HOLDER.originalStorage === undefined) delete process.env.APP_STORAGE_DIR;
  else process.env.APP_STORAGE_DIR = HOLDER.originalStorage;
}, 120_000);

// ===========================================================================
// A. 客户建档
// ===========================================================================
describe("A 客户建档（createClient）", () => {
  it("自然人与机构各建一档：客户编号按 KH-年份-流水 生成，证件号落库为密文", async () => {
    as(lawyer);

    const individual = await createClient({
      name: "张三",
      type: "INDIVIDUAL",
      cooperationStatus: "SIGNED",
      idType: "ID_CARD",
      idNumber: "330106199003071234",
      phone: "13800000001",
      address: "杭州市西湖区文三路 1 号",
      gender: "MALE",
      tags: ["链路测试"],
      contacts: [{ name: "张三", phone: "13800000001", isPrimary: true, title: "", email: "", wechat: "", notes: "" }]
    });
    const company = await createClient({
      name: "甲科技有限公司",
      type: "COMPANY",
      idType: "USCC",
      idNumber: "91330100MA2H0001X2",
      legalRep: "李四",
      phone: "0571-88880000",
      address: "杭州市滨江区江南大道 100 号",
      cooperationStatus: "SIGNED",
      tags: ["链路测试"],
      contacts: []
    });

    const person = await prisma.client.findUniqueOrThrow({ where: { id: individual.id } });
    const org = await prisma.client.findUniqueOrThrow({ where: { id: company.id } });
    individualClient = { id: person.id, internalCode: person.internalCode };
    companyClient = { id: org.id, internalCode: org.internalCode };

    // 客户编号：同一个计数器、按建档顺序自增（全新库从 0001 起）
    expect(person.internalCode).toMatch(/^KH-\d{4}-0001$/);
    expect(org.internalCode).toMatch(/^KH-\d{4}-0002$/);

    // 证件号加密：库内不是明文，且能被解密回规范化号码
    expect(person.idNumber).not.toBe("330106199003071234");
    expect(isEncryptedIdNumber(person.idNumber)).toBe(true);
    expect(decryptIdNumber(person.idNumber)).toBe("330106199003071234");
    expect(person.idNumberBlind).toMatch(/^[0-9a-f]{64}$/);
    expect(isEncryptedIdNumber(org.idNumber)).toBe(true);
    expect(decryptIdNumber(org.idNumber)).toBe("91330100MA2H0001X2");

    expect(person.type).toBe("INDIVIDUAL");
    expect(org.type).toBe("COMPANY");
    // 缺陷 D-1（已固化，未修生产代码）：createClient 的写入白名单里没有 legalRep，
    // 入参的法定代表人被静默丢弃——机构客户建档后「法定代表人」永远为空，
    // 而转案时当事人 legalRep 又取自 Client（convertIntakeToMatter 用 intake.client.legalRep），
    // 于是机构委托方的法定代表人一路丢到卷宗。
    expect(org.legalRep).toBeNull();
    expect(org.cooperationStatus).toBe("SIGNED");
    expect(await prisma.contact.count({ where: { clientId: person.id, isPrimary: true } })).toBe(1);

    expect(await countAudit("CLIENT_CREATE")).toBe(2);
  });
});

// ===========================================================================
// B. 收案登记
// ===========================================================================
describe("B 收案登记（createIntake）", () => {
  it("以机构客户为委托方登记收案：落 Intake、状态 INTAKE、关联客户与相对方", async () => {
    as(lawyer);
    const receivedAt = new Date("2026-11-10T09:00:00+08:00");
    const created = await createIntake({
      category: "CIVIL_COMMERCIAL",
      title: "甲科技有限公司与乙贸易有限公司买卖合同纠纷",
      description: "货款催收",
      receivedAt,
      clientId: companyClient.id,
      clientType: "COMPANY",
      contactName: "李四",
      contactPhone: "0571-88880000",
      firstProcedureType: "FIRST_INSTANCE",
      firstAgency: "杭州市西湖区人民法院",
      jurisdiction: "浙江省杭州市西湖区",
      ourStanding: "PLAINTIFF",
      claimAmount: 500000,
      claimDescription: "请求支付货款 50 万元及利息",
      barFiling: "NONE",
      counterclaim: false,
      feeType: "FIXED",
      feeAmount: 20000,
      feeSchedule: "签约后 7 日内付清",
      ownerUserId: lawyer.id,
      coUserIds: [],
      parties: [
        {
          role: "OPPOSING_PARTY",
          standing: "DEFENDANT",
          ordinal: 2,
          name: "乙贸易有限公司",
          partyType: "COMPANY",
          enterpriseSocialCode: "91330100MA2H0002Y3"
        }
      ]
    });
    intakeId = (created as { id: string }).id;

    const intake = await prisma.intake.findUniqueOrThrow({
      where: { id: intakeId },
      include: { parties: true }
    });
    expect(intake.status).toBe("INTAKE");        // 送审轮次功能已启用 → 先落 INTAKE
    expect(intake.clientId).toBe(companyClient.id);
    expect(intake.ownerUserId).toBe(lawyer.id);
    expect(intake.createdById).toBe(lawyer.id);
    expect(intake.category).toBe("CIVIL_COMMERCIAL");
    expect(intake.ourStanding).toBe("PLAINTIFF");
    expect(intake.feeType).toBe("FIXED");
    expect(dec(intake.feeAmount!)).toBe("20000.00");
    expect(intake.receivedAt.toISOString()).toBe(receivedAt.toISOString());
    expect(intake.firstProcedureType).toBe("FIRST_INSTANCE");
    expect(intake.parties).toHaveLength(1);
    expect(intake.parties[0].role).toBe("OPPOSING_PARTY");
    expect(intake.parties[0].name).toBe("乙贸易有限公司");
    expect(intake.parties[0].standing).toBe("DEFENDANT");
    expect(intake.parties[0].enterpriseSocialCode).toBe("91330100MA2H0002Y3");

    expect(await countAudit("INTAKE_CREATE")).toBe(1);
  });
});

// ===========================================================================
// C. 冲突检索
// ===========================================================================
describe("C 冲突检索（runCheckAndSave）", () => {
  it("对本收案主体跑正式检索：ConflictCheck 落库、自动给出 DIFFERENT 结论、主体指纹落库", async () => {
    as(lawyer);
    const result = await runCheckAndSave({
      intakeId,
      // 收案正式检索以服务端重算的主体为准（assertIntakeEditor + intakeState），这里的输入会被覆盖
      queries: [{ role: "OPPOSING_PARTY", name: "乙贸易有限公司", idNumber: "91330100MA2H0002Y3" }]
    });
    checkId = (result as { checkId: string }).checkId;

    const check = await prisma.conflictCheck.findUniqueOrThrow({
      where: { id: checkId },
      include: { hits: true }
    });
    expect(check.intakeId).toBe(intakeId);
    expect(check.conclusion).toBe("DIFFERENT");
    expect(check.decidedById).toBe(lawyer.id);
    expect(check.decidedAt).not.toBeNull();
    expect(check.hits).toHaveLength(0);
    expect(check.note).toContain("未命中");

    // 冲突检索的主体覆盖必须包含委托方与相对方两侧（否则转案时会被 assertConflictReviewAllowsConversion 拦）
    const payload = check.queryPayload as { queries: { role: string; name: string }[] };
    const roles = payload.queries.map((q) => q.role);
    expect(roles).toContain("CLIENT_PARTY");
    expect(roles).toContain("OPPOSING_PARTY");
    expect(payload.queries.map((q) => q.name)).toEqual(
      expect.arrayContaining(["甲科技有限公司", "乙贸易有限公司"])
    );

    // 主体指纹：转案时 assertIntakeConvertible 用它比对送审轮次
    const [meta] = await prisma.$queryRaw<{ subjectFingerprint: string | null }[]>`
      SELECT "subjectFingerprint" FROM "ConflictCheck" WHERE id = ${checkId}`;
    expect(meta.subjectFingerprint).toMatch(/^[0-9a-f]{64}$/);

    expect(await countAudit("CONFLICT_CHECK_RUN")).toBe(1);
  });
});

// ===========================================================================
// D. 转正式案件
// ===========================================================================
describe("D 转为正式案件（resubmitIntake → convertIntakeToMatter）", () => {
  it("D-1 送审固定轮次：收案转 PENDING_CONFIRMATION，轮次快照与冲突检索绑定", async () => {
    as(lawyer);
    await resubmitIntake(intakeId);
    const submitted = await prisma.intake.findUniqueOrThrow({ where: { id: intakeId } });
    expect(submitted.status).toBe("PENDING_CONFIRMATION");
    const revision = await prisma.intakeRevision.findFirstOrThrow({ where: { intakeId } });
    expect(revision.round).toBe(1);
    expect(revision.checkId).toBe(checkId);
    expect(await countAudit("INTAKE_SUBMIT_ROUND")).toBe(1);
  });

  it("D-2 转案成功（2026-11-19 修复后）：Matter/首程序/当事人/MatterClient/收费草稿全部落库，收案转 CONVERTED", async () => {
    as(approver);
    const converted = await convertIntakeToMatter(intakeId, "链路测试：主体与范围已复核");

    // 返回契约：ok + matterId + internalCode，调用方无需回查案件
    expect((converted as { ok: boolean }).ok).toBe(true);
    matterId = (converted as { matterId: string }).matterId;
    matterInternalCode = (converted as { internalCode: string }).internalCode;
    expect(matterId).toBeTruthy();
    // internalCode = {前缀}-{上海年}-{类别码}-{4 位流水}；这是本库第一次建案 → 0001。
    // 旧缺陷「事务外取号 + 失败重试跳号」随修复消失，所以这里断言的是 0001 而不是 0002。
    expect(matterInternalCode).toMatch(/^LL-\d{4}-CC-0001$/);

    // 收案侧终态
    const intakeAfter = await prisma.intake.findUniqueOrThrow({ where: { id: intakeId } });
    expect(intakeAfter.status).toBe("CONVERTED");

    // 案件主体
    const matter = await prisma.matter.findUniqueOrThrow({
      where: { id: matterId },
      include: { clientLinks: true, members: true }
    });
    expect(matter.internalCode).toBe(matterInternalCode);
    expect(matter.firmCaseNo).toBeTruthy();
    expect(matter.title).toBe("甲科技有限公司与乙贸易有限公司买卖合同纠纷");
    expect(matter.category).toBe("CIVIL_COMMERCIAL");
    expect(matter.ownerId).toBe(lawyer.id);
    expect(matter.registeredById).toBe(lawyer.id);
    expect(matter.primaryClientId).toBe(companyClient.id);
    expect(matter.intakeId).toBe(intakeId);        // matterId ↔ intakeId 双向串联
    expect(matter.ourStanding).toBe("PLAINTIFF");
    expect(dec(matter.claimAmount!)).toBe("500000.00");
    expect(matter.intakeDate?.toISOString()).toBe(new Date("2026-11-10T09:00:00+08:00").toISOString());

    // 客户关联：指向 A 步建的机构客户（MatterClient）
    expect(matter.clientLinks).toHaveLength(1);
    expect(matter.clientLinks[0].clientId).toBe(companyClient.id);
    expect(matter.clientLinks[0].isPrimary).toBe(true);
    expect(matter.clientLinks[0].label).toBe("主要委托方");
    expect(matter.members.map((m) => [m.userId, m.role])).toEqual([[lawyer.id, "LEAD"]]);

    // 首程序（一审）：转案按收案当前程序建立
    const procedures = await prisma.matterProcedure.findMany({
      where: { matterId },
      orderBy: { order: "asc" },
      include: { procedureParties: true }
    });
    expect(procedures).toHaveLength(1);
    const first = procedures[0];
    firstProcedureId = first.id;
    expect(first.type).toBe("FIRST_INSTANCE");
    expect(first.engagement).toBe("ENGAGED");
    expect(first.order).toBe(1);
    expect(first.leadLawyerId).toBe(lawyer.id);
    expect(first.handlingAgency).toBe("杭州市西湖区人民法院");
    expect(first.jurisdiction).toBe("浙江省杭州市西湖区");
    expect(first.ourStanding).toBe("PLAINTIFF");

    // 委托方作为 CLIENT_PARTY 自动进入案件；收案登记的相对方也被复制成案件侧当事人（副本）
    const parties = await prisma.party.findMany({ where: { matterId }, orderBy: [{ role: "asc" }, { ordinal: "asc" }] });
    expect(parties).toHaveLength(2);
    const clientPartyRow = parties.find((p) => p.role === "CLIENT_PARTY")!;
    const opposingRow = parties.find((p) => p.role === "OPPOSING_PARTY")!;
    partyClientId = clientPartyRow.id;
    partyOpposingId = opposingRow.id;
    expect(clientPartyRow.name).toBe("甲科技有限公司");
    expect(clientPartyRow.standing).toBe("PLAINTIFF");
    expect(clientPartyRow.enterpriseSocialCode).toBe("91330100MA2H0001X2"); // 客户密文在当事人侧解密为明文
    // 缺陷 D-1 的传导：客户没有 legalRep → 当事人 legalRep 也为空
    expect(clientPartyRow.legalRep).toBeNull();
    expect(opposingRow.name).toBe("乙贸易有限公司");
    expect(opposingRow.standing).toBe("DEFENDANT");
    expect(opposingRow.enterpriseSocialCode).toBe("91330100MA2H0002Y3");
    // 收案侧当事人保留（matterId 为空），案件侧是新副本——同一主体在两张表各一行
    expect(await prisma.party.count({ where: { intakeId, matterId: null } })).toBe(1);
    // 转案同时把两个当事人挂到首程序（委托方 + 收案相对方副本）
    expect(first.procedureParties.map((p) => [p.partyId, p.standing])).toEqual([
      [partyClientId, "PLAINTIFF"],
      [partyOpposingId, "DEFENDANT"]
    ]);

    // 收案律师费 → 收费安排草稿（DRAFT，尚未生成应收）
    const draft = await prisma.billing.findMany({ where: { matterId } });
    expect(draft).toHaveLength(1);
    expect(draft[0].status).toBe("DRAFT");
    expect(draft[0].moneyKind).toBe("LAWYER_FEE");
    expect(dec(draft[0].contractAmount)).toBe("20000.00");
    expect(draft[0].title).toBe("委托代理合同 - 固定收费");
    expect(await prisma.receivable.count({ where: { matterId } })).toBe(0);

    // 默认卷宗已建（案件详情页依赖）
    expect(await prisma.documentFolder.count({ where: { matterId } })).toBeGreaterThan(0);

    // 审计：INTAKE_CONVERT 在事务外写，detail 串上 matterId 与 internalCode —— 收案↔案件↔编号三方可追溯
    expect(await countAudit("INTAKE_CONVERT")).toBe(1);
    const convertAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "INTAKE_CONVERT", targetId: intakeId }
    });
    expect((convertAudit.detail as { matterId?: string }).matterId).toBe(matterId);
    expect((convertAudit.detail as { internalCode?: string }).internalCode).toBe(matterInternalCode);
    // 事务内的审批台账（第二条审计）也一并提交了——这正是修复前会让整个事务 25P02 的那一笔
    expect(await countAudit("INTAKE_APPROVE")).toBe(1);

    // 既然转案事务内写了多条审计，链上就必然出现「同一前驱挂多条后继」的分叉。
    // 修复前这里会直接抛 25P02（事务毒化）；现在功能可用，代价是分叉——由 verifyAuditChain 查出。
    const chainAfterConvert = await verifyAuditChain(chainDb());
    const convertFork = chainAfterConvert.forks?.find((f) => f.actions.includes("INTAKE_APPROVE"));
    expect(convertFork).toBeDefined();
    expect(convertFork!.ids.length).toBeGreaterThanOrEqual(2);
    console.info(`[business-chain] 转案事务内多审计：分叉点 ${convertFork!.ids.length} 条后继 → ${convertFork!.actions.join(" / ")}`);
  });

  it("D-3 同一事务内写两条审计不再失败：两条都提交、都有摘要，且 previousHash 相同（链在此分叉）", async () => {
    // 背景（修复前）：审计扩展用**另一条连接**（base）读「上一条摘要」，读不到同事务内尚未提交的
    // 前一条；因此两条审计会算出同一个 previousHash。旧迁移 20261119000004 把 previousHash 设为
    // 唯一索引，于是第二条插入撞键、Postgres 25P02 毒化事务，转案 100% 失败。
    // 迁移 20261119000006 撤销该唯一索引后：两条都能写进去，代价是链在此分叉。
    //
    // **分叉是可接受的已知取舍**：不能建案等于系统作废，而分叉只要查得出来就能事后归因——
    // verifyAuditChain 用 forks 字段显式报出分叉点（本用例末尾直接验证这一点），
    // 不再像修复前那样「沿第一条链走完就说 ok:true」而不报覆盖缺口。
    expect(await prisma.auditLog.count()).toBeGreaterThan(0);   // A/B/C/D-2 已提交的审计链

    probeIds = await prisma.$transaction(async (tx) => {
      const a = await tx.auditLog.create({
        data: { action: "PROBE_TX_AUDIT", targetType: "Probe" },
        select: { id: true }
      });
      const b = await tx.auditLog.create({
        data: { action: "PROBE_TX_AUDIT", targetType: "Probe" },
        select: { id: true }
      });
      return [a.id, b.id];
    });

    // 两条都在事务提交后存在（不是「第一条成功、第二条被吞掉」）
    const rows = await prisma.auditLog.findMany({ where: { id: { in: probeIds } } });
    expect(rows).toHaveLength(2);
    expect(await countAudit("PROBE_TX_AUDIT")).toBe(2);

    // 每条都带完整摘要（说明扩展客户端确实为两条都算了哈希，而不是漏写）
    for (const row of rows) {
      expect(row.integrityHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.previousHash).toMatch(/^[0-9a-f]{64}$/);
    }

    // 已知行为：同事务内两条审计共用同一个前驱 → previousHash 相同（这不是 bug，是取舍）
    probeForkPrev = rows[0].previousHash!;
    expect(rows[0].previousHash).toBe(rows[1].previousHash);

    // verifyAuditChain 必须把这个分叉点报出来（修复 P0-2 的核心：不再假绿灯）
    const chain = await verifyAuditChain(chainDb());
    expect(chain.ok).toBe(true);
    expect(chain.brokenAt).toBeNull();
    expect(chain.forks).not.toBeNull();
    const fork = chain.forks!.find((f) => f.previousHash === probeForkPrev);
    expect(fork).toBeDefined();
    expect(fork!.ids).toEqual(expect.arrayContaining(probeIds));
    expect(fork!.actions).toEqual(["PROBE_TX_AUDIT", "PROBE_TX_AUDIT"]);
    console.info(
      `[business-chain] D-3 分叉点 ${probeForkPrev.slice(0, 12)}… 后继 ${fork!.ids.length} 条；` +
      `checked=${chain.checked} unchecked=${chain.unchecked}`
    );
  });
});

// ===========================================================================
// E. 当事人
// ===========================================================================
describe("E 当事人（updateProcedureInfo：我方/对方入程序 + 新增第三人）", () => {
  it("我方（客户）与对方各一进入首程序，并新增第三人：Party/procedureParty 落库、role/standing 正确", async () => {
    as(lawyer);
    // 我方与对方在 D 步已作为案件当事人存在（委托方自动带入、相对方按收案复制），
    // 本步的「入程序」由 procedureParties 完成；「新增当事人」用第三人走 newProcedureParties 分支。
    // 注意：updateProcedureInfo 是「整表单覆盖」写法（未传的机构/管辖/地位会被清空），
    // 这里显式回填 D 步已有的字段，避免断言被自己的调用清掉。
    await updateProcedureInfo({
      procedureId: firstProcedureId,
      handlingAgency: "杭州市西湖区人民法院",
      jurisdiction: "浙江省杭州市西湖区",
      ourStanding: "PLAINTIFF",
      procedureParties: [
        { partyId: partyClientId, standing: "PLAINTIFF" },
        { partyId: partyOpposingId, standing: "DEFENDANT" }
      ],
      newProcedureParties: [
        {
          name: "丙物流有限公司",
          role: "THIRD_PARTY",
          partyType: "COMPANY",
          enterpriseSocialCode: "91330100MA2H0003Z4",
          standings: ["THIRD_PARTY"]
        }
      ]
    });

    const parties = await prisma.party.findMany({ where: { matterId }, orderBy: [{ role: "asc" }, { ordinal: "asc" }] });
    expect(parties).toHaveLength(3);
    const clientParty = parties.find((p) => p.role === "CLIENT_PARTY")!;
    const opposing = parties.find((p) => p.role === "OPPOSING_PARTY")!;
    const third = parties.find((p) => p.role === "THIRD_PARTY")!;
    expect(clientParty.id).toBe(partyClientId);
    expect(opposing.id).toBe(partyOpposingId);
    expect(opposing.matterId).toBe(matterId);
    // 副本沿用收案当事人的 ordinal（收案里相对方排第 2），不是案件内重新编号
    expect(opposing.ordinal).toBe(2);
    expect(opposing.name).toBe("乙贸易有限公司");
    expect(opposing.standing).toBe("DEFENDANT");
    expect(opposing.partyType).toBe("COMPANY");
    expect(opposing.enterpriseSocialCode).toBe("91330100MA2H0002Y3");
    // 收案相对方只填了名称+信用代码，enterpriseName 留空；转案原样复制该字段，
    // 而 updateProcedureInfo 新增当事人时才会把名称写进 enterpriseName（见下方 third）。
    expect(opposing.enterpriseName).toBeNull();
    expect(third.matterId).toBe(matterId);
    expect(third.ordinal).toBe(1);
    expect(third.name).toBe("丙物流有限公司");
    expect(third.standing).toBe("THIRD_PARTY");
    expect(third.enterpriseSocialCode).toBe("91330100MA2H0003Z4");
    expect(third.enterpriseName).toBe("丙物流有限公司");

    const links = await prisma.procedureParty.findMany({
      where: { procedureId: firstProcedureId },
      orderBy: { ordinal: "asc" }
    });
    expect(links).toHaveLength(3);
    expect(links.map((l) => [l.partyId, l.standing])).toEqual([
      [partyClientId, "PLAINTIFF"],
      [partyOpposingId, "DEFENDANT"],
      [third.id, "THIRD_PARTY"]
    ]);
    expect(await countAudit("PROCEDURE_INFO_UPDATE")).toBe(1);
  });
});

// ===========================================================================
// F. 程序
// ===========================================================================
describe("F 程序（addProcedure）", () => {
  it("一审由转案自动建立（ENGAGED/待办），追加程序走 addProcedure：engagement/status 按契约落库", async () => {
    const first = await prisma.matterProcedure.findUniqueOrThrow({ where: { id: firstProcedureId } });
    // 转案建立的一审：已承接(ENGAGED)，但因财务升级库要求先核合同覆盖，初始状态是 PENDING
    expect(first.engagement).toBe("ENGAGED");
    expect(first.status).toBe("PENDING");
    expect(first.order).toBe(1);

    as(lawyer);
    const added = await addProcedure({
      matterId,
      type: "SECOND_INSTANCE",
      engagement: "INFORMATIONAL",
      handlingAgency: "杭州市中级人民法院",
      jurisdiction: "浙江省杭州市",
      // schema 是 z.string()（不 coerce），传 ISO 字符串；tsc 看到的是 transform 后的 Date 输出类型，故显式收窄
      acceptedAt: "2026-11-18T10:00:00+08:00" as unknown as Date,
      isExternalLead: false,
      leadLawyerId: lawyer.id
    });
    secondProcedureId = (added as { id: string }).id;

    const second = await prisma.matterProcedure.findUniqueOrThrow({ where: { id: secondProcedureId } });
    expect(second.id).toBe(secondProcedureId);
    expect(second.matterId).toBe(matterId);
    expect(second.type).toBe("SECOND_INSTANCE");
    expect(second.engagement).toBe("INFORMATIONAL");
    // INFORMATIONAL（了解性）程序不进入办案状态机，直接 CONCLUDED
    expect(second.status).toBe("CONCLUDED");
    expect(second.order).toBe(2);
    expect(second.handlingAgency).toBe("杭州市中级人民法院");
    expect(second.acceptedAt?.toISOString()).toBe(new Date("2026-11-18T10:00:00+08:00").toISOString());

    expect(await countAudit("PROCEDURE_CREATE")).toBe(1);
  });
});

// ===========================================================================
// G. 期限
// ===========================================================================
describe("G 期限（addDeadline）", () => {
  it("一审举证期限：dueAt 为上海日历日正午载体、procedureId 指一审、事项责任自动建 OPEN 行", async () => {
    as(lawyer);
    const dueAt = new Date(2026, 11, 15, 12, 0, 0); // 2026-12-15 12:00（本地=上海）
    const created = await addDeadline({
      procedureId: firstProcedureId,
      title: "举证期限届满",
      category: "EVIDENCE",
      dueAt,
      basis: "民事诉讼法第六十八条",
      remindDays: 3
    });
    deadlineId = (created as { id: string }).id;

    const deadline = await prisma.deadline.findUniqueOrThrow({ where: { id: deadlineId } });
    expect(deadline.procedureId).toBe(firstProcedureId);
    expect(deadline.title).toBe("举证期限届满");
    expect(deadline.category).toBe("EVIDENCE");
    // 正午载体：日界不错位（UTC 偏移不会把日历日推到前一天/后一天）
    expect(deadline.dueAt.getTime()).toBe(dueAt.getTime());
    expect(deadline.dueAt.getHours()).toBe(12);
    expect(shDayKey(deadline.dueAt)).toBe("2026-12-15");
    expect(civilKey(deadline.dueAt)).toBe("2026-12-15");
    expect(deadline.remindDays).toBe(3);
    // 人工录入（无来源规则）→ 直接视为已确认
    expect(deadline.confirmStatus).toBe("CONFIRMED");
    expect(deadline.sourceRuleId).toBeNull();
    expect(deadline.completed).toBe(false);

    // 期限写入后由数据库触发器建立「事项责任」——它是归档门禁里 work 的来源
    const work = await prisma.workResponsibility.findFirstOrThrow({ where: { deadlineId } });
    expect(work.state).toBe("OPEN");
    expect(work.assigneeId).toBe(lawyer.id);

    expect(await countAudit("DEADLINE_CREATE")).toBe(1);
  });
});

// ===========================================================================
// H. 工时
// ===========================================================================
describe("H 工时（addTimeEntry）", () => {
  it("登记 90 分钟：minutes/进分钟数/费率快照/金额落库，之后调费率不倒灌历史", async () => {
    // 案件级费率：800 元/小时，6 分钟进位
    const rate = await prisma.rateSchedule.create({
      data: {
        scope: "MATTER",
        matterId,
        hourlyRate: new Prisma.Decimal("800.00"),
        billingIncrement: 6,
        effectiveFrom: new Date("2026-01-01T00:00:00+08:00")
      }
    });

    as(lawyer);
    const result = await addTimeEntry({
      matterId,
      workDate: "2026-11-17",
      minutes: 90,
      narrative: "阅卷并起草代理词",
      taskCode: "PLEADING",
      billable: true
    });
    timeEntryId = (result as { id: string }).id;

    const entry = await prisma.timeEntry.findUniqueOrThrow({ where: { id: timeEntryId } });
    expect(entry.matterId).toBe(matterId);
    expect(entry.userId).toBe(lawyer.id);
    expect(entry.minutes).toBe(90);
    expect(entry.billableMinutes).toBe(90);        // 90 已对齐 6 分钟进位
    expect(entry.billable).toBe(true);
    expect(dec(entry.hourlyRateSnapshot)).toBe("800.00");
    expect(entry.rateScheduleId).toBe(rate.id);
    expect(dec(entry.amount)).toBe("1200.00");     // 90/60 × 800
    expect(shDayKey(entry.workDate)).toBe("2026-11-17");
    expect(entry.narrative).toBe("阅卷并起草代理词");

    // 费率快照已锁：新增更高费率不会改写已登记工时
    await prisma.rateSchedule.create({
      data: {
        scope: "USER", userId: lawyer.id,
        hourlyRate: new Prisma.Decimal("1200.00"), billingIncrement: 6,
        effectiveFrom: new Date("2026-11-19T00:00:00+08:00")
      }
    });
    const unchanged = await prisma.timeEntry.findUniqueOrThrow({ where: { id: timeEntryId } });
    expect(dec(unchanged.hourlyRateSnapshot)).toBe("800.00");
    expect(dec(unchanged.amount)).toBe("1200.00");

    expect(await countAudit("TIME_ENTRY_CREATE")).toBe(1);
  });
});

// ===========================================================================
// I. 登记实收（两步留痕第一步）
// ===========================================================================
describe("I 登记实收（registerReceipt）", () => {
  it("登记 20000 元实收：FeeEntry 落 PENDING，未生成 Payment；旧 createFeeEntry 入口在本库已被硬禁用", async () => {
    as(lawyer);
    const res = await registerReceipt({
      matterId,
      amount: "20000",
      moneyKind: "LAWYER_FEE",
      occurredAt: new Date("2026-11-18T10:00:00+08:00"),
      payerOrPayee: "甲科技有限公司",
      note: "一审代理费"
    });
    expect((res as { ok: boolean }).ok).toBe(true);

    const entry = await prisma.feeEntry.findFirstOrThrow({
      where: { matterId, type: "RECEIVED" },
      orderBy: { createdAt: "desc" }
    });
    feeEntryId = entry.id;
    expect(entry.type).toBe("RECEIVED");
    expect(entry.confirmState).toBe("PENDING");   // 两步留痕硬规则：谁登记都一样先挂待确认
    expect(dec(entry.amount)).toBe("20000.00");
    expect(entry.moneyKind).toBe("LAWYER_FEE");
    expect(entry.recordedById).toBe(lawyer.id);
    expect(entry.confirmedById).toBeNull();
    expect(entry.confirmedAt).toBeNull();
    expect(entry.occurredAt.toISOString()).toBe(new Date("2026-11-18T10:00:00+08:00").toISOString());

    // 未确认前不生成实收，也不进统计口径
    expect(await prisma.payment.count({ where: { matterId } })).toBe(0);

    // 旧 FeeEntry 直登入口：本库财务升级已就绪（financeLedgerReady=true），入口被明确禁用
    await expect(createFeeEntry({
      matterId,
      type: "RECEIVED",
      amount: 100,
      occurredAt: new Date("2026-11-18T10:00:00+08:00")
    })).rejects.toThrow(/应收与收款分配/);

    expect(await countAudit("FEE_ENTRY_SUBMIT")).toBe(1);
  });
});

// ===========================================================================
// J. 确认实收（两步留痕第二步）
// ===========================================================================
describe("J 确认实收（confirmReceipt，财务岗）", () => {
  it("确认后：CONFIRMED + confirmedBy/At 落库、生成 Payment、时间线与审计同事务", async () => {
    as(finance);
    const res = await confirmReceipt(feeEntryId);
    expect((res as { ok: boolean }).ok).toBe(true);

    const entry = await prisma.feeEntry.findUniqueOrThrow({ where: { id: feeEntryId } });
    expect(entry.confirmState).toBe("CONFIRMED");
    expect(entry.confirmedById).toBe(finance.id);
    expect(entry.confirmedAt).not.toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { feeEntryId } });
    paymentId = payment.id;
    expect(payment.matterId).toBe(matterId);
    expect(dec(payment.amount)).toBe("20000.00");
    expect(payment.moneyKind).toBe("LAWYER_FEE");
    expect(payment.recordedById).toBe(finance.id);
    expect(dec(payment.allocatedAmount)).toBe("0.00");
    expect(dec(payment.refundedAmount)).toBe("0.00");
    expect(payment.status).toBe("UNALLOCATED");

    // 确认动作的痕迹：审计 + 时间线
    expect(await countAudit("FEE_ENTRY_CONFIRM")).toBe(1);
    const timeline = await prisma.timelineEvent.findMany({ where: { matterId, eventType: "FEE_RECEIVED" } });
    expect(timeline).toHaveLength(1);
    expect(timeline[0].refId).toBe(feeEntryId);
  });
});

// ===========================================================================
// K. 收款分配
// ===========================================================================
describe("K 收款分配（registerBilling → allocateLedger）", () => {
  it("先建收费安排生成应收，再核销：Allocation 落库、应收结清、实收全额核销", async () => {
    as(lawyer);
    const billing = await registerBilling({
      matterId,
      title: "一审代理费（合同）",
      moneyKind: "LAWYER_FEE",
      amount: "20000",
      signedAt: new Date("2026-11-01T10:00:00+08:00"),
      installments: [
        {
          title: "一审代理费",
          amount: "20000",
          dueState: "DATE_SET",
          dueDate: new Date("2026-12-01T12:00:00+08:00")
        }
      ]
    });
    expect((billing as { ok: boolean }).ok).toBe(true);

    const billingRow = await prisma.billing.findFirstOrThrow({
      where: { matterId, status: "ACTIVE" },
      orderBy: { createdAt: "desc" }
    });
    billingId = billingRow.id;
    expect(billingRow.moneyKind).toBe("LAWYER_FEE");
    expect(dec(billingRow.contractAmount)).toBe("20000.00");
    expect(billingRow.signedAt?.toISOString()).toBe(new Date("2026-11-01T10:00:00+08:00").toISOString());

    const receivable = await prisma.receivable.findFirstOrThrow({ where: { matterId, billingId } });
    receivableId = receivable.id;
    expect(dec(receivable.amount)).toBe("20000.00");
    expect(dec(receivable.settledAmount)).toBe("0.00");
    expect(receivable.status).toBe("OPEN");
    expect(receivable.dueState).toBe("DATE_SET");
    expect(receivable.sourceKey).toBe(`billing:${billingId}:1`);

    // 核销（财务岗持有全所 finance.write）
    as(finance);
    const allocated = await allocateLedger({
      paymentId,
      revision: 0,
      kind: "RECEIVABLE",
      items: [{ targetId: receivableId, amount: "20000" }]
    });
    expect((allocated as { ok: boolean }).ok).toBe(true);

    const allocations = await prisma.allocation.findMany({ where: { paymentId } });
    expect(allocations).toHaveLength(1);
    expect(allocations[0].receivableId).toBe(receivableId);
    expect(dec(allocations[0].amount)).toBe("20000.00");
    expect(allocations[0].allocatedById).toBe(finance.id);

    const arAfter = await prisma.receivable.findUniqueOrThrow({ where: { id: receivableId } });
    expect(dec(arAfter.settledAmount)).toBe("20000.00");
    expect(arAfter.status).toBe("SETTLED");
    expect(arAfter.revision).toBe(1);

    const payAfter = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(dec(payAfter.allocatedAmount)).toBe("20000.00");
    expect(payAfter.status).toBe("FULLY_ALLOCATED");
    expect(payAfter.revision).toBe(1);

    expect(await countAudit("BILLING_CREATE")).toBe(1);
    expect(await countAudit("FINANCE_ALLOCATION")).toBe(1);
  });
});

// ===========================================================================
// L. 归档申请
// ===========================================================================
describe("L 归档申请（saveClosure → archiveMatter）", () => {
  it("结案收尾后提交归档：ArchiveRecord 落 PENDING_REVIEW、checklistJson 快照结构完整、案件尚未归档", async () => {
    // L-0 归档门禁前置：程序终结 + 期限办结
    as(lawyer);
    const concludedAt = new Date("2026-11-18T17:00:00+08:00");
    await updateProcedureInfo({
      procedureId: firstProcedureId,
      handlingAgency: "杭州市西湖区人民法院",
      jurisdiction: "浙江省杭州市西湖区",
      ourStanding: "PLAINTIFF",
      concludedAt: concludedAt.toISOString()
    });
    const concludedProcedure = await prisma.matterProcedure.findUniqueOrThrow({ where: { id: firstProcedureId } });
    expect(concludedProcedure.status).toBe("CONCLUDED");
    expect(concludedProcedure.concludedAt?.toISOString()).toBe(concludedAt.toISOString());

    await toggleDeadlineCompleted(deadlineId);
    expect((await prisma.deadline.findUniqueOrThrow({ where: { id: deadlineId } })).completed).toBe(true);
    expect((await prisma.workResponsibility.findFirstOrThrow({ where: { deadlineId } })).state).toBe("DONE");

    // L-1 服务完成与财务收尾安排（归档指纹的基线）
    const serviceCompletedAt = new Date("2026-11-18T12:00:00+08:00");
    const saved = await saveClosure({
      matterId,
      revision: null,
      financeOwnerId: null,       // 财务已结清 → 无需指定收尾人
      serviceCompletedAt,
      reason: "服务已完成，材料齐备，代理费已结清"
    });
    expect((saved as { ok: boolean }).ok).toBe(true);
    const plan = await prisma.archiveClosurePlan.findUniqueOrThrow({ where: { matterId } });
    expect(plan.revision).toBe(0);
    expect(plan.financeOwnerId).toBeNull();
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await countAudit("ARCHIVE_CLOSURE_PLAN")).toBe(1);

    // L-2 提交归档（必交项按缺项例外申请：本测试不造 7 份实体材料）
    completedAt = new Date("2026-11-18T00:00:00+08:00");
    const requiredItemIds = [
      "retainer_contract", "power_of_attorney", "pleading",
      "evidence_catalog", "judgment", "closing_form", "case_summary"
    ];
    const checklistItems: Record<string, { status: "MISSING"; documentIds: string[]; note: string }> = {};
    for (const id of requiredItemIds) {
      checklistItems[id] = { status: "MISSING", documentIds: [], note: "链路测试未入卷，申请例外核准" };
    }
    const manualChecks: Record<string, { confirmed: boolean; note: string }> = {};
    for (const id of ["archive_scope", "originals_handled", "fees_handled", "catalog_pagination"]) {
      manualChecks[id] = { confirmed: true, note: "链路测试逐项核验通过" };
    }

    as(lawyer);
    const result = await archiveMatter({
      matterId,
      summary: "判决生效并履行完毕，代理费已收讫，材料清单已核对。",
      closedReason: "JUDGMENT",
      completedAt,
      judgmentSummary: "判令被告支付货款 50 万元及利息。",
      checklistItems,
      manualChecks,
      forceWithMissing: true
    });
    archiveNo = (result as { archiveNo: string }).archiveNo;
    expect((result as { status: string }).status).toBe("PENDING_REVIEW");
    expect(archiveNo).toMatch(/^\d{4}-民-\d{4}$/);

    const record = await prisma.archiveRecord.findFirstOrThrow({ where: { matterId } });
    archiveId = record.id;
    expect(record.archiveNo).toBe(archiveNo);
    expect(record.status).toBe("PENDING_REVIEW");
    expect(record.matterId).toBe(matterId);
    expect(record.archivedById).toBe(lawyer.id);
    expect(record.archivedBy).toBe("承办律师");
    expect(record.closedReason).toBe("JUDGMENT");
    expect(record.completedAt?.toISOString()).toBe(completedAt.toISOString());
    expect(record.reviewedById).toBeNull();
    expect(record.reviewedAt).toBeNull();
    expect(record.missingItems.sort()).toEqual([...requiredItemIds].sort());

    // 快照结构完整：制度、清单（含自动生成的封皮/目录）、人工核验、材料、被排除材料
    const snapshot = parseArchiveSnapshot(record.checklistJson);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.schemaVersion).toBe(2);
    expect(snapshot!.policy.configured).toBe(true);
    expect(snapshot!.policy.version).toBe("v1.0");
    expect(snapshot!.policy.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot!.checklist.kind).toBe("LITIGATION");
    expect(snapshot!.checklist.items).toHaveLength(14);
    expect(snapshot!.checklist.items.filter((i) => i.autoGenerated).map((i) => i.id).sort())
      .toEqual(["archive_catalog", "archive_cover"]);
    expect(snapshot!.checklist.items.filter((i) => i.autoGenerated).every((i) => i.status === "AUTO_GENERATED")).toBe(true);
    expect(snapshot!.manualChecks).toHaveLength(4);
    expect(snapshot!.manualChecks.every((m) => m.confirmed)).toBe(true);
    expect(snapshot!.documents.map((d) => d.id).sort()).toEqual(
      [record.coverDocId!, record.catalogDocId!].sort()
    );
    expect(snapshot!.documentIds).toHaveLength(2);
    expect(snapshot!.documents.every((d) => /^[0-9a-f]{64}$/.test(d.sha256))).toBe(true);
    expect(snapshot!.excludedDocuments).toEqual([]);
    expect(new Date(snapshot!.submittedAt).getTime()).toBeGreaterThan(0);

    // 封皮与目录是真实渲染并落盘的文书
    const cover = await prisma.document.findUniqueOrThrow({ where: { id: record.coverDocId! } });
    const catalog = await prisma.document.findUniqueOrThrow({ where: { id: record.catalogDocId! } });
    expect(cover.name).toBe(`卷宗封皮_${archiveNo}.docx`);
    expect(cover.tags).toContain("卷宗封皮");
    // 存储里是 AES-256-GCM 密文，document.sha256 登记的是明文 docx 的摘要 → 解密后再算
    const coverRaw = await storage.readFile(cover.path);
    expect(cover.sha256).toBe(sha256(decryptBuffer(coverRaw, cover.iv!, cover.authTag!)));
    expect(catalog.tags).toContain("卷宗目录");
    const catalogRaw = await storage.readFile(catalog.path);
    expect(catalog.sha256).toBe(sha256(decryptBuffer(catalogRaw, catalog.iv!, catalog.authTag!)));

    // 送审不等于归档：案件此时仍未归档
    const matter = await prisma.matter.findUniqueOrThrow({ where: { id: matterId } });
    expect(matter.status).not.toBe("ARCHIVED");
    expect(matter.archivedAt).toBeNull();

    expect(await countAudit("MATTER_ARCHIVE")).toBe(1);
  });
});

// ===========================================================================
// M. 归档审批
// ===========================================================================
describe("M 归档审批（approveArchiveRecord，主任律师）", () => {
  it("逐项核验后核准例外：APPROVED + Matter ARCHIVED + 冻结清单 + 审计", async () => {
    const record = await prisma.archiveRecord.findUniqueOrThrow({ where: { id: archiveId } });
    const snapshot = parseArchiveSnapshot(record.checklistJson)!;
    const verificationIds = requiredArchiveVerificationIds(snapshot);
    // 必交缺项 7 + 自动生成 2 + 人工核验 4 + 材料 2
    expect(verificationIds).toHaveLength(15);

    as(approver);
    const result = await approveArchiveRecord({
      archiveId,
      note: "缺项已核准：纸质原件另行入卷，其余逐项核验通过。",
      verificationIds,
      exceptionApproved: true
    });
    expect((result as { ok: boolean }).ok).toBe(true);

    const approved = await prisma.archiveRecord.findUniqueOrThrow({ where: { id: archiveId } });
    expect(approved.status).toBe("APPROVED");
    expect(approved.reviewedById).toBe(approver.id);
    expect(approved.reviewedAt).not.toBeNull();
    expect(approved.reviewNote).toContain("缺项已核准");
    expect(approved.frozenManifest).not.toBeNull();

    const matter = await prisma.matter.findUniqueOrThrow({ where: { id: matterId } });
    expect(matter.status).toBe("ARCHIVED");
    expect(matter.archivedAt).not.toBeNull();
    expect(matter.closedAt?.toISOString()).toBe(completedAt.toISOString());

    // 归档后的只读门禁（终态一致性：这条链再也不能写）
    as(lawyer);
    await expect(addTimeEntry({
      matterId,
      workDate: "2026-11-18",
      minutes: 30,
      narrative: "归档后补录尝试",
      billable: true
    })).rejects.toThrow(/归档/);

    // 归档审批留两条 ARCHIVE_APPROVE：事务内 approvalAudit（审批台账）+ 事务外 audit（业务审计）
    expect(await countAudit("ARCHIVE_APPROVE")).toBe(2);
  });
});

// ===========================================================================
// 跨环节一致性
// ===========================================================================
describe("跨环节一致性：编号链 / 外键链 / 审计链 / 终态财务", () => {
  it("编号链：Client.internalCode → Matter.internalCode → ArchiveRecord.archiveNo 三代可追溯", async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: companyClient.id } });
    const matter = await prisma.matter.findUniqueOrThrow({ where: { id: matterId } });
    const record = await prisma.archiveRecord.findUniqueOrThrow({ where: { id: archiveId } });

    expect(client.internalCode).toBe(companyClient.internalCode);
    expect(client.internalCode).toMatch(/^KH-\d{4}-0002$/);
    expect(matter.internalCode).toBe(matterInternalCode);
    expect(matter.internalCode).toMatch(/^LL-\d{4}-CC-0001$/); // 本库首案，无失败重试跳号（旧缺陷 D-4 已随修复消失）
    expect(record.archiveNo).toBe(archiveNo);
    expect(record.archiveNo).toMatch(/^\d{4}-民-0001$/);

    // 自然人客户只建了档、未进入本案（编号链走的是机构客户），两条链不得混用
    const naturalPerson = await prisma.client.findUniqueOrThrow({ where: { id: individualClient.id } });
    expect(naturalPerson.internalCode).toBe(individualClient.internalCode);
    expect(await prisma.matterClient.count({ where: { clientId: individualClient.id } })).toBe(0);

    // 三代之间的关联字段同一：Matter 指出客户与收案，ArchiveRecord 指回 Matter
    expect(matter.primaryClientId).toBe(client.id);
    expect(matter.intakeId).toBe(intakeId);
    expect(record.matterId).toBe(matter.id);

    // 归档号年份与归档瞬间的上海年份一致（跨年 0-8 点不落去年）
    expect(record.archiveNo.slice(0, 4)).toBe(String(matter.archivedAt!.getFullYear()));
  });

  it("外键链：当事人/程序/期限/工时/收付/核销/归档全部指向同一个 matterId", async () => {
    const [
      parties, procedures, deadlines, entries, feeEntries, payments,
      allocations, receivables, billings, record, timeEntries
    ] = await Promise.all([
      prisma.party.findMany({ where: { matterId } }),
      prisma.matterProcedure.findMany({ where: { matterId } }),
      prisma.deadline.findMany({ where: { procedure: { matterId } } }),
      prisma.timeEntry.findMany({ where: { matterId } }),
      prisma.feeEntry.findMany({ where: { matterId } }),
      prisma.payment.findMany({ where: { matterId } }),
      prisma.allocation.findMany({ where: { payment: { matterId } } }),
      prisma.receivable.findMany({ where: { matterId } }),
      prisma.billing.findMany({ where: { matterId } }),
      prisma.archiveRecord.findMany({ where: { matterId } }),
      prisma.timeEntry.findMany({ where: { matterId, id: timeEntryId } })
    ]);

    expect(parties).toHaveLength(3);
    expect(parties.map((p) => p.matterId)).toEqual([matterId, matterId, matterId]);
    expect(new Set(procedures.map((p) => p.matterId)).size).toBe(1);
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0].procedureId).toBe(firstProcedureId);
    expect(entries).toHaveLength(1);
    expect(timeEntries).toHaveLength(1);
    expect(feeEntries.map((e) => e.matterId)).toEqual([matterId]);
    expect(payments).toHaveLength(1);
    expect(allocations).toHaveLength(1);
    expect(allocations[0].paymentId).toBe(paymentId);
    expect(allocations[0].receivableId).toBe(receivableId);
    expect(receivables).toHaveLength(1);
    expect(billings.map((b) => b.matterId)).toEqual([matterId, matterId]); // 收案草稿 + 合同
    expect(record).toHaveLength(1);
    expect(record[0].matterId).toBe(matterId);

    // 程序当事人不得跨案
    const procedureParties = await prisma.procedureParty.findMany({ where: { procedureId: firstProcedureId } });
    expect(procedureParties).toHaveLength(3);
    const partyIds = new Set(parties.map((p) => p.id));
    expect(procedureParties.every((pp) => partyIds.has(pp.partyId))).toBe(true);
  });

  it("审计链：A–M 每步至少一条审计；verifyAuditChain 返回 ok:true、brokenAt:null，并显式报告分叉点", async () => {
    const expected: [string, string][] = [
      ["A 客户建档", "CLIENT_CREATE"],
      ["B 收案登记", "INTAKE_CREATE"],
      ["C 冲突检索", "CONFLICT_CHECK_RUN"],
      ["D 送审", "INTAKE_SUBMIT_ROUND"],
      ["D 转案", "INTAKE_CONVERT"],
      ["E 当事人", "PROCEDURE_INFO_UPDATE"],
      ["F 程序", "PROCEDURE_CREATE"],
      ["G 期限", "DEADLINE_CREATE"],
      ["H 工时", "TIME_ENTRY_CREATE"],
      ["I 登记实收", "FEE_ENTRY_SUBMIT"],
      ["J 确认实收", "FEE_ENTRY_CONFIRM"],
      ["K 收费安排", "BILLING_CREATE"],
      ["K 核销", "FINANCE_ALLOCATION"],
      ["L 收尾安排", "ARCHIVE_CLOSURE_PLAN"],
      ["L 归档送审", "MATTER_ARCHIVE"],
      ["M 归档审批", "ARCHIVE_APPROVE"]
    ];
    const missing: string[] = [];
    for (const [step, action] of expected) {
      if (await countAudit(action) < 1) missing.push(`${step}(${action})`);
    }
    expect(missing).toEqual([]);

    const chain = await verifyAuditChain(chainDb());
    expect(chain.brokenAt).toBeNull();
    expect(chain.ok).toBe(true);
    expect(chain.checked).toBeGreaterThan(0);
    // 全部审计都由扩展客户端写入 → 没有「加链前的历史记录」被跳过
    expect(chain.skippedLegacy).toBe(0);
    // 注：「无分叉时 forks === null」的契约由本文件之外的纯函数用例覆盖；
    // 端到端链上必然存在分叉（见下），这里断言的是分叉场景的那一侧。
    // 分叉 ≠ 覆盖缺口：全图遍历会走完每条分支，forks 只用于说明「链在这处分岔过」。

    // 分叉场景（本链必然有：D-2 事务内写 INTAKE_APPROVE + 复核审计，D-3 事务内写两条探针）。
    // 不再用「总数 > checked」把覆盖缺口固化成预期，而是要求 verifyAuditChain **显式指出分叉点**：
    // 这才是修复后的契约——ok 只说明走通的那条链没被篡改，分叉与未覆盖面由 forks / unchecked 交代。
    expect(chain.forks).not.toBeNull();

    const forkAtProbe = chain.forks!.find((f) => f.previousHash === probeForkPrev);
    expect(forkAtProbe).toBeDefined();
    expect(forkAtProbe!.ids).toEqual(expect.arrayContaining(probeIds));
    expect(forkAtProbe!.actions).toEqual(["PROBE_TX_AUDIT", "PROBE_TX_AUDIT"]);

    // 覆盖账必须自洽：走过的 + 未覆盖的 = 带摘要总数（分叉的另一股确实没被走完）
    const total = await prisma.auditLog.count({ where: { integrityHash: { not: null } } });
    console.info(
      `[business-chain] 审计链：ok=${chain.ok} checked=${chain.checked} unchecked=${chain.unchecked} ` +
      `forks=${chain.forks!.length} 带摘要总数=${total}`
    );
    // 覆盖账必须自洽
    expect(chain.checked + chain.unchecked).toBe(total);
    // 2026-11-19 全图遍历后：分叉的每条分支都会被走到，因此端到端链上应**零缺口**。
    // （旧实现是单链遍历，分叉处只走第一条，剩下一股永远不被校验，所以当时只能断言
    //   「unchecked > 0」把它固化成预期——那不是契约，那是缺陷。）
    expect(chain.unchecked).toBe(0);
    expect(chain.checked).toBe(total);
  });

  it("终态一致：归档后财务数字与前序登记一致，且每笔金额都能对上来源", async () => {
    const matter = await prisma.matter.findUniqueOrThrow({ where: { id: matterId } });
    expect(matter.status).toBe("ARCHIVED");

    const entries = await prisma.feeEntry.findMany({ where: { matterId } });
    const received = entries.filter((e) => e.type === "RECEIVED");
    const confirmed = received.filter((e) => e.confirmState === "CONFIRMED");
    expect(received).toHaveLength(1);
    expect(confirmed).toHaveLength(1);
    expect(dec(confirmed[0].amount)).toBe("20000.00");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { feeEntryId: confirmed[0].id } });
    expect(payment.id).toBe(paymentId);
    expect(dec(payment.amount)).toBe(dec(confirmed[0].amount));   // 实收 = 已确认登记额

    const receivable = await prisma.receivable.findUniqueOrThrow({ where: { id: receivableId } });
    expect(dec(receivable.amount)).toBe("20000.00");
    expect(dec(receivable.settledAmount)).toBe(dec(payment.amount)); // 应收结清额 = 实收额

    const allocation = await prisma.allocation.findFirstOrThrow({ where: { paymentId } });
    expect(dec(allocation.amount)).toBe("20000.00");
    expect(new Prisma.Decimal(payment.amount).eq(receivable.settledAmount)).toBe(true);
    expect(new Prisma.Decimal(payment.amount).eq(allocation.amount)).toBe(true);

    // 归档快照里冻结的「结案方式 / 完成时间」与案件终态一致
    const record = await prisma.archiveRecord.findUniqueOrThrow({ where: { id: archiveId } });
    expect(record.completedAt?.toISOString()).toBe(matter.closedAt?.toISOString());
    expect(matter.archivedAt!.getTime()).toBeGreaterThanOrEqual(record.archivedAt.getTime());
  });
});
