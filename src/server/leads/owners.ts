/**
 * 可派单的律师清单（2026-11-22，P1-2）
 *
 * 只列**在职**且角色与案件承办相关的账号：停用账号派不出单，
 * 派了也没人接，只会让线索在看板上"有主"却实际无人跟。
 */
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/auth/session";

export async function listLawyerOptions(): Promise<{ id: string; name: string }[]> {
  await requireSession("clients.read");
  const rows = await prisma.user.findMany({
    where: {
      active: true,
      role: { in: ["LAWYER", "PRINCIPAL_LAWYER", "INDEPENDENT_LAWYER"] }
    },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
    take: 200
  });
  return rows;
}
