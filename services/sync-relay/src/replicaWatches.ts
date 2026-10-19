import { createHash } from "node:crypto";
import { ownerLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import type { AuthorizedShareAction } from "./shareAuthorization";
import { MAX_DISCUSSION_ACTIVITY_HOLD_MS } from "./wireLimits";

const HOLD_TTL_MS = MAX_DISCUSSION_ACTIVITY_HOLD_MS + 5_000;

export interface ReplicaWatchesOptions {
  maxWorkspaces?: number;
  maxHoldersPerWorkspace?: number;
  maxWorkspacesPerOwner?: number;
  maxWorkspacesPerReader?: number;
}

interface WorkspaceWatch {
  ownerId: string;
  holders: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
}

// Owners can query only the workspace boolean. Nothing here is persisted.
export class ReplicaWatches {
  private readonly workspaces = new Map<string, WorkspaceWatch>();
  private readonly owners = new Map<string, number>();
  private readonly readers = new Map<string, number>();
  private readonly maxWorkspaces: number;
  private readonly maxHoldersPerWorkspace: number;
  private readonly maxWorkspacesPerOwner: number;
  private readonly maxWorkspacesPerReader: number;

  constructor(
    private readonly activity: Pick<DiscussionActivityHub, "wake">,
    options: ReplicaWatchesOptions = {},
  ) {
    this.maxWorkspaces = options.maxWorkspaces ?? 1_024;
    this.maxHoldersPerWorkspace = options.maxHoldersPerWorkspace ?? 64;
    this.maxWorkspacesPerOwner = options.maxWorkspacesPerOwner ?? 32;
    this.maxWorkspacesPerReader = options.maxWorkspacesPerReader ?? 16;
    for (const cap of [this.maxWorkspaces, this.maxHoldersPerWorkspace,
      this.maxWorkspacesPerOwner, this.maxWorkspacesPerReader]) {
      if (!Number.isSafeInteger(cap) || cap < 1) throw new RangeError("invalid replica watch cap");
    }
  }

  // Call only for a recipient read, after fresh authorization on every refresh.
  // Owner devices and the replica supervisor do not call this. Revocation can
  // remain counted for up to 35 s. Capacity adds no response data or async wait.
  holdReader({ share, grant }: AuthorizedShareAction): void {
    const principal = grant.principalKind === "user" ? grant.principalUserId
      : grant.principalKind === "link" ? grant.grantId : null;
    if (principal === null || (grant.principalKind === "user" && principal === share.granterUserId)) return;
    // Stored principal IDs have no universal length bound. Keep retained keys fixed-size.
    const readerKey = createHash("sha256")
      .update(JSON.stringify([grant.principalKind, principal]))
      .digest("base64url");
    this.hold(share.workspaceId, share.granterUserId, readerKey);
  }

  private hold(workspaceId: string, ownerId: string, readerKey: string): boolean {
    let watch = this.workspaces.get(workspaceId);
    if (watch) {
      this.expire(workspaceId, watch);
      watch = this.workspaces.get(workspaceId);
    }
    const refresh = watch?.holders.has(readerKey) ?? false;
    // Check account quotas before inspecting relay-wide capacity.
    if (!watch && (this.owners.get(ownerId) ?? 0) >= this.maxWorkspacesPerOwner) {
      return false;
    }
    if (!refresh && (this.readers.get(readerKey) ?? 0) >= this.maxWorkspacesPerReader) {
      return false;
    }
    if (!watch && this.workspaces.size >= this.maxWorkspaces) return false;
    if (watch && !refresh && watch.holders.size >= this.maxHoldersPerWorkspace) {
      return false;
    }
    const started = !watch;
    if (!watch) {
      watch = { ownerId, holders: new Map() };
      this.workspaces.set(workspaceId, watch);
      this.owners.set(ownerId, (this.owners.get(ownerId) ?? 0) + 1);
    }
    if (!refresh) this.readers.set(readerKey, (this.readers.get(readerKey) ?? 0) + 1);
    watch.holders.set(readerKey, Date.now() + HOLD_TTL_MS);
    this.schedule(workspaceId, watch);
    if (started) this.activity.wake(ownerLogWaitGroup(workspaceId));
    return true;
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
    this.readers.clear();
  }

  private expire(workspaceId: string, watch: WorkspaceWatch): void {
    const now = Date.now();
    for (const [readerKey, expiresAt] of watch.holders) {
      if (expiresAt <= now) {
        watch.holders.delete(readerKey);
        const reading = this.readers.get(readerKey)! - 1;
        if (reading === 0) this.readers.delete(readerKey);
        else this.readers.set(readerKey, reading);
      }
    }
    if (watch.holders.size === 0) this.remove(workspaceId, watch);
  }

  private remove(workspaceId: string, watch: WorkspaceWatch): void {
    if (watch.timer) clearTimeout(watch.timer);
    this.workspaces.delete(workspaceId);
    const owned = this.owners.get(watch.ownerId)! - 1;
    if (owned === 0) this.owners.delete(watch.ownerId);
    else this.owners.set(watch.ownerId, owned);
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
