"use server";

/**
 * 坏账登记（2026-11-22，对标分析 P0-5）
 *
 * ## 这一段补的是什么
 *
 * 客户现行系统有一列「退款及无法收取费用差额」。LawLink 此前只有退款，
 * **没有坏账**——于是应收永远挂着，回款率永远到不了 100%，而没人知道差额是什么。
 *
 * ## 三条口径
 *
 * ① **只有 APPROVED 才扣减未收余额**。PENDING 是"申报"，不是事实；
 *    若申报即扣减，律师只要提一笔坏账就能把回款率做漂亮。
 *
 * ② **坏账不减应收发生额，只减未收余额**。应收是历史事实（合同签了多少），
 *    坏账是对事实的处置。混在一起就分不清「当初应收多少」与「后来免了多少」。
 *
 * ③ **申报与批准分开，批准需 `finance.correct`（ALL 范围）**。
 *    这个权限在本项目里本就是"确认财务更正"的独立权限——
 *    坏账就是一次财务更正，不该由申报人自己批。
 *
 * ## 已知边界（如实声明）
 *
 * · 不做金额阈值分级审批（方案里提过"阈值以下可单人确认"，但那需要一套
 *   可配置阈值 + 更多测试；当前统一走 `finance.correct`，更严不会更松）；
 * · 不自动核销对应应收条目（`Allocation` 是另一条链），本表只提供"扣减额"口径，
 *   与应收条目的逐笔对应留待财务批次；
 * · 报表口径尚未纳入坏账（案件页已扣减），此事已在台账登记，不假装已通。
 */

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseInput } from "@/lib/parse-input";
import { ActionError } from "@/lib/action-error";
import { requireSession } from "@/lib/auth/session";
import { canExecuteFinance } from "@/lib/roles/catalog";
import { roleMutation } from "@/lib/roles/service";
import { audit } from "@/server/audit";
import { revalidatePath } from "next/cache";
import { assertMatterWritable } from "@/lib/archive/guard";

const requestSchema = z.object({
  matterId: z.string().trim().min(1),
  billingId: z.string().trim().optional().or(z.literal("")),
  // 只接受两位小数：否则 1.005 这类值会「校验用原始值、落库被 numeric(14,2) 舍入」，
  // 导致明细合计 ≠ 坏账总额（独立复核指出，已实测 Math.round(1.005*100)/100 = 1）。
  amount: z.coerce.number().positive("坏账金额须大于 0").max(1_000_000_000)
    .multipleOf(0.01, "金额最多两位小数"),
  reason: z.enum(["CUSTOMER_UNREACHABLE", "INABILITY_TO_PAY", "WAIVED", "IN_DISPUTE", "OTHER"]),
  note: z.string().trim().max(500).optional().or(z.literal(""))
});

/**
 * 按「最早到期优先」把坏账额分摊到该案的未收应收条目。
 *
 * 为什么自动分摊而不是让人逐条勾选：
 *   · 业务上就是"先冲最早该收的那笔"，人工勾选只会引入不一致；
 *   · 但**必须落明细**——只记总额的话，对账时回答不了"这笔坏账冲的是哪几笔"。
 *
 * 规则：
 *   · 只取未收余额 > 0 的条目（已核销的不能再被坏账冲）；
 *   · 指定了 billingId 时只看该合同下的条目；
 *   · 总额超过可选未收合计 → 拒绝（不能凭空多冲）。
 */
async function allocateWriteOffItems(
  db: Prisma.TransactionClient,
  matterId: string,
  billingId: string | null,
  total: number
): Promise<{ receivableId: string; amount: number }[]> {
  // 行锁：把同一案（或同一合同）的应收条目锁住，避免并发申报各自都"看起来够"，
  // 合起来却超过未收合计。FOR UPDATE 必须在事务内，故本函数只接受事务客户端。
  const locked = await db.$queryRaw<
    { id: string; amount: string; settledAmount: string; adjustmentAmount: string }[]
  >`
    SELECT id, amount::text AS amount, "settledAmount"::text AS "settledAmount",
           "adjustmentAmount"::text AS "adjustmentAmount"
    FROM "Receivable"
    WHERE "matterId" = ${matterId}
      AND "moneyKind" = 'LAWYER_FEE'
      -- 作废应收不参与：案页 outstanding 与核销路径都把 CANCELLED 剔除，
      -- 这里若算进来就是「超额却放行」（独立复核给出过 100 + 作废200 → available 300 的复现）
      AND "status" <> 'CANCELLED'
      AND (${billingId}::text IS NULL OR "billingId" = ${billingId})
    ORDER BY "dueDate" ASC NULLS LAST, "createdAt" ASC
    FOR UPDATE
  `;

  // 注意：这里**不能**直接 `if (locked.length === 0) return []`。
  // 早返回会让「指定合同下无未收条目」「该案应收已全部结清」两种情况
  // 静默按合同级申报成功（独立复核抓到过），三态判断必须走完。

  // 已被"在途/已批"坏账占用的额度必须扣掉：坏账不改 settledAmount，
  // 若不扣，两笔各 ≤ 未收合计的申报会合起来超额。
  const ids = locked.map((r) => r.id);
  const used = await db.receivableWriteOffItem.groupBy({
    by: ["receivableId"],
    where: { receivableId: { in: ids }, writeOff: { status: { in: ["PENDING", "APPROVED"] } } },
    _sum: { amount: true }
  });
  const usedMap = new Map(used.map((u) => [u.receivableId, Number(u._sum.amount ?? 0)]));

  // 合同级（无明细）的旧数据也要占额度：按总额从可分摊额度里扣
  const legacyAgg = await db.receivableWriteOff.aggregate({
    where: {
      matterId,
      ...(billingId ? { billingId } : {}),
      status: { in: ["PENDING", "APPROVED"] },
      items: { none: {} }
    },
    _sum: { amount: true }
  });
  let legacyLeft = Math.round(Number(legacyAgg._sum.amount ?? 0) * 100) / 100;

  const open = locked
    .map((r) => {
      const raw = Number(r.amount) + Number(r.adjustmentAmount) - Number(r.settledAmount);
      const reserved = (usedMap.get(r.id) ?? 0) + 0;
      return { id: r.id, open: Math.max(0, Math.round((raw - reserved) * 100) / 100) };
    })
    .filter((r) => r.open > 0);

  // 合同级旧坏账优先占用最早到期的条目
  const usable = open.map((r) => {
    if (legacyLeft <= 0) return r;
    const take = Math.min(r.open, legacyLeft);
    legacyLeft = Math.round((legacyLeft - take) * 100) / 100;
    return { id: r.id, open: Math.round((r.open - take) * 100) / 100 };
  }).filter((r) => r.open > 0);

  const available = Math.round(usable.reduce((n, r) => n + r.open, 0) * 100) / 100;

  /**
   * 三种"没有可分摊条目"的情形必须分开（独立复核指出原实现把它们压成同一个静默结果）：
   *
   * ① **该案根本没有应收条目** → 允许按合同级申报（财务常见"先报坏账、后补应收"）；
   * ② **有应收但全部已结清/作废** → **拒绝**。否则已全额收款的案件可登记任意金额坏账，
   *    报表「已批坏账」凭空增加而余额早已钳零，等于让账目说谎；
   * ③ **指定了合同，但该合同下无未收条目** → **拒绝**并提示改按整案申报。
   */
  if (usable.length === 0) {
    const matterLevel = await db.receivable.count({
      where: { matterId, moneyKind: "LAWYER_FEE", status: { not: "CANCELLED" } }
    });
    if (matterLevel === 0) return []; // ① 真的没有应收
    if (billingId) {
      throw new ActionError("该合同下没有未收应收条目，请改按整案申报坏账");
    }
    throw new ActionError("该案应收已全部结清或作废，无需登记坏账");
  }

  if (total > available) {
    throw new ActionError(
      `坏账金额 ${total} 超过该${billingId ? "合同" : "案"}可用未收额度 ${available}（已扣除在途/已批坏账），请先核对金额`
    );
  }

  const items: { receivableId: string; amount: number }[] = [];
  let left = Math.round(total * 100) / 100;
  for (const r of usable) {
    if (left <= 0) break;
    const take = Math.min(r.open, left);
    items.push({ receivableId: r.id, amount: Math.round(take * 100) / 100 });
    left = Math.round((left - take) * 100) / 100;
  }
  return items;
}

/** 申报坏账（进入 PENDING，不扣减任何金额；但会落逐笔冲抵明细） */
export async function requestWriteOff(input: z.input<typeof requestSchema>) {
  const session = await requireSession("finance.write");
  const data = parseInput(requestSchema, input);
  await assertMatterWritable(data.matterId, { allowFinanceRole: true });

  const billingId = data.billingId?.trim() || null;
  // 归一成两位小数：校验、分摊、落库、审计必须用同一个数，
  // 否则会出现「明细合计 1.00、坏账 1.01」这种跨表不一致。
  const total = Math.round(data.amount * 100) / 100;

  // 分摊与写入必须在**同一事务**里，且分摊时已对条目加行锁（见 allocateWriteOffItems）。
  // 否则并发两笔各自"看起来够"，合起来超额，且明细与总额会不一致。
  const { created, items } = await roleMutation(
    session.user,
    "finance.write",
    async (db) => {
      const allocated = await allocateWriteOffItems(db, data.matterId, billingId, total);
      const row = await db.receivableWriteOff.create({
        data: {
          matterId: data.matterId,
          billingId,
          amount: new Prisma.Decimal(total),
          reason: data.reason,
          note: data.note || null,
          requestedById: session.user.id,
          items: {
            create: allocated.map((i) => ({ receivableId: i.receivableId, amount: new Prisma.Decimal(i.amount) }))
          }
        },
        select: { id: true }
      });
      return { created: row, items: allocated };
    },
    { atomic: true }
  );

  await audit({
    userId: session.user.id,
    action: "WRITE_OFF_REQUEST",
    targetType: "ReceivableWriteOff",
    targetId: created.id,
    detail: {
      matterId: data.matterId,
      amount: total,
      reason: data.reason,
      // 逐笔冲抵明细进审计：事后核对「这笔坏账冲了哪几笔」不必再查库
      items: items.map((i) => ({ receivableId: i.receivableId, amount: i.amount }))
    }
  });
  revalidatePath(`/matters`);
  return { ok: true as const, id: created.id };
}

const decideSchema = z.object({
  id: z.string().trim().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  rejectReason: z.string().trim().max(200).optional().or(z.literal(""))
});

/** 批准/驳回（需 finance.correct，且不得自批） */
export async function decideWriteOff(input: z.input<typeof decideSchema>) {
  const session = await requireSession("finance.correct");
  // 用项目既有的「独立财务执行资格」判定（内置财务 或 自定义角色显式授 ALL），
  // 不自己写一套——系统身份与管理权不参与授权，这条口径已经踩过坑。
  if (!canExecuteFinance(session.user as never, "finance.correct")) {
    throw new ActionError("坏账批准需财务更正权限（全所范围）");
  }
  const data = parseInput(decideSchema, input);

  const current = await prisma.receivableWriteOff.findUnique({
    where: { id: data.id },
    select: { id: true, matterId: true, status: true, amount: true, requestedById: true }
  });
  if (!current) throw new ActionError("坏账记录不存在");
  if (current.status !== "PENDING") throw new ActionError("该坏账已处理，不能重复审批");
  // 归档案件不再产生新的财务处置（写守卫审计指出此处缺失，补上）：
  // 案件归档意味着“账已收尾”，此时批准一笔坏账会改动一个已封存的口径。
  await assertMatterWritable(current.matterId, { allowFinanceRole: true });
  // 自批会让"两个人分开"的设计失效
  if (current.requestedById === session.user.id) {
    throw new ActionError("不能批准自己申报的坏账，请由他人复核");
  }
  if (data.decision === "REJECTED" && !data.rejectReason?.trim()) {
    throw new ActionError("驳回须填写理由");
  }

  await prisma.receivableWriteOff.update({
    where: { id: current.id },
    data: {
      status: data.decision,
      decidedById: session.user.id,
      decidedAt: new Date(),
      rejectReason: data.decision === "REJECTED" ? data.rejectReason!.trim() : null
    }
  });
  await audit({
    userId: session.user.id,
    action: data.decision === "APPROVED" ? "WRITE_OFF_APPROVE" : "WRITE_OFF_REJECT",
    targetType: "ReceivableWriteOff",
    targetId: current.id,
    detail: {
      matterId: current.matterId,
      amount: Number(current.amount),
      rejectReason: data.decision === "REJECTED" ? data.rejectReason : undefined
    }
  });
  revalidatePath(`/matters`);
  return { ok: true as const };
}

/** 某案的坏账列表（含三种状态，供界面展示与审批） */
export async function listWriteOffs(matterId: string) {
  await requireSession("finance.read");
  const id = String(matterId ?? "").trim();
  if (!id) throw new ActionError("缺少案件标识");

  const rows = await prisma.receivableWriteOff.findMany({
    where: { matterId: id },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 100,
    select: {
      id: true, amount: true, reason: true, status: true, note: true,
      createdAt: true, decidedAt: true, rejectReason: true,
      requestedBy: { select: { id: true, name: true } },
      decidedBy: { select: { id: true, name: true } },
      billing: { select: { id: true, title: true } },
      // 逐笔冲抵明细（2026-11-22）：让界面能回答「这笔坏账冲了哪几笔应收」
      items: {
        select: {
          id: true, amount: true,
          receivable: { select: { id: true, title: true } }
        }
      }
    }
  });
  return rows.map((r) => ({
    ...r,
    amount: Number(r.amount),
    items: r.items.map((i) => ({ id: i.id, receivableId: i.receivable.id, receivableTitle: i.receivable.title, amount: Number(i.amount) }))
  }));
}

export type WriteOffRow = Awaited<ReturnType<typeof listWriteOffs>>[number];
