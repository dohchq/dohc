import { describe, expect, it } from "vitest";
import {
  MAX_HTTP_HEADER_SECRET_BYTES,
  MAX_HTTP_URL_SECRET_BYTES,
  normalizeSecretAllowedHost,
  validateSecretHeaderValue,
  validateSecretHttpUrl,
  WorkspaceSecretWriteInput,
} from "./workspaceSecrets";

describe("workspaceSecrets contracts", () => {
  it("normalizes and validates allowed hosts", () => {
    expect(normalizeSecretAllowedHost("API.Resend.COM")).toBe("api.resend.com");
    expect(normalizeSecretAllowedHost("  hooks.slack.com  ")).toBe("hooks.slack.com");
    for (const invalid of [
      "",
      "localhost",
      "sync-relay",
      "*.resend.com",
      "api.resend.com:443",
      "https://api.resend.com",
      "api.resend.com/emails",
      "api.resend.com.",
      "service.local",
      "metadata.google.internal",
      "home.arpa",
      "box.home.arpa",
      `${"a".repeat(64)}.example.com`,
      "127.0.0.1",
      "169.254.169.254",
      "[::1]",
      "2130706433",
    ]) {
      expect(normalizeSecretAllowedHost(invalid), invalid).toBeNull();
    }
  });

  it("validates http-url secret values", () => {
    expect(validateSecretHttpUrl("https://hooks.slack.com/services/A/B/C")?.hostname).toBe(
      "hooks.slack.com",
    );
    expect(validateSecretHttpUrl("https://api.example.com:443/hook")?.hostname).toBe(
      "api.example.com",
    );
    for (const invalid of [
      "http://hooks.slack.com/services/A/B/C",
      "https://user:pass@hooks.slack.com/hook",
      "https://hooks.slack.com:8443/hook",
      "https://hooks.slack.com/hook#frag",
      "https://hooks.slack.com/hook#",
      "https://127.0.0.1/hook",
      "https://[::1]/hook",
      "https://sync-relay/sync/hooks/token",
      "https://service.local/hook",
      "https://home.arpa/hook",
      `https://${"a".repeat(64)}.example.com/hook`,
      "https://api.example.com/hook\t1",
      "https://api.example.com/hook\n",
      `https://api.example.com/${"a".repeat(MAX_HTTP_URL_SECRET_BYTES)}`,
    ]) {
      expect(validateSecretHttpUrl(invalid), invalid).toBeNull();
    }
  });

  it("validates http-header secret values and refuses control characters", () => {
    expect(validateSecretHeaderValue("re_1234567890")).toBe(true);
    expect(validateSecretHeaderValue("Bearer tok_abc")).toBe(true);
    expect(validateSecretHeaderValue("")).toBe(false);
    expect(validateSecretHeaderValue("abc\tdef")).toBe(false);
    expect(validateSecretHeaderValue("abc\r\nX-Injected: 1")).toBe(false);
    expect(validateSecretHeaderValue("abc\0def")).toBe(false);
    expect(validateSecretHeaderValue("a".repeat(MAX_HTTP_HEADER_SECRET_BYTES + 1))).toBe(false);
  });

  it("deduplicates and sorts allowedHosts on http-header write input", () => {
    const parsed = WorkspaceSecretWriteInput.parse({
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_secret_value",
      allowedHosts: ["API.Resend.com", "b.example.com", "api.resend.com"],
    });
    expect(parsed).toEqual({
      name: "RESEND_API_KEY",
      mode: "create",
      usage: "http-header",
      value: "re_secret_value",
      allowedHosts: ["api.resend.com", "b.example.com"],
    });
  });

  it("rejects invalid names, missing mode, and missing allowedHosts for http-header", () => {
    expect(
      WorkspaceSecretWriteInput.safeParse({
        name: "lowercase_name",
        mode: "create",
        usage: "http-url",
        value: "https://hooks.slack.com/services/A/B/C",
      }).success,
    ).toBe(false);

    expect(
      WorkspaceSecretWriteInput.safeParse({
        name: "VALID_NAME",
        usage: "http-url",
        value: "https://hooks.slack.com/services/A/B/C",
      }).success,
    ).toBe(false);

    expect(
      WorkspaceSecretWriteInput.safeParse({
        name: "RESEND_API_KEY",
        mode: "create",
        usage: "http-header",
        value: "re_secret_value",
        allowedHosts: [],
      }).success,
    ).toBe(false);
  });
});
