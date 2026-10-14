import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SyncRelayStorage } from "./storage";
import { observeRelayWrites } from "./relayWriteChanges";
import { createReplicaReadPrincipal, type ReplicaReadLease } from "./replicaReadPrincipal";

/** PR 2's catch-up and store budgets belong at the startChild boundary. */
export const REPLICA_SUPERVISOR_LIMITS = Object.freeze({ maxRunning: 4, idleMs: 5 * 60_000 });
export interface ReplicaChild {
  readonly pid?: number;
  readonly exited?: Promise<void>;
  pull(): Promise<void>;
  close(): Promise<void>;
}
export interface ReplicaChildInput {
  readonly storeDir: string;
  readonly lease: ReplicaReadLease;
}
export interface ReplicaSupervisorOptions {
  readonly storage: SyncRelayStorage;
  readonly storeRoot: string;
  readonly startChild: (input: ReplicaChildInput) => Promise<ReplicaChild>;
  readonly maxRunning?: number;
  readonly idleMs?: number;
  readonly onError?: (workspaceId: string, error: unknown) => void;
}
interface Entry {
  lease: ReplicaReadLease;
  storeDir?: string;
  child?: ReplicaChild;
  frontier: number;
  dirty: boolean;
  stopping: boolean;
  run?: Promise<void>;
  retirement?: Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
}

/** Explicit construction only. Production startup must wait for PR 6's readers. */
export function createReplicaSupervisor(options: ReplicaSupervisorOptions) {
  const limits = { ...REPLICA_SUPERVISOR_LIMITS, ...options };
  if (!isAbsolute(options.storeRoot)) throw new TypeError("Replica store root must be absolute.");
  if (dirname(resolve(options.storeRoot)) === resolve(options.storeRoot)) throw new TypeError("Replica store root must be a private directory.");
  for (const value of [limits.maxRunning, limits.idleMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid replica budget.");
  }
  const principal = createReplicaReadPrincipal(options.storage);
  const entries = new Map<string, Entry>();
  // Leases and stores belong to this process. Finish the crash sweep before activation.
  // Only this supervisor's replica-* stores are removed; anything else under the root stays.
  const ready = mkdir(options.storeRoot, { recursive: true, mode: 0o700 })
    .then(() => readdir(options.storeRoot, { withFileTypes: true }))
    .then(found => Promise.all(found.filter(item => item.isDirectory() && item.name.startsWith("replica-"))
      .map(item => rm(join(options.storeRoot, item.name), { recursive: true, force: true }))));
  void ready.catch(() => {});
  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let notification: ReturnType<typeof setTimeout> | undefined;
  let notificationDone = Promise.resolve();
  let finishNotification = () => {};
  const report = (entry: Entry, error: unknown) => options.onError?.(entry.lease.workspaceId, error);
  const standingCurrent = (lease: ReplicaReadLease) => {
    const standing = options.storage.readReplicaStanding(lease.workspaceId, lease.shareGrantBindings);
    return standing && standing.ownerUserId === lease.ownerUserId &&
      standing.replicationEpoch === lease.replicationEpoch && standing.streamIdentity === lease.streamIdentity ? standing : null;
  };
  function stopObserving() {
    unsubscribe?.(); unsubscribe = undefined;
    if (notification) clearTimeout(notification);
    notification = undefined;
    finishNotification();
  }

  async function retire(entry: Entry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.stopping = true;
    principal.revoke(entry.lease);
    clearTimeout(entry.idle);
    entry.retirement = (async () => {
      // Startup may still own the directory and child. Wait before disposing either.
      try {
        await entry.run?.catch(() => {});
        try { await entry.child?.close(); } catch (error) { report(entry, error); }
        finally {
          try { if (entry.storeDir) await rm(entry.storeDir, { recursive: true, force: true }); }
          catch (error) { report(entry, error); }
        }
      } finally {
        if (entries.get(entry.lease.workspaceId) === entry) entries.delete(entry.lease.workspaceId);
        if (entries.size === 0) stopObserving();
      }
    })();
    return entry.retirement;
  }

  function schedule(entry: Entry): Promise<void> {
    clearTimeout(entry.idle);
    entry.dirty = true;
    if (entry.run) return entry.run;
    entry.run = (async () => {
      const fresh = !entry.child;
      if (fresh) {
        await mkdir(options.storeRoot, { recursive: true, mode: 0o700 });
        entry.storeDir = await mkdtemp(join(options.storeRoot, "replica-"));
      }
      for (let attempt = 0; ; attempt++) {
        try {
          if (!entry.child && !entry.stopping && principal.current(entry.lease)) {
            entry.child = await options.startChild({ storeDir: entry.storeDir!, lease: entry.lease });
            const child = entry.child;
            void child.exited?.then(() => {
              // A first-pull crash belongs to the one-time fresh-store rebuild below.
              if (entry.child === child && !entry.stopping && entry.frontier >= 0) {
                report(entry, new Error("Replica child exited."));
                void retire(entry).catch(error => report(entry, error));
              }
            });
          }
          while (entry.dirty && !entry.stopping) {
            if (!principal.current(entry.lease)) break;
            entry.dirty = false;
            const frontier = options.storage.readReplicaStanding(entry.lease.workspaceId)!.logSeq;
            await entry.child!.pull();
            entry.frontier = frontier;
          }
          return;
        } catch (error) {
          if (!fresh || attempt === 1 || entry.frontier >= 0 || entry.stopping || !principal.current(entry.lease)) throw error;
          // A crash before the passive role is recorded can leave an owner-role store.
          principal.revoke(entry.lease);
          await entry.child?.close();
          entry.child = undefined;
          await rm(entry.storeDir!, { recursive: true, force: true });
          if (entry.stopping) throw error;
          await mkdir(entry.storeDir!, { mode: 0o700 });
          if (entry.stopping || !standingCurrent(entry.lease)) throw error;
          entry.lease = principal.issue(entry.lease.workspaceId, randomUUID());
          entry.dirty = true;
        }
      }
    })().finally(() => { entry.run = undefined; });
    const running = entry.run;
    void running.then(() => {
      if (entry.stopping) return;
      if (!principal.current(entry.lease)) void retire(entry).catch(error => report(entry, error));
      else {
        entry.idle = setTimeout(() => { void retire(entry).catch(error => report(entry, error)); }, limits.idleMs);
        entry.idle.unref();
      }
    }, error => {
      report(entry, error);
      void retire(entry).catch(failure => report(entry, failure));
    });
    return running;
  }

  // Batch append notifications briefly so owner responses leave before replica reads re-enter.
  function observeWrite() {
    if (closed || entries.size === 0 || notification) return;
    notificationDone = new Promise<void>(resolve => { finishNotification = resolve; });
    notification = setTimeout(() => {
      notification = undefined;
      for (const entry of entries.values()) {
        if (entry.stopping) continue;
        const standing = standingCurrent(entry.lease);
        if (!standing) void retire(entry).catch(error => report(entry, error));
        else if (standing.logSeq !== entry.frontier) {
          void schedule(entry).catch(() => {});
        }
      }
      finishNotification();
    }, 20);
  }

  async function activate(workspaceId: string): Promise<void> {
    await ready;
    if (closed) throw new Error("Replica supervisor is closed.");
    let entry = entries.get(workspaceId);
    if (entry && (entry.stopping || !standingCurrent(entry.lease))) {
      await retire(entry);
      return activate(workspaceId);
    }
    if (!entry) {
      if (entries.size >= limits.maxRunning) throw new Error("Replica capacity reached.");
      const lease = principal.issue(workspaceId, randomUUID());
      entry = { lease, frontier: -1, dirty: true, stopping: false };
      entries.set(workspaceId, entry);
      unsubscribe ??= observeRelayWrites(options.storage, observeWrite);
    }
    await schedule(entry);
    if (entry.stopping || !principal.current(entry.lease)) throw new Error("Replica standing ended during activation.");
  }

  return {
    handle: principal.handle,
    activate,
    async settled(workspaceId: string): Promise<void> {
      await ready;
      await Promise.resolve();
      await notificationDone;
      const entry = entries.get(workspaceId);
      await entry?.run;
      await entry?.retirement;
    },
    async evict(workspaceId: string): Promise<void> { const entry = entries.get(workspaceId); if (entry) await retire(entry); },
    async close(): Promise<void> {
      closed = true;
      stopObserving();
      await ready;
      await Promise.all([...entries.values()].map(retire));
    },
  };
}
