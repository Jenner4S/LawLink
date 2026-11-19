import type ExcelJS from "exceljs";
import type { matterCategoryKind } from "@/lib/enums";

/**
 * 案件工作簿导出的列元数据（纯静态表，零状态、零依赖）。
 *
 * 依赖方向：export-xlsx（编排层）→ export-columns。
 * 本文件不 import 任何其他 export-* 模块，是最底层的叶子节点。
 */

type MatterCategoryKind = ReturnType<typeof matterCategoryKind>;

export function intakeColumnsForKind(kind: MatterCategoryKind): Partial<ExcelJS.Column>[] {
  const commonStart: Partial<ExcelJS.Column>[] = [
    { header: "收案ID", key: "id", width: 24 },
    { header: "标题", key: "title", width: 36 },
    { header: "收案分类", key: "category", width: 12 },
    { header: "收案状态", key: "status", width: 12 },
    { header: "收案时间", key: "receivedAt", width: 12 },
    { header: "案由", key: "cause", width: 18 },
    { header: "自由案由", key: "causeFreeText", width: 18 },
    { header: "案情描述", key: "description", width: 36 },
    { header: "委托方", key: "client", width: 20 },
    { header: "委托方类型", key: "clientType", width: 12 },
    { header: "委托方证件/代码", key: "clientIdNumber", width: 22 },
    { header: "委托方地址", key: "clientAddress", width: 28 },
    { header: "法定代表人", key: "clientLegalRep", width: 14 },
    { header: "联系人", key: "contactName", width: 14 },
    { header: "联系电话", key: "contactPhone", width: 16 },
    { header: "客户档案联系人", key: "clientContacts", width: 28 },
    { header: "主办律师", key: "owner", width: 12 },
    { header: "共同律师", key: "coUsers", width: 24 }
  ];
  const litigationColumns: Partial<ExcelJS.Column>[] = [
    { header: "首次程序", key: "firstProcedureType", width: 14 },
    { header: "争议解决机构", key: "firstAgency", width: 24 },
    { header: "管辖地", key: "jurisdiction", width: 18 },
    { header: "我方地位", key: "ourStanding", width: 14 },
    { header: "标的金额", key: "money", width: 14 },
    { header: "标的描述", key: "claimDescription", width: 24 },
    { header: "律协备案", key: "barFiling", width: 18 },
    { header: "是否反诉", key: "counterclaim", width: 10 },
    { header: "当事人", key: "parties", width: 44 }
  ];
  const projectColumns: Partial<ExcelJS.Column>[] = [
    { header: "业务类型", key: "businessType", width: 16 },
    { header: "服务范围", key: "serviceScope", width: 28 },
    { header: "交付成果", key: "deliverables", width: 24 },
    { header: "服务起", key: "serviceStart", width: 12 },
    { header: "服务止", key: "serviceEnd", width: 12 },
    { header: "相关方", key: "parties", width: 44 }
  ];
  const counselColumns: Partial<ExcelJS.Column>[] = [
    { header: "顾问类型", key: "counselType", width: 16 },
    { header: "服务范围", key: "serviceScope", width: 28 },
    { header: "服务起", key: "serviceStart", width: 12 },
    { header: "服务止", key: "serviceEnd", width: 12 },
    { header: "相关方", key: "parties", width: 44 }
  ];
  const commonEnd: Partial<ExcelJS.Column>[] = [
    { header: "收费方式", key: "feeType", width: 14 },
    { header: "律师费金额", key: "feeAmount", width: 14 },
    { header: "风险代理条款", key: "contingencyTerms", width: 26 },
    { header: "付款节点", key: "feeSchedule", width: 26 },
    { header: "费用备注", key: "feeNote", width: 24 },
    { header: "附件", key: "documents", width: 36 },
    { header: "转化案件", key: "matter", width: 28 },
    { header: "不接案/补正原因", key: "declinedReason", width: 30 },
    { header: "创建时间", key: "createdAt", width: 18 },
    { header: "更新时间", key: "updatedAt", width: 18 }
  ];
  const typedColumns =
    kind === "litigation"
      ? litigationColumns
      : kind === "project"
        ? projectColumns
        : counselColumns;
  return [...commonStart, ...typedColumns, ...commonEnd];
}

export function matterColumnsForKind(
  kind: MatterCategoryKind,
  maxProcedures: number
): Partial<ExcelJS.Column>[] {
  const commonStart: Partial<ExcelJS.Column>[] = [
    { header: "系统编号", key: "internalCode", width: 16 },
    { header: "所内案号", key: "firmCaseNo", width: 18 },
    { header: "案件名称", key: "title", width: 38 },
    { header: "案件分类", key: "category", width: 12 },
    { header: "案件状态", key: "status", width: 12 },
    { header: "收案时间", key: "intakeDate", width: 12 },
    { header: "首次立案/受理", key: "firstAcceptedAt", width: 12 },
    { header: "结案时间", key: "closedAt", width: 12 },
    { header: "归档时间", key: "archivedAt", width: 12 },
    { header: "主客户", key: "primaryClient", width: 20 },
    { header: "主客户类型", key: "primaryClientType", width: 12 },
    { header: "主客户证件/代码", key: "primaryClientIdNumber", width: 22 },
    { header: "主客户地址", key: "primaryClientAddress", width: 28 },
    { header: "主客户法定代表人", key: "primaryClientLegalRep", width: 16 },
    { header: "主客户联系人", key: "primaryClientContacts", width: 28 },
    { header: "其他客户", key: "otherClients", width: 30 },
    { header: "主办律师", key: "owner", width: 12 },
    { header: "团队成员", key: "members", width: 30 }
  ];
  const litigationColumns: Partial<ExcelJS.Column>[] = [
    { header: "案由", key: "cause", width: 18 },
    { header: "自由案由", key: "causeFreeText", width: 18 },
    { header: "标的金额", key: "claimAmount", width: 14 },
    { header: "我方地位", key: "ourStanding", width: 14 },
    { header: "反诉原告", key: "counterclaimAsPlaintiff", width: 10 },
    { header: "反诉被告", key: "counterclaimAsDefendant", width: 10 },
    { header: "律协备案", key: "barFiling", width: 18 },
    { header: "案件当事人", key: "parties", width: 48 }
  ];
  const projectColumns: Partial<ExcelJS.Column>[] = [
    { header: "业务类型", key: "businessType", width: 16 },
    { header: "服务范围", key: "serviceScope", width: 28 },
    { header: "交付成果", key: "deliverables", width: 24 },
    { header: "服务起", key: "serviceStart", width: 12 },
    { header: "服务止", key: "serviceEnd", width: 12 },
    { header: "相关方", key: "parties", width: 48 },
    { header: "阶段/程序摘要", key: "procedureSummary", width: 42 }
  ];
  const counselColumns: Partial<ExcelJS.Column>[] = [
    { header: "顾问类型", key: "counselType", width: 16 },
    { header: "服务范围", key: "serviceScope", width: 28 },
    { header: "服务起", key: "serviceStart", width: 12 },
    { header: "服务止", key: "serviceEnd", width: 12 },
    { header: "相关方", key: "parties", width: 48 },
    { header: "阶段/程序摘要", key: "procedureSummary", width: 42 }
  ];
  const commonEnd: Partial<ExcelJS.Column>[] = [
    { header: "关联实体", key: "relatedEntities", width: 36 },
    { header: "关联案件", key: "relatedMatters", width: 36 },
    { header: "案件附件", key: "documents", width: 36 },
    { header: "自定义字段", key: "customValues", width: 30 },
    { header: "来源收案标题", key: "intakeTitle", width: 34 },
    { header: "来源收案状态", key: "intakeStatus", width: 12 },
    { header: "来源收案时间", key: "sourceReceivedAt", width: 12 },
    { header: "来源收案案情", key: "sourceDescription", width: 34 },
    { header: "来源收费方式", key: "sourceFeeType", width: 14 },
    { header: "来源律师费金额", key: "sourceFeeAmount", width: 14 },
    { header: "来源付款节点", key: "sourceFeeSchedule", width: 26 },
    { header: "来源费用备注", key: "sourceFeeNote", width: 24 },
    { header: "来源共同律师", key: "sourceCoUsers", width: 24 },
    { header: "来源附件", key: "sourceDocuments", width: 36 },
    { header: "创建时间", key: "createdAt", width: 18 },
    { header: "更新时间", key: "updatedAt", width: 18 }
  ];
  const litigationSourceColumns: Partial<ExcelJS.Column>[] = [
    { header: "来源收案首次程序", key: "sourceFirstProcedureType", width: 14 },
    { header: "来源争议解决机构", key: "sourceFirstAgency", width: 24 },
    { header: "来源管辖地", key: "sourceJurisdiction", width: 18 },
    { header: "来源我方地位", key: "sourceOurStanding", width: 14 },
    { header: "来源标的金额", key: "sourceClaimAmount", width: 14 },
    { header: "来源标的描述", key: "sourceClaimDescription", width: 24 },
    { header: "来源律协备案", key: "sourceBarFiling", width: 18 },
    { header: "来源是否反诉", key: "sourceCounterclaim", width: 12 }
  ];
  const projectSourceColumns: Partial<ExcelJS.Column>[] = [
    { header: "来源业务类型", key: "sourceBusinessType", width: 16 },
    { header: "来源服务范围", key: "sourceServiceScope", width: 28 },
    { header: "来源交付成果", key: "sourceDeliverables", width: 24 },
    { header: "来源服务起", key: "sourceServiceStart", width: 12 },
    { header: "来源服务止", key: "sourceServiceEnd", width: 12 }
  ];
  const counselSourceColumns: Partial<ExcelJS.Column>[] = [
    { header: "来源顾问类型", key: "sourceCounselType", width: 16 },
    { header: "来源服务范围", key: "sourceServiceScope", width: 28 },
    { header: "来源服务起", key: "sourceServiceStart", width: 12 },
    { header: "来源服务止", key: "sourceServiceEnd", width: 12 }
  ];
  const typedColumns =
    kind === "litigation"
      ? litigationColumns
      : kind === "project"
        ? projectColumns
        : counselColumns;
  const typedSourceColumns =
    kind === "litigation"
      ? litigationSourceColumns
      : kind === "project"
        ? projectSourceColumns
        : counselSourceColumns;
  const procedureColumns: Partial<ExcelJS.Column>[] = [];
  for (let i = 1; i <= maxProcedures; i += 1) {
    procedureColumns.push(
      { header: `程序${i}-类型`, key: `procedure${i}Type`, width: 14 },
      { header: `程序${i}-标签`, key: `procedure${i}Label`, width: 16 },
      { header: `程序${i}-参与方式`, key: `procedure${i}Engagement`, width: 12 },
      { header: `程序${i}-状态`, key: `procedure${i}Status`, width: 12 },
      { header: `程序${i}-案号`, key: `procedure${i}CaseNumber`, width: 24 },
      { header: `程序${i}-管辖地`, key: `procedure${i}Jurisdiction`, width: 18 },
      { header: `程序${i}-办理机关`, key: `procedure${i}HandlingAgency`, width: 24 },
      { header: `程序${i}-合议庭/部门`, key: `procedure${i}Panel`, width: 20 },
      { header: `程序${i}-经办人`, key: `procedure${i}Handler`, width: 16 },
      { header: `程序${i}-我方地位`, key: `procedure${i}OurStanding`, width: 14 },
      { header: `程序${i}-主办律师`, key: `procedure${i}LeadLawyer`, width: 14 },
      { header: `程序${i}-外部代理`, key: `procedure${i}ExternalLead`, width: 10 },
      { header: `程序${i}-立案/受理`, key: `procedure${i}AcceptedAt`, width: 12 },
      { header: `程序${i}-裁决/结案`, key: `procedure${i}ConcludedAt`, width: 12 },
      { header: `程序${i}-结果`, key: `procedure${i}Outcome`, width: 12 },
      { header: `程序${i}-结果说明`, key: `procedure${i}OutcomeNote`, width: 26 },
      { header: `程序${i}-主审/仲裁员/执行法官`, key: `procedure${i}PresidingJudge`, width: 22 },
      { header: `程序${i}-联系方式`, key: `procedure${i}PresidingJudgeContact`, width: 18 },
      { header: `程序${i}-助理`, key: `procedure${i}JudgeAssistant`, width: 16 },
      { header: `程序${i}-助理联系方式`, key: `procedure${i}JudgeAssistantContact`, width: 18 },
      { header: `程序${i}-程序当事人`, key: `procedure${i}Parties`, width: 48 }
    );
  }

  return [
    ...commonStart,
    ...typedColumns,
    ...procedureColumns,
    ...typedSourceColumns,
    ...commonEnd
  ];
}
