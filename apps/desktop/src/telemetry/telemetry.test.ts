import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EngineDaemonUnavailableError } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeLocations } from "../crashReports/crashReport";
import type { Reporting } from "./reportingConfig";
import { CHANNELS } from "../ipc/channels";
import { createTelemetry, privacyInEffect, rateLimitMs, REPORT_LIMITS, usageEventFor } from "./telemetry";

const INSTALL = resolve("dohc-install", "Programs", "dohc");
const BUNDLE = join(INSTALL, "resources", "app.asar", "dist", "main", "App-Ab12.js");
const SECRET = "Secret Trip Plans";
const KEY = "phc_abcdefghij0123";
const REPORTING: Reporting = {
  usage: { url: new URL("https://ph.example.test/batch/"), key: KEY },
  errors: { host: "https://ph.example.test", key: KEY },
  dist: "win-x64",
};
// The chunk IDs `posthog-cli sourcemap inject` 0.18.10 wrote into a main and
// a renderer file: its snippet first, its trailer last.
const MAIN_CHUNK = "0192f5b8-7c3a-5e1d-9a2b-3c4d5e6f7a8b";
const RENDERER_CHUNK = "1a2b3c4d-5e6f-5a7b-8c9d-0e1f2a3b4c5d";
const injected = (chunkId: string) =>
  `!function(){try{var e="undefined"!=typeof window?window:"undefined"!=typeof global?global:"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:{},n=(new e.Error).stack;n&&(e._posthogChunkIds=e._posthogChunkIds||{},e._posthogChunkIds[n]="${chunkId}")}catch(e){}}();export const x=1;\n\n//# chunkId=${chunkId}`;
const CODE: Record<string, string> = {
  "/resources/app.asar/dist/main/App-Ab12.js": injected(MAIN_CHUNK),
  "/resources/app.asar/dist/renderer/assets/Index-AbC9.js": injected(RENDERER_CHUNK),
};
const readCode = vi.fn(async (path: string) => {
  const text = CODE[path.replaceAll("\\", "/")];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
});
const ON = { usageReports: true, errorReports: true };
const OFF = { usageReports: false, errorReports: false };

interface Call { url: string; init: RequestInit }

let dir: string;
let calls: Call[];
let nowMs: number;
let respond: (call: Call) => Promise<Response>;

// The SDK loads with the first error report; loading it here keeps that
// from waiting on disk while the tests run fake timers.
beforeAll(async () => {
  await import("./posthogErrors");
});

beforeEach(() => {
  vi.useFakeTimers();
  readCode.mockClear();
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const statePath = () => join(dir, "reporting.json");
const savedState = () => JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
const INSTALL_ID = "6f1c1c55-6a52-4a40-8d38-1b2d2e1c1f10";

function telemetry(
  reporting: Reporting | null = REPORTING,
  overrides: Partial<Pick<Parameters<typeof createTelemetry>[0], "facts" | "locate" | "statePath">> = {},
) {
  return createTelemetry({
    reporting,
    statePath: statePath(),
    facts: FACTS,
    locate: createCodeLocations([INSTALL], process.platform),
    readCode,
    ...overrides,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return await respond(call);
    }) as typeof fetch,
    now: () => nowMs,
  });
}

// A telemetry whose person already saw a notice naming both reports on an earlier launch.
function shown(reporting: Reporting | null = REPORTING, overrides: Parameters<typeof telemetry>[1] = {}) {
  writeFileSync(statePath(), JSON.stringify({ usage: { installId: INSTALL_ID }, errors: true }));
  return telemetry(reporting, overrides);
}

// Lets both lanes' timers fire.
const settle = () => vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
const anError = (name = "TypeError") =>
  ({ kind: "renderer", origin: "uncaught", error: { name, stack: "" } }) as const;

interface SentEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
  uuid?: string;
}
interface SentFrame {
  filename: string;
  function: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
  chunk_id?: string;
  platform: string;
}
interface SentException {
  type: string;
  value: string;
  mechanism: Record<string, unknown>;
  stacktrace?: { type: string; frames: SentFrame[] };
}
const sentBody = (call: Call) => JSON.parse(String(call.init.body)) as { api_key: string; batch: SentEvent[] } & Record<string, unknown>;
const isErrorCall = (call: Call) => sentBody(call).batch.some((event) => event.event === "$exception");
const usageCalls = () => calls.filter((call) => !isErrorCall(call));
const errorCalls = () => calls.filter(isErrorCall);
const exceptionEvent = (call: Call) => sentBody(call).batch[0]!;
const exceptions = (call: Call) => exceptionEvent(call).properties.$exception_list as SentException[];

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

    reports.acknowledgeNotice({ usage: true, errors: true });
    expect(savedState()).toEqual({ usage: { installId: expect.stringMatching(/^[0-9a-f-]{36}$/) }, errors: true });
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
    reports.reportError(anError());
    await settle();
    expect(calls).toEqual([]);
    reports.acknowledgeNotice({ usage: false, errors: true });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs);
    expect(errorCalls()).toHaveLength(1);
    // An error report carries no install ID, so none is made for it.
    expect(savedState()).toEqual({ errors: true });
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
    await settle();
    expect(usageCalls()).toHaveLength(0);
    expect(errorCalls()).toHaveLength(1);

    calls.length = 0;
    reports.setPrivacy({ usageReports: true, errorReports: false });
    reports.track({ name: "chat_message_sent" });
    reports.reportError(anError("RangeError"));
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
    reports.acknowledgeNotice({ usage: true, errors: true });
    reports.track({ name: "app_launched" });
    reports.reportError({ kind: "renderer", origin: "boundary", error: { type: "string" } });
    await reports.flush();
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "reporting.json"))).toBe(false);
  });
});

describe("each kind of report waits for a notice that names it", () => {
  const USAGE = { usage: true, errors: false };
  const ERRORS = { usage: false, errors: true };
  const usageOnly = { usageReports: true, errorReports: false };
  const errorsOnly = { usageReports: false, errorReports: true };

  it("sends no usage report after a notice that named only error reports, until a notice names usage", async () => {
    const reports = telemetry();
    reports.setPrivacy(errorsOnly);
    expect(reports.noticeDue(errorsOnly)).toEqual(ERRORS);
    reports.acknowledgeNotice(ERRORS);

    reports.setPrivacy(ON);
    reports.track({ name: "app_launched" });
    reports.reportError(anError());
    await settle();
    expect(usageCalls()).toHaveLength(0);
    expect(errorCalls()).toHaveLength(1);
    expect(reports.noticeDue(ON)).toEqual(USAGE);

    reports.acknowledgeNotice(USAGE);
    await settle();
    expect(usageCalls()).toHaveLength(1);
    expect(savedState()).toEqual({ usage: { installId: expect.any(String) }, errors: true });
  });

  it("sends no error report after a notice that named only usage reports, until a notice names errors", async () => {
    const reports = telemetry();
    reports.setPrivacy(usageOnly);
    expect(reports.noticeDue(usageOnly)).toEqual(USAGE);
    reports.acknowledgeNotice(USAGE);

    reports.setPrivacy(ON);
    reports.track({ name: "app_launched" });
    reports.reportError(anError());
    await settle();
    expect(usageCalls()).toHaveLength(1);
    expect(errorCalls()).toHaveLength(0);
    expect(reports.noticeDue(ON)).toEqual(ERRORS);

    reports.acknowledgeNotice(ERRORS);
    await settle();
    expect(errorCalls()).toHaveLength(1);
  });

  it.each([
    { first: ERRORS, then: USAGE },
    { first: USAGE, then: ERRORS },
  ])("keeps the other kind due on the next launch after a notice that named $first", async ({ first, then }) => {
    const before = telemetry();
    before.setPrivacy(ON);
    before.acknowledgeNotice(first);
    await before.flush();

    calls.length = 0;
    const after = telemetry();
    after.setPrivacy(ON);
    expect(after.noticeDue(ON)).toEqual(then);
    after.track({ name: "app_launched" });
    after.reportError(anError());
    await settle();
    expect(usageCalls()).toHaveLength(first.usage ? 1 : 0);
    expect(errorCalls()).toHaveLength(first.errors ? 1 : 0);
  });

  it("keeps the install ID once usage reports were named", () => {
    const before = telemetry();
    before.acknowledgeNotice(USAGE);
    const { usage } = savedState();
    telemetry().acknowledgeNotice(ERRORS);
    expect(savedState()).toEqual({ usage, errors: true });
  });

  it("names usage reports when a later build adds their service", async () => {
    const partial = telemetry({ ...REPORTING, usage: null });
    partial.setPrivacy(ON);
    expect(partial.noticeDue(ON)).toEqual(ERRORS);
    // The window says what it showed; this build could not send usage reports.
    partial.acknowledgeNotice({ usage: true, errors: true });
    expect(savedState()).toEqual({ errors: true });

    const full = telemetry();
    full.setPrivacy(ON);
    expect(full.noticeDue(ON)).toEqual(USAGE);
    full.track({ name: "app_launched" });
    await settle();
    expect(usageCalls()).toHaveLength(0);
  });

  it("saves exactly the kinds the notice named, whatever the switches say by then", () => {
    const reports = telemetry();
    reports.setPrivacy(ON);
    expect(reports.noticeDue(ON)).toEqual({ usage: true, errors: true });
    reports.setPrivacy(OFF);
    reports.acknowledgeNotice({ usage: true, errors: true });
    expect(reports.noticeDue(ON)).toEqual({ usage: false, errors: false });

    const partly = mkdtempSync(join(tmpdir(), "dohc-reports-"));
    try {
      const other = telemetry(REPORTING, { statePath: join(partly, "reporting.json") });
      other.setPrivacy(ON);
      other.acknowledgeNotice(ERRORS);
      expect(other.noticeDue(ON)).toEqual(USAGE);
    } finally {
      rmSync(partly, { recursive: true, force: true });
    }
  });

  it.each([
    ["an earlier format", JSON.stringify({ installId: INSTALL_ID })],
    ["damaged JSON", "{"],
    ["a kind turned off by hand", JSON.stringify({ usage: { installId: INSTALL_ID }, errors: false })],
    ["an install ID that is not random", JSON.stringify({ usage: { installId: "sam" }, errors: true })],
  ])("names both kinds again after a state file with %s", async (_label, text) => {
    writeFileSync(statePath(), text);
    const reports = telemetry();
    reports.setPrivacy(ON);
    expect(reports.noticeDue(ON)).toEqual({ usage: true, errors: true });
    reports.track({ name: "app_launched" });
    reports.reportError(anError());
    await settle();
    expect(calls).toEqual([]);
  });

  it("sends nothing and keeps the notice due when the state cannot be saved", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "a file where a folder should be");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reports = telemetry(REPORTING, { statePath: join(blocked, "reporting.json") });
    reports.setPrivacy(ON);
    reports.acknowledgeNotice({ usage: true, errors: true });
    expect(errorLog).toHaveBeenCalledOnce();
    errorLog.mockRestore();
    expect(reports.noticeDue(ON)).toEqual({ usage: true, errors: true });
    reports.track({ name: "app_launched" });
    reports.reportError(anError());
    await settle();
    await reports.flush();
    expect(calls).toEqual([]);
  });
});

describe("reports at quit", () => {
  function heldResponses() {
    const held: Array<{ call: Call; answer: (response: Response) => void }> = [];
    respond = (call) => new Promise((resolve, reject) => {
      held.push({ call, answer: resolve });
      call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
    return held;
  }

  it("sends what waits right away, without waiting for the usage timer", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    reports.track({ name: "app_launched" });
    reports.reportError(anError());
    await reports.flush();
    expect(usageCalls()).toHaveLength(1);
    expect(errorCalls()).toHaveLength(1);
  });

  it("waits for a send under way, then sends what queued behind it", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const held = heldResponses();
    reports.reportError(anError());
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs);
    expect(held).toHaveLength(1);
    reports.reportError(anError("RangeError"));

    let done = false;
    const flushing = reports.flush().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    expect(held).toHaveLength(1);

    held[0]!.answer(new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toHaveLength(2);
    expect(done).toBe(false);
    held[1]!.answer(new Response(null, { status: 200 }));
    await flushing;
    expect(errorCalls()).toHaveLength(2);
  });

  it("stops at one deadline for every report together, and drops the rest", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const held = heldResponses();
    for (const name of ["TypeError", "RangeError", "SyntaxError", "EvalError"]) reports.reportError(anError(name));
    reports.track({ name: "app_launched" });

    let done = false;
    const flushing = reports.flush().then(() => { done = true; });
    // The first send of each kind takes half the deadline; the next error's send never finishes.
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.shutdownTimeoutMs / 2);
    expect(held).toHaveLength(2);
    for (const { answer } of held.splice(0)) answer(new Response(null, { status: 200 }));
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.shutdownTimeoutMs / 2 - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(usageCalls()).toHaveLength(1);
    expect(errorCalls()).toHaveLength(2);
    expect(held).toHaveLength(1);
    expect(held[0]!.call.init.signal?.aborted).toBe(true);
    const sent = calls.length;

    reports.reportError(anError("URIError"));
    reports.track({ name: "workspace_opened" });
    await settle();
    expect(calls).toHaveLength(sent);
  });

  it("stops at the deadline when a service never answers, even to an abort", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    respond = () => new Promise<Response>(() => undefined);
    reports.reportError(anError());
    reports.reportError(anError("RangeError"));

    let done = false;
    const flushing = reports.flush().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.shutdownTimeoutMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0]!.init.signal?.aborted).toBe(true);
  });

  it("stops the send under way and ends early when a switch turns off during quit", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const held = heldResponses();
    reports.reportError(anError());
    reports.reportError(anError("RangeError"));

    let done = false;
    const flushing = reports.flush().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toHaveLength(1);
    reports.setPrivacy({ usageReports: true, errorReports: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    await flushing;
    expect(held[0]!.call.init.signal?.aborted).toBe(true);
    expect(errorCalls()).toHaveLength(1);
  });

  it("starts no timer and sends nothing after quit", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    await reports.flush();
    reports.track({ name: "app_launched" });
    reports.reportError(anError());
    reports.setPrivacy(ON);
    reports.acknowledgeNotice({ usage: true, errors: true });
    for (let index = 0; index < REPORT_LIMITS.usageBatch; index += 1) reports.track({ name: "workspace_opened" });
    expect(vi.getTimerCount()).toBe(0);
    await settle();
    expect(calls).toEqual([]);
  });
});

describe("what an error report holds", () => {
  const { _posthogReleaseId: releaseBefore } = globalThis as { _posthogReleaseId?: unknown };
  afterEach(() => {
    (globalThis as { _posthogReleaseId?: unknown })._posthogReleaseId = releaseBefore;
    vi.unstubAllEnvs();
  });

  it("sends PostHog only allowlisted facts, through one request per problem", async () => {
    const listeners = ["uncaughtException", "unhandledRejection"].map((name) => process.listenerCount(name));
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
      expect(body).not.toContain(INSTALL_ID);
      expect(call.url).toBe("https://ph.example.test/batch/");
      expect(call.init.method).toBe("POST");
      expect(call.init.redirect).toBe("error");
      expect(new Headers(call.init.headers).get("content-encoding")).toBeNull();
      expect(Object.keys(sentBody(call)).sort()).toEqual(["api_key", "batch", "sent_at"]);
      expect(sentBody(call).api_key).toBe(KEY);
      expect(sentBody(call).batch).toHaveLength(1);
      const event = exceptionEvent(call);
      expect(Object.keys(event).sort()).toEqual(["distinct_id", "event", "properties", "timestamp", "uuid"]);
      // A new random ID for each problem, never the installation's.
      expect(event.distinct_id).toMatch(UUID);
      expect(event.timestamp).toBe(new Date(nowMs).toISOString());
      expect(event.properties).toMatchObject({
        $process_person_profile: false, $geoip_disable: true, $exception_level: "error", $lib: "posthog-node",
        app_version: "1.2.3", channel: "latest", dist: "win-x64", os: "Windows_NT", os_version: "10.0.22631",
        arch: "x64", electron: "43.3.0",
      });
    }
    expect(exceptionEvent(errorCalls()[0]!).distinct_id).not.toBe(exceptionEvent(errorCalls()[1]!).distinct_id);
    // Nothing installed a handler of its own.
    expect(["uncaughtException", "unhandledRejection"].map((name) => process.listenerCount(name))).toEqual(listeners);

    const main = exceptionEvent(errorCalls()[0]!);
    expect(Object.keys(main.properties).sort()).toEqual([
      "$exception_level", "$exception_list", "$geoip_disable", "$is_server", "$lib", "$lib_version",
      "$process_person_profile", "app_version", "arch", "channel", "dist", "electron", "origin", "os", "os_version", "process",
    ]);
    expect(main.properties).toMatchObject({ process: "main", origin: "uncaughtException" });
    // The error comes first, then its cause; each stack runs oldest call first.
    const app = (lineno: number, colno: number) => ({
      filename: "app:///dist/main/App-Ab12.js", function: "?", lineno, colno, in_app: true, chunk_id: MAIN_CHUNK, platform: "node:javascript",
    });
    const withheld = { filename: "<withheld>", function: "?", in_app: false, platform: "node:javascript" };
    expect(exceptions(errorCalls()[0]!)).toEqual([
      {
        type: "TypeError", value: "<message withheld>",
        mechanism: { type: "generic", handled: true, synthetic: false, exception_id: 0 },
        stacktrace: { type: "raw", frames: [app(3, 4), withheld, app(10, 20)] },
      },
      {
        type: "Error", value: "<message withheld> (code ENOENT)",
        mechanism: { type: "chained", source: "cause", synthetic: false, exception_id: 1, parent_id: 0 },
        stacktrace: { type: "raw", frames: [withheld] },
      },
    ]);
    const renderer = errorCalls()[1]!;
    expect(exceptionEvent(renderer).properties).toMatchObject({ process: "renderer", origin: "boundary" });
    expect(exceptions(renderer)).toEqual([{
      type: "<withheld>", value: "<message withheld>",
      mechanism: { type: "generic", handled: true, synthetic: false, exception_id: 0 },
      stacktrace: { type: "raw", frames: [app(5, 6), withheld] },
    }]);
    // Each file's chunk ID is read once.
    expect(readCode).toHaveBeenCalledTimes(1);
  });

  it("names the release the build's injected files name, and nothing else", async () => {
    const release = "0192f5b8-0000-7000-8000-000000000001";
    (globalThis as { _posthogReleaseId?: unknown })._posthogReleaseId = release;
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError(anError());
    await reports.flush();
    expect(exceptionEvent(errorCalls()[0]!).properties.$release_id).toBe(release);

    // The SDK prefers this variable to the injected release.
    vi.stubEnv("POSTHOG_RELEASE_ID", SECRET);
    calls.length = 0;
    const next = shown();
    next.setPrivacy(ON);
    next.reportError(anError());
    await next.flush();
    expect(exceptionEvent(errorCalls()[0]!).properties).not.toHaveProperty("$release_id");
    expect(String(errorCalls()[0]!.init.body)).not.toContain(SECRET);
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
    expect(errorCalls().map((call) => exceptions(call).map(({ type, value, stacktrace }) => ({ type, value, stacktrace })))).toEqual([
      [{ type: "EngineDaemonUnavailableError", value: "Rust engine daemon exited unexpectedly with code 3.", stacktrace: undefined }],
      [{ type: "ProcessGone", value: "gpu crashed (exit code 5)", stacktrace: undefined }],
    ]);
    expect(errorCalls().map((call) => exceptionEvent(call).properties)).toMatchObject([
      { process: "engine", stage: "restarting" },
      { process: "gpu", reason: "crashed" },
    ]);
  });

  it("still sends a short report when an error's stack is not text", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const error = privateError();
    for (const link of [error, error.cause as Error]) Object.assign(link, { stack: { toString: () => `at x (C:\\Users\\sam\\${SECRET}.js:1:1)` } });
    reports.reportError({ kind: "crash", event: { kind: "main-exception", error, origin: "uncaughtException" } });
    reports.reportError({
      kind: "crash",
      event: {
        kind: "engine",
        stage: "restarting",
        error: Object.assign(new EngineDaemonUnavailableError("Rust engine daemon exited unexpectedly with code 3."), { stack: 42 }),
      },
    });
    reports.reportError({ kind: "crash", event: { kind: "engine", stage: "startup", error: undefined } });
    await reports.flush();
    expect(errorCalls().map((call) => exceptions(call).map(({ type, value, stacktrace }) => ({ type, value, stacktrace })))).toEqual([
      [
        { type: "TypeError", value: "<message withheld>", stacktrace: undefined },
        { type: "Error", value: "<message withheld> (code ENOENT)", stacktrace: undefined },
      ],
      [{ type: "EngineDaemonUnavailableError", value: "Rust engine daemon exited unexpectedly with code 3.", stacktrace: undefined }],
      [{ type: "ThrownValue", value: "a value of type undefined", stacktrace: undefined }],
    ]);
    for (const call of errorCalls()) {
      expect(String(call.init.body)).not.toContain(SECRET);
      // The SDK put none of its own frames in place of a missing stack.
      for (const exception of exceptions(call)) expect(exception.mechanism.synthetic).toBe(false);
    }
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
    expect(exceptions(errorCalls()[0]!)[0]!.stacktrace!.frames).toEqual([{
      filename: "app:///dist/renderer/assets/Index-AbC9.js",
      function: "?",
      lineno: 7,
      colno: 8,
      in_app: true,
      chunk_id: RENDERER_CHUNK,
      platform: "node:javascript",
    }]);
  });

  it("sends a frame without a chunk ID when its file carries none", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const other = join(INSTALL, "resources", "app.asar", "node_modules", "ws", "lib", "websocket.js");
    reports.reportError({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `    at send (${other}:1:2)` } });
    await reports.flush();
    expect(exceptions(errorCalls()[0]!)[0]!.stacktrace!.frames).toEqual([{
      filename: "app:///node_modules/ws/lib/websocket.js", function: "?", lineno: 1, colno: 2, in_app: false, platform: "node:javascript",
    }]);
  });
});

describe("how PostHog groups problems", () => {
  const atLine = (line: number) =>
    ({ kind: "renderer", origin: "uncaught", error: { name: "TypeError", stack: `    at x (${BUNDLE}:${line}:2)` } }) as const;
  const engine = (stage: "restarting" | "stopped") => ({
    kind: "crash",
    event: { kind: "engine", stage, error: new EngineDaemonUnavailableError("Rust engine daemon exited unexpectedly with code 3.") },
  }) as const;
  const thrown = (origin: "boundary" | "uncaught") => ({ kind: "renderer", origin, error: { type: "string" } }) as const;

  async function launch(...problems: Parameters<ReturnType<typeof telemetry>["reportError"]>[0][]) {
    calls.length = 0;
    const reports = shown();
    reports.setPrivacy(ON);
    for (const problem of problems) reports.reportError(problem);
    await reports.flush();
    return errorCalls().map((call) => ({
      exceptions: exceptions(call),
      fingerprint: exceptionEvent(call).properties.$exception_fingerprint,
    }));
  }

  it("keeps a problem in one group across launches", async () => {
    const first = await launch(atLine(3), engine("restarting"), thrown("boundary"));
    const second = await launch(atLine(3), engine("restarting"), thrown("boundary"));
    expect(second).toEqual(first);
    // Frames in dohc's code group the first once source maps resolve them;
    // the others carry the group they name.
    expect(first[0]!.fingerprint).toBeUndefined();
    expect(first[1]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first[2]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells apart problems with the same message", async () => {
    const [here, there, restarting, stopped, boundary, uncaught] =
      await launch(atLine(3), atLine(9), engine("restarting"), engine("stopped"), thrown("boundary"), thrown("uncaught"));
    expect(here!.exceptions[0]!.value).toBe(there!.exceptions[0]!.value);
    expect(here!.exceptions[0]!.stacktrace).not.toEqual(there!.exceptions[0]!.stacktrace);
    expect(restarting!.exceptions).toEqual(stopped!.exceptions);
    expect(restarting!.fingerprint).not.toBe(stopped!.fingerprint);
    expect(boundary!.exceptions).toEqual(uncaught!.exceptions);
    expect(boundary!.fingerprint).not.toBe(uncaught!.fingerprint);
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
    reports.reportError(anError());
    await settle();
    respond = async () => new Response(null, { status: 200 });
    reports.reportError(anError("RangeError"));
    await settle();
    expect(errorCalls()).toHaveLength(1);
    nowMs += 121_000;
    reports.reportError(anError("SyntaxError"));
    await settle();
    expect(errorCalls()).toHaveLength(2);
  });

  it("honors a rate limit at quit", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    respond = async () => new Response(null, { status: 429, headers: { "retry-after": "120" } });
    reports.reportError(anError());
    await settle();
    respond = async () => new Response(null, { status: 200 });
    reports.reportError(anError("RangeError"));
    await reports.flush();
    expect(errorCalls()).toHaveLength(1);
  });

  it("reads PostHog's rate limit", () => {
    const response = (status: number, headers: Record<string, string>) => ({ status, headers: new Headers(headers) });
    expect(rateLimitMs(response(200, {}))).toBe(0);
    expect(rateLimitMs(response(200, { "retry-after": "120" }))).toBe(0);
    expect(rateLimitMs(response(429, {}))).toBe(60_000);
    expect(rateLimitMs(response(429, { "retry-after": "120" }))).toBe(120_000);
    expect(rateLimitMs(response(429, { "retry-after": "999999" }))).toBe(REPORT_LIMITS.maxPauseMs);
  });

  it("makes no request the reports did not ask for", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError(anError());
    reports.track({ name: "app_launched" });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.maxPauseMs);
    expect(calls.map((call) => [call.url, isErrorCall(call)])).toEqual([
      ["https://ph.example.test/batch/", true],
      ["https://ph.example.test/batch/", false],
    ]);
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
