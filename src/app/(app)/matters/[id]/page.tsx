import {getClosureBoard} from "@/server/archive/closure-actions";
import {MatterClosurePanel} from "@/components/matters/closure-panel";
import {getWorkBoard} from "@/server/reminders/work-actions";
import {WorkResponsibilityPanel} from "@/components/matters/work-responsibility-panel";
import {readMatterReview} from "@/server/conflicts/matter-review";
import {MatterConflictReview} from "./_components/conflict-review";
import { hasCustomPermission } from "@/lib/roles/catalog";
import { hasMatterBusinessAccess, isManager } from "@/lib/permissions";
import { isSystemAdmin } from "@/lib/auth/system-role";
import { getWallSummaryForMatter } from "@/server/ethical-walls/read";
import { TeamMatterOverview } from "./_components/team-matter-overview";
import { notFound, redirect } from "next/navigation";
import { getMatterById } from "@/server/matters/actions";
import { ActionError } from "@/lib/action-error";
import { listWriteOffs } from "@/server/finance/writeoff-actions";
import { suggestCommissionRoles } from "@/server/finance/commission-roles";
import { getMatterFinance } from "@/server/finance/actions";
import { listActiveColleagues } from "@/server/users/actions";
import { getLatestArchiveRecord } from "@/server/archive/actions";
import { getMatterReviewSummary } from "@/server/ai/matter-review-summary";
import { getSession } from "@/lib/auth/session";
import { getAiSettings } from "@/lib/ai/settings";
import { getYuandianSettings } from "@/lib/yuandian/settings";
import { resolveMatterRoute } from "@/server/matters/route";
import { matterHref } from "@/lib/matters/route";
import { prisma } from "@/lib/prisma";
import { nullableDecimalToNumber, serializeDecimals } from "@/lib/decimal";
import { MatterDetailTabs } from "./_components/matter-detail-tabs";
import { MatterSignalStrip } from "./_components/matter-signal-strip";
import { getMatterSignals } from "@/server/matters/signals";
import { listEngagementsForMatter } from "@/server/engagements/actions";
import { TimePanel } from "./_components/time-panel";
import { getMatterTimeBoard } from "@/server/time/actions";
import { listNotes } from "@/server/notes/actions";
import { ReviewSummaryCard } from "./_components/review-summary-card";
import { listEvidenceItems } from "@/server/evidence/actions";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function MatterDetailPage({ params }: PageProps) {
  const { id: param } = await params;

  // 路由键是 internalCode（`LL-2026-CC-0001`），但历史书签、通知与审计日志里
  // 存的是 cuid 地址，两者都要认；命中 cuid 时在鉴权通过后再跳规范地址。
  const route = await resolveMatterRoute(param);
  if (!route) notFound();

  // getMatterById 在无权访问时抛 ActionError("案件不存在")——这个措辞是刻意的：
  // 不区分「真不存在」与「被隔离/无权」，避免泄露案件存在性（隔离墙的存在本身即机密）。
  // 但页面必须把它转成 404，否则正常拦截会表现为 500，运维会误判为故障。
  let matterRaw: Awaited<ReturnType<typeof getMatterById>>;
  try {
    matterRaw = await getMatterById(route.id);
  } catch (err) {
    if (err instanceof ActionError) notFound();
    throw err;
  }
  const session = await getSession();
  if (!matterRaw) notFound();

  if (param !== route.internalCode) redirect(matterHref(route));

  if (session?.user && !await hasMatterBusinessAccess(session.user.id, session.user.role, matterRaw.id, session.user.rolePermissions)) {
    return <TeamMatterOverview matter={matterRaw} />;
  }

  if (!session?.user) redirect("/login");
  const allowed = (key: import("@/lib/roles/catalog").PermissionKey) => hasCustomPermission(session.user, key);
  const matter = {
    ...matterRaw,
    claimAmount: nullableDecimalToNumber(matterRaw.claimAmount),
    intake: matterRaw.intake
      ? { ...matterRaw.intake, feeAmount: nullableDecimalToNumber(matterRaw.intake.feeAmount) }
      : matterRaw.intake
  };

  const [
    financeRaw,
    userOptions,
    documents,
    folders,
    templates,
    allColleagues,
    sealContracts,
    expresses,
    latestArchive,
    customFieldDefs,
    preservationCases,
    writeOffRows,
    commissionSuggestions
  ] = await Promise.all([
    allowed("finance.read") ? getMatterFinance(matter.id) : Promise.resolve({ billings: [], entries: [], plans: [], stats: { outstanding:0, allocated:0, clientFunds:0, contractAmount: 0, receivable: 0, received: 0, pendingReceived: 0, refund: 0, cost: 0, commission: 0, invoiced: 0, writeOff: 0, outstandingNet: 0 }, writeOffs: [], contingency: { plans: [], total: 0 } }),
    listActiveColleagues(),
    prisma.document.findMany({
      where: { matterId: matter.id, deletedAt: null, ...(!allowed("documents.read") ? { id: { in: [] } } : {}) },
      orderBy: { createdAt: "desc" },
      include: {
        uploadedBy: { select: { id: true, name: true } },
        procedure: { select: { id: true, type: true, customLabel: true } }
      }
    }),
    // v0.8: 卷宗
    prisma.documentFolder.findMany({
      where: { matterId: matter.id, ...(!allowed("documents.read") ? { id: { in: [] } } : {}) },
      orderBy: [{ orderIndex: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true, orderIndex: true, isDefault: true }
    }),
    // v0.8: 适用本案件类别的模板
    prisma.documentTemplate.findMany({
      where: {
        enabled: true,
        OR: [
          { applicableCategories: { isEmpty: true } },
          { applicableCategories: { has: matter.category } }
        ]
      },
      orderBy: [{ category: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        category: true,
        description: true,
        applicableCategories: true,
        variables: true,
        isBuiltIn: true
      }
    }),
    listActiveColleagues(),
    // v0.11: 案件下用印申请关联的合同附件（待盖章稿 + 盖章后扫描件）
    prisma.sealRequest.findMany({
      where: { matterId: matter.id, ...(session.user.role === "CUSTOM" ? { requestedById: session.user.id } : {}) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        code: true,
        documentTitle: true,
        status: true,
        createdAt: true,
        draftDoc: { select: { id: true, name: true, size: true, createdAt: true } },
        stampedDoc: { select: { id: true, name: true, size: true, createdAt: true } }
      }
    }),
    // v0.11: 案件下快递追踪
    prisma.expressTracking.findMany({
      where: { matterId: matter.id, ...(!allowed("express.manage") ? { id: { in: [] } } : {}) },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        trackingNo: true,
        companyCode: true,
        direction: true,
        purpose: true,
        lastState: true,
        lastUpdateAt: true,
        createdAt: true
      }
    }),
    // v0.18: 最新归档申请状态（用于显示"归档中"/"已驳回" banner）
    allowed("archive.read") ? getLatestArchiveRecord(matter.id) : Promise.resolve(null),
    // v0.28: 案件自定义字段定义（启用项）
    prisma.customFieldDef.findMany({
      where: { entityType: "MATTER", enabled: true },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
      select: { id: true, key: true, label: true, fieldType: true, options: true, required: true }
    }),
    prisma.preservationCase.findMany({
      where: { matterId: matter.id },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
      include: {
        matter: { select: { id: true, internalCode: true, title: true } },
        owner: { select: { id: true, name: true } },
        targets: {
          orderBy: { createdAt: "asc" },
          include: {
            properties: {
              orderBy: { expiryDate: "asc" },
              include: {
                renewals: { orderBy: { renewedAt: "desc" }, take: 3 }
              }
            }
          }
        }
      }
    }),
    // 2026-11-22 P0-5：坏账明细（含申报人/状态，用于界面展示与审批）
    allowed("finance.read") ? listWriteOffs(matter.id) : Promise.resolve([]),
    // 2026-11-22 D 段：分成角色建议（只建议、不自动写）
    allowed("finance.read") ? suggestCommissionRoles(matter.id) : Promise.resolve([])
  ]);

  // getMatterFinance 已在 action 出口统一序列化 Decimal
  const finance = financeRaw;

  // v0.22: 本案 AI 审查总览（聚合 ReviewRecord）
  const reviewSummary = allowed("documents.read") ? await getMatterReviewSummary(matter.id) : null;
  // v1.x P2: 委托与证据链（详情页区块；read 已在页面入口校验）
  const [evidenceItems, notes] = await Promise.all([
    listEvidenceItems(matter.id).catch(() => []),
    allowed("schedule.read") ? listNotes(matter.id).catch(() => []) : Promise.resolve([])
  ]);
  const currentMatterMember = session?.user.id
    ? matter.members.find((member) => member.userId === session.user.id)
    : null;
  const canAssociateThisMatter = Boolean(
    allowed("matters.write") && session?.user.id &&
      (matter.ownerId === session.user.id ||
        currentMatterMember)
  );
  const canLeadThisMatter = Boolean(
    allowed("matters.write") && session?.user.id &&
      (matter.ownerId === session.user.id ||
        currentMatterMember?.role === "LEAD" ||
        currentMatterMember?.role === "CO_LEAD")
  );
  const canOwnThisMatter = Boolean(allowed("matters.write") && session?.user.id && matter.ownerId === session.user.id);

  // v0.8: 卷宗对应文档（含 templateId 标识）
  const folderDocuments = documents.map((d) => ({
    id: d.id,
    name: d.name,
    size: d.size,
    folderId: d.folderId,
    templateId: d.templateId,
    createdAt: d.createdAt
  }));
  const preservationCasesForClient = serializeDecimals(preservationCases);

  const conflictReview=await readMatterReview(prisma,matter.id);
  // 隔离墙知情提示（P0-3 ⑤）：能看本案的人应当知道本案挡了谁，否则会把材料转给被隔离的同事。
  // 注意 getWallSummaryForMatter 本身不做鉴权——上面的 getMatterById 已保证调用方有权读本案。
  // 管理入口只给能进 /admin 的人（与 AdminLayout 的 canEnterAdminWorkspace 同一口径：
  // isSystemAdmin || PRINCIPAL_LAWYER || managerAuthorized）。
  const wallSummary = await getWallSummaryForMatter(matter.id);
  const canOpenWallAdmin = isSystemAdmin(session.user) || isManager(session.user);
  // P0-1 阶段 1-b：工时页签（列表 + 三角汇总）。可见性由 getMatterTimeBoard 内部
  // 复用 assertCanReadMatter 判定，与本案详情页同一断言。
  const timeBoard = allowed("matters.read") ? await getMatterTimeBoard(matter.id).catch(() => null) : null;
  // 墨案 04 ② 信号条：此前只存在于组件文件与注释里，页面从未渲染。
  // 用专用聚合查询（src/server/matters/signals.ts）——详情页既有的 procedures select
  // 是为程序卡片裁剪过的，塞不下信号条需要的四卡口径。
  const signals = await getMatterSignals(matter.id).catch(() => ({ procedures: [], invoicePending: 0 }));
  // 委托：客户 → 委托 → 合同 → 收付，委托是中间那环。后端与测试早已存在，界面此前无入口。
  const engagementsForMatter = await listEngagementsForMatter(matter.id).catch(() => []);
  // 与 MatterDetailTabs 同口径：优先第一个未结案的程序，否则第一个
  const signalCurrent = signals.procedures.find((p) => p.status !== "CONCLUDED") ?? signals.procedures[0] ?? null;
  const currentSignalProcedures = signalCurrent ? [signalCurrent] : [];
  return (
    <>
      {/* 墨案 04 页面骨架由 MatterDetailTabs 统一承载：
          上下文头 → 信号条 → 程序链卡 → 三栏工作区（环节导航 / 工作区 / 辅助栏） */}
      <MatterDetailTabs
        responsibilityNode={<WorkResponsibilityPanel data={await getWorkBoard({matterId:matter.id})} matterId={matter.id}/>}
        closureNode={<MatterClosurePanel matterId={matter.id} data={allowed("archive.read")?await getClosureBoard(matter.id):null}/>}
        conflictNode={<MatterConflictReview matterId={matter.id} data={conflictReview} canWrite={allowed("matters.write")&&matter.status!=="ARCHIVED"}/>}
        matter={matter}
        finance={finance}
        writeOffRows={writeOffRows}
        commissionSuggestions={commissionSuggestions}
        userOptions={[
          ...userOptions,
          ...matter.members.filter((m) => !userOptions.some((u) => u.id === m.userId)).map((m) => ({ ...m.user, active: false, isTeammate: false }))
        ]}
        documents={documents}
        folders={folders}
        folderDocuments={folderDocuments}
        templates={templates.map((t) => ({
          ...t,
          variables: Array.isArray(t.variables) ? (t.variables as string[]) : []
        }))}
        colleagues={allColleagues.map((c) => ({ id: c.id, name: c.name }))}
        rolePermissions={session.user.rolePermissions}
        currentUserRole={session?.user.role ?? null}
        canAssociateThisMatter={canAssociateThisMatter}
        canLeadThisMatter={canLeadThisMatter}
        canOwnThisMatter={canOwnThisMatter}
        sealContracts={sealContracts}
        expresses={expresses}
        latestArchive={latestArchive}
        wallSummary={wallSummary}
        canOpenWallAdmin={canOpenWallAdmin}
        customFieldDefs={customFieldDefs}
        preservationCases={preservationCasesForClient}
        evidenceItems={evidenceItems}
        notes={notes}
        viewerId={session?.user?.id}
        capabilities={{
          aiReview: (await getAiSettings().catch(() => null))?.configured ?? false,
          caseSearch: (await getYuandianSettings().catch(() => null))?.configured ?? false
        }}
        reviewNode={
          reviewSummary ? <ReviewSummaryCard summary={reviewSummary} matterId={matter.id} /> : undefined
        }
        engagements={engagementsForMatter}
        signalNode={
          <MatterSignalStrip
            procedures={currentSignalProcedures as unknown as Parameters<typeof MatterSignalStrip>[0]["procedures"]}
            allProcedures={signals.procedures as unknown as Parameters<typeof MatterSignalStrip>[0]["allProcedures"]}
            finance={
              finance?.stats
                ? {
                    contractAmount: Number(finance.stats.contractAmount ?? 0),
                    received: Number(finance.stats.received ?? 0),
                    receivable: Number(finance.stats.receivable ?? 0),
                    invoiced: Number(finance.stats.invoiced ?? 0)
                  }
                : null
            }
            invoicePending={signals.invoicePending}
            service={
              matter.serviceStart || matter.serviceEnd
                ? { start: matter.serviceStart, end: matter.serviceEnd }
                : null
            }
          />
        }
        timeNode={
          timeBoard ? (
            <TimePanel
              matterId={matter.id}
              board={timeBoard}
              canWrite={allowed("matters.write") && matter.status !== "ARCHIVED"}
            />
          ) : undefined
        }
      />
    </>
  );
}
