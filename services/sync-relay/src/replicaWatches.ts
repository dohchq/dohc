import { createHmac, randomBytes, type BinaryLike } from "node:crypto";
import { ownerLogWaitGroup, type DiscussionActivityHub } from "./discussionActivity";
import type { AuthorizedShareAction } from "./shareAuthorization";

const HOLD_TTL_MS = 35_000;

export interface ReplicaWatchesOptions {
  key?: BinaryLike;
  maxWorkspaces?: number;
  maxHoldersPerWorkspace?: number;
  maxWorkspacesPerOwner?: number;
  maxWorkspacesPerReader?: number;
}

export class ReplicaWatchCapacityError extends Error {
  constructor() {
    super("replica watches are at capacity");
    this.name = "ReplicaWatchCapacityError";
  }
}

interface WorkspaceWatch {
  ownerId: string;
  holders: Map<string, { readerKey: string; expiresAt: number }>;
  timer?: ReturnType<typeof setTimeout>;
}

// Owners can query only the workspace boolean. Nothing here is persisted.
export class ReplicaWatches {
  private readonly workspaces = new Map<string, WorkspaceWatch>();
  private readonly owners = new Map<string, number>();
  private readonly readers = new Map<string, Set<string>>();
  private readonly key: BinaryLike;
  private readonly maxWorkspaces: number;
  private readonly maxHoldersPerWorkspace: number;
  private readonly maxWorkspacesPerOwner: number;
  private readonly maxWorkspacesPerReader: number;

  constructor(
    private readonly activity: Pick<DiscussionActivityHub, "wake">,
    options: ReplicaWatchesOptions = {},
  ) {
    // Production supplies DOHC_RELAY_LINK_KEY; dev/test may use an ephemeral key.
    this.key = options.key ?? randomBytes(32);
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
    const readerKey = JSON.stringify([grant.principalKind, principal]);
    const holderKey = createHmac("sha256", this.key)
      .update(JSON.stringify(["replica-watch-holder-v1", grant.principalKind, principal, share.workspaceId]))
      .digest("base64url");
    try {
      this.hold(share.workspaceId, share.granterUserId, readerKey, holderKey);
    } catch (error) {
      if (!(error instanceof ReplicaWatchCapacityError)) throw error;
    }
  }

  private hold(workspaceId: string, ownerId: string, readerKey: string, holderKey: string): void {
    let watch = this.workspaces.get(workspaceId);
    if (watch) {
      this.expire(workspaceId, watch);
      watch = this.workspaces.get(workspaceId);
    }
    const readerWorkspaces = this.readers.get(readerKey);
    // Check account quotas before inspecting relay-wide capacity.
    if (!watch && (this.owners.get(ownerId) ?? 0) >= this.maxWorkspacesPerOwner) {
      throw new ReplicaWatchCapacityError();
    }
    if (!readerWorkspaces?.has(workspaceId) && (readerWorkspaces?.size ?? 0) >= this.maxWorkspacesPerReader) {
      throw new ReplicaWatchCapacityError();
    }
    if (!watch && this.workspaces.size >= this.maxWorkspaces) throw new ReplicaWatchCapacityError();
    if (watch && !watch.holders.has(holderKey) && watch.holders.size >= this.maxHoldersPerWorkspace) {
      throw new ReplicaWatchCapacityError();
    }
    const started = !watch;
    if (!watch) {
      watch = { ownerId, holders: new Map() };
      this.workspaces.set(workspaceId, watch);
      this.owners.set(ownerId, (this.owners.get(ownerId) ?? 0) + 1);
    }
    if (!readerWorkspaces) this.readers.set(readerKey, new Set([workspaceId]));
    else readerWorkspaces.add(workspaceId);
    watch.holders.set(holderKey, { readerKey, expiresAt: Date.now() + HOLD_TTL_MS });
    this.schedule(workspaceId, watch);
    if (started) this.activity.wake(ownerLogWaitGroup(workspaceId));
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
    for (const [key, holder] of watch.holders) {
      if (holder.expiresAt <= now) {
        watch.holders.delete(key);
        const readerWorkspaces = this.readers.get(holder.readerKey)!;
        readerWorkspaces.delete(workspaceId);
        if (readerWorkspaces.size === 0) this.readers.delete(holder.readerKey);
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
    for (const holder of watch.holders.values()) earliest = Math.min(earliest, holder.expiresAt);
    watch.timer = setTimeout(() => {
      this.expire(workspaceId, watch);
      if (watch.holders.size > 0) this.schedule(workspaceId, watch);
    }, Math.max(0, earliest - Date.now()));
    watch.timer.unref();
  }
}
