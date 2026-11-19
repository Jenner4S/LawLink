"use client";

/**
 * 被隔离对象选择器：人员在 / 团队 / 岗位三种类别互斥一次选一类，
 * 但已选对象可以混合（一堵墙常见「隔离某律师 + 隔离其所在团队」）。
 *
 * 类别只有 3 项，用 RadioChips（≤5 用 chip，AGENTS 交互原则②）；
 * 人员与团队可能是几十条，用搜索框 + 勾选列表（与律师团队页同款），不用下拉逐条滚。
 */
import { useState } from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioChips } from "@/components/ui/radio-chips";
import type { WallTargetOptions } from "@/server/ethical-walls/actions";
import type { DenyType } from "@/server/ethical-walls/schemas";

export type PickedTarget = { key: string; denyType: DenyType; id: string; label: string };

const TYPE_ITEMS: { value: DenyType; label: string; description: string }[] = [
  { value: "USER", label: "人员", description: "隔离指定的人，不论其岗位与团队" },
  { value: "TEAM", label: "团队", description: "隔离整个律师团队的活跃成员" },
  { value: "ROLE", label: "岗位", description: "隔离全所该岗位的所有人" }
];

export function DenialPicker({
  targets,
  value,
  onChange
}: {
  targets: WallTargetOptions;
  value: PickedTarget[];
  onChange: (next: PickedTarget[]) => void;
}) {
  const [denyType, setDenyType] = useState<DenyType>("USER");
  const [search, setSearch] = useState("");

  const keyword = search.trim();
  const candidates: PickedTarget[] =
    denyType === "USER"
      ? targets.users
          .filter((user) => !keyword || user.name.includes(keyword) || user.roleLabel.includes(keyword))
          .map((user) => ({ key: `USER:${user.id}`, denyType: "USER", id: user.id, label: `${user.name}（${user.roleLabel}）` }))
      : denyType === "TEAM"
        ? targets.teams
            .filter((team) => !keyword || team.name.includes(keyword))
            .map((team) => ({ key: `TEAM:${team.id}`, denyType: "TEAM", id: team.id, label: team.name }))
        : targets.roles.map((role) => ({ key: `ROLE:${role.value}`, denyType: "ROLE", id: role.value, label: `全所「${role.label}」` }));

  function toggle(target: PickedTarget, checked: boolean) {
    if (checked) {
      if (value.some((item) => item.key === target.key)) return;
      onChange([...value, target]);
      return;
    }
    onChange(value.filter((item) => item.key !== target.key));
  }

  return (
    <div className="space-y-3">
      <RadioChips items={TYPE_ITEMS} value={denyType} onChange={(next) => { setDenyType(next); setSearch(""); }} size="sm" />

      {denyType === "ROLE" ? null : (
        <Input
          aria-label="搜索被隔离对象"
          placeholder={denyType === "USER" ? "搜索姓名或岗位（保留已选对象）" : "搜索团队名称（保留已选对象）"}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      )}

      <div className="max-h-56 divide-y overflow-y-auto rounded-lg border">
        {candidates.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">没有匹配的对象</p>
        ) : (
          candidates.map((target) => (
            <label key={target.key} className="flex cursor-pointer items-center gap-2 p-2.5 text-sm hover:bg-[var(--bg-hover)]">
              <Checkbox
                checked={value.some((item) => item.key === target.key)}
                onCheckedChange={(checked) => toggle(target, checked === true)}
              />
              <span className="min-w-0 flex-1 truncate">{target.label}</span>
            </label>
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">已选 {value.length} 项：</span>
        {value.length === 0 ? <span className="text-xs text-muted-foreground">尚未选择</span> : null}
        {value.map((item) => (
          <Badge key={item.key} variant="secondary" className="gap-1">
            {item.label}
            <button
              type="button"
              aria-label={`移除 ${item.label}`}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive"
              onClick={() => onChange(value.filter((row) => row.key !== item.key))}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
      </div>
    </div>
  );
}
