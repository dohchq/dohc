import { describe, expect, it } from "vitest";
import { posthogProject, resolveReporting, type ReportingBuild } from "./reportingConfig";

const BUILD: ReportingBuild = {
  posthogKey: "phc_abcdefghij0123456789",
  posthogHost: "https://us.i.posthog.com",
  dist: "win-x64",
};

function resolve(overrides: Partial<Parameters<typeof resolveReporting>[0]> = {}) {
  return resolveReporting({
    build: BUILD,
    packaged: true,
    env: {},
    argv: [],
    ...overrides,
  });
}

describe("which builds report", () => {
  it("sends both kinds of report to the build's PostHog project", () => {
    const reporting = resolve();
    expect(reporting?.usage).toEqual({ url: new URL("https://us.i.posthog.com/batch/"), key: BUILD.posthogKey });
    expect(reporting?.errors).toEqual({ host: "https://us.i.posthog.com", key: BUILD.posthogKey });
    expect(reporting?.dist).toBe("win-x64");
  });

  it("keeps a host's path prefix", () => {
    const reporting = resolve({ build: { ...BUILD, posthogHost: "https://ph.example.test/ingest/" } });
    expect(reporting?.usage?.url.href).toBe("https://ph.example.test/ingest/batch/");
    expect(reporting?.errors?.host).toBe("https://ph.example.test/ingest");
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

  it("sends nothing from a build that names no usable project", () => {
    expect(resolve({ build: null })).toBeNull();
    expect(resolve({ build: { posthogKey: "", posthogHost: "", dist: "" } })).toBeNull();
    expect(resolve({ build: { ...BUILD, posthogKey: "" } })).toBeNull();
    expect(resolve({ build: { ...BUILD, posthogHost: "" } })).toBeNull();
  });

  it("falls back to this platform for a dist that is not a plain name", () => {
    expect(resolve({ build: { ...BUILD, dist: "../x y" } })?.dist).toBe(`${process.platform}-${process.arch}`);
  });
});

describe("project settings", () => {
  it("accepts only https hosts and project keys", () => {
    expect(posthogProject(" phc_abcdefghij0123 ", "https://eu.i.posthog.com/")?.key).toBe("phc_abcdefghij0123");
    expect(posthogProject("phc_abcdefghij0123", "http://us.i.posthog.com")).toBeNull();
    expect(posthogProject("phc_abcdefghij0123", "https://user:pass@us.i.posthog.com")).toBeNull();
    expect(posthogProject("phc_abcdefghij0123", "https://us.i.posthog.com/?x=1")).toBeNull();
    expect(posthogProject("phc_abcdefghij0123", "not a host")).toBeNull();
    expect(posthogProject("phx_personal_key_0123", "https://us.i.posthog.com")).toBeNull();
  });
});
