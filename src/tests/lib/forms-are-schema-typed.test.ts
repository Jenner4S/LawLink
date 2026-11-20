// @vitest-environment node
/**
 * 写表单必须是**类型化**的 react-hook-form（2026-11-21）
 *
 * ## 这条守卫保护的是什么
 *
 * `useForm()` 不传泛型时，`register("任意字符串")` 完全不受类型检查——
 * 字段名拼错不会报错，运行时该字段读不到值，服务端 zod 校验失败，
 * 用户只看到「保存失败」。这类 bug 在浏览器里点一遍才可能发现。
 *
 * 传了泛型（`useForm<ClientCreateInput>`）之后，`register` 的 name 被约束为
 * `FieldPath<T>`，拼错即**编译错误**；schema 新增必填字段时，
 * 类型化的 `defaultValues` 也会报错。这是整套写表单的编译期保障。
 *
 * ## 现状（写守卫时的实测）
 *
 * src/app + src/components 共 11 处 `useForm`，**全部**带泛型；
 * 唯一一处 `useForm()` 命中出现在 login-form 的**注释**里（故本测试先剥注释再判）。
 *
 * ## 本测试**测不到**的（如实声明）
 *
 * · 泛型参数是否就是对应的 zod schema 类型（只保证「有泛型」，不保证「泛型选对」）
 * · 非 react-hook-form 的表单（如受控 useState 表单）不在此列
 * · 运行时行为——本测试是**源码结构检查**，不执行组件
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src/app", "src/components"];

/** 递归收集 .tsx 文件 */
function collect(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * 去掉注释再判：本项目多次出现「测试被自己的注释弄红」的情况
 * （门户隔离测试的注释里提过 next-auth 的 cookie 名，直接把断言打红）。
 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("写表单的类型化约束", () => {
  it("src/app 与 src/components 里每一处 useForm 都带类型参数", () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of collect(root)) {
        const code = codeOnly(readFileSync(file, "utf8"));
        // 未类型化：useForm( 紧跟 ( —— 带泛型的是 useForm<
        const untyped = code.match(/useForm\s*\(/g);
        if (untyped) offenders.push(`${file}（${untyped.length} 处未类型化）`);
      }
    }
    expect(offenders, `以下文件的 useForm 没有泛型参数，register 路径不受类型检查：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("守卫本身有效：未类型化的写法会被识别（自检，防断言写成空转）", () => {
    // 这条防的是「正则写错导致永远匹配不到」——那会让上一条变成永绿的空测试。
    const sample = "const f = useForm({ defaultValues: { a: 1 } });";
    expect(codeOnly(sample).match(/useForm\s*\(/g)).toHaveLength(1);
    const typedSample = "const f = useForm<X>({ defaultValues: { a: 1 } });";
    expect(codeOnly(typedSample).match(/useForm\s*\(/g)).toBeNull();
    // 注释里的提及不应算数
    const commented = "// 见 useForm().watch 的说明\nconst f = useForm<X>({});";
    expect(codeOnly(commented).match(/useForm\s*\(/g)).toBeNull();
  });
});
