import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestScratch } from "../workspaces/testTemp";
import type { CrashEvent, CrashFacts } from "./crashReport";
import {
  CRASH_REPORT_MAX_PROBLEMS,
  CrashReportChangedError,
  crashReportEndpoint,
  createCrashReportStore,
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
    scrub: (text) => text,
    onChanged,
  });
}

const EVERY_KIND: CrashEvent[] = [
  { kind: "main-exception", error: new Error("main broke"), origin: "uncaughtException" },
  { kind: "process-gone", source: "window", name: null, reason: "crashed", exitCode: -1 },
  { kind: "process-gone", source: "gpu", name: "GPU", reason: "oom", exitCode: 1 },
  { kind: "engine", error: new Error("engine exited"), stage: "restarting" },
  { kind: "engine", error: new Error("engine stopped"), stage: "stopped" },
];

describe("crash report store", () => {
  it("sends nothing until Send, then posts exactly the text the person read", async () => {
    const reportServer = await startReportServer();
    servers.push(reportServer.server);
    // Every network call from the store goes through the global fetch.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const onChanged = vi.fn();
    const reports = store(reportServer.url, onChanged);

    for (const event of EVERY_KIND) reports.record(event);
    const first = reports.read();
    reports.dismiss(first.report!.revision);
    reports.record(EVERY_KIND[1]!);
    const shown = reports.read();

    expect(onChanged).toHaveBeenCalledTimes(EVERY_KIND.length + 2);
    expect(shown.sendTo).toBe(reportServer.url.host);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(reportServer.received).toEqual([]);

    await reports.send(shown.report!.revision);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(reportServer.received).toEqual([{
      method: "POST",
      url: "/crash-reports",
      contentType: "text/plain; charset=utf-8",
      body: shown.report!.text,
    }]);
    expect(reports.read().report).toBeNull();
  });

  it("keeps a report for the next launch", () => {
    store(null).record(EVERY_KIND[0]!);
    const next = store(null).read().report;
    expect(next?.source).toBe("main");
    expect(next?.text).toContain("Error: Error: main broke");
  });

  it("keeps the newest problems and counts the rest", () => {
    const reports = store(null);
    for (let index = 0; index < CRASH_REPORT_MAX_PROBLEMS + 2; index += 1) {
      reports.record({ kind: "engine", error: new Error(`failure ${index}`), stage: "restarting" });
    }
    const report = reports.read().report!;
    expect(report.problems).toBe(CRASH_REPORT_MAX_PROBLEMS + 2);
    expect(report.text).toContain("Earlier problems left out: 2");
    expect(report.text).not.toContain("failure 1.");
    expect(report.text).toContain(`failure ${CRASH_REPORT_MAX_PROBLEMS + 1}`);
  });

  it("dismisses what the person saw and keeps a newer problem", () => {
    const reports = store(null);
    reports.record(EVERY_KIND[0]!);
    const seen = reports.read().report!.revision;
    reports.record(EVERY_KIND[3]!);
    reports.dismiss(seen);
    const left = reports.read().report!;
    expect(left.problems).toBe(1);
    expect(left.source).toBe("engine");
    expect(left.text).not.toContain("main broke");
  });

  it("refuses to send a report that changed after the person read it", async () => {
    const reportServer = await startReportServer();
    servers.push(reportServer.server);
    const reports = store(reportServer.url);
    reports.record(EVERY_KIND[0]!);
    const seen = reports.read().report!.revision;
    reports.record(EVERY_KIND[1]!);
    await expect(reports.send(seen)).rejects.toBeInstanceOf(CrashReportChangedError);
    expect(reportServer.received).toEqual([]);
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
    await expect(refused.send(refused.read().report!.revision)).rejects.toThrow("The report server answered 500.");
    expect(refused.read().report).not.toBeNull();

    const redirected = store(redirecting.url);
    await expect(redirected.send(redirected.read().report!.revision)).rejects.toThrow(
      "The connection to the report server failed.",
    );
    expect(redirected.read().report).not.toBeNull();
    expect(elsewhere.received).toEqual([]);
  });

  it("offers no Send and sends nothing without a report server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const reports = store(null);
    reports.record(EVERY_KIND[0]!);
    const read = reports.read();
    expect(read.sendTo).toBeNull();
    await expect(reports.send(read.report!.revision)).rejects.toThrow("no report server");
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
  it("accepts https, and http only to this computer", () => {
    expect(crashReportEndpoint(undefined)).toBeNull();
    expect(crashReportEndpoint("  ")).toBeNull();
    expect(crashReportEndpoint("not a url")).toBeNull();
    expect(crashReportEndpoint("https://reports.example.test/v1")?.host).toBe("reports.example.test");
    expect(crashReportEndpoint("http://127.0.0.1:4000/r")?.host).toBe("127.0.0.1:4000");
    expect(crashReportEndpoint("http://localhost:4000/r")?.host).toBe("localhost:4000");
    expect(crashReportEndpoint("http://reports.example.test/v1")).toBeNull();
    expect(crashReportEndpoint("https://user:secret@reports.example.test/v1")).toBeNull();
    expect(crashReportEndpoint("ftp://reports.example.test/v1")).toBeNull();
  });
});
