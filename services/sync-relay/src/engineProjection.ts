import { createHash, randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  createEngineClient,
  EngineClientError,
  EngineRequestDeadlineError,
  EngineRequestError,
  type EngineClient,
  type EngineClientSpawnOptions,
} from "@dohc/workspace-engine-client/daemon";

/** The kinds the engine derives from updates alone. A scene reads its images from a workspace store. */
export type ProjectedContentKind = "richdoc" | "plaintext";

export interface EngineProjectionInput {
  readonly contentKind: ProjectedContentKind;
  /** A document's stored `ydoc.update` bytes, in relay order. */
  readonly updates: readonly Uint8Array[];
}

/**
 * - `busy`: every slot and queue place is taken. Try again.
 * - `too-large`: the updates exceed one engine request, or the file exceeds the live-editing limit or a projection budget.
 * - `invalid`: the engine cannot project these updates, or failed on them.
 * - `unavailable`: the engine stopped or passed its deadline, and restarts after a delay.
 */
export type EngineProjectionRefusal = "busy" | "too-large" | "invalid" | "unavailable";

export type EngineProjection =
  | {
      readonly kind: "projected";
      /** The bytes an owner device settles for the document. */
      readonly content: Buffer;
      readonly sha256: string;
      readonly sourceStateVectorSha256: string;
      /** SHA-256 of the engine executable that projected it. A cached projection from another engine is stale. */
      readonly engineSha256: string;
    }
  | { readonly kind: "refused"; readonly reason: EngineProjectionRefusal; readonly message: string };

type ProjectionEngine = Pick<EngineClient, "sendRequest" | "close" | "closeUnresponsive" | "waitForExit" | "helloAck">;
type WireLimits = NonNullable<EngineClient["helloAck"]>["limits"];

export interface EngineProjectionOptions {
  readonly engineExecutable: string;
  /** Requests the engine runs at once. */
  readonly maxInFlight: number;
  /** Requests that wait for a slot, and the encoded bytes they may hold, before later ones are refused as busy. */
  readonly maxQueued: number;
  readonly maxQueuedBytes: number;
  readonly deadlineMs: number;
  readonly connectTimeoutMs: number;
  /** The first delay before a stopped engine starts again, doubling up to the maximum. */
  readonly restartBackoffMs: { readonly initial: number; readonly max: number };
  /** Address space the engine may map, on POSIX hosts. Windows has no per-process limit without a job object. */
  readonly maxAddressSpaceBytes: number;
  readonly launch?: (options: EngineClientSpawnOptions) => Promise<ProjectionEngine>;
  readonly now?: () => number;
}

export const DOCUMENT_PROJECTION_LIMITS = Object.freeze({
  maxInFlight: 2, maxQueued: 32, maxQueuedBytes: 64 * 1024 * 1024, deadlineMs: 30_000, connectTimeoutMs: 30_000,
  restartBackoffMs: Object.freeze({ initial: 250, max: 30_000 }), maxAddressSpaceBytes: 4 * 1024 * 1024 * 1024,
});

// JSON field names, the method, and the request id around the encoded updates.
const ENVELOPE_RESERVE_BYTES = 1_024;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refused = (reason: EngineProjectionRefusal, message: string): EngineProjection => Object.freeze({ kind: "refused", reason, message });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Starts the engine child that derives shared documents' settled files with
 * its `ydoc.project` method, and proves it answers before the relay listens.
 * The child parses untrusted Y.Doc updates, so it gets no environment from
 * the relay and, on POSIX, a bounded address space. A crash or a hang ends
 * only the child, which starts again after a growing delay. The child also
 * ends when the relay does: its stdin closes, and the engine exits on that.
 */
export async function startEngineProjection(options: EngineProjectionOptions) {
  const { engineExecutable, maxInFlight, maxQueued, maxQueuedBytes, deadlineMs, connectTimeoutMs, restartBackoffMs, maxAddressSpaceBytes } = options;
  const launch = options.launch ?? createEngineClient;
  const now = options.now ?? (() => performance.now());
  if (!isAbsolute(engineExecutable) || !statSync(engineExecutable, { throwIfNoEntry: false })?.isFile()) {
    throw new TypeError("The engine executable must be an absolute path to a file.");
  }
  if ([maxInFlight, maxQueuedBytes, deadlineMs, connectTimeoutMs, restartBackoffMs.initial, restartBackoffMs.max, maxAddressSpaceBytes]
    .some(value => !Number.isSafeInteger(value) || value < 1) || !Number.isSafeInteger(maxQueued) || maxQueued < 0) {
    throw new TypeError("Invalid engine projection limits.");
  }
  // Recorded once. A restart runs the file only while it still has this digest,
  // so every projection names the engine that made it.
  const engineSha256 = await fileSha256(engineExecutable);
  const lifetime = new AbortController();
  const spawn: Pick<EngineClientSpawnOptions, "command" | "args" | "env"> = process.platform === "win32"
    ? { command: engineExecutable, env: { SystemRoot: process.env.SystemRoot } }
    : { command: "/bin/sh", args: ["-c", 'ulimit -v "$1" && exec "$0"', engineExecutable, String(Math.floor(maxAddressSpaceBytes / 1024))],
        env: { MALLOC_ARENA_MAX: "2" } };
  type Started = Promise<ProjectionEngine>;
  let current: Started | undefined, closed = false, active = 0, requestId = 0, launches = 0, failures = 0, restartAt = 0, queuedBytes = 0;
  const clients = new Set<ProjectionEngine>();
  const waiting: { bytes: number; grant: () => void; deny: () => void }[] = [];

  const retire = (engine: Started, how: "closed" | "failed" | "killed") => {
    if (current !== engine) return;
    current = undefined;
    if (how !== "closed") {
      failures += 1;
      restartAt = now() + Math.min(restartBackoffMs.max, restartBackoffMs.initial * 2 ** (failures - 1));
    }
    void engine.then(client => { if (how === "killed") client.closeUnresponsive(); else client.close(); }, () => undefined);
  };
  const start = (): Started => {
    const engine: Started = (async () => {
      if (launches++ > 0 && await fileSha256(engineExecutable) !== engineSha256) {
        throw new Error("The engine executable changed after the relay started. Restart the relay to use it.");
      }
      const client = await launch({ ...spawn, inheritEnvironment: false, authToken: randomBytes(32).toString("base64url"),
        protocolVersion: 2, capabilities: [], connectTimeoutMs, signal: lifetime.signal,
        onExit: () => retire(engine, "failed"), onStderr: text => console.error("[engine-projection]", text.trimEnd()) });
      clients.add(client);
      void client.waitForExit().then(() => clients.delete(client));
      return client;
    })();
    engine.catch(() => retire(engine, "failed"));
    return current = engine;
  };

  // Prove the file is an engine that answers `ydoc.project` before the relay listens.
  const first = start();
  let limits: WireLimits;
  try {
    const client = await first;
    const ping = await client.sendRequest({ id: ++requestId, method: "engine.ping", params: {}, deadlineMs: connectTimeoutMs });
    if ((ping.result as { ok?: unknown } | null)?.ok !== true) throw new Error("It did not answer engine.ping.");
    const probe = await client.sendRequest({ id: ++requestId, method: "ydoc.project", params: {}, deadlineMs: connectTimeoutMs })
      .then(() => undefined, (error: unknown) => error);
    if (!(probe instanceof EngineRequestError && probe.wireError?.code === "INVALID_PARAMS")) {
      throw new Error("It does not provide ydoc.project, so it is older than this relay.");
    }
    if (!client.helloAck) throw new Error("It sent no wire limits.");
    limits = client.helloAck.limits;
  } catch (error) {
    lifetime.abort();
    retire(first, "closed");
    await first.then(client => client.waitForExit(), () => undefined);
    throw new Error(`The engine at ${engineExecutable} did not start. ${message(error)}`);
  }

  // Checked before the updates are encoded or queued: an envelope past the
  // engine's wire limits ends the whole engine session, not one request.
  const encodedBytes = (input: EngineProjectionInput): number | EngineProjection => {
    if (input.updates.length > limits.maxCollectionLen) {
      return refused("too-large", `The document has ${input.updates.length} updates; one engine request carries at most ${limits.maxCollectionLen}.`);
    }
    let bytes = ENVELOPE_RESERVE_BYTES;
    for (const update of input.updates) {
      const encoded = 4 * Math.ceil(update.byteLength / 3);
      if (encoded > limits.maxStringBytes) {
        return refused("too-large", `One update encodes to ${encoded} bytes; the engine accepts strings of at most ${limits.maxStringBytes}.`);
      }
      bytes += encoded + 3;
    }
    if (bytes > limits.maxFrameBytes) {
      return refused("too-large", `The updates encode to ${bytes} bytes; one engine request carries at most ${limits.maxFrameBytes}.`);
    }
    return bytes;
  };
  const admit = (bytes: number, signal?: AbortSignal): boolean | Promise<boolean> => {
    if (active < maxInFlight) { active += 1; return true; }
    if (waiting.length >= maxQueued || queuedBytes + bytes > maxQueuedBytes) return false;
    queuedBytes += bytes;
    return new Promise(resolve => {
      const settle = (granted: boolean) => { queuedBytes -= bytes; signal?.removeEventListener("abort", abort); resolve(granted); };
      const entry = { bytes, grant: () => settle(true), deny: () => settle(false) };
      const abort = () => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); settle(false); };
      waiting.push(entry);
      signal?.addEventListener("abort", abort, { once: true });
    });
  };
  const release = () => { const next = waiting.shift(); if (next) next.grant(); else active -= 1; };

  const classify = (error: unknown, engine: Started | undefined): EngineProjection => {
    if (error instanceof EngineRequestError) {
      const code = error.wireError?.code;
      if (code === "INVALID_PARAMS" || code === "INTERNAL") return refused("invalid", error.message);
      if (code === "PAYLOAD_TOO_LARGE") return refused("too-large", error.message);
      if (code === "OVERLOADED") return refused("busy", error.message);
    }
    if (error instanceof EngineClientError && error.code === "request-too-large") return refused("too-large", error.message);
    // A deadline leaves the projection running in the engine, so the child ends with it.
    const deadline = error instanceof EngineRequestDeadlineError ||
      (error instanceof EngineRequestError && error.wireError?.code === "DEADLINE_EXCEEDED");
    if (engine) retire(engine, deadline ? "killed" : "failed");
    return refused("unavailable", message(error));
  };

  // Holds its slot until the engine answers or the child ends, whoever waits.
  const run = async (input: EngineProjectionInput): Promise<EngineProjection> => {
    let engine: Started | undefined;
    try {
      if (closed) return refused("unavailable", "The engine projection is closed.");
      if (!current && now() < restartAt) {
        return refused("unavailable", `The engine stopped. It starts again in ${Math.ceil(restartAt - now())} ms.`);
      }
      engine = current ?? start();
      const client = await engine;
      const params = { contentKind: input.contentKind,
        updatesBase64: input.updates.map(update => Buffer.from(update.buffer, update.byteOffset, update.byteLength).toString("base64")) };
      const response = await client.sendRequest({ id: ++requestId, method: "ydoc.project", params, deadlineMs });
      const row = response.result as Record<string, unknown> | null;
      if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "contentBase64,sourceStateVectorSha256" ||
        typeof row.contentBase64 !== "string" || typeof row.sourceStateVectorSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.sourceStateVectorSha256)) return refused("invalid", "The engine returned an invalid projection.");
      const content = Buffer.from(row.contentBase64, "base64");
      if (content.toString("base64") !== row.contentBase64) return refused("invalid", "The engine returned an invalid projection.");
      failures = 0;
      return Object.freeze({ kind: "projected", content, sha256: sha256(content), sourceStateVectorSha256: row.sourceStateVectorSha256, engineSha256 });
    } catch (error) {
      return classify(error, engine);
    } finally { release(); }
  };
  // An aborted caller stops waiting; the slot stays with the work.
  const detach = (work: Promise<EngineProjection>, signal: AbortSignal) => new Promise<EngineProjection>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(result => { signal.removeEventListener("abort", abort); resolve(result); });
  });

  return Object.freeze({
    engineSha256,
    async project(input: EngineProjectionInput, signal?: AbortSignal): Promise<EngineProjection> {
      signal?.throwIfAborted();
      if (closed) return refused("unavailable", "The engine projection is closed.");
      const bytes = encodedBytes(input);
      if (typeof bytes !== "number") return bytes;
      if (!await admit(bytes, signal)) {
        signal?.throwIfAborted();
        return closed ? refused("unavailable", "The engine projection is closed.")
          : refused("busy", `Every engine projection slot is taken and the queue is full (${maxQueued} requests or ${maxQueuedBytes} bytes).`);
      }
      const work = run(input);
      return signal ? detach(work, signal) : work;
    },
    /** Refuses new projections, stops a launch in progress, and waits for every engine child to exit. */
    async close(): Promise<void> {
      closed = true;
      lifetime.abort();
      for (const entry of waiting.splice(0)) entry.deny();
      const engine = current;
      if (engine) { retire(engine, "closed"); await engine.catch(() => undefined); }
      for (const client of clients) client.close();
      await Promise.all([...clients].map(client => client.waitForExit()));
    },
  });
}
