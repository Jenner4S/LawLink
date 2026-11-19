import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

import { ActionError } from "@/lib/action-error";
import { readDecryptedBlob } from "@/lib/storage/read-decrypted";
import { encryptBuffer } from "@/lib/storage/crypto";

/**
 * 存储读取的异常转义（2026-11-19）。
 *
 * 底层两类失败都抛原生 Error：文件缺失（ENOENT）、解密失败（authTag 不匹配）。
 * Next.js 生产构建下 Flight 会把它脱敏成 "Minified React error #441"，
 * 审批人看到乱码而不是「请退回补正」。本文件固化「一律转 ActionError 且文案可行动」。
 */

// 测试自包含：注入 32 字节 base64 密钥，不依赖外部 .env。
// crypto.ts 首次调用会缓存 key，故必须在任何 encrypt/decrypt 之前设置。
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const ORIGINAL_KEY = process.env.STORAGE_ENCRYPTION_KEY;
beforeAll(() => {
  process.env.STORAGE_ENCRYPTION_KEY = TEST_KEY;
});
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("readDecryptedBlob", () => {
  it("未加密对象：直接返回原文", async () => {
    const buf = Buffer.from("hello");
    const out = await readDecryptedBlob(async () => buf, {
      path: "a/b.bin", name: "材料A", encrypted: false, iv: null, authTag: null
    });
    expect(out.toString()).toBe("hello");
  });

  it("加密对象：正确解密", async () => {
    const plain = Buffer.from("机密内容");
    const sealed = encryptBuffer(plain);
    const out = await readDecryptedBlob(async () => sealed.ciphertext, {
      path: "a/c.bin", name: "材料C",
      encrypted: true, iv: sealed.iv, authTag: sealed.authTag
    });
    expect(out.toString()).toBe("机密内容");
  });

  it("文件缺失 → ActionError（不是原生 Error），文案可行动", async () => {
    const read = async () => { throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" }); };
    await expect(
      readDecryptedBlob(read, { path: "missing.bin", name: "归档材料X", encrypted: false, iv: null, authTag: null })
    ).rejects.toThrow(ActionError);
    await expect(
      readDecryptedBlob(read, { path: "missing.bin", name: "归档材料X", encrypted: false, iv: null, authTag: null })
    ).rejects.toThrow(/读取失败.*文件可能已被移动或删除/);
  });

  it("解密失败（authTag 不匹配）→ ActionError，文案指出密钥/损坏", async () => {
    const sealed = encryptBuffer(Buffer.from("原文"));
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0xff; // 篡改密文
    const read = async () => tampered;
    await expect(
      readDecryptedBlob(read, {
        path: "t.bin", name: "证据材料", encrypted: true, iv: sealed.iv, authTag: sealed.authTag
      })
    ).rejects.toThrow(ActionError);
    await expect(
      readDecryptedBlob(read, {
        path: "t.bin", name: "证据材料", encrypted: true, iv: sealed.iv, authTag: sealed.authTag
      })
    ).rejects.toThrow(/解密失败.*内容可能已损坏或加密密钥已更换/);
  });

  it("加密元数据缺失 → ActionError（不走底层解密）", async () => {
    await expect(
      readDecryptedBlob(async () => Buffer.from("x"), {
        path: "m.bin", name: "材料M", encrypted: true, iv: null, authTag: null
      })
    ).rejects.toThrow(/加密元数据损坏/);
  });

  it("抛出的始终是 ActionError —— 保证 Flight 能透出中文", async () => {
    const cases = [
      async () => { throw new Error("ENOENT"); },
      async () => Buffer.from("bad")
    ];
    for (const [i, read] of cases.entries()) {
      try {
        await readDecryptedBlob(read as () => Promise<Buffer>, {
          path: "x", name: "X", encrypted: i === 1, iv: "AAAA", authTag: "BBBB"
        });
        expect.unreachable("应当抛错");
      } catch (err) {
        expect(err).toBeInstanceOf(ActionError);
        // digest 通道：生产脱敏下客户端能看到的正是这条
        expect((err as { digest?: string }).digest).toMatch(/^ACTION_ERROR:/);
      }
    }
  });
});
