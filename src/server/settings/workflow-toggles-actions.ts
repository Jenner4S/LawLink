"use server";

import { revalidatePath } from "next/cache";
import { parseInput } from "@/lib/parse-input";
import { z } from "zod";
import { requireSystemAdmin } from "@/lib/auth/session";
import { audit } from "@/server/audit";
import { getWorkflowToggles, saveWorkflowToggles } from "./workflow-toggles";

const saveSchema = z.object({
  externalContactReview: z.boolean()
});

export async function saveWorkflowTogglesAction(input: z.infer<typeof saveSchema>) {
  const session = await requireSystemAdmin();
  const data = parseInput(saveSchema, input);
  await saveWorkflowToggles(data);
  await audit({
    userId: session.user.id,
    action: "WORKFLOW_TOGGLES_SAVE",
    targetType: "SystemSetting",
    targetId: "workflowToggles",
    detail: data
  });
  revalidatePath("/admin/firm-profile");
  revalidatePath("/admin/firm-profile");
  return { ok: true };
}

export async function getWorkflowTogglesAction() {
  await requireSystemAdmin();
  return getWorkflowToggles();
}
