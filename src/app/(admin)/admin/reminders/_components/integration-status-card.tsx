/**
 * 外部接入状态卡（2026-11-23）
 *
 * 只读：三项对接的配置都在 `.env`，界面不改配置，只回答"现在到哪一步了"。
 *
 * 四种状态用四种颜色，其中 **`configured-unimplemented`（配了但没实现）**
 * 必须显眼——它最容易被误认为"已就绪"，实际一条也发不出去。
 */
import { Plug } from "lucide-react";
import type { IntegrationState, IntegrationStatus } from "@/server/settings/integration-status";

const TONE: Record<IntegrationState["state"], { text: string; cls: string }> = {
  ready: { text: "已就绪", cls: "text-[var(--green,#15803d)]" },
  off: { text: "未配置", cls: "text-[var(--t-muted)]" },
  demo: { text: "演练模式（不真发）", cls: "text-[var(--amber,#b45309)]" },
  "configured-unimplemented": { text: "⚠️ 配了但未实现", cls: "text-[var(--red,#b91c1c)]" }
};

function Row({ label, value, detail }: { label: string; value: IntegrationState; detail?: string }) {
  const tone = TONE[value.state];
  return (
    <div className="flex items-start gap-3 border-t border-[var(--line)] py-1.5 text-[12px] first:border-t-0">
      <span className="w-28 shrink-0 text-[var(--t-muted)]">{label}</span>
      <span className={`w-36 shrink-0 font-medium ${tone.cls}`}>{tone.text}</span>
      <span className="min-w-0 flex-1 text-[11px] text-[var(--t-muted)]">
        {value.state === "off" && (
          <>
            缺：{value.missing.join(" / ")}
            {/* 未配置也把已有数据露出来：线索数不该因为"没配 token"就看不见 */}
            {detail ? `（${detail}）` : ""}
          </>
        )}
        {value.state === "configured-unimplemented" && value.note}
        {value.state === "ready" && detail}
        {value.state === "demo" && "短信会记入内存但不真发，可用来验证整条链路"}
      </span>
    </div>
  );
}

export function IntegrationStatusCard({ status }: { status: IntegrationStatus }) {
  const formDetail =
    status.form.inboundLeadCount > 0
      ? `已收到 ${status.form.inboundLeadCount} 条自动入站线索`
      : "尚无自动入站线索（接口可用，等表单接过来）";

  return (
    <div className="card">
      <div className="panel-head">
        <div className="panel-title" style={{ fontSize: 13 }}>
          <Plug className="ic" strokeWidth={1.8} />
          外部接入（表单 / 邮件 / 短信）
        </div>
        <span className="t-xs t-mute">配置在 .env，此处只读</span>
      </div>
      <div className="mt-1">
        <Row label="官网表单入站" value={status.form} detail={formDetail} />
        <Row label="邮件收件（IMAP）" value={status.imap} />
        <Row label="短信通道" value={status.sms} />
      </div>
      <div className="mt-2 text-[10.5px] text-[var(--t-muted)]">
        接入步骤见 <span className="underline">docs/外部对接说明-20261123.md</span>。
        「配了但未实现」表示密钥已填、代码还没接——此时功能不可用，不要当成已开通。
      </div>
    </div>
  );
}
