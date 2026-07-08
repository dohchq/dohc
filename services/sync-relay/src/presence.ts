// MU-C1 — the EPHEMERAL awareness transport (presence / typing / co-viewing).
//
// This is the in-memory pub/sub the design calls "the ephemeral awareness
// channel over the relay transport". It is DELIBERATELY separate from the
// durable op log (storage.ts / sync_relay_log): presence, typing, and
// "viewing this channel/doc" are last-writer, self-expiring, dropped on
// disconnect, and MUST NEVER be journaled (0P Risk 2 / the G2-C awareness
// rule). Nothing in this module touches `storage` — it holds no sqlite handle,
// writes no row, and is lost entirely on relay restart. That is the contract.
//
// It rides the SAME relay process a self-hoster already runs (no new service),
// so presence is fully self-hostable. If a proxy blocks the presence routes,
// chat/co-editing still work fully — only presence degrades, exactly the
// G2-C/design contract.
//
// Transport shape: long-poll, not a websocket. The relay's node adapter
// buffers each request/response, so a streaming SSE/ws body cannot flow
// through it; a long-poll GET (hold until a change or a bounded timeout, then
// return a finite snapshot + version cursor) fits that adapter and needs no
// new server primitive. A publisher heartbeats faster than the entry TTL to
// stay "present"; a peer polls with the last version and re-parks.
//
// Identity is NEVER trusted from the client. The relay stamps each entry's
// `userId` from the authenticated Better Auth actor (server-derived, the same
// posture as MU-C0 authorship). The client's `state` blob is opaque display
// data (display name, "viewing" | "typing", cursor); attribution keys on the
// relay-stamped `userId`, so presence cannot impersonate another user.
//
// RESOURCE SAFETY (the load-bearing part): everything in the hub is bounded
// AND time-expired. Expiry is TIME-DRIVEN — a sweep timer removes entries past
// their TTL and reclaims empty scopes even if nothing ever touches that scope
// again, so a client that sprays unique topics and disconnects cannot grow
// memory forever. On top of the TTL there are hard caps: global and
// per-workspace scope/entry caps bound publishes, and global / per-scope /
// per-actor caps bound parked long-poll waiters. Past a cap the hub refuses
// (PresenceCapacityError -> 429); it never grows unboundedly.

export interface PresenceEntry {
  // Server-derived: the authenticated actor's user id. Never client-supplied.
  userId: string;
  // Client-supplied per-connection id (device/tab) so one user with two tabs
  // is two entries, and a stale tab's entry expires independently.
  clientId: string;
  // Opaque awareness payload (e.g. { displayName, state: "viewing"|"typing" }
  // or an encoded Yjs awareness update). The relay never interprets it.
  state: unknown;
  updatedAtMs: number;
}

export interface PresenceSnapshot {
  // Monotonic per-scope version. A poller passes it back as `since`; the relay
  // returns immediately when the scope has advanced past it, else parks.
  version: number;
  peers: PresenceEntry[];
}

export interface PresenceWaitOptions {
  holdMs: number;
  nowMs: number;
  signal?: AbortSignal;
  // Server-derived actor id, counted against the per-actor parked-waiter cap
  // so one authenticated user cannot exhaust the relay-wide waiter budget.
  actorId?: string;
}

export interface PresenceHubOptions {
  // How long an entry survives without a heartbeat. A vanished client (crash,
  // closed lid) is dropped after this window even if it never sent `leave`.
  entryTtlMs?: number;
  // Hard cap on distinct entries in one scope — bounds memory against a
  // misbehaving client spraying clientIds. Updates to existing entries are
  // always allowed; only NEW distinct entries past the cap are refused.
  maxEntriesPerScope?: number;
  // Global caps across ALL scopes: total scope count and total entry count.
  maxScopes?: number;
  maxTotalEntries?: number;
  // Per-workspace (scope group) caps, so one workspace spraying topics cannot
  // starve every other tenant before the global caps bite.
  maxScopesPerGroup?: number;
  maxEntriesPerGroup?: number;
  // Caps on PARKED long-poll waiters: relay-wide, per scope, and per actor.
  maxTotalWaiters?: number;
  maxWaitersPerScope?: number;
  maxWaitersPerActor?: number;
  // How often the time-driven sweeper expires stale entries. Defaults to the
  // TTL clamped into [1s, 10s] so an abandoned entry outlives its TTL by at
  // most one sweep interval.
  sweepIntervalMs?: number;
  nowMs?: () => number;
  // Maps a scope key to its workspace group for the per-group caps. Defaults
  // to the `presenceScopeKey` layout below.
  groupOf?: (scopeKey: string) => string;
}

export const DEFAULT_PRESENCE_ENTRY_TTL_MS = 30_000;
export const DEFAULT_PRESENCE_MAX_ENTRIES_PER_SCOPE = 256;
export const DEFAULT_PRESENCE_MAX_SCOPES = 16_384;
export const DEFAULT_PRESENCE_MAX_TOTAL_ENTRIES = 65_536;
export const DEFAULT_PRESENCE_MAX_SCOPES_PER_GROUP = 2_048;
export const DEFAULT_PRESENCE_MAX_ENTRIES_PER_GROUP = 8_192;
export const DEFAULT_PRESENCE_MAX_TOTAL_WAITERS = 4_096;
export const DEFAULT_PRESENCE_MAX_WAITERS_PER_SCOPE = 512;
export const DEFAULT_PRESENCE_MAX_WAITERS_PER_ACTOR = 64;

// Scope key shared by an owner (workspace route) and every share recipient
// (share route resolves the granter's workspaceId), so co-viewers of the SAME
// (workspace, topic) fan into one scope regardless of how they were
// authorized. NUL separators keep it unambiguous — the parse boundary
// (server.ts parseString) rejects control characters in every component, so
// no crafted workspaceId/topic can collide with another workspace's scope.
export function presenceScopeKey(workspaceId: string, topic: string): string {
  return `ws\u0000${workspaceId}\u0000${topic}`;
}

// The workspace component of a presenceScopeKey — the per-group cap bucket.
function presenceScopeGroup(scopeKey: string): string {
  const parts = scopeKey.split("\u0000");
  return parts.length >= 2 ? parts[1]! : scopeKey;
}

export class PresenceCapacityError extends Error {
  constructor(message = "presence scope is at capacity") {
    super(message);
    this.name = "PresenceCapacityError";
  }
}

interface Scope {
  group: string;
  entries: Map<string, PresenceEntry>;
  version: number;
  waiters: Set<(snapshot: PresenceSnapshot) => void>;
}

interface GroupStats {
  scopes: number;
  entries: number;
}

function entryKey(userId: string, clientId: string): string {
  // NUL separator: the relay's parse boundary refuses control characters in
  // clientId (userId is server-derived), so the composite key is unambiguous.
  return `${userId}\u0000${clientId}`;
}

export class PresenceHub {
  private readonly scopes = new Map<string, Scope>();
  private readonly groups = new Map<string, GroupStats>();
  private readonly actorWaiters = new Map<string, number>();
  private totalEntries = 0;
  private totalWaiters = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly entryTtlMs: number;
  private readonly maxEntriesPerScope: number;
  private readonly maxScopes: number;
  private readonly maxTotalEntries: number;
  private readonly maxScopesPerGroup: number;
  private readonly maxEntriesPerGroup: number;
  private readonly maxTotalWaiters: number;
  private readonly maxWaitersPerScope: number;
  private readonly maxWaitersPerActor: number;
  private readonly sweepIntervalMs: number;
  private readonly now: () => number;
  private readonly groupOf: (scopeKey: string) => string;

  constructor(options: PresenceHubOptions = {}) {
    this.entryTtlMs = options.entryTtlMs ?? DEFAULT_PRESENCE_ENTRY_TTL_MS;
    this.maxEntriesPerScope =
      options.maxEntriesPerScope ?? DEFAULT_PRESENCE_MAX_ENTRIES_PER_SCOPE;
    this.maxScopes = options.maxScopes ?? DEFAULT_PRESENCE_MAX_SCOPES;
    this.maxTotalEntries = options.maxTotalEntries ?? DEFAULT_PRESENCE_MAX_TOTAL_ENTRIES;
    this.maxScopesPerGroup =
      options.maxScopesPerGroup ?? DEFAULT_PRESENCE_MAX_SCOPES_PER_GROUP;
    this.maxEntriesPerGroup =
      options.maxEntriesPerGroup ?? DEFAULT_PRESENCE_MAX_ENTRIES_PER_GROUP;
    this.maxTotalWaiters = options.maxTotalWaiters ?? DEFAULT_PRESENCE_MAX_TOTAL_WAITERS;
    this.maxWaitersPerScope =
      options.maxWaitersPerScope ?? DEFAULT_PRESENCE_MAX_WAITERS_PER_SCOPE;
    this.maxWaitersPerActor =
      options.maxWaitersPerActor ?? DEFAULT_PRESENCE_MAX_WAITERS_PER_ACTOR;
    this.sweepIntervalMs =
      options.sweepIntervalMs ?? Math.max(1_000, Math.min(this.entryTtlMs, 10_000));
    this.now = options.nowMs ?? (() => Date.now());
    this.groupOf = options.groupOf ?? presenceScopeGroup;
  }

  // Publish (or refresh) this actor's presence in a scope. Returns the fresh
  // snapshot so the publisher immediately sees its peers. `userId` is the
  // server-derived actor id; the caller must NEVER pass a client-claimed id.
  publish(
    scopeKey: string,
    userId: string,
    clientId: string,
    state: unknown,
    nowMs: number,
  ): PresenceSnapshot {
    const existing = this.scopes.get(scopeKey);
    if (existing) this.prune(existing, nowMs);
    const key = entryKey(userId, clientId);
    // Enforce every entry cap BEFORE creating anything, so a refused publish
    // allocates nothing. Updates to existing entries are always allowed.
    if (!existing?.entries.has(key)) {
      if ((existing?.entries.size ?? 0) >= this.maxEntriesPerScope) {
        throw new PresenceCapacityError();
      }
      if (this.totalEntries >= this.maxTotalEntries) {
        throw new PresenceCapacityError("relay presence is at capacity");
      }
      const group = this.groups.get(this.groupOf(scopeKey));
      if ((group?.entries ?? 0) >= this.maxEntriesPerGroup) {
        throw new PresenceCapacityError("workspace presence is at capacity");
      }
    }
    const scope = this.scopeFor(scopeKey); // may throw on the scope-count caps
    this.setEntry(scope, key, { userId, clientId, state, updatedAtMs: nowMs });
    this.bump(scope);
    return this.snapshotOf(scope);
  }

  // Explicit disconnect: remove this actor's entry NOW (not on TTL). Sent by
  // the client on unmount / blur / page-hide so peers see the departure
  // promptly rather than waiting out the TTL.
  leave(scopeKey: string, userId: string, clientId: string, nowMs: number): PresenceSnapshot {
    const scope = this.scopes.get(scopeKey);
    if (!scope) return { version: 0, peers: [] };
    // Bump on EITHER removal (same pattern as snapshot()/wait()): a retried
    // leave whose own entry is already gone can still prune a DIFFERENT stale
    // peer here, and that departure must wake parked waiters too.
    const pruned = this.prune(scope, nowMs);
    const deleted = this.deleteEntry(scope, entryKey(userId, clientId));
    if (pruned || deleted) this.bump(scope);
    const snapshot = this.snapshotOf(scope);
    this.gc(scopeKey, scope);
    return snapshot;
  }

  snapshot(scopeKey: string, nowMs: number): PresenceSnapshot {
    const scope = this.scopes.get(scopeKey);
    if (!scope) return { version: 0, peers: [] };
    if (this.prune(scope, nowMs)) this.bump(scope);
    const snapshot = this.snapshotOf(scope);
    this.gc(scopeKey, scope);
    return snapshot;
  }

  // Long-poll: resolve immediately if the scope has advanced past `since`,
  // otherwise park until the next change or `holdMs`, then return the current
  // snapshot (the poller re-parks). Aborting the request (client disconnect)
  // resolves early AND releases the parked slot. Parked waiters are capped —
  // beyond the caps this throws PresenceCapacityError instead of parking.
  wait(scopeKey: string, since: number, options: PresenceWaitOptions): Promise<PresenceSnapshot> {
    const scope = this.scopeFor(scopeKey); // may throw on the scope-count caps
    if (this.prune(scope, options.nowMs)) this.bump(scope);
    if (scope.version !== since) {
      const snapshot = this.snapshotOf(scope);
      this.gc(scopeKey, scope);
      return Promise.resolve(snapshot);
    }
    const actorId = options.actorId;
    if (
      this.totalWaiters >= this.maxTotalWaiters ||
      scope.waiters.size >= this.maxWaitersPerScope ||
      (actorId !== undefined && (this.actorWaiters.get(actorId) ?? 0) >= this.maxWaitersPerActor)
    ) {
      this.gc(scopeKey, scope);
      throw new PresenceCapacityError("too many parked presence polls");
    }
    return new Promise<PresenceSnapshot>((resolve) => {
      let settled = false;
      this.totalWaiters += 1;
      if (actorId !== undefined) {
        this.actorWaiters.set(actorId, (this.actorWaiters.get(actorId) ?? 0) + 1);
      }
      const finish = (snapshot: PresenceSnapshot): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        scope.waiters.delete(waiter);
        this.totalWaiters -= 1;
        if (actorId !== undefined) {
          const count = (this.actorWaiters.get(actorId) ?? 1) - 1;
          if (count <= 0) this.actorWaiters.delete(actorId);
          else this.actorWaiters.set(actorId, count);
        }
        options.signal?.removeEventListener("abort", onAbort);
        resolve(snapshot);
        this.gc(scopeKey, scope);
      };
      const waiter = (snapshot: PresenceSnapshot): void => finish(snapshot);
      const onAbort = (): void => finish(this.snapshotOf(scope));
      const timer = setTimeout(() => finish(this.snapshotOf(scope)), options.holdMs);
      // Never keep the process alive purely to hold a presence poll open.
      if (typeof timer === "object" && timer && "unref" in timer) {
        (timer as { unref: () => void }).unref();
      }
      scope.waiters.add(waiter);
      if (options.signal) {
        if (options.signal.aborted) {
          finish(this.snapshotOf(scope));
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }

  // In-memory footprint, for tests/no-leak assertions. There is no durable
  // counterpart anywhere — this IS the entire presence state.
  stats(): { scopes: number; entries: number; waiters: number } {
    return { scopes: this.scopes.size, entries: this.totalEntries, waiters: this.totalWaiters };
  }

  // Stop the sweep timer (tests / orderly shutdown). Scopes remain readable;
  // a later publish restarts the sweeper.
  dispose(): void {
    this.stopSweeper();
  }

  private scopeFor(scopeKey: string): Scope {
    let scope = this.scopes.get(scopeKey);
    if (!scope) {
      const group = this.groupOf(scopeKey);
      if (this.scopes.size >= this.maxScopes) {
        throw new PresenceCapacityError("relay presence is at capacity");
      }
      const groupStats = this.groups.get(group);
      if ((groupStats?.scopes ?? 0) >= this.maxScopesPerGroup) {
        throw new PresenceCapacityError("workspace presence is at capacity");
      }
      scope = { group, entries: new Map(), version: 0, waiters: new Set() };
      this.scopes.set(scopeKey, scope);
      this.groupStatsFor(group).scopes += 1;
      this.ensureSweeper();
    }
    return scope;
  }

  private groupStatsFor(group: string): GroupStats {
    let stats = this.groups.get(group);
    if (!stats) {
      stats = { scopes: 0, entries: 0 };
      this.groups.set(group, stats);
    }
    return stats;
  }

  private setEntry(scope: Scope, key: string, entry: PresenceEntry): void {
    if (!scope.entries.has(key)) {
      this.totalEntries += 1;
      this.groupStatsFor(scope.group).entries += 1;
    }
    scope.entries.set(key, entry);
  }

  private deleteEntry(scope: Scope, key: string): boolean {
    if (!scope.entries.delete(key)) return false;
    this.totalEntries -= 1;
    const stats = this.groups.get(scope.group);
    if (stats) stats.entries -= 1;
    return true;
  }

  // Drop expired entries. Returns true if any were removed so the caller can
  // bump the version (peers learn of a TTL departure on their next poll).
  private prune(scope: Scope, nowMs: number): boolean {
    let removed = false;
    for (const [key, entry] of scope.entries) {
      if (nowMs - entry.updatedAtMs >= this.entryTtlMs) {
        this.deleteEntry(scope, key);
        removed = true;
      }
    }
    return removed;
  }

  private bump(scope: Scope): void {
    scope.version += 1;
    if (scope.waiters.size === 0) return;
    const snapshot = this.snapshotOf(scope);
    const waiters = [...scope.waiters];
    scope.waiters.clear();
    for (const waiter of waiters) waiter(snapshot);
  }

  private snapshotOf(scope: Scope): PresenceSnapshot {
    return {
      version: scope.version,
      peers: [...scope.entries.values()].map((entry) => ({ ...entry })),
    };
  }

  // Reclaim an empty, unwatched scope so a workspace that opens and closes
  // thousands of docs never accumulates dead scope objects.
  private gc(scopeKey: string, scope: Scope): void {
    if (scope.entries.size !== 0 || scope.waiters.size !== 0) return;
    if (this.scopes.get(scopeKey) !== scope) return;
    this.scopes.delete(scopeKey);
    const stats = this.groups.get(scope.group);
    if (stats) {
      stats.scopes -= 1;
      if (stats.scopes <= 0 && stats.entries <= 0) this.groups.delete(scope.group);
    }
    if (this.scopes.size === 0) this.stopSweeper();
  }

  // TIME-DRIVEN expiry: runs on a timer so entries past their TTL are removed
  // and empty scopes reclaimed even when nothing ever touches the scope again
  // (the lazy prune in publish/snapshot/wait only helps scopes still in use).
  private sweep(): void {
    const nowMs = this.now();
    for (const [scopeKey, scope] of [...this.scopes]) {
      if (this.prune(scope, nowMs)) this.bump(scope);
      this.gc(scopeKey, scope);
    }
    if (this.scopes.size === 0) this.stopSweeper();
  }

  private ensureSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    // The sweeper must never keep the process alive on its own.
    if (typeof this.sweepTimer === "object" && this.sweepTimer && "unref" in this.sweepTimer) {
      (this.sweepTimer as unknown as { unref: () => void }).unref();
    }
  }

  private stopSweeper(): void {
    if (!this.sweepTimer) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
