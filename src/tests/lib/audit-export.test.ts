import { describe, it, expect } from "vitest";
import { toCef, toSyslog, toJsonExport, type ExportRow } from "@/server/audit/export";

const row: ExportRow = {
  id: "cmwm8t1dk0007furr24jye227",
  userId: "u1",
  userEmail: "admin@lawlink.local",
  action: "CLIENT_UPDATE",
  targetType: "Client",
  targetId: "c1",
  detail: { fields: ["phone"] },
  ip: "127.0.0.1",
  userAgent: "Mozilla/5.0",
  integrityHash: "b8437608c117f6d984f1ebed320eb3b76458c0049345516",
  createdAt: new Date("2026-11-18T15:08:27.521Z")
};

describe("SIEM 导出格式", () => {
  it("CEF：头部 7 段 + 扩展字段含摘要", () => {
    const cef = toCef(row);
    const head = cef.split("|").slice(0, 7);
    expect(head[0]).toBe("CEF:0");
    expect(head[1]).toBe("LawLink");
    expect(head[3]).toBe("2.0");
    expect(head[4]).toBe("CLIENT_UPDATE");
    expect(head[6]).toBe("3"); // UPDATE 属常规更新，落 3 分档（高危/中危见下一条用例）
    expect(cef).toContain("cs3Label=完整性摘要");
    expect(cef).toContain("suser=admin@lawlink.local");
    expect(cef).toContain("externalId=cmwm8t1dk0007furr24jye227");
  });

  it("CEF：高危动作严重度更高", () => {
    const del = toCef({ ...row, action: "CLIENT_DELETE" });
    const view = toCef({ ...row, action: "CLIENT_VIEW" });
    const sev = (s: string) => Number(s.split("|")[6]);
    expect(sev(del)).toBe(7);
    expect(sev(view)).toBe(3);
  });

  it("CEF：扩展字段值转义管道符与换行", () => {
    const evil = toCef({ ...row, userEmail: "a|b\nc" });
    expect(evil.endsWith("\n") || evil.includes("\\|")).toBe(true);
    expect(evil).toContain("a\\|b\\nc");
  });

  it("Syslog：RFC5424 结构 + 结构化数据带摘要", () => {
    const s = toSyslog(row);
    expect(s.startsWith("<110>1 ")).toBe(true);   // facility 13 * 8 + info 6
    expect(s).toContain(" lawlink lawlink - CLIENT_UPDATE ");
    expect(s).toContain('action="CLIENT_UPDATE"');
    expect(s).toContain('actor="admin@lawlink.local"');
    expect(s).toContain('integrity="b8437608');
  });

  it("JSON：schema 标识 + 中文标签 + 摘要", () => {
    const j = toJsonExport([row], { truncated: false, maxRows: 5000 });
    expect(j.schema).toBe("lawlink.audit.export/v1");
    expect(j.count).toBe(1);
    expect(j.records[0].actionLabel).toContain("更新");
    expect(j.records[0].target.label).toBe("客户");
    expect(j.records[0].integrityHash).toBe(row.integrityHash);
  });

  it("JSON：截断时给出可操作提示", () => {
    const j = toJsonExport([row], { truncated: true, maxRows: 5000 });
    expect(j.truncated).toBe(true);
    expect(j.note).toContain("分段导出");
  });

  it("无摘要的历史记录不报错（摘要可空）", () => {
    const legacy = { ...row, integrityHash: null };
    expect(toCef(legacy)).not.toContain("cs3Label");
    expect(toSyslog(legacy)).not.toContain('integrity="');
    expect(toJsonExport([legacy], { truncated: false, maxRows: 10 }).records[0].integrityHash).toBeNull();
  });
});

describe("CEF 单行约束（回归）", () => {
  it("一条记录只输出一行，label 与值用空格分隔", () => {
    const withIds: ExportRow = {
      ...row,
      targetId: "c1",
      integrityHash: "deadbeef"
    };
    const cef = toCef(withIds);
    expect(cef).not.toContain("\n");
    expect(cef).toContain("cs2Label=目标ID cs2=c1");
    expect(cef).toContain("cs3Label=完整性摘要 cs3=deadbeef");
  });
});
