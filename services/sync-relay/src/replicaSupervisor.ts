import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SyncRelayStorage } from "./storage";
import { observeRelayWrites } from "./relayWriteChanges";
import { createReplicaReadPrincipal, type ReplicaReadLease } from "./replicaReadPrincipal";

/** PR 2's catch-up and store budgets belong at the startChild boundary. */
export const REPLICA_SUPERVISOR_LIMITS = Object.freeze({ maxRunning: 4, idleMs: 5 * 60_000 });
export interface ReplicaChild {
  readonly pid?: number;
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
  for (const value of [limits.maxRunning, limits.idleMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid replica budget.");
  }
  const principal = createReplicaReadPrincipal(options.storage);
  const entries = new Map<string, Entry>();
  let closed = false;
  let notification: ReturnType<typeof setTimeout> | undefined;
  let notificationDone = Promise.resolve();
  let finishNotification = () => {};
  const report = (entry: Entry, error: unknown) => options.onError?.(entry.lease.workspaceId, error);

  async function retire(entry: Entry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.stopping = true;
    principal.revoke(entry.lease);
    clearTimeout(entry.idle);
    entry.retirement = (async () => {
      // Startup may still own the directory and child. Wait before disposing either.
      await entry.run?.catch(() => {});
      await entry.child?.close();
      if (entry.storeDir) await rm(entry.storeDir, { recursive: true, force: true });
      entries.delete(entry.lease.workspaceId);
    })();
    return entry.retirement;
  }

  function schedule(entry: Entry): Promise<void> {
    clearTimeout(entry.idle);
    entry.dirty = true;
    if (entry.run) return entry.run;
    entry.run = (async () => {
      if (!entry.child) {
        await mkdir(options.storeRoot, { recursive: true, mode: 0o700 });
        entry.storeDir = await mkdtemp(join(options.storeRoot, "replica-"));
        if (!entry.stopping && principal.current(entry.lease)) {
          entry.child = await options.startChild({ storeDir: entry.storeDir, lease: entry.lease });
        }
      }
      while (entry.dirty && !entry.stopping) {
        if (!principal.current(entry.lease)) break;
        entry.dirty = false;
        const frontier = options.storage.readReplicaStanding(entry.lease.workspaceId)!.logSeq;
        await entry.child!.pull();
        entry.frontier = frontier;
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
    }, error => { report(entry, error); void retire(entry).catch(failure => report(entry, failure)); });
    return running;
  }

  // Batch append notifications briefly so owner responses leave before replica reads re-enter.
  const unsubscribe = observeRelayWrites(options.storage, () => {
    if (closed || notification) return;
    notificationDone = new Promise<void>(resolve => { finishNotification = resolve; });
    notification = setTimeout(() => {
      notification = undefined;
      for (const entry of entries.values()) {
        if (entry.stopping) continue;
        if (!principal.current(entry.lease)) void retire(entry).catch(error => report(entry, error));
        else if (options.storage.readReplicaStanding(entry.lease.workspaceId)!.logSeq !== entry.frontier) {
          void schedule(entry).catch(() => {});
        }
      }
      finishNotification();
    }, 20);
  });

  async function activate(workspaceId: string): Promise<void> {
    if (closed) throw new Error("Replica supervisor is closed.");
    let entry = entries.get(workspaceId);
    if (entry && (entry.stopping || !principal.current(entry.lease))) {
      await retire(entry);
      return activate(workspaceId);
    }
    if (!entry) {
      if (entries.size >= limits.maxRunning) throw new Error("Replica capacity reached.");
      const lease = principal.issue(workspaceId, randomUUID());
      entry = { lease, frontier: -1, dirty: true, stopping: false };
      entries.set(workspaceId, entry);
    }
    await schedule(entry);
    if (entry.stopping || !principal.current(entry.lease)) throw new Error("Replica standing ended during activation.");
  }

  return {
    handle: principal.handle,
    activate,
    async settled(workspaceId: string): Promise<void> {
      await Promise.resolve();
      await notificationDone;
      const entry = entries.get(workspaceId);
      await entry?.run;
      await entry?.retirement;
    },
    async evict(workspaceId: string): Promise<void> { const entry = entries.get(workspaceId); if (entry) await retire(entry); },
    async close(): Promise<void> {
      closed = true;
      unsubscribe();
      if (notification) clearTimeout(notification);
      notification = undefined;
      finishNotification();
      await Promise.all([...entries.values()].map(retire));
    },
  };
}
