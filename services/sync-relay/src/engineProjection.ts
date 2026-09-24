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
 * - `too-large`: the updates exceed one engine request, or the file exceeds the live-editing limit.
 * - `invalid`: the engine cannot project these updates, or failed on them.
 * - `unavailable`: the engine did not start, stopped, or passed its deadline. The next call starts another.
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

type ProjectionEngine = Pick<EngineClient, "sendRequest" | "close" | "closeUnresponsive" | "waitForExit">;

export interface EngineProjectionOptions {
  readonly engineExecutable: string;
  /** Requests the engine runs at once. */
  readonly maxInFlight: number;
  /** Requests that wait for a slot before later ones are refused as busy. */
  readonly maxQueued: number;
  readonly deadlineMs: number;
  readonly connectTimeoutMs: number;
  readonly launch?: (options: EngineClientSpawnOptions) => Promise<ProjectionEngine>;
}

export const DOCUMENT_PROJECTION_LIMITS = Object.freeze({
  maxInFlight: 2, maxQueued: 32, deadlineMs: 30_000, connectTimeoutMs: 30_000,
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const refused = (reason: EngineProjectionRefusal, message: string): EngineProjection => Object.freeze({ kind: "refused", reason, message });

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Derives a document's settled file with the engine's `ydoc.project` method,
 * through one long-lived engine child. The child starts on first use and
 * again after it stops; a crash or a hang ends only the child.
 */
export function createEngineProjection(options: EngineProjectionOptions) {
  const { engineExecutable, maxInFlight, maxQueued, deadlineMs, connectTimeoutMs } = options;
  const launch = options.launch ?? createEngineClient;
  if (!isAbsolute(engineExecutable) || !statSync(engineExecutable, { throwIfNoEntry: false })?.isFile()) {
    throw new TypeError("The engine executable must be an absolute path to a file.");
  }
  if ([maxInFlight, deadlineMs, connectTimeoutMs].some(value => !Number.isSafeInteger(value) || value < 1) ||
    !Number.isSafeInteger(maxQueued) || maxQueued < 0) throw new TypeError("Invalid engine projection limits.");
  type Started = Promise<{ readonly client: ProjectionEngine; readonly engineSha256: string }>;
  let current: Started | undefined, closed = false, active = 0, requestId = 0;
  const clients = new Set<ProjectionEngine>();
  const waiting: { grant: () => void; deny: () => void }[] = [];

  const retire = (engine: Started, force: boolean) => {
    if (current === engine) current = undefined;
    void engine.then(({ client }) => { if (force) client.closeUnresponsive(); else client.close(); }, () => undefined);
  };
  const start = (): Started => {
    const engine: Started = (async () => {
      const engineSha256 = await fileSha256(engineExecutable);
      const client = await launch({ command: engineExecutable, authToken: randomBytes(32).toString("base64url"),
        protocolVersion: 2, capabilities: [], connectTimeoutMs,
        onExit: () => retire(engine, false), onStderr: text => console.error("[engine-projection]", text.trimEnd()) });
      clients.add(client);
      void client.waitForExit().then(() => clients.delete(client));
      return { client, engineSha256 };
    })();
    engine.catch(() => retire(engine, false));
    return current = engine;
  };
  const acquire = (signal?: AbortSignal): boolean | Promise<boolean> => {
    if (active < maxInFlight) { active += 1; return true; }
    if (waiting.length >= maxQueued) return false;
    return new Promise(resolve => {
      const settle = (granted: boolean) => { signal?.removeEventListener("abort", abort); resolve(granted); };
      const entry = { grant: () => settle(true), deny: () => settle(false) };
      const abort = () => { const at = waiting.indexOf(entry); if (at >= 0) waiting.splice(at, 1); resolve(false); };
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
    if (engine) retire(engine, deadline);
    return refused("unavailable", error instanceof Error ? error.message : String(error));
  };

  return Object.freeze({
    async project(input: EngineProjectionInput, signal?: AbortSignal): Promise<EngineProjection> {
      signal?.throwIfAborted();
      if (closed) return refused("unavailable", "The engine projection is closed.");
      const params = { contentKind: input.contentKind,
        updatesBase64: input.updates.map(update => Buffer.from(update.buffer, update.byteOffset, update.byteLength).toString("base64")) };
      if (!await acquire(signal)) {
        signal?.throwIfAborted();
        return closed ? refused("unavailable", "The engine projection is closed.")
          : refused("busy", `Every engine projection slot is taken and ${maxQueued} requests are waiting.`);
      }
      let engine: Started | undefined;
      try {
        if (closed) return refused("unavailable", "The engine projection is closed.");
        engine = current ?? start();
        const { client, engineSha256 } = await engine;
        const response = await client.sendRequest({ id: ++requestId, method: "ydoc.project", params, deadlineMs }, signal);
        const row = response.result as Record<string, unknown> | null;
        if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "contentBase64,sourceStateVectorSha256" ||
          typeof row.contentBase64 !== "string" || typeof row.sourceStateVectorSha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sourceStateVectorSha256)) return refused("invalid", "The engine returned an invalid projection.");
        const content = Buffer.from(row.contentBase64, "base64");
        if (content.toString("base64") !== row.contentBase64) return refused("invalid", "The engine returned an invalid projection.");
        return Object.freeze({ kind: "projected", content, sha256: sha256(content),
          sourceStateVectorSha256: row.sourceStateVectorSha256, engineSha256 });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        return classify(error, engine);
      } finally { release(); }
    },
    /** Refuses new projections and waits for every engine child to exit. */
    async close(): Promise<void> {
      closed = true;
      for (const entry of waiting.splice(0)) entry.deny();
      const engine = current;
      if (engine) { retire(engine, false); await engine.catch(() => undefined); }
      for (const client of clients) client.close();
      await Promise.all([...clients].map(client => client.waitForExit()));
    },
  });
}
