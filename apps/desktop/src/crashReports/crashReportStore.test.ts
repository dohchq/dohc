import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { EngineDaemonUnavailableError } from "@dohc/workspace-engine-client/daemon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import type { CrashEvent, CrashFacts } from "./crashReport";
import {
  CRASH_REPORT_MAX_PROBLEMS,
  crashReportEndpoint,
  createCrashReportStore,
  type CrashReportSendRequest,
} from "./crashReportStore";

interface Received {
  method: string | undefined;
  url: string | undefined;
  contentType: string | undefined;
  body: string;
}

// A report server on this computer. It records every request it gets.
async function startReportServer(
  answer: (request: IncomingMessage) => { status: number; headers?: Record<string, string> } = () => ({ status: 204 }),
): Promise<{ url: URL; received: Received[]; server: Server }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        contentType: request.headers["content-type"],
        body,
      });
      const { status, headers } = answer(request);
      response.writeHead(status, headers).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: new URL(`http://127.0.0.1:${port}/crash-reports`), received, server };
}

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

let directory = "";
beforeEach(async () => {
  directory = await createTestScratch("crash-report-store");
});

let clock = 1_000;
function facts(): CrashFacts {
  clock += 1_000;
  return {
    atMs: clock, version: "0.9.0", channel: "latest", packaged: true,
    system: "Windows_NT 10.0.22631", arch: "x64", electron: "43.3.0", uptimeSeconds: 12,
  };
}

function store(endpoint: URL | null, onChanged: () => void = () => undefined) {
  return createCrashReportStore({
    path: join(directory, "crash-report.json"),
    endpoint,
    facts,
    codeFrame: () => "<frame>",
    onChanged,
  });
}

function engineError(code: number): Error {
  return new EngineDaemonUnavailableError(`Rust engine daemon exited unexpectedly with code ${code}.`);
}

const EVERY_KIND: CrashEvent[] = [
  { kind: "main-exception", error: new TypeError("main broke"), origin: "uncaughtException" },
  { kind: "process-gone", source: "window", name: null, reason: "crashed", exitCode: -1 },
  { kind: "process-gone", source: "gpu", name: "GPU", reason: "oom", exitCode: 1 },
  { kind: "engine", error: engineError(1), stage: "restarting" },
  { kind: "engine", error: engineError(2), stage: "stopped" },
];

// Main's dialog, answered the way the test says, and what it was shown.
function dialog(answer: boolean) {
  const shown: CrashReportSendRequest[] = [];
  return {
    shown,
    confirm: async (request: CrashReportSendRequest) => {
      shown.push(request);
      return answer;
    },
  };
}

describe("crash report store", () => {
  it("sends nothing until the person confirms in main's dialog, then posts exactly what it showed", async () => {
    const reportServer = await startReportServer();
    servers.push(reportServer.server);
    // Every network call from the store goes through the global fetch.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onChanged = vi.fn();
    const reports = store(reportServer.url, onChanged);

    for (const event of EVERY_KIND) reports.record(event);
    reports.dismiss(reports.read().report!.through);
    reports.record(EVERY_KIND[1]!);
    const shown = reports.read();
    expect(onChanged).toHaveBeenCalledTimes(EVERY_KIND.length + 2);
    expect(shown.sendTo).toBe(reportServer.url.host);

    // A renderer can open the dialog, but a Cancel there sends nothing.
    const cancelled = dialog(false);
    expect(await reports.send(cancelled.confirm)).toBe(false);
    expect(cancelled.shown).toEqual([{ host: reportServer.url.host, text: shown.report!.text }]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reportServer.received).toEqual([]);
    expect(reports.read().report).not.toBeNull();

    const confirmed = dialog(true);
    expect(await reports.send(confirmed.confirm)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(reportServer.received).toEqual([{
      method: "POST",
      url: "/crash-reports",
      contentType: "text/plain; charset=utf-8",
      body: confirmed.shown[0]!.text,
    }]);
    expect(reports.read().report).toBeNull();
  });

  it("posts the text the dialog showed, and keeps a crash recorded while it was open", async () => {
    const reportServer = await startReportServer();
    servers.push(reportServer.server);
    const reports = store(reportServer.url);
    reports.record(EVERY_KIND[0]!);
    let shownText = "";
    const sent = await reports.send(async ({ text }) => {
      shownText = text;
      reports.record(EVERY_KIND[1]!);
      return true;
    });
    expect(sent).toBe(true);
    expect(reportServer.received.map((request) => request.body)).toEqual([shownText]);
    expect(shownText).not.toContain("Process: window");
    const left = reports.read().report!;
    expect(left.source).toBe("window");
    expect(left.problems).toBe(1);
  });

  it("asks once at a time", async () => {
    const reportServer = await startReportServer();
    servers.push(reportServer.server);
    const reports = store(reportServer.url);
    reports.record(EVERY_KIND[0]!);
    let answer: (value: boolean) => void = () => undefined;
    const first = reports.send(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const second = dialog(true);
    expect(await reports.send(second.confirm)).toBe(false);
    expect(second.shown).toEqual([]);
    answer(false);
    expect(await first).toBe(false);
  });

  it("changes the revision whenever the text changes", () => {
    const reports = store(null);
    reports.record(EVERY_KIND[0]!);
    reports.record(EVERY_KIND[1]!);
    const before = reports.read().report!;
    reports.dismiss(before.through - 1);
    const after = reports.read().report!;
    expect(after.through).toBe(before.through);
    expect(after.text).not.toBe(before.text);
    expect(after.revision).not.toBe(before.revision);
  });

  it("keeps a report for the next launch", () => {
    store(null).record(EVERY_KIND[0]!);
    const next = store(null).read().report;
    expect(next?.source).toBe("main");
    expect(next?.text).toContain("Error: TypeError: <message withheld>");
  });

  it("keeps the newest problems and counts the rest", () => {
    const reports = store(null);
    for (let index = 0; index < CRASH_REPORT_MAX_PROBLEMS + 2; index += 1) {
      reports.record({ kind: "engine", error: engineError(100 + index), stage: "restarting" });
    }
    const report = reports.read().report!;
    expect(report.problems).toBe(CRASH_REPORT_MAX_PROBLEMS + 2);
    expect(report.text).toContain("Earlier problems left out: 2");
    expect(report.text).not.toContain("code 101.");
    expect(report.text).toContain(`code ${100 + CRASH_REPORT_MAX_PROBLEMS + 1}.`);
  });

  it("dismisses what the person saw and keeps a newer problem", () => {
    const reports = store(null);
    reports.record(EVERY_KIND[0]!);
    const seen = reports.read().report!.through;
    reports.record(EVERY_KIND[3]!);
    reports.dismiss(seen);
    const left = reports.read().report!;
    expect(left.problems).toBe(1);
    expect(left.source).toBe("engine");
    expect(left.text).not.toContain("TypeError");
  });

  it("keeps the report when the server refuses it or redirects", async () => {
    const refusing = await startReportServer(() => ({ status: 500 }));
    const elsewhere = await startReportServer();
    const redirecting = await startReportServer(() => ({
      status: 307, headers: { location: elsewhere.url.href },
    }));
    servers.push(refusing.server, elsewhere.server, redirecting.server);

    const refused = store(refusing.url);
    refused.record(EVERY_KIND[0]!);
    await expect(refused.send(dialog(true).confirm)).rejects.toThrow("The report server answered 500.");
    expect(refused.read().report).not.toBeNull();

    const redirected = store(redirecting.url);
    await expect(redirected.send(dialog(true).confirm)).rejects.toThrow("The connection to the report server failed.");
    expect(redirected.read().report).not.toBeNull();
    expect(elsewhere.received).toEqual([]);
  });

  it("offers no Send and asks nothing without a report server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const reports = store(null);
    reports.record(EVERY_KIND[0]!);
    expect(reports.read().sendTo).toBeNull();
    const asked = dialog(true);
    await expect(reports.send(asked.confirm)).rejects.toThrow("no report server");
    expect(asked.shown).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("starts a new report when the file is damaged", () => {
    writeFileSync(join(directory, "crash-report.json"), "{not json");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reports = store(null);
    expect(reports.read().report).toBeNull();
    reports.record(EVERY_KIND[1]!);
    expect(reports.read().report?.source).toBe("window");
  });
});

describe("report server address", () => {
  it("lets a development build name any https server, or http to this computer", () => {
    expect(crashReportEndpoint(undefined, false)).toBeNull();
    expect(crashReportEndpoint("  ", false)).toBeNull();
    expect(crashReportEndpoint("not a url", false)).toBeNull();
    expect(crashReportEndpoint("https://reports.example.test/v1", false)?.host).toBe("reports.example.test");
    expect(crashReportEndpoint("http://127.0.0.1:4000/r", false)?.host).toBe("127.0.0.1:4000");
    expect(crashReportEndpoint("http://localhost:4000/r", false)?.host).toBe("localhost:4000");
    expect(crashReportEndpoint("http://reports.example.test/v1", false)).toBeNull();
    expect(crashReportEndpoint("https://user:secret@reports.example.test/v1", false)).toBeNull();
    expect(crashReportEndpoint("ftp://reports.example.test/v1", false)).toBeNull();
  });

  it("ignores the override in a packaged build, which has no report server yet", () => {
    expect(crashReportEndpoint("https://third-party.example/collect", true)).toBeNull();
    expect(crashReportEndpoint("http://127.0.0.1:4000/r", true)).toBeNull();
    expect(crashReportEndpoint(undefined, true)).toBeNull();
  });
});
