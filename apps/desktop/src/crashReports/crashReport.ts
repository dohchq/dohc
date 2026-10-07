import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineDaemonUnavailableError } from "@dohc/workspace-engine-client/daemon";
import type { CrashReportSource } from "../ipc/bridgeContract";
import { ENGINE_METHODS, ERROR_CODES, ERROR_NAMES, SIGNALS, SYSCALLS, WIRE_CODES } from "./crashReportValues";

// One problem the desktop saw. A report keeps only what dohc itself wrote:
// fixed facts, error classes and codes, messages that match a known
// template, and stack frames inside dohc's own code. Everything else is
// withheld, because free text can hold a person's file names and content.
export type CrashEvent =
  // An exception nothing caught in the main process, or one that stopped
  // the main module from loading at all.
  | { kind: "main-exception"; error: unknown; origin: "uncaughtException" | "unhandledRejection" | "module-load" }
  // A window's renderer, the GPU process, or a Chromium service process
  // that ended abnormally.
  | { kind: "process-gone"; source: "window" | "gpu" | "utility"; name: string | null; reason: string; exitCode: number }
  // The workspace engine failed. `stage` says what dohc did about it.
  | { kind: "engine"; error: unknown; stage: "restarting" | "stopped" | "startup" };

export function crashEventSource(event: CrashEvent): CrashReportSource {
  if (event.kind === "main-exception") return "main";
  if (event.kind === "engine") return "engine";
  return event.source;
}

// Facts about this build and computer, read when the problem happens.
export interface CrashFacts {
  atMs: number;
  version: string;
  channel: string;
  packaged: boolean;
  // Operating system name and release, such as "Windows_NT 10.0.22631".
  system: string;
  arch: string;
  electron: string;
  uptimeSeconds: number;
}

// One problem, bounded, so five fit in a report with its header.
export const CRASH_EVENT_MAX_CHARS = 6_000;
export const MESSAGE_WITHHELD = "<message withheld>";
export const FRAME_WITHHELD = "<frame>";
const FRAMES_PER_ERROR = 25;
const CAUSE_DEPTH = 3;
// Stack lines read per error, before frames outside dohc collapse.
const STACK_LINES = 200;
const LINE_MAX_CHARS = 500;

const ENGINE_STAGE: Record<Extract<CrashEvent, { kind: "engine" }>["stage"], string> = {
  restarting: "The workspace engine failed. dohc restarts it.",
  stopped: "The workspace engine failed again, and dohc stopped restarting it.",
  startup: "The workspace engine did not start.",
};

const MAIN_EXCEPTION: Record<Extract<CrashEvent, { kind: "main-exception" }>["origin"], string> = {
  uncaughtException: "Uncaught exception",
  unhandledRejection: "Unhandled promise rejection",
  "module-load": "The main module failed to load",
};

export const VALUE_WITHHELD = "<withheld>";

// Only real supervisor errors reach these templates. desktopEngine.ts uses
// engineDaemonLifecycle.ts's default counters and timeouts, so keep those
// exact values. Request caps can shrink to the remaining read budget, up to
// the default 120,000ms smoke cap. Exit codes can be signed or unsigned
// 32-bit values on Windows; signal names come from a fixed list.
const ENGINE_MESSAGES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string | null]> = [
  [/^Rust engine daemon exited unexpectedly with (?:code (-?\d+)|code unknown|signal (\w+))\.$/, (m) => {
    const code = Number(m[1]);
    if (m[1] !== undefined && (!Number.isInteger(code) || code < -2_147_483_648 || code > 4_294_967_295)) return null;
    return `Rust engine daemon exited unexpectedly with ${
      m[1] !== undefined ? `code ${code}` : m[2] !== undefined ? `signal ${SIGNALS.has(m[2]) ? m[2] : VALUE_WITHHELD}` : "code unknown"
    }.`;
  }],
  [/^Rust engine (\S+) returned an invalid result\.$/, (m) => rpcMessage(m[1]!, "returned an invalid result.")],
  [/^Rust engine (\S+) made no progress while the daemon was responding\.$/, (m) =>
    rpcMessage(m[1]!, "made no progress while the daemon was responding.")],
  [/^Rust engine (\S+) timed out after ([1-9]\d{0,5})ms\.$/, (m) => {
    const capMs = Number(m[2]);
    return capMs <= 120_000 ? rpcMessage(m[1]!, `timed out after ${capMs}ms.`) : null;
  }],
  [/^Rust engine (\S+) did not start within its 10000ms budget\.$/, (m) =>
    rpcMessage(m[1]!, "did not start within its 10000ms budget.")],
  [/^Rust engine (\S+) ran out of its 10000ms budget before the read\.$/, (m) =>
    rpcMessage(m[1]!, "ran out of its 10000ms budget before the read.")],
  [/^Rust engine (\S+) got no answer: a probe expired after 45000ms with no frame of any kind from the engine\.$/, (m) =>
    rpcMessage(m[1]!, "got no answer: a probe expired after 45000ms with no frame of any kind from the engine.")],
  ...[
    "Rust engine restart limit exceeded after 3 attempts.",
    "The Rust engine crashed again after 10 restarts in the last 10 minutes. The limit is 10 restarts per 10 minutes. dohc stopped restarting it.",
    "The Rust engine went silent on 2 launches: 3 probes in a row expired after 45000ms each with no frame of any kind from the engine. The limit is 2 wedges with no traffic in between. dohc stopped restarting it.",
    "The Rust engine is running but sent nothing: 3 probes in a row expired after 45000ms each with no frame of any kind from the engine. The limit is 3 probes with no traffic. dohc is restarting it.",
    "Rust engine failed its startup handshake.",
    "Rust engine exited during its startup handshake.",
    "Rust engine exited during its startup health check.",
    "Rust engine exited while retiring the previous generation's work.",
    "Rust engine daemon is not available.",
    "Rust engine lifecycle is already stopping.",
    "Rust engine request generation was retired.",
    "Rust engine workspace.open returned no workspace handle.",
    "Electron resources path is unavailable for the packaged Rust engine.",
  ].map((sentence) => [new RegExp(`^${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), () => sentence] as const),
];

function rpcMessage(method: string, diagnostic: string): string {
  return `Rust engine ${ENGINE_METHODS.has(method) ? method : VALUE_WITHHELD} ${diagnostic}`;
}

function engineMessage(message: string): string | null {
  for (const [pattern, render] of ENGINE_MESSAGES) {
    const match = pattern.exec(message);
    if (match) return render(match);
  }
  return null;
}

/** The event as report lines: facts first, then errors and their stacks. */
export function formatCrashEvent(
  event: CrashEvent,
  facts: CrashFacts,
  codeFrame: (frame: string) => string,
): string {
  const lines: string[] = [];
  const fact = (label: string, value: string) => lines.push(`${label}: ${value}`);
  fact("Time", new Date(facts.atMs).toISOString());
  if (event.kind === "main-exception") {
    fact("Process", "main");
    fact("What happened", MAIN_EXCEPTION[event.origin]);
  } else if (event.kind === "process-gone") {
    const name = event.name && /^[\w .-]{1,100}$/.test(event.name) ? event.name : null;
    fact("Process", event.source === "utility" && name ? `utility (${name})` : event.source);
    fact("What happened", "The process ended");
    fact("Reason", /^[a-z-]{1,40}$/.test(event.reason) ? event.reason : "unknown");
    fact("Exit code", String(event.exitCode));
  } else {
    fact("Process", "workspace engine");
    fact("What happened", ENGINE_STAGE[event.stage]);
  }
  fact("Version", clip(`${facts.version} (${facts.channel}${facts.packaged ? "" : ", development build"})`));
  fact("System", clip(`${facts.system} ${facts.arch}`));
  fact("Electron", clip(facts.electron));
  fact("Running for", `${facts.uptimeSeconds} s`);
  if (event.kind !== "process-gone") {
    // The engine's errors come from the supervisor, whose stack names only
    // its own restart code. The message and its causes carry the facts.
    lines.push(...errorLines(event.error, codeFrame, event.kind === "main-exception"));
  }
  const text = lines.join("\n");
  return text.length > CRASH_EVENT_MAX_CHARS ? `${text.slice(0, CRASH_EVENT_MAX_CHARS - 1)}…` : text;
}

/** The whole report: a header, then each problem, oldest first. */
export function crashReportText(events: readonly string[], leftOut: number): string {
  return [
    "dohc crash report",
    ...(leftOut > 0 ? [`Earlier problems left out: ${leftOut}`] : []),
    ...events,
  ].join("\n\n");
}

function errorLines(error: unknown, codeFrame: (frame: string) => string, withStack: boolean): string[] {
  const lines: string[] = [];
  errorChain(error).forEach((link, depth) => {
    const label = depth === 0 ? "Error" : "Caused by";
    if (link.kind === "value") {
      lines.push(`${label}: a value of type ${link.type}`);
      return;
    }
    lines.push(`${label}: ${link.name}: ${link.message}`);
    if (!withStack) return;
    const frames: string[] = [];
    for (const line of link.stack) {
      const frame = codeFrame(line);
      // Runs of frames outside dohc read as one.
      if (frame !== FRAME_WITHHELD || frames.at(-1) !== FRAME_WITHHELD) frames.push(frame);
      if (frames.length === FRAMES_PER_ERROR) break;
    }
    lines.push(...frames.map((frame) => `    ${frame}`));
  });
  return lines;
}

// One error and its causes, outermost first. `name` and `message` hold only
// values from fixed lists; `stack` holds the raw "at" lines, which the
// caller must pass through a code-location filter before they leave.
export type ErrorLink =
  | { kind: "error"; name: string; message: string; stack: readonly string[] }
  | { kind: "value"; type: string };

export function errorChain(error: unknown): ErrorLink[] {
  const chain: ErrorLink[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (!(current instanceof Error)) {
      // A thrown value can be anything a person typed.
      chain.push({ kind: "value", type: current === null ? "null" : typeof current });
      break;
    }
    // Any code can set a stack, so one that is not text has no frames.
    const raw: unknown = current.stack;
    const stack = (typeof raw === "string" ? raw : "").split("\n")
      .filter((line) => /^\s*at\s/.test(line))
      .slice(0, STACK_LINES)
      .map((line) => line.trim());
    chain.push({ kind: "error", ...errorSummary(current), stack });
    current = current.cause;
  }
  return chain;
}

// The class, the message rebuilt from a known template, and the codes Node
// and the engine attach, each only when it is on a known list.
function errorSummary(error: Error): { name: string; message: string } {
  const name = ERROR_NAMES.has(error.name) ? error.name : VALUE_WITHHELD;
  const message = (error instanceof EngineDaemonUnavailableError ? engineMessage(error.message) : null) ?? MESSAGE_WITHHELD;
  const fields = error as Error & { code?: unknown; wireCode?: unknown; syscall?: unknown };
  const known = (value: unknown, values: ReadonlySet<string>) =>
    typeof value === "string" && values.has(value) ? value : VALUE_WITHHELD;
  const codes = [
    ...(fields.code !== undefined ? [`code ${known(fields.code, ERROR_CODES)}`] : []),
    ...(fields.wireCode !== undefined ? [`code ${known(fields.wireCode, WIRE_CODES)}`] : []),
    ...(fields.syscall !== undefined ? [`syscall ${known(fields.syscall, SYSCALLS)}`] : []),
  ];
  return { name, message: `${message}${codes.length > 0 ? ` (${codes.join(", ")})` : ""}` };
}

// One line of at most `max` characters.
function clip(text: string, max = LINE_MAX_CHARS): string {
  const line = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

// A place in dohc's own code: a path under one of its roots, starting
// with "/", in its own spelling, and a line and column.
export interface CodeLocation {
  path: string;
  line: number;
  column: number;
}

/**
 * Finds where a V8 stack line points when that is inside one of `roots`,
 * dohc's own code, and answers null otherwise. The function name is dropped,
 * and a path is kept only when every character in it is one dohc's own file
 * names use.
 */
export function createCodeLocations(
  roots: readonly string[],
  platform: NodeJS.Platform,
): (frame: string) => CodeLocation | null {
  const fold = (text: string) => platform === "win32" ? text.toLowerCase().replace(/\\/g, "/") : text;
  const rootPaths = roots.map((root) => fold(root.replace(/[\\/]+$/, "")));
  return (frame) => {
    const location = frame.length > 1_000 ? null : /(?:^at (?:async )?|\()([^()]+):(\d+):(\d+)\)?$/.exec(frame);
    if (!location) return null;
    let path = location[1]!;
    if (path.startsWith("file://")) {
      try {
        path = fileURLToPath(path);
      } catch {
        return null;
      }
    }
    const folded = fold(path);
    for (const root of rootPaths) {
      if (!folded.startsWith(`${root}/`)) continue;
      const relative = folded.slice(root.length);
      if (!/^(?:\/[\w@+-][\w.@+-]*)+$/.test(relative) || relative.includes("/..")) return null;
      // A source map needs the file name's own case, which Windows folds.
      const spelled = path.replace(/\\/g, "/").slice(-relative.length);
      return {
        path: fold(spelled) === relative ? spelled : relative,
        line: Number(location[2]),
        column: Number(location[3]),
      };
    }
    return null;
  };
}

/** A stack line as `at <dohc>/…:line:col`, or `<frame>` outside dohc's code. */
export function createCodeFrames(roots: readonly string[], platform: NodeJS.Platform): (frame: string) => string {
  const locate = createCodeLocations(roots, platform);
  const fold = (text: string) => platform === "win32" ? text.toLowerCase() : text;
  return (frame) => {
    const location = locate(frame);
    return location ? `at <dohc>${fold(location.path)}:${location.line}:${location.column}` : FRAME_WITHHELD;
  };
}

/**
 * dohc's own folder: the checkout in development, or the installed app. A
 * packaged build's code sits under its resources folder, whose parent also
 * holds the executable on every platform, including a macOS app's Contents.
 */
export function crashReportRoot(app: { isPackaged: boolean; appPath: string; resourcesPath: string }): string {
  return app.isPackaged ? dirname(app.resourcesPath) : resolve(app.appPath, "../..");
}
