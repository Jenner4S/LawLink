"use client";

import { FormDialogBody } from "@/components/patterns/form-dialog";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Copy, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { draftDocument } from "@/server/ai/draft-document";

/** 常用文书类型（可自由填写，这里只是快捷项） */
const COMMON_TYPES = [
  "民事起诉状",
  "答辩状",
  "代理词",
  "上诉状",
  "证据目录",
  "律师函",
  "法律意见书",
  "和解协议",
  "申请书"
];

/**
 * AI 引导式文书起草（2026-11-20）
 *
 * `draftDocument` 一直存在但零引用：整套「填空 → AI 生成草稿 → 预览/复制/下载」
 * 的能力没有任何入口。而已有的「从模板生成」走的是 docxtemplater 变量替换，
 * 只能产出**已有模板**的文书；没有模板的新类型只能手写。
 *
 * 服务端已内建降级（`{ok:false, reason:"not_configured"}`），所以本对话框
 * 不需要自己判断 AI 是否配置 —— 未配置时把服务端的原因**原样显示**，
 * 并指向 /admin/ai，而不是静默失败或假装成功。
 *
 * 生成结果是 Markdown **草稿**，服务端提示词明确禁止臆造事实与法条编号，
 * 缺失处以【】占位；落款也写明需律师核校。写入卷宗仍走「上传」，
 * 本对话框只负责把草稿交到用户手上。
 */
export function AiDraftDialog({
  open,
  onOpenChange,
  matterTitle,
  defaultDocType
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  matterTitle?: string;
  defaultDocType?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [docType, setDocType] = useState(defaultDocType ?? "");
  const [selfParty, setSelfParty] = useState("");
  const [opposingParty, setOpposingParty] = useState("");
  const [background, setBackground] = useState("");
  const [claims, setClaims] = useState("");
  const [extra, setExtra] = useState("");
  const [content, setContent] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);

  const generate = () => {
    if (!docType.trim()) {
      toast.error("请填写文书类型");
      return;
    }
    setNotConfigured(null);
    startTransition(async () => {
      const res = await draftDocument({
        docType: docType.trim(),
        selfParty: selfParty.trim() || undefined,
        opposingParty: opposingParty.trim() || undefined,
        background: background.trim() || undefined,
        claims: claims.trim() || undefined,
        extra: extra.trim() || undefined
      });
      if (res.ok) {
        setContent(res.content);
        return;
      }
      if (res.reason === "not_configured") {
        setNotConfigured(res.message);
        return;
      }
      toast.error("生成失败", { description: res.message });
    });
  };

  const copy = async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      toast.success("已复制到剪贴板");
    } catch {
      toast.error("复制失败，请手动选中复制");
    }
  };

  const download = () => {
    if (!content) return;
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${docType.trim() || "文书草稿"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Sparkles className="h-4 w-4" />
            AI 起草文书
          </DialogTitle>
          <DialogDescription className="text-xs">
            只依据你填写的信息起草，不臆造事实、证据与法条编号；缺失处以【】占位。
            {matterTitle ? `（本案：${matterTitle}）` : ""}
            <br />
            生成结果是**草稿**，需律师核校后使用。写入卷宗请用「上传」。
          </DialogDescription>
        </DialogHeader>
        <FormDialogBody>
          {notConfigured ? (
            <div className="flex items-start gap-2 rounded-md border border-[var(--amber-line,rgba(150,101,11,.35))] bg-[var(--amber-bg,rgba(150,101,11,.08))] px-3 py-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--amber)]" />
              <div className="text-xs">
                <p className="text-[var(--amber)]">{notConfigured}</p>
                <p className="mt-1 text-muted-foreground">
                  请管理员在「管理后台 → AI 与元典」配置模型后再用；未配置时可用「从模板生成」或手工上传。
                </p>
              </div>
            </div>
          ) : null}

          {content ? (
            <>
              <div className="flex items-center justify-between">
                <Label className="text-xs">生成结果（Markdown 草稿）</Label>
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" className="gap-1 text-[11px]" onClick={copy}>
                    <Copy className="h-3 w-3" /> 复制
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1 text-[11px]" onClick={download}>
                    <Download className="h-3 w-3" /> 下载
                  </Button>
                  <Button size="sm" variant="ghost" className="text-[11px]" onClick={() => setContent(null)}>
                    重写
                  </Button>
                </div>
              </div>
              <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md border border-[var(--line)] p-3 text-[12px] leading-relaxed">
                {content}
              </pre>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="ai-doc-type">文书类型（必填）</Label>
                <Input
                  id="ai-doc-type"
                  list="ai-doc-type-options"
                  value={docType}
                  placeholder="如：民事起诉状"
                  onChange={(e) => setDocType(e.target.value)}
                />
                <datalist id="ai-doc-type-options">
                  {COMMON_TYPES.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-self">我方当事人</Label>
                  <Input id="ai-self" value={selfParty} onChange={(e) => setSelfParty(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-opp">对方当事人</Label>
                  <Input id="ai-opp" value={opposingParty} onChange={(e) => setOpposingParty(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-bg">案件背景</Label>
                <Textarea id="ai-bg" rows={3} value={background} placeholder="时间、事实经过、现状" onChange={(e) => setBackground(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-claims">诉讼请求 / 核心主张</Label>
                <Textarea id="ai-claims" rows={3} value={claims} placeholder="分条写明请求事项" onChange={(e) => setClaims(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-extra">其他补充</Label>
                <Textarea id="ai-extra" rows={2} value={extra} placeholder="选填" onChange={(e) => setExtra(e.target.value)} />
              </div>
            </>
          )}
        </FormDialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            关闭
          </Button>
          {!content ? (
            <Button onClick={generate} disabled={isPending} className="gap-1">
              {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              生成草稿
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
