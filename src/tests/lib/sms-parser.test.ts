import { describe, expect, it } from "vitest";
import { parseSms, toDate } from "@/lib/sms-parser";

describe("parseSms", () => {
  it("提取开庭时间并生成重要事项", () => {
    const parsed = parseSms(
      "【上海市浦东新区人民法院】案号（2026）沪0115民初12345号，本院定于2026年7月1日上午9:30在第三法庭开庭，承办法官张三。"
    );

    expect(parsed.smsType).toBe("HEARING_NOTICE");
    expect(parsed.caseNumbers).toEqual(["（2026）沪0115民初12345号"]);
    expect(parsed.hearingDate).toBe("2026年7月1日上午9:30");
    expect(parsed.dates).toEqual(["2026年7月1日上午9:30"]);
    expect(parsed.importantItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "HEARING",
          title: "开庭 / 庭审",
          dateText: "2026年7月1日上午9:30"
        })
      ])
    );
  });

  it("识别电子送达链接、账号密码和人工登录状态", () => {
    const parsed = parseSms(
      "【12368】你有法律文书待签收，案号（2026）浙0106民初888号，请登录https://songda.example.com/doc?id=abc，账号：lawyer001，密码：Abc12345，验证码：778899。"
    );

    expect(parsed.smsType).toBe("SERVICE_NOTICE");
    expect(parsed.urls).toEqual(["https://songda.example.com/doc?id=abc"]);
    expect(parsed.credentials.map((c) => c.label)).toEqual(["账号", "密码", "验证码"]);
    expect(parsed.credentials[1].valuePreview).not.toBe("Abc12345");
    expect(parsed.documentLinks[0]).toMatchObject({
      url: "https://songda.example.com/doc?id=abc",
      requiresLogin: true
    });
  });

  it("把举证、缴费等日期识别成待处理事项", () => {
    const parsed = parseSms(
      "【法院通知】请于2026年6月25日前提交证据材料，并于2026年6月20日前缴纳诉讼费500元。详情：https://court.example.com/pay。"
    );

    expect(parsed.smsType).toBe("FEE_NOTICE");
    expect(parsed.amounts).toContain("500元");
    expect(parsed.importantItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "EVIDENCE_DEADLINE", dateText: "2026年6月25日" }),
        expect.objectContaining({ kind: "FEE_DEADLINE", dateText: "2026年6月20日" })
      ])
    );
    expect(parsed.urls).toEqual(["https://court.example.com/pay"]);
  });
});

// ============================================================
// toDate：不存在的日期必须被拒绝（2026-11-20 修复）
// ============================================================
describe("toDate 拒绝不存在的日期", () => {
  it("越界日期不再静默滚动（修复前会给出别的月份甚至别的年份）", () => {
    // 修复前实测：
    //   "2026-02-30 10:00" → 上海 3 月 2 日
    //   "2026-02-29 10:00" → 3 月 1 日（非闰年）
    //   "2026-13-45 99:99" → 2027-02-17（差了一年多）
    // 短信是外部输入（当事人/法院发来的），笔误会直接喂给
    // generateHearingFromSms / generateDeadlineFromSms，错误的开庭日与
    // 举证期限就此进入案件数据且无任何提示。
    for (const bad of [
      "2026-02-30 10:00",
      "2026-02-29 10:00",
      "2026-04-31 10:00",
      "2026-06-31 10:00",
      "2026-13-45 99:99",
      "2026年2月30日 09:00"
    ]) {
      expect(toDate(bad), bad).toBeNull();
    }
  });

  it("真实存在的日期照常解析，且按上海墙钟（+08:00）构造", () => {
    // 闰年 2-29 是真实日期，必须通过
    expect(toDate("2028-02-29 10:00")?.toISOString()).toBe("2028-02-29T02:00:00.000Z");
    // 常规格式
    expect(toDate("2026-09-20 10:00")?.toISOString()).toBe("2026-09-20T02:00:00.000Z");
    // 下午换算：15:30 上海 = 07:30Z
    expect(toDate("2026/9/20 下午3:30")?.toISOString()).toBe("2026-09-20T07:30:00.000Z");
    // 中文格式
    expect(toDate("2026年9月20日 10:00")?.toISOString()).toBe("2026-09-20T02:00:00.000Z");
  });
});
