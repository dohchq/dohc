import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CRASH_EVENT_MAX_CHARS,
  crashReportRoot,
  crashReportText,
  createCodeFrames,
  formatCrashEvent,
  type CrashFacts,
} from "./crashReport";

const INSTALL = resolve("dohc-install", "Programs", "dohc");
const codeFrame = createCodeFrames([INSTALL], process.platform);
const BUNDLE = join(INSTALL, "resources", "app.asar", "out", "main", "index.js");
// Windows folds dohc's own paths to lower case; elsewhere they keep theirs.
const BUNDLE_REL = "/resources/app.asar/out/main/index.js";

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

function mainError(error: unknown): string {
  return formatCrashEvent({ kind: "main-exception", error, origin: "uncaughtException" }, FACTS, codeFrame);
}

function withStack(message: string, frames: string[]): Error {
  const error = new Error(message);
  error.stack = [`Error: ${message}`, ...frames.map((frame) => `    ${frame}`)].join("\n");
  return error;
}

describe("crash report stack frames", () => {
  it("keeps a frame inside dohc's own code as a dohc path, in every spelling", () => {
    expect(codeFrame(`at open (${BUNDLE}:12:5)`)).toBe(`at <dohc>${BUNDLE_REL}:12:5`);
    expect(codeFrame(`at ${BUNDLE}:12:5`)).toBe(`at <dohc>${BUNDLE_REL}:12:5`);
    expect(codeFrame(`at async open (${pathToFileURL(BUNDLE).href}:1:2)`)).toBe(`at <dohc>${BUNDLE_REL}:1:2`);
  });

  it("withholds every other frame", () => {
    for (const frame of [
      "at C:\\Users\\sam\\Plans (Acquisition)\\draft.js:1:1",
      "at run (C:\\Users\\sam\\Plans (Acquisition)\\draft.js:1:1)",
      "at run (/Private Work/计划.md:3:1)",
      "at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      `at x (${join(resolve("dohc-install", "Programs"), "dohc-notes", "secret.js")}:1:1)`,
      `at x (${join(INSTALL, "..", "elsewhere.js")}:1:1)`,
      `at x (${join(INSTALL, "notes", "Trip plans.js")}:1:1)`,
      "at new Promise (<anonymous>)",
      `at eval (eval at run (${BUNDLE}:1:2), <anonymous>:3:4)`,
    ]) {
      expect(codeFrame(frame), frame).toBe("<frame>");
    }
  });

  it("uses the folder that holds a packaged build's code, on macOS too", () => {
    expect(crashReportRoot({
      isPackaged: true,
      appPath: "/Applications/dohc.app/Contents/Resources/app.asar",
      resourcesPath: "/Applications/dohc.app/Contents/Resources",
    }).replace(/\\/g, "/")).toBe("/Applications/dohc.app/Contents");
    const mac = createCodeFrames(["/Applications/dohc.app/Contents"], "darwin");
    expect(mac("at open (/Applications/dohc.app/Contents/Resources/app.asar/out/main/index.js:4:2)"))
      .toBe("at <dohc>/Resources/app.asar/out/main/index.js:4:2");
    expect(crashReportRoot({ isPackaged: false, appPath: join(INSTALL, "apps", "desktop"), resourcesPath: "unused" }))
      .toBe(INSTALL);
  });
});

describe("crash report messages", () => {
  it("withholds a message dohc did not write from a known template, and keeps the class", () => {
    for (const message of [
      "Cookie: theme=light; sid=abc123",
      "open /Private Work/计划.md",
      "Workspace Acquisition Planning failed",
      "Cannot read properties of undefined (reading 'title')",
    ]) {
      const text = mainError(new TypeError(message));
      expect(text).toContain("Error: TypeError: <message withheld>");
      expect(text).not.toContain(message);
    }
  });

  it("keeps Node's code and system call, and withholds the message that names the path", () => {
    const error = Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\Users\\sam\\plan.md'"), {
      code: "ENOENT", syscall: "open", errno: -4058,
    });
    expect(mainError(error)).toContain("Error: Error: <message withheld> (code ENOENT, syscall open)");
  });

  it("withholds a name, code, engine code, or system call that is not on a known list", () => {
    const error = Object.assign(new Error("x"), {
      name: "AcquisitionPlan", code: "sk_live_abc123", wireCode: "Acme_Merger", syscall: "open_acme_plans",
    });
    const text = mainError(error);
    expect(text).toContain("Error: <withheld>: <message withheld> (code <withheld>, code <withheld>, syscall <withheld>)");
    for (const secret of ["AcquisitionPlan", "sk_live_abc123", "Acme_Merger", "open_acme_plans"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("writes an engine message again from its template, never from the error's own words", () => {
    const engineError = (message: string) => Object.assign(new Error(message), { name: "EngineDaemonUnavailableError" });
    expect(mainError(engineError(
      "The Rust engine crashed again after 10 restarts in the last Acme merger plans. The limit is 10 restarts per Acme merger plans. dohc stopped restarting it.",
    ))).toContain(
      "The Rust engine crashed again after 10 restarts in the last a window. The limit is 10 restarts per a window. dohc stopped restarting it.",
    );
    expect(mainError(engineError("Rust engine daemon exited unexpectedly with signal ACMEPLANS.")))
      .toContain("Rust engine daemon exited unexpectedly with signal <withheld>.");
    expect(mainError(engineError("Rust engine acme.merger.plans timed out after 5000ms.")))
      .toContain("EngineDaemonUnavailableError: Rust engine request timed out after 5000ms.");
    expect(mainError(engineError(
      "The Rust engine crashed again after 3 restarts in the last 10 minutes. The limit is 10 restarts per 10 minutes. dohc stopped restarting it.",
    ))).toContain("in the last 10 minutes. The limit is 10 restarts per 10 minutes.");
    // A class that is not the supervisor's keeps no message, even a template.
    expect(mainError(Object.assign(new Error("Rust engine restart limit exceeded after 3 attempts."), { name: "TypeError" })))
      .toContain("TypeError: <message withheld>");
  });

  it("keeps an engine refusal's code", () => {
    const error = Object.assign(new Error("The file notes/plan.md is open"), { name: "DaemonRefusalError", wireCode: "SHARE_READ_ONLY" });
    expect(mainError(error)).toContain("Error: DaemonRefusalError: <message withheld> (code SHARE_READ_ONLY)");
  });

  it("keeps the engine supervisor's messages, which are fixed templates", () => {
    const engineError = (message: string, cause?: unknown) =>
      Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { name: "EngineDaemonUnavailableError" });
    const exit = engineError("Rust engine daemon exited unexpectedly with code 101.");
    const terminal = engineError("Rust engine restart limit exceeded after 3 attempts.", exit);
    const text = formatCrashEvent({ kind: "engine", error: terminal, stage: "stopped" }, { ...FACTS, packaged: false }, codeFrame);
    expect(text).toContain("Process: workspace engine");
    expect(text).toContain("What happened: The workspace engine failed again, and dohc stopped restarting it.");
    expect(text).toContain("Version: 0.9.0 (latest, development build)");
    expect(text).toContain("Error: EngineDaemonUnavailableError: Rust engine restart limit exceeded after 3 attempts.");
    expect(text).toContain("Caused by: EngineDaemonUnavailableError: Rust engine daemon exited unexpectedly with code 101.");
    expect(text).not.toContain("    at ");
    // The one supervisor message with a path in it is withheld.
    expect(mainError(engineError("Rust engine binary not found: C:\\Users\\sam\\dohc.exe")))
      .toContain("EngineDaemonUnavailableError: <message withheld>");
  });

  it("writes the facts, then the error and its frames", () => {
    const error = withStack("the title of Trip plans", [
      `at render (${BUNDLE}:40:7)`,
      "at C:\\Users\\sam\\AppData\\Local\\Temp\\plugin.js:1:1",
      "at node:internal/process/task_queues:95:5",
    ]);
    expect(mainError(error)).toBe([
      "Time: 2026-09-25T10:00:00.000Z",
      "Process: main",
      "What happened: Uncaught exception",
      "Version: 0.9.0 (latest)",
      "System: Windows_NT 10.0.22631 x64",
      "Electron: 43.3.0",
      "Running for: 125 s",
      "Error: Error: <message withheld>",
      `    at <dohc>${BUNDLE_REL}:40:7`,
      "    <frame>",
    ].join("\n"));
  });

  it("never spells out a thrown value, and keeps only a known class name", () => {
    expect(mainError("lost C:\\Users\\sam\\notes.md")).toContain("Error: a value of type string");
    expect(mainError({ secret: "x" })).toContain("Error: a value of type object");
    const named = Object.assign(new Error("x"), { name: "Plans for Acme" });
    expect(mainError(named)).toContain("Error: <withheld>: <message withheld>");
  });

  it("names a process that ended, keeping only Chromium's own words", () => {
    const text = formatCrashEvent({
      kind: "process-gone", source: "utility", name: "network.mojom.NetworkService", reason: "crashed", exitCode: -1073741819,
    }, FACTS, codeFrame);
    expect(text).toContain("Process: utility (network.mojom.NetworkService)");
    expect(text).toContain("Reason: crashed");
    expect(text).toContain("Exit code: -1073741819");
  });

  it("bounds one problem and puts a header on the report", () => {
    const error = withStack("x", Array<string>(200).fill(`at deep (${BUNDLE}:1:1)`));
    error.cause = withStack("y", Array<string>(200).fill(`at deep (${BUNDLE}:1:1)`));
    expect(mainError(error).length).toBeLessThanOrEqual(CRASH_EVENT_MAX_CHARS);
    expect(crashReportText(["one", "two"], 3)).toBe("dohc crash report\n\nEarlier problems left out: 3\n\none\n\ntwo");
  });
});
