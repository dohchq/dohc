import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CrashReportSource } from "../ipc/bridgeContract";
import { ERROR_CODES, ERROR_NAMES, SIGNALS, SYSCALLS, WIRE_CODES } from "./crashReportValues";

// One problem the desktop saw. A report keeps only what dohc itself wrote:
// fixed facts, error classes and codes, messages that match a known
// template, and stack frames inside dohc's own code. Everything else is
// withheld, because free text can hold a person's file names and content.
export type CrashEvent =
  // An exception nothing caught in the main process.
  | { kind: "main-exception"; error: unknown; origin: "uncaughtException" | "unhandledRejection" }
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
const LINE_MAX_CHARS = 500;

const ENGINE_STAGE: Record<Extract<CrashEvent, { kind: "engine" }>["stage"], string> = {
  restarting: "The workspace engine failed. dohc restarts it.",
  stopped: "The workspace engine failed again, and dohc stopped restarting it.",
  startup: "The workspace engine did not start.",
};

export const VALUE_WITHHELD = "<withheld>";

// The engine supervisor's messages (engineDaemonLifecycle.ts). A matching
// message is written again from this list, with only its numbers, a
// window in minutes or milliseconds, and a known signal name carried over.
// Nothing else from the error's own text reaches the report, whoever
// threw it.
const n = (value: string | undefined) => String(Number(value));
const windowText = (value: string | undefined) => {
  const match = /^(\d+)(ms| minutes?)$/.exec(value ?? "");
  return match ? `${n(match[1])}${match[2]}` : "a window";
};
const ENGINE_MESSAGES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [/^Rust engine daemon exited unexpectedly with (?:code (-?\d+)|code unknown|signal (\w+))\.$/, (m) =>
    `Rust engine daemon exited unexpectedly with ${
      m[1] !== undefined ? `code ${n(m[1])}` : m[2] !== undefined ? `signal ${SIGNALS.has(m[2]) ? m[2] : VALUE_WITHHELD}` : "code unknown"
    }.`],
  [/^Rust engine restart limit exceeded after (\d+) attempts\.$/, (m) =>
    `Rust engine restart limit exceeded after ${n(m[1])} attempts.`],
  [/^The Rust engine crashed again after (\d+) restarts in the last ([\w ]+)\. The limit is (\d+) restarts per [\w ]+\. dohc stopped restarting it\.$/, (m) =>
    `The Rust engine crashed again after ${n(m[1])} restarts in the last ${windowText(m[2])}. The limit is ${n(m[3])} restarts per ${windowText(m[2])}. dohc stopped restarting it.`],
  [/^The Rust engine went silent on (\d+) launches: (\d+) probes in a row expired after (\d+)ms each with no frame of any kind from the engine\. The limit is (\d+) wedges with no traffic in between\. dohc stopped restarting it\.$/, (m) =>
    `The Rust engine went silent on ${n(m[1])} launches: ${n(m[2])} probes in a row expired after ${n(m[3])}ms each with no frame of any kind from the engine. The limit is ${n(m[4])} wedges with no traffic in between. dohc stopped restarting it.`],
  [/^The Rust engine is running but sent nothing: (\d+) probes in a row expired after (\d+)ms each with no frame of any kind from the engine\. The limit is (\d+) probes with no traffic\. dohc is restarting it\.$/, (m) =>
    `The Rust engine is running but sent nothing: ${n(m[1])} probes in a row expired after ${n(m[2])}ms each with no frame of any kind from the engine. The limit is ${n(m[3])} probes with no traffic. dohc is restarting it.`],
  [/^Rust engine \S+ returned an invalid result\.$/, () => "Rust engine request returned an invalid result."],
  [/^Rust engine \S+ timed out after (\d+)ms\.$/, (m) => `Rust engine request timed out after ${n(m[1])}ms.`],
  ...[
    "Rust engine failed its startup handshake.",
    "Rust engine exited during its startup handshake.",
    "Rust engine exited during its startup health check.",
    "Rust engine exited while retiring the previous generation's work.",
    "Rust engine daemon is not available.",
    "Rust engine lifecycle is already stopping.",
    "Rust engine workspace.open returned no workspace handle.",
    "Electron resources path is unavailable for the packaged Rust engine.",
  ].map((sentence) => [new RegExp(`^${sentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), () => sentence] as const),
];

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
    fact("What happened", event.origin === "unhandledRejection" ? "Unhandled promise rejection" : "Uncaught exception");
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
  let current: unknown = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && current !== undefined; depth += 1) {
    const label = depth === 0 ? "Error" : "Caused by";
    if (!(current instanceof Error)) {
      // A thrown value can be anything a person typed.
      lines.push(`${label}: a value of type ${current === null ? "null" : typeof current}`);
      break;
    }
    lines.push(`${label}: ${errorSummary(current)}`);
    if (withStack) {
      const frames: string[] = [];
      for (const line of (current.stack ?? "").split("\n")) {
        if (!/^\s*at\s/.test(line)) continue;
        const frame = codeFrame(line.trim());
        // Runs of frames outside dohc read as one.
        if (frame !== FRAME_WITHHELD || frames.at(-1) !== FRAME_WITHHELD) frames.push(frame);
        if (frames.length === FRAMES_PER_ERROR) break;
      }
      lines.push(...frames.map((frame) => `    ${frame}`));
    }
    current = current.cause;
  }
  return lines;
}

// The class, the message rebuilt from a known template, and the codes Node
// and the engine attach, each only when it is on a known list.
function errorSummary(error: Error): string {
  const name = ERROR_NAMES.has(error.name) ? error.name : VALUE_WITHHELD;
  const message = (name === "EngineDaemonUnavailableError" ? engineMessage(error.message) : null) ?? MESSAGE_WITHHELD;
  const fields = error as Error & { code?: unknown; wireCode?: unknown; syscall?: unknown };
  const known = (value: unknown, values: ReadonlySet<string>) =>
    typeof value === "string" && values.has(value) ? value : VALUE_WITHHELD;
  const codes = [
    ...(fields.code !== undefined ? [`code ${known(fields.code, ERROR_CODES)}`] : []),
    ...(fields.wireCode !== undefined ? [`code ${known(fields.wireCode, WIRE_CODES)}`] : []),
    ...(fields.syscall !== undefined ? [`syscall ${known(fields.syscall, SYSCALLS)}`] : []),
  ];
  return `${name}: ${message}${codes.length > 0 ? ` (${codes.join(", ")})` : ""}`;
}

// One line of at most `max` characters.
function clip(text: string, max = LINE_MAX_CHARS): string {
  const line = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Turns a V8 stack line into `at <dohc>/…:line:col` when it points into one
 * of `roots`, dohc's own code, and into `<frame>` otherwise. The function
 * name is dropped, and a path is kept only when every character in it is one
 * dohc's own file names use.
 */
export function createCodeFrames(roots: readonly string[], platform: NodeJS.Platform): (frame: string) => string {
  const fold = (text: string) => platform === "win32" ? text.toLowerCase().replace(/\\/g, "/") : text;
  const rootPaths = roots.map((root) => fold(root.replace(/[\\/]+$/, "")));
  return (frame) => {
    const location = frame.length > 1_000 ? null : /(?:^at (?:async )?|\()([^()]+):(\d+):(\d+)\)?$/.exec(frame);
    if (!location) return FRAME_WITHHELD;
    let path = location[1]!;
    if (path.startsWith("file://")) {
      try {
        path = fileURLToPath(path);
      } catch {
        return FRAME_WITHHELD;
      }
    }
    const folded = fold(path);
    for (const root of rootPaths) {
      if (!folded.startsWith(`${root}/`)) continue;
      const relative = folded.slice(root.length);
      if (!/^(?:\/[\w@+-][\w.@+-]*)+$/.test(relative) || relative.includes("/..")) return FRAME_WITHHELD;
      return `at <dohc>${relative}:${location[2]}:${location[3]}`;
    }
    return FRAME_WITHHELD;
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
