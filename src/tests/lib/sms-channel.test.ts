// @vitest-environment node
/**
 * 短信通道与模板（2026-11-23）
 *
 * 与 IMAP 同一思路：模板/长度/手机号/失败处理是纯逻辑，全部可测；
 * 真通道要密钥，明确标注未接。
 *
 * 覆盖：
 *  ① 未配置 → 通道为 null；缺项清单可读
 *  ② `SMS_PROVIDER=fake` → 假通道可用（**不真发但能跑通整条链路**）
 *  ③ 其它 provider → **明确抛错**说明还差实现（不静默当成功）
 *  ④ 手机号校验与服务端同口径
 *  ⑤ 70 字切分：中文短信按 70 计费，切分数要能算准
 *  ⑥ 明细版超 70 时，短版必须 ≤ 70（降级路径能真的省一条）
 *  ⑦ 签名自动补【】、已带则不重复
 *  ⑧ 空事项列表给"没有事项"而不是拼出半句话
 */
import { describe, expect, it } from "vitest";
import {
  FakeSmsChannel, createSmsChannel, isMobilePhone, isSmsConfigured,
  missingSmsKeys, splitSmsText, SMS_MAX_LEN
} from "@/lib/integrations/sms-channel";
import {
  renderReminderSms, renderReminderSmsCompact, renderVisitReminderSms
} from "@/server/notifications/sms-template";

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("短信通道适配层", () => {
  it("未配置 → 通道 null、缺项清单可读", () => {
    expect(isSmsConfigured(env({}))).toBe(false);
    expect(createSmsChannel(env({}))).toBeNull();
    expect(missingSmsKeys(env({}))).toEqual(["SMS_PROVIDER", "SMS_KEY"]);
  });

  it("**SMS_PROVIDER=fake → 假通道可用**（不真发但能跑通链路）", () => {
    const c = createSmsChannel(env({ SMS_PROVIDER: "fake" }));
    expect(c).toBeInstanceOf(FakeSmsChannel);
    expect(isSmsConfigured(env({ SMS_PROVIDER: "fake" }))).toBe(true);
    expect(missingSmsKeys(env({ SMS_PROVIDER: "fake" }))).toEqual([]);
  });

  it("**其它 provider → 明确抛错**（不静默当成功，否则业主以为发出去了）", () => {
    expect(() => createSmsChannel(env({ SMS_PROVIDER: "aliyun", SMS_KEY: "k" }))).toThrow(/尚未接入/);
  });

  it("假通道记录发送内容并返回分段数", async () => {
    const c = new FakeSmsChannel();
    const r = await c.send("13900001111", "x".repeat(150));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.segments).toBe(3);
    expect(c.sent).toHaveLength(1);
  });

  it("手机号校验与服务端同口径", () => {
    expect(isMobilePhone("13900001111")).toBe(true);
    expect(isMobilePhone("12300001111")).toBe(false);
    expect(isMobilePhone("1390000111")).toBe(false);
  });

  it(`按 ${SMS_MAX_LEN} 字切分`, () => {
    expect(splitSmsText("a".repeat(70))).toHaveLength(1);
    expect(splitSmsText("a".repeat(71))).toHaveLength(2);
    expect(splitSmsText("")).toEqual([""]);
  });
});

describe("短信模板", () => {
  it("签名自动补【】；已带不重复", () => {
    expect(renderReminderSmsCompact({ userName: "张三", count: 1, sign: "律所" })).toContain("【律所】");
    expect(renderReminderSmsCompact({ userName: "张三", count: 1, sign: "【律所】" })).toContain("【律所】");
    expect(renderReminderSmsCompact({ userName: "张三", count: 1, sign: "【律所】" })).not.toContain("【【");
  });

  it("空事项列表给出完整句，不拼半句", () => {
    const t = renderReminderSms({ userName: "张三", items: [], sign: "律所" });
    expect(t).toBe("【律所】张三，当前没有临近或已到期的事项");
  });

  it("明细版：前 2 条用①②，其余折成「等 N 项」", () => {
    const t = renderReminderSms({
      userName: "张三",
      sign: "律所",
      items: [
        { title: "借款纠纷", dueText: "11-25" },
        { title: "股权转让", dueText: "11-26" },
        { title: "劳动仲裁", dueText: "11-27" }
      ]
    });
    expect(t).toContain("① 借款纠纷 11-25");
    expect(t).toContain("② 股权转让 11-26");
    expect(t).toContain("等 3 项");
    expect(t).not.toContain("劳动仲裁"); // 第三条折掉了
  });

  it("**明细版超 70 字时，短版必须 ≤70**（降级真能省一条）", () => {
    const input = {
      userName: "欧阳某某某某某某",
      sign: "某某律师事务所",
      items: [
        { title: "一起非常长的借款合同纠纷案件", dueText: "2026-11-25" },
        { title: "第二个也很长的股权转让纠纷", dueText: "2026-11-26" },
        { title: "第三个", dueText: "11-27" }
      ]
    };
    const detail = renderReminderSms(input);
    expect(splitSmsText(detail).length).toBeGreaterThan(1); // 明细版确实超了
    const compact = renderReminderSmsCompact({ userName: input.userName, count: 3, sign: input.sign });
    expect(splitSmsText(compact).length).toBe(1);           // 短版一条搞定
  });

  it("上门提醒短信含律师称呼与时间", () => {
    const t = renderVisitReminderSms({ clientName: "李四", whenText: "明天下午三点", lawyerName: "王", sign: "律所" });
    expect(t).toContain("李四您好");
    expect(t).toContain("王律师");
    expect(t).toContain("明天下午三点");
  });
});
