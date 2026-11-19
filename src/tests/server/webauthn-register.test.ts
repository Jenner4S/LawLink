// @vitest-environment node
/**
 * Passkey 注册与凭证管理单测（台账 P2-2 后半）。
 *
 * 关键覆盖：
 *   - **注册必须二次确认当前密码**（红线 5）：会话被劫持时不能静默绑定攻击者设备。
 *     密码错时挑战**不应被消费**——否则用户输错一次就得从头再来。
 *   - 同一认证器不能绑定两次（credentialId 唯一），跨账号更不行（那是抢别人的设备）。
 *   - 删除保留至少一种登录方式：无密码账号删到最后一台即拒绝。
 *   - 全部动作写审计（WEBAUTHN_REGISTER / WEBAUTHN_DELETE），含拒绝分支。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  verifyReg: vi.fn(),
  verifyAuthn: vi.fn()
}));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return state.db;
  }
}));
vi.mock("@/lib/roles/service", () => ({
  resolveRoleUser: vi.fn(async () => ({ enabled: true, roleName: "律师", rolePermissions: [] }))
}));
vi.mock("@simplewebauthn/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@simplewebauthn/server")>();
  return {
    ...actual,
    verifyRegistrationResponse: state.verifyReg,
    verifyAuthenticationResponse: state.verifyAuthn
  };
});

import bcrypt from "bcryptjs";
import { ActionError } from "@/lib/action-error";
import { createFakePrisma, type FakeDb } from "@/tests/server/_webauthn-fake-db";
import {
  beginRegistration,
  deleteCredential,
  finishRegistration,
  listCredentials
} from "@/server/auth/webauthn-service";
import { encodeBase64Url } from "@/lib/auth/webauthn";

const USER = "ckuser00000000000000000001";
const OTHER = "ckuser00000000000000000002";
const PASSWORD = "ChangeMe!2026";

type Fake = FakeDb & {
  __state: {
    challenges: Array<{ challenge: string; kind: string; userId: string | null; usedAt: Date | null }>;
    credentials: Array<{ id: string; userId: string; credentialId: string; publicKey: string; counter: bigint; transports: string[]; deviceName: string | null; backedUp: boolean }>;
    users: Array<Record<string, unknown> & { id: string }>;
    audits: Array<{ action: string; detail?: Record<string, unknown>; targetId?: string }>;
  };
};

let db: Fake;
let passwordHash: string;
const actor = { id: USER, role: "LAWYER" };

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.AUTH_WEBAUTHN_RP_ID = "law.example.com";
  process.env.AUTH_WEBAUTHN_ORIGIN = "https://law.example.com";
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

function makeDb(users?: Array<Record<string, unknown> & { id: string }>) {
  db = createFakePrisma({
    users: users ?? [
      { id: USER, name: "测试律师", email: "lawyer@law.example.com", active: true, role: "LAWYER", passwordHash },
      { id: OTHER, name: "另一位", email: "other@law.example.com", active: true, role: "LAWYER", passwordHash }
    ],
    credentials: []
  }) as Fake;
  state.db = db;
  return db;
}

/** 直接往内存表里塞一条凭证（补上 create 时才会自动生成的字段） */
function pushCred(...overs: Record<string, unknown>[]) {
  for (const over of overs) {
    db.__state.credentials.push({
      id: "credDefault",
      userId: USER,
      credentialId: "ZGVmYXVsdA",
      publicKey: "AA",
      counter: BigInt(0),
      transports: [],
      deviceName: null,
      backedUp: false,
      createdAt: new Date("2026-11-01T00:00:00Z"),
      lastUsedAt: null,
      ...over
    } as never);
  }
}

function attestationFor(challenge: string, over: Record<string, unknown> = {}) {
  const clientDataJSON = encodeBase64Url(
    Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: "https://law.example.com" }))
  );
  return {
    id: "bmV3Y3JlZGVudGlhbA",
    rawId: "bmV3Y3JlZGVudGlhbA",
    type: "public-key",
    response: { clientDataJSON, attestationObject: "YXR0ZXN0YXRpb24", transports: ["internal", "weird-value"] },
    clientExtensionResults: {},
    ...over
  };
}

function registrationInfo(id = "bmV3Y3JlZGVudGlhbA", counter = 0) {
  return {
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: { id, publicKey: new Uint8Array([9, 8, 7]), counter, transports: ["internal"] },
      credentialType: "public-key",
      attestationObject: new Uint8Array([]),
      userVerified: true,
      credentialDeviceType: "singleDevice",
      credentialBackedUp: true,
      origin: "https://law.example.com",
      rpID: "law.example.com"
    }
  };
}

// ============ 开始注册 ============

describe("beginRegistration", () => {
  it("未配置时拒绝（不降级）", async () => {
    delete process.env.AUTH_WEBAUTHN_RP_ID;
    makeDb();
    await expect(beginRegistration(actor)).rejects.toThrow(/未启用/);
  });

  it("生成 options：rp 名称/rpID、userHandle 稳定、已绑定设备进 excludeCredentials", async () => {
    makeDb();
    const first = await beginRegistration(actor);
    expect(first.rp.id).toBe("law.example.com");
    expect(first.rp.name).toBe("LawLink");
    expect(first.user.name).toBe("lawyer@law.example.com");
    expect(first.excludeCredentials).toEqual([]);

    // 已有一台设备后再开始注册 → 进 excludeCredentials（避免同一认证器绑定两次）
    pushCred({
      id: "cred000001",
      userId: USER,
      credentialId: "ZXhpc3Rpbmc",
      publicKey: "AA",
      counter: BigInt(0),
      transports: ["usb"],
      deviceName: "旧 U 盾",
      backedUp: false
    });
    const second = await beginRegistration(actor);
    expect(second.excludeCredentials).toEqual([{ id: "ZXhpc3Rpbmc", transports: ["usb"], type: "public-key" }]);

    // 挑战已落库且绑定到当前用户
    const row = db.__state.challenges.find((c) => c.challenge === second.challenge);
    expect(row?.kind).toBe("register");
    expect(row?.userId).toBe(USER);
  });

  it("账号不存在 → 拒绝", async () => {
    makeDb([]);
    await expect(beginRegistration(actor)).rejects.toThrow(/账号不存在/);
  });
});

// ============ 完成注册 ============

describe("finishRegistration：二次确认密码", () => {
  it("密码错误 → 拒绝 + 审计，且挑战不被消费（用户改对密码可继续用同一挑战）", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue(registrationInfo());

    await expect(
      finishRegistration(actor, {
        attestation: attestationFor(options.challenge),
        password: "wrong-password",
        deviceName: "办公台式机"
      })
    ).rejects.toThrow(/当前密码不正确/);

    expect(db.__state.credentials).toHaveLength(0);
    expect(db.__state.challenges[0].usedAt).toBeNull();
    const rejected = db.__state.audits.find(
      (a) => a.action === "WEBAUTHN_REGISTER" && a.detail?.reason === "BAD_PASSWORD"
    );
    expect(rejected).toBeTruthy();
    expect(state.verifyReg).not.toHaveBeenCalled();
  });

  it("密码正确 → 落库：publicKey 为 Base64URL、transports 过滤未知值、backedUp 记录事实", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue(registrationInfo());

    const created = await finishRegistration(actor, {
      attestation: attestationFor(options.challenge),
      password: PASSWORD,
      deviceName: "  办公台式机  "
    });
    expect(created.deviceName).toBe("办公台式机");

    const stored = db.__state.credentials[0];
    expect(stored.userId).toBe(USER);
    expect(stored.publicKey).toBe(encodeBase64Url(new Uint8Array([9, 8, 7])));
    expect(stored.transports).toEqual(["internal"]);
    expect(stored.backedUp).toBe(true);
    expect(stored.counter).toBe(BigInt(0));

    // 验签参数来自配置
    const call = state.verifyReg.mock.calls[0][0];
    expect(call.expectedOrigin).toBe("https://law.example.com");
    expect(call.expectedRPID).toBe("law.example.com");
    expect(call.expectedChallenge).toBe(options.challenge);
    expect(call.requireUserVerification).toBe(true);

    const ok = db.__state.audits.find((a) => a.action === "WEBAUTHN_REGISTER" && a.detail?.result === "OK");
    expect(ok?.detail).toMatchObject({ deviceName: "办公台式机", transports: ["internal"] });
  });

  it("不填备注时 deviceName 为 null（列表回退显示「未命名设备」）", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue(registrationInfo());
    const created = await finishRegistration(actor, {
      attestation: attestationFor(options.challenge),
      password: PASSWORD
    });
    expect(created.deviceName).toBeNull();
  });
});

describe("finishRegistration：挑战与重复绑定", () => {
  it("同一挑战只能用一次（重放 attestation 无效）", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue(registrationInfo());
    await finishRegistration(actor, { attestation: attestationFor(options.challenge), password: PASSWORD });

    await expect(
      finishRegistration(actor, { attestation: attestationFor(options.challenge), password: PASSWORD })
    ).rejects.toThrow(/已过期或已被使用/);
    expect(db.__state.credentials).toHaveLength(1);
  });

  it("挑战属于另一个账号 → 拒绝（不能用别人的挑战给自己绑设备）", async () => {
    makeDb();
    const options = await beginRegistration({ id: OTHER, role: "LAWYER" });
    state.verifyReg.mockResolvedValue(registrationInfo());
    await expect(
      finishRegistration(actor, { attestation: attestationFor(options.challenge), password: PASSWORD })
    ).rejects.toThrow(/不匹配/);
  });

  it("同一设备重复绑定（同账号）→ 拒绝并审计 DUPLICATE", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue(registrationInfo("c2FtZWNyZWQ"));
    await finishRegistration(actor, { attestation: attestationFor(options.challenge), password: PASSWORD });

    const again = await beginRegistration(actor);
    await expect(
      finishRegistration(actor, { attestation: attestationFor(again.challenge), password: PASSWORD })
    ).rejects.toThrow(/已绑定到当前账号/);
  });

  it("该设备已绑在别人账号上 → 拒绝（抢设备绑定）", async () => {
    makeDb();
    pushCred({
      id: "cred000009",
      userId: OTHER,
      credentialId: "c3RvYWxlbmNyZWQ",
      publicKey: "AA",
      counter: BigInt(0),
      transports: [],
      deviceName: null,
      backedUp: false
    });
    const options = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue(registrationInfo("c3RvYWxlbmNyZWQ"));
    await expect(
      finishRegistration(actor, { attestation: attestationFor(options.challenge), password: PASSWORD })
    ).rejects.toThrow(/其他账号/);
  });

  it("验签抛错 / 未通过 → 拒绝并审计，凭证不落库", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    state.verifyReg.mockRejectedValue(new Error("bad attestation"));
    await expect(
      finishRegistration(actor, { attestation: attestationFor(options.challenge), password: PASSWORD })
    ).rejects.toThrow(/注册验证失败/);

    const second = await beginRegistration(actor);
    state.verifyReg.mockResolvedValue({ verified: false });
    await expect(
      finishRegistration(actor, { attestation: attestationFor(second.challenge), password: PASSWORD })
    ).rejects.toThrow(/注册验证失败/);
    expect(db.__state.credentials).toHaveLength(0);
  });

  it("入参校验：缺密码 / 备注超长 → parseInput 拒绝", async () => {
    makeDb();
    const options = await beginRegistration(actor);
    await expect(finishRegistration(actor, { attestation: attestationFor(options.challenge) })).rejects.toBeInstanceOf(ActionError);
    await expect(
      finishRegistration(actor, {
        attestation: attestationFor(options.challenge),
        password: PASSWORD,
        deviceName: "x".repeat(41)
      })
    ).rejects.toThrow(/40 字/);
  });
});

// ============ 列表与删除 ============

describe("listCredentials / deleteCredential", () => {
  it("列表只返回本人的设备，按添加时间倒序", async () => {
    makeDb();
    pushCred(
      {
        id: "credA",
        userId: USER,
        credentialId: "YQ",
        publicKey: "AA",
        counter: BigInt(0),
        transports: ["internal"],
        deviceName: "办公台式机",
        backedUp: false
      },
      {
        id: "credB",
        userId: USER,
        credentialId: "Yg",
        publicKey: "AA",
        counter: BigInt(0),
        transports: ["hybrid"],
        deviceName: "手机",
        backedUp: true
      },
      {
        id: "credC",
        userId: OTHER,
        credentialId: "Yw",
        publicKey: "AA",
        counter: BigInt(0),
        transports: [],
        deviceName: "别人的设备",
        backedUp: false
      }
    );
    const list = await listCredentials(actor);
    expect(list.map((c) => c.id).sort()).toEqual(["credA", "credB"]);
    expect(list.find((c) => c.id === "credB")?.backedUp).toBe(true);
  });

  it("删除他人设备 → 拒绝", async () => {
    makeDb();
    pushCred({
      id: "credC",
      userId: OTHER,
      credentialId: "Yw",
      publicKey: "AA",
      counter: BigInt(0),
      transports: [],
      deviceName: null,
      backedUp: false
    });
    await expect(deleteCredential(actor, { id: "credC" })).rejects.toThrow(/不存在/);
  });

  it("正常删除 → 落库删除 + WEBAUTHN_DELETE 审计", async () => {
    makeDb();
    pushCred(
      {
        id: "credA",
        userId: USER,
        credentialId: "YQ",
        publicKey: "AA",
        counter: BigInt(0),
        transports: ["internal"],
        deviceName: "旧电脑",
        backedUp: false
      },
      {
        id: "credB",
        userId: USER,
        credentialId: "Yg",
        publicKey: "AA",
        counter: BigInt(0),
        transports: [],
        deviceName: "新电脑",
        backedUp: false
      }
    );
    await deleteCredential(actor, { id: "credA" });
    expect(db.__state.credentials.map((c) => c.id)).toEqual(["credB"]);
    const auditRow = db.__state.audits.find((a) => a.action === "WEBAUTHN_DELETE");
    expect(auditRow?.detail).toMatchObject({ deviceName: "旧电脑", remainingAfter: 1 });
  });

  it("无密码且只剩一台 → 拒绝删除（保留至少一种登录方式）", async () => {
    makeDb([{ id: USER, name: "无密码账号", email: "np@law.example.com", active: true, role: "LAWYER", passwordHash: "" }]);
    pushCred({
      id: "credA",
      userId: USER,
      credentialId: "YQ",
      publicKey: "AA",
      counter: BigInt(0),
      transports: [],
      deviceName: "唯一设备",
      backedUp: false
    });
    await expect(deleteCredential(actor, { id: "credA" })).rejects.toThrow(/唯一/);
    expect(db.__state.credentials).toHaveLength(1);
  });

  it("有密码时可删到最后（密码仍是登录方式）", async () => {
    makeDb();
    pushCred({
      id: "credA",
      userId: USER,
      credentialId: "YQ",
      publicKey: "AA",
      counter: BigInt(0),
      transports: [],
      deviceName: "唯一设备",
      backedUp: false
    });
    await deleteCredential(actor, { id: "credA" });
    expect(db.__state.credentials).toHaveLength(0);
  });
});
