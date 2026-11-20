"use server";

/**
 * 业务口径保存动作（2026-11-22）
 *
 * 与 `lead-finance-policy.ts`（只读+类型）分开：写动作带 `"use server"` 与
 * `revalidatePath`，混在一起会让客户端组件把 server-only 模块拖进浏览器包
 * （本项目已因此失败过两次，见台账 2026-11-22 03:30）。
 *
 * 权限：口径直接决定钱怎么算，限管理员/合伙人。
 */

import { z } from "zod";
import { requireSession } from "@/lib/auth/session";
import { ActionError } from "@/lib/action-error";
import { parseInput } from "@/lib/parse-input";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";
import { getLeadFinancePolicy, saveLeadFinancePolicy } from "./lead-finance-policy";

const schema = z.object({
  contingencyBasis: z.enum(["RECEIVED", "CONTRACT"]),
  voucherAmountSide: z.enum(["COST", "REVENUE", "IGNORED"])
});

export async function updateLeadFinancePolicy(input: z.input<typeof schema>) {
  const session = await requireSession("clients.write");
  if (!["ADMIN", "PRINCIPAL_LAWYER"].includes(session.user.role) && session.user.role !== "CUSTOM") {
    throw new ActionError("仅管理员或合伙人可修改业务口径");
  }
  const data = parseInput(schema, input);
  const before = await getLeadFinancePolicy();

  await saveLeadFinancePolicy(data);
  await audit({
    userId: session.user.id,
    action: "LEAD_FINANCE_POLICY",
    targetType: "SystemSetting",
    targetId: "leadFinancePolicy",
    detail: { before, after: data }
  });
  revalidatePath("/leads");
  return { ok: true as const };
}
