import type { WatcherEvent } from "@dohc/workspace-core";
import {
  classifyEngineFilePath,
  createVersionedTextStore,
  type ActorNeutralWriteMetadata,
  type VersionedTextStore,
} from "@dohc/workspace-engine";
import { isTextMediaType, mediaTypeForPath, scanWorkspaceFiles } from "@dohc/workspace-fs";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MAX_HISTORY_TEXT_SNAPSHOT_BYTES } from "./workspaceWatcher";

// PR 0M-3 watcher->engine capture (interim dual-write).
//
// While a workspace's `experimental.workspaceEngineAlpha` flag is on, every
// settled watcher batch is ALSO captured into the workspace engine's
// versioned text store (main version) beside the untouched legacy
// .dohc/history recording. The history UI still reads legacy records; lane
// 0M-5 flips the UI to engine moments and disables legacy recording for
// flagged workspaces. Engine state lives under `<root>/.dohc/engine/`.
//
// What the engine owns (shared policy, not local heuristics):
//   - classifyEngineFilePath (workspace-engine) excludes ignored segments and
//     `.env`-style secret paths — the SAME classifier engine search uses.
//   - Only UTF-8 text files up to MAX_HISTORY_TEXT_SNAPSHOT_BYTES are
//     captured (the legacy history snapshot pipeline's text heuristics).
//     Binary, oversized, non-UTF-8, and secret files are skipped entirely —
//     no metadata-only engine moments; if a previously captured path stops
//     being engine-ownable text, it is removed from engine state so engine
//     state never goes stale-but-authoritative.
//
// Single engine record per physical write:
//   - a settled batch carries one final on-disk state per path, so rapid
//     writes coalesce into at most one engine moment per path per batch;
//   - a batch whose content already equals engine state is a no-op (this
//     also makes startup reconciliation idempotent);
//   - engine-originated disk writes (restore flows, future engine API/MCP
//     writes) register expected events via registerExpectedEngineEvents and
//     the matching watcher observation skips engine re-capture (consume-once
//     with expiry, the ActiveLocalOperation/expectedEvents precedent).
//     Legacy history still records those observations with the provenance it
//     gets today — only the ENGINE re-capture is suppressed.
//
// Concurrency and failure:
//   - all engine work runs on one internal promise chain in the main process,
//     off the IPC hot path: batch capture and startup reconciliation are
//     serialized against each other and never block the renderer;
//   - engine failures are logged and surfaced via onError but never crash the
//     watcher; legacy recording is untouched (fail open for legacy, fail
//     visible for engine).

export const EXPECTED_ENGINE_EVENT_EXPIRY_MS = 10_000;
export const MAX_ENGINE_CAPTURE_TEXT_BYTES = MAX_HISTORY_TEXT_SNAPSHOT_BYTES;

export interface ExpectedEngineEvent {
  path: string;
  operation: "write" | "delete";
  // sha256 of the written UTF-8 text; required for writes so a LATER user
  // edit to the same path can never be swallowed by a stale registration.
  sha256?: string;
}

export interface WorkspaceEngineCapture {
  // Kicks the background startup reconciliation (closed-period edits). Runs
  // on the capture chain, so it cannot interleave with live batch capture.
  start(): void;
  // Enqueues a settled watcher batch for engine capture. Synchronous and
  // non-throwing: the watcher's record chain never waits on the engine.
  captureBatch(events: readonly WatcherEvent[]): void;
  // Registers engine-originated disk writes the watcher is about to observe;
  // matching observations skip engine re-capture. Returns a cancel function.
  registerExpectedEngineEvents(events: readonly ExpectedEngineEvent[]): () => void;
  // Resolves when everything enqueued so far has been captured (tests).
  flush(): Promise<void>;
  // Stops accepting work and resolves once in-flight capture is durably
  // written — the workspace shutdown chain awaits this so the last capture
  // is never dropped.
  stop(): Promise<void>;
}

export interface WorkspaceEngineCaptureOptions {
  workspaceId: string;
  rootPath: string;
  // Injectable for tests; defaults to the workspace's .dohc/engine store.
  store?: VersionedTextStore;
  now?: () => number;
  onError?: (context: string, error: unknown) => void;
}

const ENGINE_MAIN_VERSION_ID = "main";

interface RegisteredExpectedEngineEvent extends ExpectedEngineEvent {
  expiresAtMs: number;
}

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

type DiskTextState =
  // Confirmed absent (ENOENT/ENOTDIR): the engine file, if any, was deleted.
  | { kind: "absent" }
  // Engine-ownable UTF-8 text within the size cap.
  | { kind: "text"; text: string; sha256: string }
  // Present but not engine-ownable (binary, oversized, or non-UTF-8 text).
  | { kind: "untracked-content" }
  // Transiently unreadable (EACCES/EBUSY/...): leave engine state alone.
  | { kind: "unreadable" };

async function readDiskTextState(rootPath: string, path: string): Promise<DiskTextState> {
  const absolute = join(rootPath, path);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { kind: "untracked-content" };
    if (!isTextMediaType(mediaTypeForPath(path), path)) return { kind: "untracked-content" };
    if (info.size > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const bytes = await readFile(absolute);
    if (bytes.length > MAX_ENGINE_CAPTURE_TEXT_BYTES) return { kind: "untracked-content" };
    const text = bytes.toString("utf8");
    // The engine only stores text that round-trips through UTF-8; anything
    // else is binary in disguise, not engine-ownable.
    if (!Buffer.from(text, "utf8").equals(bytes)) return { kind: "untracked-content" };
    return { kind: "text", text, sha256: sha256Utf8(text) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unreadable" };
  }
}

export function createWorkspaceEngineCapture(
  options: WorkspaceEngineCaptureOptions,
): WorkspaceEngineCapture {
  const { workspaceId, rootPath } = options;
  const now = options.now ?? (() => Date.now());
  const onError =
    options.onError ??
    ((context: string, error: unknown) => {
      console.error(
        `[desktop] workspace engine capture ${context} failed for ${rootPath}:`,
        error,
      );
    });

  let store: VersionedTextStore | null = options.store ?? null;
  let expectedEvents: RegisteredExpectedEngineEvent[] = [];
  let stopped = false;

  // THE serialization point: batch capture and reconciliation both run here,
  // strictly in order. A failed task logs and the chain stays alive. Work
  // enqueued before stop() still runs (stop refuses only NEW work), so the
  // final settled batch is never dropped on shutdown.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(context: string, task: () => Promise<void>): void {
    if (stopped) return;
    chain = chain.then(async () => {
      try {
        await task();
      } catch (error) {
        onError(context, error);
      }
    });
  }

  let initialized: Promise<VersionedTextStore> | null = null;
  function engineStore(): Promise<VersionedTextStore> {
    initialized ??= (async () => {
      store ??= createVersionedTextStore(rootPath);
      await store.ensureMainVersion({ workspaceId });
      return store;
    })();
    return initialized;
  }

  function consumeExpectedEvent(
    operation: "write" | "delete",
    path: string,
    sha256?: string,
  ): boolean {
    const nowMs = now();
    expectedEvents = expectedEvents.filter((event) => event.expiresAtMs > nowMs);
    const index = expectedEvents.findIndex(
      (event) =>
        event.path === path &&
        event.operation === operation &&
        (operation === "delete" || event.sha256 === sha256),
    );
    if (index < 0) return false;
    expectedEvents.splice(index, 1);
    return true;
  }

  async function deleteIfTracked(
    engine: VersionedTextStore,
    path: string,
    metadata: ActorNeutralWriteMetadata,
  ): Promise<boolean> {
    const current = await engine.readTextFile({
      workspaceId,
      versionId: ENGINE_MAIN_VERSION_ID,
      path,
    });
    if (!current) return false;
    await engine.deleteTextFile({
      workspaceId,
      versionId: ENGINE_MAIN_VERSION_ID,
      path,
      metadata,
    });
    return true;
  }

  async function writeIfChanged(
    engine: VersionedTextStore,
    path: string,
    disk: { text: string; sha256: string },
    metadata: ActorNeutralWriteMetadata,
  ): Promise<boolean> {
    const current = await engine.readTextFile({
      workspaceId,
      versionId: ENGINE_MAIN_VERSION_ID,
      path,
    });
    // Content equality is the no-op rule: it keeps one engine record per
    // physical write across settle windows and makes reconciliation
    // idempotent.
    if (current && current.text === disk.text) return false;
    await engine.writeTextFile({
      workspaceId,
      versionId: ENGINE_MAIN_VERSION_ID,
      path,
      text: disk.text,
      metadata,
    });
    return true;
  }

  async function captureOnePath(
    engine: VersionedTextStore,
    event: WatcherEvent,
    metadata: ActorNeutralWriteMetadata,
  ): Promise<void> {
    if (classifyEngineFilePath(event.path).kind !== "tracked") return;
    // Deletes trust the watcher's confirmed-absent check; updates re-read the
    // CURRENT disk state so rapid successive writes coalesce to the final
    // content instead of replaying stale event snapshots.
    if (event.operation === "delete") {
      if (consumeExpectedEvent("delete", event.path)) return;
      await deleteIfTracked(engine, event.path, metadata);
      return;
    }
    const disk = await readDiskTextState(rootPath, event.path);
    if (disk.kind === "unreadable") return;
    if (disk.kind === "absent") {
      if (consumeExpectedEvent("delete", event.path)) return;
      await deleteIfTracked(engine, event.path, metadata);
      return;
    }
    if (disk.kind === "untracked-content") {
      // The path stopped being engine-ownable text: retire it from engine
      // state rather than leaving a stale snapshot behind.
      await deleteIfTracked(engine, event.path, {
        ...metadata,
        summary: "Stopped tracking non-text content",
      });
      return;
    }
    if (consumeExpectedEvent("write", event.path, disk.sha256)) return;
    await writeIfChanged(engine, event.path, disk, metadata);
  }

  async function reconcile(): Promise<void> {
    const engine = await engineStore();
    // One actor-neutral correlation id ties the pass's per-file moments
    // together as "reconciled offline edits" without inventing an author.
    const metadata: ActorNeutralWriteMetadata = {
      origin: "local-file",
      summary: "Reconciled offline edits",
      correlationId: `reconcile-${randomUUID()}`,
    };
    const scanned = await scanWorkspaceFiles(rootPath);
    const diskPaths = new Set<string>();
    for (const file of scanned) {
      if (classifyEngineFilePath(file.path).kind !== "tracked") continue;
      diskPaths.add(file.path);
      const disk = await readDiskTextState(rootPath, file.path);
      if (disk.kind === "unreadable") continue;
      if (disk.kind === "text") {
        await writeIfChanged(engine, file.path, disk, metadata);
      } else {
        // absent (raced a delete) or no longer engine-ownable text.
        await deleteIfTracked(engine, file.path, metadata);
        diskPaths.delete(file.path);
      }
    }
    // Files the engine tracked that no longer exist on disk were deleted
    // while dohc was closed; reconcile the deletions too.
    const tracked = await engine.listTextFiles({
      workspaceId,
      versionId: ENGINE_MAIN_VERSION_ID,
    });
    for (const snapshot of tracked) {
      if (diskPaths.has(snapshot.path)) continue;
      await deleteIfTracked(engine, snapshot.path, metadata);
    }
  }

  return {
    start() {
      enqueue("startup reconciliation", reconcile);
    },

    captureBatch(events) {
      if (events.length === 0) return;
      const batch = events.map((event) => ({ ...event }));
      enqueue("batch capture", async () => {
        const engine = await engineStore();
        const metadata: ActorNeutralWriteMetadata = { origin: "local-file" };
        for (const event of batch) {
          try {
            await captureOnePath(engine, event, metadata);
          } catch (error) {
            // One bad path must not drop the rest of the batch.
            onError(`batch capture of ${event.path}`, error);
          }
        }
      });
    },

    registerExpectedEngineEvents(events) {
      const registered: RegisteredExpectedEngineEvent[] = events.map((event) => ({
        ...event,
        expiresAtMs: now() + EXPECTED_ENGINE_EVENT_EXPIRY_MS,
      }));
      expectedEvents.push(...registered);
      return () => {
        expectedEvents = expectedEvents.filter((event) => !registered.includes(event));
      };
    },

    flush() {
      return chain;
    },

    async stop() {
      // Everything already enqueued (including the watcher's final settled
      // batch) still runs; only NEW work is refused.
      stopped = true;
      await chain;
    },
  };
}
