/**
 * v0.42 一次性回填：给现有 Matter 生成所内案号（firmCaseNo）。
 * 按 createdAt 顺序、按「年（取 intakeDate 否则 createdAt）+ 类别」分流水，
 * 用当前「设置 → 律所信息」的模板渲染；同时把各计数器写进 SystemSetting，
 * 保证之后 generateFirmCaseNo() 接着排，不与回填的号冲突。
 *
 * 运行：npx tsx scripts/backfill-firm-caseno.ts
 */
import { prisma } from "../src/lib/prisma";
import { getFirmProfile, CATEGORY_ABBR } from "../src/server/settings/firm-profile";
import { matterCategoryCode } from "../src/lib/procedures-by-category";
import { shParts } from "../src/lib/ui/sh-time";
import { renderCaseNoTemplate } from "../src/lib/matters/firm-caseno";

const DRY_RUN = !process.argv.includes("--yes");
if (!process.argv.includes("--yes") && !process.argv.includes("--dry-run")) {
  console.log("（未指定 --yes，按 dry-run 处理；确认无误后加 --yes 真正写入）\n");
}

async function main() {
  // 2026-11-20：与 backfill-client-codes 同款防护。
  // 本脚本改写 Matter.firmCaseNo —— 这是对外可见的案号（归档、报表、卷宗封面都用它），
  // 误跑一次就直接改标识，且无法简单回退。
  const target = (process.env.DATABASE_URL ?? "").replace(/:[^:@]*@/, ":***@");
  console.log(`目标库：${target || "（未设置 DATABASE_URL）"}`);
  console.log(DRY_RUN ? "模式：DRY-RUN（不写库）\n" : "模式：写入\n");

  const profile = await getFirmProfile();
  const matters = await prisma.matter.findMany({
    where: { firmCaseNo: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, category: true, intakeDate: true, createdAt: true }
  });

  if (matters.length === 0) {
    console.log("没有需要回填的案件");
    return;
  }

  const counters = new Map<string, number>(); // `${year}-${code}` → 当前流水
  let updated = 0;

  for (const m of matters) {
    const year = shParts(m.intakeDate ?? m.createdAt).y;
    const code = matterCategoryCode[m.category];
    const ckey = `${year}-${code}`;
    const seq = (counters.get(ckey) ?? 0) + 1;
    counters.set(ckey, seq);

    const firmCaseNo = renderCaseNoTemplate(profile.caseNoTemplate, {
      year,
      firmShortName: profile.firmShortName,
      categoryAbbr: CATEGORY_ABBR[m.category],
      categoryWord: profile.categoryWords[m.category],
      seq
    });
    if (!DRY_RUN) {
      await prisma.matter.update({ where: { id: m.id }, data: { firmCaseNo } });
    }
    updated++;
  }

  // 播种计数器到各 (年+类别) 的最大流水
  for (const [ckey, maxSeq] of counters) {
    const key = `firm-caseno-${ckey}`;
    await prisma.systemSetting.upsert({
      where: { key },
      update: { value: { value: maxSeq } },
      create: { key, value: { value: maxSeq } }
    });
    console.log(`计数器 ${key} = ${maxSeq}`);
  }

  console.log(`已回填 ${updated} 个所内案号`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
