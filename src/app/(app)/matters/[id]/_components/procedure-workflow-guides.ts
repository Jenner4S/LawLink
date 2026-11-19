/**
 * 环节指引数据表（2026-11-21 从 procedure-workflow-panel.tsx 拆出）
 *
 * 这些是从「环节名」到「该环节该做哪些事/该收哪些材料」的静态映射，约 350 行。
 * 它们是**数据**不是**行为**：面板要改的是渲染与交互，而这张表只在业务口径变化时
 * 才动（新增程序类型、调整必交材料）。放在一起会让每次改 UI 都要滑过 350 行常量。
 *
 * 拆出前该文件 3488 行、约 30 个顶层定义，其中只有一个组件被导出 ——
 * 属于「宽内部复杂度、窄外部表面」，拆分风险集中在类型引用上，tsc 会全部兜住。
 */
import type { DocumentCategory } from "@prisma/client";
import { PRESERVATION_ACTIONS } from "./procedure-workflow-types";
import type { StageGuide } from "./procedure-workflow-types";

export const DEFAULT_STAGE_GUIDE: StageGuide = {
  summary: "记录本环节的任务、文件和沟通结果，作为当前程序的工作留痕。",
  checklistTitle: "本环节事项",
  checklist: ["明确本环节目标和交付物", "记录当事人或法院沟通要点", "归集本环节形成的材料"],
  actions: ["工作底稿", "补充说明"],
  deadlineCategories: [],
  materialCategories: [],
  materialPattern: /阶段|说明|记录|底稿|工作/,
  defaultCategory: "PROCEDURE"
};

export const STAGE_GUIDES: { keys: string[]; guide: StageGuide }[] = [
  {
    keys: ["代理授权", "委托手续"],
    guide: {
      summary: "办理代理合同、授权文件、律所手续、风险告知、费用到账和材料交接留痕。",
      checklistTitle: "委托手续",
      checklist: [
        "核对委托人身份和签章主体",
        "签署委托代理合同、授权委托书、所函",
        "完成风险告知、工作联系函和材料交接留痕",
        "确认律师费到账、发票和原件移交记录"
      ],
      actions: ["委托代理合同", "授权委托书", "律所函", "风险告知书", "工作联系函", "证据原件交接单"],
      deadlineCategories: [],
      materialCategories: ["CONTRACT"],
      materialPattern: /授权|委托|所函|律所函|风险告知|联系函|发票|签收|交接/,
      defaultCategory: "CONTRACT"
    }
  },
  {
    keys: ["财产保全"],
    guide: {
      summary: "围绕保全申请、担保、缴费、裁定、续封和解除组织材料。",
      checklistTitle: "保全事项",
      checklist: [
        "确认保全范围、财产线索和担保方式",
        "提交保全申请、担保书/保函和财产线索",
        "跟进缴费、裁定、查封冻结结果和首封情况",
        "记录保全期限并提前安排续保或解除"
      ],
      actions: PRESERVATION_ACTIONS,
      deadlineCategories: ["PRESERVATION"],
      materialCategories: [],
      materialPattern: /保全|财产线索|担保|保函|查封|冻结|续封|续保|解除|裁定|协助执行/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["案情研判", "材料消化", "诉讼方案", "二审阅卷研判"],
    guide: {
      summary: "消化基础材料，形成事实摘要、证据缺口、法律检索和诉讼代理方案。",
      checklistTitle: "研判事项",
      checklist: [
        "梳理案件事实、法律关系、争议焦点",
        "核对证据原件或扫描件，列出缺漏清单",
        "完成法律法规、案例和司法观点检索",
        "向当事人确认关键事实和诉讼方案"
      ],
      actions: ["案件事实摘要", "法律关系图", "证据缺口清单", "法律检索报告", "诉讼代理方案"],
      deadlineCategories: [],
      materialCategories: [],
      materialPattern: /摘要|法律关系|检索|方案|证据缺口|材料清单|事实梳理/,
      defaultCategory: "OTHER"
    }
  },
  {
    keys: ["执行立案"],
    guide: {
      summary: "准备强制执行申请材料，确认生效、履行期限和执行法院立案要求。",
      checklistTitle: "执行立案事项",
      checklist: [
        "确认裁判文书已生效且履行期限届满",
        "准备强制执行申请书、生效文书和身份材料",
        "补齐申请人账户确认书、送达地址确认书和委托手续",
        "立案后一周内跟进承办法官联系方式"
      ],
      actions: ["强制执行申请书", "生效证明", "申请人账号确认书", "送达地址确认书", "执行立案材料清单"],
      deadlineCategories: ["PERFORMANCE", "ENFORCEMENT"],
      materialCategories: [],
      materialPattern: /执行申请|强制执行|生效|履行|账号确认|送达地址/,
      defaultCategory: "PLEADING"
    }
  },
  {
    keys: ["起诉立案", "仲裁立案"],
    guide: {
      summary: "完成起诉或仲裁申请材料、主体身份、管辖依据、证据目录、缴费和诉调跟进。",
      checklistTitle: "立案事项",
      checklist: [
        "确认请求标的、管辖法院或仲裁机构",
        "整理起诉状/仲裁申请、身份材料、授权手续和证据目录",
        "核对被告身份、送达信息、管辖材料和保全材料",
        "跟进立案审查、诉调转立案和诉讼费/仲裁费缴纳"
      ],
      actions: ["民事起诉状", "仲裁申请书", "证据目录", "送达地址确认书", "诉讼费缴费凭证", "立案材料清单"],
      deadlineCategories: ["LIMITATION"],
      materialCategories: [],
      materialPattern: /起诉|仲裁申请|立案|证据目录|送达地址|诉讼费|仲裁费|管辖材料/,
      defaultCategory: "PLEADING"
    }
  },
  {
    keys: ["管辖异议", "管辖权异议"],
    guide: {
      summary: "处理对方管辖异议、答辩、裁定签收和异议上诉/答辩衔接。",
      checklistTitle: "管辖事项",
      checklist: [
        "签收并研判对方管辖权异议理由",
        "提交管辖权异议答辩意见及证据",
        "跟进裁定结果并告知当事人",
        "在上诉期内处理异议上诉或二审答辩"
      ],
      actions: ["管辖权异议答辩意见", "管辖权异议申请书", "管辖异议上诉状", "管辖异议裁定签收记录"],
      deadlineCategories: ["APPEAL", "RESPONSE"],
      materialCategories: [],
      materialPattern: /管辖|异议|移送|裁定|上诉/,
      defaultCategory: "PLEADING"
    }
  },
  {
    keys: ["举证质证"],
    guide: {
      summary: "围绕举证期限、补充证据、调查令、鉴定、证人出庭和对方证据质证组织工作。",
      checklistTitle: "举证事项",
      checklist: [
        "记录举证通知签收日并计算举证期限",
        "复核全案材料，确认补充证据和反驳证据",
        "评估调查令、法院调查取证、鉴定和证人出庭申请",
        "收到对方证据后与当事人核实真实性并形成质证意见"
      ],
      actions: ["证据目录", "补充证据清单", "质证意见", "调查取证申请书", "证人出庭申请书"],
      deadlineCategories: ["EVIDENCE"],
      materialCategories: ["EVIDENCE"],
      materialPattern: /证据|举证|质证|调查令|调查取证|证人|反驳证据/,
      defaultCategory: "EVIDENCE"
    }
  },
  {
    keys: ["鉴定申请", "司法鉴定"],
    guide: {
      summary: "判断是否申请鉴定、提出鉴定事项、异议、补充材料和专家辅助人安排。",
      checklistTitle: "鉴定事项",
      checklist: [
        "确认鉴定必要性、鉴定事项和证明目的",
        "准备鉴定申请、样本材料和费用沟通",
        "处理鉴定机构、鉴定材料和鉴定意见异议",
        "需要时安排专家辅助人出庭"
      ],
      actions: ["鉴定申请书", "鉴定材料清单", "鉴定异议书", "专家辅助人出庭申请书"],
      deadlineCategories: ["EVIDENCE"],
      materialCategories: [],
      materialPattern: /鉴定|专家|辅助人|样本|检材/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["庭前会议"],
    guide: {
      summary: "处理庭前会议通知、争点归纳、证据交换、程序事项和庭审安排。",
      checklistTitle: "庭前会议事项",
      checklist: [
        "确认庭前会议时间、地点、参加人员和会议目的",
        "准备争议焦点、证据交换意见和程序性申请",
        "记录法院或仲裁庭确认的审理范围和举证安排",
        "根据会议结果修订庭审提纲和证据组织方案"
      ],
      actions: ["庭前会议提纲", "争议焦点清单", "证据交换意见", "程序事项申请书", "庭前会议记录"],
      deadlineCategories: ["EVIDENCE", "CUSTOM"],
      includeHearings: true,
      materialCategories: [],
      materialPattern: /庭前会议|争议焦点|证据交换|程序事项|会议记录/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["模拟法庭"],
    guide: {
      summary: "围绕庭审争点、发问路径、攻防预案和客户出庭表现做正式开庭前演练。",
      checklistTitle: "模拟事项",
      checklist: [
        "形成争点清单和证明责任分配表",
        "准备我方发问、反问和对方可能追问清单",
        "演练法庭调查、法庭辩论和最后陈述",
        "记录演练暴露的问题并修订庭审提纲"
      ],
      actions: ["模拟法庭脚本", "争点攻防清单", "发问提纲", "客户庭前沟通记录", "庭审风险提示"],
      deadlineCategories: [],
      materialCategories: [],
      materialPattern: /模拟法庭|攻防|发问|反问|演练|庭审风险|庭前沟通/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["开庭准备", "开庭/询问", "开庭审理"],
    guide: {
      summary: "围绕开庭通知、证据原件、庭审提纲、质证意见、发问提纲和客户庭前沟通做准备。",
      checklistTitle: "庭前事项",
      checklist: [
        "确认开庭时间、地点、法庭和书记员联系方式",
        "核对证据原件、对方证据和是否变更诉请",
        "准备庭审提纲、发问提纲、质证意见和代理词提纲",
        "向当事人交代出庭材料、庭审流程和注意事项"
      ],
      actions: ["庭审提纲", "发问提纲", "质证意见", "代理词提纲", "庭前沟通记录"],
      deadlineCategories: [],
      includeHearings: true,
      materialCategories: [],
      materialPattern: /开庭|庭审|传票|发问|提纲|质证|原件|代理词/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["庭后工作", "庭后代理词", "庭后补充"],
    guide: {
      summary: "庭后复盘并提交代理意见、补充材料，向客户汇报并持续跟进裁判进度。",
      checklistTitle: "庭后事项",
      checklist: [
        "庭后向当事人汇报庭审情况并留痕",
        "提交代理词、质证意见、法律检索报告或补充意见",
        "按庭审要求核实事实、补交材料或移交证据原件",
        "联系法官或书记员跟进裁判进度"
      ],
      actions: ["开庭报告", "代理词", "庭后补充意见", "书面质证意见", "法律检索报告"],
      deadlineCategories: ["EVIDENCE", "CUSTOM"],
      materialCategories: [],
      materialPattern: /代理词|庭后|补充意见|开庭报告|质证意见|检索报告|笔录/,
      defaultCategory: "PLEADING"
    }
  },
  {
    keys: ["裁判/上诉", "裁判签收", "二审裁判", "仲裁裁决", "执行结案"],
    guide: {
      summary: "签收裁判或裁决文书，计算上诉期/履行期，处理生效、退费、履行和后续程序提示。",
      checklistTitle: "裁判事项",
      checklist: [
        "记录裁判文书签收日并计算上诉期或撤裁期限",
        "向当事人汇报裁判结果并确认是否上诉、撤裁或履行",
        "处理文书更正、生效证明、诉讼费退费和保全解除",
        "跟进对方履行并提示需要另行新建执行程序的情形"
      ],
      actions: ["裁判结果报告", "上诉期告知函", "结案报告", "生效证明申请", "履行衔接清单"],
      deadlineCategories: ["APPEAL", "PERFORMANCE", "ARBITRATION_SET_ASIDE", "ENFORCEMENT"],
      materialCategories: ["JUDGMENT"],
      materialPattern: /判决|裁定|裁决|调解书|上诉|生效|履行|退费|结案|后续程序/,
      defaultCategory: "JUDGMENT"
    }
  },
  {
    keys: ["案件归档"],
    guide: {
      summary: "完成结案报告、材料完整性核对、原件退还、费用结清和归档申请。",
      checklistTitle: "归档事项",
      checklist: [
        "确认裁判、裁决、调解或执行结果已形成最终留痕",
        "核对委托手续、程序材料、证据材料和往来记录是否完整",
        "完成结案报告、客户交接、原件退还和费用结清",
        "提交归档申请并处理补正意见"
      ],
      actions: ["结案报告", "归档材料清单", "原件退还确认书", "客户结案告知函", "归档申请"],
      deadlineCategories: [],
      materialCategories: ["PROCEDURE", "JUDGMENT"],
      materialPattern: /归档|结案报告|原件退还|材料清单|结案告知|费用结清/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["上诉/应诉"],
    guide: {
      summary: "围绕上诉、二审应诉、补充证据、上诉费和二审庭询安排组织材料。",
      checklistTitle: "二审事项",
      checklist: [
        "签订二审委托手续并确认上诉期限",
        "递交上诉状或二审答辩意见、证据材料",
        "提醒并核对上诉费缴纳",
        "梳理一审裁判争点和二审代理思路"
      ],
      actions: ["上诉状", "二审答辩状", "二审证据目录", "上诉费缴费凭证", "二审代理方案"],
      deadlineCategories: ["APPEAL", "RESPONSE", "EVIDENCE"],
      materialCategories: [],
      materialPattern: /上诉|二审|答辩|一审判决|裁定|上诉费|代理方案/,
      defaultCategory: "PLEADING"
    }
  },
  {
    keys: ["财产查控"],
    guide: {
      summary: "梳理并提交被执行人财产线索，跟进网络查控、处置方案和续保。",
      checklistTitle: "查控事项",
      checklist: [
        "梳理房产、车辆、银行账户、股权等财产线索",
        "向执行法官提交财产线索和查控申请",
        "跟进查封、冻结、扣押和评估拍卖进度",
        "执行周期较长时同步检查已保全财产续保"
      ],
      actions: ["财产线索清单", "网络查控申请书", "追加被执行人申请书", "续封申请书"],
      deadlineCategories: ["ENFORCEMENT", "PRESERVATION"],
      materialCategories: [],
      materialPattern: /查控|财产线索|冻结|查封|扣押|拍卖|追加被执行人|续封/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["异议/复议"],
    guide: {
      summary: "处理执行异议、复议、不予执行或案外人异议相关材料和期限。",
      checklistTitle: "异议事项",
      checklist: [
        "确认异议主体、异议对象和法定期限",
        "准备执行异议申请或复议申请及证据",
        "跟进听证、裁定和后续异议之诉衔接",
        "向当事人汇报风险和下一步策略"
      ],
      actions: ["执行异议申请书", "复议申请书", "不予执行申请书", "听证提纲"],
      deadlineCategories: ["ENFORCEMENT", "CUSTOM"],
      materialCategories: [],
      materialPattern: /执行异议|复议|不予执行|案外人|听证|异议之诉/,
      defaultCategory: "PLEADING"
    }
  },
  {
    keys: ["执行和解"],
    guide: {
      summary: "推动执行和解方案、客户确认、协议签署、履行监督和恢复执行预案。",
      checklistTitle: "和解事项",
      checklist: [
        "核实对方履行能力和和解条件",
        "形成和解方案并取得客户书面确认",
        "签署执行和解协议并提交法院备案",
        "跟进分期履行、违约处理和恢复执行"
      ],
      actions: ["执行和解方案", "调解/和解方案确认函", "执行和解协议", "恢复执行申请书"],
      deadlineCategories: ["PERFORMANCE", "ENFORCEMENT"],
      materialCategories: [],
      materialPattern: /和解|调解|履行计划|恢复执行|确认函/,
      defaultCategory: "PROCEDURE"
    }
  },
  {
    keys: ["会见", "取保候审", "阅卷线索", "辩护意见"],
    guide: {
      summary: "刑事程序内按会见、取保、阅卷、线索核实和辩护意见组织工作。",
      checklistTitle: "刑事事项",
      checklist: [
        "核对委托手续、会见手续和办案机关要求",
        "记录会见情况、阅卷要点和补充线索",
        "评估取保候审、羁押必要性和证据风险",
        "形成书面辩护意见或法律意见"
      ],
      actions: ["会见笔录", "取保候审申请书", "阅卷笔录", "辩护意见", "法律意见书"],
      deadlineCategories: ["CUSTOM"],
      materialCategories: [],
      materialPattern: /会见|取保|阅卷|辩护|羁押|法律意见/,
      defaultCategory: "PROCEDURE"
    }
  }
];

export const DOCUMENT_CATEGORY_OPTIONS: DocumentCategory[] = [
  "CONTRACT",
  "PLEADING",
  "EVIDENCE",
  "PROCEDURE",
  "JUDGMENT",
  "OTHER"
];
export const SOURCE_MATERIAL_CATEGORIES: DocumentCategory[] = ["PLEADING", "EVIDENCE"];
