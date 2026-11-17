// The messages between a page's web view, which runs the live provider and the editor, and the app, which owns the
// page's socket. Both sides bundle this file, so it imports nothing.
//
// Each message names the open it belongs to (`gen`) and its place in that open's stream (`seq`, from 1 in each
// direction). A side ignores a message of an earlier open, and closes the connection on a gap or a repeat, so a frame is
// never lost or applied twice without the connection ending. A frame is one protocol frame, base64. Each side holds
// at most a window of frames the other hasn't taken, and closes the connection when a frame would pass it.

/** The editor limits the server sent with the page's ticket. The page checks them in full when it makes the provider. */
export interface LiveLimits {
  readonly provider: {
    readonly frames: { readonly maxQueuedBytes: number; readonly maxQueuedFrames: number };
  };
  readonly maxSocketBufferedBytes: number;
  readonly connectTimeoutMs: number;
}

/** What the page tells the app about its provider. */
export interface LiveFacts {
  readonly status: "disconnected" | "connecting" | "syncing" | "live" | "quarantined" | "closed";
  readonly reason: string | null;
  readonly pendingUpdates: number;
  /** The page holds edits the server hasn't applied: waiting ones, or ones it refused. */
  readonly unsent: boolean;
}

type Stamp = {
  readonly kind: "live";
  readonly gen: number;
  readonly seq: number;
};
/** To the page. `connect` starts an open; `sent` says the app sent one frame; `lost` says the socket ended. */
export type ToPage = Stamp &
  (
    | {
        readonly type: "connect";
        readonly limits: LiveLimits;
        readonly workspaceId: string;
        readonly objectId: string;
      }
    | { readonly type: "frame"; readonly data: string }
    | { readonly type: "sent" | "lost" }
  );
/** From the page. `took` says the page took one frame; `close` says its provider ended the connection. */
export type FromPage = Stamp &
  (
    | { readonly type: "frame"; readonly data: string }
    | { readonly type: "state"; readonly facts: LiveFacts }
    | { readonly type: "took" | "close" }
  );
/** A message as its sender writes it, before `outgoing` stamps it. */
export type Body<M> = M extends Stamp ? Omit<M, keyof Stamp> : never;

const STATUSES: readonly string[] = [
  "disconnected",
  "connecting",
  "syncing",
  "live",
  "quarantined",
  "closed",
];
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256;

/** The positive whole numbers the app reads, or null when any is missing. */
export function readLimits(value: unknown): LiveLimits | null {
  if (!record(value) || !record(value.provider) || !record(value.provider.frames)) return null;
  const { maxQueuedBytes, maxQueuedFrames } = value.provider.frames;
  return count(maxQueuedBytes, 1) &&
    count(maxQueuedFrames, 1) &&
    count(value.maxSocketBufferedBytes, 1) &&
    count(value.connectTimeoutMs, 1)
    ? (value as unknown as LiveLimits)
    : null;
}

function stamped(value: unknown): value is Record<string, unknown> & Stamp {
  return record(value) && value.kind === "live" && count(value.gen, 1) && count(value.seq, 1);
}

export function readToPage(value: unknown): ToPage | null {
  if (!stamped(value)) return null;
  switch (value.type) {
    case "connect":
      return readLimits(value.limits) && id(value.workspaceId) && id(value.objectId)
        ? (value as unknown as ToPage)
        : null;
    case "frame":
      return typeof value.data === "string" ? (value as unknown as ToPage) : null;
    case "sent":
    case "lost":
      return value as unknown as ToPage;
    default:
      return null;
  }
}

export function readFromPage(value: unknown): FromPage | null {
  if (!stamped(value)) return null;
  switch (value.type) {
    case "frame":
      return typeof value.data === "string" ? (value as unknown as FromPage) : null;
    case "state": {
      const facts = value.facts;
      return record(facts) &&
        typeof facts.status === "string" &&
        STATUSES.includes(facts.status) &&
        (facts.reason === null || typeof facts.reason === "string") &&
        count(facts.pendingUpdates) &&
        typeof facts.unsent === "boolean"
        ? (value as unknown as FromPage)
        : null;
    }
    case "took":
    case "close":
      return value as unknown as FromPage;
    default:
      return null;
  }
}

/** Numbers one open's messages in one direction. */
export function outgoing<M extends Stamp>(gen: number, post: (message: M) => void) {
  let seq = 0;
  return (body: Body<M>) => post({ ...body, kind: "live", gen, seq: ++seq } as unknown as M);
}

/**
 * Checks one open's messages in one direction: `stale` for an earlier open's, which the side ignores, `broken` for a
 * gap or a repeat, which closes the connection.
 */
export function incoming(gen: number) {
  let seq = 0;
  return (message: Stamp): "next" | "stale" | "broken" => {
    if (message.gen !== gen) return "stale";
    if (message.seq !== seq + 1) return "broken";
    seq = message.seq;
    return "next";
  };
}

/** Frames one side sent and the other hasn't taken. `add` refuses a frame past either bound. */
export function frameWindow(maxFrames: number, maxBytes: number) {
  const sizes: number[] = [];
  let bytes = 0;
  return {
    add(size: number): boolean {
      if (sizes.length >= maxFrames || size > maxBytes - bytes) return false;
      sizes.push(size);
      bytes += size;
      return true;
    },
    /** False when nothing was waiting, which only a broken stream sends. */
    release(): boolean {
      const size = sizes.shift();
      if (size === undefined) return false;
      bytes -= size;
      return true;
    },
  };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}
