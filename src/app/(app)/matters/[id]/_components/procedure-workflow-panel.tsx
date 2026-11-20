"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Archive,
  BookOpen,
  CalendarClock,
  Check,
  CircleDollarSign,
  Clock3,
  FileCheck2,
  FileText,
  FolderOpen,
  Gavel,
  Landmark,
  Lightbulb,
  ListChecks,
  Loader2,
  Mail,
  MessageSquare,
  PenLine,
  Plus,
  Scale,
  ScrollText,
  Shield,
  Stamp,
  StickyNote,
  Truck,
  Sparkles,
  Upload
} from "lucide-react";
import type {
  DocumentCategory,
  DocumentSourceOrigin,
  ProcedureType
} from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { uploadDocument } from "@/server/documents/actions";
import { createTask, toggleTaskCompleted } from "@/server/tasks/actions";
import { TaskEditDialog, type EditableTask } from "./task-edit-dialog";
import { NoteEditDialog, type EditableNote } from "./note-edit-dialog";
import { DocFolderMoveDialog } from "./doc-folder-move-dialog";
import { deleteNote } from "@/server/notes/actions";
import { createProcedureStage, deleteProcedureMemo, ensureProcedureStage, removeProcedureStage, toggleDeadlineCompleted, toggleProcedureMemo } from "@/server/procedures/actions";
import { deleteExpress } from "@/server/express/actions";
import type { ExpressItem } from "./info-extras";
import { AddDeadlineDialog } from "./procedure-forms";
import { liftProperty } from "@/server/preservations/actions-v2";
import { cn, daysUntil, formatCurrency } from "@/lib/utils";
import { litigationStandingLabel, procedureTypeLabel } from "@/lib/enums";
import {
  defaultStageNamesForProcedure,
  normalizeProcedureStageName,
  procedureStagePresetsForProcedure,
  stagePresetForName
} from "@/lib/procedure-stage-defaults";
import { canPreview, officePreviewKind } from "@/lib/storage/mime-ext";
import {
  PreservationCaseDialog,
  AddTargetDialog,
  AddPropertyDialog,
  RenewPropertyDialog
} from "@/app/(app)/preservation/_components/preservation-dialog";
import {
  GUARANTEE_TYPE_CN,
  PRES_STATUS_CN,
  PRES_STATUS_COLOR,
  PRES_TYPE_CN,
  PROPERTY_TYPE_CN,
  classifyExpiry,
  type MatterOption,
  type UserOption
} from "@/app/(app)/preservation/_components/preservation-types";
import { TemplatePickerDialog } from "./template-picker-dialog";
import { AdjustDeadlineDialog } from "./procedure-content";
import { confirmDeadline } from "@/server/deadlines/confirm";
import { DocIcon, EmptyState, SourceChip } from "@/components/patterns/moan";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { documentSourceChip } from "@/lib/ui/moan-tones";
import type { FolderPayload, TemplateSummary } from "./folder-types";
import { confirmDialog } from "@/components/patterns/confirm-dialog";
import { useDocActions } from "./doc-actions-context";
import { EvidencePoints } from "./evidence-panel";
import { evidenceKindLabel } from "@/lib/enums";
import { actionErrorMessage } from "@/lib/action-error";

// 类型 / 常量 / 环节指引表已拆到同目录（2026-11-21）：
//   procedure-workflow-types.ts   类型 + PRESERVATION_ACTIONS / JUDGMENT_NOTE_TAG / stageNoteTag
//   procedure-workflow-guides.ts  环节指引数据表（约 350 行静态映射）
// 这里只保留渲染与交互。
import {
  DOCUMENT_CATEGORY_OPTIONS,
  SOURCE_MATERIAL_CATEGORIES,
} from "./procedure-workflow-guides";
import {
  COURT_PROCEDURE_SOURCE,
  stageNoteTag
} from "./procedure-workflow-types";
import {
  actionWhen,
  buildActionItems,
  defaultInsertTarget,
  formatBytes,
  buildLogItems,
  defaultCategoryForStage,
  documentMatchesStage,
  parseInsertTarget,
  shortDay,
  stageMaterialTag,
  stageChainDate,
  stageGuideFor
} from "./procedure-workflow-derive";
import type {
  ActionItem,
  DossierView,
  LogItem,
  LogKind,
  WaitingItem,
  WorkflowApi,
  WorkflowDocument,
  WorkflowMatter,
  WorkflowItem,
  WorkflowNote,
  WorkflowPreservationCase,
  WorkflowProcedure,
  StageGuide,
  WorkflowStage,
  WorkflowStageSource,
  WorkflowStageStatus,
  WorkflowTask,
  WorkflowTimelineEvent
} from "./procedure-workflow-types";
// 供既有调用方继续从本文件引用（拆分前这些名字就在本文件导出，改动零成本）
export { JUDGMENT_NOTE_TAG, stageNoteTag } from "./procedure-workflow-types";
export type {
  DossierView,
  WaitingItem,
  WorkflowApi,
  WorkflowNote,
  WorkflowPreservationCase
} from "./procedure-workflow-types";

/**
 * 案卷工作台（程序栏之下）：页签 → 各视图。
 * - 案件档案：案件页注入的档案主栏 + 侧栏（承办团队 + 最近待办 / 最近记录）
 * - 办案进程：环节竖列 + 环节操作条 + 待办 + 材料（含证据要点）+ 经办记录（含快递与备忘）
 * - 委托与财务、审批用印：案件页注入
 * 同一份数据只在一处展示：未完成事项只在待办，已发生事项只在经办记录，材料与证据链只在办案进程。
 */
export function ProcedureWorkflowPanel({
  matter,
  procedure,
  documents,
  preservationCases,
  folders,
  templates,
  users,
  canManage,
  notes,
  timelineEvents,
  viewerId,
  onWriteNote,
  apiRef,
  view,
  onViewChange,
  viewCounts,
  archiveNode, responsibilityNode,
  archiveRailTop,
  expresses,
  onAddLedger,
  materialsExtra,
  onCaseSearch,
  financeNode,
  timeNode,
  emailNode,
  sealNode,
  waiting
}: {
  matter: WorkflowMatter;
  procedure: WorkflowProcedure | null;
  documents: WorkflowDocument[];
  preservationCases: WorkflowPreservationCase[];
  folders: FolderPayload[];
  templates: TemplateSummary[];
  users: UserOption[];
  canManage: boolean;
  notes: WorkflowNote[];
  timelineEvents: WorkflowTimelineEvent[];
  onWriteNote: (opts: { judgment: boolean; stageName?: string }) => void;
  apiRef?: React.MutableRefObject<WorkflowApi | null>;
  view: DossierView;
  onViewChange: (view: DossierView) => void;
  viewCounts?: Partial<Record<DossierView, number>>;
  archiveNode: React.ReactNode;
  responsibilityNode?: React.ReactNode;
  /** 案件档案侧栏顶部（承办团队） */
  archiveRailTop?: React.ReactNode;
  /** 快递记录（并入经办记录） */
  expresses?: ExpressItem[];
  /** 「＋记录」中的快递、「＋事项」中的开庭（沿用重要事项弹窗） */
  onAddLedger?: (type: "express" | "hearing" | "deadline") => void;
  /** 类案检索入口（元典已配置时） */
  onCaseSearch?: () => void;
  /** 全部环节范围下材料之后的补充内容（AI 审查总览） */
  materialsExtra?: React.ReactNode;
  financeNode?: React.ReactNode;
  /** 工时页签（P0-1 阶段 1-b，案件页注入） */
  timeNode?: React.ReactNode;
  /** 邮件页签（P1-3，案件页注入） */
  emailNode?: React.ReactNode;
  sealNode?: React.ReactNode;
  waiting?: WaitingItem[];
  /** 当前登录用户 id：经办记录的改/删只对作者本人显示（服务端同口径） */
  viewerId?: string;
}) {
  const router = useRouter();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [taskStage, setTaskStage] = useState<WorkflowStage | null>(null);
  const [stageCreateOpen, setStageCreateOpen] = useState(false);
  const [deadlineOpen, setDeadlineOpen] = useState(false);
  const [uploadSignal, setUploadSignal] = useState(0);
  // 任务编辑（2026-11-22）：updateTask 此前零界面入口
  const [editingTask, setEditingTask] = useState<EditableTask | null>(null);
  // 经办记录编辑（2026-11-22）：updateNote 此前零界面入口
  const [editingNote, setEditingNote] = useState<EditableNote | null>(null);
  const [, startStageRemovalTransition] = useTransition();

  const stages = useMemo(
    () => buildWorkflowStages(procedure, preservationCases),
    [procedure, preservationCases]
  );
  // 保全是贯穿程序的并行事项（在保期间一直「进行中 / 临期」），不作为当前环节
  const mainStages = stages.filter((s) => s.kind !== "preservation");
  const currentStage =
    mainStages.find((s) => s.status === "active" || s.status === "risk") ??
    mainStages.find((s) => s.status === "todo") ??
    mainStages[mainStages.length - 1] ??
    stages[0] ??
    null;
  const selectedStage = stages.find((s) => s.key === selectedKey) ?? currentStage;
  // 2026-09-19 用户确认去掉「总览」：始终以选中环节为范围；没有环节（尚无程序）时才退回全部
  const effectiveScope: "all" | "stage" = selectedStage ? "stage" : "all";
  const actions = useMemo(() => buildActionItems(procedure, stages, users), [procedure, stages, users]);
  const logItems = useMemo(() => buildLogItems({ procedure, stages, notes, events: timelineEvents, users, expresses: expresses ?? [] }), [procedure, stages, notes, timelineEvents, users, expresses]);

  // 切换程序后回到该程序的当前环节
  useEffect(() => {
    setSelectedKey(null);
  }, [procedure?.id]);

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      openUpload: () => {
        if (!selectedStage) {
          toast.info("请先新增程序后再上传材料");
          return;
        }
        setUploadSignal((n) => n + 1);
      },
      openAddTask: () => {
        if (selectedStage) setTaskStage(selectedStage);
        else toast.info("请先新增程序后再添加任务");
      },
      stageNames: stages.map((st) => st.name),
      currentStageName: selectedStage?.name ?? null
    };
  }, [apiRef, selectedStage, stages]);

  function selectStage(key: string) {
    setSelectedKey(key);
  }

  async function handleRemoveStage(stage: WorkflowStage) {
    const stageId = stage.id;
    if (!stageId) {
      toast.info("该环节尚未写入流程，无需移除");
      return;
    }
    if (!stage.removable) {
      toast.warning("必备环节不能移除");
      return;
    }
    if (!(await confirmDialog({ title: `移除环节「${stage.name}」？`, description: "已有任务或材料的环节将被隐藏（数据保留，重新添加同名环节可恢复）。", confirmText: "移除", danger: true }))) return;
    startStageRemovalTransition(async () => {
      try {
        const res = await removeProcedureStage({ id: stageId });
        toast.success(res.hidden ? "环节已隐藏，数据保留（重新添加同名环节可恢复）" : "环节已移除");
        setSelectedKey(null);
        router.refresh();
      } catch (err) {
        toast.error("移除失败", { description: actionErrorMessage(err) });
      }
    });
  }


  const VIEWS: { key: DossierView; label: string; show: boolean; icon: typeof FileText; count?: number; hot?: boolean }[] = [
    { key: "archive", label: "案件档案", show: true, icon: FileText },
    { key: "work", label: "办案进程", show: true, icon: ListChecks, count: actions.length, hot: actions.some((a) => a.days !== null && a.days < 0) },
    { key: "money", label: "委托与财务", show: Boolean(financeNode), icon: CircleDollarSign },
    { key: "time", label: "工时", show: Boolean(timeNode), icon: Clock3 },
    { key: "email", label: "邮件", show: Boolean(emailNode), icon: Mail },
    { key: "seal", label: "审批用印", show: Boolean(sealNode), icon: Stamp, count: viewCounts?.seal }
  ];

  return (
    <>
      <div className="dos-views" role="tablist" aria-label="案件视图">
        {VIEWS.filter((v) => v.show).map((v) => {
          const Icon = v.icon;
          return (
            <button key={v.key} type="button" role="tab" aria-selected={view === v.key} className={cn("dos-view", view === v.key && "on")} onClick={() => onViewChange(v.key)}>
              <Icon strokeWidth={1.9} />
              {v.label}
              {v.count ? <span className={cn("n", v.hot && "hot")}>{v.count}</span> : null}
            </button>
          );
        })}
      </div>

      {/* 侧栏在四个页签间常驻（2026-09-14 用户要求）：承办团队 + 最近待办 + 最近记录 */}
      <div className="dos-work">
        <div className="dos-main">
      {view === "archive" ? archiveNode : null}

      {view === "work" ? (
        <div className="dos-flow">
          <StageLine
            procedure={procedure}
            stages={stages}
            selectedKey={effectiveScope === "stage" ? selectedStage?.key ?? null : null}
            currentKey={currentStage?.key ?? null}
            onSelect={selectStage}
            onAddStage={canManage && procedure ? () => setStageCreateOpen(true) : undefined}
          />
          <div className="dos-main">
          {responsibilityNode}
          {selectedStage && procedure && effectiveScope === "stage" ? (
            <StageBar
              stage={selectedStage}
              procedure={procedure}
              documents={documents}
              notes={notes}
              isCurrent={selectedStage.key === currentStage?.key}
              canManage={canManage}
              onRemoveStage={canManage && selectedStage.removable ? () => handleRemoveStage(selectedStage) : undefined}
            />
          ) : null}
          <div>
            <div className="dos-main">
              {selectedStage?.kind === "preservation" && effectiveScope === "stage" && procedure ? (
                <PreservationWorkflowContent
                  matter={matter}
                  procedure={procedure}
                  stage={selectedStage}
                  cases={preservationCases}
                  documents={documents}
                  users={users}
                  canManage={canManage}
                  onOpenTemplate={() => setTemplateOpen(true)}
                  onAddTask={() => setTaskStage(selectedStage)}
                  onRemoveStage={canManage && selectedStage.removable ? () => handleRemoveStage(selectedStage) : undefined}
                  uploadSignal={0}
                />
              ) : null}
              <MaterialsSection
                matterId={matter.id}
                procedure={procedure}
                stages={stages}
                documents={documents}
                stage={effectiveScope === "stage" ? selectedStage : null}
                canManage={canManage}
                onOpenTemplate={() => setTemplateOpen(true)}
              />
              {materialsExtra}
              <CaseLog
                items={logItems}
                stages={stages}
                procedure={procedure}
                focusStageName={effectiveScope === "stage" ? selectedStage?.name ?? null : null}
                canManage={canManage}
                onWriteRecord={() => onWriteNote({ judgment: false, stageName: selectedStage?.name })}
                onWriteJudgment={() => onWriteNote({ judgment: true, stageName: selectedStage?.name })}
                onAddLedger={canManage && onAddLedger ? () => onAddLedger("express") : undefined}
                onCaseSearch={onCaseSearch}
                viewerId={viewerId}
                onEditNote={(item) =>
                  setEditingNote({
                    id: item.noteId!,
                    matterId: matter.id,
                    content: item.body ?? "",
                    occurredAt: item.at,
                    channel: item.noteChannel ?? "OTHER",
                    withWhom: item.noteWithWhom ?? null,
                    tags: item.noteTags ?? []
                  })
                }
              />
            </div>
          </div>
        </div>
          </div>
      ) : null}

      {view === "money" ? financeNode : null}
      {view === "time" ? timeNode : null}
      {view === "email" ? emailNode : null}
      {view === "seal" ? sealNode : null}
        </div>
        <aside className="dos-rail">
          {archiveRailTop}
          {/* 待办在侧栏（2026-09-16 用户要求）：主栏留给材料与记录；其余页签显示最近待办与记录摘要 */}
          {view === "work" ? (
            <NextActions
              compact
              actions={actions}
              selectedStage={selectedStage}
              scope={effectiveScope}
              canManage={canManage}
              waiting={waiting ?? []}
              onAddTask={procedure && selectedStage ? () => setTaskStage(selectedStage) : undefined}
              onAddDeadline={procedure ? () => setDeadlineOpen(true) : undefined}
              onAddHearing={procedure && onAddLedger ? () => onAddLedger("hearing") : undefined}
              onEditTask={(item) =>
                setEditingTask({
                  id: item.taskId!,
                  matterId: matter.id,
                  title: item.title,
                  description: item.description ?? null,
                  dueAt: item.at,
                  priority: item.priority,
                  stageId: item.stageId ?? null,
                  assigneeId: item.assigneeId ?? null
                })
              }
            />
          ) : (
          <ArchiveGlance
            actions={actions}
            logItems={logItems}
            waiting={waiting ?? []}
            procedureLabel={procedure ? procedure.customLabel ?? procedureTypeLabel[procedure.type] : null}
            onOpenWork={() => onViewChange("work")}
          />
          )}
        </aside>
      </div>

      {/* 环节操作条与页头「上传材料」共用：打开当前选中环节的上传弹窗 */}
      {procedure && selectedStage ? (
        <div hidden>
          <StageMaterialsPanel
            matterId={matter.id}
            procedure={procedure}
            stage={selectedStage}
            documents={[]}
            canManage={canManage}
            uploadSignal={uploadSignal}
          />
        </div>
      ) : null}

      <TemplatePickerDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        matterId={matter.id}
        matterCategory={matter.category}
        folders={folders}
        templates={templates}
      />
      {procedure && taskStage && (
        <TaskQuickDialog
          open={!!taskStage}
          onOpenChange={(open) => !open && setTaskStage(null)}
          matterId={matter.id}
          procedureId={procedure.id}
          stage={taskStage}
          users={users}
          onStageReady={(stageId) => setSelectedKey(`stage-${stageId}`)}
        />
      )}
      {procedure ? (
        <StageCreateDialog
          open={stageCreateOpen}
          onOpenChange={setStageCreateOpen}
          procedureId={procedure.id}
          procedureType={procedure.type}
          stages={stages}
          selectedItem={selectedStage}
          onCreated={(stageId) => setSelectedKey(`stage-${stageId}`)}
        />
      ) : null}
      {procedure && deadlineOpen ? (
        <AddDeadlineDialog
          open={deadlineOpen}
          onOpenChange={setDeadlineOpen}
          procedures={[{ id: procedure.id, label: procedure.customLabel ?? procedureTypeLabel[procedure.type] }]}
          defaultProcedureId={procedure.id}
        />
      ) : null}
      {/* 任务编辑（2026-11-22）：updateTask 此前零界面入口，建错了改不了 */}
      <TaskEditDialog
        open={editingTask !== null}
        onOpenChange={(o) => { if (!o) setEditingTask(null); }}
        task={editingTask}
      />
      {/* 经办记录编辑（2026-11-22）：updateNote 此前零界面入口 */}
      <NoteEditDialog
        open={editingNote !== null}
        onOpenChange={(o) => { if (!o) setEditingNote(null); }}
        note={editingNote}
      />
    </>
  );
}


function StageGlyph({ name, kind, className }: { name: string; kind: WorkflowStage["kind"]; className?: string }) {
  const p = { className, strokeWidth: 1.8 };
  if (kind === "preservation" || name.includes("保全")) return <Shield {...p} />;
  if (name.includes("授权") || name.includes("委托")) return <FileCheck2 {...p} />;
  if (name.includes("研判") || name.includes("分析")) return <Lightbulb {...p} />;
  if (name.includes("证据") || name.includes("举证") || name.includes("质证")) return <BookOpen {...p} />;
  if (name.includes("开庭") || name.includes("庭审") || name.includes("庭")) return <Landmark {...p} />;
  if (name.includes("判决") || name.includes("裁") || name.includes("送达")) return <ScrollText {...p} />;
  if (name.includes("归档") || name.includes("结案")) return <Archive {...p} />;
  if (name.includes("立案") || name.includes("材料") || name.includes("起诉")) return <FolderOpen {...p} />;
  if (name.includes("执行")) return <Gavel {...p} />;
  return <ListChecks {...p} />;
}

const STAGE_STATUS_TEXT: Record<WorkflowStageStatus, string> = {
  done: "已完成",
  active: "进行中",
  risk: "临期风险",
  todo: "待开始",
  not_applicable: "不适用"
};

/** 环节条：选中环节的说明、清单与本环节操作；事项列表在「下一步」，材料在「材料」视图 */
function StageBar({
  stage,
  procedure,
  documents,
  notes,
  isCurrent,
  canManage,
  onRemoveStage
}: {
  stage: WorkflowStage;
  procedure: WorkflowProcedure;
  documents: WorkflowDocument[];
  notes: WorkflowNote[];
  isCurrent: boolean;
  canManage: boolean;
  onRemoveStage?: () => void;
}) {
  const [guideOpen, setGuideOpen] = useState(false);
  const guide = stageGuideFor(stage.name);
  const src = procedure.stages.find((s) => s.id === stage.id);
  const openTasks = stage.tasks.filter((t) => !t.completed).length;
  const docCount = documents.filter((d) => documentMatchesStage(d, stage)).length;
  const noteCount = notes.filter((n) => n.tags.includes(stageNoteTag(stage.name))).length;
  const tone = stage.status === "risk" ? "amber" : stage.status === "done" ? "green" : stage.status === "active" ? "teal" : "slate";

  return (
    <section className="card dos-stage" aria-label={`环节：${stage.name}`}>
      <div className="dos-stage-head">
        <div className="ic-wrap" style={stage.status === "risk" ? { background: "var(--amber-bg)", color: "var(--amber)" } : undefined}>
          <StageGlyph name={stage.name} kind={stage.kind} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="dos-stage-name">{stage.name}</h2>
            <span className={cn("badge", `b-${tone}`)}>
              <span className="bdot" />
              {STAGE_STATUS_TEXT[stage.status]}
            </span>
            {!isCurrent ? <span className="t-xs t-mute">（非当前环节）</span> : null}
          </div>
          <div className="dos-stage-meta">
            {[
              src?.startedAt ? `开始 ${shortDay(src.startedAt)}` : null,
              src?.completedAt ? `完成 ${shortDay(src.completedAt)}` : null,
              `未完成事项 ${openTasks}`,
              `研判 ${noteCount}`
            ]
              .filter(Boolean)
              .join(" · ")}
            {` · 材料 ${docCount} 份`}
          </div>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setGuideOpen((v) => !v)} aria-expanded={guideOpen}>
          {guideOpen ? "收起说明" : "环节说明"}
        </button>
      </div>
      {guideOpen ? <StageGuideBody guide={guide} /> : <p className="dos-stage-summary">{guide.summary}</p>}
      {canManage && onRemoveStage ? (
        <div className="dos-stage-acts">
          <button type="button" className="btn btn-ghost btn-sm text-[var(--t-muted)]" onClick={onRemoveStage}>
            移除环节
          </button>
        </div>
      ) : null}
    </section>
  );
}

function StageGuideBody({ guide }: { guide: StageGuide }) {
  return (
    <div className="mx-4 mb-3 rounded-[8px] bg-[var(--bg-sunken)] px-3 py-2.5">
      <div className="text-[11.5px] font-semibold text-[var(--t-secondary)]">{guide.checklistTitle}</div>
      <ul className="mt-1.5 space-y-1">
        {guide.checklist.map((item) => (
          <li key={item} className="flex items-start gap-2 text-[12px] leading-5 text-[var(--t-secondary)]">
            <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-[var(--teal)]" />
            {item}
          </li>
        ))}
      </ul>
      {guide.actions.length > 0 ? (
        <p className="mt-1.5 text-[11px] leading-5 text-[var(--t-muted)]">常用文书：{guide.actions.join("、")}（在「从模板生成」中选用）</p>
      ) : null}
    </div>
  );
}


/** 研判笔记归属环节（tags「环节:xxx」） */



const EVENT_TONE: Record<string, { bg: string; fg: string; icon: typeof FileText }> = {
  FEE_RECEIVED: { bg: "var(--green-bg)", fg: "var(--green)", icon: CircleDollarSign },
  DOCUMENT_UPLOADED: { bg: "var(--blue-bg)", fg: "var(--blue)", icon: FileText },
  HEARING_SCHEDULED: { bg: "var(--blue-bg)", fg: "var(--blue)", icon: Landmark },
  DEADLINE_ADDED: { bg: "var(--amber-bg)", fg: "var(--amber)", icon: CalendarClock },
  MATTER_ARCHIVED: { bg: "var(--bronze-bg)", fg: "var(--bronze)", icon: Archive },
  MATTER_ARCHIVE_REQUESTED: { bg: "var(--bronze-bg)", fg: "var(--bronze)", icon: Archive },
  MATTER_CLOSED: { bg: "var(--green-bg)", fg: "var(--green)", icon: Check }
};

/* ------------------------------------------------------------------ */
/* 环节线：当前程序的全部环节，末尾是「＋ 添加环节」                     */
/* ------------------------------------------------------------------ */

function StageLine({
  procedure,
  stages,
  selectedKey,
  currentKey,
  onSelect,
  onAddStage
}: {
  procedure: WorkflowProcedure | null;
  stages: WorkflowStage[];
  selectedKey: string | null;
  currentKey: string | null;
  onSelect: (key: string) => void;
  onAddStage?: () => void;
}) {
  if (!procedure) {
    return (
      <nav className="card dos-vline" aria-label="办案环节">
        <div className="dos-vline-head">
          <span className="t">办案环节</span>
        </div>
        <p className="t-xs t-mute" style={{ padding: "4px 14px 14px" }}>暂无在办程序，请在上方程序栏新增程序。</p>
      </nav>
    );
  }
  const currentIndex = stages.findIndex((s) => s.key === currentKey);
  const hearingStageKey = (stages.find((s) => /开庭|庭审|询问/.test(s.name)) ?? stages.find((s) => stageGuideFor(s.name).includeHearings))?.key ?? null;
  const nextHearing = [...procedure.hearings].filter((h) => daysUntil(h.startsAt) >= 0).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0] ?? null;

  function flagFor(stage: WorkflowStage): { text: string; tone: "red" | "amber" | "blue" } | null {
    const guide = stageGuideFor(stage.name);
    const overdue =
      stage.tasks.filter((t) => !t.completed && t.dueAt && daysUntil(t.dueAt) < 0).length +
      procedure!.deadlines.filter((d) => !d.completed && guide.deadlineCategories.includes(d.category) && daysUntil(d.dueAt) < 0).length;
    if (overdue > 0) return { text: `逾期 ${overdue}`, tone: "red" };
    if (stage.kind === "preservation" && stage.badge?.hot) return { text: `${stage.badge.text.split(" · ")[1] ?? "临期"}到期`, tone: "amber" };
    if (stage.key === hearingStageKey && nextHearing) return { text: `开庭 ${shortDay(nextHearing.startsAt)}`, tone: "blue" };
    const soon = procedure!.deadlines
      .filter((d) => !d.completed && guide.deadlineCategories.includes(d.category))
      .map((d) => daysUntil(d.dueAt))
      .filter((n) => n >= 0 && n <= 7);
    if (soon.length) return { text: `剩 ${Math.min(...soon)} 天`, tone: "amber" };
    return null;
  }

  return (
    <nav className="card dos-vline" aria-label="办案环节">
      <div className="dos-vline-head">
        <span className="t">办案环节</span>
        <span className="t-xs t-mute">
          {currentIndex >= 0 ? `第 ${currentIndex + 1}/${stages.length}` : `${stages.length} 个`} · 已完成 {stages.filter((s) => s.status === "done").length}
        </span>
      </div>
      <ol className="dos-vline-list">
        {stages.map((stage, i) => {
          const state = stage.status === "done" ? "done" : stage.key === currentKey ? "cur" : stage.status === "risk" ? "risk" : "todo";
          const flag = flagFor(stage);
          const date = stageChainDate(stage, procedure);
          const openTasks = stage.tasks.filter((t) => !t.completed).length;
          return (
            <li key={stage.key} className={cn("dos-vnode", state, stage.key === selectedKey && "sel", i < currentIndex && "passed")}>
              <button type="button" onClick={() => onSelect(stage.key)} aria-current={stage.key === selectedKey ? "step" : undefined} title={`${stage.name} · ${STAGE_STATUS_TEXT[stage.status]}`}>
                <span className="pin" aria-hidden>{state === "done" ? <Check strokeWidth={3} /> : null}</span>
                <span className="body">
                  <span className="nm">
                    {stage.name}
                    {state === "cur" ? <span className="now">当前</span> : null}
                  </span>
                  <span className="sub">
                    {flag ? <span className={cn("dos-flag", flag.tone)}>{flag.text}</span> : null}
                    <span className="dt">{date ?? (openTasks ? `${openTasks} 项待办` : "—")}</span>
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {onAddStage ? (
          <li className="dos-vnode add">
            <button type="button" onClick={onAddStage}>
              <span className="pin" aria-hidden>
                <Plus strokeWidth={2.6} />
              </span>
              <span className="body">
                <span className="nm">添加环节</span>
                <span className="sub">
                  <span className="dt">可插入任意位置</span>
                </span>
              </span>
            </button>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

/** 一个按钮 + 类型菜单：待办用「＋事项」，记录用「＋记录」（2026-09-15 入口合并） */
function AddMenu({
  label,
  primary,
  items
}: {
  label: string;
  primary?: boolean;
  items: { key: string; label: string; hint: string; icon: typeof Plus; onSelect: () => void }[];
}) {
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn("btn btn-sm", primary ? "btn-primary" : "btn-secondary")}>
          <Plus />
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <DropdownMenuItem key={item.key} onSelect={item.onSelect} className="items-start gap-2.5 py-2">
              <Icon className="mt-0.5 h-4 w-4 text-[var(--t-muted)]" strokeWidth={1.8} />
              <span className="flex flex-col">
                <span className="text-[13px] font-medium">{item.label}</span>
                <span className="text-[11px] text-muted-foreground">{item.hint}</span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ------------------------------------------------------------------ */
/* 待办：只放未完成的任务、法定期限与开庭                               */
/* ------------------------------------------------------------------ */




function NextActions({
  compact = false,
  actions,
  selectedStage,
  scope,
  canManage,
  waiting,
  onAddTask,
  onAddDeadline,
  onAddHearing,
  onEditTask
}: {
  /** 侧栏紧凑排布（办案进程页签） */
  compact?: boolean;
  actions: ActionItem[];
  selectedStage: WorkflowStage | null;
  scope: "all" | "stage";
  canManage: boolean;
  waiting: WaitingItem[];
  onAddTask?: () => void;
  /** 任务编辑入口（2026-11-22）：由主面板持有状态并渲染对话框 */
  onEditTask?: (item: ActionItem) => void;
  onAddDeadline?: () => void;
  onAddHearing?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showLater, setShowLater] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const [adjusting, setAdjusting] = useState<{ id: string; title: string; dueAt: Date } | null>(null);
  const inScope = scope === "stage" && selectedStage ? actions.filter((i) => i.stageKey === selectedStage.key) : actions;
  const overdue = inScope.filter((i) => i.days !== null && i.days < 0);
  const soon = inScope.filter((i) => i.days !== null && i.days >= 0 && i.days <= 7);
  const later = inScope.filter((i) => i.days === null || i.days > 7);
  const others = scope === "stage" && selectedStage ? actions.filter((i) => i.stageKey !== selectedStage.key) : [];
  const othersOverdue = others.filter((i) => i.days !== null && i.days < 0).length;

  function run(action: () => Promise<unknown>, ok: string) {
    startTransition(async () => {
      try {
        await action();
        toast.success(ok);
        router.refresh();
      } catch (err) {
        toast.error("操作失败", { description: actionErrorMessage(err) });
      }
    });
  }

  async function completeDeadline(item: ActionItem) {
    if (!item.deadlineId) return;
    if (!(await confirmDialog({ title: `标记「${item.title}」已完成？`, description: "法定期限完成后不再提醒，会记入记录。", confirmText: "标记完成" }))) return;
    run(() => toggleDeadlineCompleted(item.deadlineId!), "期限已标记完成");
  }

  const row = (item: ActionItem, other = false) => {
    const when = actionWhen(item);
    if (compact) {
      const kindMeta =
        item.kind === "deadline"
          ? { label: "期限", cls: "k-deadline", Icon: Scale }
          : item.kind === "hearing"
            ? { label: "开庭", cls: "k-hearing", Icon: Landmark }
            : item.kind === "memo"
              ? { label: "备忘", cls: "k-memo", Icon: StickyNote }
              : { label: "任务", cls: "k-task", Icon: ListChecks };
      const KindIcon = kindMeta.Icon;
      return (
        <div key={item.key} className={cn("dos-act-c", when.tone, other && "other")}>
          <span className="bar" aria-hidden />
          <span className={cn("ki", kindMeta.cls)} title={kindMeta.label} aria-label={kindMeta.label}>
            <KindIcon strokeWidth={2} />
          </span>
          <div className="body">
            <div className="top">
              <span className="t">{item.title}</span>
              <span className="w">{when.main}</span>
            </div>
            <div className="bot">
              <span className="m">
                {[other || scope === "all" ? item.stageName : null, when.sub, item.meta || null].filter(Boolean).join(" · ") || "\u00a0"}
              </span>
              <span className="ops">
                {canManage && item.kind === "task" && item.taskId ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={pending}
                      onClick={() => onEditTask?.(item)}
                    >
                      改
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(() => toggleTaskCompleted(item.taskId!), "任务已完成，已记入记录")}>
                      完成
                    </button>
                  </>
                ) : null}
                {canManage && item.kind === "memo" && item.memoId ? (
                  <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(() => toggleProcedureMemo(item.memoId!), "已办结，转入记录")}>
                    办结
                  </button>
                ) : null}
                {canManage && item.kind === "deadline" && item.deadlineId ? (
                  <>
                    {item.pendingConfirm ? (
                      <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(() => confirmDeadline({ id: item.deadlineId! }), "期限已确认")}>
                        确认
                      </button>
                    ) : null}
                    <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => item.at && setAdjusting({ id: item.deadlineId!, title: item.title, dueAt: item.at })}>
                      调整
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => completeDeadline(item)}>
                      完成
                    </button>
                  </>
                ) : null}
              </span>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div key={item.key} className={cn("dos-act", when.tone)}>
        <i className="sev" aria-hidden />
        <div className="when">
          <b>{when.main}</b>
          <span>{when.sub}</span>
        </div>
        <div className="what">
          <div className="t">
            {item.title}
            {item.kind === "deadline" ? <span className="badge b-outline-red" style={{ fontSize: 10 }}>法定期限</span> : null}
            {item.kind === "hearing" ? <span className="badge b-blue" style={{ fontSize: 10 }}>开庭</span> : null}
            {item.kind === "task" && item.priority === 2 ? <span className="badge b-red" style={{ fontSize: 10 }}>紧急</span> : null}
            {item.kind === "memo" ? <span className="badge b-slate" style={{ fontSize: 10 }}>备忘</span> : null}
            {item.pendingConfirm ? <span className="badge b-amber" style={{ fontSize: 10 }}>期限待确认</span> : null}
          </div>
          <div className="d">{[scope === "all" ? item.stageName : null, item.meta || null].filter(Boolean).join(" · ") || " "}</div>
        </div>
        <div className="op">
          {canManage && item.kind === "task" && item.taskId ? (
            <button type="button" className={cn("btn btn-sm", when.tone === "red" ? "btn-primary" : "btn-secondary")} disabled={pending} onClick={() => run(() => toggleTaskCompleted(item.taskId!), "任务已完成，已记入记录")}>
              完成
            </button>
          ) : null}
          {canManage && item.kind === "memo" && item.memoId ? (
            <>
              <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => run(() => toggleProcedureMemo(item.memoId!), "已办结，转入记录")}>
                办结
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm text-[var(--t-muted)]"
                disabled={pending}
                onClick={async () => {
                  if (!(await confirmDialog({ title: "删除这条备忘？", confirmText: "删除", danger: true }))) return;
                  run(() => deleteProcedureMemo(item.memoId!), "已删除");
                }}
              >
                删除
              </button>
            </>
          ) : null}
          {canManage && item.kind === "deadline" && item.deadlineId ? (
            <>
              {item.pendingConfirm ? (
                <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => run(() => confirmDeadline({ id: item.deadlineId! }), "期限已确认")}>
                  确认
                </button>
              ) : null}
              <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => item.at && setAdjusting({ id: item.deadlineId!, title: item.title, dueAt: item.at })}>
                调整
              </button>
              <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => completeDeadline(item)}>
                完成
              </button>
            </>
          ) : null}
        </div>
      </div>
    );
  };

  const empty = overdue.length + soon.length + later.length === 0;

  return (
    <section className={cn("card", compact && "dos-todo-rail")} aria-label="待办">
      <div className={cn("panel-head flex-wrap", compact && "rail-sec-head")}>
        <div className={compact ? "flex items-center gap-2" : "panel-title"}>
          <ListChecks className={compact ? "h-[15px] w-[15px] text-[var(--t-muted)]" : "ic"} strokeWidth={1.8} />
          待办
          {compact ? (
            <span className="t-xs t-mute" style={{ fontWeight: 400 }}>{scope === "stage" && selectedStage ? selectedStage.name : "全部环节"}</span>
          ) : (
            <span className="t-xs t-mute" style={{ fontWeight: 400 }}>{scope === "stage" && selectedStage ? selectedStage.name : "全部环节"}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canManage ? (
            <AddMenu
              label="事项"
              items={[
                ...(onAddTask ? [{ key: "task", label: "任务", hint: "要做的事，可指派负责人与截止日", icon: ListChecks, onSelect: onAddTask }] : []),
                ...(onAddDeadline ? [{ key: "deadline", label: "期限", hint: "法定或约定期限，带起算依据与确认", icon: Scale, onSelect: onAddDeadline }] : []),
                ...(onAddHearing ? [{ key: "hearing", label: "开庭", hint: "时间、法庭与地址，同时进日程", icon: Landmark, onSelect: onAddHearing }] : [])
              ]}
            />
          ) : null}
        </div>
      </div>

      {empty && waiting.length === 0 ? (
        <EmptyState compact title={scope === "stage" ? "本环节没有待办" : "没有待办"} />
      ) : null}
      {overdue.length ? (
        <div className="dos-lane">
          <div className={cn("dos-lane-h red", compact && "chip")}>已逾期 · {overdue.length}</div>
          {overdue.map((i) => row(i))}
        </div>
      ) : null}
      {soon.length ? (
        <div className="dos-lane">
          <div className={cn("dos-lane-h", compact && "chip amber")}>7 天内 · {soon.length}</div>
          {soon.map((i) => row(i))}
        </div>
      ) : null}
      {later.length ? (
        <div className="dos-lane">
          <button type="button" className={cn("dos-lane-h as-btn", compact && "chip slate")} onClick={() => setShowLater((v) => !v)} aria-expanded={showLater}>
            之后 · {later.length} {showLater ? "（收起）" : "（展开）"}
          </button>
          {showLater ? later.map((i) => row(i)) : null}
        </div>
      ) : null}
      {/* 其他环节的待办：同一模块内弱化陈列，默认折叠（2026-09-16 用户要求） */}
      {others.length ? (
        <div className="dos-lane others">
          <div className="dos-others-h">
            <span className={cn("chip", othersOverdue && "hot")}>
              其他环节 · {others.length}
              {othersOverdue ? `（逾期 ${othersOverdue}）` : ""}
            </span>
            <button type="button" className="more" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}>
              {showOthers ? "收起" : "展开"}
            </button>
          </div>
          {showOthers ? others.map((i) => row(i, true)) : null}
        </div>
      ) : null}
      {waiting.length ? (
        <div className="dos-lane">
          <div className={cn("dos-lane-h", compact && "chip teal")}>等待他人 · {waiting.length}</div>
          {waiting.map((w) => compact ? (
            <div key={w.key} className="dos-act-c teal">
              <span className="bar" aria-hidden />
              <span className="ki k-approval" aria-label="审批">
                <Stamp strokeWidth={2} />
              </span>
              <div className="body">
              <div className="top">
                <span className="t">{w.title}</span>
                <span className="w">审批中</span>
              </div>
              <div className="bot">
                <span className="m">{w.meta}</span>
                <span className="ops">
                  {w.onOpen ? (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={w.onOpen}>
                      查看
                    </button>
                  ) : null}
                </span>
              </div>
              </div>
            </div>
          ) : (
            <div key={w.key} className="dos-act teal">
              <i className="sev" aria-hidden />
              <div className="when">
                <b>审批中</b>
                <span />
              </div>
              <div className="what">
                <div className="t">{w.title}</div>
                <div className="d">{w.meta}</div>
              </div>
              <div className="op">
                {w.onOpen ? (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={w.onOpen}>
                    查看
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {adjusting ? (
        <AdjustDeadlineDialog
          deadline={adjusting}
          onClose={() => {
            setAdjusting(null);
            router.refresh();
          }}
        />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 经办记录：只放已发生的事——沟通、研判、完成的任务、已开庭、系统事件    */
/* ------------------------------------------------------------------ */



const LOG_FILTERS: { key: "all" | LogKind; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "talk", label: "沟通" },
  { key: "court", label: "法院" },
  { key: "note", label: "研判" },
  { key: "task", label: "完成的事项" },
  { key: "express", label: "快递" },
  { key: "sys", label: "系统" }
];

function LogRow({
  item,
  canManage,
  viewerId,
  onEditNote
}: {
  item: LogItem;
  canManage?: boolean;
  viewerId?: string;
  onEditNote?: (item: LogItem) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  function run(fn: () => Promise<unknown>, ok: string) {
    startTransition(async () => {
      try {
        await fn();
        toast.success(ok);
        router.refresh();
      } catch (err) {
        toast.error("操作失败", { description: actionErrorMessage(err) });
      }
    });
  }
  // 经办记录：只有作者本人能改/删（服务端同口径："只能编辑/删除自己的沟通记录"）
  const noteOwned = Boolean(item.noteId && viewerId && item.noteAuthorId === viewerId);
  const noteOps = noteOwned ? (
    <div className="dos-log-ops">
      <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => onEditNote?.(item)}>
        改
      </button>
      <button
        type="button"
        className="btn btn-ghost btn-sm text-[var(--t-muted)]"
        disabled={pending}
        onClick={async () => {
          if (
            !(await confirmDialog({
              title: "删除这条记录？",
              description: "记录删除后不再出现在卷宗里，操作会写入审计。",
              confirmText: "删除",
              danger: true
            }))
          )
            return;
          run(() => deleteNote(item.noteId!), "记录已删除");
        }}
      >
        删除
      </button>
    </div>
  ) : null;

  const ledgerOps =
    canManage && (item.memo || item.express) ? (
      <div className="dos-log-ops">
        {item.memo ? (
          <button type="button" className="btn btn-ghost btn-sm" disabled={pending} onClick={() => run(() => toggleProcedureMemo(item.memo!.id), item.memo!.done ? "已恢复为待办" : "备忘已办结")}>
            {item.memo.done ? "恢复" : "办结"}
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm text-[var(--t-muted)]"
          disabled={pending}
          onClick={async () => {
            if (!(await confirmDialog({ title: item.memo ? "删除这条备忘？" : "删除这条快递记录？", confirmText: "删除", danger: true }))) return;
            run(() => (item.memo ? deleteProcedureMemo(item.memo.id) : deleteExpress({ id: item.express!.id })), "已删除");
          }}
        >
          删除
        </button>
      </div>
    ) : null;
  if (item.kind === "note") {
    return (
      <div className="rec">
        <div className="rec-ic" style={{ background: "var(--violet-bg)", color: "var(--violet)" }}>
          <PenLine strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="rec-title">
            研判笔记
            {item.stageTag ? <span className="badge b-white" style={{ fontSize: 9.5, padding: "0 6px", marginLeft: 6 }}>{item.stageTag}</span> : null}
            <span className="badge b-violet" style={{ fontSize: 9.5, padding: "0 6px", marginLeft: 6 }}>人工判断</span>
          </div>
          <div className="rec-note whitespace-pre-wrap">{item.body}</div>
          <div className="rec-meta">{item.meta}</div>
        </div>
        {noteOps}
      </div>
    );
  }
  const tone =
    item.kind === "express"
      ? { bg: item.express?.outbound ? "var(--amber-bg)" : "var(--green-bg)", fg: item.express?.outbound ? "var(--amber)" : "var(--green)", icon: Truck }
      : item.kind === "memo"
        ? { bg: "var(--slate-bg)", fg: "var(--slate)", icon: StickyNote }
        : item.kind === "court"
      ? { bg: "var(--bronze-bg)", fg: "var(--bronze)", icon: Landmark }
      : item.kind === "talk"
        ? { bg: "var(--teal-soft)", fg: "var(--teal-deep)", icon: MessageSquare }
        : item.kind === "task"
          ? { bg: "var(--green-bg)", fg: "var(--green)", icon: Check }
          : EVENT_TONE[item.eventType ?? ""] ?? { bg: "var(--slate-bg)", fg: "var(--slate)", icon: ListChecks };
  const Icon = tone.icon;
  return (
    <div className="rec">
      <div className="rec-ic" style={{ background: tone.bg, color: tone.fg }}>
        <Icon strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="rec-title">{item.title}</div>
        {item.body ? <div className={cn("dos-note-text whitespace-pre-wrap", item.memo?.done && "line-through text-[var(--t-muted)]")}>{item.body}</div> : null}
        <div className="rec-meta">{item.meta}</div>
      </div>
      {noteOps}
      {ledgerOps}
    </div>
  );
}

function CaseLog({
  items,
  stages,
  procedure,
  focusStageName,
  canManage,
  onWriteRecord,
  onWriteJudgment,
  onAddLedger,
  onCaseSearch,
  viewerId,
  onEditNote
}: {
  viewerId?: string;
  onEditNote?: (item: LogItem) => void;
  onAddLedger?: (type: "express") => void;
  onCaseSearch?: () => void;
  items: LogItem[];
  stages: WorkflowStage[];
  procedure: WorkflowProcedure | null;
  focusStageName: string | null;
  canManage: boolean;
  onWriteRecord: () => void;
  onWriteJudgment: () => void;
}) {
  const [filter, setFilter] = useState<"all" | LogKind>("all");
  const [expanded, setExpanded] = useState(false);

  // 去掉「总览」后，未归环节的记录（快递、程序级事件等）若只按环节过滤就再也看不到
  const scoped = focusStageName ? items.filter((e) => e.stageName === focusStageName || !e.stageName) : items;
  const shown = scoped.filter((e) => filter === "all" || e.kind === filter);
  const order = [...stages.map((s) => s.name)].reverse();
  const groups = new Map<string, LogItem[]>();
  for (const e of shown) {
    const key = e.stageName && order.includes(e.stageName) ? e.stageName : "__none";
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const segs = [...order.filter((n) => groups.has(n)), ...(groups.has("__none") ? ["__none"] : [])].map((name) => ({ name, items: groups.get(name) ?? [] }));
  const visibleSegs = expanded ? segs : segs.slice(0, 3);

  const stageMeta = (name: string) => {
    const stage = stages.find((s) => s.name === name);
    const src = stage?.id ? procedure?.stages.find((s) => s.id === stage.id) : null;
    const period = src?.startedAt ? `${shortDay(src.startedAt)} — ${src.completedAt ? shortDay(src.completedAt) : ""}` : "";
    return { status: stage ? STAGE_STATUS_TEXT[stage.status] : "", period };
  };

  return (
    <section className="card" aria-label="记录">
      <div className="panel-head flex-wrap">
        <div className="panel-title">
          <BookOpen className="ic" strokeWidth={1.8} />
          记录
          <span className="t-xs t-mute" style={{ fontWeight: 400 }}>{focusStageName ?? "全部环节"}</span>
        </div>
        <div className="flex items-center gap-[7px]">
        {onCaseSearch ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCaseSearch}>
            <Scale />
            类案检索
          </button>
        ) : null}
        {canManage ? (
          <AddMenu
            label="记录"
            items={[
              { key: "talk", label: "沟通", hint: "电话、微信、邮件、会见、法院沟通", icon: MessageSquare, onSelect: onWriteRecord },
              ...(onAddLedger ? [{ key: "express", label: "快递", hint: "填单号，物流状态自动更新", icon: Truck, onSelect: () => onAddLedger("express") }] : []),
              { key: "judgment", label: "研判", hint: "我的判断与分析，独立样式陈列", icon: PenLine, onSelect: onWriteJudgment }
            ]}
          />
        ) : null}
        </div>
      </div>
      <div className="dos-log-filters" role="group" aria-label="记录筛选">
        {LOG_FILTERS.map((f) => {
          const count = f.key === "all" ? scoped.length : scoped.filter((e) => e.kind === f.key).length;
          return (
            <button key={f.key} type="button" className={cn("dos-filter", filter === f.key && "on")} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}
              {count ? <span>{count}</span> : null}
            </button>
          );
        })}
      </div>
      {segs.length === 0 ? (
        <EmptyState compact title={focusStageName ? "本环节暂无记录" : "暂无记录"} description="沟通、法院、研判、快递都记在这里" />
      ) : (
        visibleSegs.map((seg) => {
          const meta = seg.name === "__none" ? { status: "", period: "" } : stageMeta(seg.name);
          return (
            <div key={seg.name} className="dos-seg">
              <div className="dos-seg-h">
                <span className="nm">{seg.name === "__none" ? "收案及其他" : seg.name}</span>
                {meta.status ? <span className="st">{meta.status}</span> : null}
                <span className="rule" />
                {meta.period ? <span className="pd">{meta.period}</span> : null}
                <span className="pd">{seg.items.length} 条</span>
              </div>
              {seg.items.map((e) => (
                <LogRow key={e.key} item={e} canManage={canManage} viewerId={viewerId} onEditNote={onEditNote} />
              ))}
            </div>
          );
        })
      )}
      {segs.length > visibleSegs.length ? (
        <button type="button" className="dos-more" onClick={() => setExpanded(true)}>
          展开更早的 {segs.length - visibleSegs.length} 个环节
        </button>
      ) : null}
    </section>
  );
}

/** 案件档案右侧提醒：最近待办 + 最近记录，只做提醒，完整内容在办案进程 */
function ArchiveGlance({
  actions,
  logItems,
  waiting,
  procedureLabel,
  onOpenWork
}: {
  actions: ActionItem[];
  logItems: LogItem[];
  waiting: WaitingItem[];
  procedureLabel: string | null;
  onOpenWork: () => void;
}) {
  const overdue = actions.filter((a) => a.days !== null && a.days < 0).length;
  return (
    <>
      <div className="card">
        <div className="rail-sec-head">
          <ListChecks className="h-[15px] w-[15px] text-[var(--t-muted)]" strokeWidth={1.8} />
          最近待办
          {procedureLabel ? <span className="t-xs t-mute" style={{ fontWeight: 400 }}>{procedureLabel}</span> : null}
          <button type="button" className="link border-0 bg-transparent p-0" onClick={onOpenWork}>
            全部 {actions.length + waiting.length}
          </button>
        </div>
        {actions.length === 0 && waiting.length === 0 ? (
          <div className="panel-body t-xs t-mute">没有待办</div>
        ) : (
          <>
            {overdue > 0 ? <div className="dos-glance-alert">已逾期 {overdue} 项</div> : null}
            {actions.slice(0, 3).map((a) => {
              const when = actionWhen(a);
              return (
                <button key={a.key} type="button" className="dos-glance-row" onClick={onOpenWork}>
                  <span className={cn("w", when.tone)}>{when.main}</span>
                  <span className="t">{a.title}</span>
                </button>
              );
            })}
            {waiting.slice(0, actions.length >= 3 ? 0 : 3 - actions.length).map((w) => (
              <button key={w.key} type="button" className="dos-glance-row" onClick={w.onOpen ?? onOpenWork}>
                <span className="w teal">审批中</span>
                <span className="t">{w.title}</span>
              </button>
            ))}
          </>
        )}
      </div>
      <div className="card">
        <div className="rail-sec-head">
          <BookOpen className="h-[15px] w-[15px] text-[var(--t-muted)]" strokeWidth={1.8} />
          最近记录
          <button type="button" className="link border-0 bg-transparent p-0" onClick={onOpenWork}>
            全部 {logItems.length}
          </button>
        </div>
        {logItems.length === 0 ? (
          <div className="panel-body t-xs t-mute">暂无记录</div>
        ) : (
          logItems.slice(0, 3).map((l) => (
            <button key={l.key} type="button" className="dos-glance-row col" onClick={onOpenWork}>
              <span className="t">{l.title}</span>
              {l.body ? <span className="b">{l.body}</span> : null}
              <span className="m">{l.meta}</span>
            </button>
          ))
        )}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 材料：随环节范围展示（本环节带上传与来源筛选，全部环节按环节分组）   */
/* ------------------------------------------------------------------ */

function MaterialsSection({
  matterId,
  procedure,
  stages,
  documents,
  stage,
  canManage,
  onOpenTemplate
}: {
  matterId: string;
  procedure: WorkflowProcedure | null;
  stages: WorkflowStage[];
  documents: WorkflowDocument[];
  /** null = 全部环节 */
  stage: WorkflowStage | null;
  canManage: boolean;
  onOpenTemplate: () => void;
}) {
  const { onAddEvidence, unlinkedEvidence } = useDocActions();
  if (!procedure) return null;
  if (stage) {
    // 去掉「总览」后，任何环节都匹配不上的材料会失去入口，故在环节材料下方常驻一段兜底
    const orphans = documents.filter((d) => !stages.some((st) => documentMatchesStage(d, st)));
    return (
      <>
        <StageMaterialsPanel
          key={stage.key}
          matterId={matterId}
          procedure={procedure}
          stage={stage}
          documents={documents.filter((d) => documentMatchesStage(d, stage))}
          canManage={canManage}
          onOpenTemplate={onOpenTemplate}
        />
        {orphans.length || unlinkedEvidence?.length ? (
          <div className="card">
            <div className="panel-head">
              <div className="panel-title">
                <FolderOpen className="ic" strokeWidth={1.8} />
                未归入环节
                <span className="badge b-white" style={{ marginLeft: 2 }}>{orphans.length + (unlinkedEvidence?.length ?? 0)}</span>
                <span className="t-xs t-mute" style={{ fontWeight: 400 }}>未匹配到环节的材料与未挂材料的证据要点</span>
              </div>
            </div>
            {orphans.map((d) => <DocRow key={d.id} doc={d} />)}
            {unlinkedEvidence?.length ? (
              <div className="dos-seg">
                <div className="dos-seg-h">
                  <span className="nm">未挂材料的证据要点</span>
                  <span className="rule" />
                  <span className="pd">{unlinkedEvidence.length} 条</span>
                </div>
                <div className="dos-doc-evbox flat">
                  <EvidencePoints items={unlinkedEvidence} showSource />
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </>
    );
  }
  // 全部环节下每份材料只出现一次：归到第一个匹配的环节（外键归属优先，模式匹配可能命中多个环节）
  const homeOf = new Map<string, string>();
  for (const d of documents) {
    const home = stages.find((st) => st.id && d.stageId === st.id) ?? stages.find((st) => documentMatchesStage(d, st));
    if (home) homeOf.set(d.id, home.key);
  }
  const unassigned = documents.filter((d) => !homeOf.has(d.id));
  return (
    <div className="card">
      <div className="panel-head">
        <div className="panel-title">
          <FolderOpen className="ic" strokeWidth={1.8} />
          材料
          <span className="badge b-white" style={{ marginLeft: 2 }}>{documents.length}</span>
          <span className="t-xs t-mute" style={{ fontWeight: 400 }}>全部环节</span>
        </div>
        {onAddEvidence ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAddEvidence(null)}>
            ＋证据要点
          </button>
        ) : null}
      </div>
      {documents.length === 0 ? <EmptyState compact icon={FileText} title="暂无材料" description="选择环节后上传，材料会归入该环节。" /> : null}
      {stages.map((s) => {
        const docs = documents.filter((d) => homeOf.get(d.id) === s.key);
        if (!docs.length) return null;
        return (
          <div key={s.key} className="dos-seg">
            <div className="dos-seg-h">
              <span className="nm">{s.name}</span>
              <span className="rule" />
              <span className="pd">{docs.length} 份</span>
            </div>
            {docs.map((d) => <DocRow key={d.id} doc={d} />)}
          </div>
        );
      })}
      {unassigned.length ? (
        <div className="dos-seg">
          <div className="dos-seg-h">
            <span className="nm">未归入环节</span>
            <span className="rule" />
            <span className="pd">{unassigned.length} 份</span>
          </div>
          {unassigned.map((d) => <DocRow key={d.id} doc={d} />)}
        </div>
      ) : null}
      {unlinkedEvidence?.length ? (
        <div className="dos-seg">
          <div className="dos-seg-h">
            <span className="nm">未挂材料的证据要点</span>
            <span className="rule" />
            <span className="pd">{unlinkedEvidence.length} 条</span>
          </div>
          <div className="dos-doc-evbox flat">
            <EvidencePoints items={unlinkedEvidence} showSource />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DocRow({ doc, compact = false }: { doc: WorkflowDocument; compact?: boolean }) {
  const { onReview, evidenceByDoc, onAddEvidence, matterId } = useDocActions();
  const [folderOpen, setFolderOpen] = useState(false);
  const [evOpen, setEvOpen] = useState(false);
  const pUrl = documentPreviewUrl(doc);
  const chip = doc.sourceOrigin ? documentSourceChip[doc.sourceOrigin] : null;
  const ext = doc.name.split(".").pop()?.toLowerCase() ?? "";
  const tone = ext === "pdf" ? "red" : ["doc", "docx"].includes(ext) ? "blue" : doc.textSource === "OCR" ? "violet" : "slate";
  const evidence = evidenceByDoc?.get(doc.id) ?? [];
  const meta: string[] = [];
  if (doc.size) meta.push(formatBytes(doc.size));
  meta.push(`${shortDay(doc.createdAt)} ${doc.templateId ? "从模板生成" : "上传"}`);
  if (doc.ocrStatus === "READY" && doc.pageCount) meta.push(`已抽取文本 · ${doc.pageCount} 页`);
  if (!compact && doc.sha256) meta.push(`校验值 ${doc.sha256.slice(0, 4)}…${doc.sha256.slice(-4)}`);
  if (doc.version && doc.version > 1) meta.push(`版本 ${doc.version}`);
  return (
    <div className={cn("dos-doc", evOpen && "open")}>
      <div className="doc-row">
        <DocIcon tone={tone} />
        <div className="min-w-0 flex-1">
          {pUrl ? (
            <a href={pUrl} target="_blank" rel="noreferrer" className="doc-name block truncate hover:text-[var(--teal-deep)]">
              {doc.name}
            </a>
          ) : (
            <div className="doc-name truncate">{doc.name}</div>
          )}
          {/* 标签行：材料性质 / 来源 / 识别状态 / 证据要点（2026-09-14 证据链并入材料） */}
          <div className="dos-doc-tags">
            <span className={cn("dos-doc-cat", doc.category === "EVIDENCE" && "ev")}>{documentCategoryLabel[doc.category]}</span>
            {chip ? <SourceChip kind={chip.kind}>{chip.label}</SourceChip> : doc.sourceParty ? <SourceChip kind="plain">{doc.sourceParty}</SourceChip> : null}
            {doc.ocrStatus === "FAILED" ? <span className="src-chip" style={{ color: "var(--red)", borderColor: "var(--red-line)", background: "var(--red-bg)" }}>识别失败</span> : null}
            {doc.textSource === "OCR" && doc.ocrStatus === "READY" ? <SourceChip kind="ai">AI 识别</SourceChip> : null}
            {evidence.length ? (
              <button type="button" className="dos-doc-ev" aria-expanded={evOpen} onClick={() => setEvOpen((v) => !v)}>
                证据要点 {evidence.length}
                {[...new Set(evidence.map((e) => evidenceKindLabel[e.kind]))].slice(0, 2).map((k) => (
                  <span key={k}>· {k}</span>
                ))}
              </button>
            ) : null}
            <span className="doc-meta truncate">{meta.join(" · ")}</span>
          </div>
        </div>
        {!compact ? (
          <div className="dos-doc-ops">
            {onAddEvidence ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onAddEvidence(doc.id)} title="记录这份材料证明的事实、主张或分析">
                ＋证据要点
              </button>
            ) : null}
            {pUrl ? (
              <a href={pUrl} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
                预览
              </a>
            ) : null}
            <a href={`/api/documents/${doc.id}/download`} target="_blank" rel="noreferrer" className="btn btn-ghost btn-sm">
              下载
            </a>
            {matterId ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFolderOpen(true)} title="归入卷宗文件夹">
                归档目录
              </button>
            ) : null}
            {onReview && doc.ocrStatus !== "FAILED" ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onReview(doc.id)} title="AI 审查缺失要素、法律风险与条款问题">
                AI 审查
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {evOpen && evidence.length ? (
        <div className="dos-doc-evbox">
          <EvidencePoints items={evidence} />
        </div>
      ) : null}
      {matterId ? (
        <DocFolderMoveDialog
          open={folderOpen}
          onOpenChange={setFolderOpen}
          documentId={doc.id}
          documentName={doc.name}
          matterId={matterId}
        />
      ) : null}
    </div>
  );
}


function PreservationWorkflowContent({
  matter,
  procedure,
  stage,
  cases,
  documents,
  users,
  canManage,
  onOpenTemplate,
  onAddTask,
  onRemoveStage,
  uploadSignal
}: {
  matter: WorkflowMatter;
  procedure: WorkflowProcedure;
  stage: WorkflowStage;
  cases: WorkflowPreservationCase[];
  documents: WorkflowDocument[];
  users: UserOption[];
  canManage: boolean;
  onOpenTemplate: () => void;
  onAddTask: () => void;
  onRemoveStage?: () => void;
  uploadSignal: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [createOpen, setCreateOpen] = useState(false);
  const [addTargetCaseId, setAddTargetCaseId] = useState<string | null>(null);
  const [addPropertyTargetId, setAddPropertyTargetId] = useState<string | null>(null);
  const [renewPropertyId, setRenewPropertyId] = useState<string | null>(null);

  const matterOption: MatterOption = {
    id: matter.id,
    internalCode: matter.internalCode,
    title: matter.title
  };
  const properties = cases.flatMap((c) => c.targets.flatMap((t) => t.properties));
  const activeProperties = properties.filter((p) => p.status === "ACTIVE" || p.status === "RENEWED");
  const expiringCount = activeProperties.filter((p) => daysUntil(p.expiryDate) <= 30).length;
  const renewableProperty = properties.find((p) => p.id === renewPropertyId) ?? null;
  const relevantDocs = documents.filter((d) => documentMatchesStage(d, stage));

  function handleLift(propertyId: string) {
    startTransition(async () => {
      try {
        await liftProperty(propertyId);
        toast.success("已解除保全");
        router.refresh();
      } catch (err) {
        toast.error("操作失败", { description: actionErrorMessage(err) });
      }
    });
  }

  return (
    <>
    <div className="card">
      <div className="panel-head" style={{ borderBottom: "none", paddingBottom: 8 }}>
        <div className="ws-head min-w-0 flex-1">
          <div className="ic-wrap" style={expiringCount > 0 ? { background: "var(--amber-bg)", color: "var(--amber)" } : undefined}>
            <Shield strokeWidth={1.8} />
          </div>
          <div className="min-w-0">
            <h2>财产保全</h2>
            <div className="desc truncate">
              {activeProperties.length > 0 ? `在保 ${activeProperties.length} 项` : "暂无在保财产"}
              {expiringCount > 0 ? ` · 30 天内到期 ${expiringCount} 项` : ""} · 申请、担保、裁定、续封和解除统一归到当前程序
            </div>
          </div>
          <div className="acts">
            {onRemoveStage ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onRemoveStage}>
                移除环节
              </button>
            ) : null}
            {canManage ? (
              <>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onAddTask}>
                  <Plus />
                  任务
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreateOpen(true)}>
                  <Plus />
                  新建保全
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="panel-body" style={{ paddingTop: 4 }}>
      {cases.length === 0 ? (
        <EmptyState compact icon={Shield} title="该程序尚无财产保全记录" description="新建保全后，被保全人、财产、续封与解除都在这里跟踪。" />
      ) : (
        <div className="space-y-3">
          {cases.map((item) => (
            <div key={item.id} className="rounded-[10px] border border-[var(--bd-hair)] bg-card">
              <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--bd-hair)] px-3 py-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{PRES_TYPE_CN[item.type]}</span>
                    {item.court && <span className="text-[11px] text-muted-foreground">{item.court}</span>}
                    {item.rulingNumber && (
                      <span className="font-mono text-[10.5px] text-muted-foreground">{item.rulingNumber}</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                    {item.guaranteeType ? GUARANTEE_TYPE_CN[item.guaranteeType] : "未填写担保方式"}
                    {item.owner?.name ? ` · ${item.owner.name}` : ""}
                  </div>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setAddTargetCaseId(item.id)}
                    className="h-7 gap-1 px-2 text-[11px]"
                  >
                    <Plus className="h-3 w-3" />
                    被保全人
                  </Button>
                )}
              </div>

              <div className="space-y-3 p-3">
                {item.targets.length === 0 ? (
                  <p className="py-3 text-center text-xs text-muted-foreground">
                    {canManage ? "暂无被保全人，点上方「+ 被保全人」录入姓名与证件后再登记财产。" : "暂无被保全人。"}
                  </p>
                ) : (
                  item.targets.map((target) => (
                    <div key={target.id} className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Landmark className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs font-medium">{target.name}</span>
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => setAddPropertyTargetId(target.id)}
                            className="ml-auto text-[11px] text-primary hover:underline"
                          >
                            + 添加财产
                          </button>
                        )}
                      </div>
                      {target.properties.length === 0 ? (
                        <p className="pl-6 text-[11px] text-muted-foreground">{canManage ? "暂无财产，点「+ 添加财产」登记标的类型与到期日。" : "暂无财产"}</p>
                      ) : (
                        <div className="space-y-1.5 pl-6">
                          {target.properties.map((property) => (
                            <PreservationPropertyRow
                              key={property.id}
                              property={property}
                              onRenew={() => setRenewPropertyId(property.id)}
                              onLift={() => handleLift(property.id)}
                              canManage={canManage}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      </div>
    </div>

      {/* 保全材料列表在「材料」视图；这里只挂载上传弹窗，供环节操作与页头「上传材料」使用 */}
      <div hidden>
        <StageMaterialsPanel
          matterId={matter.id}
          procedure={procedure}
          stage={stage}
          documents={relevantDocs}
          canManage={canManage}
          onOpenTemplate={onOpenTemplate}
          uploadSignal={uploadSignal}
        />
      </div>

      <PreservationCaseDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        matters={[matterOption]}
        users={users}
        initialMatterId={matter.id}
      />
      {addTargetCaseId && (
        <AddTargetDialog
          open={!!addTargetCaseId}
          onOpenChange={(open) => !open && setAddTargetCaseId(null)}
          caseId={addTargetCaseId}
        />
      )}
      {addPropertyTargetId && (
        <AddPropertyDialog
          open={!!addPropertyTargetId}
          onOpenChange={(open) => !open && setAddPropertyTargetId(null)}
          targetId={addPropertyTargetId}
        />
      )}
      {renewableProperty && (
        <RenewPropertyDialog
          open={!!renewPropertyId}
          onOpenChange={(open) => !open && setRenewPropertyId(null)}
          property={renewableProperty}
        />
      )}
    </>
  );
}

function PreservationPropertyRow({
  property,
  onRenew,
  onLift,
  canManage
}: {
  property: WorkflowPreservationCase["targets"][number]["properties"][number];
  onRenew: () => void;
  onLift: () => void;
  canManage: boolean;
}) {
  const days = daysUntil(property.expiryDate);
  const expiry = classifyExpiry(days);
  const statusColor = PRES_STATUS_COLOR[property.status] ?? PRES_STATUS_COLOR.ACTIVE;
  const isActive = property.status === "ACTIVE" || property.status === "RENEWED";

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-[var(--bd-hair)] bg-[var(--bg-hover)] px-2.5 py-2 text-[11.5px]">
      <span className="font-medium">{PROPERTY_TYPE_CN[property.propertyType]}</span>
      {property.amount && (
        <span className="font-mono text-muted-foreground tabular">
          {formatCurrency(Number(property.amount), { compact: true })}
        </span>
      )}
      {property.propertyDetail && (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{property.propertyDetail}</span>
      )}
      <span
        className={cn(
          "ml-auto shrink-0 font-medium",
          expiry.tone === "danger" && "text-[var(--red)]",
          expiry.tone === "warn" && "text-[var(--amber)]",
          expiry.tone === "ok" && "text-[var(--green)]"
        )}
      >
        {expiry.label}
      </span>
      <span
        className="shrink-0 rounded border px-1.5 py-0 text-[9px]"
        style={{
          borderColor: statusColor.border,
          color: statusColor.text,
          backgroundColor: statusColor.bg
        }}
      >
        {PRES_STATUS_CN[property.status]}
      </span>
      {canManage && isActive && (
        <>
          <button type="button" onClick={onRenew} className="shrink-0 text-primary hover:underline">
            续保
          </button>
          <button type="button" onClick={onLift} className="shrink-0 text-muted-foreground hover:text-foreground">
            解除
          </button>
        </>
      )}
    </div>
  );
}

function StageMaterialsPanel({
  matterId,
  procedure,
  stage,
  documents,
  canManage,
  onOpenTemplate,
  uploadSignal = 0,
  bare = false
}: {
  matterId: string;
  procedure: WorkflowProcedure;
  stage: WorkflowStage;
  documents: WorkflowDocument[];
  canManage: boolean;
  /** 嵌在环节页签内：不包卡片、不重复标题 */
  bare?: boolean;
  /** v1.1 UI（方案 D）：模板生成收口到材料区的单一入口 */
  onOpenTemplate?: () => void;
  /** 页头「上传材料」递增信号：打开本环节上传弹窗 */
  uploadSignal?: number;
}) {
  const router = useRouter();
  const stageName = stage.name;
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const [customName, setCustomName] = useState("");
  const [sourceParty, setSourceParty] = useState("");
  const [sourceOrigin, setSourceOrigin] = useState<DocumentSourceOrigin | "">("");
  const [originFilter, setOriginFilter] = useState<DocumentSourceOrigin | "ALL">("ALL");
  const [category, setCategory] = useState<DocumentCategory>(defaultCategoryForStage(stageName));
  const [isPending, startTransition] = useTransition();
  const stageTag = stageMaterialTag(stageName);
  const sourceOptions = useMemo(() => buildSourceOptions(procedure), [procedure]);

  function openUploadDialog() {
    setCategory(defaultCategoryForStage(stageName));
    setSourceParty("");
    setSourceOrigin("");
    setPicked(null);
    setCustomName("");
    if (fileRef.current) fileRef.current.value = "";
    setOpen(true);
  }

  function submitUpload() {
    if (!picked) {
      toast.warning("请先选择文件");
      return;
    }
    startTransition(async () => {
      try {
        // v0.48: 材料按外键归属环节；虚拟环节先物化拿到真实 stageId
        let stageId = stage.id;
        if (!stageId) {
          const ensured = await ensureProcedureStage({
            procedureId: procedure.id,
            name: stageName,
            description: "",
            insertPosition: "END"
          });
          stageId = ensured.id;
        }
        const fd = new FormData();
        fd.set("matterId", matterId);
        fd.set("procedureId", procedure.id);
        fd.set("stageId", stageId);
        fd.set("file", picked);
        fd.set("category", category);
        fd.set("name", customName.trim() || picked.name);
        fd.set("tags", stageTag);
        if (SOURCE_MATERIAL_CATEGORIES.includes(category) && sourceParty) {
          fd.set("sourceParty", sourceParty);
        }
        if (sourceOrigin) fd.set("sourceOrigin", sourceOrigin);
        await uploadDocument(fd);
        toast.success("材料已上传");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error("上传失败", { description: actionErrorMessage(err) });
      }
    });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (uploadSignal > 0 && canManage) openUploadDialog(); }, [uploadSignal]);

  const originCounts = documents.reduce<Partial<Record<DocumentSourceOrigin, number>>>((acc, d) => {
    if (d.sourceOrigin) acc[d.sourceOrigin] = (acc[d.sourceOrigin] ?? 0) + 1;
    return acc;
  }, {});
  const isWritten = (d: WorkflowDocument) => Boolean(d.templateId) || d.category === "PLEADING" || d.category === "JUDGMENT";
  const writtenCount = documents.filter(isWritten).length;
  const [writtenOnly, setWrittenOnly] = useState(false);
  const [evidenceOnly, setEvidenceOnly] = useState(false);
  const { evidenceByDoc } = useDocActions();
  const evidenceDocCount = documents.filter((d) => (evidenceByDoc?.get(d.id)?.length ?? 0) > 0).length;
  const shownDocs = (originFilter === "ALL" ? documents : documents.filter((d) => d.sourceOrigin === originFilter))
    .filter((d) => !writtenOnly || isWritten(d))
    .filter((d) => !evidenceOnly || (evidenceByDoc?.get(d.id)?.length ?? 0) > 0);

  const originChips = (
  <>
          {(Object.keys(originCounts) as DocumentSourceOrigin[]).map((origin, i) => (
            <button
              key={origin}
              type="button"
              onClick={() => setOriginFilter((v) => (v === origin ? "ALL" : origin))}
              className={cn("src-chip cursor-pointer", originFilter === origin && documentSourceChip[origin].kind !== "team" && documentSourceChip[origin].kind)}
              aria-pressed={originFilter === origin}
            >
              {i === 0 ? "来源：" : ""}
              <b style={{ fontWeight: i === 0 ? 600 : 550 }}>{documentSourceChip[origin].label} {originCounts[origin]}</b>
            </button>
          ))}
  </>
  );

  return (
    <div className={bare ? undefined : "card"}>
      {/* 头部两行：标题与操作按钮固定一行，筛选标签单独一行（窄宽度下不再挤乱） */}
      <div className={cn("panel-head", bare && "!border-b-0 !pb-1")}>
        <div className="panel-title min-w-0">
          <FileText className="ic" strokeWidth={1.8} />
          材料
          <span className="badge b-white" style={{ marginLeft: 2 }}>{documents.length}</span>
        </div>
        <div className="flex shrink-0 items-center gap-[7px]">
          {canManage && onOpenTemplate ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenTemplate}>
              <Sparkles />
              从模板生成
            </button>
          ) : null}
          {canManage ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={openUploadDialog}>
              <Upload />
              上传
            </button>
          ) : null}
        </div>
      </div>
      {documents.length > 0 ? (
        <div className="dos-mat-filters" role="group" aria-label="材料筛选">
          <button
            type="button"
            className={cn("src-chip cursor-pointer", !writtenOnly && !evidenceOnly && originFilter === "ALL" && "self")}
            aria-pressed={!writtenOnly && !evidenceOnly && originFilter === "ALL"}
            onClick={() => { setWrittenOnly(false); setEvidenceOnly(false); setOriginFilter("ALL"); }}
          >
            <b style={{ fontWeight: 550 }}>全部 {documents.length}</b>
          </button>
          {evidenceDocCount > 0 ? (
            <button type="button" className={cn("src-chip cursor-pointer", evidenceOnly && "self")} aria-pressed={evidenceOnly} onClick={() => setEvidenceOnly((v) => !v)}>
              <b style={{ fontWeight: 550 }}>有证据要点 {evidenceDocCount}</b>
            </button>
          ) : null}
          {writtenCount > 0 ? (
            <button type="button" className={cn("src-chip cursor-pointer", writtenOnly && "self")} aria-pressed={writtenOnly} onClick={() => setWrittenOnly((v) => !v)}>
              <b style={{ fontWeight: 550 }}>文书 {writtenCount}</b>
            </button>
          ) : null}
          {Object.keys(originCounts).length ? <span className="dos-mat-sep" aria-hidden /> : null}
          {originChips}
        </div>
      ) : null}

      {shownDocs.length === 0 ? (
        <EmptyState compact icon={FileText} title="本环节暂无材料" description={canManage ? "上传后自动归入本环节" : undefined} />
      ) : (
        shownDocs.map((doc) => <DocRow key={doc.id} doc={doc} />)
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>上传材料 · {stageName}</DialogTitle>
            <DialogDescription className="text-xs">
              文件将关联到当前程序，并自动归入本环节。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">材料类别 *</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as DocumentCategory)}>
                <SelectTrigger className="h-10 bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_CATEGORY_OPTIONS.map((item) => (
                    <SelectItem key={item} value={item}>
                      {documentCategoryLabel[item]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">材料来源</Label>
              <Select value={sourceOrigin || "__none__"} onValueChange={(value) => setSourceOrigin(value === "__none__" ? "" : (value as DocumentSourceOrigin))}>
                <SelectTrigger>
                  <SelectValue placeholder="选择材料来源" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">不标注</SelectItem>
                  {(Object.keys(documentSourceChip) as DocumentSourceOrigin[]).map((origin) => (
                    <SelectItem key={origin} value={origin}>
                      {documentSourceChip[origin].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {SOURCE_MATERIAL_CATEGORIES.includes(category) && sourceOptions.length > 0 && (
              <div className="space-y-1.5">
                <Label className="text-xs">归属/来源（可选）</Label>
                <Select
                  value={sourceParty || "__none__"}
                  onValueChange={(value) => setSourceParty(value === "__none__" ? "" : value)}
                >
                  <SelectTrigger className="h-10 bg-background">
                    <SelectValue placeholder="选择归属/来源" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">不标注</SelectItem>
                    {sourceOptions.map((item) => (
                      <SelectItem key={item} value={item}>
                        {item}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs">文件 *</Label>
              <Input
                ref={fileRef}
                type="file"
                onChange={(event) => setPicked(event.target.files?.[0] ?? null)}
              />
              {picked && (
                <p className="text-[10px] text-muted-foreground">
                  已选 {picked.name}（{(picked.size / 1024).toFixed(0)} KB）
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">显示名（可选）</Label>
              <Input
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder={`${stageName}材料`}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              取消
            </Button>
            <Button onClick={submitUpload} disabled={isPending || !picked} className="gap-1.5">
              {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              上传
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TaskQuickDialog({
  open,
  onOpenChange,
  matterId,
  procedureId,
  stage,
  users,
  onStageReady
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  matterId: string;
  procedureId: string;
  stage: WorkflowStage;
  users: UserOption[];
  onStageReady: (stageId: string) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState(0);

  function submit() {
    if (!title.trim()) {
      toast.warning("请填写任务标题");
      return;
    }
    startTransition(async () => {
      try {
        let stageId = stage.id;
        if (!stageId) {
          const ensured = await ensureProcedureStage({
            procedureId,
            name: stage.name,
            description: "",
            insertPosition: "END"
          });
          stageId = ensured.id;
          onStageReady(stageId);
        }
        await createTask({
          matterId,
          title: title.trim(),
          description,
          dueAt: dueAt ? new Date(dueAt) : undefined,
          priority,
          assigneeId,
          stageId
        });
        toast.success("任务已添加");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("添加失败", { description: actionErrorMessage(err) });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加任务 · {stage.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">任务标题 *</Label>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="如：准备财产线索 / 提交续封申请"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">截止日期</Label>
              <Input type="date" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">优先级</Label>
              <Select value={String(priority)} onValueChange={(v) => setPriority(Number(v))}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">普通</SelectItem>
                  <SelectItem value="1">高</SelectItem>
                  <SelectItem value="2">紧急</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">指派给</Label>
            <Select value={assigneeId || "__none__"} onValueChange={(v) => setAssigneeId(v === "__none__" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="暂不指派" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">暂不指派</SelectItem>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.id}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">说明</Label>
            <Textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button onClick={submit} disabled={isPending} className="gap-1.5">
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StageCreateDialog({
  open,
  onOpenChange,
  procedureId,
  procedureType,
  stages,
  selectedItem,
  onCreated
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  procedureId: string;
  procedureType: ProcedureType;
  stages: WorkflowStage[];
  selectedItem: WorkflowItem | null;
  onCreated: (stageId: string) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [presetName, setPresetName] = useState("");
  const [customMode, setCustomMode] = useState(false);
  const [customName, setCustomName] = useState("");
  const [description, setDescription] = useState("");
  const [insertTarget, setInsertTarget] = useState("END");
  const existingNameSet = useMemo(
    () => new Set(stages.map((item) => normalizeProcedureStageName(item.name))),
    [stages]
  );
  const availablePresets = useMemo(
    () =>
      procedureStagePresetsForProcedure(procedureType).filter(
        (preset) => !existingNameSet.has(normalizeProcedureStageName(preset.name))
      ),
    [existingNameSet, procedureType]
  );
  const selectedPreset = availablePresets.find((preset) => preset.name === presetName) ?? null;
  const stageName = customMode ? customName.trim() : selectedPreset?.name ?? "";
  const duplicate = stageName ? existingNameSet.has(normalizeProcedureStageName(stageName)) : false;

  useEffect(() => {
    if (open) {
      const firstPreset = availablePresets[0];
      setPresetName(firstPreset?.name ?? "");
      setCustomMode(!firstPreset);
      setCustomName("");
      setDescription("");
      setInsertTarget(defaultInsertTarget(selectedItem));
    }
  }, [availablePresets, open, selectedItem]);

  function submit() {
    if (!stageName) {
      toast.warning("请填写环节名称");
      return;
    }
    if (duplicate) {
      toast.warning("该环节已在列表中");
      return;
    }
    startTransition(async () => {
      try {
        const insert = parseInsertTarget(insertTarget, stages);
        const created = await createProcedureStage({
          procedureId,
          name: stageName,
          description: customMode ? description : description || selectedPreset?.description || "",
          insertPosition: insert.position,
          insertAfterStageId: insert.afterStageId,
          insertAfterStageName: insert.afterStageName
        });
        toast.success("环节已添加");
        onCreated(created.id);
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error("添加失败", { description: actionErrorMessage(err) });
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>添加环节</DialogTitle>
          <DialogDescription className="text-xs">
            优先选择预设环节；确实覆盖不到时再使用自定义。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!customMode ? (
            <div className="space-y-1.5">
              <Label className="text-xs">预设环节 *</Label>
              {availablePresets.length > 0 ? (
                <Select value={presetName} onValueChange={setPresetName}>
                  <SelectTrigger className="h-10 bg-background">
                    <SelectValue placeholder="选择预设环节" />
                  </SelectTrigger>
                  <SelectContent>
                    {availablePresets.map((preset) => (
                      <SelectItem key={preset.name} value={preset.name}>
                        {preset.name} · {preset.kind === "required" ? "必备" : "可选"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                  预设环节已全部加入当前程序。
                </p>
              )}
              {selectedPreset && (
                <p className="text-[10.5px] leading-5 text-muted-foreground">{selectedPreset.description}</p>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label className="text-xs">自定义环节名称 *</Label>
              <Input
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                placeholder="如：二次庭询 / 专家论证 / 履行谈判"
              />
              {duplicate && <p className="text-[10px] text-[var(--amber)]">该环节已在列表中</p>}
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">插入位置</Label>
            <Select value={insertTarget} onValueChange={setInsertTarget}>
              <SelectTrigger className="h-10 bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="START">放在最前</SelectItem>
                <SelectItem value="END">放在最后</SelectItem>
                {stages.map((stage) => (
                  <SelectItem key={stage.key} value={stage.id ? `AFTER_ID:${stage.id}` : `AFTER_NAME:${stage.name}`}>
                    放在「{stage.name}」之后
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">说明（可选）</Label>
            <Textarea
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={customMode ? "记录该环节的目标或注意事项" : selectedPreset?.description ?? ""}
            />
          </div>
          <button
            type="button"
            onClick={() => setCustomMode((value) => !value)}
            className="text-[11px] text-primary hover:underline"
          >
            {customMode ? "返回预设环节" : "预设没有覆盖，添加自定义环节"}
          </button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            取消
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || duplicate || !stageName}
            className="gap-1.5"
          >
            {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}



function buildWorkflowStages(
  procedure: WorkflowProcedure | null,
  preservationCases: WorkflowPreservationCase[]
): WorkflowStage[] {
  if (!procedure) return [];
  // v0.48: HIDDEN 环节不进工作台（数据保留，可重新添加恢复）
  const visibleStages = procedure.stages.filter((stage) => stage.status !== "HIDDEN");
  const context = { procedure, preservationCases };
  const realStages: WorkflowStage[] = visibleStages.map((stage) => ({
    ...workflowStageFromName(
      procedure.type,
      stage.name,
      {
        key: `stage-${stage.id}`,
        id: stage.id,
        status: statusForStage(stage.name, stage, procedure, preservationCases),
        tasks: stage.tasks
      },
      context
    )
  }));

  const source = realStages.length > 0
    ? realStages
    : defaultStageNamesForProcedure(procedure.type).map((name, index) => ({
        ...workflowStageFromName(
          procedure.type,
          name,
          {
            key: `default-${index}-${name}`,
            id: null,
            status: statusForStage(name, null, procedure, preservationCases),
            tasks: []
          },
          context
        )
      }));

  // 已有保全记录时必须能在工作台看到"财产保全"环节——即使真实环节已物化且未包含它，
  // 否则物化必备环节后保全数据会从案件详情页消失
  if (
    preservationCases.length > 0 &&
    !source.some((stage) => stage.name.includes("保全"))
  ) {
    const insertAt = Math.min(2, source.length);
    const preservationStage = workflowStageFromName(
      procedure.type,
      "财产保全",
      {
        key: "default-preservation",
        id: null,
        status: statusForStage("财产保全", null, procedure, preservationCases),
        tasks: []
      },
      context
    );
    return [...source.slice(0, insertAt), preservationStage, ...source.slice(insertAt)];
  }
  return source;
}

function workflowStageFromName(
  procedureType: ProcedureType,
  name: string,
  meta: Pick<WorkflowStage, "key" | "id" | "status" | "tasks">,
  context?: { procedure: WorkflowProcedure; preservationCases: WorkflowPreservationCase[] }
): WorkflowStage {
  const preset = stagePresetForName(procedureType, name);
  const presetKind = preset?.kind ?? "custom";
  const kind: WorkflowStage["kind"] = name.includes("保全") ? "preservation" : "normal";
  return {
    ...meta,
    name,
    kind,
    presetKind,
    removable: presetKind !== "required",
    badge: context ? stageBadge(name, kind, meta.tasks, context) : null
  };
}

/** 徽标天数：逾期显示「逾期 N 天」，否则「N 天」 */
function dayText(n: number) {
  return n < 0 ? `逾期 ${-n} 天` : n === 0 ? "今天" : `${n} 天`;
}

/** 导航徽标：临期期限（含任务数）> 未完成任务数 > 开庭日期，无则不显示 */
function stageBadge(
  name: string,
  kind: WorkflowStage["kind"],
  tasks: WorkflowTask[],
  context: { procedure: WorkflowProcedure; preservationCases: WorkflowPreservationCase[] }
): WorkflowStage["badge"] {
  if (kind === "preservation") {
    const properties = context.preservationCases.flatMap((c) =>
      c.targets.flatMap((t) => t.properties)
    );
    const active = properties.filter((p) => p.status === "ACTIVE" || p.status === "RENEWED");
    if (active.length === 0) return null;
    const nearest = Math.min(...active.map((p) => daysUntil(p.expiryDate)));
    return nearest <= 30
      ? { text: `${active.length} 项 · ${dayText(nearest)}`, hot: true }
      : { text: `${active.length} 项`, hot: false };
  }

  const openTasks = tasks.filter((t) => !t.completed).length;
  const guide = stageGuideFor(name);
  const relevantDue = context.procedure.deadlines
    .filter((d) => !d.completed && guide.deadlineCategories.includes(d.category))
    .map((d) => daysUntil(d.dueAt));
  const nearestDue = relevantDue.length > 0 ? Math.min(...relevantDue) : null;

  if (nearestDue !== null && nearestDue <= 30) {
    return {
      text: openTasks > 0 ? `${openTasks} 项 · ${dayText(nearestDue)}` : dayText(nearestDue),
      hot: true
    };
  }
  if (openTasks > 0) return { text: `${openTasks}`, hot: false };
  if (guide.includeHearings) {
    const nextHearing = context.procedure.hearings
      .filter((h) => daysUntil(h.startsAt) >= 0)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
    if (nextHearing) return { text: shortDay(nextHearing.startsAt), hot: false };
  }
  return null;
}

function statusForStage(
  name: string,
  stage: WorkflowStageSource | null,
  procedure: WorkflowProcedure,
  preservationCases: WorkflowPreservationCase[]
): WorkflowStageStatus {
  if (name.includes("保全")) {
    const properties = preservationCases.flatMap((item) => item.targets.flatMap((target) => target.properties));
    const active = properties.filter((property) => property.status === "ACTIVE" || property.status === "RENEWED");
    if (active.some((property) => daysUntil(property.expiryDate) <= 30)) return "risk";
    if (active.length > 0) return "active";
    if (properties.length > 0) return "done";
    return "todo";
  }
  if (stage?.completedAt) return "done";
  const tasks = stage?.tasks ?? [];
  if (tasks.some((task) => !task.completed && task.dueAt && daysUntil(task.dueAt) <= 3)) return "risk";
  if (tasks.length > 0 && tasks.every((task) => task.completed)) return "done";
  if (tasks.some((task) => !task.completed)) return "active";
  if ((name.includes("立案") || name.includes("起诉")) && procedure.acceptedAt) return "done";
  if (name.includes("开庭") && procedure.hearings.some((hearing) => daysUntil(hearing.startsAt) >= 0)) return "active";
  if (
    name.includes("举证") &&
    procedure.deadlines.some((deadline) => deadline.category === "EVIDENCE" && !deadline.completed && daysUntil(deadline.dueAt) <= 7)
  ) {
    return "risk";
  }
  if (
    procedure.status === "CONCLUDED" &&
    (name.includes("裁判") || name.includes("裁决") || name.includes("结案"))
  ) {
    return "done";
  }
  return "todo";
}









function buildSourceOptions(procedure: WorkflowProcedure) {
  const seen = new Set<string>([COURT_PROCEDURE_SOURCE]);
  const partyOptions = [...procedure.procedureParties]
    .sort((a, b) => a.ordinal - b.ordinal || a.party.name.localeCompare(b.party.name, "zh-Hans-CN"))
    .map((row) => {
      const name = row.party.name.trim();
      if (!name) return null;
      return `${litigationStandingLabel[row.standing] ?? row.standing}·${name}`;
    })
    .filter((label): label is string => {
      if (!label || seen.has(label)) return false;
      seen.add(label);
      return true;
    });
  return [COURT_PROCEDURE_SOURCE, ...partyOptions];
}

function documentPreviewUrl(document: Pick<WorkflowDocument, "id" | "mimeType" | "name">) {
  if (officePreviewKind(document.mimeType, document.name)) {
    return `/api/documents/${document.id}/preview`;
  }
  if (canPreview(document.mimeType, document.name)) {
    return `/api/documents/${document.id}/download?inline=1`;
  }
  return null;
}


const documentCategoryLabel: Record<DocumentCategory, string> = {
  EVIDENCE: "证据",
  PLEADING: "诉辩文件",
  PROCEDURE: "程序文件",
  JUDGMENT: "裁决",
  CONTRACT: "合同",
  OTHER: "其他"
};
