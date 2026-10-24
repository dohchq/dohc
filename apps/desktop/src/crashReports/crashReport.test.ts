import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EngineDaemonUnavailableError } from "@dohc/workspace-engine-client/daemon";
import { describe, expect, it } from "vitest";
import { ipcWireError } from "../ipc/errorWords";
import {
  CRASH_EVENT_MAX_CHARS,
  crashReportRoot,
  crashReportText,
  createCodeFrames,
  createCodeLocations,
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

describe("code locations for error reports", () => {
  it("keeps a file name's own case, which Windows folds for the report text", () => {
    const asset = join(INSTALL, "resources", "app.asar", "dist", "renderer", "assets", "Index-AbC9.js");
    const frame = `at render (${asset}:7:8)`;
    expect(createCodeLocations([INSTALL.toUpperCase()], "win32")(frame))
      .toEqual({ path: "/resources/app.asar/dist/renderer/assets/Index-AbC9.js", line: 7, column: 8 });
    expect(createCodeFrames([INSTALL], "win32")(frame))
      .toBe("at <dohc>/resources/app.asar/dist/renderer/assets/index-abc9.js:7:8");
    expect(createCodeLocations([INSTALL], process.platform)(`at x (${join(INSTALL, "..", "elsewhere.js")}:1:1)`)).toBeNull();
  });
});

describe("crash report messages", () => {
  it("keeps the compiler timeout type while withholding its message and details", () => {
    const details = "Last stage: worker ready; elapsed=1000ms; stderr tail: [redacted stderr]; ENOMEM";
    const timeout = Object.assign(new Error("The app took too long to build."), { name: "AppCompilerTimeoutError", details });
    for (const error of [timeout, ipcWireError(timeout)]) {
      const text = mainError(error);
      expect(text).toContain("Error: AppCompilerTimeoutError: <message withheld>");
      expect(text).not.toContain(timeout.message);
      expect(text).not.toContain("Last stage:");
      expect(text).not.toContain("stderr tail:");
      expect(text).not.toContain("ENOMEM");
    }
  });

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
    const engineError = (message: string) => new EngineDaemonUnavailableError(message);
    expect(mainError(engineError(
      "The Rust engine crashed again after 10 restarts in the last Acme merger plans. The limit is 10 restarts per Acme merger plans. dohc stopped restarting it.",
    ))).toContain(
      "EngineDaemonUnavailableError: <message withheld>",
    );
    expect(mainError(engineError("Rust engine daemon exited unexpectedly with signal ACMEPLANS.")))
      .toContain("Rust engine daemon exited unexpectedly with signal <withheld>.");
    expect(mainError(engineError("Rust engine acme.merger.plans timed out after 5000ms.")))
      .toContain("EngineDaemonUnavailableError: Rust engine <withheld> timed out after 5000ms.");
    expect(mainError(engineError(
      "The Rust engine crashed again after 10 restarts in the last 10 minutes. The limit is 10 restarts per 10 minutes. dohc stopped restarting it.",
    ))).toContain("in the last 10 minutes. The limit is 10 restarts per 10 minutes.");
    // A class that is not the supervisor's keeps no message, even a template.
    expect(mainError(Object.assign(new Error("Rust engine restart limit exceeded after 3 attempts."), { name: "TypeError" })))
      .toContain("TypeError: <message withheld>");
  });

  it("withholds supervisor messages from spoofed names, including causes", () => {
    for (const attempts of ["3", "15551234567"]) {
      const message = `Rust engine restart limit exceeded after ${attempts} attempts.`;
      const spoof = Object.assign(new Error(message), { name: "EngineDaemonUnavailableError" });
      for (const error of [spoof, new EngineDaemonUnavailableError("Rust engine failed its startup handshake.", { cause: spoof })]) {
        const text = formatCrashEvent({ kind: "engine", error, stage: "stopped" }, FACTS, codeFrame);
        expect(text).toContain("EngineDaemonUnavailableError: <message withheld>");
        expect(text).not.toContain(message);
        expect(text).not.toContain("15551234567");
      }
    }
  });

  it("keeps only the desktop supervisor's configured numbers", () => {
    const messages = [
      "Rust engine restart limit exceeded after 3 attempts.",
      "The Rust engine crashed again after 10 restarts in the last 10 minutes. The limit is 10 restarts per 10 minutes. dohc stopped restarting it.",
      "The Rust engine went silent on 2 launches: 3 probes in a row expired after 45000ms each with no frame of any kind from the engine. The limit is 2 wedges with no traffic in between. dohc stopped restarting it.",
      "The Rust engine is running but sent nothing: 3 probes in a row expired after 45000ms each with no frame of any kind from the engine. The limit is 3 probes with no traffic. dohc is restarting it.",
    ];
    for (const message of messages) {
      expect(mainError(new EngineDaemonUnavailableError(message))).toContain(message);
      for (const match of message.matchAll(/\d+/g)) {
        for (const invalid of ["0", "15551234567", "9".repeat(400)]) {
          const changed = message.slice(0, match.index) + invalid + message.slice(match.index + match[0].length);
          const text = mainError(new EngineDaemonUnavailableError(changed));
          expect(text).toContain("EngineDaemonUnavailableError: <message withheld>");
          expect(text).not.toContain(changed);
        }
      }
    }
  });

  it("preserves issued RPC names in invalid-result diagnostics", () => {
    for (const method of ["workspace.open", "workspace.close", "versions.active",
      "search.queryChatMessagesGranular", "chats.readState.listUnreadFileThreads", "ydoc.open", "keys.download"]) {
      const message = `Rust engine ${method} returned an invalid result.`;
      expect(mainError(new EngineDaemonUnavailableError(message))).toContain(message);
    }
  });

  it("keeps a timeout diagnostic while withholding an unknown method", () => {
    const text = mainError(new EngineDaemonUnavailableError("Rust engine acme.merger.plans timed out after 5000ms."));
    expect(text).toContain("EngineDaemonUnavailableError: Rust engine <withheld> timed out after 5000ms.");
    expect(text).not.toContain("acme.merger.plans");
  });

  it("keeps engine.ping in lifecycle diagnostics", () => {
    for (const message of [
      "Rust engine engine.ping returned an invalid result.",
      "Rust engine engine.ping timed out after 5000ms.",
      "Rust engine engine.ping got no answer: a probe expired after 45000ms with no frame of any kind from the engine.",
    ]) {
      expect(mainError(new EngineDaemonUnavailableError(message))).toContain(message);
    }
  });

  it("reconstructs current lifecycle caps, read budgets, and silence diagnostics", () => {
    for (const message of [
      "Rust engine workspace.open timed out after 120000ms.",
      "Rust engine workspace.close timed out after 10000ms.",
      "Rust engine versions.active timed out after 5000ms.",
      "Rust engine search.queryChatMessagesGranular timed out after 8732ms.",
      "Rust engine workspace.open timed out after 1ms.",
      "Rust engine search.queryChatMessagesGranular did not start within its 10000ms budget.",
      "Rust engine chats.readState.listUnreadFileThreads ran out of its 10000ms budget before the read.",
      "Rust engine workspace.open got no answer: a probe expired after 45000ms with no frame of any kind from the engine.",
    ]) {
      expect(mainError(new EngineDaemonUnavailableError(message))).toContain(message);
    }
  });

  it("withholds unknown RPCs, method-shaped filenames, paths, and forged templates in nested causes", () => {
    const templates = [
      (method: string) => `Rust engine ${method} returned an invalid result.`,
      (method: string) => `Rust engine ${method} timed out after 120000ms.`,
      (method: string) => `Rust engine ${method} did not start within its 10000ms budget.`,
      (method: string) => `Rust engine ${method} ran out of its 10000ms budget before the read.`,
      (method: string) => `Rust engine ${method} got no answer: a probe expired after 45000ms with no frame of any kind from the engine.`,
    ];
    const sensitiveMethods = ["acme.merger.plans", "files.drain", "liveApplication.resumeRestore",
      "engine.ping.md", "workspace.open.backup", "ENGINE.PING",
      "C:\\Users\\sam\\engine.ping", "/Private/engine.ping", "engine.ping/secret", "engine.ping\u0000secret"];
    for (const method of sensitiveMethods) {
      for (const template of templates) {
        const error = new EngineDaemonUnavailableError("Rust engine failed its startup handshake.", {
          cause: new EngineDaemonUnavailableError(template(method)),
        });
        const text = crashReportText([formatCrashEvent({ kind: "engine", error, stage: "startup" }, FACTS, codeFrame)], 0);
        expect(text).toContain(`Caused by: EngineDaemonUnavailableError: ${template("<withheld>")}`);
        expect(text).not.toContain(method);
      }
    }
    const sensitiveMessages = [
      ...templates.flatMap((template) => [
        `secret ${template("engine.ping")}`, `${template("engine.ping")} /Private/secret.md`,
        `${template("engine.ping")}\nsecret`,
      ]),
      ...["0", "-1", "1.5", "0120000", "120001", "15551234567", "9".repeat(400), "/Private/secret.md"]
        .map((cap) => `Rust engine workspace.open timed out after ${cap}ms.`),
      "Rust engine engine.ping got no answer: a probe expired after 15551234567ms with no frame of any kind from the engine.",
      "Rust engine workspace.open did not start within its 15551234567ms budget.",
      "Rust engine workspace.open ran out of its 15551234567ms budget before the read.",
    ];
    for (const message of sensitiveMessages) {
      const error = new EngineDaemonUnavailableError("Rust engine failed its startup handshake.", {
        cause: new EngineDaemonUnavailableError("Rust engine workspace.open returned an invalid result.", {
          cause: new EngineDaemonUnavailableError(message),
        }),
      });
      const text = crashReportText([formatCrashEvent({ kind: "engine", error, stage: "startup" }, FACTS, codeFrame)], 0);
      expect(text, message).toContain("Caused by: EngineDaemonUnavailableError: <message withheld>");
      expect(text, message).not.toContain(message);
      for (const sensitive of [...sensitiveMethods, "secret", "15551234567"]) expect(text).not.toContain(sensitive);
    }
    for (const message of templates.map((template) => template("engine.ping"))) {
      const spoof = Object.assign(new Error(message), { name: "EngineDaemonUnavailableError" });
      for (const error of [new Error(message), spoof, new EngineDaemonUnavailableError("unknown", { cause: spoof })]) {
        expect(mainError(error)).not.toContain(message);
      }
    }
  });

  it("keeps the no-progress diagnostic and withholds an unknown method", () => {
    for (const [method, expected] of [["engine.ping", "engine.ping"], ["private.plan", "<withheld>"]]) {
      const message = `Rust engine ${method} made no progress while the daemon was responding.`;
      expect(mainError(new EngineDaemonUnavailableError(message)))
        .toContain(`EngineDaemonUnavailableError: Rust engine ${expected} made no progress while the daemon was responding.`);
      if (method !== expected) expect(mainError(new EngineDaemonUnavailableError(message))).not.toContain(method);
      for (const suffix of [" private plan", "\n"]) {
        expect(mainError(new EngineDaemonUnavailableError(message + suffix)))
          .toContain("EngineDaemonUnavailableError: <message withheld>");
      }
      expect(mainError(new Error(message))).toContain("Error: Error: <message withheld>");
    }
  });

  it("keeps the retired-generation diagnostic only as an exact supervisor sentence", () => {
    const message = "Rust engine request generation was retired.";
    expect(mainError(new EngineDaemonUnavailableError(message))).toContain(`EngineDaemonUnavailableError: ${message}`);
    for (const suffix of [" private plan", "\n"]) {
      expect(mainError(new EngineDaemonUnavailableError(message + suffix)))
        .toContain("EngineDaemonUnavailableError: <message withheld>");
    }
    expect(mainError(new Error(message))).toContain("Error: Error: <message withheld>");
  });

  it("withholds a template with a trailing newline", () => {
    const message = "Rust engine workspace.open timed out after 5000ms.";
    const text = formatCrashEvent({
      kind: "engine", error: new EngineDaemonUnavailableError(`${message}\n`), stage: "startup",
    }, FACTS, codeFrame);
    expect(text.endsWith("EngineDaemonUnavailableError: <message withheld>")).toBe(true);
    expect(text.endsWith("\n")).toBe(false);
  });

  it("preserves allowed diagnostics through nested causes while withholding free text", () => {
    const privateMessage = "Cookie: sid=private-token; /Private/Acquisition.md";
    const error = new EngineDaemonUnavailableError("Rust engine failed its startup handshake.", {
      cause: new EngineDaemonUnavailableError("Rust engine workspace.open timed out after 120000ms.", {
        cause: new EngineDaemonUnavailableError("Rust engine workspace.close returned an invalid result.", {
          cause: new Error(privateMessage),
        }),
      }),
    });
    const text = crashReportText([formatCrashEvent({ kind: "engine", error, stage: "startup" }, FACTS, codeFrame)], 0);
    expect(text).toContain("Caused by: EngineDaemonUnavailableError: Rust engine workspace.open timed out after 120000ms.");
    expect(text).toContain("Caused by: EngineDaemonUnavailableError: Rust engine workspace.close returned an invalid result.");
    expect(text).toContain("Caused by: Error: <message withheld>");
    for (const sensitive of ["private-token", "/Private/Acquisition.md", privateMessage]) expect(text).not.toContain(sensitive);
  });

  it("bounds supervisor exit codes to signed or unsigned 32-bit integers", () => {
    for (const code of [-2147483648, -1073741819, 0, 101, 4294967295]) {
      const message = `Rust engine daemon exited unexpectedly with code ${code}.`;
      expect(mainError(new EngineDaemonUnavailableError(message))).toContain(message);
    }
    for (const code of ["-2147483649", "4294967296", "15551234567", "1.5", "9".repeat(400)]) {
      const message = `Rust engine daemon exited unexpectedly with code ${code}.`;
      expect(mainError(new EngineDaemonUnavailableError(message))).toContain("EngineDaemonUnavailableError: <message withheld>");
    }
  });

  it("keeps an engine refusal's code", () => {
    const error = Object.assign(new Error("The file notes/plan.md is open"), { name: "DaemonRefusalError", wireCode: "SHARE_READ_ONLY" });
    expect(mainError(error)).toContain("Error: DaemonRefusalError: <message withheld> (code SHARE_READ_ONLY)");
  });

  it("keeps the engine supervisor's messages, which are fixed templates", () => {
    const engineError = (message: string, cause?: unknown) =>
      new EngineDaemonUnavailableError(message, cause === undefined ? undefined : { cause });
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

  it("still writes the report when an error's stack is not text", () => {
    for (const stack of [42, { toString: () => `    at x (C:\\Users\\sam\\Trip plans.js:1:1)` }]) {
      const cause = Object.assign(new Error("open C:\\Users\\sam\\Trip plans.md"), { code: "ENOENT", stack });
      const error = Object.assign(new TypeError("the title of Trip plans", { cause }), { stack });
      const main = mainError(error);
      expect(main.split("\n").slice(-2)).toEqual([
        "Error: TypeError: <message withheld>",
        "Caused by: Error: <message withheld> (code ENOENT)",
      ]);
      const engine = formatCrashEvent({
        kind: "engine",
        stage: "stopped",
        error: Object.assign(new EngineDaemonUnavailableError("Rust engine restart limit exceeded after 3 attempts.", {
          cause: Object.assign(new EngineDaemonUnavailableError("Rust engine daemon exited unexpectedly with code 101."), { stack }),
        }), { stack }),
      }, FACTS, codeFrame);
      expect(engine.split("\n").slice(-2)).toEqual([
        "Error: EngineDaemonUnavailableError: Rust engine restart limit exceeded after 3 attempts.",
        "Caused by: EngineDaemonUnavailableError: Rust engine daemon exited unexpectedly with code 101.",
      ]);
      for (const text of [main, engine]) {
        expect(text).not.toContain("Trip plans");
        expect(text).not.toContain("sam");
      }
    }
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
