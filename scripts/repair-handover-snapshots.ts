/**
 * 一次性修复（2026-09-20）：早期演示种子为交接行写入过占位快照 {"note":"演示"}，
 * 日程页「事项责任与交接」面板按 work/procedures/urgent 数组渲染导致 500。
 * 本脚本为缺字段的行重算真实快照与指纹；快照完好的行不动，可重复执行。
 */
import { PrismaClient } from '@prisma/client';
import { handoverSnapshot } from '../src/server/matters/handover';
import { intakeHandoverSnapshot } from '../src/server/intakes/handover';
import { fingerprint } from '../src/server/intakes/workflow';

const db = new PrismaClient();

const DRY_RUN = !process.argv.includes("--yes");
if (!process.argv.includes("--yes") && !process.argv.includes("--dry-run")) {
  console.log("（未指定 --yes，按 dry-run 处理；确认无误后加 --yes 真正写入）\n");
}

async function main() {
  // 2026-11-20：加防护 + 包事务。
  // 防护：快照与指纹是归档交接的审计依据，误跑会冲掉历史快照。
  // 事务：原实现逐条 UPDATE 且无事务 —— 中途失败会留下「前几条已修、后几条未修」
  //       的半修状态，而调用方无从判断进度。现在整批要么全成要么全不成。
  const target = (process.env.DATABASE_URL ?? "").replace(/:[^:@]*@/, ":***@");
  console.log(`目标库：${target || "（未设置 DATABASE_URL）"}`);
  console.log(DRY_RUN ? "模式：DRY-RUN（不写库）\n" : "模式：写入\n");

  if (DRY_RUN) {
    // DRY_RUN 时 collect 里的两处 UPDATE 都被 if (!DRY_RUN) 挡掉，
    // 只打印会修哪些行 —— 2026-11-20 首版实现漏了这个守卫，
    // dry-run 仍会真写库（当时主库恰好 0 待修行所以没暴露）。
    await collect();
    return;
  }
  await db.$transaction(async (tx) => { await collect(tx); }, { timeout: 120_000 });
}

async function collect(tx?: { $queryRaw: typeof db.$queryRaw; $executeRaw: typeof db.$executeRaw }) {
  const q = tx ?? db;
  const matters = await q.$queryRaw<{ id: string; matterId: string; status: string }[]>`
    SELECT id, "matterId", status::text FROM "MatterHandover"
    WHERE NOT (snapshot ? 'work' AND snapshot ? 'procedures')`;
  for (const h of matters) {
    const snap = await handoverSnapshot(db, h.matterId);
    if (!DRY_RUN) await q.$executeRaw`UPDATE "MatterHandover" SET snapshot=${JSON.parse(JSON.stringify(snap.snapshot))}::jsonb, fingerprint=${snap.fingerprint} WHERE id=${h.id}`;
    console.log(`repaired MatterHandover ${h.id} (${h.status})`);
  }
  const intakes = await q.$queryRaw<{ id: string; intakeId: string }[]>`
    SELECT id, "intakeId" FROM "IntakeHandover"
    WHERE NOT (snapshot ? 'urgent' AND snapshot ? 'intake')`;
  for (const i of intakes) {
    const snap = await intakeHandoverSnapshot(db, i.intakeId);
    const normalized = JSON.parse(JSON.stringify(snap));
    if (!DRY_RUN) await q.$executeRaw`UPDATE "IntakeHandover" SET snapshot=${normalized}::jsonb, fingerprint=${fingerprint(snap)} WHERE id=${i.id}`;
    console.log(`repaired IntakeHandover ${i.id}`);
  }
  console.log(`done: ${matters.length} matter + ${intakes.length} intake rows`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
