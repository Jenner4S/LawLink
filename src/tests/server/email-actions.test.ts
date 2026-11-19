// @vitest-environment node
/**
 * 邮件归档服务层单测（台账 P1-3）。
 *
 * 覆盖：去重、自动匹配落库、审计、人工指定归属、读取权限与待归档队列的作用域。
 * 匹配算法本身在 `email-match.test.ts` 里逐条钉死，这里只验证接线与权限。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, requireSessionMock, auditTxMock, revalidateMatterMock, assertCanReadMatterMock, visibilityMock } =
  vi.hoisted(() => {
    const db: Record<string, any> = {
      $transaction: vi.fn(),
      emailArchive: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
      matter: { findMany: vi.fn(), findFirst: vi.fn() },
      party: { findMany: vi.fn() },
      contact: { findMany: vi.fn() },
      client: { findMany: vi.fn() }
    };
    return {
      db,
      requireSessionMock: vi.fn(),
      auditTxMock: vi.fn<(tx: unknown, params: Record<string, any>) => Promise<void>>(),
      revalidateMatterMock: vi.fn(async () => {}),
      assertCanReadMatterMock: vi.fn(async () => {}),
      visibilityMock: vi.fn(() => ({ OR: [{ ownerId: "cmailuser0000000000000001" }] }))
    };
  });

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ requireSession: requireSessionMock }));
vi.mock("@/server/audit", () => ({ auditTx: auditTxMock, audit: vi.fn() }));
vi.mock("@/server/matters/route", () => ({ revalidateMatter: revalidateMatterMock }));
vi.mock("@/lib/permissions", () => ({
  matterReadVisibilityFilter: visibilityMock,
  assertCanReadMatter: assertCanReadMatterMock,
  isManager: (user: { role?: string; managerAuthorized?: boolean }) =>
    user?.role === "PRINCIPAL_LAWYER" || user?.managerAuthorized === true
}));

import {
  archiveEmail,
  getEmailDetail,
  linkEmailToMatter,
  listEmailsForMatter,
  listLinkableMatters,
  listUnmatchedEmails
} from "@/server/emails/actions";

const MATTER = "cmattermail00000000000001";
const EMAIL = "cemail000000000000000001";
const USER = "cmailuser0000000000000001";

const matterRow = { id: MATTER, internalCode: "LL-2026-CC-0001", firmCaseNo: "2026-民诉-001" };

const lawyerSession = {
  user: { id: USER, role: "LAWYER", systemRole: "NONE", managerAuthorized: false, rolePermissions: [] }
};
const managerSession = {
  user: { id: "cmailmanager0000000000001", role: "PRINCIPAL_LAWYER", systemRole: "NONE", managerAuthorized: false, rolePermissions: [] }
};

const baseInput = {
  subject: "LL-2026-CC-0001 开庭安排",
  fromAddress: "LiSi@JingBei.Example",
  fromName: "李思梅",
  toAddresses: ["A@Example.com", "b@example.com", "a@example.com"],
  ccAddresses: [],
  sentAt: "2026-11-18T10:30",
  bodyText: "承办律师您好：本案（LL-2026-CC-0001）定于下月开庭，请准备证据目录。",
  attachmentCount: 2,
  messageId: "<inquiry-001@jingbei.example>"
};

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => Promise<unknown>) => fn(db));
  requireSessionMock.mockResolvedValue(lawyerSession);
  db.emailArchive.findUnique.mockResolvedValue(null);
  db.emailArchive.create.mockResolvedValue({ id: EMAIL });
  db.emailArchive.update.mockResolvedValue({ id: EMAIL });
  db.emailArchive.findMany.mockResolvedValue([]);
  db.matter.findMany.mockResolvedValue([matterRow]);
  db.matter.findFirst.mockResolvedValue(matterRow);
  db.party.findMany.mockResolvedValue([]);
  db.contact.findMany.mockResolvedValue([]);
  db.client.findMany.mockResolvedValue([]);
});

describe("归档 · 去重", () => {
  it("messageId 已存在时拒绝并提示「该邮件已归档」", async () => {
    db.emailArchive.findUnique.mockResolvedValue({ id: "cexisting00000000000001" });
    await expect(archiveEmail(baseInput)).rejects.toThrow("该邮件已归档");
    expect(db.emailArchive.create).not.toHaveBeenCalled();
  });

  it("未提供 messageId 时不做去重查询", async () => {
    await archiveEmail({ ...baseInput, messageId: null });
    expect(db.emailArchive.findUnique).not.toHaveBeenCalled();
    expect(db.emailArchive.create).toHaveBeenCalledTimes(1);
  });
});

describe("归档 · 落库与审计", () => {
  it("编号命中后落库字段正确（归属、匹配类别、大小写归一、上海时区时刻）", async () => {
    const result = await archiveEmail(baseInput);
    expect(result).toMatchObject({
      ok: true,
      id: EMAIL,
      matchKind: "MATCHED_BY_CODE",
      matterId: MATTER,
      matterCode: "LL-2026-CC-0001"
    });

    const createArgs = db.emailArchive.create.mock.calls[0][0];
    expect(createArgs.data).toMatchObject({
      subject: baseInput.subject,
      fromAddress: "lisi@jingbei.example",
      fromName: "李思梅",
      toAddresses: ["a@example.com", "b@example.com"],
      ccAddresses: [],
      attachmentCount: 2,
      matterId: MATTER,
      matchKind: "MATCHED_BY_CODE",
      archivedById: USER,
      messageId: baseInput.messageId
    });
    expect(createArgs.data.matchEvidence).toContain("LL-2026-CC-0001");
    // 2026-11-18 10:30 上海 = 02:30 UTC
    expect(createArgs.data.sentAt.toISOString()).toBe("2026-11-18T02:30:00.000Z");
  });

  it("归档写 EMAIL_ARCHIVE 审计，且审计不落邮件正文", async () => {
    await archiveEmail(baseInput);
    expect(auditTxMock).toHaveBeenCalledTimes(1);
    const [, params] = auditTxMock.mock.calls[0];
    expect(params).toMatchObject({
      userId: USER,
      action: "EMAIL_ARCHIVE",
      targetType: "EmailArchive",
      targetId: EMAIL,
      detail: { matchKind: "MATCHED_BY_CODE", matterId: MATTER }
    });
    expect(JSON.stringify(params.detail)).not.toContain("证据目录");
  });

  it("没有任何信号时以 UNMATCHED 落库，归属为空", async () => {
    db.matter.findMany.mockResolvedValue([]);
    const result = await archiveEmail({
      ...baseInput,
      subject: "问候",
      bodyText: "很久没联系了。",
      fromAddress: "nobody@example.com"
    });
    expect(result).toMatchObject({ matchKind: "UNMATCHED", matterId: null, matterCode: null });
    expect(db.emailArchive.create.mock.calls[0][0].data).toMatchObject({
      matterId: null,
      matchKind: "UNMATCHED"
    });
  });

  it("不存在的发送时间被拒（2026-02-30 不会被静默顺延）", async () => {
    await expect(archiveEmail({ ...baseInput, sentAt: "2026-02-30T10:00" })).rejects.toThrow(
      "发送时间不存在"
    );
    expect(db.emailArchive.create).not.toHaveBeenCalled();
  });

  it("非法邮箱被 parseInput 拦下并给出中文提示", async () => {
    await expect(archiveEmail({ ...baseInput, fromAddress: "not-an-email" })).rejects.toThrow(
      "邮箱格式不正确"
    );
    expect(db.emailArchive.create).not.toHaveBeenCalled();
  });
});

describe("人工指定归属", () => {
  const existing = {
    id: EMAIL,
    matterId: null,
    matchKind: "UNMATCHED",
    matchEvidence: "命中 2 个案件，需人工指定",
    messageId: null
  };

  it("置 MANUAL、写 EMAIL_LINK 审计，并保留原匹配说明", async () => {
    db.emailArchive.findUnique.mockResolvedValue(existing);
    const result = await linkEmailToMatter({ id: EMAIL, matterId: MATTER });

    expect(result).toEqual({ ok: true, matterId: MATTER });
    expect(assertCanReadMatterMock).toHaveBeenCalled();
    const updateArgs = db.emailArchive.update.mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({ matterId: MATTER, matchKind: "MANUAL" });
    expect(updateArgs.data.matchEvidence).toContain("原匹配：UNMATCHED");

    const [, auditParams] = auditTxMock.mock.calls[0];
    expect(auditParams).toMatchObject({
      action: "EMAIL_LINK",
      targetType: "EmailArchive",
      targetId: EMAIL,
      detail: { matterId: MATTER, previousMatchKind: "UNMATCHED" }
    });
  });

  it("已归属同一案件时拒绝重复指定", async () => {
    db.emailArchive.findUnique.mockResolvedValue({ ...existing, matterId: MATTER });
    await expect(linkEmailToMatter({ id: EMAIL, matterId: MATTER })).rejects.toThrow(
      "该邮件已归属此案件"
    );
    expect(db.emailArchive.update).not.toHaveBeenCalled();
  });

  it("邮件不存在时拒绝", async () => {
    db.emailArchive.findUnique.mockResolvedValue(null);
    await expect(linkEmailToMatter({ id: EMAIL, matterId: MATTER })).rejects.toThrow("邮件不存在");
  });
});

describe("读取", () => {
  it("本案邮件列表按发送时间倒序查询，并先校验案件可见性", async () => {
    const sentAt = new Date("2026-11-18T02:30:00.000Z");
    db.emailArchive.findMany.mockResolvedValue([
      {
        id: EMAIL,
        subject: "开庭安排",
        fromAddress: "lisi@jingbei.example",
        fromName: "李思梅",
        sentAt,
        attachmentCount: 2,
        matchKind: "MATCHED_BY_CODE",
        matchEvidence: "主题或正文含案号 LL-2026-CC-0001",
        createdAt: sentAt,
        archivedBy: { name: "王律师" }
      }
    ]);

    const rows = await listEmailsForMatter(MATTER);
    expect(assertCanReadMatterMock).toHaveBeenCalledWith(USER, "LAWYER", MATTER, []);
    expect(db.emailArchive.findMany.mock.calls[0][0]).toMatchObject({
      where: { matterId: MATTER },
      orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: EMAIL,
      subject: "开庭安排",
      attachmentCount: 2,
      archivedByName: "王律师"
    });
  });

  it("普通律师的待归档队列只查自己归档的邮件", async () => {
    await listUnmatchedEmails();
    const where = db.emailArchive.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ matchKind: "UNMATCHED", archivedById: USER });
  });

  it("管理岗的待归档队列不按归档人收窄", async () => {
    requireSessionMock.mockResolvedValue(managerSession);
    await listUnmatchedEmails();
    const where = db.emailArchive.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ matchKind: "UNMATCHED" });
  });

  it("无归属邮件的正文，非归档人且非管理岗不可读", async () => {
    db.emailArchive.findUnique.mockResolvedValue({
      id: EMAIL,
      subject: "未匹配邮件",
      fromAddress: "x@example.com",
      fromName: null,
      toAddresses: [],
      ccAddresses: [],
      sentAt: new Date(),
      bodyText: "机密沟通内容",
      bodyHtml: null,
      attachmentCount: 0,
      matchKind: "UNMATCHED",
      matchEvidence: null,
      messageId: null,
      matterId: null,
      archivedById: "someone-else",
      archivedBy: { name: "他人" },
      matter: null
    });
    await expect(getEmailDetail(EMAIL)).rejects.toThrow("邮件不存在");
  });

  it("已归属邮件的正文读取跟随案件可见性", async () => {
    db.emailArchive.findUnique.mockResolvedValue({
      id: EMAIL,
      subject: "开庭安排",
      fromAddress: "lisi@jingbei.example",
      fromName: "李思梅",
      toAddresses: ["a@example.com"],
      ccAddresses: [],
      sentAt: new Date(),
      bodyText: "正文",
      bodyHtml: null,
      attachmentCount: 2,
      matchKind: "MATCHED_BY_CODE",
      matchEvidence: "主题或正文含案号 LL-2026-CC-0001",
      messageId: null,
      matterId: MATTER,
      archivedById: USER,
      archivedBy: { name: "王律师" },
      matter: { id: MATTER, internalCode: "LL-2026-CC-0001", title: "甲公司诉乙公司" }
    });
    const detail = await getEmailDetail(EMAIL);
    expect(assertCanReadMatterMock).toHaveBeenCalledWith(USER, "LAWYER", MATTER, []);
    expect(detail.bodyText).toBe("正文");
    expect(detail.matter?.title).toBe("甲公司诉乙公司");
  });

  it("人工指定用案件候选只返回可见范围", async () => {
    db.matter.findMany.mockResolvedValue([
      { id: MATTER, internalCode: "LL-2026-CC-0001", title: "甲公司诉乙公司" }
    ]);
    const rows = await listLinkableMatters();
    expect(visibilityMock).toHaveBeenCalled();
    expect(rows).toEqual([{ id: MATTER, internalCode: "LL-2026-CC-0001", title: "甲公司诉乙公司" }]);
  });
});
