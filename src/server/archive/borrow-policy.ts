/**
 * 归档材料的取阅策略（2026-11-21）
 *
 * ## 这个文件为什么存在
 *
 * 第八轮审计后做借阅链条真库测试时发现一个矛盾：
 *   · 借阅的**申请资格**是「对该案有常规可见性」（主办/成员/团队）；
 *   · 借阅授权的**效果**只发生在 `assertCanReadMatter` / `canReadDocument`
 *     的「常规路径不通过」分支。
 * 两条路交集为空 → 合法路径上没人能拿到借阅授权，借阅链空转。
 *
 * 根源是：归档**不收回**团队/主办对案件的可见性
 * （`approveArchiveRecord` 只写 status/archivedAt/closedAt）。
 * 于是「归档后需要借阅才能看」这个前提从来不成立。
 *
 * ## 处置：可配置 + 默认有主张
 *
 * 按 AGENTS §五之二：多选项做成可配置，默认值必须有主张。
 *   · 默认 `REQUIRE_BORROW`（归档就要借阅）—— 「归档 = 收起来」，
 *     且它是唯一能让「限时借阅」自洽的口径；
 *   · 可切到 `OPEN`（归档后照旧按案件关系放行）—— 有的所把归档当"只读存档"，
 *     不希望取阅要审批；切换后行为回到 2026-11-21 之前。
 *
 * ## 边界（重要）
 *
 * 本策略只作用于**归档材料的内容取阅**（下载/预览），
 * **不影响**案件元数据读取（详情页、列表）——否则归档案件连看都看不了，
 * 会把"归档"变成"消失"，那是另一个产品。
 *
 * 合伙人及以上（`isManager`）不走本策略，与 `canReadDocument` 既有口径一致。
 */
import { prisma } from "@/lib/prisma";

const POLICY_KEY = "archive.materialAccessPolicy";

export type ArchiveMaterialPolicy = "REQUIRE_BORROW" | "OPEN";

export const ARCHIVE_POLICY_DEFAULTS: { policy: ArchiveMaterialPolicy } = {
  // 有主张的默认：归档即收起来，取阅需借阅（可审计、限时、可归还）
  policy: "REQUIRE_BORROW"
};

export async function getArchiveMaterialPolicy(): Promise<ArchiveMaterialPolicy> {
  const row = await prisma.systemSetting.findUnique({ where: { key: POLICY_KEY } });
  const v = (row?.value as { policy?: string } | null)?.policy;
  return v === "OPEN" || v === "REQUIRE_BORROW" ? v : ARCHIVE_POLICY_DEFAULTS.policy;
}

/** 该用户对该归档案件是否有有效借阅（已批准、未归还、未到期、归档记录有效） */
export async function hasActiveArchiveBorrowGrant(userId: string, matterId: string): Promise<boolean> {
  const row = await prisma.archiveBorrowRequest.findFirst({
    where: {
      applicantId: userId,
      status: "APPROVED",
      accessUntil: { gte: new Date() },
      archiveRecord: { status: "APPROVED", matterId }
    },
    select: { id: true }
  });
  return Boolean(row);
}

/**
 * 该用户对某归档案件是否「可见但取阅材料需要借阅」（2026-11-21）
 *
 * 用于下载/预览被拒时给出**可操作的**提示。
 *
 * 为什么不能一律 404：`/api/documents/[id]/download` 对无权者统一返回 404
 * 「材料不存在」，目的是防止通过状态码枚举材料是否存在（2026-11-20 安全探针）。
 * 但归档材料收紧之后，一个**本来就看得见这个案件**的律师点下载也会收到
 * 「材料不存在」——材料明明存在，这是对知情人说假话，且他无从知道该去申请借阅。
 *
 * 判据：本人对该案有常规关系（主办/成员）+ 案件已归档 + 无有效借阅。
 * 这类人已经知道案件存在，告诉他「需借阅」不泄露任何额外信息；
 * 与该案无关的人仍走 404，枚举面不变。
 */
export async function needsBorrowToReadMaterials(userId: string, matterId: string): Promise<boolean> {
  const matter = await prisma.matter.findUnique({
    where: { id: matterId },
    select: {
      deletedAt: true,
      status: true,
      ownerId: true,
      members: { where: { userId }, select: { userId: true } }
    }
  });
  if (!matter || matter.deletedAt || matter.status !== "ARCHIVED") return false;
  const related = matter.ownerId === userId || matter.members.length > 0;
  if (!related) return false;
  if (await getArchiveMaterialPolicy() === "OPEN") return false;
  return !(await hasActiveArchiveBorrowGrant(userId, matterId));
}
