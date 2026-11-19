import { prisma } from "@/lib/prisma";
import { verifyAuditChain } from "@/lib/audit-chain";
import { auditActionLabel } from "@/lib/audit-labels";
import { shMonthDayTime } from "@/lib/ui/sh-time";

/**
 * 审计链完整性卡片（2026-11-19）。
 *
 * 为什么要有这张卡：
 * verifyAuditChain 早就在跑，但结果只有两种出口——`/api/audit/verify` 的 JSON
 * 和命令行。运维真正打开的是这个页面，不是 curl。算出来没人看见等于没算。
 *
 * 这张卡回答四件事，按运维的判断顺序排：
 *   1. 链是不是完好（一句话结论 + 颜色）
 *   2. 有多少条真正被校验过（checked / total）——「ok」不等于「全查了」
 *   3. 分叉在哪（这是同事务写多条审计的已知形态，不算故障，但要能看到）
 *   4. 未通过的是哪一条、为什么（给 action 与 id 前缀，能直接定位）
 *
 * 刻意不做的事：
 *   - 不提供「修复」按钮。审计不可改（数据库触发器拦删除），能做的只有查证与追责，
 *     给一个按钮会让人以为点一下就好。
 *   - 不隐藏缺口。unchecked > 0 就如实显示，包括「历史记录用旧算法写入」这种
 *     无法回填的情况——掩盖它比暴露它危险得多。
 */
export async function ChainIntegrityCard() {
  let result: Awaited<ReturnType<typeof verifyAuditChain>> | null = null;
  let total = 0;
  let error: string | null = null;

  try {
    // 审计表异常不应让整个「安全与审计」页打不开
    [result, total] = await Promise.all([
      verifyAuditChain(prisma),
      prisma.auditLog.count({ where: { integrityHash: { not: null } } })
    ]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (error || !result) {
    return (
      <section className="card p-4">
        <h2 className="text-[15px] font-semibold">审计链完整性</h2>
        <p className="mt-1 text-[12px] leading-5 text-[var(--red)]">
          校验未能执行：{error ?? "未知原因"}。这不代表链有问题，只代表这次没查成——请稍后重试或联系管理员。
        </p>
      </section>
    );
  }

  const passed = total - result.unchecked;
  // 2026-11-20（M2）：三种状态必须分开，此前只按哈希对错分了两档。
  //
  // 哈希链有两条独立的性质：
  //   ① 完整性——每条记录的 integrityHash 与其内容一致（result.ok）
  //   ② 单线性——每条记录只有一个后继（result.forks 为空）
  // 分叉不会让任何一条记录的哈希算错，所以 ok=true 时仍可能存在分叉。
  // 原文案在 ok && unchecked===0 时断言「都挂在同一条链上」，一旦有分叉就是假话。
  // 撤销 previousHash 唯一索引后（迁移 20261119000006，同事务写多条审计导致），
  // 分叉成为已知且可接受的形态——那就更不能在界面上否认它。
  const forkCount = result.forks?.length ?? 0;
  const health = result.ok && result.unchecked === 0 && forkCount === 0;
  const partial = result.ok && (result.unchecked > 0 || forkCount > 0);

  return (
    <section className="card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">审计链完整性</h2>
        <span
          className={
            health
              ? "rounded-full bg-[var(--teal-soft)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--teal-deep)]"
              : partial
                ? "rounded-full bg-[var(--amber-bg)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--amber)]"
                : "rounded-full bg-[var(--red-bg)] px-2.5 py-0.5 text-[11.5px] font-semibold text-[var(--red)]"
          }
        >
          {health ? "完好" : partial ? (forkCount > 0 ? "有分叉" : "有未校验记录") : "发现异常"}
        </span>
      </div>

      {/* 结论一句话：先说人话，再给数字 */}
      <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
        {health
          ? `带摘要的 ${total} 条记录全部通过校验：逐条内容与自身摘要一致，且没有分叉——整条链只有一条主线。`
          : partial
            ? forkCount > 0
              // 分叉与「未校验」是两件事，分开说，否则运维会去查错方向
              ? `带摘要的 ${total} 条记录内容均通过校验，但有 ${forkCount} 处分叉（见下方）：同一时刻有两条记录各自接着同一个前驱。这通常是同一事务里连写多条审计造成的，不影响每条记录自身的可信度，但不能说成「一条链」。`
              : `带摘要的 ${total} 条记录中，${passed} 条通过校验，${result.unchecked} 条未通过（见下方明细）。`
            : `校验在 ${result.brokenAt?.action ?? "某条记录"} 处发现异常，已校验 ${result.checked} 条。`}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px] sm:grid-cols-4">
        <div>
          <dt className="text-muted-foreground">已校验</dt>
          <dd className="font-mono tabular-nums font-semibold">{result.checked}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">未通过</dt>
          <dd className={`font-mono tabular-nums font-semibold ${result.unchecked > 0 ? "text-[var(--red)]" : ""}`}>
            {result.unchecked}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">分叉点</dt>
          <dd className="font-mono tabular-nums font-semibold">{result.forks?.length ?? 0}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">无摘要历史</dt>
          <dd className="font-mono tabular-nums font-semibold">{result.skippedLegacy}</dd>
        </div>
      </dl>

      {/* 未通过明细：给 action 和 id 前缀，能直接定位 */}
      {/*
        2026-11-21 修复：原用 --red-soft（moan.css 里不存在，只有 --red-bg: #FBECE9），
        fallback #FCEDEB 是猜的、与真实 token 不同；且 bg-[var(...)]/40 的透明度修饰符
        对 var() 生成不出 CSS（Tailwind 需要 <alpha-value> 占位符），那层红底其实一直是丢的。
        改用真实 token --red-bg 并去掉无效的 /40 —— --red-bg 本身就是浅红。
      */}
      {result.brokenAt ? (
        <div className="mt-4 rounded-lg border border-[var(--red-line)] bg-[var(--red-bg)] p-3">
          <h3 className="text-[13px] font-semibold text-[var(--red)]">首个未通过的记录</h3>
          <p className="mt-1 text-[12px] leading-5">
            <span className="font-semibold">{auditActionLabel(result.brokenAt.action)}</span>
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
              {result.brokenAt.id.slice(0, 10)}…
            </span>
          </p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{result.brokenAt.reason}</p>
          <p className="mt-2 text-[11.5px] leading-5 text-muted-foreground">
            「内容与摘要不符」通常有两种来源：该条记录被改动过，或它写入于旧版序列化算法
            （对 undefined 字段处理不一致，已于 2026-11-19 修复，新写入不受影响）。
            审计记录不可修改，请对照该条的技术详情与同期操作记录核实。
          </p>
        </div>
      ) : null}

      {/* 分叉明细：解释成因，避免被误读成故障 */}
      {result.forks?.length ? (
        <div className="mt-4">
          <h3 className="text-[13px] font-semibold">分叉点（{result.forks.length} 处）</h3>
          <p className="mt-1 text-[11.5px] leading-5 text-muted-foreground">
            同一前驱出现多条后继。成因是「同一事务内写入多条审计」时，链的前驱读取走独立连接，
            读不到同事务内尚未提交的前一条 —— 这是已知形态，不影响可用性，各分支均已校验。
          </p>
          <ul className="mt-2 divide-y divide-[var(--bd-subtle)] text-[12px]">
            {result.forks.slice(0, 5).map((fork) => (
              <li key={fork.previousHash} className="py-1.5">
                <span className="font-mono text-[11px] text-muted-foreground">
                  {fork.previousHash === "(root)" ? "链起点" : fork.previousHash.slice(0, 12) + "…"}
                </span>
                <span className="ml-2">
                  {fork.actions.map(auditActionLabel).join(" / ")}
                </span>
                <span className="ml-2 text-[11px] text-muted-foreground">
                  {fork.ids.map((id) => id.slice(-6)).join(", ")}
                </span>
              </li>
            ))}
          </ul>
          {result.forks.length > 5 ? (
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              另有 {result.forks.length - 5} 处分叉未列出。
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="mt-3 text-[11.5px] leading-5 text-muted-foreground">
        校验于 {shMonthDayTime(new Date())} 执行。审计记录只能归档处置、不可删除或修改；
        本页只读，不提供修复入口 —— 发现问题应依下方记录追查操作过程。
      </p>
    </section>
  );
}
