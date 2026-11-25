import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EngineDaemonUnavailableError } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeLocations } from "../crashReports/crashReport";
import type { Reporting } from "./reportingConfig";
import { CHANNELS } from "../ipc/channels";
import { datasetOperations } from "../ipc/datasetOperations";
import { shareMountOperations } from "../ipc/shareOperations";
import { sharedViewAccessOperations } from "../ipc/bridgeContract";
import { workspaceFileOperations } from "../ipc/workspaceFileOperations";
import {
  classifyServerKind,
  countBucket,
  crashSignalFromEvent,
  createTelemetry,
  CURRENT_USAGE_NOTICE_VERSION,
  privacyInEffect,
  REPORT_LIMITS,
  updateEventFromTransition,
  usageEventFor,
} from "./telemetry";

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

interface Call {
  url: string;
  init: RequestInit;
}

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
  atMs: nowMs,
  version: "1.2.3",
  channel: "latest",
  os: "Windows_NT",
  osVersion: "10.0.22631",
  arch: "x64",
  electron: "43.3.0",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const statePath = () => join(dir, "reporting.json");
const noticeMetaPath = () => join(dir, "reporting-notice.json");
const savedState = () => JSON.parse(readFileSync(statePath(), "utf8")) as Record<string, unknown>;
const savedNoticeMeta = () =>
  JSON.parse(readFileSync(noticeMetaPath(), "utf8")) as Record<string, unknown>;
const INSTALL_ID = "6f1c1c55-6a52-4a40-8d38-1b2d2e1c1f10";

function telemetry(
  reporting: Reporting | null = REPORTING,
  overrides: Partial<
    Pick<
      Parameters<typeof createTelemetry>[0],
      "facts" | "locate" | "statePath" | "serverKind" | "random"
    >
  > = {},
) {
  return createTelemetry({
    reporting,
    statePath: statePath(),
    facts: FACTS,
    locate: createCodeLocations([INSTALL], process.platform),
    readCode,
    random: () => 0.5,
    ...overrides,
    fetch: (async (url: URL | RequestInfo, init?: RequestInit) => {
      const call = { url: String(url), init: init ?? {} };
      calls.push(call);
      return await respond(call);
    }) as typeof fetch,
    now: () => nowMs,
  });
}

function shown(
  reporting: Reporting | null = REPORTING,
  overrides: Parameters<typeof telemetry>[1] = {},
) {
  writeFileSync(statePath(), JSON.stringify({ usage: { installId: INSTALL_ID }, errors: true }));
  writeFileSync(noticeMetaPath(), JSON.stringify({ usage: CURRENT_USAGE_NOTICE_VERSION }));
  return telemetry(reporting, overrides);
}

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
const sentBody = (call: Call) =>
  JSON.parse(String(call.init.body)) as { api_key: string; batch: SentEvent[] } & Record<
    string,
    unknown
  >;
const isErrorCall = (call: Call) =>
  sentBody(call).batch.some((event) => event.event === "$exception");
const usageCalls = () => calls.filter((call) => !isErrorCall(call));
const errorCalls = () => calls.filter(isErrorCall);
const exceptionEvent = (call: Call) => sentBody(call).batch[0]!;
const exceptions = (call: Call) =>
  exceptionEvent(call).properties.$exception_list as SentException[];

function privateError(): Error {
  const cause = Object.assign(new Error(`could not read C:\\Users\\sam\\${SECRET}.md`), {
    code: "ENOENT",
    path: SECRET,
  });
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
    expect(savedState()).toEqual({
      usage: { installId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      errors: true,
    });
    expect(reports.noticeDue(ON)).toEqual({ usage: false, errors: false });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
    expect(usageCalls()).toHaveLength(1);
    const body = JSON.parse(String(usageCalls()[0]!.init.body)) as {
      api_key: string;
      batch: Array<{
        event: string;
        distinct_id: string;
        uuid: string;
        properties: Record<string, unknown>;
      }>;
    };
    expect(body.api_key).toBe("phc_abcdefghij0123");
    expect(body.batch).toHaveLength(1);
    expect(body.batch[0]!.event).toBe("app_launched");
    expect(body.batch[0]!.distinct_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.batch[0]!.uuid).toMatch(UUID);
    expect(body.batch[0]!.properties).toEqual({
      $process_person_profile: false,
      $geoip_disable: true,
      $lib: "dohc-desktop",
      schema_version: 2,
      app_version: "1.2.3",
      channel: "latest",
      dist: "win-x64",
      os: "Windows_NT",
      os_version: "10.0.22631",
      arch: "x64",
      server_kind: "none",
    });
    expect(savedNoticeMeta()).toEqual({ usage: CURRENT_USAGE_NOTICE_VERSION });
  });

  it("drops what waited when the saved switches are off at startup", async () => {
    const reports = shown();
    reports.track({ name: "app_launched" });
    reports.reportError({
      kind: "crash",
      event: { kind: "main-exception", error: new Error("x"), origin: "uncaughtException" },
    });
    reports.setPrivacy(OFF);
    reports.track({ name: "workspace_opened" });
    await reports.flush();
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs * 2);
    expect(calls).toEqual([]);
  });

  it("keeps the two switches independent", async () => {
    const reports = shown();
    reports.setPrivacy({ usageReports: false, errorReports: true });
    reports.track({ name: "chat_message_sent" });
    reports.reportError({
      kind: "renderer",
      origin: "uncaught",
      error: { name: "TypeError", stack: `at x (${BUNDLE}:1:2)` },
    });
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
    respond = (call) =>
      new Promise((_resolve, reject) => {
        call.init.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    for (let index = 0; index < REPORT_LIMITS.usageBatch + 5; index += 1)
      reports.track({ name: "workspace_opened" });
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

  it.each([
    ["damaged JSON", "{"],
    [
      "an install ID that is not random",
      JSON.stringify({ usage: { installId: "sam" }, errors: true }),
    ],
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
    respond = (call) =>
      new Promise((resolve, reject) => {
        held.push({ call, answer: resolve });
        call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    return held;
  }

  it("stops at one deadline for every report together, and drops the rest", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const held = heldResponses();
    for (const name of ["TypeError", "RangeError", "SyntaxError", "EvalError"])
      reports.reportError(anError(name));
    reports.track({ name: "app_launched" });

    let done = false;
    const flushing = reports.flush().then(() => {
      done = true;
    });
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
    const flushing = reports.flush().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.shutdownTimeoutMs - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flushing;
    expect(errorCalls()).toHaveLength(1);
    expect(errorCalls()[0]!.init.signal?.aborted).toBe(true);
  });
});

describe("what an error report holds", () => {
  const RELEASE = "0192f5b8-0000-7000-8000-000000000001";
  const FOREIGN_RELEASE = "0192f5b8-0000-7000-8000-0000000000ff";
  const { _posthogReleaseId: releaseBefore } = globalThis as { _posthogReleaseId?: unknown };
  afterEach(() => {
    (globalThis as { _posthogReleaseId?: unknown })._posthogReleaseId = releaseBefore;
    vi.unstubAllEnvs();
  });

  it("sends PostHog only allowlisted facts, through one request per problem", async () => {
    const listeners = ["uncaughtException", "unhandledRejection"].map((name) =>
      process.listenerCount(name),
    );
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError({
      kind: "crash",
      event: { kind: "main-exception", error: privateError(), origin: "uncaughtException" },
    });
    reports.reportError({
      kind: "renderer",
      origin: "boundary",
      error: {
        name: `${SECRET}Error`,
        stack: `at x (C:\\Users\\sam\\${SECRET}.js:1:1)\n    at y (${BUNDLE}:5:6)`,
      },
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
      expect(Object.keys(event).sort()).toEqual([
        "distinct_id",
        "event",
        "properties",
        "timestamp",
        "uuid",
      ]);
      expect(event.distinct_id).toMatch(UUID);
      expect(event.timestamp).toBe(new Date(nowMs).toISOString());
      expect(event.properties).toMatchObject({
        $process_person_profile: false,
        $geoip_disable: true,
        $exception_level: "error",
        $lib: "posthog-node",
        app_version: "1.2.3",
        channel: "latest",
        dist: "win-x64",
        os: "Windows_NT",
        os_version: "10.0.22631",
        arch: "x64",
        electron: "43.3.0",
      });
    }
    expect(exceptionEvent(errorCalls()[0]!).distinct_id).not.toBe(
      exceptionEvent(errorCalls()[1]!).distinct_id,
    );
    expect(
      ["uncaughtException", "unhandledRejection"].map((name) => process.listenerCount(name)),
    ).toEqual(listeners);

    const main = exceptionEvent(errorCalls()[0]!);
    expect(Object.keys(main.properties).sort()).toEqual([
      "$exception_level",
      "$exception_list",
      "$geoip_disable",
      "$is_server",
      "$lib",
      "$lib_version",
      "$process_person_profile",
      "app_version",
      "arch",
      "channel",
      "dist",
      "electron",
      "origin",
      "os",
      "os_version",
      "process",
    ]);
    expect(main.properties).toMatchObject({ process: "main", origin: "uncaughtException" });
    const app = (lineno: number, colno: number) => ({
      filename: "app:///dist/main/App-Ab12.js",
      function: "?",
      lineno,
      colno,
      in_app: true,
      chunk_id: MAIN_CHUNK,
      platform: "node:javascript",
    });
    const withheld = {
      filename: "<withheld>",
      function: "?",
      in_app: false,
      platform: "node:javascript",
    };
    expect(exceptions(errorCalls()[0]!)).toEqual([
      {
        type: "TypeError",
        value: "<message withheld>",
        mechanism: { type: "generic", handled: false, synthetic: false, exception_id: 0 },
        stacktrace: { type: "raw", frames: [app(3, 4), withheld, app(10, 20)] },
      },
      {
        type: "Error",
        value: "<message withheld> (code ENOENT)",
        mechanism: {
          type: "chained",
          source: "cause",
          synthetic: false,
          exception_id: 1,
          parent_id: 0,
        },
        stacktrace: { type: "raw", frames: [withheld] },
      },
    ]);
    const renderer = errorCalls()[1]!;
    expect(exceptionEvent(renderer).properties).toMatchObject({
      process: "renderer",
      origin: "boundary",
    });
    expect(exceptions(renderer)).toEqual([
      {
        type: "<withheld>",
        value: "<message withheld>",
        mechanism: { type: "generic", handled: true, synthetic: false, exception_id: 0 },
        stacktrace: { type: "raw", frames: [app(5, 6), withheld] },
      },
    ]);
    expect(readCode).toHaveBeenCalledTimes(1);
  });

  it.each([
    // The SDK prefers POSTHOG_RELEASE_ID to the injected release.
    {
      label: "another release's ID in the environment",
      injected: RELEASE,
      env: FOREIGN_RELEASE,
      sent: RELEASE,
    },
    {
      label: "an injected value that is not a release ID",
      injected: SECRET,
      env: FOREIGN_RELEASE,
      sent: undefined,
    },
  ])(
    "names only the release the build's injected files name, with $label",
    async ({ injected, env, sent }) => {
      (globalThis as { _posthogReleaseId?: unknown })._posthogReleaseId = injected;
      vi.stubEnv("POSTHOG_RELEASE_ID", env);
      const reports = shown();
      reports.setPrivacy(ON);
      reports.reportError(anError());
      await reports.flush();
      const { properties } = exceptionEvent(errorCalls()[0]!);
      if (sent) expect(properties.$release_id).toBe(sent);
      else expect(properties).not.toHaveProperty("$release_id");
      const body = String(errorCalls()[0]!.init.body);
      for (const leaked of [env, injected]) {
        if (typeof leaked === "string" && leaked !== sent) expect(body).not.toContain(leaked);
      }
    },
  );

  it("keeps an engine message only when it matches a known template", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError({
      kind: "crash",
      event: {
        kind: "engine",
        stage: "restarting",
        error: new EngineDaemonUnavailableError(
          "Rust engine daemon exited unexpectedly with code 3.",
        ),
      },
    });
    reports.reportError({
      kind: "crash",
      event: { kind: "process-gone", source: "gpu", name: null, reason: "crashed", exitCode: 5 },
    });
    await reports.flush();
    expect(
      errorCalls().map((call) =>
        exceptions(call).map(({ type, value, stacktrace }) => ({ type, value, stacktrace })),
      ),
    ).toEqual([
      [
        {
          type: "EngineDaemonUnavailableError",
          value: "Rust engine daemon exited unexpectedly with code 3.",
          stacktrace: undefined,
        },
      ],
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
    for (const link of [error, error.cause as Error])
      Object.assign(link, { stack: { toString: () => `at x (C:\\Users\\sam\\${SECRET}.js:1:1)` } });
    reports.reportError({
      kind: "crash",
      event: { kind: "main-exception", error, origin: "uncaughtException" },
    });
    reports.reportError({
      kind: "crash",
      event: {
        kind: "engine",
        stage: "restarting",
        error: Object.assign(
          new EngineDaemonUnavailableError("Rust engine daemon exited unexpectedly with code 3."),
          { stack: 42 },
        ),
      },
    });
    reports.reportError({
      kind: "crash",
      event: { kind: "engine", stage: "startup", error: undefined },
    });
    await reports.flush();
    expect(
      errorCalls().map((call) =>
        exceptions(call).map(({ type, value, stacktrace }) => ({ type, value, stacktrace })),
      ),
    ).toEqual([
      [
        { type: "TypeError", value: "<message withheld>", stacktrace: undefined },
        { type: "Error", value: "<message withheld> (code ENOENT)", stacktrace: undefined },
      ],
      [
        {
          type: "EngineDaemonUnavailableError",
          value: "Rust engine daemon exited unexpectedly with code 3.",
          stacktrace: undefined,
        },
      ],
      [{ type: "ThrownValue", value: "a value of type undefined", stacktrace: undefined }],
    ]);
    for (const call of errorCalls()) {
      expect(String(call.init.body)).not.toContain(SECRET);
      for (const exception of exceptions(call)) expect(exception.mechanism.synthetic).toBe(false);
    }
  });
});

describe("limits", () => {
  it("holds at most a bounded queue while it waits", async () => {
    const reports = shown();
    for (let index = 0; index < REPORT_LIMITS.usageQueue + 50; index += 1)
      reports.track({ name: "workspace_opened" });
    reports.setPrivacy(ON);
    await reports.flush();
    const sent = usageCalls().reduce(
      (total, call) =>
        total + (JSON.parse(String(call.init.body)) as { batch: unknown[] }).batch.length,
      0,
    );
    expect(sent).toBe(REPORT_LIMITS.usageQueue);
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
});

// The SDK sends to another endpoint, with its own request code, when the
// person's environment sets POSTHOG_CAPTURE_MODE=v1.
describe("error reports through the SDK's capture v1", () => {
  const V1_URL = "https://ph.example.test/i/v1/analytics/events";
  beforeEach(() => {
    vi.stubEnv("POSTHOG_CAPTURE_MODE", "v1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends the same allowlisted report, in one request per problem", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    reports.reportError({
      kind: "crash",
      event: { kind: "main-exception", error: privateError(), origin: "uncaughtException" },
    });
    await reports.flush();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(V1_URL);
    expect(call!.init.redirect).toBe("error");
    expect(new Headers(call!.init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(new Headers(call!.init.headers).get("content-encoding")).toBeNull();
    const body = String(call!.init.body);
    for (const leaked of [SECRET, "sam", INSTALL_ID]) expect(body).not.toContain(leaked);
    expect(body).not.toMatch(/Users/i);
    const sent = JSON.parse(body) as {
      batch: Array<SentEvent & { options: Record<string, unknown> }>;
    };
    expect(sent.batch).toHaveLength(1);
    const [event] = sent.batch;
    expect(event!.event).toBe("$exception");
    expect(event!.distinct_id).toMatch(UUID);
    expect(event!.options).toEqual({ process_person_profile: false });
    expect(event!.properties).toMatchObject({
      $geoip_disable: true,
      process: "main",
      origin: "uncaughtException",
      dist: "win-x64",
    });
    const [error, cause] = event!.properties.$exception_list as SentException[];
    expect(error).toMatchObject({
      type: "TypeError",
      value: "<message withheld>",
      mechanism: { handled: false },
    });
    expect(error!.stacktrace!.frames.map((frame) => frame.chunk_id ?? frame.filename)).toEqual([
      MAIN_CHUNK,
      "<withheld>",
      MAIN_CHUNK,
    ]);
    expect(cause).toMatchObject({ type: "Error", value: "<message withheld> (code ENOENT)" });
  });

  it("stops the send under way when the switch turns off", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const held: Call[] = [];
    respond = (call) =>
      new Promise((_resolve, reject) => {
        held.push(call);
        call.init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    reports.reportError(anError());
    reports.reportError(anError("RangeError"));
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.errorFlushMs);
    expect(held).toHaveLength(1);
    reports.setPrivacy({ usageReports: true, errorReports: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(held[0]!.init.signal?.aborted).toBe(true);
    await reports.flush();
    expect(calls).toHaveLength(1);
  });
});

describe("the switches in effect", () => {
  it("turns reports off when the settings file cannot be used or a switch cannot be read", () => {
    const settings = { privacy: ON };
    expect(privacyInEffect({ settings, source: "stored" })).toEqual(ON);
    expect(privacyInEffect({ settings, source: "recovered" })).toEqual(OFF);
    expect(
      privacyInEffect({ settings, source: "stored", ignored: [{ key: "privacy.usageReports" }] }),
    ).toEqual({ usageReports: false, errorReports: true });
    expect(privacyInEffect({ settings, source: "stored", ignored: [{ key: "privacy" }] })).toEqual(
      OFF,
    );
  });
});

describe("v2 usage events, notice versioning, crash signals, and retries", () => {
  it("re-notices upgraded installs once for v2 usage while keeping reporting.json strict and preserving installId", async () => {
    writeFileSync(statePath(), JSON.stringify({ usage: { installId: INSTALL_ID }, errors: true }));
    const reports = telemetry(REPORTING, { serverKind: () => "drive" });
    reports.setPrivacy(ON);
    expect(reports.noticeDue(ON)).toEqual({ usage: true, errors: false });

    reports.track({ name: "app_launched", workspace_count_bucket: "2-5" });
    await settle();
    expect(usageCalls()).toHaveLength(0);

    reports.acknowledgeNotice({ usage: true, errors: false });
    expect(reports.noticeDue(ON)).toEqual({ usage: false, errors: false });
    expect(savedState()).toEqual({ usage: { installId: INSTALL_ID }, errors: true });
    expect(savedNoticeMeta()).toEqual({ usage: CURRENT_USAGE_NOTICE_VERSION });

    await settle();
    expect(usageCalls()).toHaveLength(1);
    const [event] = sentBody(usageCalls()[0]!).batch;
    expect(event!.distinct_id).toBe(INSTALL_ID);
    expect(event!.properties).toMatchObject({
      schema_version: 2,
      server_kind: "drive",
      workspace_count_bucket: "2-5",
    });
  });

  it("retries transient usage 5xx with the same event uuid, drops 4xx, and aborts retries when usageReports turns off", async () => {
    const reports = shown();
    reports.setPrivacy(ON);
    const statuses = [503, 200, 400, 503];
    respond = async () => new Response(null, { status: statuses.shift() ?? 200 });

    reports.track({ name: "workspace_added", method: "create_local" });
    nowMs += REPORT_LIMITS.usageFlushMs;
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
    expect(usageCalls()).toHaveLength(1);
    const firstUuid = sentBody(usageCalls()[0]!).batch[0]!.uuid;

    nowMs += REPORT_LIMITS.usageBaseBackoffMs;
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageBaseBackoffMs);
    expect(usageCalls()).toHaveLength(2);
    expect(sentBody(usageCalls()[1]!).batch[0]!.uuid).toBe(firstUuid);

    reports.track({ name: "chat_message_sent" });
    nowMs += REPORT_LIMITS.usageFlushMs;
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
    expect(usageCalls()).toHaveLength(3);

    nowMs += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(usageCalls()).toHaveLength(3);

    reports.track({ name: "workspace_added", method: "attach_folder" });
    nowMs += REPORT_LIMITS.usageFlushMs;
    await vi.advanceTimersByTimeAsync(REPORT_LIMITS.usageFlushMs);
    expect(usageCalls()).toHaveLength(4);

    reports.setPrivacy({ usageReports: false, errorReports: true });
    nowMs += 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(usageCalls()).toHaveLength(4);
  });

  it("emits app_active_heartbeat once per UTC day and coarsens crash_signal timestamps to the UTC hour", async () => {
    nowMs = Date.UTC(2026, 10, 25, 14, 37, 42);
    const reports = shown();
    reports.setPrivacy(ON);
    reports.markActive();
    reports.markActive();
    nowMs += REPORT_LIMITS.usageFlushMs;
    await settle();
    nowMs = Date.UTC(2026, 10, 26, 0, 5, 19);
    reports.markActive();
    reports.observePreviousCrash({
      revision: 1,
      through: 4,
      read: false,
      source: "main",
      problems: 1,
      atMs: Date.UTC(2026, 10, 25, 23, 49, 12),
      text: "dohc crash report\n\nUncaught exception\nError: <message withheld>",
    });
    reports.observePreviousCrash({
      revision: 1,
      through: 4,
      read: false,
      source: "main",
      problems: 1,
      atMs: Date.UTC(2026, 10, 25, 23, 49, 12),
      text: "dohc crash report\n\nUncaught exception\nError: <message withheld>",
    });
    reports.observePreviousCrash({
      revision: 2,
      through: 5,
      read: false,
      source: "main",
      problems: 2,
      atMs: Date.UTC(2026, 10, 25, 23, 55, 0),
      text: "dohc crash report\n\nUnhandled promise rejection\nError: <message withheld>",
    });

    await reports.flush();
    const batch = usageCalls().flatMap((call) => sentBody(call).batch);
    expect(batch.map((item) => item.event)).toEqual([
      "app_active_heartbeat",
      "app_active_heartbeat",
      "crash_signal",
    ]);
    expect(batch[2]!.timestamp).toBe("2026-11-25T23:00:00.000Z");
    expect(batch[2]!.properties).toMatchObject({ source: "main", reason: "uncaughtException" });
    expect(savedNoticeMeta()).toMatchObject({ lastCrashSeq: 4 });
  });

  it("maps workspace, dataset, update, server kind, and crash helper inputs cleanly", () => {
    expect(countBucket(0)).toBe("0");
    expect(countBucket(1)).toBe("1");
    expect(countBucket(5)).toBe("2-5");
    expect(countBucket(6)).toBe("6+");
    expect(classifyServerKind(null)).toBe("none");
    expect(classifyServerKind("https://drive.dohc.computer/api")).toBe("drive");
    expect(classifyServerKind("https://sync.example.test")).toBe("self_hosted");
    expect(
      crashSignalFromEvent({
        kind: "main-exception",
        origin: "unhandledRejection",
        error: new Error("x"),
      }),
    ).toBeNull();
    expect(
      crashSignalFromEvent({
        kind: "process-gone",
        source: "gpu",
        name: null,
        reason: "oom",
        exitCode: 1,
      }),
    ).toEqual({ name: "crash_signal", source: "gpu", reason: "oom" });
    expect(
      updateEventFromTransition(
        {
          status: "checking",
          message: "",
          currentVersion: "1.0.0",
          channel: "latest",
          canCheck: false,
          canInstall: false,
        },
        {
          status: "ready",
          message: "",
          currentVersion: "1.0.0",
          channel: "latest",
          canCheck: true,
          canInstall: true,
          version: "1.1.0",
        },
      ),
    ).toEqual({ name: "app_update_event", stage: "downloaded" });
    expect(
      updateEventFromTransition(
        {
          status: "downloading",
          message: "",
          currentVersion: "1.0.0",
          channel: "latest",
          canCheck: false,
          canInstall: false,
        },
        {
          status: "error",
          message: "failed",
          currentVersion: "1.0.0",
          channel: "latest",
          canCheck: true,
          canInstall: false,
          failure: { step: "download", id: 1 },
        },
      ),
    ).toEqual({ name: "app_update_event", stage: "failed", failure_step: "download" });
    expect(usageEventFor(CHANNELS.attachWorkspaceFolder, {})).toEqual({
      name: "workspace_added",
      method: "attach_folder",
    });
    expect(usageEventFor(CHANNELS.cloudJoinWorkspace, {})).toEqual({
      name: "workspace_added",
      method: "join_cloud",
    });
    expect(usageEventFor(sharedViewAccessOperations.openSharedView.channel, {})).toEqual({
      name: "workspace_added",
      method: "open_shared_view",
    });
    expect(usageEventFor(shareMountOperations.mountShare.channel, {})).toEqual({
      name: "workspace_added",
      method: "mount_share",
    });
    expect(usageEventFor(workspaceFileOperations.createWorkspaceFile.channel, {})).toEqual({
      name: "feature_used",
      capability_id: "file.create",
      door: "renderer",
    });
    expect(
      usageEventFor(datasetOperations.dataset.channel, { ok: true }, { action: "list" }),
    ).toBeNull();
    expect(
      usageEventFor(
        datasetOperations.dataset.channel,
        { ok: false, kind: "refused" },
        { action: "create" },
      ),
    ).toBeNull();
    expect(
      usageEventFor(datasetOperations.dataset.channel, { ok: true }, { action: "create" }),
    ).toEqual({
      name: "feature_used",
      capability_id: "dataset.create",
      door: "renderer",
    });
  });
});
