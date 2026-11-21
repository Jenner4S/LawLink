"use server";

/**
 * 线索列显隐保存（2026-11-23）
 *
 * 与 `leads-columns.ts`（只读 + 类型）分开：写动作带 `"use server"`，
 * 混在一起会把 server-only 模块拖进客户端包（本项目踩过两次）。
 */
import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { parseInput } from "@/lib/parse-input";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";
import { getLeadsListColumns, saveLeadsListColumns } from "./leads-columns";

const schema = z.object({
  columns: z.array(z.string().min(1)).min(1, "至少保留一列")
});

export async function updateLeadsListColumns(input: z.input<typeof schema>) {
  const session = await requireSession("clients.write");
  if (!["ADMIN", "PRINCIPAL_LAWYER"].includes(session.user.role) && session.user.role !== "CUSTOM") {
    throw new ActionError("仅管理员或合伙人可调整列表列");
  }
  const data = parseInput(schema, input);
  const before = await getLeadsListColumns();
  const after = await saveLeadsListColumns(data.columns);

  await audit({
    userId: session.user.id,
    action: "LEADS_COLUMNS",
    targetType: "SystemSetting",
    targetId: "leads.listColumns",
    detail: { before, after }
  });
  revalidatePath("/leads");
  return { ok: true as const, columns: after };
}
