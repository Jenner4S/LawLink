import Link from "next/link";
import { ArrowLeft, Receipt } from "lucide-react";
import { requirePortalViewer } from "@/lib/portal/session";
import { listPortalBillings } from "@/server/portal/portal-reads";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * 门户「账单」（2026-11-20，门户 S2）
 *
 * 方案 §七 Q2 三条：
 *   ① **显示状态 + 金额**（不藏金额——客户迟早会在发票上看到，藏起来反而像"在藏什么"）
 *   ② **不显示工时明细**（会引出「这一项为什么要 3 小时」的逐条质疑，承办律师无法逐项解释）
 *   ③ **金额与财务模块同一数据源**（见 listPortalBillings 注释：直接调用财务模块的计算函数）
 */
export default async function PortalBillsPage() {
  await requirePortalViewer("/portal/bills");
  const bills = await listPortalBillings();

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">账单</h1>
          <p className="mt-1 text-[12px] text-[var(--t-muted)]">
            金额与律所财务系统同一口径。如有疑问，请与主办律师核对。
          </p>
        </div>
        <Link href="/portal" className="btn btn-ghost btn-sm gap-1">
          <ArrowLeft className="h-3.5 w-3.5" />
          返回
        </Link>
      </div>

      {bills.length === 0 ? (
        <div className="rounded-lg border border-[var(--line)] p-8 text-center">
          <Receipt className="mx-auto h-6 w-6 text-[var(--t-muted)]" />
          <p className="mt-3 text-[12.5px] text-[var(--t-muted)]">
            目前没有向你开放的账单。如需对账，请联系主办律师。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {bills.map((b) => (
            <li key={b.matterId} className="rounded-lg border border-[var(--line)] p-4">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-[11px] text-[var(--t-muted)]">{b.internalCode}</span>
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium" title={b.title}>
                  {b.title}
                </span>
              </div>

              <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-4">
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">合同金额</dt>
                  <dd className="font-mono tabular">{formatCurrency(b.contractAmount)}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">应收</dt>
                  <dd className="font-mono tabular">{formatCurrency(b.receivable)}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">已收</dt>
                  <dd className="font-mono tabular text-[var(--green)]">{formatCurrency(b.received)}</dd>
                </div>
                <div>
                  <dt className="text-[10.5px] text-[var(--t-muted)]">待收</dt>
                  <dd className="font-mono tabular" style={{ color: b.outstanding > 0 ? "var(--amber)" : undefined }}>
                    {formatCurrency(b.outstanding)}
                  </dd>
                </div>
              </dl>

              {b.invoices.length > 0 ? (
                <div className="mt-3">
                  <p className="text-[11px] font-medium text-[var(--t-muted)]">
                    已开发票 {b.invoices.length} 张 · 合计 {formatCurrency(b.invoiced)}
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {b.invoices.map((inv) => (
                      <li key={inv.id} className="flex items-center gap-2 text-[11.5px]">
                        <span className="font-mono text-[var(--t-muted)]">{inv.invoiceNo ?? "（待补票号）"}</span>
                        <span className="font-mono tabular">{formatCurrency(inv.amount)}</span>
                        <span className="text-[10.5px] text-[var(--t-muted)]">
                          {inv.issuedAt ? formatDate(inv.issuedAt) : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="mt-2 text-[11px] text-[var(--t-muted)]">尚未开具发票。</p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* data-portal-disclaimer：这是「我们不显示什么」的说明。
          校验脚本会在禁止词检查前排除本段，否则说明文字会把断言弄红——
          而改文案去迁就断言，等于让检查失去意义。 */}
      <p data-portal-disclaimer className="mt-5 text-[11px] leading-relaxed text-[var(--t-muted)]">
        这里只显示合同金额、应收、已收、待收与已开发票，<b>不含工时明细与内部成本</b>。
        需要逐项核对请与主办律师预约。
      </p>
    </div>
  );
}
