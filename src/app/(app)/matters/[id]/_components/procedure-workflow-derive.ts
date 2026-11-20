/**
 * 案卷工作台的纯派生逻辑（2026-11-21 从 procedure-workflow-panel.tsx 抽出）
 *
 * 这一层回答的是「律师在待办里看到什么、排在哪、逾期怎么算」——
 * 全是**决定业务呈现的规则**，却一行测试都没有（提取前它们埋在 3400 行的组件里，
 * 无法单独构造输入）。抽出来的唯一目的是让它们可被测试。
 *
 * 与渲染无关：这里不 import React、不碰 props、不读写 state。
 */
import { daysUntil } from "@/lib/utils";
import { shMonthDay, shMonthDayTime, shTime } from "@/lib/ui/sh-time";
import type { DeadlineCategory, DocumentCategory } from "@prisma/client";
import { DEFAULT_STAGE_GUIDE, STAGE_GUIDES } from "./procedure-workflow-guides";
import { JUDGMENT_NOTE_TAG } from "./procedure-workflow-types";
import type { ExpressItem } from "./info-extras";
import type {
  ActionItem,
  LogKind,
  LogItem,
  WorkflowDocument,
  WorkflowNote,
  WorkflowTimelineEvent,
  WorkflowItem,
  WorkflowProcedure,
  WorkflowStage
} from "./procedure-workflow-types";

/** 用户选项（姓名解析用，避免依赖保存面板的 module） */
export type UserOption = { id: string; name: string };

/** 办案记录的沟通渠道中文标签（buildLogItems 用它拼标题） */
const NOTE_CHANNEL_LABEL: Record<string, string> = {
  PHONE: "电话沟通",
  WECHAT: "微信沟通",
  EMAIL: "邮件往来",
  MEETING: "面谈",
  COURT: "法院沟通",
  OTHER: "办案记录"
};

/** 上海日历口径的「月-日」。提取前是面板里的一个本地别名，顺手收进这一层。 */
export function shortDay(date: Date): string {
  return shMonthDay(date);
}

export function stageGuideFor(stageName: string) {
  return STAGE_GUIDES.find((item) => item.keys.some((key) => stageName.includes(key)))?.guide ??
    DEFAULT_STAGE_GUIDE;
}

export function stageChainDate(stage: WorkflowStage, procedure: WorkflowProcedure | null): string | null {
  const src = procedure?.stages.find((s) => s.id === stage.id);
  if (src?.completedAt) return shortDay(src.completedAt);
  const due = stage.tasks.filter((t) => !t.completed && t.dueAt).map((t) => new Date(t.dueAt!).getTime()).sort((a, b) => a - b)[0];
  if (due) return shortDay(new Date(due));
  if (src?.startedAt) return shortDay(src.startedAt);
  return null;
}

export function actionWhen(item: ActionItem) {
  const tone = item.days !== null && item.days < 0 ? "red" : item.kind === "hearing" ? "blue" : item.days !== null && item.days <= 7 ? "amber" : "slate";
  const main =
    item.kind === "hearing" && item.at
      ? shortDay(item.at)
      : item.days === null
        ? "无期限"
        : item.days < 0
          ? `逾期 ${-item.days} 天`
          : item.days === 0
            ? "今天"
            : `剩 ${item.days} 天`;
  const sub = item.at ? (item.kind === "hearing" ? shTime(item.at) : `${shortDay(item.at)} 截止`) : "";
  return { tone, main, sub };
}

export function buildActionItems(procedure: WorkflowProcedure | null, stages: WorkflowStage[], users: UserOption[]): ActionItem[] {
  if (!procedure) return [];
  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);
  const items: ActionItem[] = [];
  for (const stage of stages) {
    for (const task of stage.tasks) {
      if (task.completed) continue;
      const assignee = nameOf(task.assigneeId);
      items.push({
        key: `t-${task.id}`,
        kind: "task",
        title: task.title,
        at: task.dueAt,
        days: task.dueAt ? daysUntil(task.dueAt) : null,
        stageKey: stage.key,
        stageName: stage.name,
        meta: [assignee ? `指派 ${assignee}` : "未指派", task.description?.trim() || null].filter(Boolean).join(" · "),
        priority: task.priority,
        taskId: task.id,
        assigneeId: task.assigneeId,
        description: task.description,
        stageId: task.stageId
      });
    }
  }
  const stageForDeadline = (category: DeadlineCategory) => stages.find((s) => stageGuideFor(s.name).deadlineCategories.includes(category))
    // 无映射类目（如「其他」）此前归 null，环节视图下待办区永不显示、确认/调整入口不可达
    // （2026-09-21 全流程验收发现）——回退到当前推进环节，保证任何期限都可被看见与处置。
    ?? stages.find((s) => s.status === "active")
    ?? stages[0]
    ?? null;
  for (const deadline of procedure.deadlines) {
    if (deadline.completed) continue;
    const stage = stageForDeadline(deadline.category);
    items.push({
      key: `d-${deadline.id}`,
      kind: "deadline",
      title: deadline.title,
      at: deadline.dueAt,
      days: daysUntil(deadline.dueAt),
      stageKey: stage?.key ?? null,
      stageName: stage?.name ?? null,
      meta: deadline.basis ?? "",
      priority: 2,
      deadlineId: deadline.id,
      pendingConfirm: deadline.confirmStatus === "PENDING"
    });
  }
  const hearingStage = stages.find((s) => /开庭|庭审|询问/.test(s.name)) ?? stages.find((s) => stageGuideFor(s.name).includeHearings) ?? null;
  for (const hearing of procedure.hearings) {
    const days = daysUntil(hearing.startsAt);
    if (days < 0) continue;
    items.push({
      key: `h-${hearing.id}`,
      kind: "hearing",
      title: hearing.title,
      at: hearing.startsAt,
      days,
      stageKey: hearingStage?.key ?? null,
      stageName: hearingStage?.name ?? null,
      meta: [hearing.room, hearing.address].filter(Boolean).join(" · "),
      priority: 1
    });
  }
  // 历史备忘＝无截止日的事项（2026-09-15 起不再新增）
  for (const memo of procedure.memos ?? []) {
    if (memo.done) continue;
    items.push({
      key: `m-${memo.id}`,
      kind: "memo",
      title: memo.content.split("\n")[0].slice(0, 80),
      at: null,
      days: null,
      stageKey: null,
      stageName: null,
      meta: `备忘 · ${shortDay(memo.createdAt)} 记`,
      priority: 0,
      memoId: memo.id
    });
  }
  const byTime = (a: ActionItem, b: ActionItem) => (a.at ? new Date(a.at).getTime() : Infinity) - (b.at ? new Date(b.at).getTime() : Infinity) || b.priority - a.priority;
  return items.sort(byTime);
}

export function formatDateTimeShort(date: Date) {
  const d = new Date(date);
  return shMonthDayTime(d);
}

export function formatBytes(size: number) {
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size} B`;
}

export function defaultInsertTarget(selectedItem: WorkflowItem | null) {
  if (!selectedItem) return "START";
  return selectedItem.id ? `AFTER_ID:${selectedItem.id}` : `AFTER_NAME:${selectedItem.name}`;
}

export function parseInsertTarget(target: string, stages: WorkflowStage[]) {
  if (target === "START") {
    return { position: "START" as const, afterStageId: "", afterStageName: "" };
  }
  if (target.startsWith("AFTER_ID:")) {
    return {
      position: "AFTER" as const,
      afterStageId: target.slice("AFTER_ID:".length),
      afterStageName: ""
    };
  }
  if (target.startsWith("AFTER_NAME:")) {
    const name = target.slice("AFTER_NAME:".length);
    return {
      position: "AFTER" as const,
      afterStageId: "",
      afterStageName: stages.find((stage) => stage.name === name)?.name ?? name
    };
  }
  return { position: "END" as const, afterStageId: "", afterStageName: "" };
}

export function noteStage(note: WorkflowNote) {
  return note.tags?.find((t) => t.startsWith("环节:"))?.slice(3) ?? null;
}

export function buildLogItems({
  procedure,
  stages,
  notes,
  events,
  users,
  expresses
}: {
  procedure: WorkflowProcedure | null;
  stages: WorkflowStage[];
  notes: WorkflowNote[];
  events: WorkflowTimelineEvent[];
  users: UserOption[];
  expresses: ExpressItem[];
}): LogItem[] {
  // 时间归段：记录落在其前最近开始的环节；研判笔记环节标签、任务所属环节优先
  const started = (procedure?.stages ?? [])
    .filter((s) => s.status !== "HIDDEN" && s.startedAt)
    .sort((a, b) => new Date(a.startedAt!).getTime() - new Date(b.startedAt!).getTime());
  const stageByTime = (at: Date) => {
    let hit: string | null = null;
    for (const s of started) if (new Date(s.startedAt!).getTime() <= at.getTime()) hit = s.name;
    return hit;
  };
  const nameOf = (id: string | null) => (id ? users.find((u) => u.id === id)?.name ?? null : null);
  const items: LogItem[] = [];
  const now = Date.now();

  for (const note of notes) {
    const at = new Date(note.occurredAt);
    const judgment = note.tags.includes(JUDGMENT_NOTE_TAG);
    const kind: LogKind = judgment ? "note" : note.channel === "COURT" ? "court" : "talk";
    items.push({
      key: `n-${note.id}`,
      kind,
      at,
      stageName: noteStage(note) ?? stageByTime(at),
      title: judgment ? "研判笔记" : `${NOTE_CHANNEL_LABEL[note.channel] ?? "办案记录"}${note.withWhom ? ` · ${note.withWhom}` : ""}`,
      body: note.content,
      meta: `${note.author.name} · ${formatDateTimeShort(at)}`,
      stageTag: noteStage(note),
      noteId: note.id,
      noteAuthorId: note.author.id,
      noteChannel: note.channel,
      noteWithWhom: note.withWhom,
      noteTags: note.tags
    });
  }
  for (const stage of stages) {
    for (const task of stage.tasks) {
      if (!task.completed || !task.completedAt) continue;
      const at = new Date(task.completedAt);
      const assignee = nameOf(task.assigneeId);
      items.push({
        key: `t-${task.id}`,
        kind: "task",
        at,
        stageName: stage.name,
        title: `完成任务：${task.title}`,
        body: null,
        meta: [assignee ? `经办 ${assignee}` : null, formatDateTimeShort(at)].filter(Boolean).join(" · ")
      });
    }
  }
  const hearingStage = stages.find((s) => /开庭|庭审|询问/.test(s.name))?.name ?? null;
  for (const hearing of procedure?.hearings ?? []) {
    const at = new Date(hearing.startsAt);
    if (at.getTime() > now) continue;
    // 标题点名了环节（如「庭前会议」）时归该环节，否则归开庭环节
    const named = stages.find((s) => hearing.title.includes(s.name))?.name ?? null;
    items.push({
      key: `h-${hearing.id}`,
      kind: "court",
      at,
      stageName: named ?? hearingStage ?? stageByTime(at),
      title: `已开庭：${hearing.title}`,
      body: null,
      meta: [hearing.room, formatDateTimeShort(at)].filter(Boolean).join(" · "),
      channelTone: "court"
    });
  }
  for (const memo of (procedure?.memos ?? []).filter((m) => m.done)) {
    const at = new Date(memo.createdAt);
    items.push({
      key: `m-${memo.id}`,
      kind: "memo",
      at,
      stageName: stageByTime(at),
      title: memo.done ? "备忘（已办）" : "备忘",
      body: memo.content,
      meta: [formatDateTimeShort(at), memo.done && memo.doneAt ? `${formatDateTimeShort(new Date(memo.doneAt))} 办结` : null].filter(Boolean).join(" · "),
      memo: { id: memo.id, done: memo.done }
    });
  }
  for (const ex of expresses) {
    const at = new Date(ex.createdAt);
    const outbound = ex.direction === "OUTBOUND";
    items.push({
      key: `x-${ex.id}`,
      kind: "express",
      at,
      stageName: stageByTime(at),
      title: `${outbound ? "寄出" : "收件"}：${ex.purpose}`,
      body: null,
      meta: [ex.companyCode ?? "快递公司待识别", ex.trackingNo, ex.lastState ?? "待跟踪", ex.lastUpdateAt ? `更新 ${formatDateTimeShort(new Date(ex.lastUpdateAt))}` : null].filter(Boolean).join(" · "),
      express: { id: ex.id, outbound }
    });
  }
  for (const event of events) {
    // 材料在「材料与证据」；任务、开庭已按实际结果入记录，避免同一件事出现两次
    if (["DOCUMENT_UPLOADED", "TASK_ADDED", "HEARING_SCHEDULED", "DEADLINE_ADDED"].includes(event.eventType)) continue;
    const at = new Date(event.occurredAt);
    items.push({
      key: `e-${event.id}`,
      kind: "sys",
      at,
      stageName: stageByTime(at),
      title: event.title,
      body: null,
      meta: [formatDateTimeShort(at), event.content].filter(Boolean).join(" · "),
      eventType: event.eventType
    });
  }
  return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export function stageMaterialTag(stageName: string) {
  return `阶段:${stageName}`;
}

export function documentMatchesStage(
  document: WorkflowDocument,
  stage: { id: string | null; name: string }
) {
  // v0.48: 外键归属优先——已明确归属某环节的材料不再按模式匹配到其他环节
  if (document.stageId) return stage.id !== null && document.stageId === stage.id;
  if (document.tags?.includes(stageMaterialTag(stage.name))) return true;
  const guide = stageGuideFor(stage.name);
  return guide.materialCategories.includes(document.category) || guide.materialPattern.test(document.name);
}

export function defaultCategoryForStage(stageName: string): DocumentCategory {
  return stageGuideFor(stageName).defaultCategory;
}
