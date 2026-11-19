import { describe, it, expect, beforeAll } from "vitest";
import { encryptBuffer, decryptBuffer, sha256 } from "@/lib/storage/crypto";

beforeAll(() => {
  // 测试用固定密钥（32 字节 base64）
  process.env.STORAGE_ENCRYPTION_KEY = "dGVzdC1rZXktMzItYnl0ZXMtbG9uZy1lbm91Z2gteHg=";
});

describe("crypto", () => {
  it("encryptBuffer + decryptBuffer roundtrip", () => {
    const plain = Buffer.from("LawLink 文档加密测试 🔒");
    const { ciphertext, iv, authTag } = encryptBuffer(plain);
    const restored = decryptBuffer(ciphertext, iv.toString("base64"), authTag.toString("base64"));
    expect(restored.toString()).toBe(plain.toString());
  });

  it("不同明文产生不同密文", () => {
    const a = encryptBuffer(Buffer.from("AAA"));
    const b = encryptBuffer(Buffer.from("BBB"));
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("相同明文不同 IV（随机性）", () => {
    const plain = Buffer.from("same");
    const a = encryptBuffer(plain);
    const b = encryptBuffer(plain);
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  // 2026-11-21 修复（多智能体审计 A-14）：原断言是恒真式。
  //
  //   expect(sha256(data)).toBe(sha256(data));
  //
  // 同一确定性函数、同一入参，必然相等 —— 它只证明「函数是确定性的」，
  // 不证明「算的是 SHA-256」。若实现退化成
  //   createHash("sha256").update(data.toString())
  // （Buffer 经 toString 变 UTF-8 字符串，非 UTF-8 字节会变替换字符），
  // 所有归档防篡改断言与审计链哈希断言仍是两端同源自洽、全绿，
  // 而真实防护已失效。
  //
  // 改成**已知答案向量**：固定输入 → 固定输出，实现错了必红。
  // 向量来源：`node -e 'console.log(require("crypto").createHash("sha256").update(Buffer.from("hello")).digest("hex"))'`
  // 同时也是 RFC/NIST 公开的 "hello" 摘要值，可独立核对。
  it("sha256 已知答案向量（固定输入 → 固定输出）", () => {
    expect(sha256(Buffer.from("hello"))).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
    // 空串也是公开向量，覆盖「零长度输入」边界
    expect(sha256(Buffer.from(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    expect(sha256(Buffer.from("hello"))).toHaveLength(64); // hex string
  });

  // 补一条 A-14 提到的退化场景：非 UTF-8 字节必须按字节哈希，不能走 toString()
  it("sha256 对非 UTF-8 字节按原始字节计算（防 toString 退化）", () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x01]); // 非法 UTF-8 序列
    const asBytes = sha256(raw);
    const asString = sha256(Buffer.from(raw.toString())); // 退化实现会得到这个
    expect(asBytes).not.toBe(asString);
    // 与 Node 内置算法逐字节一致
    expect(asBytes).toBe(
      require("node:crypto").createHash("sha256").update(raw).digest("hex")
    );
  });
});
