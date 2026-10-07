import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EngineDaemonUnavailableError } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeLocations } from "../crashReports/crashReport";
import type { Reporting } from "./reportingConfig";
import { CHANNELS } from "../ipc/channels";
import { createTelemetry, privacyInEffect, rateLimitMs, REPORT_LIMITS, usageEventFor } from "./telemetry";

const INSTALL = resolve("dohc-install", "Programs", "dohc");
const BUNDLE = join(INSTALL, "resources", "app.asar", "dist", "main", "App-Ab12.js");
const SECRET = "Secret Trip Plans";
const REPORTING: Reporting = {
  usage: { url: new URL("https://ph.example.test/batch/"), key: "phc_abcdefghij0123" },
  errors: { url: new URL("https://sentry.example.test/api/42/envelope/"), publicKey: "abcdef0123456789abcdef0123456789" },
  release: "dohc-desktop@1.2.3",
  dist: "win-x64",
  environment: "latest",
};
const ON = { usageReports: true, errorReports: true };
const OFF = { usageReports: false, errorReports: false };

interface Call { url: string; init: RequestInit }

let dir: string;
let calls: Call[];
let nowMs: number;
let respond: (call: Call) => Promise<Response>;

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "dohc-reports-"));
  calls = [];
  nowMs = Date.UTC(2026, 9, 7);
  respond = async () => new Response(null, { status: 200 });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const FACTS = () => ({
  atMs: nowMs, version: "1.2.3", channel: "latest", os: "Windows_NT", osVersion: "10.0.22631",
  arch: "x64", electron: "43.3.0",
});

function telemetry(
  reporting: Reporting | null = REPORTING,
  overrides: Partial<Pick<Parameters<typeof createTelemetry>[0], "facts" | "locate">> = {},
) {
  return createTelemetry({
    reporting,
    statePath: join(dir, "reporting.json"),
    facts: FACTS,
    locate: createCodeLocations([INSTALL], process.platform),
    ...overrides,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return await respond(call);
    }) as typeof fetch,
    now: () => nowMs,
  });
}

// A telemetry whose person already saw the notice on an earlier launch.
function shown(reporting: Reporting | null = REPORTING, overrides: Parameters<typeof telemetry>[1] = {}) {
  writeFileSync(join(dir, "reporting.json"), JSON.stringify({ installId: "6f1c1c55-6a52-4a40-8d38-1b2d2e1c1f10" }));
  return telemetry(reporting, overrides);
}

const usageCalls = () => calls.filter((call) => call.url.startsWith("https://ph.example.test/"));
const errorCalls = () => calls.filter((call) => call.url.startsWith("https://sentry.example.test/"));
const envelopeEvent = (call: Call) => JSON.parse(String(call.init.body).split("\n")[2]!) as Record<string, unknown>;

function privateError(): Error {
  const cause = Object.assign(new Error(`could not read C:\\Users\\sam\\${SECRET}.md`), { code: "ENOENT", path: SECRET });
  const error = new TypeError(`${SECRET} failed`, { cause });
  error.stack = [
    `TypeError: ${SECRET} failed`,
    `    at readPlan (${BUNDLE}:10:20)`,
    `    at C:\\Users\\sam\\${SECRET}\\plugin.js:1:1`,
    `    at node:internal/process/task_queues:95:5`,
    `    at open (${BUNDLE}:3:4)`,
  ].join("\n");
  return error;
}

describe("reports wait for the notice and the switches", () => {
  it("sends nothing until a window showed the notice, then sends what waited", async () => {
    const reports = telemetry();
    reports.track({ name: "app_launched" });
    reports.setPrivacy(ON);
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs * 2);
    expect(calls).toEqual([]);

    // Asking changes nothing: a window may close before it shows the notice.
    expect(reports.noticeDue(ON)).toEqual({ usage: true, errors: true });
    expect(reports.noticeDue(ON)).toEqual({ usage: true, errors: true });
    expect(existsSync(join(dir, "reporting.json"))).toBe(false);
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs * 2);
    expect(calls).toEqual([]);

    reports.acknowledgeNotice();
    expect(existsSync(join(dir, "reporting.json"))).toBe(true);
    expect(reports.noticeDue(ON)).toEqual({ usage: false, errors: false });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
    expect(usageCalls()).toHaveLength(1);
    const body = JSON.parse(String(usageCalls()[0]!.init.body)) as {
      api_key: string;
      batch: Array<{ event: string; distinct_id: string; properties: Record<string, unknown> }>;
    };
    expect(body.api_key).toBe("phc_abcdefghij0123");
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]!.event).toBe("app_launched");
    expect(body.batch[0]!.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.batch[0]!.properties).toEqual({
      $process_person_profile: false, $geoip_disable: true, $lib: "dohc-desktop",
      app_version: "1.2.3", channel: "latest", os: "Windows_NT", arch: "x64",
    });
  });

  it("sends nothing before main reads the switches", async () => {
    const reports = shown();
    reports.track({ name: "app_launched" });
    reports.reportError({ kind: "crash", event: { kind: "main-exception", error: new Error("x"), origin: "uncaughtException" } });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs * 2);
    expect(calls).toEqual([]);
    reports.setPrivacy(ON);
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
    expect(usageCalls()).toHaveLength(1);
    expect(errorCalls()).toHaveLength(1);
  });

  it("drops what waited when the saved switches are off at startup", async () => {
    const reports = shown();
    reports.track({ name: "app_launched" });
    reports.reportError({ kind: "crash", event: { kind: "main-exception", error: new Error("x"), origin: "uncaughtException" } });
    reports.setPrivacy(OFF);
    reports.track({ name: "workspace_opened" });
    await reports.flush();
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs * 2);
    expect(calls).toEqual([]);
  });

  it("keeps the notice due on the next launch when no window showed it", async () => {
    const first = telemetry();
    first.setPrivacy(ON);
    expect(first.noticeDue(ON)).toEqual({ usage: true, errors: true });
    first.track({ name: "app_launched" });
    await first.flush();

    const next = telemetry();
    next.setPrivacy(ON);
    expect(next.noticeDue(ON)).toEqual({ usage: true, errors: true });
    await next.flush();
    expect(calls).toEqual([]);
  });

  it("names no report while both switches are off, and the ones turned on later", async () => {
    const reports = telemetry();
    reports.setPrivacy(OFF);
    expect(reports.noticeDue(OFF)).toEqual({ usage: false, errors: false });
    expect(existsSync(join(dir, "reporting.json"))).toBe(false);

    const errorsOnly = { usageReports: false, errorReports: true };
    reports.setPrivacy(errorsOnly);
    expect(reports.noticeDue(errorsOnly)).toEqual({ usage: false, errors: true });
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: "" } });
    await reports.flush();
    expect(calls).toEqual([]);
    reports.acknowledgeNotice();
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs);
    expect(errorCalls()).toHaveLength(1);
  });

  it("names only the reports this launch can send", () => {
    expect(telemetry({ ...REPORTING, usage: null }).noticeDue(ON)).toEqual({ usage: false, errors: true });
    expect(telemetry({ ...REPORTING, errors: null }).noticeDue(ON)).toEqual({ usage: true, errors: false });
    expect(telemetry({ ...REPORTING, usage: null }).available).toEqual({ usage: false, errors: true });
    expect(telemetry({ ...REPORTING, errors: null }).available).toEqual({ usage: true, errors: false });
    expect(telemetry(REPORTING).available).toEqual({ usage: true, errors: true });
  });

  it("keeps the two switches independent", async () => {
    const reports = shown();
    reports.setPrivacy({ usageReports: false, errorReports: true });
    reports.track({ name: "chat_message_sent" });
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `at x (${BUNDLE}:1:2)` } });
    await reports.flush();
    expect(usageCalls()).toHaveLength(0);
    expect(errorCalls()).toHaveLength(1);

    calls.length = 0;
    reports.setPrivacy({ usageReports: true, errorReports: false });
    reports.track({ name: "chat_message_sent" });
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "RangeError", stack: "" } });
    await reports.flush();
    expect(usageCalls()).toHaveLength(1);
    expect(errorCalls()).toHaveLength(0);
  });

  it("stops a send under way and drops the queue when a switch turns off", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    let aborted = false;
    respond = (call) => new Promise((_resolve, reject) => {
      call.init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
    for (let index = 0; index < REPORT_LIMITS.usageBatch + 5; index += 1) reports.track({ name: "workspace_opened" });
    expect(usageCalls()).toHaveLength(1);
    reports.setPrivacy({ usageReports: false, errorReports: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toBe(true);
    respond = async () => new Response(null, { status: 200 });
    reports.track({ name: "workspace_opened" });
    await reports.flush();
    expect(usageCalls()).toHaveLength(1);
  });

  it("sends nothing from a build that names no service", async () => {
    const reports = telemetry(null);
    reports.setPrivacy(ON);
    expect(reports.available).toEqual({ usage: false, errors: false });
    expect(reports.noticeDue(ON)).toEqual({ usage: false, errors: false });
    reports.acknowledgeNotice();
    reports.track({ name: "app_launched" });
    reports.reportError({ kind: "renderer", origin: "boundary", error: { type: "string" } });
    await reports.flush();
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "reporting.json"))).toBe(false);
  });
});

describe("what an error report holds", () => {
  it("leaves out messages, private paths, and frames outside dohc", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError({ kind: "crash", event: { kind: "main-exception", error: privateError(), origin: "uncaughtException" } });
    reports.reportError({
      kind: "renderer", origin: "boundary",
      error: { name: `${SECRET}Error`, stack: `at x (C:\\Users\\sam\\${SECRET}.js:1:1)\n    at y (${BUNDLE}:5:6)` },
    });
    await reports.flush();
    expect(errorCalls()).toHaveLength(2);
    for (const call of errorCalls()) {
      const body = String(call.init.body);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain("sam");
      expect(body).not.toMatch(/Users/i);
      expect(new Headers(call.init.headers).get("x-sentry-auth"))
        .toBe("Sentry sentry_version=7, sentry_key=abcdef0123456789abcdef0123456789, sentry_client=dohc-desktop/1");
      expect(call.init.redirect).toBe("error");
    }
    const event = envelopeEvent(errorCalls()[0]!);
    expect(Object.keys(event).sort()).toEqual([
      "contexts", "dist", "environment", "event_id", "exception", "level", "platform", "release", "tags", "timestamp",
    ]);
    expect(event).toMatchObject({ platform: "node", release: "dohc-desktop@1.2.3", dist: "win-x64", tags: { process: "main", origin: "uncaughtException" } });
    const values = (event.exception as { values: Array<{ type: string; value: string; stacktrace?: { frames: unknown[] } }> }).values;
    // The cause comes first, then the error, and its oldest call first.
    expect(values.map(({ type, value }) => [type, value])).toEqual([
      ["Error", "<message withheld> (code ENOENT)"],
      ["TypeError", "<message withheld>"],
    ]);
    expect(values[1]!.stacktrace!.frames).toEqual([
      { filename: "app:///dist/main/App-Ab12.js", abs_path: "app:///dist/main/App-Ab12.js", lineno: 3, colno: 4, in_app: true },
      { filename: "<withheld>", in_app: false },
      { filename: "app:///dist/main/App-Ab12.js", abs_path: "app:///dist/main/App-Ab12.js", lineno: 10, colno: 20, in_app: true },
    ]);
    const renderer = envelopeEvent(errorCalls()[1]!);
    expect(renderer).toMatchObject({ tags: { process: "renderer", origin: "boundary" } });
    expect((renderer.exception as { values: Array<{ type: string }> }).values[0]!.type).toBe("<withheld>");
  });

  it("keeps an engine message only when it matches a known template", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError({
      kind: "crash",
      event: { kind: "engine", stage: "restarting", error: new EngineDaemonUnavailableError("Rust engine daemon exited unexpectedly with code 3.") },
    });
    reports.reportError({ kind: "crash", event: { kind: "process-gone", source: "gpu", name: null, reason: "crashed", exitCode: 5 } });
    await reports.flush();
    expect(errorCalls().map((call) => (envelopeEvent(call).exception as { values: unknown[] }).values)).toEqual([
      [{ type: "EngineDaemonUnavailableError", value: "Rust engine daemon exited unexpectedly with code 3." }],
      [{ type: "ProcessGone", value: "gpu crashed (exit code 5)" }],
    ]);
  });

  it("names a window's file the way the uploaded source maps do, from an installation path with spaces", async () => {
    const install = resolve("dohc install", "My Programs", "dohc");
    const asset = join(install, "resources", "app.asar", "dist", "renderer", "assets", "Index-AbC9.js");
    const reports = shown(REPORTING, { locate: createCodeLocations([install], process.platform) });
    reports.setPrivacy(ON);
    const url = pathToFileURL(asset).href;
    expect(url).toContain("%20");
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `    at render (${url}:7:8)` } });
    await reports.flush();
    const values = (envelopeEvent(errorCalls()[0]!).exception as { values: Array<{ stacktrace: { frames: unknown[] } }> }).values;
    expect(values[0]!.stacktrace.frames).toEqual([{
      filename: "app:///dist/renderer/assets/Index-AbC9.js",
      abs_path: "app:///dist/renderer/assets/Index-AbC9.js",
      lineno: 7,
      colno: 8,
      in_app: true,
    }]);
  });
});

describe("limits", () => {
  it("sends a repeated error once", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    for (let index = 0; index < 5; index += 1) {
      reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `at x (${BUNDLE}:1:2)` } });
    }
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs * 10);
    expect(errorCalls()).toHaveLength(1);
  });

  it("stops preparing errors once a loop has repeated one too often", async () => {
    const facts = vi.fn(FACTS);
    const reports = shown(REPORTING, { facts });
    reports.setPrivacy(ON);
    for (let index = 0; index < 1_000; index += 1) {
      reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `at x (${BUNDLE}:1:2)` } });
    }
    expect(facts).toHaveBeenCalledTimes(REPORT_LIMITS.errorsPrepared);
    await reports.flush();
    expect(errorCalls()).toHaveLength(1);
  });

  it("caps errors and usage events per launch", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    for (let index = 0; index < REPORT_LIMITS.errorsPerLaunch + 10; index += 1) {
      reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `at x (${BUNDLE}:${index + 1}:2)` } });
      await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs);
    }
    expect(errorCalls()).toHaveLength(REPORT_LIMITS.errorsPerLaunch);

    for (let index = 0; index < REPORT_LIMITS.usagePerLaunch + 100; index += 1) {
      reports.track({ name: "chat_message_sent" });
      await vi.advanceTimersByTimeAsync(0);
    }
    await reports.flush();
    const sent = usageCalls().reduce((total, call) => total + (JSON.parse(String(call.init.body)) as { batch: unknown[] }).batch.length, 0);
    expect(sent).toBe(REPORT_LIMITS.usagePerLaunch);
  });

  it("holds at most a bounded queue while it waits", async () => {
    const reports = shown();
    for (let index = 0; index < REPORT_LIMITS.usageQueue + 50; index += 1) reports.track({ name: "workspace_opened" });
    reports.setPrivacy(ON);
    await reports.flush();
    const sent = usageCalls().reduce((total, call) => total + (JSON.parse(String(call.init.body)) as { batch: unknown[] }).batch.length, 0);
    expect(sent).toBe(REPORT_LIMITS.usageQueue);
  });

  it("drops a failed send without trying again", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    respond = async () => { throw new Error("offline"); };
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: "" } });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs * 100);
    await reports.flush();
    expect(errorCalls()).toHaveLength(1);
  });

  it("waits as long as a rate limit says, and drops reports meanwhile", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    respond = async () => new Response(null, { status: 429, headers: { "retry-after": "120" } });
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: "" } });
    await reports.flush();
    respond = async () => new Response(null, { status: 200 });
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "RangeError", stack: "" } });
    await reports.flush();
    expect(errorCalls()).toHaveLength(1);
    nowMs += 121_000;
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "SyntaxError", stack: "" } });
    await reports.flush();
    expect(errorCalls()).toHaveLength(2);
  });

  it("reads Sentry's rate limit headers", () => {
    const response = (status: number, headers: Record<string, string>) => ({ status, headers: new Headers(headers) });
    expect(rateLimitMs(response(200, {}))).toBe(0);
    expect(rateLimitMs(response(429, {}))).toBe(60_000);
    expect(rateLimitMs(response(200, { "x-sentry-rate-limits": "60:transaction:key, 2700:default;error;security:organization" }))).toBe(2_700_000);
    expect(rateLimitMs(response(200, { "x-sentry-rate-limits": "30::key" }))).toBe(30_000);
    expect(rateLimitMs(response(429, { "retry-after": "999999" }))).toBe(REPORT_LIMITS.maxPauseMs);
  });
});

describe("usage events", () => {
  it("counts finished actions and carries nothing from them", () => {
    expect(usageEventFor(CHANNELS.createLocalWorkspace, { workspaceId: SECRET, rootPath: SECRET })).toEqual({ name: "workspace_created" });
    expect(usageEventFor(CHANNELS.openWorkspace, {})).toEqual({ name: "workspace_opened" });
    expect(usageEventFor(CHANNELS.createRelayShare, { shareId: SECRET })).toEqual({ name: "share_created", method: "people" });
    expect(usageEventFor(CHANNELS.createRelayShareLink, { url: SECRET })).toEqual({ name: "share_created", method: "link" });
    expect(usageEventFor(CHANNELS.sendChatMessage, { message: { body: SECRET } })).toEqual({ name: "chat_message_sent" });
  });

  it("counts a publication only once it is published", () => {
    expect(usageEventFor(CHANNELS.publishOwnerApp, { kind: "prepared" })).toBeNull();
    expect(usageEventFor(CHANNELS.publishOwnerApp, { kind: "published", local: true })).toEqual({ name: "app_published", local: true });
    expect(usageEventFor(CHANNELS.publishOwnerApp, { kind: "published" })).toEqual({ name: "app_published", local: false });
    expect(usageEventFor(CHANNELS.publishOwnerApp, undefined)).toBeNull();
  });

  it("counts nothing for any other request", () => {
    expect(usageEventFor(CHANNELS.getUserSettings, {})).toBeNull();
    expect(usageEventFor("toString", {})).toBeNull();
  });
});

describe("the switches in effect", () => {
  it("turns reports off when the settings file cannot be used or a switch cannot be read", () => {
    const settings = { privacy: ON };
    expect(privacyInEffect({ settings, source: "stored" })).toEqual(ON);
    expect(privacyInEffect({ settings, source: "recovered" })).toEqual(OFF);
    expect(privacyInEffect({ settings, source: "stored", ignored: [{ key: "privacy.usageReports" }] }))
      .toEqual({ usageReports: false, errorReports: true });
    expect(privacyInEffect({ settings, source: "stored", ignored: [{ key: "privacy" }] })).toEqual(OFF);
  });
});
