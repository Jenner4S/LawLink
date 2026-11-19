// @vitest-environment node
/**
 * WebAuthn 基础层单测（台账 P2-2 后半）。
 *
 * 覆盖的是"开关"与"一次性"这两类最不能出错的东西：
 *   - 配置读错的两个方向都危险：该关没关（登录页出现一个点了就报错的按钮、或服务端
 *     拿请求头凑 origin 让假站点通过验签）、该开没开（部署方以为开了，实际全在走密码）；
 *   - 挑战/票据如果不是真一次性，验签就成了摆设（重放即可复用同一份断言）。
 *
 * 这里刻意**不用 stub 打桩 Prisma**：挑战与票据的一次性来自条件更新的原子语义
 * （`updateMany(where: { usedAt: null, expiresAt: { gt: now } })`），用假实现就必须
 * 保留真实的匹配逻辑，否则测的是 stub 不是代码。见 _webauthn-fake-db.ts 的说明。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return state.db;
  }
}));

import { createFakePrisma, type FakeDb } from "@/tests/server/_webauthn-fake-db";
import {
  decodeBase64Url,
  encodeBase64Url,
  WEBAUTHN_CHALLENGE_TTL_MS,
  WEBAUTHN_TICKET_TTL_MS,
  consumeChallenge,
  consumeLoginTicket,
  counterRolledBack,
  createChallenge,
  isLoopbackHost,
  isWebAuthnConfigured,
  issueLoginTicket,
  newChallengeValue,
  pruneExpiredChallenges,
  readClientChallenge,
  readWebAuthnConfig,
  sanitizeTransports,
  webauthnUserHandle
} from "@/lib/auth/webauthn";

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  over as unknown as NodeJS.ProcessEnv;

const FULL = {
  AUTH_WEBAUTHN_RP_ID: "law.example.com",
  AUTH_WEBAUTHN_ORIGIN: "https://law.example.com"
};

let db: FakeDb & { __state: { challenges: Array<{ challenge: string; kind: string; usedAt: Date | null }> } };
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = createFakePrisma() as typeof db;
  state.db = db;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

// ============ 配置 ============

describe("readWebAuthnConfig：功能开关", () => {
  it("三个变量全空 → null，且不吵日志（这是「没启用」不是「配错了」）", () => {
    expect(readWebAuthnConfig(env())).toBeNull();
    expect(readWebAuthnConfig(env({ AUTH_WEBAUTHN_RP_NAME: "  " }))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(isWebAuthnConfigured(env())).toBe(false);
  });

  it("只配了一半 → null + warn（部署方写错必须看得见）", () => {
    expect(readWebAuthnConfig(env({ AUTH_WEBAUTHN_RP_ID: "law.example.com" }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("配置不完整"));
    expect(readWebAuthnConfig(env({ AUTH_WEBAUTHN_ORIGIN: "https://law.example.com" }))).toBeNull();
  });

  it("http + 公网域名被拒绝（WebAuthn 只在安全上下文里成立）", () => {
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_ORIGIN: "http://law.example.com" }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("localhost / 127.0.0.1"));
  });

  it("http + 本机 localhost / 127.0.0.1 允许，并规范化为 origin", () => {
    expect(
      readWebAuthnConfig(env({ AUTH_WEBAUTHN_RP_ID: "localhost", AUTH_WEBAUTHN_ORIGIN: "http://localhost:3000" }))
    ).toEqual({ rpId: "localhost", rpName: "LawLink", origin: "http://localhost:3000" });
    expect(
      readWebAuthnConfig(env({ AUTH_WEBAUTHN_RP_ID: "127.0.0.1", AUTH_WEBAUTHN_ORIGIN: "http://127.0.0.1:3000" }))?.origin
    ).toBe("http://127.0.0.1:3000");
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("law.example.com")).toBe(false);
  });

  it("完整 https 配置解析（rpName 缺省 LawLink、大小写归一）", () => {
    expect(readWebAuthnConfig(env(FULL))).toEqual({
      rpId: "law.example.com",
      rpName: "LawLink",
      origin: "https://law.example.com"
    });
    expect(
      readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_RP_NAME: " 某某律所 ", AUTH_WEBAUTHN_RP_ID: "LAW.Example.COM" }))
    ).toEqual({ rpId: "law.example.com", rpName: "某某律所", origin: "https://law.example.com" });
    expect(isWebAuthnConfigured(env(FULL))).toBe(true);
  });

  it("rpID 允许是 origin 的上级域，但不能与主机名无关", () => {
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_RP_ID: "example.com" }))?.rpId).toBe("example.com");
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_RP_ID: "other.example.com" }))).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("上级域名"));
  });

  it("rpID 带协议/端口/路径、origin 带路径 → 一律拒绝", () => {
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_RP_ID: "https://law.example.com" }))).toBeNull();
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_RP_ID: "law.example.com:3000" }))).toBeNull();
    expect(
      readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_ORIGIN: "https://law.example.com/login" }))
    ).toBeNull();
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_ORIGIN: "not-a-url" }))).toBeNull();
    expect(readWebAuthnConfig(env({ ...FULL, AUTH_WEBAUTHN_ORIGIN: "ftp://law.example.com" }))).toBeNull();
  });
});

// ============ 挑战（一次性 + 过期） ============

describe("challenge：一次性、限时、绑定 kind", () => {
  const T0 = new Date("2026-11-19T10:00:00Z");

  it("第一次消费成功，第二次消费失败（重放同一份断言必须无效）", async () => {
    const challenge = await createChallenge({ kind: "login", userId: "u1", now: T0 });
    const first = await consumeChallenge({ challenge, kind: "login", now: new Date(T0.getTime() + 1000) });
    expect(first).toEqual({ userId: "u1" });
    const second = await consumeChallenge({ challenge, kind: "login", now: new Date(T0.getTime() + 2000) });
    expect(second).toBeNull();
  });

  it("超过 5 分钟即失效（TTL 之外一律 null）", async () => {
    const challenge = await createChallenge({ kind: "login", userId: "u1", now: T0 });
    const expired = await consumeChallenge({
      challenge,
      kind: "login",
      now: new Date(T0.getTime() + WEBAUTHN_CHALLENGE_TTL_MS + 1)
    });
    expect(expired).toBeNull();
  });

  it("kind 不符不能用（注册挑战不能拿去当登录挑战）", async () => {
    const challenge = await createChallenge({ kind: "register", userId: "u1", now: T0 });
    expect(await consumeChallenge({ challenge, kind: "login", now: T0 })).toBeNull();
    expect(await consumeChallenge({ challenge, kind: "register", now: T0 })).toEqual({ userId: "u1" });
  });

  it("不存在的挑战返回 null；无用户名发现的挑战 userId 为空", async () => {
    expect(await consumeChallenge({ challenge: "nope", kind: "login", now: T0 })).toBeNull();
    const challenge = await createChallenge({ kind: "login", userId: null, now: T0 });
    expect(await consumeChallenge({ challenge, kind: "login", now: T0 })).toEqual({ userId: null });
  });

  it("并发消费只有一个能成功（条件更新即原子独占）", async () => {
    const challenge = await createChallenge({ kind: "login", userId: "u1", now: T0 });
    const results = await Promise.all([
      consumeChallenge({ challenge, kind: "login", now: T0 }),
      consumeChallenge({ challenge, kind: "login", now: T0 }),
      consumeChallenge({ challenge, kind: "login", now: T0 })
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("清理过期行：只删已过期的", async () => {
    await createChallenge({ kind: "login", now: T0, ttlMs: 1000 });
    await createChallenge({ kind: "login", now: T0, ttlMs: 60_000 });
    const removed = await pruneExpiredChallenges(new Date(T0.getTime() + 2000));
    expect(removed).toBe(1);
    expect(db.__state.challenges).toHaveLength(1);
  });
});

// ============ 一次性登录票据 ============

describe("ticket：60 秒、单次、绑定 userId 与 2FA 标记", () => {
  const T0 = new Date("2026-11-19T10:00:00Z");

  it("核销一次即失效", async () => {
    const ticket = await issueLoginTicket("u1", { secondFactor: false, now: T0 });
    expect(await consumeLoginTicket(ticket, T0)).toEqual({ userId: "u1", secondFactor: false });
    expect(await consumeLoginTicket(ticket, T0)).toBeNull();
  });

  it("超过 60 秒失效", async () => {
    const ticket = await issueLoginTicket("u1", { secondFactor: false, now: T0 });
    expect(await consumeLoginTicket(ticket, new Date(T0.getTime() + WEBAUTHN_TICKET_TTL_MS + 1))).toBeNull();
  });

  it("secondFactor 标记随票据传递（决定 authorize 是否还要动态码）", async () => {
    const ticket = await issueLoginTicket("u1", { secondFactor: true, now: T0 });
    expect(await consumeLoginTicket(ticket, T0)).toEqual({ userId: "u1", secondFactor: true });
  });

  it("注册/登录挑战不能当票据用（kind 隔离）", async () => {
    const register = await createChallenge({ kind: "register", userId: "u1", now: T0 });
    const login = await createChallenge({ kind: "login", userId: "u1", now: T0 });
    expect(await consumeLoginTicket(register, T0)).toBeNull();
    expect(await consumeLoginTicket(login, T0)).toBeNull();
  });

  it("伪造的票据字符串核销失败", async () => {
    expect(await consumeLoginTicket(newChallengeValue(), T0)).toBeNull();
  });
});

// ============ 计数器（防克隆的唯一手段） ============

describe("counterRolledBack", () => {
  it("相等即判定回退（同一份私钥被两处使用）", () => {
    expect(counterRolledBack(5, 5)).toBe(true);
    expect(counterRolledBack(BigInt(7), 7)).toBe(true);
  });

  it("变小即判定回退", () => {
    expect(counterRolledBack(5, 3)).toBe(true);
    expect(counterRolledBack(BigInt(1), 0)).toBe(true);
  });

  it("严格递增放行", () => {
    expect(counterRolledBack(5, 6)).toBe(false);
    expect(counterRolledBack(BigInt(0), 1)).toBe(false);
  });

  it("0→0 视为「认证器不支持计数器」（WebAuthn L2 §6.1.3），不判克隆", () => {
    expect(counterRolledBack(0, 0)).toBe(false);
    expect(counterRolledBack(BigInt(0), 0)).toBe(false);
  });
});

// ============ 编解码与辅助 ============

describe("Base64URL 与 clientData 解析", () => {
  it("编码/解码可往返，且不含 + / = 字符", () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(decodeBase64Url(encoded))).toEqual(Array.from(bytes));
    // 前端可能带填充/标准 base64 形态（兼容旧实现），仍应解出同样的字节
    expect(Array.from(decodeBase64Url("AAH6+/z9/v8="))).toEqual(Array.from(bytes));
  });

  it("readClientChallenge 解出挑战；畸形输入返回 null", () => {
    const clientData = encodeBase64Url(Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: "abc123" })));
    expect(readClientChallenge(clientData)).toBe("abc123");
    expect(readClientChallenge(encodeBase64Url(Buffer.from("not json")))).toBeNull();
    expect(readClientChallenge(encodeBase64Url(Buffer.from(JSON.stringify({ challenge: "" }))))).toBeNull();
    expect(readClientChallenge("!!!")).toBeNull();
  });

  it("sanitizeTransports 只保留规范取值并去重", () => {
    expect(sanitizeTransports(["USB", "internal", "internal", "evil", 42, null])).toEqual(["usb", "internal"]);
    expect(sanitizeTransports("usb")).toEqual([]);
    expect(sanitizeTransports(["hybrid", "smart-card"])).toEqual(["hybrid", "smart-card"]);
  });

  it("user handle 稳定、长度 32 字节、不泄露原始 userId", async () => {
    const a = webauthnUserHandle("ckuser0000000000000000001");
    const b = webauthnUserHandle("ckuser0000000000000000001");
    const c = webauthnUserHandle("ckuser0000000000000000002");
    expect(a).toHaveLength(32);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(Buffer.from(a).toString("utf8")).not.toContain("ckuser");
  });
});
