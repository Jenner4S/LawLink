// @vitest-environment node
/**
 * 邮件归档自动匹配（纯函数）单测（台账 P1-3）。
 *
 * 重点不是「能匹配」，而是**不猜**：
 *   - 命中多案时返回 UNMATCHED 并说明「命中 N 个案件，需人工指定」；
 *   - 同一当事人属于多案时不挑其中一个；
 *   - 两字姓名不参与匹配（误伤率高）；
 *   - 弱信号不能推翻强信号的多义结果（编号命中即停）。
 */
import { describe, expect, it } from "vitest";

import {
  collectCandidateMatterIds,
  extractCandidateCodes,
  matchEmail,
  type MatchCandidates
} from "@/server/emails/match";

const A = "cmattera00000000000000001";
const B = "cmatterb00000000000000002";

const candidates: MatchCandidates = {
  matters: [
    { id: A, internalCode: "LL-2026-CC-0001", firmCaseNo: "2026-民诉-001" },
    { id: B, internalCode: "LL-2026-CC-0002", firmCaseNo: "2026-民诉-002" }
  ],
  parties: [
    { name: "上海京贝置业发展有限公司", matterId: A },
    { name: "上海拳能体育发展有限公司", matterId: A },
    { name: "杭州金笔珠宝设计有限公司", matterId: B }
  ],
  addresses: [
    { email: "lisi@jingbei.example", matterIds: [A], source: "客户「上海京贝置业发展有限公司」联系人「李思梅」" }
  ]
};

const base = { subject: "", bodyText: "", fromAddress: "unknown@example.com" };

describe("邮件匹配 · 编号", () => {
  it("正文含系统编号命中 MATCHED_BY_CODE", () => {
    const result = matchEmail(
      { ...base, subject: "关于 LL-2026-CC-0001 的开庭安排", bodyText: "对方已收悉。" },
      candidates
    );
    expect(result).toMatchObject({ matterId: A, matchKind: "MATCHED_BY_CODE" });
    expect(result.evidence).toContain("LL-2026-CC-0001");
  });

  it("主题含所内案号也命中（编号在主题里同样有效）", () => {
    const result = matchEmail({ ...base, subject: "2026-民诉-002 证据交换", bodyText: "见附件。" }, candidates);
    expect(result).toMatchObject({ matterId: B, matchKind: "MATCHED_BY_CODE" });
  });

  it("更长的编号不被短编号误命中（LL-2026-CC-00011 ≠ LL-2026-CC-0001）", () => {
    const result = matchEmail({ ...base, bodyText: "案号 LL-2026-CC-00011 与本案无关。" }, candidates);
    expect(result.matchKind).toBe("UNMATCHED");
  });

  it("编号命中多个案件时返回 UNMATCHED，不猜其中一个", () => {
    const result = matchEmail(
      { ...base, bodyText: "LL-2026-CC-0001 与 LL-2026-CC-0002 两个案子一并沟通。" },
      candidates
    );
    expect(result).toMatchObject({ matterId: null, matchKind: "UNMATCHED" });
    expect(result.evidence).toContain("命中 2 个案件");
    expect(result.evidence).toContain("需人工指定");
  });

  it("编号优先级高于当事人（命中即停）", () => {
    const result = matchEmail(
      {
        ...base,
        subject: "LL-2026-CC-0002",
        bodyText: "正文抄送了上海京贝置业发展有限公司。"
      },
      candidates
    );
    expect(result).toMatchObject({ matterId: B, matchKind: "MATCHED_BY_CODE" });
  });
});

describe("邮件匹配 · 当事人", () => {
  it("正文含唯一归属的当事人全名命中 MATCHED_BY_PARTY", () => {
    const result = matchEmail(
      { ...base, bodyText: "早上与杭州金笔珠宝设计有限公司的王总通过电话。" },
      candidates
    );
    expect(result).toMatchObject({ matterId: B, matchKind: "MATCHED_BY_PARTY" });
    expect(result.evidence).toContain("杭州金笔珠宝设计有限公司");
  });

  it("两字姓名不参与匹配（≥3 字门槛）", () => {
    const result = matchEmail(
      { ...base, bodyText: "张三今天来过电话。" },
      { ...candidates, parties: [{ name: "张三", matterId: A }] }
    );
    expect(result.matchKind).toBe("UNMATCHED");
  });

  it("同一当事人属于多个案件时返回 UNMATCHED", () => {
    const result = matchEmail(
      { ...base, bodyText: "上海京贝置业发展有限公司来函。" },
      {
        ...candidates,
        parties: [
          { name: "上海京贝置业发展有限公司", matterId: A },
          { name: "上海京贝置业发展有限公司", matterId: B }
        ]
      }
    );
    expect(result.matchKind).toBe("UNMATCHED");
    expect(result.evidence).toContain("命中 2 个案件");
  });

  it("正文命中多个当事人但都指向同一案件时仍可匹配", () => {
    const result = matchEmail(
      { ...base, bodyText: "上海京贝置业发展有限公司与上海拳能体育发展有限公司均确认。" },
      candidates
    );
    expect(result).toMatchObject({ matterId: A, matchKind: "MATCHED_BY_PARTY" });
  });
});

describe("邮件匹配 · 邮箱", () => {
  it("发件人邮箱与客户联系人邮箱一致时命中 MATCHED_BY_ADDRESS（大小写不敏感）", () => {
    const result = matchEmail({ ...base, fromAddress: "LiSi@JingBei.Example" }, candidates);
    expect(result).toMatchObject({ matterId: A, matchKind: "MATCHED_BY_ADDRESS" });
    expect(result.evidence).toContain("李思梅");
  });

  it("邮箱关联多个案件时返回 UNMATCHED", () => {
    const result = matchEmail(
      { ...base, fromAddress: "shared@example.com" },
      {
        ...candidates,
        addresses: [{ email: "shared@example.com", matterIds: [A, B], source: "客户「共享客户」" }]
      }
    );
    expect(result.matchKind).toBe("UNMATCHED");
    expect(result.evidence).toContain("关联 2 个案件");
  });
});

describe("邮件匹配 · 无信号与候选收集", () => {
  it("三条信号都没有时返回 UNMATCHED 且说明需人工指定", () => {
    const result = matchEmail({ ...base, subject: "问候", bodyText: "很久没联系了。" }, candidates);
    expect(result).toMatchObject({ matterId: null, matchKind: "UNMATCHED" });
    expect(result.evidence).toContain("需人工指定");
  });

  it("从正文抽取疑似编号只用于缩小查询范围", () => {
    expect(extractCandidateCodes("见 LL-2026-CC-0001 与 ll-2026-cr-0002")).toEqual([
      "LL-2026-CC-0001",
      "LL-2026-CR-0002"
    ]);
    expect(extractCandidateCodes("没有编号")).toEqual([]);
  });

  it("候选收集会把多义命中的案件都返回给人工挑选", () => {
    const ids = collectCandidateMatterIds(
      { ...base, bodyText: "LL-2026-CC-0001 与 LL-2026-CC-0002，以及杭州金笔珠宝设计有限公司。" },
      candidates
    );
    expect(ids.sort()).toEqual([A, B].sort());
  });
});
