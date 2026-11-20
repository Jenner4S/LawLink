/**
 * 手机号归一与重复咨询识别（2026-11-22，对标分析 P0-2）
 *
 * ## 为什么需要它
 *
 * 客户现行系统里专门有一列「联系方式-是否重复」。因为同一客户会多次来电、
 * 多平台来单。不识别就会：两个销售撞单、老客户被当新客户重新教育、投放重复计费。
 *
 * ## 三条口径决定
 *
 * ① **只提示，不阻断**。
 *    同一号码可能是家人代接、公司总机、前台转接——硬拦会把真实新客户挡在门外。
 *    系统给证据（谁在跟、最近一次什么时候），判断权留给人。
 *
 * ② **归一化后比对，且归一化必须在 SQL 侧做**。
 *    库里存的是原始输入（律师可能抄的是「186 5538 2185」）。
 *    第一版用 `contains: 后7位` 粗筛，**在带空格的数据上直接漏检**——
 *    因为「5382185」不是「5538 2185」的子串。改为 SQL 里先 `regexp_replace` 去非数字，
 *    再比较 `right(digits, 7)`。后 7 位不受国际区号/前导 0 影响，足以区分不同号码。
 *
 * ③ **跨实体查**：线索、客户档案联系人、收案联系人。
 *    只查线索会漏掉「老客户又来问」——那才是最该识别的情形。
 */

import { prisma } from "@/lib/prisma";

/** 归一化手机号：只留数字，去国际区号与前导 0 */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return "";
  let d = raw.replace(/[^\d]/g, "");
  if (d.startsWith("0086")) d = d.slice(4);
  else if (d.startsWith("86") && d.length > 11) d = d.slice(2);
  if (d.startsWith("0") && d.length > 11) d = d.slice(1);
  return d;
}

/** 粗筛用：取后 7 位（中国手机号 11 位，后 7 位足以区分） */
function tail7(normalized: string): string {
  return normalized.slice(-7);
}

export type PhoneDuplicate = {
  kind: "LEAD" | "CLIENT" | "INTAKE";
  id: string;
  /** 展示名：线索人/客户名/收案联系人 */
  name: string;
  /** 谁在跟（线索负责人 / 客户无负责人则空） */
  ownerName: string | null;
  /** 最近一次跟进或创建时间，便于判断"是不是刚跟过" */
  lastSeenAt: Date;
};

/**
 * 查找与给定手机号可能重复的记录。**不阻断任何写入**。
 * `excludeLeadId` 用于编辑场景排除自身。
 */
export async function findPhoneDuplicates(
  rawPhone: string | null | undefined,
  options: { excludeLeadId?: string } = {}
): Promise<PhoneDuplicate[]> {
  const normalized = normalizePhone(rawPhone);
  if (normalized.length < 7) return [];
  const tail = tail7(normalized);

  // 归一化在 SQL 侧完成：`regexp_replace(phone, '[^0-9]', '', 'g')`。
  // 用 Prisma 的 contains 做不到——它匹配的是原始文本，带空格的号码会漏检（已踩过）。
  // 两支完整查询而不是把片段拼进模板：嵌套 $queryRaw 的插值不会合成一条 SQL，
  // Postgres 会报 `syntax error at or near "$2"`（第一版就这样炸的）。
  type LeadHit = { id: string; name: string; phone: string | null; updatedAt: Date; ownerName: string | null };
  const leadRows = options.excludeLeadId
    ? await prisma.$queryRaw<LeadHit[]>`
        SELECT l.id, l.name, l.phone, l."updatedAt", u.name AS "ownerName"
        FROM "Lead" l LEFT JOIN "User" u ON u.id = l."ownerId"
        WHERE right(regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g'), 7) = ${tail}
          AND l.id <> ${options.excludeLeadId}
        LIMIT 20
      `
    : await prisma.$queryRaw<LeadHit[]>`
        SELECT l.id, l.name, l.phone, l."updatedAt", u.name AS "ownerName"
        FROM "Lead" l LEFT JOIN "User" u ON u.id = l."ownerId"
        WHERE right(regexp_replace(coalesce(l.phone,''), '[^0-9]', '', 'g'), 7) = ${tail}
        LIMIT 20
      `;

  const contactRows = await prisma.$queryRaw<{ id: string; name: string; phone: string | null; clientId: string; clientName: string }[]>`
    SELECT c.id, c.name, c.phone, c."clientId", cl.name AS "clientName"
    FROM "Contact" c JOIN "Client" cl ON cl.id = c."clientId"
    WHERE right(regexp_replace(coalesce(c.phone,''), '[^0-9]', '', 'g'), 7) = ${tail}
    LIMIT 20
  `;

  const intakeRows = await prisma.$queryRaw<{ id: string; title: string; contactName: string | null; contactPhone: string | null; createdAt: Date }[]>`
    SELECT i.id, i.title, i."contactName", i."contactPhone", i."createdAt"
    FROM "Intake" i
    WHERE right(regexp_replace(coalesce(i."contactPhone",''), '[^0-9]', '', 'g'), 7) = ${tail}
    LIMIT 20
  `;

  const out: PhoneDuplicate[] = [];

  for (const l of leadRows) {
    // SQL 已按后 7 位筛过；这里再按完整归一值确认一次，防尾号巧合
    if (normalizePhone(l.phone) !== normalized) continue;
    out.push({ kind: "LEAD", id: l.id, name: l.name, ownerName: l.ownerName, lastSeenAt: l.updatedAt });
  }
  for (const c of contactRows) {
    if (normalizePhone(c.phone) !== normalized) continue;
    out.push({
      kind: "CLIENT",
      id: c.clientId,
      name: `${c.clientName}（联系人 ${c.name}）`,
      ownerName: null,
      lastSeenAt: new Date(0)
    });
  }
  for (const i of intakeRows) {
    if (normalizePhone(i.contactPhone) !== normalized) continue;
    out.push({
      kind: "INTAKE",
      id: i.id,
      name: i.contactName ? `${i.title}（${i.contactName}）` : i.title,
      ownerName: null,
      lastSeenAt: i.createdAt
    });
  }

  // 最近出现过的排前面：先看"是不是刚跟过"
  return out.sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}
