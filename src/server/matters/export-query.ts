import { ethicalWallExclusion } from "@/lib/permissions/ethical-wall";
import { MatterCategory, Prisma } from "@prisma/client";
import type { RoleGrant } from "@/lib/roles/catalog";
import { prisma } from "@/lib/prisma";
import {
  intakeVisibilityFilter,
  matterAssociationFilter,
  teamMatterFilter,
  teamIntakeFilter,
  isManager
} from "@/lib/permissions";
import { resolveDateBoundary } from "./export-format";

/**
 * 案件工作簿导出的取数层：查询条件、include 选择器、排序与分组辅助。
 *
 * 依赖方向：export-xlsx（编排层）→ export-query → export-format。
 * 本层不 import export-xlsx / export-rows，避免循环；共享类型
 * （MattersExportTab / MattersExportParams / ExportUser 等）下沉到本文件。
 * export-format 仅以 `import type` 引用 MatterExportRow / MattersExportTab，
 * 编译期擦除，运行时无环。
 */

export type MattersExportTab = "intake" | "active" | "archived" | "revision" | "all";
export type MatterSortBy = "hearing" | "intakeDate" | "claimAmount" | "archivedAt";
export type MatterSortDir = "asc" | "desc";

export type MattersExportParams = {
  tab: MattersExportTab;
  scope?: "all" | "mine" | "team";
  teamId?: string;
  ownerId?: string;
  search?: string;
  category?: MatterCategory;
  status?: string;
  from?: string;
  to?: string;
  sortBy: MatterSortBy;
  sortDir: MatterSortDir;
};

export type ExportUser = {
  id: string;
  role: string;
  rolePermissions?: RoleGrant[];
  /**
   * 业务管理权按人授予（与岗位解耦）。**导出刻意不随它放大**：
   * 工作簿含当事人证件号、电话与住址明文，按人授予的管理权只放开只读可见范围，
   * 导出仍限本人经办 / 参与，合伙人岗位除外（既有口径）。与 MANAGER_GRANTS 注释一致。
   */
  managerAuthorized?: boolean | null;
};

export const MATTER_CATEGORIES = Object.values(MatterCategory) as MatterCategory[];

export const intakeInclude = Prisma.validator<Prisma.IntakeInclude>()({
  client: {
    select: {
      id: true,
      name: true,
      type: true,
      idNumber: true,
      address: true,
      phone: true,
      legalRep: true,
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        take: 3,
        select: { name: true, title: true, phone: true, email: true, isPrimary: true }
      }
    }
  },
  cause: { select: { name: true } },
  ownerUser: { select: { id: true, name: true } },
  parties: { orderBy: [{ role: "asc" }, { ordinal: "asc" }] },
  matter: { select: { id: true, internalCode: true, firmCaseNo: true, title: true } },
  documents: {
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { name: true, category: true, createdAt: true }
  }
});

export const matterInclude = Prisma.validator<Prisma.MatterInclude>()({
  primaryClient: {
    select: {
      id: true,
      name: true,
      type: true,
      idNumber: true,
      address: true,
      phone: true,
      legalRep: true,
      contacts: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
        take: 3,
        select: { name: true, title: true, phone: true, email: true, isPrimary: true }
      }
    }
  },
  clientLinks: {
    orderBy: { addedAt: "asc" },
    include: {
      client: {
        select: {
          id: true,
          name: true,
          type: true,
          idNumber: true,
          address: true,
          phone: true,
          legalRep: true
        }
      }
    }
  },
  owner: { select: { id: true, name: true } },
  members: {
    orderBy: { joinedAt: "asc" },
    include: { user: { select: { id: true, name: true } } }
  },
  cause: { select: { name: true } },
  intake: { include: intakeInclude },
  parties: { orderBy: [{ role: "asc" }, { ordinal: "asc" }] },
  procedures: {
    orderBy: { order: "asc" },
    include: {
      leadLawyer: { select: { id: true, name: true } },
      procedureParties: {
        orderBy: [{ standing: "asc" }, { ordinal: "asc" }],
        include: { party: true }
      },
      hearings: {
        orderBy: { startsAt: "desc" },
        take: 1,
        select: { startsAt: true }
      }
    }
  },
  relatedEntities: {
    orderBy: { createdAt: "asc" },
    select: { name: true, relationship: true, notes: true }
  },
  linksFrom: {
    include: { relatedMatter: { select: { internalCode: true, firmCaseNo: true, title: true } } }
  },
  linksTo: {
    include: { matter: { select: { internalCode: true, firmCaseNo: true, title: true } } }
  },
  documents: {
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: { name: true, category: true, createdAt: true }
  }
});

export type IntakeExportRow = Prisma.IntakeGetPayload<{ include: typeof intakeInclude }>;
export type MatterExportRow = Prisma.MatterGetPayload<{ include: typeof matterInclude }>;

export function defaultSortByForTab(tab: MattersExportTab): MatterSortBy {
  if (tab === "active") return "hearing";
  if (tab === "archived") return "archivedAt";
  return "intakeDate";
}

export function normalizeSortByForTab(tab: MattersExportTab, sortBy: MatterSortBy): MatterSortBy {
  if (sortBy === "hearing" && tab !== "active" && tab !== "all") {
    return defaultSortByForTab(tab);
  }
  if (sortBy === "archivedAt" && tab !== "archived") {
    return defaultSortByForTab(tab);
  }
  if (sortBy === "claimAmount" && tab === "archived") {
    return defaultSortByForTab(tab);
  }
  return sortBy;
}

export function groupRowsByCategory<T extends { category: MatterCategory }>(
  rows: T[],
  category?: MatterCategory
) {
  return MATTER_CATEGORIES
    .filter((candidate) => !category || candidate === category)
    .map((candidate) => ({
      category: candidate,
      rows: rows.filter((row) => row.category === candidate)
    }))
    .filter((group) => group.rows.length > 0);
}

export function buildIntakeWhere(params: MattersExportParams, user: ExportUser): Prisma.IntakeWhereInput {
  const parts: Prisma.IntakeWhereInput[] = [
    intakeVisibilityFilter(user.id, isManager(user.role) ? user.role : "LAWYER"),
    params.tab === "revision"
      ? { status: { in: ["NEEDS_REVISION"] } }
      : { status: { in: ["INTAKE", "PENDING_CONFIRMATION"] } }
  ];
  if (params.scope === "mine") parts.push(intakeVisibilityFilter(user.id, "LAWYER"));
  if (params.scope === "team" || params.teamId) parts.push(teamIntakeFilter(user.id, params.teamId));
  if (params.ownerId) parts.push({ ownerUserId: params.ownerId });
  if (params.category) parts.push({ category: params.category });
  const from = resolveDateBoundary(params.from, false);
  const to = resolveDateBoundary(params.to, true);
  if (from || to) {
    parts.push({
      receivedAt: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {})
      }
    });
  }
  if (params.search) {
    parts.push({
      OR: [
        { title: { contains: params.search, mode: "insensitive" } },
        { description: { contains: params.search, mode: "insensitive" } },
        { client: { name: { contains: params.search, mode: "insensitive" } } },
        { cause: { name: { contains: params.search, mode: "insensitive" } } },
        { parties: { some: { name: { contains: params.search, mode: "insensitive" } } } }
      ]
    });
  }
  return { AND: parts };
}

export function buildMatterWhere(params: MattersExportParams, user: ExportUser): Prisma.MatterWhereInput {
  const parts: Prisma.MatterWhereInput[] = [
    // 导出口径窄于列表可见口径：只允许本人经办 / 参与的案件，管理岗（主任律师）例外。
    // 财务岗虽可见全所案件的财务字段，但工作簿含当事人证件与联系方式，不得整所导出。
    // 只认合伙人岗位（字符串形式），不传 user 对象——见 ExportUser.managerAuthorized 注释
    (isManager(user.role) ? {} : matterAssociationFilter(user.id)),
    { deletedAt: null },
    // 隔离墙（2026-11-20 补）：上面那行的 isManager 分支是 {}，合伙人因此可导出全所；
    // 而这里此前从不查墙 —— 于是被隔离在墙内的案件，其当事人证件号、联系方式、
    // 标的额会随工作簿一起被带出系统。工作簿是本系统敏感度最高的一个出口：
    // 注释自己都写了「含当事人证件与联系方式，不得整所导出」。
    // 用纯函数拼 where（不需要 db 访问），且必须放在 isManager 短路之后单独叠加，
    // 与 matterReadVisibilityFilter 的处理方式一致：墙对全所生效，含合伙人。
    ethicalWallExclusion(user.id, user.role),
    matterStatusWhere(params)
  ];
  if (params.scope === "mine") parts.push(matterAssociationFilter(user.id));
  if (params.scope === "team" || params.teamId) parts.push(teamMatterFilter(user.id, params.teamId));
  if (params.ownerId) parts.push({ ownerId: params.ownerId });
  if (params.category) parts.push({ category: params.category });
  const from = resolveDateBoundary(params.from, false);
  const to = resolveDateBoundary(params.to, true);
  if (from || to) {
    parts.push({
      intakeDate: {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {})
      }
    });
  }
  if (params.search) {
    parts.push({
      OR: [
        { title: { contains: params.search, mode: "insensitive" } },
        { internalCode: { contains: params.search, mode: "insensitive" } },
        { firmCaseNo: { contains: params.search, mode: "insensitive" } },
        { primaryClient: { name: { contains: params.search, mode: "insensitive" } } },
        { cause: { name: { contains: params.search, mode: "insensitive" } } },
        { parties: { some: { name: { contains: params.search, mode: "insensitive" } } } },
        { procedures: { some: { caseNumber: { contains: params.search, mode: "insensitive" } } } }
      ]
    });
  }
  return { AND: parts };
}

export function matterStatusWhere(params: MattersExportParams): Prisma.MatterWhereInput {
  if (params.tab === "archived") return { status: { in: ["ARCHIVED"] } };
  if (params.tab === "active") return { status: { notIn: ["CLOSED", "ARCHIVED"] } };
  if (params.status === "active") return { status: { in: ["IN_PROGRESS", "ON_HOLD"] } };
  if (params.status === "closed") return { status: { in: ["CLOSED"] } };
  if (params.status === "archived") return { status: { in: ["ARCHIVED"] } };
  return { status: { in: ["IN_PROGRESS", "ON_HOLD", "CLOSED", "ARCHIVED"] } };
}

export function intakeOrderBy(params: MattersExportParams): Prisma.IntakeOrderByWithRelationInput[] {
  if (params.sortBy === "claimAmount") {
    return [{ claimAmount: params.sortDir }, { receivedAt: "desc" }];
  }
  return [{ receivedAt: params.sortDir }];
}

export function sortMatterRows(rows: MatterExportRow[], params: MattersExportParams) {
  return [...rows].sort((a, b) => {
    const aValue = matterSortValue(a, params.sortBy);
    const bValue = matterSortValue(b, params.sortBy);
    const aEmpty = aValue === null || aValue === undefined;
    const bEmpty = bValue === null || bValue === undefined;
    if (aEmpty && bEmpty) return b.updatedAt.getTime() - a.updatedAt.getTime();
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    const direction = params.sortDir === "asc" ? 1 : -1;
    const base =
      aValue instanceof Date || bValue instanceof Date
        ? (aValue as Date).getTime() - (bValue as Date).getTime()
        : Number(aValue) - Number(bValue);
    if (base !== 0) return base * direction;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

export function matterSortValue(row: MatterExportRow, sortBy: MatterSortBy) {
  if (sortBy === "hearing") {
    return (
      row.procedures
        .map((procedure) => procedure.hearings[0]?.startsAt ?? null)
        .filter((date): date is Date => !!date)
        .sort((a, b) => b.getTime() - a.getTime())[0] ?? null
    );
  }
  if (sortBy === "claimAmount") {
    return row.claimAmount === null || row.claimAmount === undefined
      ? null
      : Number(row.claimAmount);
  }
  if (sortBy === "archivedAt") {
    return row.archivedAt;
  }
  return row.intakeDate;
}

export async function loadUserNameMap(ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map<string, string>();
  const users = await prisma.user.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, name: true }
  });
  return new Map(users.map((user) => [user.id, user.name]));
}
