/**
 * 数据库不变量检查（2026-11-21）
 *
 * ## 这个脚本补的是哪一块
 *
 * 单测覆盖的是「代码路径」，Docker 构建覆盖的是「能打包」，
 * 83 项 UI 巡检覆盖的是「页面能打开」。**三者都通过，仍然可能有问题** ——
 * 因为它们都不检查「库里现存的数据是否还满足代码依赖的那些前提」。
 *
 * 备份恢复之后尤其如此：表一样、行数一样、内容摘要一样，
 * 但应用可能因为某条不变量被破坏而在运行时出错。
 *
 * ## 查什么
 *
 * 只查「数据库约束表达不了、但代码默默依赖」的规则 ——
 * 这些正是本项目 2026-11 这一批并发/一致性修复所围绕的东西：
 *
 *   1. 文档族恰好一条 isLatest（Round 124：曾因非原子切换导致整族丢失）
 *   2. PENDING 提醒台账不指向已删除/已解除对象（Round 125/130）
 *   3. 审计链哈希连续（篡改/截断可发现）
 *   4. 至少一个可用的 SUPER_ADMIN（否则全所无法进入管理后台）
 *   5. 借阅单：APPROVED 且未到期必须有有效归档记录
 *   6. 外键孤儿（数据库约束本应保证；这里作为「恢复是否完整」的独立佐证）
 *
 * ## 用法
 *
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-db-invariants.ts
 *   DATABASE_URL=postgresql://... npx tsx scripts/verify-db-invariants.ts --json
 *
 * 退出码：0 = 全部通过；1 = 有违规项（逐条列出）。只读，不写库。
 */
import { PrismaClient } from "@prisma/client";
import { verifyAuditChain } from "../src/lib/audit-chain";

const prisma = new PrismaClient();
const AS_JSON = process.argv.includes("--json");

type Finding = {
  id: string;
  title: string;
  violations: number;
  samples: string[];
  note?: string;
};

const findings: Finding[] = [];

function record(id: string, title: string, samples: string[], note?: string) {
  findings.push({ id, title, violations: samples.length, samples: samples.slice(0, 5), note });
}

async function main() {
  // ── 1. 文档族恰好一条 isLatest ────────────────────────────
  // 只算未软删的文档；familyId 为空的独立文档不参与（它们各自是"一族"）。
  {
    const rows = await prisma.$queryRaw<{ familyId: string; n: bigint }[]>`
      SELECT "familyId", count(*) FILTER (WHERE "isLatest") AS n
      FROM "Document"
      WHERE "familyId" IS NOT NULL AND "deletedAt" IS NULL
      GROUP BY "familyId"
      HAVING count(*) FILTER (WHERE "isLatest") <> 1
    `;
    record(
      "doc-family-latest",
      "每个文档族恰好一条 isLatest=true",
      rows.map((r) => `familyId=${r.familyId} latest=${r.n}`),
      "0 条或 2 条以上都意味着该材料在列表/导出里会出现丢失或重复"
    );
  }

  // ── 2. PENDING 提醒不指向已消失的对象 ────────────────────
  // 保全财产被删除/解除后仍有 PENDING 行 → 投递器会为一个不存在的对象发提醒。
  // （投递前复核会兜住，但这说明作废链路漏了，值得报出来。）
  {
    const rows = await prisma.$queryRaw<{ id: string; objectId: string; reason: string }[]>`
      SELECT d.id, d."objectId", 'object-missing' AS reason
      FROM reminder_delivery d
      WHERE d.status = 'PENDING' AND d."objectType" = 'PRESERVATION_PROPERTY'
        AND NOT EXISTS (SELECT 1 FROM "PreservationProperty" p WHERE p.id = d."objectId")
      UNION ALL
      SELECT d.id, d."objectId", 'object-lifted'
      FROM reminder_delivery d
      JOIN "PreservationProperty" p ON p.id = d."objectId"
      WHERE d.status = 'PENDING' AND d."objectType" = 'PRESERVATION_PROPERTY'
        AND p.status = 'LIFTED'
    `;
    record(
      "reminder-orphan",
      "PENDING 提醒不指向已删除/已解除的保全财产",
      rows.map((r) => `${r.id} objectId=${r.objectId} ${r.reason}`)
    );
  }

  // ── 3. 审计链哈希连续 ────────────────────────────────────
  // 这一项是「数据是否被篡改/截断」的唯一独立证据，恢复后必须仍然成立。
  //
  // 但必须区分两类断点：
  //   · **历史遗留**：2026-11-19 13:32 之前写入的记录，哈希是用旧的 stableJson
  //     算的（那时没跳过 undefined 值，`{"dueAt":}` 落库后键被 JSONB 丢掉，
  //     读回重算必然不等）。这类断点是已知的、有据可查的，不是篡改。
  //     修复合入后写入的记录不会再有这个问题。
  //   · **真破坏**：修复时刻之后仍有断点 → 数据被改过，必须当事故。
  //
  // 硬编码这个时刻是有意的：它对应提交 5f0599e，写死在代码里比"读环境变量"
  // 更难被悄悄改掉。真要调整请连同这条注释一起改。
  {
    const LEGACY_FIX_AT = new Date("2026-11-19T13:32:12+08:00");
    const res = await verifyAuditChain(prisma);

    if (res.ok && !res.brokenAt) {
      record("audit-chain", "审计链哈希连续", [], `共 ${res.checked} 条${res.skippedLegacy ? `，另有 ${res.skippedLegacy} 条前置字段历史记录未参与校验` : ""}`);
    } else {
      const broken = res.brokenAt; // { id, action, reason }
      // ChainVerifyResult.firstBroken 只带 {id, action, reason}，没有时间；
      // 分类需要 createdAt，直接按 id 查一次（只查一行，代价可忽略）。
      const brokenRow = broken?.id
        ? await prisma.auditLog.findUnique({ where: { id: broken.id }, select: { createdAt: true } })
        : null;
      const at = brokenRow?.createdAt ?? null;
      const isLegacy = at !== null && at < LEGACY_FIX_AT;
      const desc = `brokenAt id=${broken?.id ?? "?"} action=${broken?.action ?? "?"} createdAt=${at ? at.toISOString() : "?"} reason=${broken?.reason ?? "?"}`;

      if (isLegacy) {
        // 用 note 记录、不计入 violations —— 但**必须显示**，不能悄悄放过
        findings.push({
          id: "audit-chain-legacy",
          title: "审计链有历史遗留断点（旧序列化，非篡改）",
          violations: 0,
          samples: [desc],
          note: `该记录早于 2026-11-19 13:32 的 stableJson 修复；修复后写入的记录不受影响。`
        });
      } else {
        record("audit-chain", "审计链哈希连续", [desc], `已校验 ${res.checked} 条，跳过历史 ${res.skippedLegacy} 条`);
      }
    }
  }

  // ── 4. 至少一个可用 SUPER_ADMIN ──────────────────────────
  // 没有可用超管时全所进不了管理后台，而且没有任何自助恢复路径。
  //
  // 但要区分「空库」：`migrate deploy` 刚跑完、还没 `db seed` 的库，
  // User 表本来就是空的 —— 那不是违规，是「还没初始化」。
  // 已在用的库（有用户但没有在职超管）才是真问题。
  {
    const totalUsers = await prisma.user.count();
    if (totalUsers === 0) {
      findings.push({
        id: "super-admin",
        title: "至少一个在职的超级管理员",
        violations: 0,
        samples: [],
        note: "库中无任何用户（空库，尚未 db seed），本项不适用"
      });
    } else {
      const n = await prisma.user.count({ where: { systemRole: "SUPER_ADMIN", active: true } });
      record(
        "super-admin",
        "至少一个在职的超级管理员",
        n === 0 ? [`共 ${totalUsers} 个用户，但 active SUPER_ADMIN = 0`] : []
      );
    }
  }

  // ── 5. 借阅单：生效中必须有有效归档记录 ──────────────────
  {
    // 表名以 @@map 为准：archive_borrow_request（模型名不是表名）
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT b.id
      FROM archive_borrow_request b
      WHERE b.status = 'APPROVED'
        AND (b."accessUntil" IS NULL OR b."accessUntil" >= now())
        AND NOT EXISTS (SELECT 1 FROM "ArchiveRecord" r WHERE r.id = b."archiveRecordId")
    `;
    record("borrow-grant", "生效中的借阅单必须有对应归档记录", rows.map((r) => `borrowId=${r.id}`));
  }

  // ── 11. 金额链路：实收必须与来源流水一致 ─────────────────
  // 规则同样来自代码而不是我编的：`assertPaymentSource` 每次分配前都校验
  //   matterId 相同 / type=RECEIVED / confirmState=CONFIRMED /
  //   amount 相等 / moneyKind 相同
  // 任一不符就抛「实收与已确认来源流水不一致，不能分配」。
  //
  // 为什么全库查有意义：这笔一致性是「钱」与「凭证」的对应关系。
  // 若实收金额与它声称的来源流水不等，等于系统里凭空记了一笔钱（或多记少记），
  // 而这条只在下一次分配时才被发现 —— 不分配就永远发现不了。
  {
    const rows = await prisma.$queryRaw<
      { code: string; issues: string }[]
    >`
      SELECT m."internalCode" AS code,
             concat_ws(' / ',
               CASE WHEN f."matterId" <> p."matterId" THEN '案件不一致' END,
               CASE WHEN f.type <> 'RECEIVED' THEN '来源非实收' END,
               CASE WHEN f."confirmState" <> 'CONFIRMED' THEN '来源未确认' END,
               CASE WHEN f.amount <> p.amount THEN '金额不一致' END,
               CASE WHEN f."moneyKind" <> p."moneyKind" THEN '款项性质不一致' END
             ) AS issues
      FROM "Payment" p
      JOIN "FeeEntry" f ON f.id = p."feeEntryId"
      JOIN "Matter" m ON m.id = p."matterId"
      WHERE m."deletedAt" IS NULL
        AND (f."matterId" <> p."matterId"
          OR f.type <> 'RECEIVED'
          OR f."confirmState" <> 'CONFIRMED'
          OR f.amount <> p.amount
          OR f."moneyKind" <> p."moneyKind")
      LIMIT 20`;
    record(
      "payment-source-consistent",
      "实收与其来源流水一致（案件/类型/确认态/金额/性质）",
      rows.map((r) => `${r.code}：${r.issues}`)
    );
  }

  // ── 12. 金额链路：发票已关联金额不得超额 ─────────────────
  // 规则出自 `ledger-mutations.ts` 的写入断言：
  //   if (value > invoice.amount - adjusted - used) throw "分配金额超过发票未关联金额"
  // 其中 used = SUM(InvoicePaymentAllocation.amount - reversedAmount)，
  // adjusted = SUM(InvoiceAdjustment.amount)（红冲/作废/换开的调整合计）。
  // 这是**上界**而非等式：票款关联是部分可选的，不要求全额关联。
  // 但超过上界就意味着系统在一条发票上挂出了比它面额更多的收款，
  // 对账时会出现「这张票收了两遍」的假象。
  {
    const rows = await prisma.$queryRaw<{ no: string; invoice: string; linked: string; capacity: string }[]>`
      SELECT i."invoiceNo" AS no,
             i.amount::text AS invoice,
             COALESCE((SELECT SUM(a.amount - a."reversedAmount") FROM "InvoicePaymentAllocation" a
                       WHERE a."invoiceId" = i.id), 0)::text AS linked,
             (i.amount - COALESCE((SELECT SUM(adj.amount) FROM "InvoiceAdjustment" adj
                       WHERE adj."invoiceId" = i.id), 0))::text AS capacity
      FROM "InvoiceRequest" i
      WHERE i."invoiceNo" IS NOT NULL
        AND COALESCE((SELECT SUM(a.amount - a."reversedAmount") FROM "InvoicePaymentAllocation" a
                      WHERE a."invoiceId" = i.id), 0)
          > (i.amount - COALESCE((SELECT SUM(adj.amount) FROM "InvoiceAdjustment" adj
                      WHERE adj."invoiceId" = i.id), 0))
      LIMIT 20`;
    record(
      "invoice-linked-capacity",
      "发票已关联金额不超过发票可关联额度",
      rows.map((r) => `${r.no}：已关联 ${r.linked}，可关联 ${r.capacity}（面额 ${r.invoice}）`)
    );
  }

  // ── 13. 金额链路：实收已关联票据不得超额 ─────────────────
  // 同源断言：
  //   if (amount > payment.amount - payment.refundedAmount - linked) throw "分配合计超过实收可关联票据余额"
  // 超过就意味着同一笔钱被挂到了比它本身更多的发票上。
  {
    const rows = await prisma.$queryRaw<{ code: string; amount: string; refunded: string; linked: string }[]>`
      SELECT m."internalCode" AS code,
             p.amount::text AS amount,
             p."refundedAmount"::text AS refunded,
             COALESCE((SELECT SUM(a.amount - a."reversedAmount") FROM "InvoicePaymentAllocation" a
                       WHERE a."paymentId" = p.id), 0)::text AS linked
      FROM "Payment" p
      JOIN "Matter" m ON m.id = p."matterId"
      WHERE m."deletedAt" IS NULL
        AND COALESCE((SELECT SUM(a.amount - a."reversedAmount") FROM "InvoicePaymentAllocation" a
                      WHERE a."paymentId" = p.id), 0)
          > (p.amount - p."refundedAmount")
      LIMIT 20`;
    record(
      "payment-invoice-linked-capacity",
      "实收已关联票据金额不超过实收可关联额度",
      rows.map((r) => `${r.code}：已关联 ${r.linked}，可关联 ${(Number(r.amount) - Number(r.refunded)).toFixed(2)}`)
    );
  }

  // ── 9. 金额链路：应收余额与核销明细一致 ──────────────────
  // 规则来源**不是我自己想的**：`ledger-mutations.ts` 在每次核销前就有
  //   SELECT COALESCE(SUM(amount-"reversedAmount"),0) FROM "Allocation" WHERE "receivableId"=…
  //   if (!linked.amount.eq(ar.settledAmount)) throw "应收核销明细与余额不符，请先核对"
  // 也就是说这是**写入时已强制的规则**，这里只是把它从「单笔写入前」升级为
  // 「全库随时可查」。
  //
  // 为什么要升级：`settledAmount` 是冗余汇总字段（明细在 Allocation），
  // 冗余汇总与明细漂移是最经典的一类脏数据；一旦漂移，界面上的未收余额是错的，
  // 律师会去追一笔其实已经收到的钱，或者漏收。而写入时的断言只在那一次写入时生效，
  // 拦不住历史脏账与绕过写入的改动（代码注释里就提到过「某笔实收存在历史脏账」）。
  {
    const rows = await prisma.$queryRaw<
      { title: string; matter: string; settled: string; linked: string }[]
    >`
      SELECT r.title, m."internalCode" AS matter,
             r."settledAmount"::text AS settled,
             COALESCE(SUM(a.amount - a."reversedAmount"), 0)::text AS linked
      FROM "Receivable" r
      JOIN "Matter" m ON m.id = r."matterId"
      LEFT JOIN "Allocation" a ON a."receivableId" = r.id
      WHERE m."deletedAt" IS NULL
      GROUP BY r.id, r.title, r."settledAmount", m."internalCode"
      HAVING r."settledAmount" <> COALESCE(SUM(a.amount - a."reversedAmount"), 0)
      LIMIT 20`;
    record(
      "receivable-settled-total",
      "应收已核销额与核销明细合计一致",
      rows.map((r) => `${r.matter} / ${r.title}：账面 ${r.settled}，明细合计 ${r.linked}`)
    );
  }

  // ── 10. 金额链路：实收已分配合计与明细一致 ───────────────
  // 同源规则：`assertAllocationTotals`
  //   SELECT amount-"reversedAmount" FROM "Allocation" WHERE "paymentId"=…
  //   if (!total(...).eq(payment.allocatedAmount)) throw "实收核销明细与余额不符，请先核对"
  {
    const rows = await prisma.$queryRaw<
      { matter: string; allocated: string; linked: string }[]
    >`
      SELECT m."internalCode" AS matter,
             p."allocatedAmount"::text AS allocated,
             COALESCE(SUM(a.amount - a."reversedAmount"), 0)::text AS linked
      FROM "Payment" p
      JOIN "Matter" m ON m.id = p."matterId"
      LEFT JOIN "Allocation" a ON a."paymentId" = p.id
      WHERE m."deletedAt" IS NULL
      GROUP BY p.id, p."allocatedAmount", m."internalCode"
      HAVING p."allocatedAmount" <> COALESCE(SUM(a.amount - a."reversedAmount"), 0)
      LIMIT 20`;
    record(
      "payment-allocated-total",
      "实收已分配合计与核销明细一致",
      rows.map((r) => `${r.matter}：账面 ${r.allocated}，明细合计 ${r.linked}`)
    );
  }

  // ── 7. 跨表状态一致：结案案件不得有未办结事项 ────────────
  // closeMatter 已用 closureReady 门禁拦截；这里守的是**绕过门禁**的情形
  //（直接改库、未来新增的写入路径、迁移脚本）。「A 表说结完了、B 表说还有活」
  // 是律师最容易在庭上被问住的一类矛盾，单表校验发现不了。
  {
    const rows = await prisma.$queryRaw<{ id: string; internalCode: string; detail: string }[]>`
      SELECT m.id, m."internalCode",
             concat_ws(' / ',
               CASE WHEN EXISTS (SELECT 1 FROM "Task" t WHERE t."matterId"=m.id AND t.completed=false)
                    THEN '未办结任务' END,
               CASE WHEN EXISTS (SELECT 1 FROM "Deadline" d JOIN "MatterProcedure" p ON p.id=d."procedureId"
                                 WHERE p."matterId"=m.id AND d.completed=false)
                    THEN '未办结期限' END,
               CASE WHEN EXISTS (SELECT 1 FROM "Hearing" h JOIN "MatterProcedure" p2 ON p2.id=h."procedureId"
                                 WHERE p2."matterId"=m.id AND h."startsAt" > now())
                    THEN '未来开庭' END) AS detail
      FROM "Matter" m
      WHERE m.status = 'CLOSED' AND m."deletedAt" IS NULL
        AND (EXISTS (SELECT 1 FROM "Task" t WHERE t."matterId"=m.id AND t.completed=false)
          OR EXISTS (SELECT 1 FROM "Deadline" d JOIN "MatterProcedure" p ON p.id=d."procedureId"
                     WHERE p."matterId"=m.id AND d.completed=false)
          OR EXISTS (SELECT 1 FROM "Hearing" h JOIN "MatterProcedure" p2 ON p2.id=h."procedureId"
                     WHERE p2."matterId"=m.id AND h."startsAt" > now()))
      LIMIT 20`;
    record(
      "closed-matter-open-work",
      "结案案件无未办结事项",
      rows.map((r) => `${r.internalCode}（${r.detail}）`)
    );
  }

  // ── 8. 跨表状态一致：归档记录与案件状态同步 ──────────────
  // approveArchiveRecord 在同一事务里同时置 record=APPROVED 与 matter=ARCHIVED，
  // 所以两个方向都必须成立。任一方向不一致都说明有路径只改了一半。
  //
  // 未纳入（如实记）："程序 CONCLUDED 但环节仍 ACTIVE" —— 曾想加，核对后确认
  // 程序是按「填写结案时间」置为 CONCLUDED 的，环节状态是独立字段，
  // ACTIVE 属正常，加了就是假阳性。不验证过的规则不进不变量。
  {
    const approvedNotArchived = await prisma.$queryRaw<{ archiveNo: string; internalCode: string; status: string }[]>`
      SELECT a."archiveNo", m."internalCode", m.status::text AS status
      FROM "ArchiveRecord" a JOIN "Matter" m ON m.id = a."matterId"
      WHERE a.status = 'APPROVED' AND m.status <> 'ARCHIVED' AND m."deletedAt" IS NULL
      LIMIT 20`;
    const archivedWithoutRecord = await prisma.$queryRaw<{ internalCode: string }[]>`
      SELECT m."internalCode"
      FROM "Matter" m
      WHERE m.status = 'ARCHIVED' AND m."deletedAt" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "ArchiveRecord" a WHERE a."matterId" = m.id AND a.status = 'APPROVED')
      LIMIT 20`;
    record(
      "archive-status-sync",
      "归档记录与案件状态同步",
      [
        ...approvedNotArchived.map((r) => `${r.archiveNo}: 记录已批准但案件状态=${r.status}`),
        ...archivedWithoutRecord.map((r) => `${r.internalCode}: 案件已归档但无已批准归档记录`)
      ]
    );
  }

  // ── 6. 外键孤儿（恢复完整性佐证）─────────────────────────
  // 数据库约束本应保证；若恢复不完整（比如某张表漏了），这里会暴露。
  {
    const probes: { name: string; sql: string }[] = [
      { name: "Document.familyId", sql: `SELECT id FROM "Document" d WHERE d."familyId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Document" f WHERE f.id = d."familyId")` },
      { name: "ReminderDelivery.objectId(PreservationProperty)", sql: `SELECT d.id FROM reminder_delivery d WHERE d."objectType"='PRESERVATION_PROPERTY' AND NOT EXISTS (SELECT 1 FROM "PreservationProperty" p WHERE p.id=d."objectId")` },
      { name: "ArchiveBorrowRequest.applicantId", sql: `SELECT b.id FROM archive_borrow_request b WHERE NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id=b."applicantId")` },
      { name: "AuditLog.userId", sql: `SELECT a.id FROM "AuditLog" a WHERE a."userId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u.id=a."userId")` }
    ];
    const samples: string[] = [];
    for (const p of probes) {
      const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(p.sql);
      for (const r of rows.slice(0, 2)) samples.push(`${p.name}: ${r.id}`);
    }
    record("fk-orphans", "关键外键无孤儿引用", samples);
  }

  // ── 输出 ────────────────────────────────────────────────
  const failed = findings.filter((f) => f.violations > 0);

  if (AS_JSON) {
    console.log(JSON.stringify({ ok: failed.length === 0, findings }, null, 2));
  } else {
    console.log("=== 数据库不变量检查 ===");
    console.log(`连接: ${(process.env.DATABASE_URL ?? "").replace(/:[^:@]*@/, ":***@")}`);
    console.log("");
    for (const f of findings) {
      if (f.violations === 0) {
        const mark = f.id.endsWith("-legacy") ? "⚠️ " : "✅";
        console.log(`  ${mark} ${f.title}${f.note ? `（${f.note}）` : ""}`);
        for (const s of f.samples) console.log(`       ${s}`);
      } else {
        console.log(`  ❌ ${f.title} —— ${f.violations} 处违规${f.note ? `（${f.note}）` : ""}`);
        for (const s of f.samples) console.log(`       ${s}`);
      }
    }
    console.log("");
    console.log(
      failed.length === 0
        ? "=== 全部通过 ==="
        : `=== 有 ${failed.length} 类不变量被破坏（见上）===`
    );
  }

  await prisma.$disconnect();
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async (e) => {
  // 脚本自身出错（SQL 写错、表名不对）与「数据违规」是两件事，
  // 退出码也分开：2 = 没查成，1 = 查出了问题。混在一起会让人误判。
  console.error("检查脚本自身失败（不是数据问题）：", e instanceof Error ? e.message : e);
  await prisma.$disconnect();
  process.exit(2);
});
