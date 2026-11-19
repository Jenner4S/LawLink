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

    if (res.valid !== false && !res.brokenAt) {
      record("audit-chain", "审计链哈希连续", [], res.total !== undefined ? `共 ${res.total} 条` : undefined);
    } else {
      const broken = res.brokenAt as { id?: string; action?: string } | undefined;
      // ChainVerifyResult.firstBroken 只带 {id, action, reason}，没有时间；
      // 分类需要 createdAt，直接按 id 查一次（只查一行，代价可忽略）。
      const brokenRow = broken?.id
        ? await prisma.auditLog.findUnique({ where: { id: broken.id }, select: { createdAt: true } })
        : null;
      const at = brokenRow?.createdAt ?? null;
      const isLegacy = at !== null && at < LEGACY_FIX_AT;
      const desc = `brokenAt id=${broken?.id ?? "?"} action=${broken?.action ?? "?"} createdAt=${at ? at.toISOString() : "?"} reason=${res.reason ?? "?"}`;

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
        record("audit-chain", "审计链哈希连续", [desc], res.total !== undefined ? `共 ${res.total} 条` : undefined);
      }
    }
  }

  // ── 4. 至少一个可用 SUPER_ADMIN ──────────────────────────
  // 没有可用超管时全所进不了管理后台，而且没有任何自助恢复路径。
  {
    const n = await prisma.user.count({ where: { systemRole: "SUPER_ADMIN", active: true } });
    record("super-admin", "至少一个在职的超级管理员", n === 0 ? ["active SUPER_ADMIN = 0"] : []);
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
