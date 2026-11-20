/**
 * 报表与坏账口径对齐（2026-11-22，P0-5 收尾）
 *
 * ## 这一段解决什么
 *
 * 案件页已经扣了坏账（`stats.outstandingNet`），但报表原本没扣 ——
 * **两个数不一致**是财务上最容易失去信任的一类问题：
 * 律师在案件页看到待收 7000，在报表里看到 10000，然后开始怀疑系统。
 *
 * ## 三条口径
 *
 * ① **只算 APPROVED**（与案件页同源；PENDING 是申报，不是事实）
 * ② **只扣 balance，不动 receivable**（应收是历史事实，坏账是对事实的处置）
 * ③ **余额钳到 0**（坏账超收时不出现负数应收——那会让"多收了钱"的假象）
 *
 * ## 为什么单独成模块
 *
 * 报表函数体很大且依赖账本表（应收来自 ledger 而非 billing），
 * 走全链路测「扣减」成本高、易测错分支。抽成纯函数后可以直接用真库测这一步。
 */

import { prisma } from "@/lib/prisma";

export type ClientBalanceRow = {
  clientId: string;
  /** 已批准坏账合计 */
  writeOff: number;
  balance: number;
};

/**
 * 就地把已批准坏账计入每行客户余额。返回同一个数组（便于链式使用）。
 * 只影响传入的行；找不到对应客户的行不受影响。
 */
export async function applyApprovedWriteOffs<T extends ClientBalanceRow>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;

  const writeOffs = await prisma.receivableWriteOff.findMany({
    where: { status: "APPROVED" },
    select: { amount: true, matter: { select: { primaryClientId: true } } }
  });

  const byClient = new Map<string, number>();
  for (const w of writeOffs) {
    const clientId = w.matter.primaryClientId;
    if (!clientId) continue;
    byClient.set(clientId, (byClient.get(clientId) ?? 0) + Number(w.amount));
  }

  for (const row of rows) {
    const total = byClient.get(row.clientId) ?? 0;
    row.writeOff = total;
    // 余额钳到 0：坏账超过未收时不出现负数（负数意味着「多收了」，那是另一种错）
    row.balance = Math.max(0, row.balance - total);
  }
  return rows;
}
