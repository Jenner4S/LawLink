// @vitest-environment node
/**
 * 合同确认留痕（P1-4 降级实现）—— 服务层与律师侧动作。
 *
 * 重点覆盖：
 * - 创建：contentHash 与正文一致、token 明文不落库；
 * - 公开访问：不存在 / 过期 / 已确认 / 已撤销 / 哈希被改 / 正常待确认；
 * - 确认：IP/UA 记录、幂等（第二次不重复写审计）、并发落败按已确认返回、哈希复核失败拒绝；
 * - 撤销：需理由、已确认拒绝撤销；
 * - 限流：同 IP 60 秒 20 次。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { db, session, auditTxMock } = vi.hoisted(() => {
  const db: Record<string, any> = {
    contractConfirmation: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn()
    },
    client: { findUnique: vi.fn() },
    engagement: { findUnique: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn()
  };
  return {
    db,
    session: {
      user: {
        id: "clawyer0000000000000000001",
        role: "LAWYER",
        rolePermissions: undefined,
        managerAuthorized: false
      }
    },
    auditTxMock: vi.fn()
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => session) }));
vi.mock("@/server/audit", () => ({ audit: vi.fn(), auditTx: auditTxMock, auditStrict: vi.fn() }));
vi.mock("@/lib/permissions", () => ({
  assertCanHandleMatter: vi.fn(async () => undefined),
  assertCanReadMatter: vi.fn(async () => undefined)
}));

import {
  CONTRACT_CONFIRMATION_DISCLAIMER,
  CONFIRMED_REVOKE_MESSAGE,
  checkPublicRateLimit,
  confirmByToken,
  hashContentSnapshot,
  loadPublicConfirmation,
  resetPublicRateLimits,
  sha256Hex
} from "@/server/contracts/service";
import {
  createContractConfirmation,
  listContractConfirmations,
  revokeContractConfirmation
} from "@/server/contracts/actions";
import { assertCanHandleMatter } from "@/lib/permissions";

const CLIENT_ID = "cclient000000000000000001";
const MATTER_ID = "cmatter00000000000000000001";
const CONFIRMATION_ID = "cconfirm0000000000000000001";
const TOKEN = "A".repeat(43);
const SNAPSHOT = "委托代理合同\n第一条 委托事项：甲方委托乙方代理本案一审程序。\n第二条 费用：人民币 100,000 元。";
const HASH = sha256Hex(SNAPSHOT);

function pendingRow(overrides: Record<string, any> = {}) {
  return {
    id: CONFIRMATION_ID,
    clientId: CLIENT_ID,
    status: "PENDING",
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    contentSnapshot: SNAPSHOT,
    contentHash: HASH,
    confirmedAt: null,
    confirmerName: null,
    revokedAt: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPublicRateLimits();
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  db.contractConfirmation.updateMany.mockResolvedValue({ count: 1 });
  db.contractConfirmation.create.mockResolvedValue({ id: CONFIRMATION_ID });
});

describe("创建确认留痕", () => {
  it("contentHash 与正文一致，token 明文不落库，写 CONTRACT_CREATE 审计", async () => {
    db.client.findUnique.mockResolvedValue({ id: CLIENT_ID, name: "客户甲", deletedAt: null });

    const res = await createContractConfirmation({
      clientId: CLIENT_ID,
      contentSnapshot: SNAPSHOT,
      expiresInDays: 7
    });

    const stored = db.contractConfirmation.create.mock.calls[0][0].data;
    expect(stored.contentSnapshot).toBe(SNAPSHOT);
    expect(stored.contentHash).toBe(hashContentSnapshot(SNAPSHOT));
    expect(stored.contentHash).toHaveLength(64);

    // token 明文只出现在返回的链接里；库中只有 SHA-256
    expect(res.url).toBe(`/confirm/${res.url.split("/confirm/")[1]}`);
    const token = res.url.split("/confirm/")[1];
    expect(token).toHaveLength(43);
    expect(stored.tokenHash).toBe(sha256Hex(token));
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);

    expect(auditTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "CONTRACT_CREATE",
        targetType: "ContractConfirmation",
        targetId: CONFIRMATION_ID,
        detail: expect.objectContaining({ contentHash: hashContentSnapshot(SNAPSHOT) })
      })
    );
  });

  it("客户不存在或已停用时拒绝", async () => {
    db.client.findUnique.mockResolvedValue(null);
    await expect(
      createContractConfirmation({ clientId: CLIENT_ID, contentSnapshot: SNAPSHOT })
    ).rejects.toThrow("客户不存在或已停用");

    db.client.findUnique.mockResolvedValue({ id: CLIENT_ID, deletedAt: new Date() });
    await expect(
      createContractConfirmation({ clientId: CLIENT_ID, contentSnapshot: SNAPSHOT })
    ).rejects.toThrow("客户不存在或已停用");
    expect(db.contractConfirmation.create).not.toHaveBeenCalled();
  });

  it("有效期超出 1–30 天由 parseInput 拒绝（中文提示）", async () => {
    db.client.findUnique.mockResolvedValue({ id: CLIENT_ID, deletedAt: null });
    await expect(
      createContractConfirmation({ clientId: CLIENT_ID, contentSnapshot: SNAPSHOT, expiresInDays: 45 })
    ).rejects.toThrow("有效期最多 30 天");
  });

  it("挂案件时逐案经办断言：非经办律师被拒且不写库", async () => {
    db.client.findUnique.mockResolvedValue({ id: CLIENT_ID, deletedAt: null });
    vi.mocked(assertCanHandleMatter).mockRejectedValueOnce(new Error("案件不存在或无权关联"));

    await expect(
      createContractConfirmation({ clientId: CLIENT_ID, matterId: MATTER_ID, contentSnapshot: SNAPSHOT })
    ).rejects.toThrow("案件不存在或无权关联");
    expect(db.contractConfirmation.create).not.toHaveBeenCalled();
  });

  it("列表只返回展示字段，不返回 tokenHash 与正文全文", async () => {
    db.contractConfirmation.findMany.mockResolvedValue([
      {
        ...pendingRow(),
        createdAt: new Date(),
        confirmedIp: null,
        confirmedUa: null,
        revokedReason: null,
        engagement: { id: "cengage0000000000000000001", title: "委托一" },
        createdBy: { name: "律师甲" }
      }
    ]);

    const rows = await listContractConfirmationRows();
    expect(rows[0]).not.toHaveProperty("tokenHash");
    expect(rows[0]).not.toHaveProperty("contentSnapshot");
    expect(rows[0].contentLength).toBe(SNAPSHOT.length);
    expect(rows[0].contentHash).toBe(HASH);
  });
});

async function listContractConfirmationRows() {
  return listContractConfirmations({ clientId: CLIENT_ID });
}

describe("公开访问（token 校验）", () => {
  it("形状不合法的 token 直接判无效，不查库（防枚举放大）", async () => {
    const res = await loadPublicConfirmation("not-a-token");
    expect(res).toEqual({ kind: "invalid" });
    expect(db.contractConfirmation.findUnique).not.toHaveBeenCalled();
  });

  it("哈希不存在 → invalid", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(null);
    expect(await loadPublicConfirmation(TOKEN)).toEqual({ kind: "invalid" });
    expect(db.contractConfirmation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256Hex(TOKEN) } })
    );
  });

  it("已过期 → expired（不返回正文）", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ expiresAt: new Date(Date.now() - 1000) })
    );
    const res = await loadPublicConfirmation(TOKEN);
    expect(res.kind).toBe("expired");
    expect(res).not.toHaveProperty("content");
  });

  it("已确认 → confirmed（只给确认时间与姓名）", async () => {
    const at = new Date("2026-11-19T02:00:00Z");
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ status: "CONFIRMED", confirmedAt: at, confirmerName: "张三" })
    );
    const res = await loadPublicConfirmation(TOKEN);
    expect(res).toEqual({ kind: "confirmed", confirmedAt: at, confirmerName: "张三" });
  });

  it("已撤销 → revoked", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ status: "REVOKED", revokedAt: new Date("2026-11-18T00:00:00Z") })
    );
    expect((await loadPublicConfirmation(TOKEN)).kind).toBe("revoked");
  });

  it("库中快照被改过（哈希对不上）→ tampered，不展示正文", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ contentSnapshot: `${SNAPSHOT}\n第三条 甲方同意额外支付 50,000 元。` })
    );
    const res = await loadPublicConfirmation(TOKEN);
    expect(res.kind).toBe("tampered");
    expect(res).not.toHaveProperty("content");
  });

  it("待确认 → 返回正文与有效期", async () => {
    const row = pendingRow();
    db.contractConfirmation.findUnique.mockResolvedValue(row);
    const res = await loadPublicConfirmation(TOKEN);
    expect(res).toEqual({ kind: "pending", content: SNAPSHOT, expiresAt: row.expiresAt });
  });
});

describe("客户确认", () => {
  it("记录服务端时间、IP、UA，写 CONTRACT_CONFIRM 审计（含 contentHash）", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(pendingRow());
    const now = new Date("2026-11-19T03:04:05Z");

    const res = await confirmByToken({
      token: TOKEN,
      confirmerName: "张三",
      ip: "203.0.113.7",
      ua: "Mozilla/5.0 Test",
      now
    });

    expect(res).toEqual({ kind: "confirmed", confirmedAt: now, already: false });
    expect(db.contractConfirmation.updateMany).toHaveBeenCalledWith({
      where: { id: CONFIRMATION_ID, status: "PENDING", expiresAt: { gt: now } },
      data: {
        status: "CONFIRMED",
        confirmedAt: now,
        confirmedIp: "203.0.113.7",
        confirmedUa: "Mozilla/5.0 Test",
        confirmerName: "张三"
      }
    });
    expect(auditTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "CONTRACT_CONFIRM",
        targetType: "ContractConfirmation",
        targetId: CONFIRMATION_ID,
        detail: expect.objectContaining({ contentHash: HASH, clientId: CLIENT_ID }),
        ip: "203.0.113.7"
      })
    );
  });

  it("UA 截断到 500 字", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(pendingRow());
    await confirmByToken({ token: TOKEN, ip: "1.2.3.4", ua: "u".repeat(900) });
    expect(db.contractConfirmation.updateMany.mock.calls[0][0].data.confirmedUa).toHaveLength(500);
  });

  it("幂等：已 CONFIRMED 再次提交不更新、不重复写审计", async () => {
    const at = new Date("2026-11-18T00:00:00Z");
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ status: "CONFIRMED", confirmedAt: at })
    );

    const res = await confirmByToken({ token: TOKEN, ip: "1.2.3.4", ua: "ua" });
    expect(res).toEqual({ kind: "confirmed", confirmedAt: at, already: true });
    expect(db.contractConfirmation.updateMany).not.toHaveBeenCalled();
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it("并发落败（updateMany count=0）回读已确认，同样不重复写审计", async () => {
    db.contractConfirmation.findUnique
      .mockResolvedValueOnce(pendingRow())
      .mockResolvedValueOnce({ status: "CONFIRMED", confirmedAt: new Date("2026-11-19T01:00:00Z") });
    db.contractConfirmation.updateMany.mockResolvedValue({ count: 0 });

    const res = await confirmByToken({ token: TOKEN, ip: "1.2.3.4", ua: "ua" });
    expect(res.kind).toBe("confirmed");
    expect(res).toMatchObject({ already: true });
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it("哈希复核失败 → tampered，不写状态、不写审计", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ contentSnapshot: `${SNAPSHOT}（被篡改）` })
    );
    const res = await confirmByToken({ token: TOKEN, ip: "1.2.3.4", ua: "ua" });
    expect(res.kind).toBe("tampered");
    expect(db.contractConfirmation.updateMany).not.toHaveBeenCalled();
    expect(auditTxMock).not.toHaveBeenCalled();
  });

  it("已过期/已撤销 → 拒绝确认", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue(
      pendingRow({ expiresAt: new Date(Date.now() - 1000) })
    );
    expect((await confirmByToken({ token: TOKEN, ip: "1.2.3.4", ua: "ua" })).kind).toBe("expired");

    db.contractConfirmation.findUnique.mockResolvedValue(pendingRow({ status: "REVOKED" }));
    expect((await confirmByToken({ token: TOKEN, ip: "1.2.3.4", ua: "ua" })).kind).toBe("revoked");
    expect(db.contractConfirmation.updateMany).not.toHaveBeenCalled();
  });
});

describe("撤销", () => {
  it("待确认记录可撤销，必须带理由并写 CONTRACT_REVOKE 审计", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue({
      id: CONFIRMATION_ID,
      status: "PENDING",
      clientId: CLIENT_ID,
      matterId: null
    });

    const res = await revokeContractConfirmation({ id: CONFIRMATION_ID, reason: "条款需重新协商" });
    expect(res).toEqual({ ok: true });
    expect(db.contractConfirmation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONFIRMATION_ID, status: { in: ["PENDING", "EXPIRED"] } },
        data: expect.objectContaining({ status: "REVOKED", revokedReason: "条款需重新协商" })
      })
    );
    expect(auditTxMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "CONTRACT_REVOKE",
        targetId: CONFIRMATION_ID,
        detail: expect.objectContaining({ reason: "条款需重新协商" })
      })
    );
  });

  it("撤销理由为空被 parseInput 拒绝", async () => {
    await expect(revokeContractConfirmation({ id: CONFIRMATION_ID, reason: " " })).rejects.toThrow(
      "请填写撤销理由"
    );
    expect(db.contractConfirmation.updateMany).not.toHaveBeenCalled();
  });

  it("已确认的记录拒绝撤销（证据链不可抹除），不改状态不写审计", async () => {
    db.contractConfirmation.findUnique.mockResolvedValue({
      id: CONFIRMATION_ID,
      status: "CONFIRMED",
      clientId: CLIENT_ID,
      matterId: null
    });

    await expect(
      revokeContractConfirmation({ id: CONFIRMATION_ID, reason: "客户说没看过" })
    ).rejects.toThrow(CONFIRMED_REVOKE_MESSAGE);
    expect(db.contractConfirmation.updateMany).not.toHaveBeenCalled();
    expect(auditTxMock).not.toHaveBeenCalled();
  });
});

describe("公开访问限流", () => {
  it("同 IP 60 秒内第 21 次被拒；不同 IP 不受影响；重置后恢复", () => {
    for (let i = 0; i < 20; i++) {
      expect(checkPublicRateLimit("198.51.100.1", 1_000_000)).toBe(true);
    }
    expect(checkPublicRateLimit("198.51.100.1", 1_000_001)).toBe(false);
    expect(checkPublicRateLimit("198.51.100.2", 1_000_001)).toBe(true);
    // 窗口滑动后恢复
    expect(checkPublicRateLimit("198.51.100.1", 1_000_000 + 60_001)).toBe(true);
    resetPublicRateLimits();
    expect(checkPublicRateLimit("198.51.100.1", 1_000_002)).toBe(true);
  });
});

describe("合规文案", () => {
  it("声明原文包含法条口径与「不能替代签字或盖章」", () => {
    expect(CONTRACT_CONFIRMATION_DISCLAIMER).toContain("不构成《中华人民共和国电子签名法》意义上的电子签名");
    expect(CONTRACT_CONFIRMATION_DISCLAIMER).toContain("不能替代签字或盖章");
    expect(CONTRACT_CONFIRMATION_DISCLAIMER).toContain("正式签署请按双方约定另行办理");
  });
});
