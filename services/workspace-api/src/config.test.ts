import { describe, expect, it } from "vitest";
import { ConfigError, readConfig } from "./config";

const SECRET = "0123456789abcdef0123456789abcdef";

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", BETTER_AUTH_SECRET: SECRET, ...overrides } as NodeJS.ProcessEnv;
}

describe("readConfig", () => {
  it("reads a self-host configuration", () => {
    const config = readConfig(
      env({
        WORKSPACE_API_PORT: "4400",
        WORKSPACE_API_BASE_URL: "https://auth.example.com",
        DOHC_SERVER_RELAY_URL: "https://auth.example.com",
        DOHC_WEB_ORIGIN: "https://auth.example.com",
        DOHC_SMTP_HOST: "smtp.example.com",
        DOHC_SMTP_PORT: "587",
        DOHC_SMTP_SECURE: "false",
        DOHC_SMTP_FROM: "dohc <noreply@example.com>",
      }),
    );
    expect(config.port).toBe(4400);
    expect(config.bindHost).toBe("0.0.0.0");
    expect(config.descriptor).toEqual({
      authUrl: "https://auth.example.com",
      relayUrl: "https://auth.example.com",
      shareUrl: "https://auth.example.com",
    });
    expect(config.emailTransport).toBe("smtp");
    expect(config.smtp?.port).toBe(587);
    expect(config.trustedOrigins).toEqual(["https://auth.example.com"]);
    expect(config.allowedOrigins).toEqual([
      "https://auth.example.com",
    ]);
  });

  it("requires one HTTPS public origin and validates descriptor metadata", () => {
    const publicOrigin = "https://server.example.test";
    expect(() => readConfig(env({ WORKSPACE_API_BASE_URL: publicOrigin, DOHC_WEB_ORIGIN: "https://other.example.test" }))).toThrow(/one public origin/);
    expect(() => readConfig(env({ WORKSPACE_API_BASE_URL: "http://server.example.test" }))).toThrow(/HTTPS/);
    expect(() => readConfig(env({ DOHC_SERVER_NETWORK_ACCESS: "auto" }))).toThrow(/private or public/);
    const config = readConfig(env({ WORKSPACE_API_BASE_URL: publicOrigin, DOHC_SERVER_NAME: "Team server", DOHC_SERVER_NETWORK_ACCESS: "private" }));
    expect(config.descriptor).toMatchObject({ name: "Team server", networkAccess: "private" });
  });

  it.each(["Team\tserver", "Team\u0000server", "Team\u001fserver", "Team\u007fserver", "Team\nserver"])("rejects server-name control characters %j", (name) => {
    expect(() => readConfig(env({ DOHC_SERVER_NAME: name }))).toThrow(/without control characters/);
  });

  it("refuses to start without a secret", () => {
    expect(() => readConfig(env({ BETTER_AUTH_SECRET: "short" }))).toThrow(ConfigError);
  });

  it("refuses the impersonation seam outside development and test", () => {
    expect(() => readConfig(env({ DOHC_TEST_AUTH: "1" }))).toThrow(/NODE_ENV=development or test/);
  });

  it("binds loopback while a seam is on", () => {
    const config = readConfig(env({ NODE_ENV: "development", DOHC_TEST_AUTH: "1" }));
    expect(config.testAuthSeam).toBe(true);
    expect(config.bindHost).toBe("127.0.0.1");
  });

  it("has no email transport in production without SMTP", () => {
    expect(readConfig(env()).emailTransport).toBe("none");
  });

  it("captures email in memory only under NODE_ENV=test", () => {
    const config = readConfig(env({ NODE_ENV: "test" }));
    expect(config.emailTransport).toBe("capture");
    expect(config.bindHost).toBe("127.0.0.1");
  });

  it("rejects an origin that is not an absolute http(s) origin", () => {
    expect(() => readConfig(env({ DOHC_WEB_ORIGIN: "share.example.com" }))).toThrow(ConfigError);
    expect(() => readConfig(env({ DOHC_WEB_ORIGIN: "https://auth.example.com/app" }))).toThrow(
      /no path or credentials/,
    );
    expect(() => readConfig(env({ DOHC_SERVER_RELAY_URL: "ws://relay.example.com" }))).toThrow(
      /http or https/,
    );
  });

  it("rejects a port outside the valid range", () => {
    expect(() => readConfig(env({ WORKSPACE_API_PORT: "70000" }))).toThrow(ConfigError);
  });

  it("trusts a forwarded address only from the proxies the operator named", () => {
    expect(readConfig(env()).trustedProxies.size).toBe(0);
    expect([
      ...readConfig(env({ DOHC_AUTH_TRUSTED_PROXIES: "10.0.0.4, 10.0.0.5" })).trustedProxies,
    ]).toEqual(["10.0.0.4", "10.0.0.5"]);
    expect(() => readConfig(env({ DOHC_AUTH_TRUSTED_PROXIES: "proxy.internal" }))).toThrow(
      ConfigError,
    );
  });

  it("reports a partly configured SMTP server as a configuration error", () => {
    expect(() => readConfig(env({ DOHC_SMTP_HOST: "smtp.example.com" }))).toThrow(ConfigError);
  });
});
