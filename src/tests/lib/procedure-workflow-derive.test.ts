/**
 * 案卷工作台的纯派生逻辑（2026-11-21 补）
 *
 * 这些函数决定**律师在待办里看到什么、排在哪、逾期怎么算、开庭什么时候从列表消失**。
 * 提取前它们埋在一个 3400 行的组件里，无法单独构造输入 —— 也就是**零覆盖**。
 * 它们不是渲染细节，是业务规则，所以必须有测试。
 *
 * 断言口径：日期一律用相对「现在」的偏移构造，避免固定日期随真实时间漂移。
 */
import { describe, expect, it } from "vitest";
import type { WorkflowProcedure, WorkflowStage } from "@/app/(app)/matters/[id]/_components/procedure-workflow-types";
import {
  actionWhen,
  buildActionItems,
  defaultInsertTarget,
  parseInsertTarget
} from "@/app/(app)/matters/[id]/_components/procedure-workflow-derive";

const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY);

function stage(over: Partial<WorkflowStage> & { key: string; name: string }): WorkflowStage {
  return {
    id: `s-${over.key}`,
    kind: "normal",
    presetKind: "custom",
    removable: false,
    status: "active",
    tasks: [],
    badge: null,
    ...over
  } as WorkflowStage;
}

function procedure(over: Partial<WorkflowProcedure> = {}): WorkflowProcedure {
  return {
    id: "p1",
    type: "FIRST_INSTANCE",
    customLabel: null,
    caseNumber: null,
    acceptedAt: null,
    concludedAt: null,
    status: "IN_PROGRESS",
    stages: [],
    deadlines: [],
    hearings: [],
    memos: [],
    procedureParties: [],
    ...over
  } as WorkflowProcedure;
}

describe("buildActionItems", () => {
  it("没有程序时返回空数组（不是崩溃、也不是全量）", () => {
    expect(buildActionItems(null, [], [])).toEqual([]);
  });

  it("已完成的任务/期限/备忘都不出现在待办里", () => {
    const s = stage({
      key: "k1",
      name: "庭前准备",
      tasks: [
        { id: "t1", title: "已完成任务", description: null, dueAt: inDays(1), completed: true, completedAt: new Date(), priority: 1, stageId: null, assigneeId: null },
        { id: "t2", title: "未完成任务", description: null, dueAt: inDays(1), completed: false, completedAt: null, priority: 1, stageId: null, assigneeId: null }
      ]
    });
    const p = procedure({
      deadlines: [
        { id: "d1", title: "已完成期限", category: "CUSTOM" as never, dueAt: inDays(2), basis: null, remindDays: 3, completed: true }
      ],
      memos: [{ id: "m1", content: "已办结备忘", done: true, doneAt: new Date(), createdAt: new Date() }]
    });
    const items = buildActionItems(p, [s], []);
    expect(items.map((i) => i.title)).toEqual(["未完成任务"]);
  });

  it("任务卡片的 meta 显示指派对象；没指派时显示「未指派」", () => {
    const s = stage({
      key: "k1",
      name: "庭前准备",
      tasks: [
        { id: "t1", title: "A", description: null, dueAt: null, completed: false, completedAt: null, priority: 1, stageId: null, assigneeId: "u1" },
        { id: "t2", title: "B", description: null, dueAt: null, completed: false, completedAt: null, priority: 1, stageId: null, assigneeId: null }
      ]
    });
    const items = buildActionItems(procedure(), [s], [{ id: "u1", name: "张三" }]);
    expect(items.find((i) => i.title === "A")!.meta).toBe("指派 张三");
    expect(items.find((i) => i.title === "B")!.meta).toBe("未指派");
  });

  it("期限按环节指引的类目归属环节；无映射时回退到当前推进环节（不能变成看不见）", () => {
    // 普通自定义期限（CUSTOM）在所有内置环节的 deadlineCategories 里都没有 → 应回退
    const s1 = stage({ key: "k1", name: "立案", status: "active" });
    const s2 = stage({ key: "k2", name: "庭前准备", status: "todo" });
    const p = procedure({
      deadlines: [
        { id: "d1", title: "自定义期限", category: "CUSTOM" as never, dueAt: inDays(3), basis: null, remindDays: 3, completed: false }
      ]
    });
    const [item] = buildActionItems(p, [s1, s2], []);
    // 关键不变量：一定有环节归属，否则环节视图下待办区永不显示、处置入口不可达
    expect(item.stageKey).not.toBeNull();
    expect(item.stageKey).toBe("k1"); // 回退到 active 那个
  });

  it("已过期的开庭不再出现在待办里（过去的事不该继续占待办位）", () => {
    const p = procedure({
      hearings: [
        { id: "h1", title: "已开完", room: null, address: null, startsAt: inDays(-1) },
        { id: "h2", title: "明天开", room: "第三法庭", address: null, startsAt: inDays(1) }
      ]
    });
    const items = buildActionItems(p, [], []);
    expect(items.map((i) => i.title)).toEqual(["明天开"]);
    expect(items[0].meta).toBe("第三法庭");
  });

  it("备忘标题取首行并截断到 80 字（长备忘不会把待办撑爆）", () => {
    const long = "第一行" + "很长的补充说明".repeat(30) + "\n第二行不该出现";
    const p = procedure({
      memos: [{ id: "m1", content: long, done: false, doneAt: null, createdAt: new Date() }]
    });
    const [item] = buildActionItems(p, [], []);
    expect(item.title.length).toBeLessThanOrEqual(80);
    expect(item.title).not.toContain("第二行");
  });

  it("排序：有时间的按时间升序；无时间的（备忘）排在最后", () => {
    const s = stage({
      key: "k1",
      name: "庭前准备",
      tasks: [
        { id: "t-late", title: "后天", description: null, dueAt: inDays(2), completed: false, completedAt: null, priority: 0, stageId: null, assigneeId: null },
        { id: "t-early", title: "明天", description: null, dueAt: inDays(1), completed: false, completedAt: null, priority: 0, stageId: null, assigneeId: null }
      ]
    });
    const p = procedure({
      memos: [{ id: "m1", content: "无期限备忘", done: false, doneAt: null, createdAt: new Date() }]
    });
    const items = buildActionItems(p, [s], []);
    expect(items.map((i) => i.title)).toEqual(["明天", "后天", "无期限备忘"]);
  });

  it("待确认的期限带上 pendingConfirm 标记（渲染层据此显示「待确认」）", () => {
    const p = procedure({
      deadlines: [
        { id: "d1", title: "待确认", category: "CUSTOM" as never, dueAt: inDays(1), basis: null, remindDays: 3, completed: false, confirmStatus: "PENDING" },
        { id: "d2", title: "已确认", category: "CUSTOM" as never, dueAt: inDays(2), basis: null, remindDays: 3, completed: false, confirmStatus: "CONFIRMED" }
      ]
    });
    const items = buildActionItems(p, [], []);
    expect(items.find((i) => i.title === "待确认")!.pendingConfirm).toBe(true);
    expect(items.find((i) => i.title === "已确认")!.pendingConfirm).toBe(false);
  });
});

describe("actionWhen —— 待办行右侧的日期/剩余天数文案", () => {
  const base = { key: "x", title: "t", at: null, days: null, stageKey: null, stageName: null, meta: "", priority: 0 } as const;

  it("逾期用红色并显示逾期天数", () => {
    const r = actionWhen({ ...base, kind: "task", days: -3 });
    expect(r.tone).toBe("red");
    expect(r.main).toBe("逾期 3 天");
  });

  it("当天显示「今天」，7 天内用琥珀色", () => {
    expect(actionWhen({ ...base, kind: "task", days: 0 }).main).toBe("今天");
    expect(actionWhen({ ...base, kind: "task", days: 3 }).tone).toBe("amber");
    expect(actionWhen({ ...base, kind: "task", days: 30 }).tone).toBe("slate");
  });

  it("开庭用蓝色，主文案是日期、副文案是时刻", () => {
    const at = new Date("2026-12-01T09:30:00+08:00");
    const r = actionWhen({ ...base, kind: "hearing", at, days: 1 });
    expect(r.tone).toBe("blue");
    expect(r.main).toMatch(/12-01|12月01/);
    expect(r.sub).toMatch(/09:30/);
  });

  it("无期限显示「无期限」，不显示副文案", () => {
    const r = actionWhen({ ...base, kind: "memo", days: null, at: null });
    expect(r.main).toBe("无期限");
    expect(r.sub).toBe("");
  });
});

describe("环节插入位置（defaultInsertTarget / parseInsertTarget 往返）", () => {
  const stages = [stage({ key: "a", name: "立案" }), stage({ key: "b", name: "开庭" })];

  it("未选中任何环节 → START（插到最前）", () => {
    expect(defaultInsertTarget(null)).toBe("START");
    expect(parseInsertTarget("START", stages)).toEqual({ position: "START", afterStageId: "", afterStageName: "" });
  });

  it("已落库的环节按 id 定位；只在本地存在的环节按名字定位", () => {
    expect(defaultInsertTarget(stages[0])).toBe("AFTER_ID:s-a");
    expect(parseInsertTarget("AFTER_ID:s-a", stages)).toEqual({
      position: "AFTER",
      afterStageId: "s-a",
      afterStageName: ""
    });
    const draft = stage({ key: "c", name: "草稿环节", id: null as never });
    expect(defaultInsertTarget(draft)).toBe("AFTER_NAME:草稿环节");
    expect(parseInsertTarget("AFTER_NAME:草稿环节", stages).afterStageName).toBe("草稿环节");
  });

  it("无法识别的目标串落到 END（不抛错、不静默插到最前）", () => {
    expect(parseInsertTarget("garbage", stages).position).toBe("END");
    expect(parseInsertTarget("", stages).position).toBe("END");
  });
});
