import { randomUUID } from "node:crypto";
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
  // Operating system name and release, such as "Windows_NT" and "10.0.22631".
  os: string;
  osVersion: string;
  arch: string;
  electron: string;
}

const FRAMES_PER_ERROR = 25;
const WITHHELD_FILE = "<withheld>";

interface SentryFrame {
  filename: string;
  abs_path?: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

// The Sentry event an error report sends. It carries no user, request,
// breadcrumbs, server name, or free text: the error classes and messages
// come from errorChain's fixed lists, and a frame names a file only inside
// dohc's own code.
export interface SentryEvent {
  event_id: string;
  timestamp: number;
  platform: "node";
  level: "error";
  release: string;
  dist: string;
  environment: string;
  tags: Record<string, string>;
  contexts: {
    os: { name: string; version: string };
    runtime: { name: "electron"; version: string };
    device: { arch: string };
  };
  exception: { values: Array<{ type: string; value: string; stacktrace?: { frames: SentryFrame[] } }> };
}

/**
 * The event for one problem, and the key that says whether it repeats an
 * earlier one. Engine and process problems carry no frames: their stacks
 * name only dohc's restart code.
 */
export function sentryEvent(
  reported: ReportedError,
  facts: ErrorFacts,
  names: { release: string; dist: string; environment: string },
  locate: (frame: string) => CodeLocation | null,
): { event: SentryEvent; key: string } {
  const { tags, values } = describe(reported, (stack) => sentryFrames(stack, locate).reverse());
  const event: SentryEvent = {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: facts.atMs / 1000,
    platform: "node",
    level: "error",
    release: names.release,
    dist: names.dist,
    environment: names.environment,
    tags,
    contexts: {
      os: { name: facts.os, version: facts.osVersion },
      runtime: { name: "electron", version: facts.electron },
      device: { arch: facts.arch },
    },
    exception: { values },
  };
  return { event, key: JSON.stringify([tags, values]) };
}

type Values = SentryEvent["exception"]["values"];

function describe(
  reported: ReportedError,
  frames: (stack: readonly string[]) => SentryFrame[],
): { tags: Record<string, string>; values: Values } {
  if (reported.kind === "crash") {
    const event = reported.event;
    if (event.kind === "process-gone") {
      const reason = /^[a-z-]{1,40}$/.test(event.reason) ? event.reason : "unknown";
      const process = crashEventSource(event);
      return {
        tags: { process, reason },
        values: [{ type: "ProcessGone", value: `${process} ${reason} (exit code ${event.exitCode})` }],
      };
    }
    if (event.kind === "engine") return { tags: { process: "engine", stage: event.stage }, values: chain(event.error, null) };
    return { tags: { process: "main", origin: event.origin }, values: chain(event.error, frames) };
  }
  const tags = { process: "renderer", origin: reported.origin };
  if ("type" in reported.error) {
    return { tags, values: [{ type: "ThrownValue", value: `a value of type ${reported.error.type}` }] };
  }
  return { tags, values: chain(rendererError(reported.error), frames) };
}

// Sentry lists a chain's cause first and a stack's oldest call first.
function chain(error: unknown, frames: ((stack: readonly string[]) => SentryFrame[]) | null): Values {
  return errorChain(error).reverse().map((link) => link.kind === "value"
    ? { type: "ThrownValue", value: `a value of type ${link.type}` }
    : {
        type: link.name,
        value: link.message,
        ...(frames ? { stacktrace: { frames: frames(link.stack) } } : {}),
      });
}

// The window's error, rebuilt from its class and stack. errorChain keeps the
// class only when it is on a known list, and withholds the message.
function rendererError(thrown: { name: string; stack: string }): Error {
  const error = new Error();
  error.name = thrown.name;
  error.stack = thrown.stack;
  return error;
}

function sentryFrames(stack: readonly string[], locate: (frame: string) => CodeLocation | null): SentryFrame[] {
  const frames: SentryFrame[] = [];
  for (const line of stack) {
    const location = locate(line);
    if (location) {
      const file = frameFile(location.path);
      frames.push({ filename: file, abs_path: file, lineno: location.line, colno: location.column, in_app: true });
    } else if (frames.at(-1)?.filename !== WITHHELD_FILE) {
      // Runs of frames outside dohc read as one.
      frames.push({ filename: WITHHELD_FILE, in_app: false });
    }
    if (frames.length === FRAMES_PER_ERROR) break;
  }
  return frames;
}

// Packaged code sits in app.asar, so its files are app:///dist/…, the names
// the release's uploaded source maps carry. Any other dohc file keeps its
// path under dohc's folder.
function frameFile(path: string): string {
  const inArchive = /\/app\.asar(\/.*)$/i.exec(path);
  return `app://${inArchive ? inArchive[1] : path}`;
}

/** One Sentry envelope holding one event. */
export function sentryEnvelope(event: SentryEvent, sentAtMs: number): string {
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date(sentAtMs).toISOString() }),
    JSON.stringify({ type: "event", content_type: "application/json" }),
    JSON.stringify(event),
    "",
  ].join("\n");
}
