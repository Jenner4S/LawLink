/**
 * 案卷工作台的类型与小常量（2026-11-21 从 procedure-workflow-panel.tsx 拆出）
 *
 * 面板组件本身 3400+ 行、约 30 个顶层定义；这些类型被其中大半引用，
 * 放在文件头部会让「渲染逻辑从第 700 行才开始」。
 * 拆成独立模块后，类型变化与 UI 变化可以分开评审。
 */
import type {
  DeadlineCategory,
  DocumentCategory,
  DocumentSourceOrigin,
  GuaranteeType,
  LitigationStanding,
  PreservationStatus,
  PreservationType,
  ProcedureType
} from "@prisma/client";
import type { StagePresetKind } from "@/lib/procedure-stage-defaults";
import { PROPERTY_TYPE_CN } from "@/app/(app)/preservation/_components/preservation-types";

export type WorkflowTask = {
  id: string;
  title: string;
  description: string | null;
  dueAt: Date | null;
  completed: boolean;
  completedAt: Date | null;
  priority: number;
  stageId: string | null;
  assigneeId: string | null;
};

export type WorkflowStageSource = {
  id: string;
  name: string;
  description: string | null;
  order: number;
  status: "ACTIVE" | "HIDDEN";
  startedAt: Date | null;
  completedAt: Date | null;
  tasks: WorkflowTask[];
};

export type WorkflowDeadline = {
  id: string;
  title: string;
  category: DeadlineCategory;
  dueAt: Date;
  basis: string | null;
  remindDays: number;
  completed: boolean;
  confirmStatus?: "PENDING" | "CONFIRMED" | "ADJUSTED";
};

export type WorkflowHearing = {
  id: string;
  title: string;
  room: string | null;
  address: string | null;
  startsAt: Date;
};

export type WorkflowProcedure = {
  id: string;
  type: ProcedureType;
  customLabel: string | null;
  caseNumber: string | null;
  acceptedAt: Date | null;
  concludedAt: Date | null;
  status: "PENDING" | "IN_PROGRESS" | "CONCLUDED";
  stages: WorkflowStageSource[];
  deadlines: WorkflowDeadline[];
  hearings: WorkflowHearing[];
  memos?: { id: string; content: string; done: boolean; doneAt: Date | null; createdAt: Date }[];
  procedureParties: {
    id: string;
    standing: LitigationStanding;
    ordinal: number;
    party: { id: string; name: string };
  }[];
};

export type WorkflowDocument = {
  id: string;
  name: string;
  category: DocumentCategory;
  mimeType: string | null;
  size: number | null;
  createdAt: Date;
  sourceParty: string | null;
  path: string;
  tags: string[];
  stageId: string | null;
  sourceOrigin: DocumentSourceOrigin | null;
  ocrStatus: "PENDING" | "READY" | "FAILED" | "SKIP" | null;
  textSource: "DOCX" | "PDF_TEXT" | "OCR" | "MANUAL" | null;
  pageCount: number | null;
  sha256: string | null;
  templateId: string | null;
  version: number | null;
};

export type WorkflowMatter = {
  id: string;
  internalCode: string;
  title: string;
  category: string;
};

export type WorkflowPreservationCase = {
  id: string;
  matterId: string | null;
  type: PreservationType;
  status: PreservationStatus;
  court: string | null;
  rulingNumber: string | null;
  guaranteeType: GuaranteeType | null;
  appliedAt: Date | null;
  note: string | null;
  ownerId: string | null;
  remindDays: number[];
  createdAt: Date;
  updatedAt: Date;
  matter: { id: string; internalCode: string; title: string } | null;
  owner: { id: string; name: string } | null;
  targets: {
    id: string;
    caseId: string;
    name: string;
    note: string | null;
    createdAt: Date;
    updatedAt: Date;
    properties: {
      id: string;
      targetId: string;
      propertyType: keyof typeof PROPERTY_TYPE_CN;
      propertyDetail: string | null;
      amount: number | null;
      startDate: Date;
      duration: number;
      expiryDate: Date;
      status: PreservationStatus;
      createdAt: Date;
      updatedAt: Date;
      renewals: {
        id: string;
        propertyId: string;
        renewedAt: Date;
        oldExpiryDate: Date;
        newExpiryDate: Date;
        renewalDuration: number;
        note: string | null;
        performedById: string;
        createdAt: Date;
      }[];
    }[];
  }[];
};

export type WorkflowStageStatus = "done" | "active" | "risk" | "todo" | "not_applicable";

export type WorkflowStage = {
  key: string;
  id: string | null;
  name: string;
  kind: "normal" | "preservation";
  presetKind: StagePresetKind | "custom";
  removable: boolean;
  status: WorkflowStageStatus;
  tasks: WorkflowTask[];
  /** v1.1 UI（方案 E）：导航徽标——任务数 / 临期倒计时 / 开庭日期 */
  badge: { text: string; hot: boolean } | null;
};

export type WorkflowItem = WorkflowStage;

export type StageGuide = {
  summary: string;
  checklistTitle: string;
  checklist: string[];
  actions: string[];
  deadlineCategories: DeadlineCategory[];
  includeHearings?: boolean;
  materialCategories: DocumentCategory[];
  materialPattern: RegExp;
  defaultCategory: DocumentCategory;
};



export const PRESERVATION_ACTIONS = [
  "财产保全申请书",
  "财产线索清单",
  "担保书/保函",
  "网络查控申请书",
  "保全费缴费凭证",
  "续封申请书",
  "解除保全申请书",
  "保全复议申请书"
];


export const COURT_PROCEDURE_SOURCE = "法院程序文件";

export type WorkflowNote = {
  id: string;
  channel: string;
  withWhom: string | null;
  occurredAt: Date;
  content: string;
  tags: string[];
  author: { id: string; name: string };
};

export type WorkflowTimelineEvent = {
  id: string;
  eventType: string;
  title: string;
  content: string | null;
  occurredAt: Date;
};

/** 研判笔记标记（Note.tags）：人工判断内容，与事务记录分开陈列 */
export const JUDGMENT_NOTE_TAG = "研判笔记";
export const stageNoteTag = (stageName: string) => `环节:${stageName}`;

export type WorkflowApi = {
  /** 从外部（页头「上传材料」）打开当前环节的上传 */
  openUpload: () => void;
  /** 从「登记进展」打开当前环节的添加任务 */
  openAddTask: () => void;
  /** 当前可归档环节名（研判笔记归档用） */
  stageNames: string[];
  currentStageName: string | null;
};

/** 案卷工作台页签（docs/案卷工作台方案.md 第三版；2026-11-19 增「工时」） */
export type DossierView = "archive" | "work" | "money" | "time" | "email" | "seal";

/** 待办「等待他人」：审批中的用印、归档等 */
export type WaitingItem = { key: string; title: string; meta: string; onOpen?: () => void };


/** 待办项（buildActionItems 的产物，渲染与派生共用的契约） */
export type ActionItem = {
  key: string;
  kind: "task" | "deadline" | "hearing" | "memo";
  title: string;
  at: Date | null;
  days: number | null;
  stageKey: string | null;
  stageName: string | null;
  meta: string;
  priority: number;
  taskId?: string;
  // 2026-11-22：任务编辑需要回填原值。**assigneeId 必须原样回传**——
  // updateTask 会比对该字段，省略或改动都会抛「变更责任人请从事项责任面板发起交接」。
  assigneeId?: string | null;
  description?: string | null;
  stageId?: string | null;
  deadlineId?: string;
  memoId?: string;
  pendingConfirm?: boolean;
};

export type LogKind = "talk" | "court" | "note" | "task" | "express" | "memo" | "sys";

export type LogItem = {
  key: string;
  kind: LogKind;
  at: Date;
  stageName: string | null;
  title: string;
  body: string | null;
  meta: string;
  channelTone?: "court" | "talk";
  stageTag?: string | null;
  eventType?: string;
  // 2026-11-22：经办记录需要「改/删」入口（updateNote/deleteNote 此前零引用）。
  // 只显示给作者本人 —— 服务端同样只允许本人（"只能编辑/删除自己的沟通记录"）。
  noteId?: string;
  noteAuthorId?: string | null;
  /** updateNote 收全量：只改内容时必须把这些原值一并回传，否则会被覆盖成默认值 */
  noteChannel?: string;
  noteWithWhom?: string | null;
  noteTags?: string[];
  memo?: { id: string; done: boolean };
  express?: { id: string; outbound: boolean };
};
