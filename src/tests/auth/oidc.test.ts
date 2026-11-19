// @vitest-environment node
/**
 * OIDC 配置读取（台账 P2-2）。
 *
 * 这层是 SSO 的"开关"：配置读错的两个方向都危险——
 *   - 该关时没关：登录页出现一个点了就报错的按钮，或者 provider 缺失导致
 *     回调地址 404；
 *   - 该开时没开：部署方以为开了 SSO，实际仍在用密码登录（安全错觉）。
 * 因此这里逐条断言"哪种输入 → 是否启用"，并确认配置错误只 warn 不抛错
 * （SSO 配置写错不能让整个应用起不来，连账号密码都进不去）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isOidcConfigured,
  oidcWellKnownUrl,
  readOidcConfig,
  redactIssuer,
  OIDC_DEFAULT_DISPLAY_NAME,
  OIDC_DEFAULT_SCOPES
} from "@/lib/auth/oidc";

/** NodeJS.ProcessEnv 在 Next 的类型增强下必带 NODE_ENV，测试里用显式断言构造最小环境 */
const mkEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  over as unknown as NodeJS.ProcessEnv;

const FULL = mkEnv({
  AUTH_OIDC_ENABLED: "1",
  AUTH_OIDC_ISSUER: "https://login.microsoftonline.com/tenant-1/v2.0",
  AUTH_OIDC_CLIENT_ID: "client-abc",
  AUTH_OIDC_CLIENT_SECRET: "secret-xyz"
});

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("readOidcConfig：启用开关", () => {
  it("未设置 AUTH_OIDC_ENABLED 时返回 null，且不吵日志", () => {
    expect(readOidcConfig(mkEnv())).toBeNull();
    expect(readOidcConfig(mkEnv({ AUTH_OIDC_ISSUER: "https://idp.example.com" }))).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("AUTH_OIDC_ENABLED=0 / false 视为关闭", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ENABLED: "0" })).toBeNull();
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ENABLED: "false" })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("AUTH_OIDC_ENABLED=1（大小写/空格容忍）开启", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ENABLED: " 1 " })).not.toBeNull();
    expect(isOidcConfigured(FULL)).toBe(true);
    expect(isOidcConfigured(mkEnv())).toBe(false);
  });
});

describe("readOidcConfig：必填项缺失 → null + warn（不抛错）", () => {
  it("缺 clientId", () => {
    const env = { ...FULL };
    delete env.AUTH_OIDC_CLIENT_ID;
    expect(readOidcConfig(env)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AUTH_OIDC_CLIENT_ID"));
  });

  it("缺 clientSecret", () => {
    const env = { ...FULL };
    delete env.AUTH_OIDC_CLIENT_SECRET;
    expect(() => readOidcConfig(env)).not.toThrow();
    expect(readOidcConfig(env)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AUTH_OIDC_CLIENT_SECRET"));
  });

  it("缺 issuer", () => {
    const env = { ...FULL };
    delete env.AUTH_OIDC_ISSUER;
    expect(readOidcConfig(env)).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("AUTH_OIDC_ISSUER"));
  });

  it("空白字符串等同缺失（避免 .env 里写了空值被当成已配置）", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_CLIENT_ID: "   " })).toBeNull();
  });
});

describe("readOidcConfig：issuer 协议校验", () => {
  it("http + 公网域名被拒绝（生产不允许明文授权端点）", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "http://idp.example.com" })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("https"));
  });

  it("http + 本机 localhost / 127.0.0.1 允许（本地联调 Keycloak）", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "http://localhost:8080/realms/lawlink" })?.issuer)
      .toBe("http://localhost:8080/realms/lawlink");
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "http://127.0.0.1:8080" })?.issuer)
      .toBe("http://127.0.0.1:8080");
  });

  it("非 URL / 非 http(s) 协议被拒绝", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "login.microsoftonline.com" })).toBeNull();
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "javascript:alert(1)" })).toBeNull();
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "ftp://idp.example.com" })).toBeNull();
  });
});

describe("readOidcConfig：完整配置解析", () => {
  it("解析 issuer / clientId / clientSecret / 缺省文案与 scope", () => {
    const config = readOidcConfig(FULL);
    expect(config).toEqual({
      enabled: true,
      issuer: "https://login.microsoftonline.com/tenant-1/v2.0",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      displayName: OIDC_DEFAULT_DISPLAY_NAME,
      scopes: OIDC_DEFAULT_SCOPES
    });
  });

  it("issuer 去尾斜杠（同一 issuer 两种写法必须等价，否则 iss 校验会误杀）", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "https://idp.example.com/oidc///" })?.issuer)
      .toBe("https://idp.example.com/oidc");
  });

  it("displayName 自定义，空白回落默认", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_DISPLAY_NAME: "  飞书统一登录 " })?.displayName).toBe("飞书统一登录");
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_DISPLAY_NAME: "   " })?.displayName).toBe(OIDC_DEFAULT_DISPLAY_NAME);
  });

  it("scopes 去重且恒含 openid（缺 openid 会退化成纯 OAuth2，没有 id_token）", () => {
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_SCOPES: "email profile email" })?.scopes)
      .toBe("openid email profile");
    expect(readOidcConfig({ ...FULL, AUTH_OIDC_SCOPES: "openid email groups" })?.scopes)
      .toBe("openid email groups");
  });

  it("wellKnown 由规范化 issuer 拼出", () => {
    const config = readOidcConfig({ ...FULL, AUTH_OIDC_ISSUER: "https://idp.example.com/" })!;
    expect(oidcWellKnownUrl(config)).toBe("https://idp.example.com/.well-known/openid-configuration");
  });

  it("redactIssuer 只回 host（issuer 路径段常含租户 ID，不进日志/界面）", () => {
    expect(redactIssuer("https://login.microsoftonline.com/tenant-secret/v2.0"))
      .toBe("login.microsoftonline.com");
    expect(redactIssuer("not a url")).toBe("(invalid)");
  });
});
