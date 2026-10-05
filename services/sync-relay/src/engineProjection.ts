import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import {
  EngineClient,
  DuplexEngineClientConnection,
  EngineRequestError,
} from "@dohc/workspace-engine-client/daemon";

const MAX_FRAME_BYTES = 14 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_UPDATES = 16_384;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const DOCUMENT_PROJECTION_LIMITS = Object.freeze({
  deadlineMs: 30_000,
  maxQueued: 32,
  maxQueuedBytes: 64 * 1024 * 1024,
  maxAddressSpaceBytes: 4 * 1024 * 1024 * 1024,
});
export interface EngineProjectionInput {
  readonly contentKind: "richdoc" | "plaintext";
  readonly updates: readonly Uint8Array[];
}
export type EngineProjection =
  | {
      readonly kind: "projected";
      readonly content: Buffer;
      readonly sha256: string;
      readonly sourceStateVectorSha256: string;
      readonly engineSha256: string;
    }
  | {
      readonly kind: "refused";
      readonly reason:
        | "too-large"
        | "invalid"
        | "busy"
        | "unavailable"
        | "timeout"
        | "cancelled";
      readonly message: string;
    };
export interface EngineProjectionService {
  readonly engineSha256: string;
  project(
    input: EngineProjectionInput,
    signal?: AbortSignal,
  ): Promise<EngineProjection>;
  close(): Promise<void>;
}
type SpawnChild = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;
export interface EngineProjectionOptions {
  readonly engineExecutable: string;
  readonly allowUnisolatedProjection?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly deadlineMs?: number;
  readonly maxQueued?: number;
  readonly maxQueuedBytes?: number;
  readonly maxAddressSpaceBytes?: number;
  readonly spawnChild?: SpawnChild;
}
const refused = (
  reason: Extract<EngineProjection, { kind: "refused" }>["reason"],
  message: string,
): EngineProjection => ({ kind: "refused", reason, message });
interface Job {
  input: EngineProjectionInput;
  bytes: number;
  resolve(result: EngineProjection): void;
  signal?: AbortSignal;
  abort?: () => void;
  child?: ChildProcessWithoutNullStreams;
}

/** Separate process per job; no live host, workspace, config file or inherited environment. */
export async function startEngineProjection(
  options: EngineProjectionOptions,
): Promise<EngineProjectionService> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" && !options.allowUnisolatedProjection) {
    throw new Error(
      "Document projection requires Linux memory isolation; development can explicitly set DOHC_RELAY_ALLOW_UNISOLATED_PROJECTION=1.",
    );
  }
  const settings = { ...DOCUMENT_PROJECTION_LIMITS, ...options };
  for (const key of [
    "deadlineMs",
    "maxQueued",
    "maxQueuedBytes",
    "maxAddressSpaceBytes",
  ] as const) {
    if (
      !Number.isSafeInteger(settings[key]) ||
      settings[key] < (key === "maxQueued" ? 0 : 1)
    )
      throw new TypeError("Invalid projection budget.");
  }
  if (settings.maxAddressSpaceBytes < 1024)
    throw new TypeError("Invalid projection address-space budget.");
  const executable = options.engineExecutable;
  if (!isAbsolute(executable)) {
    throw new TypeError(
      "The projection engine must be an absolute executable file.",
    );
  }
  const binaryIdentity = await stat(executable, { bigint: true });
  if (!binaryIdentity.isFile()) {
    throw new TypeError(
      "The projection engine must be an absolute executable file.",
    );
  }
  const engineSha256 = hash(await readFile(executable));
  const binaryUnchanged = async () => {
    const current = await stat(executable, { bigint: true });
    return (["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).every(
      (key) => current[key] === binaryIdentity[key],
    );
  };
  const spawnChild: SpawnChild =
    options.spawnChild ??
    ((command, args, opts) =>
      spawn(command, [...args], opts) as ChildProcessWithoutNullStreams);
  const queue: Job[] = [];
  let queuedBytes = 0;
  let closed = false;
  let active: Job | undefined;
  let running: Promise<void> | undefined;

  async function execute(job: Job): Promise<EngineProjection> {
    if (!(await binaryUnchanged()))
      return refused(
        "unavailable",
        "The engine executable changed after startup.",
      );
    if (closed || job.signal?.aborted)
      return refused("cancelled", "Projection cancelled.");
    const command = platform === "linux" ? "/bin/sh" : executable;
    const args =
      platform === "linux"
        ? [
            "-c",
            'ulimit -v "$1" && exec /usr/bin/env -i "$0" --projection-only',
            executable,
            String(Math.floor(settings.maxAddressSpaceBytes / 1024)),
          ]
        : ["--projection-only"];
    const child = spawnChild(command, args, {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    job.child = child;
    let timedOut = false;
    const termination = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, settings.deadlineMs);
    const connection = Duplex.from({
      readable: child.stdout,
      writable: child.stdin,
    });
    const client = new EngineClient(
      new DuplexEngineClientConnection(connection),
      {
        authToken: "",
        protocolVersion: 2,
        capabilities: ["projection-only"],
        maxFrameBytes: MAX_FRAME_BYTES,
        connectTimeoutMs: settings.deadlineMs,
      },
      () => child.kill("SIGKILL"),
      termination,
    );
    child.on("error", (error) => connection.destroy(error));
    // The one-shot engine can exit before its final stdout reaches the client.
    child.on("close", (code, signal) => client.notifyProcessExit(code, signal));
    // Drain diagnostics without retaining owner-supplied content or letting a full pipe stall the child.
    child.stderr.resume();
    try {
      await client.ready();
      const ping = await client.sendRequest({
        id: 1,
        method: "engine.ping",
        params: {},
      });
      if (
        typeof ping.result !== "object" ||
        ping.result === null ||
        (ping.result as { mode?: unknown }).mode !== "projection-only"
      ) {
        return refused(
          "unavailable",
          "The engine does not provide projection-only mode.",
        );
      }
      const response = await client.sendRequest({
        id: 2,
        method: "ydoc.project",
        params: {
          contentKind: job.input.contentKind,
          updatesBase64: job.input.updates.map((update) =>
            Buffer.from(update).toString("base64"),
          ),
        },
      });
      const row = response.result as {
        contentBase64?: unknown;
        sourceStateVectorSha256?: unknown;
      } | null;
      if (
        !row ||
        typeof row.contentBase64 !== "string" ||
        row.contentBase64.length > 4 * Math.ceil(MAX_OUTPUT_BYTES / 3) ||
        typeof row.sourceStateVectorSha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.sourceStateVectorSha256)
      ) {
        return refused(
          "invalid",
          "The engine returned an invalid or oversized projection.",
        );
      }
      const content = Buffer.from(row.contentBase64, "base64");
      if (
        content.length > MAX_OUTPUT_BYTES ||
        content.toString("base64") !== row.contentBase64
      )
        return refused(
          "invalid",
          "The engine returned invalid projection bytes.",
        );
      connection.end();
      await termination;
      if (timedOut)
        return refused(
          "timeout",
          "Projection exceeded its deadline during shutdown.",
        );
      if (child.exitCode !== 0)
        return refused(
          "unavailable",
          "Projection child did not exit successfully.",
        );
      return {
        kind: "projected",
        content,
        sha256: hash(content),
        sourceStateVectorSha256: row.sourceStateVectorSha256,
        engineSha256,
      };
    } catch (error) {
      if (job.signal?.aborted)
        return refused("cancelled", "Projection cancelled.");
      if (timedOut)
        return refused("timeout", "Projection exceeded its deadline.");
      if (error instanceof EngineRequestError && error.wireError)
        return refused(
          error.wireError.code === "PAYLOAD_TOO_LARGE"
            ? "too-large"
            : "invalid",
          error.wireError.message,
        );
      return refused("unavailable", "The isolated projection engine failed.");
    } finally {
      // A response, cancellation or wire failure never frees the slot before process close.
      connection.end();
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await termination;
      clearTimeout(timer);
      client.close();
      job.child = undefined;
    }
  }
  async function drain(): Promise<void> {
    while (!closed && queue.length) {
      const job = queue.shift()!;
      queuedBytes -= job.bytes;
      active = job;
      try {
        job.resolve(await execute(job));
      } catch {
        job.resolve(
          refused(
            "unavailable",
            "The isolated projection engine could not start.",
          ),
        );
      } finally {
        job.signal?.removeEventListener("abort", job.abort!);
        active = undefined;
      }
    }
  }
  function schedule(): void {
    if (running) return;
    running = drain().finally(() => {
      running = undefined;
      if (!closed && queue.length) schedule();
    });
  }
  const service: EngineProjectionService = {
    engineSha256,
    project(input, signal) {
      if (closed)
        return Promise.resolve(refused("unavailable", "Projection is closed."));
      if (signal?.aborted)
        return Promise.resolve(refused("cancelled", "Projection cancelled."));
      if (
        !["richdoc", "plaintext"].includes(input.contentKind) ||
        input.updates.length === 0
      )
        return Promise.resolve(
          refused("invalid", "Projection requires a content kind and updates."),
        );
      let bytes = 1024;
      if (input.updates.length > MAX_UPDATES)
        return Promise.resolve(
          refused("too-large", "The update count exceeds 16384."),
        );
      for (const update of input.updates) {
        bytes += 4 * Math.ceil(update.byteLength / 3) + 3;
        if (bytes > MAX_FRAME_BYTES)
          return Promise.resolve(
            refused(
              "too-large",
              "The encoded updates exceed the 14 MiB wire budget.",
            ),
          );
      }
      if (
        running &&
        (queue.length >= settings.maxQueued ||
          queuedBytes + bytes > settings.maxQueuedBytes)
      )
        return Promise.resolve(
          refused("busy", "The projection queue is full."),
        );
      return new Promise((resolve) => {
        const job: Job = {
          input: {
            contentKind: input.contentKind,
            updates: input.updates.map((update) => new Uint8Array(update)),
          },
          bytes,
          resolve,
          signal,
        };
        job.abort = () => {
          const index = queue.indexOf(job);
          if (index >= 0) {
            queue.splice(index, 1);
            queuedBytes -= bytes;
            signal?.removeEventListener("abort", job.abort!);
          }
          job.resolve(refused("cancelled", "Projection cancelled."));
          job.child?.kill("SIGKILL");
        };
        signal?.addEventListener("abort", job.abort, { once: true });
        queue.push(job);
        queuedBytes += bytes;
        schedule();
      });
    },
    async close() {
      closed = true;
      for (const job of queue.splice(0)) {
        job.signal?.removeEventListener("abort", job.abort!);
        job.resolve(refused("unavailable", "Projection is closed."));
      }
      queuedBytes = 0;
      active?.child?.kill("SIGKILL");
      await running;
    },
  };
  const probe = await service.project({
    contentKind: "plaintext",
    updates: [new Uint8Array([0, 0])],
  });
  if (probe.kind !== "projected" || probe.content.length !== 0) {
    await service.close();
    throw new Error(
      `Projection engine did not pass startup probes: ${probe.kind === "refused" ? probe.reason + ": " + probe.message : "nonempty probe output"}`,
    );
  }
  return service;
}
