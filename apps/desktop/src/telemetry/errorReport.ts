import { createHash } from "node:crypto";
import type { RendererThrown } from "../ipc/bridgeContract";
import {
  crashEventSource,
  errorChain,
  type CodeLocation,
  type CrashEvent,
} from "../crashReports/crashReport";

// A problem an error report describes: one the crash report records, or an
// error a dohc window caught or did not catch.
export type ReportedError =
  | { kind: "crash"; event: CrashEvent }
  | { kind: "renderer"; origin: RendererErrorOrigin; error: RendererThrown };

export type RendererErrorOrigin = "boundary" | "uncaught" | "rejection";

export interface ErrorFacts {
  atMs: number;
  version: string;
  channel: string;
  // Operating system name and release, such as "Windows_NT" and "10.0.22631".
  os: string;
  osVersion: string;
  arch: string;
  electron: string;
}

const FRAMES_PER_ERROR = 25;
const WITHHELD_FILE = "<withheld>";

// A place in dohc's own code, by the name the report gives its file and the
// path under dohc's folder that holds it, or a run of frames outside dohc.
type Frame = { file: string; path: string; line: number; column: number } | { file: typeof WITHHELD_FILE };

// One error of a chain. The class and message come from errorChain's fixed
// lists; the frames run newest first.
interface Link {
  type: string;
  value: string;
  frames?: Frame[];
}

// What one error report sends. PostHog's SDK reads `error`, which holds only
// the values above, and sends `properties` beside it. Nothing else of the
// problem reaches the SDK.
export interface ErrorReport {
  error: Error;
  properties: Record<string, string>;
  atMs: number;
  // False when nothing caught the error: one that reached main's or a
  // window's last handler.
  handled: boolean;
  // Each dohc file the frames name, by the path under dohc's folder.
  files: ReadonlyMap<string, string>;
}

/**
 * The report for one problem, and the key that says whether it repeats an
 * earlier one. Engine and process problems carry no frames: their stacks
 * name only dohc's restart code.
 */
export function errorReport(
  reported: ReportedError,
  facts: ErrorFacts,
  dist: string,
  locate: (frame: string) => CodeLocation | null,
): { report: ErrorReport; key: string } {
  const { tags, links } = describe(reported, (stack) => codeFrames(stack, locate));
  const files = new Map<string, string>();
  for (const frame of links.flatMap((link) => link.frames ?? [])) {
    if ("path" in frame) files.set(frame.file, frame.path);
  }
  const properties: Record<string, string> = {
    ...tags,
    app_version: facts.version,
    channel: facts.channel,
    dist,
    os: facts.os,
    os_version: facts.osVersion,
    arch: facts.arch,
    electron: facts.electron,
  };
  // PostHog groups a problem by its frames in dohc's code once source maps
  // resolve them, so a problem keeps its group across releases. Without such
  // a frame it would group by class and message alone, so the report names
  // its group from what failed and how.
  if (files.size === 0) {
    const group = JSON.stringify([tags, links.map(({ type, value }) => [type, value])]);
    properties.$exception_fingerprint = createHash("sha256").update(group).digest("hex");
  }
  const handled = reported.kind === "renderer" ? reported.origin === "boundary" : reported.event.kind !== "main-exception";
  return {
    report: { error: chainError(links), properties, atMs: facts.atMs, files, handled },
    key: JSON.stringify([tags, links]),
  };
}

function describe(
  reported: ReportedError,
  frames: (stack: readonly string[]) => Frame[],
): { tags: Record<string, string>; links: Link[] } {
  if (reported.kind === "crash") {
    const event = reported.event;
    if (event.kind === "process-gone") {
      const reason = /^[a-z-]{1,40}$/.test(event.reason) ? event.reason : "unknown";
      const process = crashEventSource(event);
      return {
        tags: { process, reason },
        links: [{ type: "ProcessGone", value: `${process} ${reason} (exit code ${event.exitCode})` }],
      };
    }
    if (event.kind === "engine") return { tags: { process: "engine", stage: event.stage }, links: chain(event.error, null) };
    return { tags: { process: "main", origin: event.origin }, links: chain(event.error, frames) };
  }
  const tags = { process: "renderer", origin: reported.origin };
  if ("type" in reported.error) {
    return { tags, links: [{ type: "ThrownValue", value: `a value of type ${reported.error.type}` }] };
  }
  return { tags, links: chain(rendererError(reported.error), frames) };
}

function chain(error: unknown, frames: ((stack: readonly string[]) => Frame[]) | null): Link[] {
  // errorChain reads nothing from undefined.
  if (error === undefined) return [{ type: "ThrownValue", value: "a value of type undefined" }];
  return errorChain(error).map((link) => link.kind === "value"
    ? { type: "ThrownValue", value: `a value of type ${link.type}` }
    : { type: link.name, value: link.message, ...(frames ? { frames: frames(link.stack) } : {}) });
}

// The window's error, rebuilt from its class and stack. errorChain keeps the
// class only when it is on a known list, and withholds the message.
function rendererError(thrown: { name: string; stack: string }): Error {
  const error = new Error();
  error.name = thrown.name;
  error.stack = thrown.stack;
  return error;
}

function codeFrames(stack: readonly string[], locate: (frame: string) => CodeLocation | null): Frame[] {
  const frames: Frame[] = [];
  for (const line of stack) {
    const location = locate(line);
    if (location) {
      frames.push({ file: frameFile(location.path), path: location.path, line: location.line, column: location.column });
    } else if (frames.at(-1)?.file !== WITHHELD_FILE) {
      // Runs of frames outside dohc read as one.
      frames.push({ file: WITHHELD_FILE });
    }
    if (frames.length === FRAMES_PER_ERROR) break;
  }
  return frames;
}

// Packaged code sits in app.asar, so its files are app:///dist/…. Any other
// dohc file keeps its path under dohc's folder.
function frameFile(path: string): string {
  const inArchive = /\/app\.asar(\/.*)$/i.exec(path);
  return `app://${inArchive ? inArchive[1] : path}`;
}

// The chain as errors the SDK reads, each with a V8 stack of only the
// frames above. The first line stands where V8 writes the error's own line,
// so no stack is empty: the SDK would fill an empty one with its own frames.
function chainError(links: readonly Link[]): Error {
  let cause: Error | undefined;
  for (const link of [...links].reverse()) {
    const error = new Error(link.value, cause ? { cause } : undefined);
    error.name = link.type;
    error.stack = ["Error", ...(link.frames ?? []).map((frame) =>
      `    at ${"path" in frame ? `${frame.file}:${frame.line}:${frame.column}` : frame.file}`)].join("\n");
    cause = error;
  }
  return cause!;
}
