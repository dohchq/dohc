import { ownerLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";

export interface ReplicaWatchesOptions {
  maxWorkspaces?: number;
  maxHoldersPerWorkspace?: number;
}

export class ReplicaWatchCapacityError extends Error {
  constructor() {
    super("replica watches are at capacity");
    this.name = "ReplicaWatchCapacityError";
  }
}

interface WorkspaceWatch {
  holders: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
}

// Readers supply an opaque key per held request after checking access.
// Owners can query only the workspace boolean. Nothing here is persisted.
export class ReplicaWatches {
  private readonly workspaces = new Map<string, WorkspaceWatch>();
  private readonly maxWorkspaces: number;
  private readonly maxHoldersPerWorkspace: number;

  constructor(
    private readonly activity: Pick<DiscussionActivityHub, "wake">,
    options: ReplicaWatchesOptions = {},
  ) {
    this.maxWorkspaces = options.maxWorkspaces ?? 1_024;
    this.maxHoldersPerWorkspace = options.maxHoldersPerWorkspace ?? 64;
    for (const cap of [this.maxWorkspaces, this.maxHoldersPerWorkspace]) {
      if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError("invalid replica watch cap");
    }
  }

  hold(workspaceId: string, holderKey: string, ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_DISCUSSION_ACTIVITY_HOLD_MS + 5_000) {
      throw new RangeError("invalid replica watch TTL");
    }
    let watch = this.workspaces.get(workspaceId);
    if (watch) {
      this.expire(workspaceId, watch);
      watch = this.workspaces.get(workspaceId);
    }
    if (!watch && this.workspaces.size >= this.maxWorkspaces) throw new ReplicaWatchCapacityError();
    if (watch && !watch.holders.has(holderKey) && watch.holders.size >= this.maxHoldersPerWorkspace) {
      throw new ReplicaWatchCapacityError();
    }
    const started = !watch;
    if (!watch) {
      watch = { holders: new Map() };
      this.workspaces.set(workspaceId, watch);
    }
    watch.holders.set(holderKey, Date.now() + ttlMs);
    this.schedule(workspaceId, watch);
    if (started) this.activity.wake(ownerLogWaitGroup(workspaceId));
  }

  release(workspaceId: string, holderKey: string): void {
    const watch = this.workspaces.get(workspaceId);
    if (!watch) return;
    watch.holders.delete(holderKey);
    this.expire(workspaceId, watch);
    if (watch.holders.size > 0) this.schedule(workspaceId, watch);
  }

  watched(workspaceId: string): boolean {
    return this.workspaces.has(workspaceId);
  }

  stats(): { workspaces: number; holders: number } {
    let holders = 0;
    for (const watch of this.workspaces.values()) holders += watch.holders.size;
    return { workspaces: this.workspaces.size, holders };
  }

  dispose(): void {
    for (const [workspaceId, watch] of this.workspaces) {
      watch.holders.clear();
      this.remove(workspaceId, watch);
    }
  }

  private expire(workspaceId: string, watch: WorkspaceWatch): void {
    const now = Date.now();
    for (const [key, expiresAt] of watch.holders) {
      if (expiresAt <= now) watch.holders.delete(key);
    }
    if (watch.holders.size === 0) this.remove(workspaceId, watch);
  }

  private remove(workspaceId: string, watch: WorkspaceWatch): void {
    if (watch.timer) clearTimeout(watch.timer);
    this.workspaces.delete(workspaceId);
    this.activity.wake(ownerLogWaitGroup(workspaceId));
  }

  // One unreferenced timer per watched workspace; none while empty.
  // The next holder's deadline expires even if no request arrives again.
  private schedule(workspaceId: string, watch: WorkspaceWatch): void {
    if (watch.timer) clearTimeout(watch.timer);
    let earliest = Infinity;
    for (const expiresAt of watch.holders.values()) earliest = Math.min(earliest, expiresAt);
    watch.timer = setTimeout(() => {
      this.expire(workspaceId, watch);
      if (watch.holders.size > 0) this.schedule(workspaceId, watch);
    }, Math.max(0, earliest - Date.now()));
    watch.timer.unref();
  }
}
