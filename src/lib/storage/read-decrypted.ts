import { ActionError } from "@/lib/action-error";

import { decryptBuffer } from "./crypto";

/**
 * 安全读取（并在需要时解密）一份存储对象，把底层异常转成面向用户的 ActionError。
 *
 * 为什么需要它（2026-11-19）：
 * 存储读取的两类失败都会抛**原生 Error**，而不是 ActionError：
 *   1. 文件缺失 → `fs.readFile` 抛 ENOENT
 *   2. 解密失败（密文被篡改、密钥轮换、authTag 不匹配）→ `decipher.final()` 抛
 *      "Unsupported state or unable to authenticate data"
 *
 * 在 Next.js 生产构建下，React Flight 会把未转换的 Error 脱敏成
 * "Minified React error #441"——审批人看到的是乱码，而不是「请退回补正」。
 * 归档审批、文书渲染、模板套打都在这个路径上。
 *
 * 这里统一转义：保留可诊断的信息在日志里，给用户一句能行动的中文。
 */

export interface StoredBlobRef {
  /** 存储层相对路径 */
  path: string;
  /** 面向用户的名称（文书名/模板名），用于错误文案 */
  name: string;
  encrypted: boolean;
  iv: string | null;
  authTag: string | null;
}

export async function readDecryptedBlob(
  readFile: (path: string) => Promise<Buffer>,
  ref: StoredBlobRef
): Promise<Buffer> {
  let stored: Buffer;
  try {
    stored = await readFile(ref.path);
  } catch (err) {
    // 文件缺失与权限问题对用户是同一件事：这份材料现在拿不到
    console.error("[storage] 读取失败：", { path: ref.path, name: ref.name, err });
    throw new ActionError(`材料“${ref.name}”读取失败，文件可能已被移动或删除，请联系管理员核对存储`);
  }

  if (!ref.encrypted) return stored;

  if (!ref.iv || !ref.authTag) {
    throw new ActionError(`材料“${ref.name}”的加密元数据损坏，请联系管理员`);
  }

  try {
    return decryptBuffer(stored, ref.iv, ref.authTag);
  } catch (err) {
    // 密文被篡改 / 密钥轮换 / authTag 不匹配都落在这里
    console.error("[storage] 解密失败：", { path: ref.path, name: ref.name, err });
    throw new ActionError(
      `材料“${ref.name}”解密失败，内容可能已损坏或加密密钥已更换，请联系管理员`
    );
  }
}
