/**
 * 邮件 → 案件自动匹配（台账 P1-3）。
 *
 * 纯函数：不碰数据库、不读时钟、不依赖请求上下文。候选数据由调用方一次取好传进来
 * （取数在 `./actions.ts`，那里负责可见性过滤与查询）。这样做有两个好处：
 *   1. 匹配规则可以在单测里用固定夹具逐条钉死，不需要 mock Prisma；
 *   2. 「命中多个案件怎么办」这类判断只有一处实现，页面、后台队列、未来 IMAP 取件器
 *      共用同一口径，不会各自发明。
 *
 * 优先级（命中即停，绝不降级猜测）：
 *   ① MATCHED_BY_CODE    正文/主题含案件编号（internalCode 或 firmCaseNo，且该编号在库中存在）
 *   ② MATCHED_BY_PARTY   正文含当事人全名（≥3 字），且该当事人只属于一个案件
 *   ③ MATCHED_BY_ADDRESS 发件人邮箱与客户/联系人邮箱一致，且该邮箱只指向一个案件
 *
 * 冲突处理：**同一优先级命中多个案件时返回 UNMATCHED 并说明「命中 N 个案件，需人工指定」**，
 * 不再往下一级试探——弱信号（例如正文里恰好出现另一个当事人的名字）不应推翻强信号给出的
 * 多义结果，否则就会「猜」出错误归属。归属错误比未匹配的代价高得多：它会把一封沟通记录
 * 挂到另一个客户的案卷上，属于执业风险。
 */

export type EmailMatchKindValue = "MATCHED_BY_CODE" | "MATCHED_BY_PARTY" | "MATCHED_BY_ADDRESS" | "UNMATCHED";

export type EmailMatchInput = {
  subject: string;
  bodyText: string;
  fromAddress: string;
};

/** 参与编号匹配的案件（只取编号相关字段） */
export type MatchMatter = {
  id: string;
  internalCode: string | null;
  firmCaseNo: string | null;
};

/** 参与当事人匹配的行：同一姓名可能出现在多个案件里 */
export type MatchParty = {
  name: string;
  matterId: string | null;
};

/** 参与邮箱匹配的行：同一邮箱可能关联多个客户/案件 */
export type MatchAddress = {
  email: string;
  matterIds: string[];
  /** 可读来源，如「客户「上海京贝置业发展有限公司」联系人「李思梅」」 */
  source: string;
};

export type MatchCandidates = {
  matters: MatchMatter[];
  parties: MatchParty[];
  addresses: MatchAddress[];
};

export type EmailMatchResult = {
  matterId: string | null;
  matchKind: EmailMatchKindValue;
  /** 匹配依据的可读说明；未匹配时说明原因（含「需人工指定」） */
  evidence: string;
};

/**
 * 案件编号的通用形态：`LL-2026-CC-0001`。
 * 仅用于从正文里**抽取候选**（减少查询面），最终是否命中仍以库中真实编号为准。
 */
export const EMAIL_CODE_PATTERN = /[A-Za-z]{1,12}-\d{4}-[A-Za-z]{1,4}-\d{3,8}/g;

/** 统一全角/半角与空白，避免「ＬＬ」或多余空格导致漏配 */
function normalizeDisplay(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * 编号比较：NFKC + 大写。
 * **不删除空白**：把「LL-2026-CC-00 01」拼回完整编号会制造假命中；
 * 编号本身不含空格，靠 `containsToken` 的两侧边界即可正确命中。
 */
function normalizeCode(value: string): string {
  return normalizeDisplay(value).toUpperCase();
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

const WORDISH = /[A-Z0-9-]/;

/**
 * 包含且两侧不是「编号字符」，避免 `LL-2026-CC-0001` 命中 `LL-2026-CC-00011`。
 * 中文标点、空白、汉字都算天然边界，所以不要求 `\b`。
 */
function containsToken(haystack: string, needle: string): boolean {
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index > 0 ? haystack[index - 1] : "";
    const after = haystack[index + needle.length] ?? "";
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
    from = index + 1;
  }
  return false;
}

function unique(values: (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/** 案件的可读标识：优先系统编号，其次所内案号，最后退回 id */
export function matterLabel(matter: MatchMatter): string {
  return matter.internalCode?.trim() || matter.firmCaseNo?.trim() || matter.id;
}

/** 从邮件文本中抽取疑似案件编号（只用于缩小查询范围） */
export function extractCandidateCodes(text: string): string[] {
  const matches = normalizeDisplay(text).match(EMAIL_CODE_PATTERN) ?? [];
  return unique(matches.map((code) => normalizeCode(code)));
}

function findCodeHits(text: string, matters: MatchMatter[]): { matter: MatchMatter; code: string }[] {
  const haystack = normalizeCode(text);
  const hits: { matter: MatchMatter; code: string }[] = [];
  const seen = new Set<string>();
  for (const matter of matters) {
    for (const raw of [matter.internalCode, matter.firmCaseNo]) {
      if (!raw) continue;
      const needle = normalizeCode(raw);
      if (needle.length < 4) continue;
      if (!containsToken(haystack, needle)) continue;
      const key = `${matter.id}:${needle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ matter, code: raw.trim() });
    }
  }
  return hits;
}

function findPartyHits(text: string, parties: MatchParty[]): Map<string, Set<string>> {
  const haystack = normalizeDisplay(text);
  const groups = new Map<string, Set<string>>();
  for (const party of parties) {
    if (!party.matterId) continue;
    const name = normalizeDisplay(party.name ?? "");
    // 「≥3 字才匹配」：两字姓名（张伟、李娜）与常见词重叠率太高，宁可不匹配也不误挂
    if ([...name].length < 3) continue;
    if (!haystack.includes(name)) continue;
    const bucket = groups.get(name) ?? new Set<string>();
    bucket.add(party.matterId);
    groups.set(name, bucket);
  }
  return groups;
}

function findAddressHits(fromAddress: string, addresses: MatchAddress[]): { email: string; matterIds: string[]; sources: string[] } | null {
  const email = normalizeEmail(fromAddress);
  if (!email) return null;
  const matched = addresses.filter((row) => normalizeEmail(row.email ?? "") === email);
  if (matched.length === 0) return null;
  return {
    email,
    matterIds: unique(matched.flatMap((row) => row.matterIds)),
    sources: unique(matched.map((row) => row.source)).slice(0, 3)
  };
}

function ambiguous(kindLabel: string, labels: string[]): EmailMatchResult {
  const list = labels.slice(0, 5).join("、");
  const suffix = labels.length > 5 ? " 等" : "";
  return {
    matterId: null,
    matchKind: "UNMATCHED",
    evidence: `${kindLabel}命中 ${labels.length} 个案件（${list}${suffix}），需人工指定`
  };
}

/**
 * 执行匹配。命中即停；同一优先级命中多案时返回 UNMATCHED，绝不猜测。
 */
export function matchEmail(input: EmailMatchInput, candidates: MatchCandidates): EmailMatchResult {
  const subject = input.subject ?? "";
  const body = input.bodyText ?? "";
  const text = `${subject}\n${body}`;

  // ① 案件编号
  const codeHits = findCodeHits(text, candidates.matters);
  if (codeHits.length > 0) {
    const matterIds = unique(codeHits.map((hit) => hit.matter.id));
    if (matterIds.length > 1) {
      const byMatter = new Map<string, MatchMatter>();
      for (const hit of codeHits) byMatter.set(hit.matter.id, hit.matter);
      return ambiguous("案号", [...byMatter.values()].map(matterLabel));
    }
    const hit = codeHits[0];
    return {
      matterId: hit.matter.id,
      matchKind: "MATCHED_BY_CODE",
      evidence: `主题或正文含案号 ${hit.code}`
    };
  }

  // ② 当事人全名
  const partyHits = findPartyHits(text, candidates.parties);
  if (partyHits.size > 0) {
    const matterIds = unique([...partyHits.values()].flatMap((set) => [...set]));
    if (matterIds.length > 1) {
      const labelById = new Map(candidates.matters.map((matter) => [matter.id, matterLabel(matter)]));
      return ambiguous("当事人", matterIds.map((id) => labelById.get(id) ?? id));
    }
    const [name] = [...partyHits.keys()];
    return {
      matterId: matterIds[0],
      matchKind: "MATCHED_BY_PARTY",
      evidence: `正文含当事人「${name}」`
    };
  }

  // ③ 发件人邮箱
  const addressHit = findAddressHits(input.fromAddress ?? "", candidates.addresses);
  if (addressHit) {
    if (addressHit.matterIds.length > 1) {
      return {
        matterId: null,
        matchKind: "UNMATCHED",
        evidence: `发件人邮箱 ${addressHit.email} 关联 ${addressHit.matterIds.length} 个案件，需人工指定`
      };
    }
    if (addressHit.matterIds.length === 1) {
      return {
        matterId: addressHit.matterIds[0],
        matchKind: "MATCHED_BY_ADDRESS",
        evidence: `发件人邮箱 ${addressHit.email} 与${addressHit.sources[0] ?? "客户联系方式"}邮箱一致`
      };
    }
  }

  return {
    matterId: null,
    matchKind: "UNMATCHED",
    evidence: "未在案号、当事人或邮箱中找到归属，需人工指定"
  };
}

/**
 * 收集「可能相关」的案件标识（去重），用于待归档队列展示候选建议。
 *
 * 与 `matchEmail` 的区别：这里不判断是否唯一命中，也不排除多义结果——
 * 目的恰恰是把多义候选**展示出来**让律师手工挑选。命中顺序不影响集合内容。
 */
export function collectCandidateMatterIds(input: EmailMatchInput, candidates: MatchCandidates): string[] {
  const text = `${input.subject ?? ""}\n${input.bodyText ?? ""}`;
  const ids = new Set<string>();
  for (const hit of findCodeHits(text, candidates.matters)) ids.add(hit.matter.id);
  for (const bucket of findPartyHits(text, candidates.parties).values()) {
    for (const id of bucket) ids.add(id);
  }
  const addressHit = findAddressHits(input.fromAddress ?? "", candidates.addresses);
  if (addressHit) for (const id of addressHit.matterIds) ids.add(id);
  return [...ids];
}
