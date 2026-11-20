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
