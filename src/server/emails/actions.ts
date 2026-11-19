"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { isSystemAdmin } from "@/lib/auth/system-role";
import { parseInput } from "@/lib/parse-input";
import { assertCanReadMatter, isManager, matterReadVisibilityFilter } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { shDayKey, shTime } from "@/lib/ui/sh-time";
import { auditTx } from "@/server/audit";
import { revalidateMatter } from "@/server/matters/route";

import {
  collectCandidateMatterIds,
  matchEmail,
  matterLabel,
  type EmailMatchResult,
  type MatchAddress,
  type MatchCandidates,
  type MatchMatter,
  type MatchParty
} from "./match";

/**
 * 邮件归档服务层（台账 P1-3）。
 *
 * 分工：
 *   - `./match.ts` 是纯匹配算法（无数据库、无时钟、无请求上下文）；
 *   - 本模块负责权限、可见性过滤、取数、落库、去重、审计与 revalidate。
 *
 * 三个口径（不在此处发明，沿用既有约定）：
 *   1. 输入校验一律 `parseInput(schema, input)`——zod 4 下 `schema.parse` 的抛错在
 *      Next 生产环境会退化成 minified 错误，用户看不到中文提示；
 *   2. 邮件正文是客户通信内容，读取跟随案件可见性（`assertCanReadMatter`）；
 *      自动匹配的候选库也先用 `matterReadVisibilityFilter` 收窄，不会把「另一条业务线
 *      案件的存在」泄露给无权查看的人；
 *   3. 业务变更与审计同事务提交（`auditTx`）：归档与人工改归属都是可被追问的留痕动作。
 */

// ---------------- 输入校验 ----------------

const emailAddressSchema = z
  .string()
  .trim()
  .min(3, "邮箱格式不正确")
  .max(254, "邮箱过长")
  .email("邮箱格式不正确");

const archiveEmailSchema = z.object({
  subject: z.string().trim().min(1, "邮件主题必填").max(500, "邮件主题不超过 500 字"),
  fromAddress: emailAddressSchema,
  fromName: z.string().trim().max(120, "发件人姓名不超过 120 字").optional().nullable(),
  toAddresses: z.array(emailAddressSchema).max(50, "收件人最多 50 个").default([]),
  ccAddresses: z.array(emailAddressSchema).max(50, "抄送最多 50 个").default([]),
  /** datetime-local 的上海墙钟字符串：YYYY-MM-DDTHH:mm */
  sentAt: z.string().trim().min(1, "发送时间必填"),
  bodyText: z.string().trim().min(1, "邮件正文必填").max(200_000, "邮件正文不超过 20 万字"),
  bodyHtml: z.string().max(1_000_000, "邮件 HTML 不超过 100 万字符").optional().nullable(),
  /** RFC Message-ID；提供时用于去重 */
  messageId: z.string().trim().max(998, "Message-ID 过长").optional().nullable(),
  attachmentCount: z
    .number({ error: "附件数必须是数字" })
    .int({ message: "附件数须为整数" })
    .min(0, "附件数不能为负")
    .max(999, "附件数不超过 999")
    .default(0)
});

export type ArchiveEmailInput = z.input<typeof archiveEmailSchema>;

const linkEmailSchema = z.object({
  id: z.string().trim().min(1, "缺少邮件标识"),
  matterId: z.string().trim().min(1, "请选择归属案件")
});

export type LinkEmailInput = z.input<typeof linkEmailSchema>;

// ---------------- 返回类型 ----------------

export type ArchiveEmailResult = {
  ok: true;
  id: string;
  matchKind: EmailMatchResult["matchKind"];
  evidence: string;
  matterId: string | null;
  /** 匹配到的案件编号（未匹配时为空），便于界面直接展示 */
  matterCode: string | null;
};

export type ArchivedEmailRow = {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  sentAt: Date;
  attachmentCount: number;
  matchKind: string;
  matchEvidence: string | null;
  archivedByName: string;
  createdAt: Date;
};

export type UnmatchedEmailRow = {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  sentAt: Date;
  matchEvidence: string | null;
  archivedByName: string;
  /** 系统给出的候选案件（按可见范围），最多 5 条 */
  suggestions: { id: string; label: string }[];
};

export type EmailDetail = {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  sentAt: Date;
  bodyText: string;
  bodyHtml: string | null;
  attachmentCount: number;
  matchKind: string;
  matchEvidence: string | null;
  messageId: string | null;
  archivedByName: string;
  matter: { id: string; internalCode: string | null; title: string } | null;
};

export type LinkableMatter = { id: string; internalCode: string | null; title: string };

// ---------------- 内部工具 ----------------

type Session = Awaited<ReturnType<typeof requireSession>>;

/** 上海墙钟 → 瞬时。与 inbox / 记录弹窗同一口径：固定 +08:00，不信运行时区。 */
function parseShanghaiSentAt(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new ActionError("发送时间格式应为 YYYY-MM-DDTHH:mm");
  const [, y, m, d, hh, mm] = match;
  const date = new Date(`${y}-${m}-${d}T${hh}:${mm}:00+08:00`);
  // 回读校验：2026-02-30 这类不存在的日期会被 Date 顺延，必须拒绝
  if (Number.isNaN(date.getTime()) || shDayKey(date) !== `${y}-${m}-${d}` || shTime(date) !== `${hh}:${mm}`) {
    throw new ActionError("发送时间不存在，请重新选择");
  }
  return date;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  return text ? text : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

function canSeeWholeArchiveQueue(session: Session): boolean {
  return isSystemAdmin(session.user) || isManager(session.user);
}

/**
 * 取匹配候选：只取**当前用户可见**的案件、当事人与客户邮箱。
 *
 * 说明：当事人按姓名匹配需要在 JS 侧做子串判断（Postgres 无法把「字段值包含在正文里」
 * 直接下推），因此这里取全量当事人姓名 + 案件 id 两列。目标客户是中小律所（单库单实例），
 * 量级可接受；若未来案件量到十万级，应改为正文分词后按候选名批量查询。
 */
async function loadCandidates(
  session: Session,
  fromAddress: string
): Promise<{ candidates: MatchCandidates; matterById: Map<string, MatchMatter> }> {
  const visibility = matterReadVisibilityFilter(
    session.user.id,
    session.user.role,
    session.user.rolePermissions
  );
  const matterSelect = { id: true, internalCode: true, firmCaseNo: true } as const;
  const emailProbe = { equals: fromAddress, mode: "insensitive" as const };

  const [visibleMatters, parties, contacts, clients] = await Promise.all([
    // 编号前缀与所内案号模板都可配置（可能含中文），无法只靠正则从正文反推，
    // 因此取可见范围内全部案件的编号两列（中小律所量级，且只取两列）。
    prisma.matter.findMany({
      where: { deletedAt: null, ...visibility },
      select: matterSelect
    }),
    prisma.party.findMany({
      where: {
        matterId: { not: null },
        matter: { is: { deletedAt: null, ...visibility } }
      },
      select: { name: true, matterId: true }
    }),
    prisma.contact.findMany({
      where: { email: emailProbe },
      select: {
        email: true,
        name: true,
        client: {
          select: {
            name: true,
            matters: { where: { deletedAt: null, ...visibility }, select: { id: true } },
            matterLinks: {
              where: { matter: { deletedAt: null, ...visibility } },
              select: { matterId: true }
            }
          }
        }
      }
    }),
    prisma.client.findMany({
      where: { email: emailProbe },
      select: {
        email: true,
        name: true,
        matters: { where: { deletedAt: null, ...visibility }, select: { id: true } },
        matterLinks: {
          where: { matter: { deletedAt: null, ...visibility } },
          select: { matterId: true }
        }
      }
    })
  ]);

  const matterById = new Map<string, MatchMatter>();
  for (const matter of visibleMatters) matterById.set(matter.id, matter);

  const addresses: MatchAddress[] = [];
  for (const contact of contacts) {
    if (!contact.email) continue;
    const matterIds = [
      ...contact.client.matters.map((matter) => matter.id),
      ...contact.client.matterLinks.map((link) => link.matterId)
    ];
    if (matterIds.length === 0) continue;
    addresses.push({
      email: contact.email,
      matterIds,
      source: `客户「${contact.client.name}」联系人「${contact.name}」`
    });
  }
  for (const client of clients) {
    if (!client.email) continue;
    const matterIds = [
      ...client.matters.map((matter) => matter.id),
      ...client.matterLinks.map((link) => link.matterId)
    ];
    if (matterIds.length === 0) continue;
    addresses.push({ email: client.email, matterIds, source: `客户「${client.name}」` });
  }

  const partyRows: MatchParty[] = parties.map((party) => ({ name: party.name, matterId: party.matterId }));

  return {
    candidates: {
      matters: [...matterById.values()],
      parties: partyRows,
      addresses
    },
    matterById
  };
}

async function revalidateEmailSurfaces(matterId?: string | null): Promise<void> {
  revalidatePath("/admin/emails");
  if (matterId) await revalidateMatter(matterId);
}

// ---------------- 归档 ----------------

/**
 * 粘贴归档一封邮件：校验 → 自动匹配 → 落库 → 审计。
 *
 * 匹配只给**建议**：命中多案时落 UNMATCHED 并保留说明，绝不猜归属。
 * 用户随后可在管理侧「待归档邮件」里手工指定。
 */
export async function archiveEmail(input: ArchiveEmailInput): Promise<ArchiveEmailResult> {
  const session = await requireSession("matters.write");
  const data = parseInput(archiveEmailSchema, input);
  const sentAt = parseShanghaiSentAt(data.sentAt);
  const messageId = normalizeOptional(data.messageId);

  if (messageId) {
    const existing = await prisma.emailArchive.findUnique({ where: { messageId }, select: { id: true } });
    if (existing) throw new ActionError("该邮件已归档");
  }

  const { candidates, matterById } = await loadCandidates(session, data.fromAddress);
  const match = matchEmail(
    { subject: data.subject, bodyText: data.bodyText, fromAddress: data.fromAddress },
    candidates
  );

  // 防御：匹配结果必须仍在可见候选内（纯函数不产生新 id，这里再兜一层）
  const matchedMatter = match.matterId ? matterById.get(match.matterId) ?? null : null;
  if (match.matterId && !matchedMatter) {
    throw new ActionError("匹配到的案件已不可见，请刷新后重试");
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.emailArchive.create({
        data: {
          subject: data.subject,
          fromAddress: data.fromAddress.trim().toLowerCase(),
          fromName: normalizeOptional(data.fromName),
          toAddresses: [...new Set(data.toAddresses.map((address) => address.trim().toLowerCase()))],
          ccAddresses: [...new Set(data.ccAddresses.map((address) => address.trim().toLowerCase()))],
          sentAt,
          bodyText: data.bodyText,
          bodyHtml: normalizeOptional(data.bodyHtml),
          attachmentCount: data.attachmentCount,
          matterId: matchedMatter?.id ?? null,
          matchKind: match.matchKind,
          matchEvidence: match.evidence,
          archivedById: session.user.id,
          messageId
        },
        select: { id: true }
      });
      await auditTx(tx, {
        userId: session.user.id,
        action: "EMAIL_ARCHIVE",
        targetType: "EmailArchive",
        targetId: row.id,
        // 审计只记元数据，不落邮件正文（正文属客户通信内容，不进审计列表）
        detail: {
          subject: data.subject.slice(0, 120),
          fromAddress: data.fromAddress.trim().toLowerCase(),
          sentAt: sentAt.toISOString(),
          matchKind: match.matchKind,
          matterId: matchedMatter?.id ?? null,
          hasMessageId: Boolean(messageId)
        }
      });
      return row;
    });

    await revalidateEmailSurfaces(matchedMatter?.id);
    return {
      ok: true,
      id: created.id,
      matchKind: match.matchKind,
      evidence: match.evidence,
      matterId: matchedMatter?.id ?? null,
      matterCode: matchedMatter ? matterLabel(matchedMatter) : null
    };
  } catch (error) {
    // 并发下 findUnique 可能都没命中，唯一索引兜底
    if (isUniqueViolation(error)) throw new ActionError("该邮件已归档");
    throw error;
  }
}

// ---------------- 人工指定归属 ----------------

/**
 * 人工指定邮件归属：matchKind 置 MANUAL，保留原匹配说明并写审计。
 *
 * 权限口径：`matters.write` + `assertCanReadMatter`——管理侧做分诊，能读到该案即可挂；
 * 不要求 `assertCanHandleMatter`，否则合伙人为他人案件归档历史邮件会被拦。
 * 归档案件同样允许挂（邮件归档是证据补录，不改案件业务字段）。
 */
export async function linkEmailToMatter(input: LinkEmailInput): Promise<{ ok: true; matterId: string }> {
  const session = await requireSession("matters.write");
  const data = parseInput(linkEmailSchema, input);

  const email = await prisma.emailArchive.findUnique({
    where: { id: data.id },
    select: { id: true, matterId: true, matchKind: true, matchEvidence: true, messageId: true }
  });
  if (!email) throw new ActionError("邮件不存在，请刷新后重试");

  const matter = await prisma.matter.findFirst({
    where: { id: data.matterId, deletedAt: null },
    select: { id: true, internalCode: true, firmCaseNo: true, title: true }
  });
  if (!matter) throw new ActionError("案件不存在或已删除，请刷新后重试");

  // 对象级读取校验：不把邮件挂到自己看不到的案件上
  await assertCanReadMatter(session.user.id, session.user.role, matter.id, session.user.rolePermissions);

  if (email.matterId === matter.id) {
    throw new ActionError("该邮件已归属此案件，无需重复指定");
  }

  await prisma.$transaction(async (tx) => {
    await tx.emailArchive.update({
      where: { id: email.id },
      data: {
        matterId: matter.id,
        matchKind: "MANUAL",
        matchEvidence: `人工指定归属（原匹配：${email.matchKind}${email.matchEvidence ? `，${email.matchEvidence}` : ""}）`
      }
    });
    await auditTx(tx, {
      userId: session.user.id,
      action: "EMAIL_LINK",
      targetType: "EmailArchive",
      targetId: email.id,
      detail: {
        matterId: matter.id,
        matterCode: matter.internalCode ?? matter.firmCaseNo,
        previousMatterId: email.matterId,
        previousMatchKind: email.matchKind,
        messageIdPresent: Boolean(email.messageId)
      }
    });
  });

  await revalidateEmailSurfaces(matter.id);
  if (email.matterId) await revalidateEmailSurfaces(email.matterId);
  return { ok: true, matterId: matter.id };
}

// ---------------- 读取 ----------------

/** 本案邮件列表（按发送时间倒序）。不含正文，点开再取（正文可能很长）。 */
export async function listEmailsForMatter(matterId: string): Promise<ArchivedEmailRow[]> {
  const session = await requireSession("matters.read");
  if (!matterId?.trim()) throw new ActionError("缺少案件标识");
  await assertCanReadMatter(session.user.id, session.user.role, matterId, session.user.rolePermissions);

  const rows = await prisma.emailArchive.findMany({
    where: { matterId },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      subject: true,
      fromAddress: true,
      fromName: true,
      sentAt: true,
      attachmentCount: true,
      matchKind: true,
      matchEvidence: true,
      createdAt: true,
      archivedBy: { select: { name: true } }
    }
  });

  return rows.map((row) => ({
    id: row.id,
    subject: row.subject,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    sentAt: row.sentAt,
    attachmentCount: row.attachmentCount,
    matchKind: row.matchKind,
    matchEvidence: row.matchEvidence,
    archivedByName: row.archivedBy.name,
    createdAt: row.createdAt
  }));
}

/**
 * 待归档邮件（未匹配）。
 *
 * 管理侧队列：管理岗（系统管理员 / 合伙人 / 业务管理权）看全所；其他持有 `matters.write`
 * 的人只看自己归档的未匹配件——邮件正文是客户通信内容，不因为没有归属就变成公开信息。
 */
export async function listUnmatchedEmails(): Promise<UnmatchedEmailRow[]> {
  const session = await requireSession("matters.read");
  const seeAll = canSeeWholeArchiveQueue(session);

  const rows = await prisma.emailArchive.findMany({
    where: {
      matchKind: "UNMATCHED",
      ...(seeAll ? {} : { archivedById: session.user.id })
    },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    take: 50,
    select: {
      id: true,
      subject: true,
      fromAddress: true,
      fromName: true,
      sentAt: true,
      bodyText: true,
      matchEvidence: true,
      archivedBy: { select: { name: true } }
    }
  });
  if (rows.length === 0) return [];

  // 候选建议：用同一套纯算法重新收集（多义候选要展示出来给人工挑，而不是只给一句「无法匹配」）
  const visibility = matterReadVisibilityFilter(
    session.user.id,
    session.user.role,
    session.user.rolePermissions
  );
  const fromAddresses = [...new Set(rows.map((row) => row.fromAddress.toLowerCase()))];

  const [visibleMatters, parties, contacts, clients] = await Promise.all([
    prisma.matter.findMany({
      where: { deletedAt: null, ...visibility },
      select: { id: true, internalCode: true, firmCaseNo: true }
    }),
    prisma.party.findMany({
      where: { matterId: { not: null }, matter: { is: { deletedAt: null, ...visibility } } },
      select: { name: true, matterId: true }
    }),
    fromAddresses.length
      ? prisma.contact.findMany({
          where: { OR: fromAddresses.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })) },
          select: {
            email: true,
            name: true,
            client: {
              select: {
                name: true,
                matters: { where: { deletedAt: null, ...visibility }, select: { id: true } },
                matterLinks: {
                  where: { matter: { deletedAt: null, ...visibility } },
                  select: { matterId: true }
                }
              }
            }
          }
        })
      : Promise.resolve([]),
    fromAddresses.length
      ? prisma.client.findMany({
          where: { OR: fromAddresses.map((email) => ({ email: { equals: email, mode: "insensitive" as const } })) },
          select: {
            email: true,
            name: true,
            matters: { where: { deletedAt: null, ...visibility }, select: { id: true } },
            matterLinks: {
              where: { matter: { deletedAt: null, ...visibility } },
              select: { matterId: true }
            }
          }
        })
      : Promise.resolve([])
  ]);

  const matterById = new Map<string, MatchMatter>();
  for (const matter of visibleMatters) matterById.set(matter.id, matter);

  const addresses: MatchAddress[] = [];
  for (const contact of contacts) {
    if (!contact.email) continue;
    const matterIds = [
      ...contact.client.matters.map((matter) => matter.id),
      ...contact.client.matterLinks.map((link) => link.matterId)
    ];
    if (matterIds.length === 0) continue;
    addresses.push({
      email: contact.email,
      matterIds,
      source: `客户「${contact.client.name}」联系人「${contact.name}」`
    });
  }
  for (const client of clients) {
    if (!client.email) continue;
    const matterIds = [
      ...client.matters.map((matter) => matter.id),
      ...client.matterLinks.map((link) => link.matterId)
    ];
    if (matterIds.length === 0) continue;
    addresses.push({ email: client.email, matterIds, source: `客户「${client.name}」` });
  }

  const candidates: MatchCandidates = {
    matters: [...matterById.values()],
    parties: parties.map((party) => ({ name: party.name, matterId: party.matterId })),
    addresses
  };

  return rows.map((row) => {
    const ids = collectCandidateMatterIds(
      { subject: row.subject, bodyText: row.bodyText, fromAddress: row.fromAddress },
      candidates
    );
    return {
      id: row.id,
      subject: row.subject,
      fromAddress: row.fromAddress,
      fromName: row.fromName,
      sentAt: row.sentAt,
      matchEvidence: row.matchEvidence,
      archivedByName: row.archivedBy.name,
      suggestions: ids
        .map((id) => matterById.get(id))
        .filter((matter): matter is MatchMatter => Boolean(matter))
        .slice(0, 5)
        .map((matter) => ({ id: matter.id, label: matterLabel(matter) }))
    };
  });
}

/** 邮件正文与元数据。无归属的邮件只有归档人本人、管理岗或系统管理员可读。 */
export async function getEmailDetail(id: string): Promise<EmailDetail> {
  const session = await requireSession("matters.read");
  if (!id?.trim()) throw new ActionError("缺少邮件标识");

  const row = await prisma.emailArchive.findUnique({
    where: { id },
    select: {
      id: true,
      subject: true,
      fromAddress: true,
      fromName: true,
      toAddresses: true,
      ccAddresses: true,
      sentAt: true,
      bodyText: true,
      bodyHtml: true,
      attachmentCount: true,
      matchKind: true,
      matchEvidence: true,
      messageId: true,
      matterId: true,
      archivedById: true,
      archivedBy: { select: { name: true } },
      matter: { select: { id: true, internalCode: true, title: true } }
    }
  });
  if (!row) throw new ActionError("邮件不存在，请刷新后重试");

  if (row.matterId) {
    await assertCanReadMatter(session.user.id, session.user.role, row.matterId, session.user.rolePermissions);
  } else if (row.archivedById !== session.user.id && !canSeeWholeArchiveQueue(session)) {
    throw new ActionError("邮件不存在，请刷新后重试");
  }

  return {
    id: row.id,
    subject: row.subject,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    toAddresses: row.toAddresses,
    ccAddresses: row.ccAddresses,
    sentAt: row.sentAt,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    attachmentCount: row.attachmentCount,
    matchKind: row.matchKind,
    matchEvidence: row.matchEvidence,
    messageId: row.messageId,
    archivedByName: row.archivedBy.name,
    matter: row.matter
  };
}

/** 人工指定归属时的案件候选（仅可见范围，最多 500 条，够中小律所使用） */
export async function listLinkableMatters(): Promise<LinkableMatter[]> {
  const session = await requireSession("matters.read");
  const visibility = matterReadVisibilityFilter(
    session.user.id,
    session.user.role,
    session.user.rolePermissions
  );
  const rows = await prisma.matter.findMany({
    where: { deletedAt: null, ...visibility },
    orderBy: [{ updatedAt: "desc" }],
    take: 500,
    select: { id: true, internalCode: true, title: true }
  });
  return rows;
}
