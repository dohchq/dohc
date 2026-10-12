import { describe, expect, it } from "vitest";
import { errorService, resolveReporting, usageService, type ReportingBuild } from "./reportingConfig";

const BUILD: ReportingBuild = {
  posthogKey: "phc_abcdefghij0123456789",
  posthogHost: "https://us.i.posthog.com",
  sentryDsn: "https://abcdef0123456789abcdef0123456789@o1.ingest.us.sentry.io/4501",
  dist: "win-x64",
};

function resolve(overrides: Partial<Parameters<typeof resolveReporting>[0]> = {}) {
  return resolveReporting({
    build: BUILD,
    packaged: true,
    env: {},
    argv: [],
    version: "1.2.3",
    channel: "latest",
    ...overrides,
  });
}

describe("which builds report", () => {
  it("names both services for a configured packaged build", () => {
    const reporting = resolve();
    expect(reporting?.usage?.url.href).toBe("https://us.i.posthog.com/batch/");
    expect(reporting?.errors?.url.href).toBe("https://o1.ingest.us.sentry.io/api/4501/envelope/");
    expect(reporting?.errors?.publicKey).toBe("abcdef0123456789abcdef0123456789");
    expect(reporting).toMatchObject({ release: "dohc-desktop@1.2.3", dist: "win-x64", environment: "latest" });
  });

  it("sends nothing from a development build, a test run, or an isolated test launch", () => {
    expect(resolve({ packaged: false })).toBeNull();
    expect(resolve({ env: { DOHC_DESKTOP_TEST: "1" } })).toBeNull();
    expect(resolve({ argv: ["dohc", "--dohc-isolated-test"] })).toBeNull();
  });

  it("sends nothing when the environment turns reports off", () => {
    for (const value of ["0", "off", "OFF", "false", "no"]) {
      expect(resolve({ env: { DOHC_TELEMETRY: value } }), value).toBeNull();
    }
    expect(resolve({ env: { DO_NOT_TRACK: "1" } })).toBeNull();
    expect(resolve({ env: { DOHC_TELEMETRY: "on", DO_NOT_TRACK: "0" } })).not.toBeNull();
  });

  it("sends nothing from a build that names no service, and names only what is valid", () => {
    expect(resolve({ build: null })).toBeNull();
    expect(resolve({ build: { posthogKey: "", posthogHost: "", sentryDsn: "", dist: "" } })).toBeNull();
    expect(resolve({ build: { ...BUILD, sentryDsn: "" } })?.errors).toBeNull();
    expect(resolve({ build: { ...BUILD, posthogKey: "" } })?.usage).toBeNull();
  });

  it("falls back to this platform for a dist that is not a plain name", () => {
    expect(resolve({ build: { ...BUILD, dist: "../x y" } })?.dist).toBe(`${process.platform}-${process.arch}`);
  });
});

describe("service addresses", () => {
  it("accepts only https PostHog hosts and project keys", () => {
    expect(usageService("phc_abcdefghij0123", "https://eu.i.posthog.com/")?.url.href).toBe("https://eu.i.posthog.com/batch/");
    expect(usageService("phc_abcdefghij0123", "https://ph.example.test/ingest")?.url.href).toBe("https://ph.example.test/ingest/batch/");
    expect(usageService("phc_abcdefghij0123", "http://us.i.posthog.com")).toBeNull();
    expect(usageService("phc_abcdefghij0123", "https://user:pass@us.i.posthog.com")).toBeNull();
    expect(usageService("phx_personal_key_0123", "https://us.i.posthog.com")).toBeNull();
  });

  it("builds the envelope endpoint from a DSN, keeping a path prefix", () => {
    expect(errorService("https://abcdef0123456789@sentry.example.test/prefix/7")?.url.href)
      .toBe("https://sentry.example.test/prefix/api/7/envelope/");
    expect(errorService("http://abcdef0123456789@sentry.example.test/7")).toBeNull();
    expect(errorService("https://sentry.example.test/7")).toBeNull();
    expect(errorService("https://abcdef0123456789@sentry.example.test/project")).toBeNull();
    expect(errorService("not a dsn")).toBeNull();
  });
});
