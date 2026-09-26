import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installCrashCapture } from "./crashCapture";
import type { CrashEvent } from "./crashReport";

type Listener = (...args: never[]) => void;

function fakeTarget(windowPages: readonly string[]) {
  const listeners = new Map<string, Listener>();
  const on = (event: string, listener: Listener) => {
    listeners.set(event, listener);
    return undefined;
  };
  const recorded: CrashEvent[] = [];
  installCrashCapture<string>({
    process: { on },
    app: { on },
    isWindowPage: (contents) => windowPages.includes(contents),
    record: (event) => recorded.push(event),
  });
  const emit = (event: string, ...args: unknown[]) =>
    (listeners.get(event) as ((...values: unknown[]) => void) | undefined)?.(...args);
  return { recorded, emit };
}

describe("crash capture", () => {
  it("records an uncaught exception in main without handling it", () => {
    const { recorded, emit } = fakeTarget([]);
    const error = new Error("boom");
    emit("uncaughtExceptionMonitor", error, "uncaughtException");
    expect(recorded).toEqual([{ kind: "main-exception", error, origin: "uncaughtException" }]);
  });

  it("records a dohc window's crash but not an app page's, and not a clean or outside end", () => {
    const { recorded, emit } = fakeTarget(["window"]);
    emit("render-process-gone", {}, "window", { reason: "crashed", exitCode: -1 });
    emit("render-process-gone", {}, "plugin-page", { reason: "crashed", exitCode: -1 });
    emit("render-process-gone", {}, "window", { reason: "clean-exit", exitCode: 0 });
    emit("render-process-gone", {}, "window", { reason: "killed", exitCode: 1 });
    expect(recorded).toEqual([
      { kind: "process-gone", source: "window", name: null, reason: "crashed", exitCode: -1 },
    ]);
  });

  it("records GPU and Chromium service crashes, and leaves processes dohc forks to their owners", () => {
    const { recorded, emit } = fakeTarget([]);
    emit("child-process-gone", {}, { type: "GPU", reason: "abnormal-exit", exitCode: 34 });
    emit("child-process-gone", {}, {
      type: "Utility", serviceName: "network.mojom.NetworkService", name: "Network Service", reason: "oom", exitCode: 1,
    });
    emit("child-process-gone", {}, {
      type: "Utility", serviceName: "node.mojom.NodeService", name: "dohc-plugin-host", reason: "crashed", exitCode: 1,
    });
    emit("child-process-gone", {}, { type: "GPU", reason: "memory-eviction", exitCode: 0 });
    expect(recorded).toEqual([
      { kind: "process-gone", source: "gpu", name: "GPU", reason: "abnormal-exit", exitCode: 34 },
      { kind: "process-gone", source: "utility", name: "network.mojom.NetworkService", reason: "oom", exitCode: 1 },
    ]);
  });
});

describe("crash report code", () => {
  // A crash report leaves this computer only through the store's send, which
  // only Send report reaches. Relay and notice code syncs on its own, so the
  // crash code must never route a report through it.
  it("reaches no relay or notice code, and fetches only in send", () => {
    const sources = readdirSync(__dirname)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => ({ name, source: readFileSync(join(__dirname, name), "utf8") }));
    for (const { name, source } of sources) {
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      expect(imports.filter((specifier) => /relay|notice|workspaces\/|electron$/.test(specifier ?? "")), name)
        .toEqual([]);
      expect(source.match(/\bfetch\w*\(/g) ?? [], name).toEqual(name === "crashReportStore.ts" ? ["fetchReport("] : []);
    }
  });
});
