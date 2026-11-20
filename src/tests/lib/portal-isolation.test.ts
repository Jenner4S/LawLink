import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * 门户与员工侧的**结构性隔离**守卫（2026-11-20，门户 S1）
 *
 * S1 的验收判据里有一条：「客户 token 不能调员工动作，测试必须失效」。
 *
 * 这条判据不能用「发一个请求试试」来验证——那测的是 NextAuth 内部行为，
 * 而且一旦某天有人把门户会话接进员工侧，功能测试仍会绿（客户确实只是「没登录」）。
 * 真正要守住的是**结构**：两侧的身份来源互不引用。
 *
 * 于是本文件把「互不引用」写成可执行的断言：
 *   1. 员工侧会话模块不得出现门户 cookie / 门户会话函数的任何符号
 *   2. 门户侧会话模块不得出现员工侧会话的符号（requireSession / getServerSession / authOptions）
 *   3. 门户 cookie 名与员工侧 cookie 名不同
 *   4. 门户会话载荷里**没有任何权限字段**（role / permissions / isAdmin …）——
 *      即使被误用，它也授不出任何员工权限
 *   5. 员工侧中间件把 /portal 排除在外（否则客户会被弹去员工登录页）
 *
 * 4 是关键：门户会话只承载「你是谁」，不承载「你能做什么」。
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * 去掉注释后的代码文本。
 *
 * 必须做这一步：本文件的断言按符号名匹配，而两侧的注释里**大量互相提及**
 * （例如门户 auth.ts 注释写「与员工侧 next-auth.session-token 不同」——
 * 那句注释正是在说明隔离，却会把自己的断言弄红）。
 * 第一版就是这么红的，三条用例全栽在注释上。
 */
const codeOnly = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释（含 /** */）
    .replace(/^\s*\/\/.*$/gm, "");        // 行注释

describe("门户 ↔ 员工 结构性隔离", () => {
  it("员工侧会话模块不引用门户的任何符号", () => {
    const staffFiles = ["src/lib/auth/session.ts", "src/lib/auth/options.ts"].filter((f) =>
      fs.existsSync(path.join(ROOT, f))
    );
    expect(staffFiles.length).toBeGreaterThan(0);
    for (const f of staffFiles) {
      const text = codeOnly(read(f));
      for (const sym of ["PORTAL_COOKIE", "lawlink_portal_session", "portal-session", "readPortalSession", "getPortalViewer", "ClientPortalUser"]) {
        expect(text, `${f} 出现了门户符号 ${sym}——两侧身份来源必须互不引用`).not.toContain(sym);
      }
    }
  });

  it("门户会话模块不引用员工侧会话符号", () => {
    for (const f of ["src/lib/portal/session.ts", "src/lib/portal/auth.ts"]) {
      const code = codeOnly(read(f));
      for (const sym of ["requireSession(", "getServerSession", "authOptions", "next-auth"]) {
        expect(code, `${f} 实际代码引用了员工侧符号 ${sym}`).not.toContain(sym);
      }
    }
  });

  it("门户 cookie 名与员工侧不同，且门户 cookie 限定 path=/portal", () => {
    const authRaw = read("src/lib/portal/auth.ts");
    expect(authRaw).toContain('PORTAL_COOKIE = "lawlink_portal_session"');
    expect(codeOnly(authRaw)).not.toContain("next-auth.session-token");

    const pageActions = read("src/server/portal/page-actions.ts");
    expect(pageActions, "门户 cookie 必须限定 path=/portal，避免随请求发到员工侧接口").toContain('path: "/portal"');
  });

  it("门户会话载荷只有身份，没有任何权限字段", () => {
    const auth = codeOnly(read("src/lib/portal/auth.ts"));
    const block = auth.slice(auth.indexOf("export type PortalSessionPayload"), auth.indexOf("}", auth.indexOf("export type PortalSessionPayload")));
    const fields = [...block.matchAll(/^\s*(\w+)\s*:/gm)].map((m) => m[1]);
    expect(new Set(fields)).toEqual(new Set(["uid", "sv", "exp"]));
    for (const forbidden of ["role", "roles", "permissions", "isAdmin", "scopes", "rolePermissions"]) {
      expect(fields, `门户会话不得携带权限字段 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("员工侧中间件把 /portal 与 /api/portal 都排除", () => {
    const proxy = read("src/proxy.ts");
    const matcherLine = proxy.split("\n").find((l) => l.includes("(?!") && l.includes("_next"));
    expect(matcherLine, "未找到 matcher").toBeTruthy();
    expect(matcherLine!).toContain("portal");
    expect(matcherLine!).toContain("confirm"); // 同类公开页也应仍在排除列表里

    // /api/portal 必须**单独**出现在排除列表里。
    // 2026-11-20 金线走查实测：只排 /portal 时页面能开、下载却 307 到员工登录页，
    // 症状是「客户说点下载没反应」。这类漏排不会让任何单测变红，只能靠这条断言守。
    expect(matcherLine!, "缺少 api/portal 排除——门户下载接口会被员工中间件拦走").toContain("api/portal");
  });

  it("门户页面不使用员工侧的权限断言与 AppShell", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      const abs = path.join(ROOT, dir);
      if (!fs.existsSync(abs)) return out;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
      }
      return out;
    };
    const portalFiles = walk("src/app/portal");
    expect(portalFiles.length).toBeGreaterThan(0);
    for (const f of portalFiles) {
      const text = codeOnly(read(f));
      for (const sym of ["AppShell", "requireSession(", "hasPermission(", "rolePermissions"]) {
        expect(text, `${f} 在门户里用了员工侧符号 ${sym}`).not.toContain(sym);
      }
    }
  });
});
