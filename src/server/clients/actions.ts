"use server";
import { getFinanceFacts } from "@/server/finance/facts";
import { parseInput } from "@/lib/parse-input";
import { roleMutation, checkRoleMutation } from "@/lib/roles/service";

import { revalidatePath } from "next/cache";
import { Prisma, type ClientIdType } from "@prisma/client";
import { scopeFor, type RoleUser } from "@/lib/roles/catalog";
import { matterFinanceVisibilityFilter } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";
import { audit } from "@/server/audit";
import { clientVisibilityFilter, intakeVisibilityFilter, isManager, matterReadVisibilityFilter } from "@/lib/permissions";
import { normalizeIdNumber, duplicateWhereInput } from "@/lib/clients/identity";
import { sealIdNumber, blindIdNumber, decryptIdNumber } from "@/lib/clients/id-number-crypto";
import { generateClientCode } from "./code-generator";
import {
  clientCreateSchema,
  clientUpdateSchema,
  clientListQuerySchema,
  contactInputSchema,
  type ClientCreateInput,
  type ClientUpdateInput,
  type ContactInput,
  type ClientListQuery
} from "./schemas";
import { ActionError } from "@/lib/action-error";

// 空字符串归 null（Prisma 不接受 "" 给可空字段）
function emptyToNull<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v === "" ? null : v;
  }
  return out as T;
}

export async function listClients(input: Partial<ClientListQuery> = {}) {
  const session = await requireSession("clients.read");
  const query = parseInput(clientListQuerySchema, input);

  const where: Prisma.ClientWhereInput = {
    AND: [clientVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions, session.user.systemRole)],
    deletedAt: null,
    ...(query.type ? { type: query.type } : {}),
    ...(query.tag ? { tags: { has: query.tag } } : {}),
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: "insensitive" } },
            // P1 §三：证件号模糊检索退役，改盲索引等值（输入按完整号码理解）
            { idNumberBlind: blindIdNumber(normalizeIdNumber(query.search) ?? "") },
            { phone: { contains: query.search } },
            { email: { contains: query.search, mode: "insensitive" } }
          ]
        }
      : {})
  };

  const [items, total] = await Promise.all([
    prisma.client.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        contacts: { where: { isPrimary: true }, take: 1 },
        _count: { select: {
          matters: { where: { deletedAt: null, ...matterReadVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions) } },
          intakes: { where: intakeVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions) }
        } }
      }
    }),
    prisma.client.count({ where })
  ]);

  // 证件号入库为密文，列表直接展示明文
  return { items: items.map((c) => ({ ...c, idNumber: decryptIdNumber(c.idNumber) || null })), total, page: query.page, pageSize: query.pageSize };
}

export async function getClientById(id: string) {
  const session = await requireSession("clients.read");
  // 权限检查：manager/finance 看全部，其他人需有关联案件
  if (!isManager(session.user) && session.user.role !== "FINANCE") {
    const accessible = await prisma.client.findFirst({
      where: {
        id,
        deletedAt: null,
        ...clientVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions, session.user.systemRole)
      },
      select: { id: true }
    });
    if (!accessible) throw new ActionError("客户不存在");
  }
  const client = await prisma.client.findFirst({
    where: { id, deletedAt: null },
    include: {
      contacts: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }] },
      matters: {
        where: { deletedAt: null, ...matterReadVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions) },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: {
          id: true,
          internalCode: true,
          title: true,
          category: true,
          status: true,
          updatedAt: true
        }
      }
    }
  });

  if (client) {
    await audit({
      userId: session.user.id,
      action: "CLIENT_VIEW",
      targetType: "Client",
      targetId: id
    });
  }
  return client;
}

// 客户财务汇总仅聚合当前用户具有财务访问权的案件
export async function getClientFinanceSummary(clientId: string) {
  const session = await requireSession("finance.read");
  // 权限：与 getClientById 一致
  if (!isManager(session.user) && session.user.role !== "FINANCE") {
    const accessible = await prisma.client.findFirst({
      where: {
        id: clientId,
        deletedAt: null,
        ...clientVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions, session.user.systemRole)
      },
      select: { id: true }
    });
    if (!accessible) throw new ActionError("客户不存在");
  }

  const matterWhere: Prisma.MatterWhereInput = {
    primaryClientId: clientId,
    deletedAt: null,
    ...matterFinanceVisibilityFilter(session.user.id, session.user.role, session.user.rolePermissions)
  };
  const [billings, fees, matterCount] = await Promise.all([
    prisma.billing.findMany({
      where: { matter: matterWhere },
      include: { matter: { select: { id: true, internalCode: true, title: true } } },
      orderBy: { createdAt: "desc" }
    }),
    prisma.feeEntry.findMany({
      where: { type: { in: ["RECEIVABLE", "RECEIVED"] }, confirmState: "CONFIRMED", matter: matterWhere },
      select: { type: true, amount: true }
    }),
    prisma.matter.count({ where: matterWhere })
  ]);

  const facts=await getFinanceFacts(matterWhere);
  const contractTotal = billings.filter(b=>b.signedAt).reduce((s, b) => s + Number(b.contractAmount), 0);
  const receivable = fees
    .filter((f) => f.type === "RECEIVABLE")
    .reduce((s, f) => s + Number(f.amount), 0);
  const received = fees
    .filter((f) => f.type === "RECEIVED")
    .reduce((s, f) => s + Number(f.amount), 0);

  return {
    contractTotal: facts ? facts.billings.filter(b=>b.signedAt&&b.moneyKind==='LAWYER_FEE').reduce((n,b)=>n+b.contractAmount.toNumber(),0) : contractTotal,
    receivable: facts?Number(facts.lawyerSummary.receivable):receivable,
    received: facts?Number(facts.lawyerSummary.netReceived):received,
    // 已核销/应收口径的回款分子，与案件详情 getMatterFinance 的 allocated 同源；
    // 旧口径（未升级库）无独立核销概念，退回已确认实收合计（与 received 同源）
    allocated: facts?Number(facts.lawyerSummary.receivable)-Number(facts.lawyerSummary.outstanding):received,
    pending: facts?Number(facts.lawyerSummary.outstanding):Math.max(0, receivable - received),
    matterCount,
    billings: billings.map((b) => ({
      id: b.id,
      title: b.title,
      status: b.status,
      contractAmount: Number(b.contractAmount),
      signedAt: b.signedAt,
      matter: b.matter
    }))
  };
}

export async function createClient(input: ClientCreateInput) {
  const session = await requireSession("clients.write");
  const data = parseInput(clientCreateSchema, input);

  // v1.x P0-1: 证件规范化 + 建档查重（身份持续唯一：含软删档案）
  const idNumber = normalizeIdNumber(data.idNumber);
  const idType = (data.idType || null) as ClientIdType | null;
  if (idNumber && idType) {
    const dup = await prisma.client.findFirst({
      where: duplicateWhereInput({ idType, idNumber }),
      select: { id: true, name: true, deletedAt: true }
    });
    if (dup) {
      throw new Error(
        dup.deletedAt
          ? `该证件号码已登记于停用客户「${dup.name}」，请恢复或合并后使用`
          : `该证件号码已登记于客户「${dup.name}」，请直接选用该客户`
      );
    }
  }

  const internalCode = await generateClientCode();
  const created = await roleMutation(session.user, "clients.write", async roleDb => roleDb.client.create({
    data: {
      ...emptyToNull({
        name: data.name,
        type: data.type,
        address: data.address,
        phone: data.phone,
        email: data.email,
        source: data.source,
        notes: data.notes,
        industry: data.industry,
        occupation: data.occupation,
        ethnicity: data.ethnicity
      }),
      idType,
      ...(idNumber && idType ? sealIdNumber(idNumber) : {}),
      internalCode,
      cooperationStatus: data.cooperationStatus,
      gender: data.gender || null,
      tags: data.tags,
      contacts: {
        create: data.contacts.map((c) =>
          emptyToNull({
            name: c.name,
            title: c.title,
            phone: c.phone,
            email: c.email,
            wechat: c.wechat,
            isPrimary: c.isPrimary,
            notes: c.notes
          })
        )
      }
    }
  }));

  await audit({
    userId: session.user.id,
    action: "CLIENT_CREATE",
    targetType: "Client",
    targetId: created.id,
    detail: { name: created.name, type: created.type }
  });

  revalidatePath("/clients");
  return { ok: true, id: created.id };
}

export async function updateClient(input: ClientUpdateInput) {
  const session = await requireSession("clients.write");
  if (session.user.role !== "CUSTOM" && !isManager(session.user.role)) {
    throw new ActionError("仅管理员或主办律师可编辑客户信息");
  }
  const data = parseInput(clientUpdateSchema, input);
  const { id, contacts, gender, idType, idNumber, ...rest } = data;
  await assertCustomClientWrite(session.user, id);

  // v1.x P0-1: 编辑同样查重（排除自身）+ 规范化
  const normalizedIdNumber = normalizeIdNumber(idNumber);
  const nextIdType = (idType || null) as ClientIdType | null;
  if (normalizedIdNumber && nextIdType) {
    const dup = await prisma.client.findFirst({
      where: duplicateWhereInput({ idType: nextIdType, idNumber: normalizedIdNumber, excludeId: id }),
      select: { id: true, name: true, deletedAt: true }
    });
    if (dup) {
      throw new ActionError(`该证件号码已登记于${dup.deletedAt ? "停用" : ""}客户「${dup.name}」，请通过恢复或合并处理`);
    }
  }

  // 简单策略：删除所有联系人 + 重新创建。
  //
  // 2026-11-21 修复（P2，多智能体审计「并发安全」维度）：
  // 两个人同时编辑同一客户的联系人时，READ COMMITTED 下各自走一遍
  // 「删光 → 重建」。B 的 DELETE 语句快照在 A 提交前就取好了，
  // **看不到 A 新建的那批**，于是 B 只删掉旧行、再插自己的一批 ——
  // 最终这个客户有 A 的 + B 的联系人，全都留着，还都标了各自的主联系人。
  //
  // 修法：事务一开始就对该客户行加锁（`SELECT ... FOR UPDATE`），
  // 把「同一客户的联系人编辑」串行化。B 会等 A 提交后才继续，
  // 那时它的 DELETE 是新语句、新快照，能看见 A 插的行，一并删掉。
  //
  // 用行锁而不是加唯一索引：联系人允许同名同电话（真实场景里同一人可能
  // 在两个项目里挂不同头衔），唯一约束会误伤正常数据。行锁只解决并发，
  // 不改变业务允许的形态。
  await prisma.$transaction(async db => {
    await checkRoleMutation(db, session.user, "clients.write");
    // 锁住客户行，串行化对同一客户联系人的并发编辑
    await db.$queryRaw`SELECT 1 AS locked FROM "Client" WHERE id = ${id} FOR UPDATE`;
    await db.contact.deleteMany({ where: { clientId: id } });
    await db.client.update({
      where: { id },
      data: {
        ...emptyToNull(rest),
        idType: nextIdType,
        ...(normalizedIdNumber && nextIdType ? sealIdNumber(normalizedIdNumber) : { idNumber: null, idNumberBlind: null }),
        gender: gender || null,
        tags: data.tags,
        contacts: {
          create: contacts.map((c) =>
            emptyToNull({
              name: c.name,
              title: c.title,
              phone: c.phone,
              email: c.email,
              wechat: c.wechat,
              isPrimary: c.isPrimary,
              notes: c.notes
            })
          )
        }
      }
    });
  });

  await audit({
    userId: session.user.id,
    action: "CLIENT_UPDATE",
    targetType: "Client",
    targetId: id
  });

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return { ok: true, id };
}

export async function softDeleteClient(id: string) {
  const session = await requireSession("clients.write");
  if (session.user.role !== "CUSTOM" && !isManager(session.user.role)) {
    throw new ActionError("只有合伙人或获授权岗位可以删除客户");
  }

  await assertCustomClientWrite(session.user, id);
  await roleMutation(session.user, "clients.write", async roleDb => roleDb.client.update({
    where: { id },
    data: { deletedAt: new Date() }
  }));

  await audit({
    userId: session.user.id,
    action: "CLIENT_DELETE",
    targetType: "Client",
    targetId: id
  });

  revalidatePath("/clients");
  return { ok: true };
}

// 单独的 contact 操作（用于详情页快速编辑联系人，不通过整 client 重写）
export async function addContact(clientId: string, input: ContactInput) {
  const session = await requireSession("clients.write");
  if (session.user.role !== "CUSTOM" && !isManager(session.user.role)) {
    throw new ActionError("仅管理员或主办律师可编辑联系人");
  }
  await assertCustomClientWrite(session.user, clientId);
  const data = parseInput(contactInputSchema, input);
  const created = await roleMutation(session.user, "clients.write", async roleDb => roleDb.contact.create({
    data: { clientId, ...emptyToNull(data) }
  }));
  await audit({
    userId: session.user.id,
    action: "CONTACT_CREATE",
    targetType: "Contact",
    targetId: created.id,
    detail: { clientId }
  });
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, id: created.id };
}

export async function deleteContact(id: string) {
  const session = await requireSession("clients.write");
  if (session.user.role !== "CUSTOM" && !isManager(session.user.role)) {
    throw new ActionError("仅管理员或主办律师可删除联系人");
  }
  const contact = await prisma.contact.findUnique({ where: { id } });
  if (!contact) return { ok: false };
  await assertCustomClientWrite(session.user, contact.clientId);
  await roleMutation(session.user, "clients.write", async roleDb => roleDb.contact.delete({ where: { id } }));
  await audit({
    userId: session.user.id,
    action: "CONTACT_DELETE",
    targetType: "Contact",
    targetId: id,
    detail: { clientId: contact.clientId }
  });
  revalidatePath(`/clients/${contact.clientId}`);
  return { ok: true };
}

async function assertCustomClientWrite(user: RoleUser & { id: string }, id: string) {
  if (user.role !== "CUSTOM") return;
  const scope = scopeFor(user, "clients.write");
  const grants = scope ? [{ permissionKey: "clients.read" as const, scope }] : [];
  if (!scope || !await prisma.client.count({ where: { id, deletedAt: null, ...clientVisibilityFilter(user.id, user.role, grants) } })) throw new ActionError("客户不存在或无权维护");
}
