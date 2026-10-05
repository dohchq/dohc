import {
  EngineFileObservation,
  decodeFileObservationWake,
  type EngineWorkspaceSessions,
  type EngineDaemonLifecycle,
  type FileObservationChanges,
  type FileObservationCursor,
  type FileObservationFact,
} from "@dohc/workspace-engine-client/daemon";
import type { ActivityWorkspace } from "./workspaceActivity";
import { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { scopeOf } from "./captureActivityBridge";

export interface WorkspaceObservationHandle {
  ready: Promise<void>;
  stop(): Promise<void>;
  pulledPaths(paths: readonly string[]): Promise<void>;
  pullStarting(): void;
  pullFinished(): void;
}

export interface WorkspaceObservationCallbacks {
  facts(facts: readonly FileObservationFact[]): void;
  resync(): Promise<void>;
  captured(paths?: readonly string[]): void;
  pulled(paths: readonly string[]): void;
  degraded(unavailable: boolean): void;
}

// Read one cursor at a time. A wake received during a read schedules another
// read; neither capture ordering nor the transport's event queue is a cursor.
export function observeWorkspaceFiles(options: {
  read(cursor: FileObservationCursor | undefined, drain: boolean): Promise<FileObservationChanges & { degraded?: boolean }>;
  subscribe(wake: () => void, captured: (paths?: readonly string[]) => void): () => void;
  callbacks: WorkspaceObservationCallbacks;
  onError(error: unknown): void;
}): WorkspaceObservationHandle {
  let cursor: FileObservationCursor | undefined;
  let closing = false;
  let dirty = false;
  let chain = Promise.resolve();
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  let readySeen = false;
  let unavailable = false;
  // Deduplicate paths already delivered during this pull. Late feed facts
  // can safely reread consumers; a relay page never waits for a full walk.
  const observedPaths = new Set<string>();
  let pulling = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = 250;

  function degraded(): void {
    unavailable = true;
    options.callbacks.degraded(true);
    resolveReady();
  }

  async function apply(changes: FileObservationChanges & { degraded?: boolean }): Promise<void> {
    if (changes.resync && (readySeen || unavailable)) await options.callbacks.resync();
    if (pulling) for (const fact of changes.facts) observedPaths.add(fact.path);
    if (changes.facts.length) options.callbacks.facts(changes.facts);
    cursor = changes.cursor;
    if (changes.ready) {
      unavailable = false;
      options.callbacks.degraded(false);
      if (!readySeen) { readySeen = true; resolveReady(); }
    } else if (changes.degraded) degraded();
  }

  function enqueue(task: () => Promise<void>): Promise<void> {
    const next = chain.then(task);
    chain = next.catch(options.onError);
    return next;
  }

  function wake(): void {
    if (closing || dirty) return;
    dirty = true;
    void enqueue(async () => {
      dirty = false;
      if (closing) return;
      await apply(await options.read(cursor, false));
      retryMs = 250;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
    }).catch(() => {
      if (closing) return;
      degraded();
      // The engine retains wakes, so only failed reads need recovery.
      // Keep dirty until the retry to coalesce wakes during the backoff.
      dirty = true;
      if (retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        dirty = false;
        wake();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 5_000);
      retryTimer.unref?.();
    });
  }
  const unsubscribe = options.subscribe(wake, paths => {
    if (!closing) options.callbacks.captured(paths);
  });
  wake();
  let stopped: Promise<void> | undefined;
  return {
    ready,
    pullStarting() { pulling = true; observedPaths.clear(); },
    pullFinished() { pulling = false; observedPaths.clear(); },
    pulledPaths(paths) {
      if (closing) return Promise.resolve();
      try {
        const remaining = paths.filter(path => !observedPaths.has(path));
        if (remaining.length) options.callbacks.pulled(remaining);
      } catch (error) { options.onError(error); }
      return Promise.resolve();
    },
    stop() {
      if (stopped) return stopped;
      closing = true;
      resolveReady();
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
      stopped = enqueue(async () => {
        // Failure leaves the cursor and expected-delete tokens intact.
        await apply(await options.read(cursor, true));
      });
      return stopped;
    },
  };
}

export function startWorkspaceFileObservation(
  workspace: ActivityWorkspace & { captureMode?: "none" },
  sessions: EngineWorkspaceSessions,
  daemon: Pick<EngineDaemonLifecycle, "onEvent" | "onClientChanged">,
  callbacks: WorkspaceObservationCallbacks,
): WorkspaceObservationHandle {
  return observeWorkspaceFiles({
    read: (cursor, drain) => sessions.run(workspace, async binding => {
      const feed = new EngineFileObservation(binding.client, binding.workspace);
      const changes = await (drain ? feed.drain(cursor) : feed.changesSince(cursor));
      const degraded = !changes.ready && workspace.captureMode !== "none"
        ? (await new VersionedLiveAdapter(binding.client, binding.workspace, { workspaceId: workspace.workspaceId }).watcherStatus()).degraded
        : false;
      sessions.assertCurrentBinding(workspace, binding);
      return { ...changes, degraded };
    }),
    subscribe: (wake, captured) => {
      const eventOff = daemon.onEvent(event => {
        if (event.name === "workspace.filesChanged") {
          try {
            if (decodeFileObservationWake(event.payload).workspaceId === workspace.workspaceId) wake();
          } catch { wake(); }
        } else if (event.name === "capture.momentRecorded") {
          const scope = scopeOf(event.payload);
          if (!scope || scope.workspaceId === workspace.workspaceId) captured(scope?.paths ?? undefined);
        }
      });
      const clientOff = daemon.onClientChanged(wake);
      return () => { eventOff(); clientOff(); };
    },
    callbacks,
    onError: error => console.error(`[desktop] file observation for ${workspace.workspaceId}:`, error),
  });
}
