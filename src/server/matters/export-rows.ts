import type { MatterMemberRole } from "@prisma/client";
import { decryptIdNumber } from "@/lib/clients/id-number-crypto";
import {
  barFilingLabel,
  clientTypeLabel,
  feeTypeLabel,
  intakeStatusLabel,
  litigationStandingLabel,
  matterCategoryLabel,
  matterStatusLabel,
  procedureTypeLabel
} from "@/lib/enums";
import {
  decimalNumber, formatContacts, formatDate, formatDateTime, formatDocuments, formatJson,
  formatParties, formatParty, formatProcedureSummary, formatRelatedMatters, label,
  procedureEngagementLabel, procedureOutcomeLabel, procedureStatusLabel, yesNo
} from "./export-format";
import type { IntakeExportRow, MatterExportRow } from "./export-query";

/**
 * 案件工作簿导出的行装配：把取数结果映射成与列 key 对齐的单元格对象。
 *
 * 依赖方向：export-xlsx（编排层）→ export-rows → export-query / export-format。
 * 行类型（IntakeExportRow / MatterExportRow）由 export-query 提供，本层不 import export-xlsx。
 */

const memberRoleLabel: Record<MatterMemberRole, string> = {
  LEAD: "主办",
  CO_LEAD: "协办",
  ASSISTANT: "助理"
};

export function buildIntakeRow(intake: IntakeExportRow, coUserNames: Map<string, string>) {
  return {
    id: intake.id,
    title: intake.title,
    category: matterCategoryLabel[intake.category],
    status: label(intakeStatusLabel, intake.status),
    receivedAt: formatDate(intake.receivedAt),
    cause: intake.cause?.name ?? "",
    causeFreeText: intake.causeFreeText ?? "",
    description: intake.description ?? "",
    client: intake.client?.name ?? "",
    clientType: intake.client ? clientTypeLabel[intake.client.type] : label(clientTypeLabel, intake.clientType),
    clientIdNumber: decryptIdNumber(intake.client?.idNumber),
    clientAddress: intake.client?.address ?? "",
    clientLegalRep: intake.client?.legalRep ?? "",
    contactName: intake.contactName ?? "",
    contactPhone: intake.contactPhone ?? intake.client?.phone ?? "",
    clientContacts: formatContacts(intake.client?.contacts ?? []),
    firstProcedureType: label(procedureTypeLabel, intake.firstProcedureType),
    firstAgency: intake.firstAgency ?? "",
    jurisdiction: intake.jurisdiction ?? "",
    ourStanding: label(litigationStandingLabel, intake.ourStanding),
    money: decimalNumber(intake.claimAmount),
    claimDescription: intake.claimDescription ?? "",
    barFiling: label(barFilingLabel, intake.barFiling),
    counterclaim: yesNo(intake.counterclaim),
    businessType: intake.businessType ?? "",
    serviceScope: intake.serviceScope ?? "",
    deliverables: intake.deliverables ?? "",
    counselType: intake.counselType ?? "",
    serviceStart: formatDate(intake.serviceStart),
    serviceEnd: formatDate(intake.serviceEnd),
    feeType: label(feeTypeLabel, intake.feeType),
    feeAmount: decimalNumber(intake.feeAmount),
    contingencyTerms: intake.contingencyTerms ?? "",
    feeSchedule: intake.feeSchedule ?? "",
    feeNote: intake.feeNote ?? "",
    owner: intake.ownerUser?.name ?? "",
    coUsers: intake.coUserIds.map((id) => coUserNames.get(id) ?? id).join("；"),
    parties: formatParties(intake.parties),
    documents: formatDocuments(intake.documents),
    matter: intake.matter
      ? `${intake.matter.firmCaseNo ?? intake.matter.internalCode} ${intake.matter.title}`
      : "",
    declinedReason: intake.declinedReason ?? "",
    createdAt: formatDateTime(intake.createdAt),
    updatedAt: formatDateTime(intake.updatedAt)
  };
}

export function buildMatterRow(
  matter: MatterExportRow,
  maxProcedures: number,
  coUserNames: Map<string, string>
) {
  const otherClients = matter.clientLinks
    .filter((link) => link.clientId !== matter.primaryClientId)
    .map((link) => `${link.label ? `${link.label}:` : ""}${link.client.name}`)
    .join("；");
  const source = matter.intake;
  const row: Record<string, unknown> = {
    internalCode: matter.internalCode,
    firmCaseNo: matter.firmCaseNo ?? "",
    title: matter.title,
    category: matterCategoryLabel[matter.category],
    status: matterStatusLabel[matter.status],
    cause: matter.cause?.name ?? "",
    causeFreeText: matter.causeFreeText ?? "",
    claimAmount: decimalNumber(matter.claimAmount),
    ourStanding: label(litigationStandingLabel, matter.ourStanding),
    counterclaimAsPlaintiff: yesNo(matter.counterclaimAsPlaintiff),
    counterclaimAsDefendant: yesNo(matter.counterclaimAsDefendant),
    barFiling: label(barFilingLabel, matter.barFiling),
    businessType: matter.businessType ?? "",
    serviceScope: matter.serviceScope ?? "",
    deliverables: matter.deliverables ?? "",
    counselType: matter.counselType ?? "",
    serviceStart: formatDate(matter.serviceStart),
    serviceEnd: formatDate(matter.serviceEnd),
    intakeDate: formatDate(matter.intakeDate),
    firstAcceptedAt: formatDate(matter.firstAcceptedAt),
    closedAt: formatDate(matter.closedAt),
    archivedAt: formatDate(matter.archivedAt),
    primaryClient: matter.primaryClient?.name ?? "",
    primaryClientType: matter.primaryClient ? clientTypeLabel[matter.primaryClient.type] : "",
    primaryClientIdNumber: decryptIdNumber(matter.primaryClient?.idNumber),
    primaryClientAddress: matter.primaryClient?.address ?? "",
    primaryClientLegalRep: matter.primaryClient?.legalRep ?? "",
    primaryClientContacts: formatContacts(matter.primaryClient?.contacts ?? []),
    otherClients,
    owner: matter.owner.name,
    members: matter.members
      .map((member) => `${member.user.name}（${memberRoleLabel[member.role]}）`)
      .join("；"),
    parties: formatParties(matter.parties),
    procedureSummary: formatProcedureSummary(matter.procedures),
    relatedEntities: matter.relatedEntities
      .map((entity) => [entity.name, entity.relationship, entity.notes].filter(Boolean).join(" / "))
      .join("；"),
    relatedMatters: formatRelatedMatters(matter),
    documents: formatDocuments(matter.documents),
    customValues: formatJson(matter.customValues),
    intakeTitle: source?.title ?? "",
    intakeStatus: label(intakeStatusLabel, source?.status),
    sourceReceivedAt: formatDate(source?.receivedAt),
    sourceDescription: source?.description ?? "",
    sourceFirstProcedureType: label(procedureTypeLabel, source?.firstProcedureType),
    sourceFirstAgency: source?.firstAgency ?? "",
    sourceJurisdiction: source?.jurisdiction ?? "",
    sourceOurStanding: label(litigationStandingLabel, source?.ourStanding),
    sourceClaimAmount: decimalNumber(source?.claimAmount),
    sourceClaimDescription: source?.claimDescription ?? "",
    sourceBarFiling: label(barFilingLabel, source?.barFiling),
    sourceCounterclaim: source ? yesNo(source.counterclaim) : "",
    sourceBusinessType: source?.businessType ?? "",
    sourceServiceScope: source?.serviceScope ?? "",
    sourceDeliverables: source?.deliverables ?? "",
    sourceCounselType: source?.counselType ?? "",
    sourceServiceStart: formatDate(source?.serviceStart),
    sourceServiceEnd: formatDate(source?.serviceEnd),
    sourceFeeType: label(feeTypeLabel, source?.feeType),
    sourceFeeAmount: decimalNumber(source?.feeAmount),
    sourceFeeSchedule: source?.feeSchedule ?? "",
    sourceFeeNote: source?.feeNote ?? "",
    sourceCoUsers: (source?.coUserIds ?? []).map((id) => coUserNames.get(id) ?? id).join("；"),
    sourceDocuments: formatDocuments(source?.documents ?? []),
    createdAt: formatDateTime(matter.createdAt),
    updatedAt: formatDateTime(matter.updatedAt)
  };

  for (let i = 0; i < maxProcedures; i += 1) {
    Object.assign(row, buildProcedureCells(matter.procedures[i], i + 1));
  }
  return row;
}

export function buildProcedureCells(
  procedure: MatterExportRow["procedures"][number] | undefined,
  index: number
) {
  if (!procedure) return {};
  return {
    [`procedure${index}Type`]: label(procedureTypeLabel, procedure.type),
    [`procedure${index}Label`]: procedure.customLabel ?? "",
    [`procedure${index}Engagement`]: procedureEngagementLabel[procedure.engagement],
    [`procedure${index}Status`]: procedureStatusLabel[procedure.status],
    [`procedure${index}CaseNumber`]: procedure.caseNumber ?? "",
    [`procedure${index}Jurisdiction`]: procedure.jurisdiction ?? "",
    [`procedure${index}HandlingAgency`]: procedure.handlingAgency ?? "",
    [`procedure${index}Panel`]: procedure.panel ?? "",
    [`procedure${index}Handler`]: procedure.handler ?? "",
    [`procedure${index}OurStanding`]: label(litigationStandingLabel, procedure.ourStanding),
    [`procedure${index}LeadLawyer`]: procedure.leadLawyer?.name ?? "",
    [`procedure${index}ExternalLead`]: yesNo(procedure.isExternalLead),
    [`procedure${index}AcceptedAt`]: formatDate(procedure.acceptedAt),
    [`procedure${index}ConcludedAt`]: formatDate(procedure.concludedAt),
    [`procedure${index}Outcome`]: label(procedureOutcomeLabel, procedure.outcome),
    [`procedure${index}OutcomeNote`]: procedure.outcomeNote ?? "",
    [`procedure${index}PresidingJudge`]: procedure.presidingJudge ?? "",
    [`procedure${index}PresidingJudgeContact`]: procedure.presidingJudgeContact ?? "",
    [`procedure${index}JudgeAssistant`]: procedure.judgeAssistant ?? "",
    [`procedure${index}JudgeAssistantContact`]: procedure.judgeAssistantContact ?? "",
    [`procedure${index}Parties`]: procedure.procedureParties
      .map((row) => `${label(litigationStandingLabel, row.standing)}：${formatParty(row.party)}`)
      .join("；")
  };
}
