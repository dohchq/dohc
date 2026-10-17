import {currentViewFileVisible, ReplicaCurrentViewRefused} from "./storage/replicaCurrentViews";
import type {ReplicaCurrentView, ReplicaCurrentViewPage, ReplicaCurrentViewPosition, ReplicaCurrentViewCursor, ReplicaCurrentViewSelector} from "@dohc/workspace-engine-client/daemon";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SyncRelayStorage } from "./storage";
import { observeRelayWrites } from "./relayWriteChanges";
import { createReplicaReadPrincipal, type ReplicaReadLease } from "./replicaReadPrincipal";

/** PR 2's catch-up and store budgets belong at the startChild boundary. */
export const REPLICA_SUPERVISOR_LIMITS = Object.freeze({ maxRunning: 4, idleMs: 5 * 60_000, maxViewTextBytes: 64*1024*1024 });
export interface ReplicaChild {
  readonly pid?: number;
  readonly exited?: Promise<void>;
  pull(): Promise<void>;
  currentView(selectors: ReplicaCurrentViewSelector[], knownTextShas: string[], position?: ReplicaCurrentViewPosition, cursor?: ReplicaCurrentViewCursor): Promise<ReplicaCurrentViewPage>;
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
  readonly maxViewTextBytes?: number;
  readonly onError?: (workspaceId: string, error: unknown) => void;
}
interface Entry {
  lease: ReplicaReadLease;
  storeDir?: string;
  child?: ReplicaChild;
  frontier: number;
  journalFrontier: number;
  dirty: boolean;
  stopping: boolean;
  run?: Promise<void>;
  retirement?: Promise<void>;
  idle?: ReturnType<typeof setTimeout>;
  newest?: ReplicaCurrentView;
  pendingView?: boolean;
  reportedOmissions?: Set<string>;
  quiet?: ReturnType<typeof setTimeout>;
  ceiling?: ReturnType<typeof setTimeout>;
}

/** Explicit construction only. Production startup must wait for PR 6's readers. */
export function createReplicaSupervisor(options: ReplicaSupervisorOptions) {
  const limits = { ...REPLICA_SUPERVISOR_LIMITS, ...options };
  if (!isAbsolute(options.storeRoot)) throw new TypeError("Replica store root must be absolute.");
  if (dirname(resolve(options.storeRoot)) === resolve(options.storeRoot)) throw new TypeError("Replica store root must be a private directory.");
  for (const value of [limits.maxRunning, limits.idleMs, limits.maxViewTextBytes]) {
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

  function persist(entry: Entry, view = entry.newest) {
    clearTimeout(entry.quiet); clearTimeout(entry.ceiling);
    entry.quiet = entry.ceiling = undefined;
    if (!entry.pendingView || !view) return;
    try {
      entry.newest = options.storage.storeReplicaCurrentView(entry.lease, view);
      entry.pendingView = false;
    } catch (error) {
      if (!(error instanceof ReplicaCurrentViewRefused)) throw error;
      report(entry, error);
      entry.newest = undefined; entry.pendingView = false;
    }
  }
  function acceptView(entry: Entry, view: ReplicaCurrentView, spilled: boolean) {
    if (!principal.current(entry.lease)) return;
    if (spilled) {
      entry.pendingView = true;
      persist(entry, view);
      return;
    }
    const previous = entry.newest;
    const held = new Map(previous?.texts.map(t => [t.sha256, t.text]) ?? []);
    for (const text of view.texts) held.set(text.sha256, text.text);
    const needed = new Set(view.files.filter(f => f.contentKind === "text").map(f => f.sha256));
    view.texts = [...held].filter(([sha]) => needed.has(sha)).map(([sha256, text]) => ({sha256, text}));
    const structure = (v: ReplicaCurrentView) => JSON.stringify([
      v.files.map(f => [f.versionId, f.objectId, f.path, f.contentKind, f.lineageClaimId, f.restoreGeneration]),
      v.omitted.map(f => [f.versionId, f.objectId, f.path, f.reason])]);
    entry.newest = view;
    if (previous && JSON.stringify([previous.files, previous.omitted]) === JSON.stringify([view.files, view.omitted])) return;
    entry.pendingView = true;
    if (!previous || structure(previous) !== structure(view)) {
      persist(entry);
      return;
    }
    const flush = () => {
      try {persist(entry);} catch (error) {report(entry, error); void retire(entry).catch(e => report(entry, e));}
    };
    clearTimeout(entry.quiet); entry.quiet = setTimeout(flush, 2000); entry.quiet.unref();
    entry.ceiling ??= setTimeout(flush, 30_000); entry.ceiling.unref();
  }

  async function retire(entry: Entry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.stopping = true;
    principal.revoke(entry.lease);
    clearTimeout(entry.idle);
    clearTimeout(entry.quiet); clearTimeout(entry.ceiling);
    entry.retirement = (async () => {
      // Startup may still own the directory and child. Wait before disposing either.
      try {
        await entry.run?.catch(() => {});
        try { persist(entry); } catch (error) { report(entry,error); }
        options.storage.discardReplicaCurrentView(entry.lease);
        options.storage.releaseReplicaCurrentView(entry.lease);
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
          draining: while (entry.dirty && !entry.stopping) {
            if (!principal.current(entry.lease)) break;
            entry.dirty = false;
            const standing = options.storage.readReplicaStanding(entry.lease.workspaceId)!;
            await entry.child!.pull();
            entry.frontier = standing.logSeq;
            entry.journalFrontier = standing.journalCursor;
            if (principal.current(entry.lease)) {
              const selectors = options.storage.replicaCurrentViewSelectors(entry.lease.workspaceId);
              for (;;) {
                if (entry.stopping || !principal.current(entry.lease)) return;
                let position: ReplicaCurrentViewPosition | undefined, cursor: ReplicaCurrentViewCursor | undefined;
                const known = new Set(entry.newest?.files.filter(f => f.contentKind === "text").map(f => f.sha256) ?? []);
                const held = new Map(entry.newest?.texts.map(t => [t.sha256, t.text]) ?? []);
                let textBytes = [...held.values()].reduce((n, text) => n + Buffer.byteLength(text), 0);
                let spilled = false;
                let latest: ReplicaCurrentView | undefined;
                let moved = false;
                do {
                  const page = await entry.child!.currentView(selectors, [...known], position, cursor);
                  if (page.moved) {moved = true; break;}
                  if (!principal.current(entry.lease) || entry.stopping) return;
                  position ??= {revision:page.revision,logCursor:page.logCursor,journalCursor:page.journalCursor};
                  for (const refusal of page.refusedFiles) {
                    const key = JSON.stringify([refusal.objectId, refusal.sha256]);
                    entry.reportedOmissions ??= new Set();
                    if (!entry.reportedOmissions.has(key)) {
                      entry.reportedOmissions.add(key);
                      report(entry, new Error(`Replica current view omitted ${refusal.path} (${refusal.objectId}, ${refusal.sha256}): ${refusal.reason}`));
                    }
                  }
                  latest ??= {workspaceId: page.workspaceId, ...position, files: [], texts: [], omitted: []};
                  latest.omitted.push(...page.refusedFiles);
                  latest.files.push(...page.files);
                  latest.texts.push(...page.texts);
                  for (const text of page.texts) {
                    if (!known.has(text.sha256)) textBytes += Buffer.byteLength(text.text);
                    known.add(text.sha256);
                  }
                  if (spilled || textBytes > limits.maxViewTextBytes) {
                    if (!spilled) persist(entry);
                    const staged = spilled ? {...page, omitted: page.refusedFiles} : latest;
                    const texts = new Map(staged.texts.map(t => [t.sha256, t.text]));
                    for (const file of staged.files) {
                      if (file.contentKind === "text" && held.has(file.sha256)) texts.set(file.sha256, held.get(file.sha256)!);
                    }
                    try {
                      options.storage.stageReplicaCurrentView(entry.lease, {...staged,
                        texts: [...texts].map(([sha256, text]) => ({sha256, text}))});
                    } catch (error) {
                      if (error instanceof ReplicaCurrentViewRefused) {
                        report(entry, error);
                        options.storage.discardReplicaCurrentView(entry.lease);
                        if (entry.dirty) continue draining;
                        return;
                      }
                      throw error;
                    }
                    spilled = true;
                    latest.texts = [];
                  }
                  if (page.nextCursor && cursor && JSON.stringify(page.nextCursor)===JSON.stringify(cursor)) throw new Error("Replica current view cursor did not progress.");
                  cursor=page.nextCursor??undefined;
                } while(cursor);
                if (moved) {options.storage.discardReplicaCurrentView(entry.lease);continue;}
                acceptView(entry, latest!, spilled);
                break;
              }
            }
          }
          return;
        } catch (error) {
          if (!fresh || attempt === 1 || entry.frontier >= 0 || entry.stopping || !principal.current(entry.lease)) throw error;
          // A crash before the passive role is recorded can leave an owner-role store.
          options.storage.releaseReplicaCurrentView(entry.lease);
          principal.revoke(entry.lease);
          await entry.child?.close();
          entry.child = undefined;
          await rm(entry.storeDir!, { recursive: true, force: true });
          if (entry.stopping) throw error;
          await mkdir(entry.storeDir!, { mode: 0o700 });
          if (entry.stopping || !standingCurrent(entry.lease)) throw error;
          entry.lease = principal.issue(entry.lease.workspaceId, randomUUID());
          options.storage.bindReplicaCurrentView(entry.lease);
          entry.newest=undefined; entry.pendingView=false;
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
        else if (standing.logSeq !== entry.frontier || standing.journalCursor !== entry.journalFrontier) {
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
      options.storage.bindReplicaCurrentView(lease);
      entry = { lease, frontier: -1, journalFrontier: -1, dirty: true, stopping: false };
      entries.set(workspaceId, entry);
      unsubscribe ??= observeRelayWrites(options.storage, observeWrite);
    }
    await schedule(entry);
    if (entry.stopping || !principal.current(entry.lease)) throw new Error("Replica standing ended during activation.");
  }

  return {
    handle: principal.handle,
    activate,
    // Recipient reads apply their own selector and fences in the read transaction.
    currentReadView(workspaceId: string) {
      const entry = entries.get(workspaceId);
      const stored = options.storage.readReplicaCurrentView(workspaceId);
      const memory = entry && standingCurrent(entry.lease) ? entry.newest : undefined;
      const view = memory && (!stored || memory.logCursor >= stored.logCursor && memory.journalCursor >= stored.journalCursor) ? memory : stored;
      if (!view) return null;
      return {view, previous: stored ?? undefined};
    },
    currentView(workspaceId: string) {
      const entry = entries.get(workspaceId);
      const stored = options.storage.readReplicaCurrentView(workspaceId);
      const memory = entry && standingCurrent(entry.lease) ? entry.newest : undefined;
      const view = memory && (!stored || memory.logCursor >= stored.logCursor && memory.journalCursor >= stored.journalCursor) ? memory : stored;
      if (!view) return null;
      const selectors = options.storage.replicaCurrentViewSelectors(workspaceId);
      const files = options.storage.currentViewFilesAtFences(workspaceId, view.files, stored?.files ?? [], view.omitted)
        .filter(f => currentViewFileVisible(selectors, f));
      const omitted = view.omitted.filter(f => currentViewFileVisible(selectors, f));
      const texts = new Map(view.texts.map(t => [t.sha256, t.text]));
      const allowed = new Set(files.filter(f => f.contentKind === "text").map(f => f.sha256));
      return {view: {...view, files: structuredClone(files), omitted: structuredClone(omitted), texts: []}, readText: (sha: string) => {
        if (!allowed.has(sha) || !options.storage.readReplicaStanding(workspaceId) || entry && !standingCurrent(entry.lease)) return null;
        const currentSelectors = options.storage.replicaCurrentViewSelectors(workspaceId);
        if (!files.some(f => f.contentKind === "text" && f.sha256 === sha && currentViewFileVisible(currentSelectors, f))) return null;
        return texts.get(sha) ?? options.storage.readReplicaCurrentViewText(workspaceId, sha);
      }};
    },
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
