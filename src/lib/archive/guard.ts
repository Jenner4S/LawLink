/**
 * v0.9.4 归档只读门禁
 *
 * 策略（用户选择"中"）：
 *   - 案件 status === "ARCHIVED" 后：业务写操作全禁
 *   - 例外：补传材料到 ARCHIVE 卷宗（结案/归档）允许
 *
 * 调用方式（每个写操作 server action 入口）：
 *   await assertMatterWritable(matterId);
 *
 * 文档上传 / 删除 需要 isArchiveFolder() 配合放行 ARCHIVE 卷宗。
 */
import { scopeFor } from "@/lib/roles/catalog";
import { requireSession } from "@/lib/auth/session";
import { financeRoleAssociatesAnyMatter, matterAssociationFilter } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { ActionError } from "@/lib/action-error";

type WritableGuardOptions = {
  allowedIfArchivedReason?: string;
  allowFinanceRole?: boolean;
  /** 合伙人岗位放行全所案件（与 assertCanHandleMatter 同口径；managerAuthorized 不放行——管理权只放大读取） */
  allowPrincipal?: boolean;
  /** 显式操作人（cron 队列等无请求上下文的场景替代 requireSession；有请求时不要传，走会话） */
  actor?: { id: string; role: string; managerAuthorized?: boolean };
};

async function findWritableMatter(
  matterId: string,
  opts?: Pick<WritableGuardOptions, "allowFinanceRole" | "allowPrincipal" | "actor">
) {
  const session = opts?.actor
    ? { user: opts.actor }
    : await requireSession("personal");
  // 自定义角色只要具备全所范围的「维护收付款」或「确认实收到账」之一，即按财务角色放行案件关联校验
  const allowByFinanceRole = opts?.allowFinanceRole && !opts?.actor && financeRoleAssociatesAnyMatter(session.user);
  const allowByPrincipal = opts?.allowPrincipal && session.user.role === "PRINCIPAL_LAWYER";
  return prisma.matter.findFirst({
    where: {
      id: matterId,
      deletedAt: null,
      ...(allowByFinanceRole || allowByPrincipal ? {} : matterAssociationFilter(session.user.id))
    },
    select: { status: true, archivedAt: true }
  });
}

/**
 * 已归档案件视为只读。抛错（中文）由 UI catch 显示 toast。
 */
export async function assertMatterWritable(
  matterId: string | null | undefined,
  opts?: WritableGuardOptions
): Promise<void> {
  if (!matterId) return;
  const matter = await findWritableMatter(matterId, opts);
  if (!matter) throw new ActionError("案件不存在或无权处理");
  if (matter.status === "ARCHIVED") {
    const detail = opts?.allowedIfArchivedReason
      ? `（${opts.allowedIfArchivedReason}除外）`
      : "";
    throw new ActionError(`案件已归档，禁止修改${detail}`);
  }
}

/**
 * 判定 folder 是否为 ARCHIVE 卷宗（结案 / 归档），用于上传材料门禁放行。
 * 命中条件：name 命中 ["结案", "归档"] 之一（与 default-folders.ts 一致）。
 */
const ARCHIVE_FOLDER_NAMES = new Set(["结案", "归档"]);

export function isArchiveFolderName(name: string | null | undefined): boolean {
  if (!name) return false;
  return ARCHIVE_FOLDER_NAMES.has(name);
}

/**
 * 文档操作门禁：归档后只允许上传到 ARCHIVE 卷宗。删除/重命名/移动一律禁止。
 */
export async function assertDocumentWritable(
  matterId: string | null | undefined,
  opts: { kind: "upload" | "modify"; folderName?: string | null; allowFinanceRole?: boolean; allowPrincipal?: boolean; actor?: { id: string; role: string; managerAuthorized?: boolean } }
): Promise<void> {
  if (!matterId) return;
  const matter = await findWritableMatter(matterId, opts);
  if (!matter) throw new ActionError("案件不存在或无权处理");

  // 隔离墙（2026-11-20 补，与 assertLedgerWrite 同批）。
  //
  // 读取侧 matterReadVisibilityFilter 的注释写着「隔离墙对全所生效（含合伙人/管理员）……
  // 这是执业合规要求，不是权限设置」，但写入侧只查成员关系（matterAssociationFilter
  // 不含墙），于是「看得见的限制、碰得到的自由」——被墙隔离的人读不到该案材料，
  // 却能上传、修改、删除它的材料。上传材料是最直接的「接触案件内容」。
  //
  // 为什么只加在这里、不加在 findWritableMatter（那会让 assertMatterWritable 的 101 处
  // 调用全部变化）：assertMatterWritable 覆盖结案、归档、交接等生命周期操作，
  // 而被墙者「把案件交接出去」恰恰是解决冲突的正常途径，一刀切会把人堵死。
  // 那部分需要按场景逐个确认语义，已在台账登记为待产品判断项。
  {
    const session = opts?.actor ? { user: opts.actor } : await requireSession("personal");
    const { isMatterWalledFor } = await import("@/lib/permissions/ethical-wall");
    if (await isMatterWalledFor(prisma, { matterId, userId: session.user.id, role: session.user.role })) {
      throw new ActionError("案件不存在或无权处理");
    }
  }
  if (matter.status !== "ARCHIVED") return;

  const session = opts?.actor ? { user: opts.actor } : await requireSession("personal");
  if(scopeFor(session.user,"archive.supplement")!=="OWN")throw new ActionError("归档后追加材料须单独授予补充归档权限");
  if (opts.kind === "modify") {
    throw new ActionError("案件已归档，材料不可修改或删除");
  }
  if (opts.kind === "upload" && !isArchiveFolderName(opts.folderName)) {
    throw new ActionError("案件已归档，仅允许补传材料到「结案」或「归档」卷宗");
  }
}
