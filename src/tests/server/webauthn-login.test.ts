// @vitest-environment node
/**
 * Passkey 登录链路单测（台账 P2-2 后半）。
 *
 * 分工：
 *   - 签名验证由 @simplewebauthn/server 的 verifyAuthenticationResponse 负责，真实断言
 *     只能在浏览器里产生，所以这里 mock 掉**验签函数本身**；
 *   - 但 challenge 一次性、ticket 一次性、counter 递增这三条安全逻辑走真代码 + 真匹配
 *     语义的内存库（见 _webauthn-fake-db.ts），不允许被 stub 掉。
 *
 * 覆盖点：
 *   - 未配置时功能整体关闭（不降级、不查库）；
 *   - 账号枚举防护：邮箱不存在 / 无凭证 / 无邮箱 → 响应同形（空 allowCredentials）；
 *   - 验签参数必须来自配置（expectedOrigin / expectedRPID），不是请求头；
 *   - counter 不推进 → 拒绝 + WEBAUTHN_COUNTER_ANOMALY 高危审计，且不回写 counter；
 *   - 挑战重放 / 过期 / 凭证不存在 / 挑战与凭证不同账号 → 各自拒绝并审计；
 *   - 无用户名发现时挑战 userId 回填；
 *   - 不绕过 TOTP：未带码 → TOTP_REQUIRED（不发票据）；错码 → TOTP_FAILED + 计入失败锁定；
 *     正确码 → 票据带 2FA 标记；强制开启但未绑定 → 直接拒绝。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  verifyAuthn: vi.fn(),
  verifyReg: vi.fn(),
  secondFactor: vi.fn(),
  recordFailure: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return state.db;
  }
}));
vi.mock("@/lib/roles/service", () => ({
  resolveRoleUser: vi.fn(async () => ({ enabled: true, roleName: "律师", rolePermissions: [] }))
}));
vi.mock("@/server/auth/totp-login", () => ({
  verifyLoginSecondFactor: state.secondFactor,
  encryptSecret: vi.fn(),
  decryptSecret: vi.fn()
}));
vi.mock("@/lib/auth/login-lockout", () => ({
  recordLoginFailure: state.recordFailure
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyAuthenticationResponse: state.verifyAuthn,
    verifyRegistrationResponse: state.verifyReg
  };
});

import { ActionError } from "@/lib/action-error";
import { createFakePrisma, type FakeDb } from "@/tests/server/_webauthn-fake-db";
import { beginLogin, finishLogin } from "@/server/auth/webauthn-service";
import { encodeBase64Url, issueLoginTicket, readClientChallenge } from "@/lib/auth/webauthn";
import { authOptions } from "@/lib/auth/options";

const USER = "ckuser00000000000000000001";
const CRED_ID = "Y3JlZDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA";

type Fake = FakeDb & {
  __state: {
    challenges: Array<{ challenge: string; kind: string; userId: string | null; usedAt: Date | null }>;
    credentials: Array<{ credentialId: string; counter: bigint; lastUsedAt: Date | null }>;
    audits: Array<{ action: string; detail?: Record<string, unknown> }>;
  };
};

function seedUser(over: Record<string, unknown> = {}) {
  return {
    id: USER,
    name: "测试律师",
    email: "lawyer@law.example.com",
    active: true,
    role: "LAWYER",
    systemRole: "NONE",
    sessionVersion: 0,
    avatar: null,
    passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
    lockedUntil: null,
    failedLoginAttempts: 0,
    totpEnabled: false,
    totpEnforced: false,
    managerAuthorized: false,
    ...over
  };
}

function seedCredential(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    credentialId: CRED_ID,
    publicKey: encodeBase64Url(new Uint8Array([1, 2, 3, 4])),
    counter: BigInt(5),
    transports: ["internal"],
    deviceName: "办公台式机",
    ...over
  };
}

let db: Fake;

function assertionFor(challenge: string, credentialId = CRED_ID) {
  const clientDataJSON = encodeBase64Url(
    Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: "https://law.example.com" }))
  );
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: { clientDataJSON, authenticatorData: "AAAA", signature: "AAAA", userHandle: null },
    clientExtensionResults: {}
  };
}

function okVerification(newCounter: number, credentialId = CRED_ID) {
  return {
    verified: true,
    authenticationInfo: {
      credentialID: credentialId,
      newCounter,
      userVerified: true,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: false,
      origin: "https://law.example.com",
      rpID: "law.example.com"
    }
  };
}

function auditActions(): string[] {
  return db.__state.audits.map((a) => a.action);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AUTH_WEBAUTHN_RP_ID = "law.example.com";
  process.env.AUTH_WEBAUTHN_ORIGIN = "https://law.example.com";
  delete process.env.AUTH_WEBAUTHN_RP_NAME;
  state.recordFailure.mockResolvedValue(1);
  state.secondFactor.mockResolvedValue(true);
});

function makeDb(users = [seedUser()], credentials = [seedCredential()]) {
  db = createFakePrisma({ users, credentials }) as Fake;
  state.db = db;
  return db;
}

// ============ 未配置 = 功能关闭 ============

describe("未配置时功能整体关闭", () => {
  it("beginLogin / finishLogin 一律拒绝，且不往库里写挑战（不降级）", async () => {
    delete process.env.AUTH_WEBAUTHN_RP_ID;
    delete process.env.AUTH_WEBAUTHN_ORIGIN;
    makeDb();
    await expect(beginLogin({})).rejects.toBeInstanceOf(ActionError);
    await expect(beginLogin({})).rejects.toThrow(/未启用/);
    await expect(finishLogin({})).rejects.toThrow(/未启用/);
    expect(db.__state.challenges).toHaveLength(0);
  });

  it("origin 用 http 公网地址同样视为未配置（不允许明文站点）", async () => {
    process.env.AUTH_WEBAUTHN_ORIGIN = "http://law.example.com";
    makeDb();
    await expect(beginLogin({})).rejects.toThrow(/未启用/);
  });
});

// ============ 开始登录 ============

describe("beginLogin：挑战生成与账号枚举防护", () => {
  it("带 email → allowCredentials 限定为该账号的凭证（含 transports）", async () => {
    makeDb();
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    expect(options.rpId).toBe("law.example.com");
    // allowCredentials 由 generateAuthenticationOptions 补齐 type 字段
    expect(options.allowCredentials).toMatchObject([{ id: CRED_ID, transports: ["internal"], type: "public-key" }]);
    expect(options.userVerification).toBe("required");
    const row = db.__state.challenges.find((c) => c.challenge === options.challenge);
    expect(row?.kind).toBe("login");
    expect(row?.userId).toBe(USER);
  });

  it("不带 email → 空 allowCredentials（无用户名发现），挑战 userId 为空", async () => {
    makeDb();
    const options = await beginLogin({});
    expect(options.allowCredentials).toBeUndefined();
    const row = db.__state.challenges.find((c) => c.challenge === options.challenge);
    expect(row?.userId).toBeNull();
  });

  it("邮箱不存在 / 账号停用 / 该账号没有任何凭证 → 三种情况响应完全同形（不可枚举）", async () => {
    makeDb([seedUser({ active: false })]);
    const disabled = await beginLogin({ email: "lawyer@law.example.com" });
    const unknown = await beginLogin({ email: "nobody@law.example.com" });
    expect(disabled.allowCredentials).toBeUndefined();
    expect(unknown.allowCredentials).toBeUndefined();
    // 三次请求都不把"账号存在与否"暴露成不同的挑战形状
    expect(Object.keys(disabled).sort()).toEqual(Object.keys(unknown).sort());

    const fresh = makeDb([], []);
    const noCred = await beginLogin({ email: "lawyer@law.example.com" });
    expect(noCred.allowCredentials).toBeUndefined();
    expect(fresh.__state.challenges).toHaveLength(1);
  });

  it("邮箱大小写不敏感（与 SSO 同口径）：大小写不同仍能限定到该账号的设备", async () => {
    makeDb();
    const options = await beginLogin({ email: "LAWYER@Law.Example.COM" });
    expect(options.allowCredentials).toMatchObject([{ id: CRED_ID }]);
  });

  it("邮箱格式非法 → 入参校验拒绝（parseInput 的 ActionError）", async () => {
    makeDb();
    await expect(beginLogin({ email: "not-an-email" })).rejects.toThrow(/有效邮箱/);
  });
});

// ============ 完成登录：成功路径 ============

describe("finishLogin：成功路径", () => {
  it("验签通过 → 签发一次性票据、counter 推进、lastUsedAt 落库", async () => {
    makeDb();
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    state.verifyAuthn.mockResolvedValue(okVerification(6));

    const outcome = await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(outcome).toEqual({ status: "OK", ticket: expect.any(String) });

    const cred = db.__state.credentials[0];
    expect(cred.counter).toBe(BigInt(6));
    expect(cred.lastUsedAt).toBeInstanceOf(Date);

    // 验签参数必须来自配置，不能来自请求头
    const call = state.verifyAuthn.mock.calls[0][0];
    expect(call.expectedOrigin).toBe("https://law.example.com");
    expect(call.expectedRPID).toBe("law.example.com");
    expect(call.expectedChallenge).toBe(options.challenge);
    expect(call.requireUserVerification).toBe(true);
  });

  it("无用户名发现时把挑战的 userId 回填为匹配到的用户", async () => {
    makeDb();
    const options = await beginLogin({});
    expect(db.__state.challenges[0].userId).toBeNull();
    state.verifyAuthn.mockResolvedValue(okVerification(6));

    await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(db.__state.challenges[0].userId).toBe(USER);
  });
});

// ============ 完成登录：各类拒绝 ============

describe("finishLogin：挑战与凭证校验", () => {
  it("挑战重放：第二次提交同一份断言 → CHALLENGE_INVALID", async () => {
    makeDb();
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    state.verifyAuthn.mockResolvedValue(okVerification(6));

    expect((await finishLogin({ assertion: assertionFor(options.challenge) })).status).toBe("OK");
    const replay = await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(replay).toMatchObject({ status: "REJECTED", code: "CHALLENGE_INVALID" });
    expect(auditActions()).toContain("WEBAUTHN_LOGIN_REJECT");
  });

  it("挑战过期 → CHALLENGE_INVALID（5 分钟窗口之外）", async () => {
    makeDb();
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    const row = db.__state.challenges.find((c) => c.challenge === options.challenge)!;
    row.usedAt = new Date();
    const expired = await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(expired).toMatchObject({ status: "REJECTED", code: "CHALLENGE_INVALID" });
  });

  it("凭证不存在 → UNKNOWN_CREDENTIAL", async () => {
    makeDb();
    const options = await beginLogin({});
    const outcome = await finishLogin({ assertion: assertionFor(options.challenge, "b3RoZXJjcmVkZW50aWFs") });
    expect(outcome).toMatchObject({ status: "REJECTED", code: "UNKNOWN_CREDENTIAL" });
  });

  it("挑战属于 A 账号、凭证属于 B 账号 → USER_MISMATCH", async () => {
    const other = seedUser({ id: "ckuser00000000000000000002", email: "other@law.example.com" });
    makeDb(
      [seedUser(), other],
      [seedCredential(), seedCredential({ userId: other.id, credentialId: "b3RoZXJjcmVkZW50aWFs" })]
    );
    // 挑战是按 A 的邮箱签发的（userId=A），却提交 B 的设备断言
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    const outcome = await finishLogin({ assertion: assertionFor(options.challenge, "b3RoZXJjcmVkZW50aWFs") });
    expect(outcome).toMatchObject({ status: "REJECTED", code: "USER_MISMATCH" });
    expect(db.__state.audits.some((a) => a.detail?.reason === "USER_MISMATCH")).toBe(true);
    expect(state.verifyAuthn).not.toHaveBeenCalled();
  });

  it("验签抛错 → VERIFY_FAILED（不把内部错误透给未登录页面）", async () => {
    makeDb();
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    state.verifyAuthn.mockRejectedValue(new Error("signature mismatch"));
    const outcome = await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(outcome).toMatchObject({ status: "REJECTED", code: "VERIFY_FAILED" });
    expect(JSON.stringify(outcome)).not.toContain("signature mismatch");
  });

  it("账号停用 / 锁定 / 角色停用 各自拒绝", async () => {
    makeDb([seedUser({ active: false })]);
    let options = await beginLogin({});
    expect(await finishLogin({ assertion: assertionFor(options.challenge) })).toMatchObject({
      status: "REJECTED",
      code: "ACCOUNT_DISABLED"
    });

    makeDb([seedUser({ lockedUntil: new Date(Date.now() + 60_000) })]);
    options = await beginLogin({});
    expect(await finishLogin({ assertion: assertionFor(options.challenge) })).toMatchObject({
      status: "REJECTED",
      code: "LOCKED"
    });
  });
});

// ============ 防克隆：counter ============

describe("finishLogin：counter 未推进 = 凭证可能被克隆", () => {
  it("newCounter 与已存相同 → 拒绝 + WEBAUTHN_COUNTER_ANOMALY 高危审计 + 不回写 counter", async () => {
    makeDb();
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    state.verifyAuthn.mockResolvedValue(okVerification(5)); // 存的是 5

    const outcome = await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(outcome).toMatchObject({ status: "REJECTED", code: "COUNTER_ANOMALY" });
    expect((outcome as { message: string }).message).toContain("联系");

    const anomaly = db.__state.audits.find((a) => a.action === "WEBAUTHN_COUNTER_ANOMALY");
    expect(anomaly).toBeTruthy();
    expect(anomaly?.detail).toMatchObject({ severity: "HIGH", storedCounter: "5", incomingCounter: 5 });

    expect(db.__state.credentials[0].counter).toBe(BigInt(5));
    expect(db.__state.credentials[0].lastUsedAt).toBeNull();
  });

  it("newCounter 变小（重放旧断言）→ 同样拒绝", async () => {
    makeDb([seedUser()], [seedCredential({ counter: BigInt(9) })]);
    const options = await beginLogin({});
    state.verifyAuthn.mockResolvedValue(okVerification(3));
    expect(await finishLogin({ assertion: assertionFor(options.challenge) })).toMatchObject({
      status: "REJECTED",
      code: "COUNTER_ANOMALY"
    });
  });

  it("counter 0→0（认证器不支持计数器）不误判克隆", async () => {
    makeDb([seedUser()], [seedCredential({ counter: BigInt(0) })]);
    const options = await beginLogin({});
    state.verifyAuthn.mockResolvedValue(okVerification(0));
    expect((await finishLogin({ assertion: assertionFor(options.challenge) })).status).toBe("OK");
    expect(auditActions()).not.toContain("WEBAUTHN_COUNTER_ANOMALY");
  });
});

// ============ 不绕过 TOTP ============

describe("finishLogin：TOTP 与 Passkey 串接", () => {
  it("已开启 TOTP 但没带码 → TOTP_REQUIRED，不签发任何票据", async () => {
    makeDb([seedUser({ totpEnabled: true })]);
    const options = await beginLogin({ email: "lawyer@law.example.com" });
    state.verifyAuthn.mockResolvedValue(okVerification(6));

    expect(await finishLogin({ assertion: assertionFor(options.challenge) })).toEqual({ status: "TOTP_REQUIRED" });
    // 只应有登录挑战，没有任何票据行
    expect(db.__state.challenges.filter((c) => c.kind.startsWith("TICKET"))).toHaveLength(0);
    expect(state.secondFactor).not.toHaveBeenCalled();
    // counter 也不推进（本次没走完）
    expect(db.__state.credentials[0].counter).toBe(BigInt(5));
  });

  it("TOTP 码错误 → TOTP_FAILED + 计入失败锁定 + 审计", async () => {
    makeDb([seedUser({ totpEnabled: true })]);
    const options = await beginLogin({});
    state.verifyAuthn.mockResolvedValue(okVerification(6));
    state.secondFactor.mockResolvedValue(false);
    state.recordFailure.mockResolvedValue(2);

    const outcome = await finishLogin({ assertion: assertionFor(options.challenge), totpCode: "000000" });
    expect(outcome).toMatchObject({ status: "REJECTED", code: "TOTP_FAILED" });
    expect(state.secondFactor).toHaveBeenCalledWith(USER, "000000");
    expect(state.recordFailure).toHaveBeenCalledWith(USER, 5, 15);
    const reject = db.__state.audits.find((a) => a.action === "WEBAUTHN_LOGIN_REJECT" && a.detail?.reason === "TOTP_FAILED");
    expect(reject).toBeTruthy();
  });

  it("TOTP 码正确 → 票据带 2FA 标记（authorize 侧据此放行）", async () => {
    makeDb([seedUser({ totpEnabled: true })]);
    const options = await beginLogin({});
    state.verifyAuthn.mockResolvedValue(okVerification(6));
    state.secondFactor.mockResolvedValue(true);

    const outcome = await finishLogin({ assertion: assertionFor(options.challenge), totpCode: "123456" });
    expect(outcome.status).toBe("OK");
    const ticketRow = db.__state.challenges.find((c) => c.kind.startsWith("TICKET"));
    expect(ticketRow?.kind).toBe("TICKET_2FA");
  });

  it("管理员强制开启但本人未绑定 → 直接拒绝（与密码路径同口径）", async () => {
    makeDb([seedUser({ totpEnforced: true, totpEnabled: false })]);
    const options = await beginLogin({});
    const outcome = await finishLogin({ assertion: assertionFor(options.challenge) });
    expect(outcome).toMatchObject({ status: "REJECTED", code: "TOTP_ENFORCED_UNBOUND" });
    expect(state.verifyAuthn).not.toHaveBeenCalled();
  });
});

// ============ 入参形状 ============

describe("finishLogin：入参校验", () => {
  it("缺 response 字段 → parseInput 拒绝（ActionError，不外泄为 500）", async () => {
    makeDb();
    await expect(finishLogin({ assertion: { id: "x" } })).rejects.toBeInstanceOf(ActionError);
  });

  it("clientDataJSON 畸形 → CHALLENGE_INVALID（不是崩溃）", async () => {
    makeDb();
    const broken = {
      id: CRED_ID,
      rawId: CRED_ID,
      type: "public-key",
      response: { clientDataJSON: encodeBase64Url(Buffer.from("nope")), authenticatorData: "A", signature: "B", userHandle: null }
    };
    expect(await finishLogin({ assertion: broken })).toMatchObject({ status: "REJECTED", code: "CHALLENGE_INVALID" });
  });

  it("挑战值必须与提交的 clientData 一致（换一个挑战即失效）", async () => {
    makeDb();
    const options = await beginLogin({});
    expect(readClientChallenge(assertionFor(options.challenge).response.clientDataJSON)).toBe(options.challenge);
    const swapped = await finishLogin({ assertion: assertionFor("c29tZS1vdGhlci1jaGFsbGVuZ2U") });
    expect(swapped).toMatchObject({ status: "REJECTED", code: "CHALLENGE_INVALID" });
  });
});

// ============ options.ts 接线 ============

describe("CredentialsProvider 的票据分支（不改动密码登录行为）", () => {
  // 与 totp-enforced.test.ts 同口径：本机 next-auth 的 credentials provider 可能把
  // 真实实现挂在 provider.options 上，两种形态都取得到。
  const provider = authOptions.providers[0] as {
    authorize?: (c: unknown) => Promise<unknown>;
    options?: { authorize?: (c: unknown) => Promise<unknown> };
  };
  const authorize = (provider.options?.authorize ?? provider.authorize)!;

  it("有效票据 → 返回本地 User（后续 jwt/session 走同一条 sessionVersion 校验）", async () => {
    makeDb();
    const ticket = await issueLoginTicket(USER, { secondFactor: false });
    const user = (await authorize({ ticket, __passkey: "1" })) as Record<string, unknown>;
    expect(user).toMatchObject({
      id: USER,
      role: "LAWYER",
      systemRole: "NONE",
      sessionVersion: 0,
      email: "lawyer@law.example.com"
    });
    // 票据已核销：同一张不能再换一次会话
    expect(await authorize({ ticket, __passkey: "1" })).toBeNull();
  });

  it("__passkey=1 但缺 ticket → null + MALFORMED_TICKET 审计（不走密码分支）", async () => {
    makeDb();
    expect(await authorize({ __passkey: "1" })).toBeNull();
    const auditRow = db.__state.audits.find((a) => a.detail?.reason === "MALFORMED_TICKET");
    expect(auditRow).toBeTruthy();
  });

  it("票据无效 → null（不新增任何会话审计以外的副作用）", async () => {
    makeDb();
    expect(await authorize({ ticket: "aW52YWxpZC10aWNrZXQtdmFsdWU", __passkey: "1" })).toBeNull();
    expect(db.__state.audits.some((a) => a.action === "WEBAUTHN_LOGIN")).toBe(false);
  });

  it("密码分支行为不变：不带 __passkey 时按原逻辑校验（错误密码 → null）", async () => {
    makeDb();
    expect(await authorize({ email: "lawyer@law.example.com", password: "wrong" })).toBeNull();
    // 密码分支仍然走自己的失败审计，没有被 passkey 分支劫持
    expect(db.__state.audits.some((a) => a.action === "LOGIN_FAILED" || a.action === "LOGIN_LOCKED")).toBe(true);
    expect(db.__state.audits.some((a) => a.detail?.provider === "passkey")).toBe(false);
  });
});
