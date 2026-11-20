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

  it("经办记录带回编辑所需的原值（作者/渠道/相对人/标签）——只对作者本人显示改删", () => {
    // 2026-11-22：updateNote / deleteNote 补了界面入口。
    // 编辑表单必须原样拿到 channel / withWhom / tags —— updateNote 收全量，
    // 缺项会被覆盖成默认值（与任务编辑的 assigneeId 是同一类风险）。
    const p = procedure({ deadlines: [], memos: [] });
    const items = buildLogItems({
      procedure: p,
      stages: [],
      notes: [
        {
          id: "n1",
          channel: "PHONE",
          withWhom: "对方代理人",
          occurredAt: new Date("2026-11-01T10:00:00+08:00"),
          content: "电话沟通调解方案",
          tags: ["环节:庭前准备"],
          author: { id: "u-author", name: "张律师" }
        }
      ],
      events: [],
      users: [],
      expresses: []
    });
    const note = items.find((i) => i.noteId === "n1");
    expect(note).toBeDefined();
    expect(note!.noteAuthorId).toBe("u-author");
    expect(note!.noteChannel).toBe("PHONE");
    expect(note!.noteWithWhom).toBe("对方代理人");
    expect(note!.noteTags).toEqual(["环节:庭前准备"]);
    expect(note!.body).toBe("电话沟通调解方案");
  });

  it("任务卡片带回编辑所需的原值（责任人/说明/环节）——编辑对话框靠它回填", () => {
    // 2026-11-22：updateTask 补了界面入口。编辑表单必须原样拿到这四个字段，
    // 尤其 assigneeId —— updateTask 会比对它，缺失或改动都会抛
    // 「变更责任人请从事项责任面板发起交接」。
    const s = stage({
      key: "k1",
      name: "庭前准备",
      tasks: [
        {
          id: "t9",
          title: "整理证据目录",
          description: "含原件核对",
          dueAt: inDays(3),
          completed: false,
          completedAt: null,
          priority: 2,
          stageId: "st-real",
          assigneeId: "u-real"
        }
      ]
    });
    const items = buildActionItems(procedure({ deadlines: [], memos: [] }), [s], []);
    const task = items.find((i) => i.kind === "task");
    expect(task).toBeDefined();
    expect(task!.taskId).toBe("t9");
    expect(task!.assigneeId).toBe("u-real");
    expect(task!.description).toBe("含原件核对");
    expect(task!.stageId).toBe("st-real");
    expect(task!.priority).toBe(2);
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

/* ==================================================================
 * 第二组（2026-11-21 补）：经办记录聚合 + 材料与环节的匹配
 *
 * 这两块同样是纯规则、此前零覆盖：
 *   buildLogItems        决定「经办记录里出现哪些条目、归到哪个环节、按什么顺序」
 *   documentMatchesStage 决定「一份材料算不算某个环节的」
 * ================================================================== */

const { buildLogItems, documentMatchesStage, noteStage, stageMaterialTag } = await import(
  "@/app/(app)/matters/[id]/_components/procedure-workflow-derive"
);

function note(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "n1",
    channel: "PHONE",
    withWhom: null,
    occurredAt: inDays(-1),
    content: "沟通内容",
    tags: [],
    author: { id: "u1", name: "张三" },
    ...over
  } as never;
}

describe("buildLogItems —— 经办记录里出现什么", () => {
  it("只收**已完成**的任务；未完成的在待办里，不能重复出现在记录里", () => {
    const s = stage({
      key: "k1",
      name: "庭前准备",
      tasks: [
        { id: "t-done", title: "已完成", description: null, dueAt: null, completed: true, completedAt: inDays(-1), priority: 1, stageId: null, assigneeId: "u1" },
        { id: "t-open", title: "未完成", description: null, dueAt: null, completed: false, completedAt: null, priority: 1, stageId: null, assigneeId: null }
      ]
    });
    const items = buildLogItems({ procedure: procedure(), stages: [s], notes: [], events: [], users: [{ id: "u1", name: "张三" }], expresses: [] });
    expect(items.map((i) => i.title)).toEqual(["完成任务：已完成"]);
    expect(items[0].meta).toContain("经办 张三");
  });

  it("只收**已过去**的开庭；未来的在待办里", () => {
    const p = procedure({
      hearings: [
        { id: "h-past", title: "开庭", room: "第三法庭", address: null, startsAt: inDays(-2) },
        { id: "h-future", title: "开庭", room: null, address: null, startsAt: inDays(3) }
      ]
    });
    const items = buildLogItems({ procedure: p, stages: [], notes: [], events: [], users: [], expresses: [] });
    expect(items.filter((i) => i.kind === "court").map((i) => i.title)).toEqual(["已开庭：开庭"]);
  });

  it("开庭标题点名了环节时归该环节，否则归开庭环节", () => {
    const stagesList = [
      stage({ key: "k1", name: "庭前会议" }),
      stage({ key: "k2", name: "开庭审理" })
    ];
    const p = procedure({
      hearings: [
        { id: "h1", title: "庭前会议", room: null, address: null, startsAt: inDays(-1) },
        { id: "h2", title: "第一次庭审", room: null, address: null, startsAt: inDays(-1) }
      ]
    });
    const items = buildLogItems({ procedure: p, stages: stagesList, notes: [], events: [], users: [], expresses: [] });
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i.stageName]));
    expect(byTitle["已开庭：庭前会议"]).toBe("庭前会议"); // 标题点名 → 归该环节
    expect(byTitle["已开庭：第一次庭审"]).toBe("开庭审理"); // 否则归开庭环节
  });

  it("研判笔记单独成类，标题固定为「研判笔记」；法院渠道记作 court", () => {
    const items = buildLogItems({
      procedure: procedure(),
      stages: [],
      notes: [
        note({ id: "n1", tags: ["研判笔记"], content: "判断" }),
        note({ id: "n2", channel: "COURT" }),
        note({ id: "n3", channel: "WECHAT", withWhom: "王法官" })
      ],
      events: [],
      users: [],
      expresses: []
    });
    const map = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(map["n-n1"].kind).toBe("note");
    expect(map["n-n1"].title).toBe("研判笔记");
    expect(map["n-n2"].kind).toBe("court");
    expect(map["n-n3"].kind).toBe("talk");
    expect(map["n-n3"].title).toBe("微信沟通 · 王法官");
  });

  it("环节归属：笔记自带的「环节:xxx」标签优先于按时间推断", () => {
    const s = stage({ key: "k1", name: "立案" });
    const p = procedure({ stages: [{ ...s, startedAt: inDays(-10) } as never] });
    const items = buildLogItems({
      procedure: p,
      stages: [s],
      notes: [note({ tags: ["环节:开庭审理"], occurredAt: inDays(-1) })],
      events: [],
      users: [],
      expresses: []
    });
    expect(items[0].stageName).toBe("开庭审理"); // 标签优先，不是按时间推出的「立案」
    expect(items[0].stageTag).toBe("开庭审理");
  });

  it("系统事件里，材料/任务/开庭/期限这四类被排除（已在别处呈现，避免同一件事出现两次）", () => {
    const mk = (id: string, eventType: string) => ({ id, eventType, title: `事件${id}`, content: null, occurredAt: inDays(-1) });
    const items = buildLogItems({
      procedure: procedure(),
      stages: [],
      notes: [],
      events: [
        mk("e1", "DOCUMENT_UPLOADED"),
        mk("e2", "TASK_ADDED"),
        mk("e3", "HEARING_SCHEDULED"),
        mk("e4", "DEADLINE_ADDED"),
        mk("e5", "MATTER_STATUS_CHANGED")
      ],
      users: [],
      expresses: []
    });
    expect(items.map((i) => i.key)).toEqual(["e-e5"]);
  });

  it("快递按方向区分「寄出 / 收件」；无快递公司时显示「待识别」", () => {
    const base = { trackingNo: "SF123", lastState: null, lastUpdateAt: null, createdAt: inDays(-1) };
    const items = buildLogItems({
      procedure: procedure(),
      stages: [],
      notes: [],
      events: [],
      users: [],
      expresses: [
        { ...base, id: "x1", direction: "OUTBOUND", purpose: "送达起诉状", companyCode: "SF" },
        { ...base, id: "x2", direction: "INBOUND", purpose: "回执", companyCode: null }
      ] as never
    });
    const map = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(map["x-x1"].title).toBe("寄出：送达起诉状");
    expect(map["x-x2"].title).toBe("收件：回执");
    expect(map["x-x2"].meta).toContain("快递公司待识别");
  });

  it("备忘只收已办的（未办的在待办里）", () => {
    const p = procedure({
      memos: [
        { id: "m1", content: "已办", done: true, doneAt: inDays(-1), createdAt: inDays(-3) },
        { id: "m2", content: "未办", done: false, doneAt: null, createdAt: inDays(-3) }
      ]
    });
    const items = buildLogItems({ procedure: p, stages: [], notes: [], events: [], users: [], expresses: [] });
    expect(items.map((i) => i.key)).toEqual(["m-m1"]);
    expect(items[0].title).toBe("备忘（已办）");
  });

  it("整体按时间**倒序**（最近的记录在最上面）", () => {
    const items = buildLogItems({
      procedure: procedure(),
      stages: [],
      notes: [note({ id: "n-old", occurredAt: inDays(-5) }), note({ id: "n-new", occurredAt: inDays(-1) })],
      events: [{ id: "e1", eventType: "MATTER_STATUS_CHANGED", title: "中间", content: null, occurredAt: inDays(-3) }],
      users: [],
      expresses: []
    });
    expect(items.map((i) => i.key)).toEqual(["n-n-new", "e-e1", "n-n-old"]);
  });
});

describe("documentMatchesStage —— 一份材料算不算某个环节的", () => {
  const doc = (over: Record<string, unknown>) =>
    ({ id: "d1", name: "起诉状.pdf", category: "PLEADING", tags: [], stageId: null, ...over }) as never;

  it("已明确归属某环节的材料，按外键判定，**不再**按名字模式串到别的环节", () => {
    // 这是 v0.48 的规则：外键归属优先，避免同一份材料出现在多个环节
    const target = { id: "s1", name: "立案" };
    const other = { id: "s2", name: "开庭审理" };
    const d = doc({ stageId: "s1", name: "庭审笔录.pdf" }); // 名字像开庭，但归属是立案
    expect(documentMatchesStage(d, target)).toBe(true);
    expect(documentMatchesStage(d, other)).toBe(false);
  });

  it("没有外键归属时，靠「阶段:环节名」标签命中", () => {
    const d = doc({ tags: [stageMaterialTag("开庭审理")] });
    expect(documentMatchesStage(d, { id: null, name: "开庭审理" })).toBe(true);
    expect(documentMatchesStage(d, { id: null, name: "立案" })).toBe(false);
  });

  it("既无外键也无标签时，按指引的文件名模式匹配", () => {
    // 「开庭审理」这一档的 materialPattern 含「开庭|庭审|传票|…」
    expect(documentMatchesStage(doc({ name: "开庭传票.pdf", category: "OTHER" }), { id: null, name: "开庭审理" })).toBe(true);
    // 同一份材料不该被算进「立案」环节
    expect(documentMatchesStage(doc({ name: "开庭传票.pdf", category: "OTHER" }), { id: null, name: "立案" })).toBe(false);
  });

  it("环节名匹配不到任何指引时退回 DEFAULT_STAGE_GUIDE，不会因此把所有材料都算进来", () => {
    // DEFAULT 的 pattern 是 /阶段|说明|记录|底稿|工作/，普通文书不命中
    expect(documentMatchesStage(doc({ name: "答辩状.docx", category: "PLEADING" }), { id: null, name: "某个自定义环节" })).toBe(false);
    // 但命中「说明」的材料仍归它
    expect(documentMatchesStage(doc({ name: "情况说明.docx", category: "OTHER" }), { id: null, name: "某个自定义环节" })).toBe(true);
  });
});

describe("noteStage —— 从 tags 里取「环节:xxx」", () => {
  it("有标签时取冒号后的环节名", () => {
    expect(noteStage({ tags: ["环节:开庭审理"] } as never)).toBe("开庭审理");
  });
  it("没有该标签时返回 null（渲染层再退回按时间推断）", () => {
    expect(noteStage({ tags: ["研判笔记"] } as never)).toBeNull();
    expect(noteStage({ tags: [] } as never)).toBeNull();
  });
});
