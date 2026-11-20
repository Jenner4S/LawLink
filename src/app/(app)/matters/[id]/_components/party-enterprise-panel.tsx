"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Loader2, Search, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  bindPartyToEnterprise,
  unbindPartyEnterprise,
  searchEnterpriseCandidates,
  type EnterpriseSearchItem
} from "@/server/yuandian/enterprise";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import { actionErrorMessage } from "@/lib/action-error";

/**
 * 当事人 ↔ 元典企业绑定（2026-11-20）
 *
 * `bindPartyToEnterprise` / `unbindPartyEnterprise` 一直存在但零引用：
 * AGENTS 写的动线是「录入单位名称时自动匹配并回填信用代码」，但那只在建档那一刻生效。
 * **建档后才补、或匹配错了要改绑/解绑，界面上没有入口**——而信用代码是利冲检索的比对依据，
 * 绑错了会直接影响冲突命中（漏检代价是执业违规）。
 *
 * 成本提示：搜索 1 POINT/次、企业概览 10 POINT/次（元典计费）。
 * 所以**不做自动查询**——必须用户点了才发请求，且按钮上标明这两处消耗。
 */
export function PartyEnterpriseDialog({
  open,
  onOpenChange,
  partyId,
  partyName,
  defaultQuery
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partyId: string;
  partyName: string;
  defaultQuery?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState(defaultQuery ?? partyName);
  const [searched, setSearched] = useState(false);
  const [items, setItems] = useState<EnterpriseSearchItem[]>([]);
  const [configured, setConfigured] = useState(true);

  const search = () => {
    if (!query.trim()) {
      toast.error("请填写企业名称");
      return;
    }
    startTransition(async () => {
      try {
        const res = await searchEnterpriseCandidates(query.trim());
        setConfigured(res.configured);
        setItems(res.items);
        setSearched(true);
      } catch (err) {
        toast.error("搜索失败", { description: actionErrorMessage(err) });
      }
    });
  };

  const bind = (item: EnterpriseSearchItem) => {
    startTransition(async () => {
      try {
        await bindPartyToEnterprise({
          partyId,
          enterpriseId: item.id,
          socialCode: item.creditCode,
          enterpriseName: item.name
        });
        toast.success("已绑定工商信息");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("绑定失败", { description: actionErrorMessage(err) });
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Building2 className="h-4 w-4" />
            绑定工商信息
          </DialogTitle>
          <DialogDescription className="text-xs">
            绑定后的统一社会信用代码会参与利益冲突检索比对，请核对准确。
            搜索按元典计费（1 POINT/次）。
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          <div className="space-y-1.5">
            <Label htmlFor="ent-query">企业名称</Label>
            <div className="flex gap-2">
              <Input
                id="ent-query"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    search();
                  }
                }}
              />
              <Button onClick={search} disabled={isPending} className="shrink-0 gap-1">
                {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                搜索
              </Button>
            </div>
          </div>

          {!configured ? (
            <p className="text-xs text-[var(--amber)]">
              元典开放平台未配置，无法搜索。请管理员在「管理后台 → AI 与元典」配置后再试；也可由承办律师手工填写信用代码。
            </p>
          ) : searched && items.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              未找到匹配企业。可换用全称或简称再试；确无工商登记的可不绑定。
            </p>
          ) : items.length > 0 ? (
            <div className="space-y-1">
              {items.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  disabled={isPending}
                  onClick={() => bind(it)}
                  className="flex w-full flex-col items-start gap-0.5 rounded-md border border-[var(--line)] px-3 py-2 text-left hover:bg-muted"
                >
                  <span className="text-xs font-medium">{it.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{it.creditCode}</span>
                </button>
              ))}
            </div>
          ) : null}
        </FormDialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 已绑定时的解绑按钮（绑错了要能撤销） */
export function UnbindEnterpriseButton({ partyId }: { partyId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm gap-1 text-[11px] text-muted-foreground"
      disabled={pending}
      title="解除与元典企业的绑定"
      onClick={async () => {
        const ok = await confirmDialog({
          title: "解除工商绑定？",
          description:
            "解绑后该当事人的统一社会信用代码不再参与利冲检索比对。若只是绑错了企业，建议直接重新绑定正确的，而不是先解绑。",
          confirmText: "解除绑定",
          danger: true
        });
        if (!ok) return;
        startTransition(async () => {
          try {
            await unbindPartyEnterprise(partyId);
            toast.success("已解绑");
            router.refresh();
          } catch (err) {
            toast.error("解绑失败", { description: actionErrorMessage(err) });
          }
        });
      }}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
      解绑
    </button>
  );
}
