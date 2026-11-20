"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { submitPortalRequest } from "@/server/portal/requests";
import { actionErrorMessage } from "@/lib/action-error";

export function PortalRequestForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const submit = () => {
    if (subject.trim().length < 2 || body.trim().length < 5) {
      toast.error("请填写标题与问题描述");
      return;
    }
    startTransition(async () => {
      try {
        await submitPortalRequest({ subject, body });
        toast.success("已提交，律所会尽快回复");
        setSubject("");
        setBody("");
        router.refresh();
      } catch (err) {
        toast.error("提交失败", { description: actionErrorMessage(err) });
      }
    });
  };

  return (
    <div className="rounded-lg border border-[var(--line)] p-4">
      <p className="text-[12.5px] font-medium">提一个新问题</p>
      <div className="mt-2 space-y-2">
        <div className="space-y-1">
          <Label htmlFor="pr-subject" className="text-[11.5px]">标题</Label>
          <Input
            id="pr-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="如：一审判决书什么时候能收到"
            maxLength={80}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="pr-body" className="text-[11.5px]">具体说明</Label>
          <Textarea
            id="pr-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="把情况说清楚一些，律师回复会更准确"
            maxLength={2000}
          />
        </div>
        <Button onClick={submit} disabled={isPending} className="gap-1">
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          提交
        </Button>
      </div>
    </div>
  );
}
