import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CrashReportSource } from "../ipc/bridgeContract";

// One problem the desktop saw. Main records it as plain text the person can
// read, and nothing more: no file text, no paths outside dohc's own
// installation, no tokens.
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
const LINE_MAX_CHARS = 500;
const FRAME_MAX_CHARS = 300;
const FRAMES_PER_ERROR = 25;
const CAUSE_DEPTH = 3;

const ENGINE_STAGE: Record<Extract<CrashEvent, { kind: "engine" }>["stage"], string> = {
  restarting: "The workspace engine failed. dohc restarts it.",
  stopped: "The workspace engine failed again, and dohc stopped restarting it.",
  startup: "The workspace engine did not start.",
};

/** The event as report lines: facts first, then errors and their stacks. */
export function formatCrashEvent(
  event: CrashEvent,
  facts: CrashFacts,
  scrub: (text: string) => string,
): string {
  const lines: string[] = [];
  const fact = (label: string, value: string) => lines.push(`${label}: ${clip(oneLine(value), LINE_MAX_CHARS)}`);
  fact("Time", new Date(facts.atMs).toISOString());
  if (event.kind === "main-exception") {
    fact("Process", "main");
    fact("What happened", event.origin === "unhandledRejection" ? "Unhandled promise rejection" : "Uncaught exception");
  } else if (event.kind === "process-gone") {
    fact("Process", event.source === "utility" && event.name ? `utility (${scrub(event.name)})` : event.source);
    fact("What happened", "The process ended");
    fact("Reason", scrub(event.reason));
    fact("Exit code", String(event.exitCode));
  } else {
    fact("Process", "workspace engine");
    fact("What happened", ENGINE_STAGE[event.stage]);
  }
  fact("Version", `${facts.version} (${facts.channel}${facts.packaged ? "" : ", development build"})`);
  fact("System", `${facts.system} ${facts.arch}`);
  fact("Electron", facts.electron);
  fact("Running for", `${facts.uptimeSeconds} s`);
  if (event.kind !== "process-gone") {
    // The engine's errors come from the supervisor, whose stack names only
    // its own restart code. The message and its causes carry the facts.
    lines.push(...errorLines(event.error, scrub, event.kind === "main-exception"));
  }
  return clip(lines.join("\n"), CRASH_EVENT_MAX_CHARS);
}

/** The whole report: a header, then each problem, oldest first. */
export function crashReportText(events: readonly string[], leftOut: number): string {
  return [
    "dohc crash report",
    ...(leftOut > 0 ? [`Earlier problems left out: ${leftOut}`] : []),
    ...events,
  ].join("\n\n");
}

function errorLines(error: unknown, scrub: (text: string) => string, withStack: boolean): string[] {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth <= CAUSE_DEPTH && current !== undefined; depth += 1) {
    const label = depth === 0 ? "Error" : "Caused by";
    if (!(current instanceof Error)) {
      // A thrown string can be anything a person typed; an object is not
      // spelled out at all.
      const value = typeof current === "string" ? scrub(current) : `a value of type ${current === null ? "null" : typeof current}`;
      lines.push(`${label}: ${clip(oneLine(value), LINE_MAX_CHARS)}`);
      break;
    }
    lines.push(`${label}: ${clip(oneLine(scrub(`${current.name}: ${current.message}`)), LINE_MAX_CHARS)}`);
    if (withStack) {
      const frames = (current.stack ?? "")
        .split("\n")
        .filter((line) => /^\s*at\s/.test(line))
        .slice(0, FRAMES_PER_ERROR)
        .map((line) => `    ${clip(scrub(line.trim()), FRAME_MAX_CHARS)}`);
      lines.push(...frames);
    }
    current = current.cause;
  }
  return lines;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes what a report must not carry. `roots` are dohc's own install and
 * source folders: a path inside one keeps its dohc-relative part, so a stack
 * still says which file failed. Every other path, URL, email address, IP
 * address, quoted value, and token-shaped run is replaced, because each can
 * name a person's files, server, or secrets. Quoted values go because error
 * messages quote what they were given, which is often what a person typed.
 */
export function createCrashScrubber(roots: readonly string[], platform: NodeJS.Platform): (text: string) => string {
  const spellings = roots
    .filter((root) => root.length > 3)
    .flatMap((root) => {
      const trimmed = root.replace(/[\\/]+$/, "");
      return [trimmed, trimmed.replace(/\\/g, "/"), pathToFileURL(trimmed).href];
    })
    .sort((left, right) => right.length - left.length);
  // A root ends at a separator, so a sibling such as `dohc-notes` is not
  // dohc's own folder.
  const rootPattern = spellings.length === 0
    ? null
    : new RegExp(
        `(?:${spellings.map(escapeRegExp).join("|")})(?![\\w.-])((?:[\\\\/][^\\s'"()<>|]*)?)`,
        platform === "win32" ? "gi" : "g",
      );
  return (text) => {
    let result = rootPattern
      ? text.replace(rootPattern, (_match, rest: string) => `<dohc>${rest.replace(/\\/g, "/")}`)
      : text;
    result = result
      // URLs, including file:// and dohc's own schemes, which carry paths.
      .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"()<>]*/gi, "<url>")
      // Node's network errors name the host after the error code, or after
      // the call when no code is given.
      .replace(/\b(ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH)(\s+)[^\s,;'"()<>]+/g, "$1$2<host>")
      .replace(/\b(getaddrinfo|connect)(\s+)(?![A-Z][A-Z_]*\b)(?=[^\s,;'"()<>]*[.:])[^\s,;'"()<>]+/g, "$1$2<host>")
      .replace(/\b(attempted address:?\s*)[^\s,;'"()<>]+/gi, "$1<host>")
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "<email>")
      // A quote that opens after a word character is an apostrophe, and so
      // is one inside a quoted value that a letter follows. The second rule
      // is bounded so a line of unclosed quotes stays linear.
      .replace(/(?<!\w)"[^"\n]*"(?!\w)/g, "\"…\"")
      .replace(/(?<!\w)'[^'\n]*'(?!\w)/g, "'…'")
      .replace(/(?<!\w)'(?:[^'\n]|'(?=\w)){1,500}'(?!\w)/g, "'…'")
      .replace(/(?<!\w)`[^`\n]*`(?!\w)/g, "`…`")
      // Windows drive and UNC paths run to the next quote or bracket, since
      // their folder names can hold spaces and apostrophes.
      .replace(/(?:\b[A-Za-z]:[\\/]|\\\\(?=[^\\\s]))(?:[^\n\r'"()<>|]|'(?=\w))*/g, "<path>")
      // POSIX paths with at least two parts, not inside a word or a dohc path.
      .replace(/(?<![\w.:/<>-])\/(?:[^\s/'"()<>|]+\/)+(?:[^\n\r'"()<>|]|'(?=\w))*/g, "<path>")
      .replace(/\b(bearer|basic)\s+[^\s'"]+/gi, "$1 <redacted>")
      .replace(/\b([\w-]*(?:token|secret|password|passphrase|authorization|cookie|signature|api[_-]?key))(\s*[=:]\s*)[^\s,;&'"]+/gi, "$1$2<redacted>")
      // A JSON Web Token: its header always starts `{"`, which is `eyJ`.
      .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, "<redacted>")
      .replace(/(?<![\w+=-])(?=[\w+=-]*\d)[\w+=-]{32,}/g, "<redacted>")
      .replace(/(?<![\w:])(?=[0-9a-f:]*[0-9a-f])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi, "<ip>")
      .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>");
    return result;
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
