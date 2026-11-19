import { describe, it, expect } from "vitest";
import { z } from "zod";

import { ActionError, actionErrorMessage } from "@/lib/action-error";
import { parseInput } from "@/lib/parse-input";

describe("parseInput：统一校验入口", () => {
  const schema = z.object({
    name: z.string().max(5, "名称最多 5 字"),
    count: z.coerce.number().int("必须是整数").default(1)
  });

  it("合法输入返回解析后的数据，含默认值与 transform", () => {
    expect(parseInput(schema, { name: "律所" })).toEqual({ name: "律所", count: 1 });
    expect(parseInput(schema, { name: "律所", count: "7" })).toEqual({ name: "律所", count: 7 });
  });

  it("校验失败抛 ActionError（不是 ZodError）", () => {
    expect(() => parseInput(schema, { name: "太长太长太长" })).toThrow(ActionError);
    try {
      parseInput(schema, { name: "太长太长太长" });
    } catch (err) {
      expect(err).not.toBeInstanceOf(z.ZodError);
    }
  });

  it("digest 通道携带中文消息（生产脱敏下客户端可见的那条路）", () => {
    try {
      parseInput(schema, { name: "太长太长太长" });
      expect.unreachable("应当抛错");
    } catch (err) {
      const digest = (err as { digest?: string }).digest;
      expect(digest).toBe("ACTION_ERROR:名称最多 5 字");
      expect(actionErrorMessage(err)).toBe("名称最多 5 字");
    }
  });

  it("多个字段同时出错时只取前两条，用中文分号连接", () => {
    const multi = z.object({
      a: z.string().max(1, "A 超长"),
      b: z.string().max(1, "B 超长"),
      c: z.string().max(1, "C 超长")
    });
    try {
      parseInput(multi, { a: "xx", b: "xx", c: "xx" });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as { digest?: string }).digest).toBe("ACTION_ERROR:A 超长；B 超长");
    }
  });

  it("issue 无 message 时回退通用文案，不抛空提示", () => {
    const weird = z.object({ a: z.string().refine(() => false, { message: "" }) });
    try {
      parseInput(weird, { a: "x" });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as { digest?: string }).digest).toBe("ACTION_ERROR:输入信息有误，请检查后重试");
    }
  });

  it("嵌套字段的路径不影响消息透出", () => {
    const nested = z.object({ outer: z.object({ inner: z.string().max(1, "内层超长") }) });
    try {
      parseInput(nested, { outer: { inner: "xx" } });
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as { digest?: string }).digest).toBe("ACTION_ERROR:内层超长");
    }
  });
});
