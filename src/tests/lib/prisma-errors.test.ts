import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { isPrismaError, uniqueViolationOn, uniqueViolationTargets } from "@/lib/prisma-errors";

/**
 * 这个助手存在的理由：全仓原本 6 处各自手写
 * `e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002"`。
 * 语义有三个容易记错的点（见 `src/lib/prisma-errors.ts` 抬头），
 * 散着写必然有人写错。这里把那三个点用测试钉住。
 */
describe("prisma-errors", () => {
  const p2002 = (target: unknown) =>
    new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "5.22.0",
      meta: { target }
    });

  it("isPrismaError：只认 Prisma 的已知错误，普通带 code 的对象不算", () => {
    expect(isPrismaError(p2002(["archiveNo"]), "P2002")).toBe(true);
    expect(isPrismaError(p2002(["archiveNo"]), "P2025")).toBe(false);
    // 常见误写：只看 code
    expect(isPrismaError({ code: "P2002" }, "P2002")).toBe(false);
    expect(isPrismaError(null, "P2002")).toBe(false);
    expect(isPrismaError("P2002", "P2002")).toBe(false);
  });

  it("uniqueViolationTargets：目标为数组时逐项取出", () => {
    expect(uniqueViolationTargets(p2002(["archiveNo"]))).toEqual(["archiveNo"]);
    expect(uniqueViolationTargets(p2002(["familyId", "version"]))).toEqual(["familyId", "version"]);
  });

  it("uniqueViolationTargets：目标为 Prisma 拼好的字符串时也能解析", () => {
    expect(uniqueViolationTargets(p2002("Unique constraint failed on the fields: (`archiveNo`)"))).toEqual(["archiveNo"]);
    expect(uniqueViolationTargets(p2002("(`familyId`,`version`)"))).toEqual(["familyId", "version"]);
  });

  it("uniqueViolationTargets：拿不到 target 时返回空数组，不抛错", () => {
    expect(uniqueViolationTargets(p2002(undefined))).toEqual([]);
    expect(uniqueViolationTargets({})).toEqual([]);
    expect(uniqueViolationTargets(null)).toEqual([]);
  });

  it("uniqueViolationOn：复合唯一键按「包含」判断，不能整体相等", () => {
    // 这条是关键：Document 的唯一键是 [familyId, version]，
    // 若写成整体相等比较，就永远判不出「撞的是 version」。
    const composite = p2002(["familyId", "version"]);
    expect(uniqueViolationOn(composite, "version")).toBe(true);
    expect(uniqueViolationOn(composite, "familyId")).toBe(true);
    expect(uniqueViolationOn(composite, "archiveNo")).toBe(false);
  });

  it("uniqueViolationOn：不是 P2002 或没有 target 时为 false", () => {
    expect(uniqueViolationOn(new Error("boom"), "archiveNo")).toBe(false);
    expect(uniqueViolationOn(p2002(undefined), "archiveNo")).toBe(false);
  });
});
