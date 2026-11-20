import { describe, it, expect } from "vitest";
import { MERGE_GUIDE } from "@/app/api/reports/export/route";

/**
 * 集团汇总契约的元测试（2026-11-20）
 *
 * 背景：`/api/reports/export?format=json` 是「多实例部署 + 集团汇总」的出口。
 * 消费方拿到的 MERGE_GUIDE 告诉他们哪些字段能相加、哪些是派生值、哪些是实例本地主键。
 *
 * **这份指南写错的后果**：集团把各所 archiveRate 直接相加 → 比率荒谬；
 * 按 userId 合并 → 跨实例错配。而错了不会报错，只会得出一个静默错误的报表。
 *
 * 所以这里钉死三件事：
 *   1. ReportData 的每个数值字段都必须在指南里出现（新增字段忘了登记 → 红）
 *   2. 每个字段只能属于一类（可求和 / 派生 / 本地主键 / 布尔 / 分组键），不可重叠
 *   3. archiveRate 必须是派生值而不是可求和
 */

/** 与 src/server/reports/queries.ts 的 ReportData 保持同步；新增字段须同时更新下方断言 */
const REPORT_DATA_PATHS = [
  "financeReady",
  "kpis.newIntake",
  "kpis.inProgress",
  "kpis.closed",
  "kpis.archived",
  "kpis.archiveRate",
  "byCategory[].count",
  "byLawyer[].userId",
  "byLawyer[].name",
  "byLawyer[].ownedCount",
  "byLawyer[].closedCount",
  "byLawyer[].receivedAmount",
  "byClientReceivable[].clientId",
  "byClientReceivable[].name",
  "byClientReceivable[].receivable",
  "byClientReceivable[].received",
  "byClientReceivable[].balance",
  "byClientSource[].source",
  "byClientSource[].count",
  "byClientSource[].intakeCount"
];

/** 分组键字段本身不参与求和，由 groupBy 声明 */
const GROUP_KEYS = new Set(["byCategory[].category", "byLawyer[].name", "byClientReceivable[].name", "byClientSource[].source"]);

describe("集团汇总契约 MERGE_GUIDE", () => {
  const summable = new Set<string>(MERGE_GUIDE.summable);
  const derived = new Set(Object.keys(MERGE_GUIDE.derived));
  const localKeys = new Set(Object.keys(MERGE_GUIDE.instanceLocalKeys));
  const booleanAnd = new Set<string>(MERGE_GUIDE.booleanAnd);

  it("ReportData 的每个字段都被指南归类（新增字段忘了登记会在这里红）", () => {
    const unclassified = REPORT_DATA_PATHS.filter(
      (p) => !summable.has(p) && !derived.has(p) && !localKeys.has(p) && !booleanAnd.has(p) && !GROUP_KEYS.has(p)
    );
    expect(unclassified).toEqual([]);
  });

  it("一个字段不能同时属于两类（可求和与派生互斥）", () => {
    const all = [...summable, ...derived, ...localKeys, ...booleanAnd];
    expect(all.length).toBe(new Set(all).size);
  });

  it("archiveRate 是派生值：比率不可相加", () => {
    expect(derived.has("kpis.archiveRate")).toBe(true);
    expect(summable.has("kpis.archiveRate")).toBe(false);
    // 派生公式必须说清分母为 0 的情形，否则消费方会除零
    expect(MERGE_GUIDE.derived["kpis.archiveRate"]).toContain("0");
  });

  it("实例本地主键被标出，且要求按名称合并（同名风险写进契约）", () => {
    expect(localKeys.has("byLawyer[].userId")).toBe(true);
    expect(localKeys.has("byClientReceivable[].clientId")).toBe(true);
    expect(MERGE_GUIDE.instanceLocalKeys["byLawyer[].userId"]).toContain("name");
    expect(MERGE_GUIDE.instanceLocalKeys["byClientReceivable[].clientId"]).toContain("name");
  });

  it("financeReady 取与：任一实例财务未就绪则集团未就绪", () => {
    expect(booleanAnd.has("financeReady")).toBe(true);
    expect(summable.has("financeReady")).toBe(false);
  });

  it("四个明细列表都声明了分组键", () => {
    expect(MERGE_GUIDE.groupBy.byCategory).toBe("category");
    expect(MERGE_GUIDE.groupBy.byLawyer).toBe("name");
    expect(MERGE_GUIDE.groupBy.byClientReceivable).toBe("name");
    expect(MERGE_GUIDE.groupBy.byClientSource).toBe("source");
  });

  it("可求和列表不含任何名称型字段（名称是分组键，不是金额）", () => {
    for (const p of summable) {
      expect(p).not.toMatch(/\.name$/);
    }
  });
});
