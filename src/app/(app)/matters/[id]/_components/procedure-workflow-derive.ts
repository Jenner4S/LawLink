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
import type { DeadlineCategory } from "@prisma/client";
import { DEFAULT_STAGE_GUIDE, STAGE_GUIDES } from "./procedure-workflow-guides";
import type {
  ActionItem,
  WorkflowItem,
  WorkflowProcedure,
  WorkflowStage
} from "./procedure-workflow-types";

/** 用户选项（姓名解析用，避免依赖保存面板的 module） */
export type UserOption = { id: string; name: string };

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
        taskId: task.id
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
