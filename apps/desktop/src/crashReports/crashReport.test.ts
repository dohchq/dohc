import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRASH_EVENT_MAX_CHARS,
  crashReportRoot,
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
    expect(scrub("listening on 192.168.1.20")).toBe("listening on <ip>");
    expect(scrub("Bearer abc.def")).toBe("Bearer <redacted>");
    expect(scrub("Authorization: Bearer abc.def")).toBe("Authorization: <redacted> <redacted>");
    expect(scrub("password=hunter2 next")).toBe("password=<redacted> next");
    expect(scrub("session 5f0c3e4a9b8d7c6e5f4a3b2c1d0e9f8a7b6c ended")).toBe("session <redacted> ended");
    expect(scrub("workspace 0d2f7b9e-8a5c-4d3e-9f1a-2b6c8e0d4a7f closed")).toBe("workspace <redacted> closed");
  });

  it("removes the host from Node's network errors", () => {
    expect(scrub("getaddrinfo ENOTFOUND sync.acme-corp.internal")).toBe("getaddrinfo ENOTFOUND <host>");
    expect(scrub("getaddrinfo EAI_AGAIN sync.acme-corp.internal")).toBe("getaddrinfo EAI_AGAIN <host>");
    expect(scrub("connect ECONNREFUSED 10.0.0.5:443")).toBe("connect ECONNREFUSED <host>");
    expect(scrub("connect ECONNREFUSED ::1:443")).toBe("connect ECONNREFUSED <host>");
    expect(scrub("connect ETIMEDOUT sync.acme-corp.internal:443")).toBe("connect ETIMEDOUT <host>");
    expect(scrub("getaddrinfo sync.acme-corp.internal")).toBe("getaddrinfo <host>");
    expect(scrub("Connect Timeout Error (attempted address: sync.acme-corp.internal:443, timeout: 10000ms)"))
      .toBe("Connect Timeout Error (attempted address: <host>, timeout: 10000ms)");
    // Ordinary words after "connect" stay.
    expect(scrub("dohc could not connect to the server")).toBe("dohc could not connect to the server");
  });

  it("removes IPv6 addresses", () => {
    expect(scrub("listening on fe80::1ff:fe23:4567:890a")).toBe("listening on <ip>");
    expect(scrub("peer 2001:db8::7 closed")).toBe("peer <ip> closed");
    expect(scrub("bound to [::1]:4000")).toBe("bound to [<ip>]:4000");
  });

  it("does not take a sibling of dohc's folder for dohc's own", () => {
    const programs = resolve("dohc-install", "Programs");
    const own = createCrashScrubber([join(programs, "dohc")], process.platform);
    expect(own(`at x (${join(programs, "dohcx", "other.js")}:1:1)`)).toBe("at x (<path>)");
    expect(own(`at x (${join(programs, "dohc-notes", "secret.md")}:1:1)`)).toBe("at x (<path>)");
    expect(own(`at x (${join(programs, "dohc", "resources", "app.asar")}:1:1)`)).toBe("at x (<dohc>/resources/app.asar:1:1)");
    const checkout = createCrashScrubber(["/home/sam/dev/dohc"], "linux");
    expect(checkout("read /home/sam/dev/dohc-notes/secret.md")).toBe("read <path>");
    expect(checkout("at x (/home/sam/dev/dohc/apps/desktop/out/main/index.js:3:1)"))
      .toBe("at x (<dohc>/apps/desktop/out/main/index.js:3:1)");
  });

  it("removes a home-relative path", () => {
    expect(scrub("open ~/Documents/Trip plans/budget.md")).toBe("open ~<path>");
  });

  it("removes every kind of named token, and a JSON Web Token", () => {
    expect(scrub("access_token=abcdef12 next")).toBe("access_token=<redacted> next");
    expect(scrub("refresh_token=short1")).toBe("refresh_token=<redacted>");
    expect(scrub("x-api-key: k1")).toBe("x-api-key: <redacted>");
    expect(scrub("got eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.c2ln from the relay")).toBe("got <redacted> from the relay");
  });

  it("removes a quoted or bare path that holds an apostrophe", () => {
    expect(scrub("open 'C:\\Users\\sam\\Ice's notes.md' failed")).toBe("open '…' failed");
    expect(scrub("open C:\\Users\\sam\\Ice's notes.md")).toBe("open <path>");
    expect(scrub("open '/home/sam/Ice's notes.md'")).toBe("open '…'");
    expect(scrub("rename 'Ice's notes' to 'Plans'")).toBe("rename '…' to '…'");
  });

  it("removes any host name, after any error code, and keeps code file names", () => {
    expect(scrub("connect ECONNABORTED relay.acme.internal:443")).toBe("connect ECONNABORTED <host>");
    expect(scrub("connect EADDRNOTAVAIL relay:443")).toBe("connect EADDRNOTAVAIL <host>");
    expect(scrub("Failed to connect to relay.acme.internal port 443")).toBe("Failed to connect to <host> port 443");
    expect(scrub(
      "Hostname/IP does not match certificate's altnames: Host: relay.acme.internal. is not in the cert's altnames: DNS:*.acme.com, DNS:acme.com",
    )).toBe(
      "Hostname/IP does not match certificate's altnames: Host: <host>. is not in the cert's altnames: DNS:<host>, DNS:<host>",
    );
    expect(scrub("WebSocket to RELAY.Acme.Internal:8443 closed")).toBe("WebSocket to <host> closed");
    expect(scrub("Cannot find module index.js from package.json")).toBe("Cannot find module index.js from package.json");
    // A document's name is not a code file, so it goes too.
    expect(scrub("could not settle budget.md")).toBe("could not settle <host>");
    // Stack frames keep their dotted function names.
    expect(scrub("at Promise.all (index 0)")).toBe("at Promise.all (index 0)");
    expect(scrub("at process.emit (node:events:517:28)")).toBe("at process.emit (node:events:517:28)");
  });

  it("removes a quoted value that is left open, however long", () => {
    const long = `open '${"a".repeat(300)} Ice's ${"b".repeat(400)}' failed`;
    expect(scrub(long)).toBe("open '…");
    expect(scrub("Unexpected token 'h', \"hello wor…")).toBe("Unexpected token '…', \"…");
    expect(scrub("rename 'Ice's notes' to 'Plans'")).toBe("rename '…' to '…'");
  });

  it("scrubs a long run in time that grows with its length", () => {
    // Each of these once restarted at every character: 3 to 4 s at 50,000
    // characters. Linear work is milliseconds, so allow 10 µs a character.
    for (const hostile of ["a.".repeat(100_000), "a-".repeat(100_000), `${"a-".repeat(100_000)}x`]) {
      const started = performance.now();
      scrub(hostile);
      expect(performance.now() - started).toBeLessThan(hostile.length * 0.01);
    }
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

  it("uses the folder that holds a packaged build's code, on macOS too", () => {
    expect(crashReportRoot({
      isPackaged: true,
      appPath: "/Applications/dohc.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/dohc.app/Contents/Resources",
    }).replace(/\\/g, "/")).toBe("/Applications/dohc.app/Contents");
    const mac = createCrashScrubber(["/Applications/dohc.app/Contents"], "darwin");
    expect(mac("at open (/Applications/dohc.app/Contents/Resources/app.asar/out/main/index.js:4:2)"))
      .toBe("at open (<dohc>/Resources/app.asar/out/main/index.js:4:2)");
    expect(crashReportRoot({ isPackaged: false, appPath: join(INSTALL, "apps", "desktop"), resourcesPath: "unused" }))
      .toBe(INSTALL);
  });

  it("never scrubs more than one line's worth, however long the error", () => {
    const seen: number[] = [];
    const measuring = (text: string) => {
      seen.push(text.length);
      return scrub(text);
    };
    const error = new Error(`open '${"x".repeat(200_000)}`);
    error.stack = `Error: x\n    at ${"y".repeat(200_000)}\n`;
    error.cause = "z".repeat(200_000);
    const text = formatCrashEvent({ kind: "main-exception", error, origin: "uncaughtException" }, FACTS, measuring);
    expect(seen).toHaveLength(3);
    expect(Math.max(...seen)).toBeLessThanOrEqual(500);
    expect(text).toContain("Error: Error: open '…");
    expect(text).not.toContain("xxx");
  });

  it("bounds one problem and puts a header on the report", () => {
    const error = new Error("x".repeat(20_000));
    error.stack = `Error: x\n${"    at deep (node:internal/x:1:1)\n".repeat(200)}`;
    const text = formatCrashEvent({ kind: "main-exception", error, origin: "uncaughtException" }, FACTS, scrub);
    expect(text.length).toBeLessThanOrEqual(CRASH_EVENT_MAX_CHARS);
    expect(crashReportText(["one", "two"], 3)).toBe("dohc crash report\n\nEarlier problems left out: 3\n\none\n\ntwo");
  });
});
