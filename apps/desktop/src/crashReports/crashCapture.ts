import type { CrashEvent } from "./crashReport";

// The reasons Electron gives that are crashes. A clean exit is not one,
// "killed" means something outside dohc ended the process, and
// "memory-eviction" is Chromium discarding a page on purpose.
const CRASH_REASONS = new Set(["crashed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"]);

// The service name of every utility process dohc forks itself. Those run
// plugin and app code, and their owners already report their failures.
const FORKED_UTILITY_SERVICE = "node.mojom.NodeService";

// STATUS_DLL_INIT_FAILED_LOGOFF: Windows refused to start a process because
// the session was logging off. Electron calls it a crash.
const LOGOFF_EXIT_CODE = 0xc000026b;

interface ProcessGoneDetails {
  reason: string;
  exitCode: number;
}

interface ChildProcessGoneDetails extends ProcessGoneDetails {
  type: string;
  serviceName?: string;
  name?: string;
}

// Windows sends each window session-end when it ends the session.
interface SessionWindow {
  on(event: "session-end", listener: () => void): unknown;
}

export interface CrashCaptureTarget<Contents> {
  process: {
    on(
      event: "uncaughtExceptionMonitor",
      listener: (error: Error, origin: "uncaughtException" | "unhandledRejection") => void,
    ): unknown;
  };
  app: {
    on(
      event: "render-process-gone",
      listener: (event: unknown, contents: Contents, details: ProcessGoneDetails) => void,
    ): unknown;
    on(
      event: "child-process-gone",
      listener: (event: unknown, details: ChildProcessGoneDetails) => void,
    ): unknown;
    on(event: "will-quit", listener: () => void): unknown;
    on(event: "browser-window-created", listener: (event: unknown, window: SessionWindow) => void): unknown;
  };
  // Whether the contents are a dohc window's own page, not an app or plugin
  // page shown inside one.
  isWindowPage(contents: Contents): boolean;
  record(event: CrashEvent): void;
}

/**
 * Records every crash main can see. The monitor event observes an uncaught
 * exception without handling it, so Electron's own handling stays as it is.
 * Electron's main process only warns about an unhandled rejection, so one
 * is not a crash here. A process that ends once dohc quits, or once Windows
 * ends the session, was ended for that reason and did not crash.
 */
export function installCrashCapture<Contents>(target: CrashCaptureTarget<Contents>): void {
  let ending = false;
  target.app.on("will-quit", () => { ending = true; });
  target.app.on("browser-window-created", (_event, window) => {
    window.on("session-end", () => { ending = true; });
  });
  const crashed = ({ reason, exitCode }: ProcessGoneDetails) =>
    !ending && CRASH_REASONS.has(reason) && exitCode >>> 0 !== LOGOFF_EXIT_CODE;

  target.process.on("uncaughtExceptionMonitor", (error, origin) => {
    target.record({ kind: "main-exception", error, origin });
  });
  target.app.on("render-process-gone", (_event, contents, details) => {
    if (!crashed(details) || !target.isWindowPage(contents)) return;
    target.record({
      kind: "process-gone", source: "window", name: null,
      reason: details.reason, exitCode: details.exitCode,
    });
  });
  target.app.on("child-process-gone", (_event, details) => {
    if (!crashed(details) || details.serviceName === FORKED_UTILITY_SERVICE) return;
    target.record({
      kind: "process-gone",
      source: details.type === "GPU" ? "gpu" : "utility",
      name: details.serviceName ?? details.name ?? details.type,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });
}
