/** 审计列表使用中文；原始代码保留在技术详情中供排障。 */
const targetLabels: Record<string, string> = {
  Announcement: "公告", Approval: "审批", ArchiveRecord: "归档记录", AuditLog: "审计日志",
  Backup: "备份", Billing: "结算单", Client: "客户", ConflictCheck: "冲突检索", Contact: "联系人",
  Cron: "定时任务", CustomFieldDef: "自定义字段", Deadline: "期限", Document: "材料",
  DocumentFolder: "材料目录", DocumentTemplate: "文书模板", ExpressTracking: "快递跟踪",
  ExternalContact: "外部联系人", FeeEntry: "收付记录", FirmFile: "律所文书", Hearing: "开庭",
  Intake: "收案", InvoiceRequest: "开票申请", Matter: "案件", MatterList: "案件列表",
  MatterProcedure: "案件程序", MatterStage: "案件阶段", Note: "跟进记录", Party: "当事人",
  PreservationCase: "保全案件", PreservationProperty: "保全财产", PreservationTarget: "被保全人", Report: "报告", SealRequest: "用章申请",
  SmsMessage: "法院短信", StageTemplate: "阶段模板", SystemSetting: "系统设置", Task: "事项",
  Team: "律师团队", User: "用户", BuiltinRole: "内置角色", RoleDefinition: "自定义角色",
  Engagement: "委托", EvidenceItem: "证据项",
  // 门户 S1（2026-11-20）：客户侧账号与邀请，审计页须能一眼看出是「客户门户」而非员工账号
  ClientPortalUser: "客户门户账号", PortalInvite: "门户邀请", PortalShare: "门户披露",
  PortalRequest: "客户提问", PortalSatisfaction: "客户评价", Lead: "获客线索", LeadChannel: "获客渠道",
  // 第七轮体检：补齐缺失对象标签（缺失时审计页显示「其他对象」）
  ArchiveBorrowRequest: "案卷借阅申请", CommissionSettlement: "分成结算", DeadlineRule: "期限规则",
  FeeEntryList: "收付记录列表", FinanceCorrection: "财务更正", Holiday: "放假安排",
  Payment: "实收", Receivable: "应收", ReminderDelivery: "提醒送达台账",
  UserIdentityDocument: "人员证件资料",
  EthicalWall: "隔离墙",
  EmailArchive: "邮件归档",
  // 工时与费率（P0-1）
  TimeEntry: "工时记录", RateSchedule: "费率安排",
  // 通行密钥（P2-2 后半）
  WebAuthnCredential: "通行密钥",
  // 合同确认留痕（P1-4 降级实现）：不是电子签名，审计动作名用 CONFIRM / REVOKE，不用 SIGN
  ContractConfirmation: "合同确认"
};
const words: Record<string, string> = {
  BUILTIN: "内置", ROLE: "角色", PRESENTATION: "显示资料", DEFINITION: "定义",
  IDENTITY: "身份信息", CORRECT: "更正", SELF: "本人",
  AI: "智能辅助", ALL: "全部", ANNOUNCEMENT: "公告", APPROVAL: "审批", APPROVE: "批准", APPROVED: "已批准",
  ARCHIVE: "归档", ATTACHMENT: "附件", ATTACHMENTS: "附件", AUDIT: "审计", AUTHORIZATION: "授权",
  AUTO: "自动", AVATAR: "头像", BACKFILL: "回填", BACKUP: "备份", BASIC: "基本信息", BATCH: "批量",
  BILLING: "结算单", BIND: "关联", CALENDAR: "日历订阅", CANCELLED: "已取消", CASE: "案件",
  CHECK: "检查", CLASSIFY: "分类", CLEAR: "清除", CLIENT: "客户", CLOSE: "结案", COMMISSION: "分成",
  COMPLETE: "完成", CONCLUSION: "结论", CONFLICT: "冲突", CONTACT: "联系人", CONVERT: "转正式案件",
  CREATE: "创建", CRON: "定时任务", CUSTOM: "自定义", DATABASE: "数据库", DEADLINE: "期限",
  DECLINE: "不接案", DECLINED: "不接案", DELETE: "删除", DETAIL: "详情", DOCUMENT: "材料",
  DOWNLOAD: "下载", DUE: "到期", ENTRY: "条目", ENTERPRISE: "企业", EXPIRED: "已过期", EXPORT: "导出",
  EXPRESS: "快递", EXTERNAL: "外部", EXTRACT: "提取", FAILED: "失败", FEE: "收付", FIELD: "字段",
  FILE: "文件", FILING: "立案", FIRM: "律所", FOLDER: "目录", GENERATE: "生成", GROUP: "权限组",
  HARD: "永久", HEARING: "开庭", HIDE: "隐藏", HOLD: "暂停", IMPORT: "导入", INFO: "信息",
  INTAKE: "收案", INVOICE: "开票", ISSUED: "已开具", KEY: "密钥", LEGACY: "历史申请", LINK: "关联",
  LOGIN: "登录", LOGOUT: "退出登录", MARK: "标记", MATCH: "匹配", MATTER: "案件", MATTERS: "案件",
  MOVE: "移动", NEEDS: "需要", NOTE: "跟进记录", NUMBER: "编号", OCR: "文字识别", OVERDUE: "逾期",
  PARSE: "解析", PARTY: "当事人", PERMISSION: "权限", PLAN: "方案", PRESERVATION: "保全",
  PREVIEW: "预览", PROCEDURE: "程序", PROCESSED: "已处理", PROFILE: "资料", PROPERTY: "财产",
  PURPOSE: "事项", PUSH: "推送", REFRESH: "刷新", REGENERATE: "重新生成", REJECT: "驳回", REJECTED: "已驳回",
  REMINDER: "提醒", REMOVE: "移除", RENAME: "重命名", REOPEN: "重新开启", REPLACE: "替换",
  REPORT: "报告", REQUEST: "申请", RESUBMIT: "重新提交", RETENTION: "保留", REVIEW: "审查",
  REVISION: "补正", RUN: "执行", SAVE: "保存", SCAN: "扫描", SEAL: "用章", SEARCH: "检索",
  SET: "设置", SETTINGS: "设置", SMS: "短信", STAGE: "阶段", STAMP: "盖章回填", STAMPED: "已盖章",
  STATUS: "状态", SUBMIT: "提交", SUMMARY: "摘要", TASK: "事项", TEAM: "团队", TEMPLATE: "模板",
  TOGGLE: "启停", TOGGLES: "开关", TOKEN: "订阅凭证", UNBIND: "解除关联", UPDATE: "更新",
  NOTES: "备注", CLEAN: "清洗",
  UPLOAD: "上传", USER: "用户", VALUES: "内容", VECTOR: "语义索引", VIEW: "查看", WEBHOOK: "群机器人",
  WEEKLY: "周报", WORKFLOW: "工作流", YUANDIAN: "元典", ADD: "添加", CLEANUP: "历史清理",
  ENGAGEMENT: "委托", EVIDENCE: "证据", TERMINATE: "终止", ACTIVATE: "启用", SERVICE: "服务",
  ENFORCE: "强制", SKIP: "跳过", ESCALATION: "升级",
  // 第七轮体检：auditActionLabel 要求 action 的每个词都已登记，缺一个整条即降级为
  // 「其他操作（详见技术详情）」。全仓 199 个 action 中 48 个命中该降级，其中含
  // 证件号/电话明文查看、财务更正、二次验证变更等敏感操作。以下为一次补齐的清单。
  ADJUST: "调整", ALLOCATION: "核销", AMENDMENT: "补充协议", BEGIN: "开始", BORROW: "借阅", BUNDLE: "卷宗包",
  CANCEL: "取消", CHECKOUT: "取件", CONDITION: "条件", CONFIRM: "确认", CONFIRMED: "已确认",
  CORRECTION: "更正", DESKTOP: "桌面连接器", DISABLE: "停用", DRAFT: "草稿", ENABLE: "启用",
  ENCRYPT: "加密", ENFORCED: "强制要求", FETCH: "拉取", FINANCE: "财务", FROM: "来自",
  HOLIDAY: "放假安排", ID: "证件号", INBOUND: "来件", ITEM: "条目", LEDGER: "台账",
  LIST: "清单", LOCKED: "已锁定", MERGE: "合并", MISSING: "缺失", NEW: "新增",
  NOTIFY: "通知", PHONE: "电话", PHOTO: "照片", POLICY: "制度", POST: "事后",
  REBIND: "重新绑定", RECEIVABLE: "应收", RECIPIENT: "接收人", RENDER: "渲染", RESET: "重置",
  RETURN: "归还", REVEAL: "查看明文", RULE: "规则", SAVED: "已保存", SCHEDULE: "日程",
  SIGN: "签署", TEXT: "正文", TOTP: "二次验证", VERSION: "版本",
  // 工时与费率（P0-1）。新增审计动作必须同步补词，否则整条降级为「其他操作」。
  TIME: "工时",
  // 隔离墙（P0-3 管理 UI 批次）。同上：新增审计动作必须同步补词。
  ETHICAL: "合规", WALL: "隔离墙", LIFT: "解除",
  // 邮件归档（P1-3）：EMAIL_ARCHIVE / EMAIL_LINK 两个动作需要该词，缺一即整条降级
  EMAIL: "邮件",
  // OIDC 单点登录（P2-2）：SSO_LOGIN / SSO_LOGIN_REJECT 需要该词。
  // 安全上这两个动作是登录审计的主线索（成功与拒绝都要能读懂是谁、为什么），
  // 因此词条与 LOGIN / REJECT 组合使用。
  SSO: "单点登录",
  // 通行密钥（P2-2 后半）：WEBAUTHN_REGISTER / WEBAUTHN_LOGIN / WEBAUTHN_LOGIN_REJECT /
  // WEBAUTHN_DELETE / WEBAUTHN_COUNTER_ANOMALY 五个动作需要。COUNTER_ANOMALY 是
  // 高危安全事件（凭证可能被克隆），审计页必须一眼能读懂，因此单列两个词。
  WEBAUTHN: "通行密钥", REGISTER: "注册", COUNTER: "计数器", ANOMALY: "异常",
  // 合同确认留痕（P1-4 降级实现）：CONTRACT_CONFIRM / CONTRACT_REVOKE /
  // CONTRACT_CREATE / CONTRACT_REGENERATE / CONTRACT_EXPIRE_CRON 需要。
  // 注意：这里刻意不引入「签署」系词条名——动作语义是阅知确认，不是电子签名。
  CONTRACT: "合同", REVOKE: "撤销", EXPIRE: "过期",
  // 保全域补审计（2026-11-21）：新增 PRESERVATION_TARGET_CREATE/UPDATE/DELETE 与
  // PRESERVATION_PROPERTY_RENEW/LIFT/DELETE 六个动作。被保全人与续封/解除/删除
  // 都是律所高风险操作，审计页必须一眼读懂，不能落到「其他操作」。
  TARGET: "被保全人", RENEW: "续封",
  // 客户门户 S1（2026-11-20）：PORTAL_INVITE_CREATE / PORTAL_INVITE_ACCEPT /
  // PORTAL_LOGIN / PORTAL_LOGIN_BLOCKED / PORTAL_USER_REVOKE
  // 前两个构成「邀请—接受」闭环，后三个是登录与踢下线。
  // BLOCKED 单独给词条：它记的是「有人拿着正确口令但账号已停用/客户已删」，
  // 是安全事件而不是普通登录，审计页必须能区分。
  // LOGIN 已在上面「登录/退出登录」组里定义，此处不重复（重复键在 TS 里是错误）
  // SHARE 用于 PORTAL_SHARE_CREATE / PORTAL_SHARE_REVOKE（门户 S2 披露动作）
  PORTAL: "客户门户", INVITE: "邀请", ACCEPT: "接受", BLOCKED: "被拦截", SHARE: "披露",
  // S3：PORTAL_REQUEST_CREATE / PORTAL_REQUEST_ANSWER / PORTAL_SATISFACTION_CREATE
  // 用 INQUIRY 而不是 REQUEST：REQUEST 已有词条（"申请"，用于其他动作），
  // 复用它会让「客户提问」显示成「门户申请创建」——语义不对。
  INQUIRY: "提问", ANSWER: "回复", SATISFACTION: "评价",
  // 获客链路（LEAD_CREATE / LEAD_ACTIVITY / LEAD_LOST / LEAD_CONVERT）
  // CONVERT 已有词条（"转正式案件"），LEAD_CONVERT 拼出来是「获客线索·转正式案件」——
  // 正好对：线索确实转成了正式收案。重复键会被 tsc 拦下（已踩到），故不再加。
  LEAD: "获客线索", LOST: "标记流失", ACTIVITY: "跟进",
  // LEAD_REMINDER_RECIPIENT_DISABLED（2026-11-21 收口审查）
  // REMINDER / RECIPIENT 已在通用词表里，这里只补缺的 DISABLED
  DISABLED: "已停用", RETIRE: "作废", DUPLICATE: "重复", WARNED: "已提示",
  // 到店结果（2026-11-22 P0-3）
  SHOW: "到店", CHANNEL: "渠道",
};
export function auditActionLabel(code: string): string {
  const parts = code.split("_");
  return parts.every(part => Object.hasOwn(words, part))
    ? parts.map(part => words[part]).join(" · ")
    : "其他操作（详见技术详情）";
}
export function auditTargetLabel(code: string | null | undefined): string {
  return code ? targetLabels[code] ?? "其他对象" : "—";
}
