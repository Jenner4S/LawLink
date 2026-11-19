"use client";

import { useState } from "react";
import { Plus, ShieldOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RadioChips } from "@/components/ui/radio-chips";
import { AdminPageHeader } from "@/components/layout/admin-page-header";
import { shDayKey, shMonthDayTime } from "@/lib/ui/sh-time";
import type { EthicalWallRow, WallTargetOptions } from "@/server/ethical-walls/actions";

import { WallCreateSheet } from "./wall-create-sheet";
import { WallLiftDialog } from "./wall-lift-dialog";

type StatusKey = "ALL" | "ACTIVE" | "LIFTED" | "EXPIRED";

const STATUS_ITEMS: { value: StatusKey; label: string }[] = [
  { value: "ALL", label: "全部" },
  { value: "ACTIVE", label: "生效中" },
  { value: "EXPIRED", label: "已过期" },
  { value: "LIFTED", label: "已解除" }
];

const STATUS_BADGE: Record<EthicalWallRow["status"], { variant: "amber" | "secondary" | "outline"; label: string }> = {
  ACTIVE: { variant: "amber", label: "生效中" },
  LIFTED: { variant: "secondary", label: "已解除" },
  EXPIRED: { variant: "outline", label: "已过期" }
};

const STATUS_SPINE: Record<EthicalWallRow["status"], string> = {
  ACTIVE: "amber",
  LIFTED: "slate",
  EXPIRED: "slate"
};

export function EthicalWallsView({ walls, targets }: { walls: EthicalWallRow[]; targets: WallTargetOptions }) {
  const [filter, setFilter] = useState<StatusKey>("ALL");
  const [creating, setCreating] = useState(false);
  const [liftingId, setLiftingId] = useState<string | null>(null);

  const counts = {
    ALL: walls.length,
    ACTIVE: walls.filter((wall) => wall.status === "ACTIVE").length,
    LIFTED: walls.filter((wall) => wall.status === "LIFTED").length,
    EXPIRED: walls.filter((wall) => wall.status === "EXPIRED").length
  };
  const rows = filter === "ALL" ? walls : walls.filter((wall) => wall.status === filter);
  const lifting = walls.find((wall) => wall.id === liftingId) ?? null;

  return (
    <div className="space-y-4">
      <AdminPageHeader
        title="隔离墙"
        sub={
          <>
            {counts.ACTIVE > 0 ? <><b>{counts.ACTIVE}</b> 堵生效中 · </> : null}
            与本所 {counts.ALL} 堵隔离墙记录。隔离墙对全所生效（含合伙人与管理员），解除须填理由且原理由不被覆盖。
          </>
        }
        actions={<Button size="sm" onClick={() => setCreating(true)}><Plus />新建隔离墙</Button>}
      />

      <div className="card flex flex-wrap items-center gap-3 p-3">
        <RadioChips
          items={STATUS_ITEMS.map((item) => ({
            value: item.value,
            label: `${item.label} ${counts[item.value]}`
          }))}
          value={filter}
          onChange={(next) => setFilter(next)}
          size="sm"
        />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <ShieldOff className="mx-auto h-6 w-6 text-muted-foreground" strokeWidth={1.6} />
          <p className="mt-2 text-sm text-muted-foreground">
            {filter === "ALL" ? "尚未建立任何隔离墙。当本所代理关系与本所其他客户的利益相冲突时，在此隔离相关人员的访问。" : "当前筛选下没有记录"}
          </p>
        </div>
      ) : (
        <div className="mo-scroll-x rounded-xl border bg-card">
          <table className="mo-table" style={{ minWidth: 1040 }}>
            <thead>
              <tr>
                <th style={{ width: 240 }}>案件</th>
                <th>隔离理由</th>
                <th style={{ width: 220 }}>被隔离对象</th>
                <th style={{ width: 170 }}>生效期</th>
                <th style={{ width: 96 }}>状态</th>
                <th style={{ width: 96 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((wall) => {
                const badge = STATUS_BADGE[wall.status];
                return (
                  <tr key={wall.id} data-spine={STATUS_SPINE[wall.status]}>
                    <td>
                      <div className="font-mono text-[11px] text-muted-foreground tabular">{wall.matterCode}</div>
                      <div className="mt-0.5 line-clamp-2 font-medium">{wall.matterTitle}</div>
                    </td>
                    <td>
                      <p className="line-clamp-3 text-[12.5px] leading-[1.6] text-foreground/85" title={wall.reason}>
                        {wall.reason}
                      </p>
                      {wall.status === "LIFTED" && wall.liftReason ? (
                        <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.55] text-muted-foreground" title={wall.liftReason}>
                          解除理由：{wall.liftReason}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {wall.targets.map((target) => (
                          <Badge key={target.key} variant="outline" title={target.typeLabel}>
                            {target.label}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="text-[12px] text-muted-foreground">
                      <div className="font-mono tabular">{wall.expiresAt ? `至 ${shDayKey(wall.expiresAt)}` : "长期有效"}</div>
                      {wall.status === "LIFTED" && wall.liftedAt ? (
                        <div className="mt-0.5">
                          {shDayKey(wall.liftedAt)} 由 {wall.liftedByName ?? "—"} 解除
                        </div>
                      ) : null}
                      <div className="mt-0.5 opacity-80">{shMonthDayTime(wall.createdAt)} 建立 · {wall.createdByName}</div>
                    </td>
                    <td>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td>
                      {wall.status === "LIFTED" ? (
                        <span className="text-[11.5px] text-muted-foreground">不可再操作</span>
                      ) : (
                        <Button variant="ghost" size="sm" onClick={() => setLiftingId(wall.id)} aria-label={`解除 ${wall.matterTitle} 的隔离墙`}>
                          解除
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mo-note">
        <ShieldOff aria-hidden />
        <span>
          隔离墙与「冲突检索」分工不同：冲突检索回答「这个案子能不能接」（接案前），隔离墙回答「接了之后所内谁不能看」（接案后）。
          拦截对全所生效，不因合伙人或管理员身份豁免；到期或解除后自动恢复常规权限，恢复动作同样留痕。
        </span>
      </p>

      {creating ? <WallCreateSheet targets={targets} onClose={() => setCreating(false)} /> : null}
      {lifting ? (
        <WallLiftDialog
          wallId={lifting.id}
          matterTitle={lifting.matterTitle}
          statusLabel={STATUS_BADGE[lifting.status].label}
          onClose={() => setLiftingId(null)}
        />
      ) : null}
    </div>
  );
}
