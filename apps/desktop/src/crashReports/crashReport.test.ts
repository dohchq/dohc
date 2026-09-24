import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRASH_EVENT_MAX_CHARS,
  crashReportText,
  createCrashScrubber,
  formatCrashEvent,
  type CrashFacts,
} from "./crashReport";

const INSTALL = resolve("dohc-install", "Program Files", "dohc");
const scrub = createCrashScrubber([INSTALL], process.platform);

const FACTS: CrashFacts = {
  atMs: Date.UTC(2026, 8, 25, 10, 0, 0),
  version: "0.9.0",
  channel: "latest",
  packaged: true,
  system: "Windows_NT 10.0.22631",
  arch: "x64",
  electron: "43.3.0",
  uptimeSeconds: 125,
};

describe("crash report scrubbing", () => {
  it("keeps the dohc-relative part of dohc's own paths, in every spelling", () => {
    const bundle = join(INSTALL, "resources", "app.asar", "out", "main", "index.js");
    const url = pathToFileURL(bundle).href;
    expect(scrub(`at open (${bundle}:12:5)`)).toBe("at open (<dohc>/resources/app.asar/out/main/index.js:12:5)");
    expect(scrub(`at open (${url}:12:5)`)).toBe("at open (<dohc>/resources/app.asar/out/main/index.js:12:5)");
    expect(scrub(`at open (${bundle.replace(/\\/g, "/")}:1:2)`)).toBe(
      "at open (<dohc>/resources/app.asar/out/main/index.js:1:2)",
    );
  });

  it("removes every other path, even one with spaces in its folder names", () => {
    expect(scrub("Could not open C:\\Users\\Ice de Vera\\Documents\\Trip plans\\budget.md")).toBe(
      "Could not open <path>",
    );
    expect(scrub("stat D:/Work/Secret project/notes.md failed")).toBe("stat <path>");
    expect(scrub("share \\\\fileserver\\team\\plans.md")).toBe("share <path>");
    expect(scrub("read /Users/ice de vera/Documents/plan.md")).toBe("read <path>");
    expect(scrub("at run (/home/sam/dohc/notes/a.md:3:1)")).toBe("at run (<path>)");
  });

  it("removes quoted values, since messages quote what a person typed", () => {
    expect(scrub(`Unexpected token 'h', "hello world" is not valid JSON`)).toBe(
      `Unexpected token '…', "…" is not valid JSON`,
    );
    expect(scrub("Cannot read properties of undefined (reading 'title')")).toBe(
      "Cannot read properties of undefined (reading '…')",
    );
    // An apostrophe is not a quote.
    expect(scrub("dohc couldn't open the engine's store")).toBe("dohc couldn't open the engine's store");
  });

  it("removes URLs, email addresses, IP addresses, and secrets", () => {
    expect(scrub("fetch https://relay.example.test/sync?token=abc failed")).toBe("fetch <url> failed");
    expect(scrub("dohc-file://ws-1/notes/plan.md")).toBe("<url>");
    expect(scrub("signed in as sam@example.test")).toBe("signed in as <email>");
    expect(scrub("connect ECONNREFUSED 192.168.1.20:443")).toBe("connect ECONNREFUSED <ip>:443");
    expect(scrub("Bearer abc.def")).toBe("Bearer <redacted>");
    expect(scrub("Authorization: Bearer abc.def")).toBe("Authorization: <redacted> <redacted>");
    expect(scrub("password=hunter2 next")).toBe("password=<redacted> next");
    expect(scrub("session 5f0c3e4a9b8d7c6e5f4a3b2c1d0e9f8a7b6c ended")).toBe("session <redacted> ended");
    expect(scrub("workspace 0d2f7b9e-8a5c-4d3e-9f1a-2b6c8e0d4a7f closed")).toBe("workspace <redacted> closed");
  });

  it("keeps ordinary code words and version numbers", () => {
    expect(scrub("TypeError: engineDaemonLifecycle is not a function at node:internal/process/task_queues:95:5"))
      .toBe("TypeError: engineDaemonLifecycle is not a function at node:internal/process/task_queues:95:5");
    expect(scrub("Electron 43.3.0 read/write")).toBe("Electron 43.3.0 read/write");
  });
});

describe("crash report formatting", () => {
  it("writes the facts, the error, and dohc's own stack frames", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'title')");
    error.stack = [
      "TypeError: Cannot read properties of undefined (reading 'title')",
      `    at render (${join(INSTALL, "resources", "app.asar", "out", "main", "index.js")}:40:7)`,
      "    at C:\\Users\\sam\\AppData\\Local\\Temp\\plugin.js:1:1",
    ].join("\n");
    const text = formatCrashEvent({ kind: "main-exception", error, origin: "uncaughtException" }, FACTS, scrub);
    expect(text).toBe([
      "Time: 2026-09-25T10:00:00.000Z",
      "Process: main",
      "What happened: Uncaught exception",
      "Version: 0.9.0 (latest)",
      "System: Windows_NT 10.0.22631 x64",
      "Electron: 43.3.0",
      "Running for: 125 s",
      "Error: TypeError: Cannot read properties of undefined (reading '…')",
      "    at render (<dohc>/resources/app.asar/out/main/index.js:40:7)",
      "    at <path>",
    ].join("\n"));
  });

  it("follows an engine error's causes without its supervisor stack", () => {
    const exit = new Error("Rust engine daemon exited unexpectedly with code 101.");
    const terminal = new Error("Rust engine restart limit exceeded after 3 attempts.", { cause: exit });
    const text = formatCrashEvent({ kind: "engine", error: terminal, stage: "stopped" }, { ...FACTS, packaged: false }, scrub);
    expect(text).toContain("Process: workspace engine");
    expect(text).toContain("What happened: The workspace engine failed again, and dohc stopped restarting it.");
    expect(text).toContain("Version: 0.9.0 (latest, development build)");
    expect(text).toContain("Error: Error: Rust engine restart limit exceeded after 3 attempts.");
    expect(text).toContain("Caused by: Error: Rust engine daemon exited unexpectedly with code 101.");
    expect(text).not.toContain("    at ");
  });

  it("names a process that ended with its reason and exit code", () => {
    const text = formatCrashEvent({
      kind: "process-gone", source: "utility", name: "network.mojom.NetworkService", reason: "crashed", exitCode: -1073741819,
    }, FACTS, scrub);
    expect(text).toContain("Process: utility (network.mojom.NetworkService)");
    expect(text).toContain("Reason: crashed");
    expect(text).toContain("Exit code: -1073741819");
  });

  it("never spells out a thrown object, and scrubs a thrown string", () => {
    expect(formatCrashEvent({ kind: "main-exception", error: { secret: "x" }, origin: "uncaughtException" }, FACTS, scrub))
      .toContain("Error: a value of type object");
    expect(formatCrashEvent({ kind: "main-exception", error: "lost C:\\Users\\sam\\notes.md", origin: "uncaughtException" }, FACTS, scrub))
      .toContain("Error: lost <path>");
  });

  it("bounds one problem and puts a header on the report", () => {
    const error = new Error("x".repeat(20_000));
    error.stack = `Error: x\n${"    at deep (node:internal/x:1:1)\n".repeat(200)}`;
    const text = formatCrashEvent({ kind: "main-exception", error, origin: "uncaughtException" }, FACTS, scrub);
    expect(text.length).toBeLessThanOrEqual(CRASH_EVENT_MAX_CHARS);
    expect(crashReportText(["one", "two"], 3)).toBe("dohc crash report\n\nEarlier problems left out: 3\n\none\n\ntwo");
  });
});
