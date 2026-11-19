/**
 * OIDC 单点登录配置（台账 P2-2 的一半）。
 *
 * 为什么是环境变量而不是数据库：
 *   NextAuth 的 `providers` 数组在**模块加载时**求值（`next-auth` 在
 *   `NextAuth(authOptions)` 阶段就要拿到完整 provider 列表），此时读数据库不可能
 *   同步完成。若把配置放进 SystemSetting，登录页能显示按钮而 providers 里没有
 *   provider（或反之），出现"配置幻觉"。所以 SSO 配置只走 env，管理后台只做只读
 *   状态展示，不提供写入界面——改界面会让部署方以为改的是配置。
 *
 * 取值失败一律返回 null + console.warn，**不抛错**：SSO 是可选能力，配置写错
 * 不应该让整个应用起不来（连账号密码登录都进不去）。
 *
 * 安全边界（与 sso-signin.ts 配合）：
 *   - issuer 必须是 https；只有本机（localhost / 127.0.0.1 / [::1]）才允许 http，
 *     便于本地联调 Keycloak，生产环境写 http 会被拒绝。
 *   - issuer 参与 id_token 的 `iss` 校验（ISSUER_MISMATCH），不是装饰性字段。
 */

export interface OidcConfig {
  /** 恒为 true；null 表示未启用。保留字段便于调用方显式判断。 */
  enabled: boolean;
  /** 规范化后的 issuer（去尾斜杠），用于拼 wellKnown 与校验 id_token 的 iss */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** 登录页按钮文案 */
  displayName: string;
  /** 空格分隔的 scope，恒含 openid */
  scopes: string;
}

export const OIDC_DEFAULT_DISPLAY_NAME = "企业登录";
export const OIDC_DEFAULT_SCOPES = "openid email profile";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isTruthyFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function normalizeIssuer(raw: string): string {
  // 去尾斜杠：IdP 的 issuer 可能写成 ".../v2.0/" 或 ".../v2.0"，
  // 两者是同一 issuer，却会让字符串比较失败。
  return raw.trim().replace(/\/+$/, "");
}

/** issuer 必须是 https；仅本机允许 http（本地联调 Keycloak / Dex） */
function isAcceptableIssuer(issuer: string): boolean {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOCAL_HOSTS.has(url.hostname.toLowerCase());
  return false;
}

function normalizeScopes(raw: string | undefined): string {
  const parts = (raw ?? "")
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // 未配置 → 用完整默认集；不能只补 openid，否则 name/picture 都没了
  if (!parts.length) return OIDC_DEFAULT_SCOPES;
  const deduped: string[] = [];
  for (const scope of parts) {
    if (!deduped.includes(scope)) deduped.push(scope);
  }
  // openid 缺失时 IdP 会退化成纯 OAuth2（没有 id_token，就没有 sub / email_verified），
  // 直接补在最前面，避免部署方漏写导致整条链路静默失败。
  if (!deduped.includes("openid")) deduped.unshift("openid");
  return deduped.join(" ");
}

/**
 * 读 OIDC 配置。未启用或配置不完整返回 null（并 warn）。
 *
 * @param env 便于测试注入；默认 process.env
 */
export function readOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  if (!isTruthyFlag(env.AUTH_OIDC_ENABLED)) return null;

  const issuer = normalizeIssuer(env.AUTH_OIDC_ISSUER ?? "");
  const clientId = (env.AUTH_OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (env.AUTH_OIDC_CLIENT_SECRET ?? "").trim();

  const missing: string[] = [];
  if (!issuer) missing.push("AUTH_OIDC_ISSUER");
  if (!clientId) missing.push("AUTH_OIDC_CLIENT_ID");
  if (!clientSecret) missing.push("AUTH_OIDC_CLIENT_SECRET");
  if (missing.length) {
    console.warn(`[auth/oidc] AUTH_OIDC_ENABLED=1 但缺少 ${missing.join("、")}，单点登录未启用（账号密码登录不受影响）`);
    return null;
  }

  if (!isAcceptableIssuer(issuer)) {
    console.warn(
      `[auth/oidc] AUTH_OIDC_ISSUER 必须是 https URL（仅本机 localhost/127.0.0.1 允许 http）：收到 ${redactIssuer(issuer)}，单点登录未启用`
    );
    return null;
  }

  return {
    enabled: true,
    issuer,
    clientId,
    clientSecret,
    displayName: (env.AUTH_OIDC_DISPLAY_NAME ?? "").trim() || OIDC_DEFAULT_DISPLAY_NAME,
    scopes: normalizeScopes(env.AUTH_OIDC_SCOPES)
  };
}

/** 登录页 / 管理后台用的开关判断（不返回 secret） */
export function isOidcConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return readOidcConfig(env) !== null;
}

/** 已发现（discovery）文档地址；issuer 已去尾斜杠 */
export function oidcWellKnownUrl(config: Pick<OidcConfig, "issuer">): string {
  return `${config.issuer}/.well-known/openid-configuration`;
}

/**
 * 脱敏展示用：只回 hostname（含端口），不带租户路径与 query。
 * 管理后台状态卡与日志都用它——issuer 的路径段常含租户 ID，属半敏感信息。
 */
export function redactIssuer(issuer: string): string {
  try {
    return new URL(issuer).host;
  } catch {
    return "(invalid)";
  }
}
