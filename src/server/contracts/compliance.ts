/**
 * 合同确认留痕的合规文案（唯一来源）。
 *
 * 单独成文件的原因：公开页（Server Component）与律师侧面板（Client Component）
 * 都要原样展示这段文字，而 service.ts 依赖 Prisma，不能被打进客户端包。
 *
 * 原文不得改写：这是对外交付时的功能边界声明——本功能不构成电子签名。
 */
export const CONTRACT_CONFIRMATION_DISCLAIMER =
  "本页面用于记录您对合同内容的阅知与确认，不构成《中华人民共和国电子签名法》意义上的电子签名，不能替代签字或盖章。正式签署请按双方约定另行办理。";
