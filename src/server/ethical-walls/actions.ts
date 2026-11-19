"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";

import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { isSystemAdmin } from "@/lib/auth/system-role";
import { userRoleLabel } from "@/lib/enums";
import { isManager, matterReadVisibilityFilter } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { parseShDayEnd } from "@/lib/ui/sh-time";
import { auditTx } from "@/server/audit";
import { revalidateMatter } from "@/server/matters/route";

import { denialTargetLabel, denyTypeLabel, wallStatusOf, type WallStatus } from "./labels";
import {
  DENIABLE_ROLES,
  createWallSchema,
  liftWallSchema,
  normalizeDenials,
  type CreateWallInput,
  type DenyType,
  type LiftWallInput
} from "./schemas";

/**
 * 隔离墙管理服务层（管理后台 /admin/ethical-walls 的后端）。
 *
 * 与 src/lib/permissions/ethical-wall.ts 的分工：那边是**拦截**（读链路把墙叠加进
 * MatterWhereInput，对全所生效含管理员），这边是**维护**（谁能建、谁能解、怎么留痕）。
 * 本模块不重复实现拦截，也不改动拦截口径。
 *
 * 三条与拦截层一致的设计约束：
 *   1. 建/解都需要管理资格（系统管理员或业务管理权），但**被隔离者本人不能管理自己的墙**：
 *      否则「先把自己解封」只需一次点击，隔离墙就退化成建议。系统管理员例外——它是
 *      唯一的兜底出口（例如合伙人整体被隔离、无其他有资格人时）。
 *   2. 解除是留痕动作，不是幂等开关：重复解除视为错误（见 liftEthicalWall 注释）。
 *   3. 审计与业务变更同事务提交（auditTx）：隔离墙是执业合规记录，
 *      「改了但没有审计」等于没改。
 */

// ---------------- 权限 ----------------

type WallManagerSession = Awaited<ReturnType<typeof requireSession>>;

/**
 * 管理资格：系统管理员，或业务管理权持有者（合伙人 / 按人授予 managerAuthorized）。
 * 用 requireSession("personal") 而不是 requireSystemAdmin：合伙人不是系统管理员，
 * 但隔离墙是律所业务合规动作，必须由业务管理方而非仅 IT 管理方掌握。
 */
async function requireWallManager(): Promise<WallManagerSession> {
  const session = await requireSession("personal");
  if (!isSystemAdmin(session.user) && !isManager(session.user)) {
    throw new ActionError("仅系统管理员或合伙人可维护隔离墙");
  }
  return session;
}

// ---------------- 内部工具 ----------------

type DenialRow = {
  denyType: string;
  userId: string | null;
  teamId: string | null;
  role: string | null;
};

/** 当前管理者本人在哪些活跃团队里——判定 TEAM 类隔离需要它 */
async function viewerTeamIds(userId: string): Promise<string[]> {
  const rows = await prisma.teamMember.findMany({
    where: { userId, active: true },
    select: { teamId: true }
  });
  return rows.map((row) => row.teamId);
}

/** 该墙是否把查看者本人挡住了（与 ethicalWallExclusion 的三种命中条件同构） */
function viewerIsDenied(
  denials: DenialRow[],
  viewer: { id: string; role: string },
  teamIds: string[]
): boolean {
  return denials.some(
    (row) =>
      (row.denyType === "USER" && row.userId === viewer.id) ||
      (row.denyType === "TEAM" && !!row.teamId && teamIds.includes(row.teamId)) ||
      (row.denyType === "ROLE" && row.role === viewer.role)
  );
}

/** zod 失败一律转成 ActionError，保证客户端只面对一条中文错误通道 */
function parseOrThrow<T>(result: { success: true; data: T } | { success: false; error: { issues: { message: string }[] } }): T {
  if (result.success) return result.data;
  throw new ActionError(result.error.issues[0]?.message || "输入信息有误，请检查后重试");
}

/**
 * 「失效日期」按上海时区的当天 23:59:59.999 落库。
 * 语义是「到这一天下班为止仍然生效」——用户在后台选 11-30，看到的是 11-30 这天结束才失效。
 * 用固定 +08:00 拼接而不是 new Date(y, m, d)：后者按运行时区解释，UTC 服务器会整体偏移一天。
 */
function resolveExpiresAt(key: string | null | undefined): Date | null {
  const text = (key ?? "").trim();
  if (!text) return null;
  // 2026-11-20：日期回验统一走 sh-time 的 parseShDayEnd（原为手写回验）。
  const at = parseShDayEnd(text);
  if (!at) {
    throw new ActionError("失效日期不存在，请重新选择");
  }
  if (at.getTime() <= Date.now()) {
    throw new ActionError("失效日期必须晚于当前时间");
  }
  return at;
}

async function revalidateWallSurfaces(matterId: string): Promise<void> {
  revalidatePath("/admin/ethical-walls");
  // 案件列表与案件详情都受隔离墙影响（读链路过滤），解除/新建后必须失效
  revalidatePath("/matters");
  await revalidateMatter(matterId);
}

// ---------------- 读写类型 ----------------

export type EthicalWallTargetSummary = {
  key: string;
  denyType: DenyType;
  typeLabel: string;
  label: string;
};

export type EthicalWallRow = {
  id: string;
  matterId: string;
  matterCode: string;
  matterTitle: string;
  reason: string;
  status: WallStatus;
  expiresAt: Date | null;
  createdAt: Date;
  createdByName: string;
  liftedAt: Date | null;
  liftedByName: string | null;
  liftReason: string | null;
  targets: EthicalWallTargetSummary[];
};

export type EthicalWallFilter = {
  matterId?: string | null;
  active?: boolean | null;
};

export type WallTargetOptions = {
  matters: { id: string; internalCode: string; title: string }[];
  users: { id: string; name: string; role: string; roleLabel: string }[];
  teams: { id: string; name: string }[];
  roles: { value: string; label: string }[];
};

// ---------------- 新建 ----------------

export async function createEthicalWall(input: CreateWallInput): Promise<{ id: string }> {
  const session = await requireWallManager();
  const parsed = createWallSchema.safeParse(input);
  const data = parseOrThrow(parsed);
  const denials = normalizeDenials(data.denials);
  const expiresAt = resolveExpiresAt(data.expiresAt);

  const matter = await prisma.matter.findFirst({
    where: { id: data.matterId, deletedAt: null },
    select: { id: true, internalCode: true, title: true }
  });
  if (!matter) throw new ActionError("案件不存在或已删除，请刷新后重新选择");

  // 实体存在性：写歪的隔离墙（目标 id 不存在）在拦截层永远不命中任何人，
  // 界面却显示「已生效」——必须在写库前拦住。
  const userIds = denials.map((denial) => denial.userId).filter((id): id is string => !!id);
  const teamIds = denials.map((denial) => denial.teamId).filter((id): id is string => !!id);

  const [users, teams] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true, active: true }
        })
      : Promise.resolve([]),
    teamIds.length
      ? prisma.team.findMany({
          where: { id: { in: teamIds } },
          select: { id: true, name: true, active: true }
        })
      : Promise.resolve([])
  ]);

  if (users.length !== new Set(userIds).size) throw new ActionError("被隔离人员不存在，请刷新后重试");
  if (users.some((user) => !user.active)) throw new ActionError("不能隔离已停用的账号");
  if (teams.length !== new Set(teamIds).size) throw new ActionError("被隔离团队不存在，请刷新后重试");
  if (teams.some((team) => !team.active)) throw new ActionError("不能隔离已停用的团队");

  const targetShots = denials.map((denial) => {
    if (denial.denyType === "USER") {
      const user = users.find((row) => row.id === denial.userId);
      return { denyType: "USER", targetId: denial.userId!, targetName: user?.name ?? "" };
    }
    if (denial.denyType === "TEAM") {
      const team = teams.find((row) => row.id === denial.teamId);
      return { denyType: "TEAM", targetId: denial.teamId!, targetName: team?.name ?? "" };
    }
    return {
      denyType: "ROLE",
      targetId: denial.role!,
      targetName: userRoleLabel[denial.role!]
    };
  });

  const created = await prisma.$transaction(async (tx) => {
    const wall = await tx.ethicalWall.create({
      data: {
        matterId: matter.id,
        reason: data.reason,
        expiresAt,
        createdById: session.user.id,
        denials: {
          create: denials.map((denial) => ({
            denyType: denial.denyType,
            userId: denial.userId,
            teamId: denial.teamId,
            role: denial.role
          }))
        }
      },
      select: { id: true }
    });
    await auditTx(tx, {
      userId: session.user.id,
      action: "ETHICAL_WALL_CREATE",
      targetType: "EthicalWall",
      targetId: wall.id,
      detail: {
        matterId: matter.id,
        matterCode: matter.internalCode,
        matterTitle: matter.title,
        reason: data.reason,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        denials: targetShots
      }
    });
    return wall;
  });

  await revalidateWallSurfaces(matter.id);
  return { id: created.id };
}

// ---------------- 解除 ----------------

/**
 * 解除（停用）一堵墙。
 *
 * 重复解除按**错误**处理而不是幂等：解除理由与解除人本身就是合规记录的一部分，
 * 若允许「再解一次、覆盖理由」，第二次操作会抹掉第一次留痕（谁在什么时候为什么解封），
 * 而这恰是事后追责最需要的一段。幂等语义会把这种覆盖包装成「成功」。
 * 并发下两次点击同理：条件更新只在 active=true 时命中，第二次得到 0 行即拒绝。
 */
export async function liftEthicalWall(input: LiftWallInput): Promise<{ id: string }> {
  const session = await requireWallManager();
  const parsed = liftWallSchema.safeParse(input);
  const data = parseOrThrow(parsed);

  const wall = await prisma.ethicalWall.findUnique({
    where: { id: data.id },
    select: {
      id: true,
      matterId: true,
      active: true,
      reason: true,
      expiresAt: true,
      matter: { select: { internalCode: true, title: true } },
      denials: { select: { denyType: true, userId: true, teamId: true, role: true } }
    }
  });
  if (!wall) throw new ActionError("隔离墙不存在或已删除");
  if (!wall.active) throw new ActionError("该隔离墙已解除，无需重复操作");

  if (!isSystemAdmin(session.user)) {
    const teamIds = await viewerTeamIds(session.user.id);
    if (viewerIsDenied(wall.denials, { id: session.user.id, role: session.user.role }, teamIds)) {
      throw new ActionError("该隔离墙涉及你本人，需由系统管理员处理");
    }
  }

  const liftedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const result = await tx.ethicalWall.updateMany({
      where: { id: wall.id, active: true },
      data: { active: false, liftedAt, liftedById: session.user.id, liftReason: data.liftReason }
    });
    if (result.count === 0) {
      throw new ActionError("该隔离墙已被其他管理员解除，请刷新后重试");
    }
    await auditTx(tx, {
      userId: session.user.id,
      action: "ETHICAL_WALL_LIFT",
      targetType: "EthicalWall",
      targetId: wall.id,
      detail: {
        matterId: wall.matterId,
        matterCode: wall.matter.internalCode,
        matterTitle: wall.matter.title,
        wallReason: wall.reason,
        expiresAt: wall.expiresAt ? wall.expiresAt.toISOString() : null,
        liftReason: data.liftReason,
        liftedAt: liftedAt.toISOString(),
        denials: wall.denials
      }
    });
  });

  await revalidateWallSurfaces(wall.matterId);
  return { id: wall.id };
}

// ---------------- 列表 ----------------

/**
 * 列表（可按案件或生效状态过滤）。
 *
 * 非系统管理员的查看者看不到「把自己隔离掉」的墙：隔离墙的合规意义包含
 * 「被隔离的人不应知道该案件的存在与隔离理由」，在管理页泄露案件名同样破坏隔离。
 * 代价是被隔离的管理者无法自行解封（这是刻意的），需要系统管理员介入。
 */
export async function listEthicalWalls(filter: EthicalWallFilter = {}): Promise<EthicalWallRow[]> {
  const session = await requireWallManager();
  const where: Prisma.EthicalWallWhereInput = {};
  if (filter.matterId) where.matterId = filter.matterId;
  if (typeof filter.active === "boolean") where.active = filter.active;

  const rows = await prisma.ethicalWall.findMany({
    where,
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      matterId: true,
      reason: true,
      active: true,
      expiresAt: true,
      createdAt: true,
      liftedAt: true,
      liftReason: true,
      createdBy: { select: { name: true } },
      liftedBy: { select: { name: true } },
      matter: { select: { internalCode: true, title: true } },
      denials: {
        select: {
          denyType: true,
          userId: true,
          teamId: true,
          role: true,
          user: { select: { name: true, active: true } },
          team: { select: { name: true, active: true } }
        }
      }
    }
  });

  const now = new Date();
  const systemAdmin = isSystemAdmin(session.user);
  // TEAM 类隔离需要查看者的团队归属；只有真的存在 TEAM 目标时才查这一次
  const needsTeams =
    !systemAdmin && rows.some((row) => row.denials.some((denial) => denial.denyType === "TEAM"));
  const teamIds = needsTeams ? await viewerTeamIds(session.user.id) : [];
  const viewer = { id: session.user.id, role: session.user.role };
  const visible = systemAdmin
    ? rows
    : rows.filter((row) => !viewerIsDenied(row.denials, viewer, teamIds));

  return visible.map((row) => ({
    id: row.id,
    matterId: row.matterId,
    matterCode: row.matter.internalCode,
    matterTitle: row.matter.title,
    reason: row.reason,
    status: wallStatusOf({ active: row.active, expiresAt: row.expiresAt }, now),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    createdByName: row.createdBy?.name ?? "—",
    liftedAt: row.liftedAt,
    liftedByName: row.liftedBy?.name ?? null,
    liftReason: row.liftReason,
    targets: row.denials.map((denial) => ({
      key: `${denial.denyType}:${denial.userId ?? denial.teamId ?? denial.role}`,
      denyType: denial.denyType as DenyType,
      typeLabel: denyTypeLabel[denial.denyType as DenyType],
      label: denialTargetLabel({
        denyType: denial.denyType as DenyType,
        userName: denial.user?.name,
        userActive: denial.user?.active,
        teamName: denial.team?.name,
        teamActive: denial.team?.active,
        role: denial.role
      })
    }))
  }));
}

// ---------------- 选项（新建表单用） ----------------

export async function listWallTargets(): Promise<WallTargetOptions> {
  const session = await requireWallManager();
  const user = session.user;

  // 系统管理员不受业务可见性限制（它是隔离墙的兜底维护者）；其他人按案件读口径取，
  // 避免在「选案件」下拉里泄露自己被隔离的案件。
  const matterWhere: Prisma.MatterWhereInput = isSystemAdmin(user)
    ? { deletedAt: null }
    : { AND: [{ deletedAt: null }, matterReadVisibilityFilter(user.id, user.role, user.rolePermissions)] };

  const [matters, users, teams] = await Promise.all([
    prisma.matter.findMany({
      where: matterWhere,
      orderBy: [{ updatedAt: "desc" }],
      take: 500,
      select: { id: true, internalCode: true, title: true }
    }),
    prisma.user.findMany({
      where: { active: true },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, role: true }
    }),
    prisma.team.findMany({
      where: { active: true },
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true }
    })
  ]);

  return {
    matters,
    users: users.map((row) => ({
      id: row.id,
      name: row.name,
      role: row.role,
      roleLabel: userRoleLabel[row.role]
    })),
    teams,
    roles: DENIABLE_ROLES.map((role) => ({ value: role, label: userRoleLabel[role] }))
  };
}
