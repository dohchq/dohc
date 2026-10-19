import {currentViewFileVisible, ReplicaCurrentViewRefused} from "./storage/replicaCurrentViews";
import {historyObjectKey, sameHistoryState, historyStructuralReason, type ReplicaHistoryObservation} from "./storage/replicaHistoryPins";
import type {ReplicaCurrentView, ReplicaCurrentViewPage, ReplicaCurrentViewPosition, ReplicaCurrentViewCursor, ReplicaCurrentViewSelector} from "@dohc/workspace-engine-client/daemon";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SyncRelayStorage } from "./storage";
import { observeRelayWrites } from "./relayWriteChanges";
import { createReplicaReadPrincipal, type ReplicaReadLease } from "./replicaReadPrincipal";

export const REPLICA_SUPERVISOR_LIMITS = Object.freeze({ maxRunning: 4, idleMs: 5 * 60_000, maxViewTextBytes: 64*1024*1024,
  maxStoreBytes: 512*1024*1024, minFreeBytes: 1024*1024*1024, lifetimeMs: 15*60_000, diskCheckMs: 1000 });
export class ReplicaBudgetError extends Error {}
export interface ReplicaChild {
  readonly pid?: number;
  readonly exited?: Promise<void | Error>;
  pull(): Promise<void>;
  currentView(selectors: ReplicaCurrentViewSelector[], knownTextShas: string[], position?: ReplicaCurrentViewPosition, cursor?: ReplicaCurrentViewCursor): Promise<ReplicaCurrentViewPage>;
  close(): Promise<void>;
}
export interface ReplicaChildInput {
  readonly storeDir: string;
  readonly lease: ReplicaReadLease;
  readonly relayHandler: (request: Request) => Promise<Response>;
}
export interface ReplicaSupervisorOptions {
  readonly storage: SyncRelayStorage;
  readonly storeRoot: string;
  readonly startChild: (input: ReplicaChildInput) => Promise<ReplicaChild>;
  readonly maxRunning?: number;
  readonly idleMs?: number;
  readonly maxViewTextBytes?: number;
  readonly maxStoreBytes?: number;
  readonly minFreeBytes?: number;
  readonly lifetimeMs?: number;
  readonly diskCheckMs?: number;
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
  history?: ReturnType<typeof setTimeout>;
  historyObservations?: Map<string,ReplicaHistoryObservation>;
  lifetime?: ReturnType<typeof setTimeout>;
  disk?: ReturnType<typeof setTimeout>;
  diskCheck?: Promise<void>;
  closing?: Promise<void>;
}

/** Explicit construction only. Production startup must wait for PR 6's readers. */
export function createReplicaSupervisor(options: ReplicaSupervisorOptions) {
  const limits = { ...REPLICA_SUPERVISOR_LIMITS, ...options };
  if (!isAbsolute(options.storeRoot)) throw new TypeError("Replica store root must be absolute.");
  if (dirname(resolve(options.storeRoot)) === resolve(options.storeRoot)) throw new TypeError("Replica store root must be a private directory.");
  for (const value of [limits.maxRunning, limits.idleMs, limits.maxViewTextBytes, limits.maxStoreBytes,
    limits.minFreeBytes, limits.lifetimeMs, limits.diskCheckMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Invalid replica budget.");
  }
  const principal = createReplicaReadPrincipal(options.storage);
  const entries = new Map<string, Entry>();
  // Leases and stores belong to this process. Finish the crash sweep before activation.
  // Only this supervisor's replica-* stores are removed; anything else under the root stays.
  const ready = mkdir(options.storeRoot, { recursive: true, mode: 0o700 })
    .then(async () => {
      if (process.platform === "win32") return;
      const root = await lstat(options.storeRoot);
      if (root.isSymbolicLink()) throw new Error("Replica store root must not be a symlink.");
      if (!root.isDirectory() || root.uid !== process.getuid!()) throw new Error("Replica store root must be a directory owned by the process user.");
      if (root.mode & 0o022) throw new Error("Replica store root must not be writable by group or others.");
      const limit = process.platform === "darwin" ? 104 : 108;
      const bytes = Buffer.byteLength(join(await realpath(options.storeRoot), "replica-XXXXXX", "relay.sock"));
      if (bytes >= limit) throw new Error(`Replica socket path requires ${bytes + 1} bytes; this host permits ${limit}. Use a shorter store root.`);
    })
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
  const standingCurrent = (lease: ReplicaReadLease, withGrants = true) => {
    const standing = options.storage.readReplicaStanding(lease.workspaceId, withGrants ? lease.shareGrantBindings : undefined);
    return standing && standing.ownerUserId === lease.ownerUserId &&
      standing.replicationEpoch === lease.replicationEpoch && standing.streamIdentity === lease.streamIdentity ? standing : null;
  };
  function stopObserving() {
    unsubscribe?.(); unsubscribe = undefined;
    if (notification) clearTimeout(notification);
    notification = undefined;
    finishNotification();
  }

  function armHistory(entry: Entry) {
    clearTimeout(entry.history); entry.history=undefined;
    const due = options.storage.nextReplicaHistoryPinAt(entry.lease.workspaceId);
    if (due !== null && !entry.stopping) {
      entry.history=setTimeout(()=>{void flush(entry,true);
      },Math.max(1,due-Date.now())); entry.history.unref();
    }
  }
  function persist(entry: Entry, view = entry.newest, beforeStructuralChange = false, previous?: ReplicaCurrentView): boolean {
    clearTimeout(entry.quiet); clearTimeout(entry.ceiling);
    entry.quiet = entry.ceiling = undefined;
    if (!entry.pendingView || !view) return false;
    try {
      const observations=[...(entry.historyObservations?.values() ?? [])].map(o=>beforeStructuralChange ? {...o,beforeStructuralChange:true} : o);
      entry.newest = previous ? options.storage.advanceReplicaCurrentView(entry.lease,view,previous)
        : options.storage.storeReplicaCurrentView(entry.lease, view,observations);
      entry.pendingView = false;
      entry.historyObservations?.clear();
      armHistory(entry);
      return true;
    } catch (error) {
      entry.newest = undefined; entry.pendingView = false;
      if (!(error instanceof ReplicaCurrentViewRefused)) throw error;
      report(entry, error);
      return false;
    }
  }
  async function flush(entry: Entry, sampleHistory = false) {
    clearTimeout(entry.quiet); clearTimeout(entry.ceiling);
    entry.quiet = entry.ceiling = undefined;
    try {
      const selectors = options.storage.replicaCurrentViewSelectors(entry.lease.workspaceId);
      const pending = entry.newest;
      // Restore can fence a pending view while the next journal page is in flight.
      if (pending && [...pending.files, ...pending.omitted].some(file => !currentViewFileVisible(selectors, file))) {
        await schedule(entry).catch(() => {});
      }
      if (!entry.stopping) {
        const persisted=persist(entry);
        if (sampleHistory) {
          if (!persisted) options.storage.sampleReplicaHistory(entry.lease);
          armHistory(entry);
        }
      }
    } catch (error) {report(entry, error); void retire(entry).catch(e => report(entry, e));}
  }
  function acceptView(entry: Entry, view: ReplicaCurrentView, spilled: boolean) {
    if (!principal.current(entry.lease)) return;
    const previous = entry.newest ?? options.storage.readReplicaCurrentView(entry.lease.workspaceId) ?? undefined;
    const next = new Map(view.files.map(f=>[historyObjectKey(f),f]));
    const omitted = new Set(view.omitted.map(historyObjectKey));
    if (entry.pendingView && previous?.files.some(f=>!omitted.has(historyObjectKey(f)) && historyStructuralReason(f,next.get(historyObjectKey(f))))) {
      const selectors=options.storage.replicaCurrentViewSelectors(entry.lease.workspaceId);
      const files=previous.files.filter(file=>currentViewFileVisible(selectors,file)), shas=new Set(files.map(file=>file.sha256));
      persist(entry,{...previous,files,texts:previous.texts.filter(text=>shas.has(text.sha256)),
        omitted:previous.omitted.filter(file=>currentViewFileVisible(selectors,file))},true);
    }
    entry.historyObservations ??= new Map();
    const prior = new Map(previous?.files.map(f=>[historyObjectKey(f),f]) ?? []), now=Date.now();
    let changed=!previous;
    let structural=!previous;
    for (const key of new Set([...prior.keys(),...next.keys()])) {
      if (omitted.has(key)) continue;
      const old=prior.get(key), file=next.get(key);
      if (old && file && sameHistoryState(old,file)) continue;
      changed=true;
      if (!old || !file || historyStructuralReason(old,file) || old.contentKind !== file.contentKind) structural=true;
      const identity=file ?? old!;
      entry.historyObservations.set(key,{versionId:identity.versionId,objectId:identity.objectId,
        firstChangedAtMs:entry.historyObservations.get(key)?.firstChangedAtMs ?? now,changedAtMs:now});
    }
    const priorOmitted=new Map(previous?.omitted.map(f=>[historyObjectKey(f),f]) ?? []);
    if (view.omitted.length !== priorOmitted.size) changed=structural=true;
    for (const file of view.omitted) {
      const old=priorOmitted.get(historyObjectKey(file));
      if (!old || old.path !== file.path || old.reason !== file.reason) changed=structural=true;
      else if (old.sha256 !== file.sha256) changed=true;
    }
    if (previous && JSON.stringify(previous.omitted)!==JSON.stringify(view.omitted)) changed=true;
    const fresh = !entry.newest;
    if (spilled) {
      entry.pendingView = true;
      persist(entry, view);
      return;
    }
    const held = new Map(previous?.texts.map(t => [t.sha256, t.text]) ?? []);
    for (const text of view.texts) held.set(text.sha256, text.text);
    const needed = new Set(view.files.filter(f => f.contentKind === "text").map(f => f.sha256));
    view.texts = [...held].filter(([sha]) => needed.has(sha)).map(([sha256, text]) => ({sha256, text}));
    entry.newest = view;
    if (!changed && !entry.pendingView && previous && (previous.revision !== view.revision || previous.logCursor !== view.logCursor || previous.journalCursor !== view.journalCursor)) {
      entry.pendingView=true;persist(entry,view,false,previous);return;
    }
    if (!changed) {if (fresh) armHistory(entry); return;}
    entry.pendingView = true;
    if (fresh || structural) {
      persist(entry);
      return;
    }
    clearTimeout(entry.quiet); entry.quiet = setTimeout(()=>{void flush(entry);}, 2000); entry.quiet.unref();
    entry.ceiling ??= setTimeout(()=>{void flush(entry);}, 30_000); entry.ceiling.unref();
  }

  async function retire(entry: Entry): Promise<void> {
    if (entry.retirement) return entry.retirement;
    entry.stopping = true;
    principal.revoke(entry.lease);
    clearTimeout(entry.idle);
    clearTimeout(entry.lifetime); clearTimeout(entry.disk);
    clearTimeout(entry.quiet); clearTimeout(entry.ceiling);
    clearTimeout(entry.history);
    entry.retirement = (async () => {
      // Startup may still own the directory and child. Wait before disposing either.
      try {
        await entry.run?.catch(() => {});
        await entry.diskCheck?.catch(() => {});
        try { if (standingCurrent(entry.lease,false) && !persist(entry)) options.storage.sampleReplicaHistory(entry.lease); } catch (error) { report(entry,error); }
        options.storage.discardReplicaCurrentView(entry.lease);
        options.storage.releaseReplicaCurrentView(entry.lease);
        try { await (entry.closing ?? entry.child?.close()); } catch (error) { report(entry, error); }
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

  function exhaust(entry: Entry, error: unknown) {
    if (entry.stopping) return;
    if (error !== undefined) report(entry, error);
    // Close before waiting for an in-flight pull, which can otherwise wait on the child forever.
    entry.closing ??= entry.child?.close();
    void entry.closing?.catch(failure => report(entry, failure));
    void retire(entry).catch(failure => report(entry, failure));
  }
  async function checkDisk(entry: Entry) {
    const free = await statfs(options.storeRoot);
    if (free.bavail * free.bsize < limits.minFreeBytes) throw new ReplicaBudgetError("Replica storage is low on free space. Free space on the replicas volume before retrying.");
    let bytes = 0;
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path).catch(error => {if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error;});
      if (!info) return;
      bytes += Math.max(info.size, (info.blocks ?? 0) * 512);
      if (bytes > limits.maxStoreBytes) throw new ReplicaBudgetError("Replica store exceeded its disk budget.");
      if (info.isDirectory() && !info.isSymbolicLink()) {
        for (const item of await readdir(path).catch(error => {if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error;})) await visit(join(path, item));
      }
    };
    await visit(entry.storeDir!);
  }
  function monitorDisk(entry: Entry) {
    entry.disk = setTimeout(() => {
      if (entry.stopping) return;
      entry.diskCheck = checkDisk(entry).then(() => {if (!entry.stopping) monitorDisk(entry);}, error => exhaust(entry, error));
    }, limits.diskCheckMs);
    entry.disk.unref();
  }

  function schedule(entry: Entry): Promise<void> {
    clearTimeout(entry.idle);
    entry.dirty = true;
    if (entry.run) return entry.run;
    entry.run = (async () => {
      const fresh = !entry.child;
      if (fresh) {
        await mkdir(options.storeRoot, { recursive: true, mode: 0o700 });
        const free = await statfs(options.storeRoot);
        if (free.bavail * free.bsize < limits.minFreeBytes) throw new ReplicaBudgetError("Replica storage is low on free space. Free space on the replicas volume before retrying.");
        entry.storeDir = await mkdtemp(join(options.storeRoot, "replica-"));
        entry.lifetime = setTimeout(() => exhaust(entry, undefined), limits.lifetimeMs);
        entry.lifetime.unref();
        monitorDisk(entry);
      }
      for (let attempt = 0; ; attempt++) {
        try {
          if (!entry.child && !entry.stopping && principal.current(entry.lease)) {
            entry.child = await options.startChild({ storeDir: entry.storeDir!, lease: entry.lease, relayHandler: principal.handle });
            if (entry.stopping) {await (entry.closing ??= entry.child.close()); return;}
            const child = entry.child;
            void child.exited?.then(error => {
              // A first-pull crash belongs to the one-time fresh-store rebuild below.
              if (entry.child === child && !entry.stopping && entry.frontier >= 0) {
                report(entry, error ?? new Error("Replica child exited."));
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
            await checkDisk(entry);
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
          if (error instanceof ReplicaBudgetError || !fresh || attempt === 1 || entry.frontier >= 0 || entry.stopping || !principal.current(entry.lease)) throw error;
          // A crash before the passive role is recorded can leave an owner-role store.
          options.storage.releaseReplicaCurrentView(entry.lease);
          principal.revoke(entry.lease);
          await entry.child?.close();
          clearTimeout(entry.disk);
          await entry.diskCheck;
          entry.child = undefined;
          await rm(entry.storeDir!, { recursive: true, force: true });
          if (entry.stopping) throw error;
          await mkdir(entry.storeDir!, { mode: 0o700 });
          monitorDisk(entry);
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
      if (!entry.stopping) report(entry, error);
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
