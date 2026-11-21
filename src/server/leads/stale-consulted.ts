/**
 * 已谈案但迟迟没转收案的线索（2026-11-23）
 *
 * ## 为什么值得单列
 *
 * 漏斗里「已谈案」是一个**中间态**：谈完不等于签下。
 * 真实的漏损就发生在这一段——谈完当场没签，回头忙起来就忘了，
 * 三个月后线索还挂在"已谈案"，谁也不记得当时谈成了什么。
 *
 * 提醒链只管"邀约到店"之前（1/3/7 天追问），**谈案之后没有任何机制**。
 * 这一块补上：把谈了超过 N 天还没转收案的列出来，按等待天数从长到短。
 *
 * ## 口径（三条）
 *
 * ① 只看 `stage = CONSULTED` 且**未转收案**（`convertedIntakeId` 为空）；
 * ② **判定**看 `updatedAt`（最后动静超 N 天）；**展示天数**按 `consultedAt` 算
 *    （"谈案后等了多久"比"最后改动多久"更有管理意义），缺则该用 `updatedAt`；
 * ③ 只列等待 **≥ days** 天的（默认 3 天：当天谈完当天转是正常节奏，不必催）。
 *
 * 纯读，不改任何线索状态。
 */
import { prisma } from "@/lib/prisma";

export type StaleConsulted = {
  id: string;
  name: string;
  phone: string | null;
  /** 谈案距今等待天数（向下取整） */
  waitingDays: number;
  /** 起算时间（consultedAt 或 updatedAt） */
  since: Date;
};

export async function getStaleConsultedLeads(days = 3, now = new Date()): Promise<StaleConsulted[]> {
  const cutoff = new Date(now.getTime() - days * 86_400_000);

  const rows = await prisma.lead.findMany({
    where: {
      stage: "CONSULTED",
      convertedIntakeId: null,
      // 以 **updatedAt（最后动静）** 判定，而不是 consultedAt。
      //
      // 第一版写成 `OR consultedAt <= cutoff`，结果是：只要线索有谈案时间，
      // 无论后来跟进过多少次都**永远命中**——催办后也不会从清单消失
      // （测试直接抓到了这一点）。"谈案后谈完就没动静"的真实含义是
      // "最后一次改动距今超过 N 天"。
      updatedAt: { lte: cutoff }
    },
    select: { id: true, name: true, phone: true, consultedAt: true, updatedAt: true },
    orderBy: [{ consultedAt: "asc" }, { updatedAt: "asc" }],
    take: 50
  });

  return rows
    .map((r) => {
      const since = r.consultedAt ?? r.updatedAt;
      const waitingDays = Math.floor((now.getTime() - since.getTime()) / 86_400_000);
      return { id: r.id, name: r.name, phone: r.phone, waitingDays, since };
    })
    .sort((a, b) => b.waitingDays - a.waitingDays);
}
