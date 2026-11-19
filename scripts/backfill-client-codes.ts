/**
 * v0.39 一次性回填：给现有 Client 生成 internalCode（KH-{年}-{4位}）。
 * 按 createdAt 顺序、按年分流水；同时把每年计数器写进 SystemSetting，
 * 保证之后 generateClientCode() 接着排，不与回填的号冲突。
 *
 * 运行：
 *   npx tsx scripts/backfill-client-codes.ts --dry-run    # 只看会改什么（推荐先跑这个）
 *   npx tsx scripts/backfill-client-codes.ts --yes        # 真正写入
 *
 * 2026-11-20 加防护：本脚本会 UPDATE Client 并写 SystemSetting 计数器，
 * 此前零防护 —— 误跑一次就直接改数据，且受影响的编号无法简单回退
 * （计数器被推进后，空号不会自己回来）。
 * 现在：默认只预览，必须显式 --yes 才写；任何时候都先打印目标库名，
 * 让人看清自己连的是哪个库。
 */
import { prisma } from "../src/lib/prisma";
import { shParts } from "../src/lib/ui/sh-time";

const DRY_RUN = !process.argv.includes("--yes");
if (!process.argv.includes("--yes") && !process.argv.includes("--dry-run")) {
  console.log("（未指定 --yes，按 dry-run 处理；确认无误后加 --yes 真正写入）\n");
}

async function main() {
  // 2026-11-20：先亮出目标库。改数据前让人有机会看见自己连错了库。
  const target = (process.env.DATABASE_URL ?? "").replace(/:[^:@]*@/, ":***@");
  console.log(`目标库：${target || "（未设置 DATABASE_URL）"}`);
  console.log(DRY_RUN ? "模式：DRY-RUN（不写库）\n" : "模式：写入\n");

  const clients = await prisma.client.findMany({
    where: { internalCode: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true }
  });

  if (clients.length === 0) {
    console.log("没有需要回填的客户");
    return;
  }

  const perYear = new Map<number, number>();
  let updated = 0;

  for (const c of clients) {
    const year = shParts(c.createdAt).y;
    const seq = (perYear.get(year) ?? 0) + 1;
    perYear.set(year, seq);
    const code = `KH-${year}-${String(seq).padStart(4, "0")}`;
    if (!DRY_RUN) {
      await prisma.client.update({ where: { id: c.id }, data: { internalCode: code } });
    }
    updated++;
  }

  // 播种计数器到各年最大流水
  for (const [year, maxSeq] of perYear) {
    const key = `client-code-counter-${year}`;
    if (!DRY_RUN) {
      await prisma.systemSetting.upsert({
        where: { key },
        update: { value: { value: maxSeq } },
        create: { key, value: { value: maxSeq } }
      });
    }
    console.log(`计数器 ${key} = ${maxSeq}`);
  }

  console.log(
    DRY_RUN
      ? `\nDRY-RUN 结束：将回填 ${updated} 个客户编号（未写库）。确认无误后加 --yes 重跑。`
      : `\n已回填 ${updated} 个客户编号。`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
