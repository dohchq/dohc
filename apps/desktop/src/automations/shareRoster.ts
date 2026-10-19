import type { AccessRefreshResult } from "@dohc/workspace-contracts/access";
import type { RegistryEntry, ShareViewIdentity } from "../workspaces/registryStore";
import type { SyncHistory } from "../workspaces/syncHistory";
import type { ReachRoster } from "@dohc/automation-executor/automation-reach";
import {
  readStoredRoster,
  ownerRoster,
  UNUSABLE_ROSTER,
  type ListedGrant,
  type RosterAnswer,
  type RosterListing,
  type HistoryAccount,
} from "@dohc/automation-executor/roster-listing";

// The share roster: the grants the owner gave on one workspace, as the relay
// last listed them. Grants live only on the relay, and the reach check
// (automationReach.ts) must answer without a network round trip, so the
// owner's computer keeps this copy under stateDir.
//
// The copy is never broader than the relay's last answer. A relay that
// answers nothing leaves the copy in place, and it stands in until this
// computer pulls from the relay. A relay that answers with anything dohc
// cannot read replaces it with a problem, and the reach check stops every
// step.

export const SHARE_ROSTER_REFRESH_MS = 10 * 60_000;
// Before a run, a roster listed longer ago than this is listed again if the
// relay answers. Listings are also at most this frequent when they fail.
export const SHARE_ROSTER_FRESH_MS = 60_000;
const SYNC_AGAIN = "Sync this workspace in Settings → Sync and sharing, then try again.";

/**
 * The stored copy. `version` rises when the listing changes.
 * `pulledAfter` records that this computer started a pull from the relay
 * after this listing started, so the pull may have brought changes the
 * listing did not see. It is written before the pull request is sent, and
 * only the next listing replaces it.
 */
export type RosterObservation = { listing: RosterListing | null; checkedAtMs: number | null; freshness: "fresh" | "stale" | "unknown" };

export type ShareRoster = RosterListing & { version: number; listedAtMs: number; pulledAfter?: true };

/**
 * What the reach check knows on this computer.
 *
 * `latest` is a listing this computer learned but could not save yet. It is
 * newer than the registry's copy, so it wins. `next` is what a person can do
 * when dohc has no listing it can use. `localPersonId` is this computer's
 * own id for its person, given only for a workspace proved never shared.
 * `history` is what the folder's record says for a workspace with no
 * server connection in the registry.
 */
export function reachRosterFor(input: {
  entry: RegistryEntry;
  localUserId: string | null;
  localPersonId: string | null;
  history: SyncHistory | null;
  latest: RosterListing | null;
  next: string;
}): ReachRoster {
  const { entry } = input;
  if (entry.shareView) return { kind: "shared-view" };
  const remote = entry.remote ?? entry.pausedRemote;
  // A workspace that synced keeps its grants on the relay even after it is
  // forgotten and attached again, which drops its server connection from the
  // registry. With no connection dohc cannot list them, so who can edit it
  // is unknown until it syncs again. A record dohc cannot read may say it
  // synced, so it counts the same. Only a folder with no record, as one made
  // before dohc kept it, or one that says it never synced, is its owner's.
  if (!remote && (input.history === "synced" || input.history === "unknown")) {
    return { kind: "unknown", problem: { kind: "unchecked", next: SYNC_AGAIN } };
  }
  // Only this computer's person can edit a workspace that does not sync, even
  // with no account signed in.
  if (!remote) {
    const local = input.localPersonId === null ? {} : { localPersonId: input.localPersonId };
    return { kind: "owner", ownerUserId: input.localUserId, grants: [], ...local };
  }
  // The registry is a file on disk. A copy it cannot read is unchecked, not empty.
  return ownerRoster(remote.ownerUserId, input.latest ?? entry.shareRoster, input.next);
}

interface RosterState {
  timer: ReturnType<typeof setInterval> | null;
  // When the last listing started, on a clock that never steps backwards.
  // It only paces listings.
  lastAttemptMs: number | null;
  // Pulls this computer started for the workspace in this session, and how
  // many are still running.
  pullStarts: number;
  pullsRunning: number;
  // A pull mark could not be saved. The roster is unknown until a mark or an
  // answered listing is saved.
  markFailed: boolean;
  // Set while listings get no answer, and cleared only when one answers.
  // `partial` is true when the relay answered part of one of them.
  noAnswer: { next: string; partial: boolean } | null;
  // A listing the registry has not saved yet.
  unsaved: { listing: RosterListing; pulledAfter: boolean; listedAtMs: number; context: unknown } | null;
  running: Promise<"requested" | "unavailable"> | null;
  again: boolean;
  retry: ReturnType<typeof setTimeout> | null;
  changeGeneration: number;
  checkedAtMs: number | null;
  checkedContext: unknown;
  invalidated: boolean;
  retired: boolean;
  parsedSource: unknown;
  parsed: RosterListing | null;
}

/**
 * Keeps each open workspace's roster current: at open, after this computer
 * changes a share, when relay sync recovers, and every 10 minutes. The
 * executor asks `forRun` before a run.
 *
 * While listings get no answer, the cached roster stands in only if this
 * computer has not pulled from the relay since that roster was listed. A
 * pull can bring an automation from someone whose grant the cached roster
 * does not show, so after one the roster is unknown until a listing answers.
 * The registry records the pull before its request is sent, so neither a
 * crash nor a lost response can hide it. When the registry cannot record it,
 * the pull does not run. The pull does not say who wrote what
 * it brought, so a person's own changes from another computer count too.
 */
export function createShareRosters(dependencies: {
  findWorkspace(workspaceId: string): RegistryEntry | null;
  saveRoster(workspaceId: string, listing: RosterListing, pulledAfter: boolean, listedAtMs: number): void;
  // Records that a pull started after the stored listing.
  markRosterPulled(workspaceId: string): void;
  listRoster(workspace: RegistryEntry): Promise<RosterAnswer>;
  localUserId(): Promise<string | null>;
  /** This computer's own id for its person, when the workspace is proved never shared; otherwise null. */
  localPersonId(workspace: RegistryEntry): Promise<string | null>;
  /** What the folder's record says about whether the workspace ever synced. */
  syncHistory(workspace: RegistryEntry): Promise<SyncHistory>;
  logError(workspaceId: string, error: unknown): void;
  /** A listing answered, so claims waiting to check who can edit can run. */
  onListed?(workspaceId: string): void;
  // A clock that never steps backwards, for pacing listings.
  nowMs?: () => number;
  wallNowMs?: () => number;
  /** Account session and physical attachment identity, compared before publication. */
  context?(workspaceId: string): unknown;
}) {
  const wallNowMs = dependencies.wallNowMs ?? Date.now;
  const context = dependencies.context ?? (() => null);
  const nowMs = dependencies.nowMs ?? (() => performance.now());
  const states = new Map<string, RosterState>();

  function stateFor(workspaceId: string): RosterState {
    let state = states.get(workspaceId);
    if (!state || state.retired) {
      state = {
        timer: null, lastAttemptMs: null, pullStarts: 0, pullsRunning: 0, markFailed: false,
        noAnswer: null, unsaved: null, running: null, again: false, retry: null,
        changeGeneration: 0, checkedAtMs: null, checkedContext: null, invalidated: false, retired: false, parsedSource: undefined, parsed: null,
      };
      states.set(workspaceId, state);
    }
    return state;
  }

  function save(workspaceId: string, state: RosterState): void {
    if (!state.unsaved) return;
    if (state.retired || state.unsaved.context !== context(workspaceId)) { state.unsaved = null; return; }
    try {
      dependencies.saveRoster(workspaceId, state.unsaved.listing, state.unsaved.pulledAfter, state.unsaved.listedAtMs);
      state.unsaved = null;
      state.markFailed = false;
    } catch (error) {
      dependencies.logError(workspaceId, error);
    }
  }

  // Record, before its request is sent, that a pull follows the latest
  // listing. Throws when the registry cannot be written.
  function markPulled(workspaceId: string, state: RosterState): void {
    if (state.unsaved && state.unsaved.context !== context(workspaceId)) state.unsaved = null;
    if (state.unsaved) {
      state.unsaved.pulledAfter = true;
      dependencies.saveRoster(workspaceId, state.unsaved.listing, true, state.unsaved.listedAtMs);
      state.unsaved = null;
    } else {
      const stored = dependencies.findWorkspace(workspaceId)?.shareRoster;
      if (stored && !stored.pulledAfter) dependencies.markRosterPulled(workspaceId);
    }
    state.markFailed = false;
  }

  // A pull followed the latest listing, so it may have brought changes the
  // listing did not see.
  function pulledSinceListing(workspaceId: string, state: RosterState): boolean {
    if (state.unsaved) return state.unsaved.pulledAfter;
    return dependencies.findWorkspace(workspaceId)?.shareRoster?.pulledAfter === true;
  }

  // The roster may be missing an editor: a pull mark could not be saved, or
  // the latest listing got no answer and a pull followed the one before it.
  function stale(workspaceId: string, state: RosterState): boolean {
    if (state.markFailed) return true;
    if (state.noAnswer === null) return false;
    return state.noAnswer.partial || pulledSinceListing(workspaceId, state);
  }

  async function listOnce(workspaceId: string, state: RosterState): Promise<"requested" | "unavailable"> {
    const workspace = dependencies.findWorkspace(workspaceId);
    const remote = workspace?.remote ?? workspace?.pausedRemote;
    if (!workspace || !remote || workspace.shareView) return "unavailable";
    state.lastAttemptMs = nowMs();
    const listedAtMs = wallNowMs();
    const capturedContext = context(workspaceId);
    const capturedChange = state.changeGeneration;
    // A pull that runs at any time after this listing starts may bring
    // changes the listing does not see.
    const pullStartsBefore = state.pullStarts;
    const pullRunning = state.pullsRunning > 0;
    let answer: RosterAnswer;
    try {
      answer = await dependencies.listRoster(workspace);
    } catch (error) {
      dependencies.logError(workspaceId, error);
      answer = UNUSABLE_ROSTER;
    }
    const current = dependencies.findWorkspace(workspaceId);
    const currentRemote = current?.remote ?? current?.pausedRemote;
    if (state.retired || context(workspaceId) !== capturedContext || !current ||
        current.rootPath !== workspace.rootPath || currentRemote?.ownerUserId !== remote.ownerUserId ||
        currentRemote?.serverUrl !== remote.serverUrl) return "unavailable";
    if (answer.kind === "unanswered") {
      state.invalidated = true;
      state.noAnswer = { next: answer.next, partial: (state.noAnswer?.partial ?? false) || answer.partial };
      return "unavailable";
    }
    state.noAnswer = null;
    state.checkedAtMs = listedAtMs;
    state.checkedContext = capturedContext;
    state.invalidated = capturedChange !== state.changeGeneration || answer.listing.grants === null;
    state.unsaved = { listing: answer.listing, listedAtMs, context: capturedContext, pulledAfter: pullRunning || state.pullStarts !== pullStartsBefore };
    save(workspaceId, state);
    dependencies.onListed?.(workspaceId);
    return "requested";
  }

  // Pace Access requests independently of immediate share-change and pull
  // relisting for automation reach.
  function pacedRefresh(workspaceId: string): Promise<AccessRefreshResult["status"]> {
    const state = stateFor(workspaceId);
    if (state.running) return state.running.then(status => status === "requested" ? "joined" : status);
    if (due(state)) return refresh(workspaceId);
    if (!state.retry) {
      state.retry = setTimeout(() => {
        state.retry = null;
        void refresh(workspaceId);
      }, Math.max(0, SHARE_ROSTER_FRESH_MS - (nowMs() - state.lastAttemptMs!)));
      state.retry.unref?.();
    }
    return Promise.resolve("paced");
  }

  function refresh(workspaceId: string): Promise<"requested" | "unavailable"> {
    const state = stateFor(workspaceId);
    if (state.running) { state.again = true; return state.running; }
    if (state.retry) { clearTimeout(state.retry); state.retry = null; }
    const running = (async () => {
      let status: "requested" | "unavailable";
      do {
        state.again = false;
        status = await listOnce(workspaceId, state);
      } while (state.again && !state.retired);
      return status;
    })().finally(() => { state.running = null; });
    state.running = running;
    return running;
  }

  function due(state: RosterState): boolean {
    return state.lastAttemptMs === null || nowMs() - state.lastAttemptMs >= SHARE_ROSTER_FRESH_MS;
  }

  async function forRun(workspaceId: string): Promise<ReachRoster> {
    const state = stateFor(workspaceId);
    // While the cached roster stands in, the relay is answering nothing, so a
    // run does not wait on another listing. While the relay answers, a pull
    // since the last listing means the run lists again first.
    const cacheStandsIn = state.noAnswer !== null && !stale(workspaceId, state);
    const pulledSince = state.noAnswer === null && pulledSinceListing(workspaceId, state);
    if (state.running) await state.running;
    else if ((due(state) || pulledSince) && !cacheStandsIn) await refresh(workspaceId);
    // A pull that ran during that listing may have brought changes the
    // listing did not see, so the run lists once more. If a pull overlaps
    // that listing too, the roster is unknown for this run.
    const overlapped = () => state.noAnswer === null && pulledSinceListing(workspaceId, state);
    if (overlapped()) await refresh(workspaceId);
    save(workspaceId, state);
    return await known(workspaceId, state, overlapped());
  }

  // What this computer knows now, with no listing.
  async function known(workspaceId: string, state: RosterState, overlapped: boolean): Promise<ReachRoster> {
    const entry = dependencies.findWorkspace(workspaceId);
    if (state.unsaved && state.unsaved.context !== context(workspaceId)) state.unsaved = null;
    if (!entry) return { kind: "unknown", problem: { kind: "unchecked", next: "Open this workspace, then try again." } };
    const noAnswer = state.noAnswer;
    const remote = entry.remote ?? entry.pausedRemote;
    const next = noAnswer?.next ?? (entry.pausedRemote ? "Turn sync on in Settings → Sync and sharing, then try again." : "Try again in a moment.");
    if (remote && !entry.shareView && (overlapped || stale(workspaceId, state))) {
      return { kind: "unknown", problem: { kind: "unchecked", next: state.markFailed
        ? "Check that your disk has free space, then try again." : next } };
    }
    return reachRosterFor({
      entry,
      localUserId: remote ? null : await dependencies.localUserId(),
      localPersonId: remote ? null : await dependencies.localPersonId(entry),
      history: remote ? null : await dependencies.syncHistory(entry),
      latest: state.unsaved?.listing ?? null,
      next,
    });
  }

  return {
    open(workspaceId: string): void {
      const state = stateFor(workspaceId);
      if (state.timer) return;
      state.timer = setInterval(() => void pacedRefresh(workspaceId), SHARE_ROSTER_REFRESH_MS);
      state.timer.unref?.();
      void pacedRefresh(workspaceId);
    },

    close(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (!state) return;
      if (state.timer) clearInterval(state.timer);
      if (state.retry) clearTimeout(state.retry);
      state.timer = null;
      state.retry = null;
      state.changeGeneration += 1;
      state.invalidated = true;
      state.again = false;
      state.retired = true;
      state.unsaved = null;
    },

    /** This computer created, ended, or changed a share. Null names no workspace, so every open one refreshes. */
    sharesChanged(workspaceId: string | null): void {
      const invalidate = (id: string) => {
        const state = stateFor(id);
        state.changeGeneration += 1;
        state.invalidated = true;
        void refresh(id);
      };
      if (workspaceId !== null) invalidate(workspaceId);
      else for (const [id, state] of states) if (state.timer) invalidate(id);
    },

    /**
     * A relay sync pass succeeded, so the relay answers. `recovered` is true
     * when the pass before it failed. The roster lists again then, and after a
     * listing that got no answer, at most once a minute either way. Resolves
     * when that listing ends.
     */
    pulled(workspaceId: string, recovered: boolean): Promise<void> {
      const state = stateFor(workspaceId);
      return (recovered || state.noAnswer !== null) && due(state) ? pacedRefresh(workspaceId).then(() => undefined) : Promise.resolve();
    },

    /**
     * A pull from the relay is about to start. Records it durably before it
     * returns, and returns the function to call when the pull ends. Throws
     * when the registry cannot record it, so the pull does not run.
     */
    pullStarting(workspaceId: string): () => void {
      const state = stateFor(workspaceId);
      try {
        markPulled(workspaceId, state);
      } catch (error) {
        state.markFailed = true;
        throw new Error(
          `dohc did not pull because it could not save the share roster's pull mark to the workspace registry: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      state.pullStarts += 1;
      state.pullsRunning += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        state.pullsRunning -= 1;
      };
    },

    /** Sharing, Access, and the CLI use this same pacing decision. */
    requestRefresh(workspaceId: string): Promise<AccessRefreshResult["status"]> { return pacedRefresh(workspaceId); },

    observation(workspaceId: string): RosterObservation {
      const state = stateFor(workspaceId);
      if (state.unsaved && state.unsaved.context !== context(workspaceId)) state.unsaved = null;
      const raw = state.unsaved?.listing ?? dependencies.findWorkspace(workspaceId)?.shareRoster;
      if (state.parsedSource !== raw) { state.parsedSource = raw; state.parsed = readStoredRoster(raw); }
      const listing = state.parsed;
      const checkedAtMs = state.checkedAtMs ?? dependencies.findWorkspace(workspaceId)?.shareRoster?.listedAtMs ?? null;
      const freshness = !listing || listing.grants === null ? "unknown" :
        state.checkedAtMs === null || state.invalidated || state.checkedContext !== context(workspaceId) ||
        wallNowMs() - state.checkedAtMs < 0 || wallNowMs() - state.checkedAtMs >= SHARE_ROSTER_REFRESH_MS ? "stale" : "fresh";
      return { listing, checkedAtMs, freshness };
    },

    forRun,

    /**
     * What the roster says now, without listing again, for showing reach.
     * Runs use `forRun`, which lists again when the roster is stale.
     */
    cached(workspaceId: string): Promise<ReachRoster> {
      return known(workspaceId, stateFor(workspaceId), false);
    },

  };
}

const ACCESS_WORDS: Record<ListedGrant["access"], string> = {
  view: "View",
  comment: "Comment",
  edit: "Edit",
  "read-only": "View",
  "read-write": "Edit",
};

/**
 * How History names a person who wrote a Collection's own files directly
 * (ADR 0013): their email and level from the owner's roster, as
 * "ana@example.com (Edit)". A grant the roster no longer lists as active,
 * such as a revoked one, still names the person without a level: by another
 * active grant of theirs, or by a former or ended grant the roster keeps.
 * Anyone else, or anyone when the saved roster could not be read (null), is
 * "Someone you shared with". Read the saved roster once per History read
 * with `readStoredRoster`.
 */
export function rosterAuthorLabel(
  listing: RosterListing | null,
  author: { userId: string; grantId: string },
): string {
  if (listing === null || listing.grants === null) return "Someone you shared with";
  const grant = listing.grants.find((candidate) => candidate.grantId === author.grantId);
  if (grant?.recipientEmail && (grant.recipientUserId === null || grant.recipientUserId === author.userId)) {
    return `${grant.recipientEmail} (${ACCESS_WORDS[grant.access]})`;
  }
  return rosterPersonLabel(listing, author.userId);
}

/** A Button presser's name, including people whose grants have ended. */
export function rosterPersonLabel(listing: RosterListing | null, userId: string): string {
  if (listing === null || listing.grants === null) return "Someone you shared with";
  const grant = [...listing.grants, ...listing.formerGrants.map((former) => former.grant), ...listing.endedGrants].find(
    (candidate) => candidate.recipientUserId === userId && candidate.recipientEmail !== null,
  );
  if (!grant?.recipientEmail) return "Someone you shared with";
  return grant.recipientEmail;
}

/** History's window-lifetime cache. Reads never wait for account lookups. */
export function createHistoryLabels(dependencies: {
  snapshot(workspaceId: string): { roster: RosterListing | null; owner: boolean; context: unknown; inventory: unknown;
    shareView?: Pick<ShareViewIdentity, "granterUserId" | "sharerName" | "granterEmail"> };
  lookupAccounts(workspaceId: string, ids: { grantIds: string[]; userIds: string[] }): Promise<HistoryAccount[] | null>;
  ready?(workspaceId: string): void;
  nowMs?(): number;
}) {
  type Snapshot = ReturnType<typeof dependencies.snapshot>;
  type Cache = { snapshot: Snapshot; grants: Map<string, HistoryAccount>; people: Map<string, HistoryAccount>;
    asked: Set<string>; pending: Map<string, { userId: string; grantId?: string }>; running: boolean; retryAt: number };
  const caches = new Map<string, Cache>();
  const now = dependencies.nowMs ?? (() => performance.now());
  const key = (person: { userId: string; grantId?: string }) => person.grantId === undefined ? `user:${person.userId}` : `grant:${person.grantId}`;
  const same = (left: Snapshot, right: Snapshot) => left.context === right.context && left.inventory === right.inventory;
  const current = (workspaceId: string, snapshot: Snapshot) => {
    const cache = caches.get(workspaceId);
    return cache && same(cache.snapshot, snapshot) ? cache : undefined;
  };
  const live = (workspaceId: string, cache: Cache) => caches.get(workspaceId) === cache && same(cache.snapshot, dependencies.snapshot(workspaceId)) && dependencies.snapshot(workspaceId).owner;
  function cachedLabel(workspaceId: string, userId: string, grantId?: string): string {
    const snapshot = dependencies.snapshot(workspaceId);
    const cache = snapshot.owner ? current(workspaceId, snapshot) : undefined;
    const account = grantId === undefined ? cache?.people.get(userId) : cache?.grants.get(grantId);
    return account?.recipientUserId === userId && account.recipientEmail
      ? `${account.recipientEmail} (via share link)` : "Someone you shared with";
  }
  function schedule(workspaceId: string, target: Cache): void {
    if (target.running || target.pending.size === 0 || now() < target.retryAt) return;
    target.running = true;
    // Let the IPC read answer and release its workspace lease before starting I/O.
    setImmediate(() => { void (async () => {
      if (!live(workspaceId, target)) return;
      const batch = [...target.pending.entries()].slice(0, 200);
      for (const [id] of batch) { target.pending.delete(id); target.asked.add(id); }
      let accounts: HistoryAccount[] | null;
      try { accounts = await dependencies.lookupAccounts(workspaceId, {
        grantIds: batch.flatMap(([, person]) => person.grantId === undefined ? [] : [person.grantId]),
        userIds: batch.flatMap(([, person]) => person.grantId === undefined ? [person.userId] : []),
      }); } catch { accounts = null; }
      if (!live(workspaceId, target)) return;
      if (accounts === null) { for (const [id] of batch) target.asked.delete(id); target.retryAt = now() + 60_000; target.pending.clear(); return; }
      for (const [id] of batch) target.asked.add(id);
      for (const account of accounts) {
        target.grants.set(account.grantId, account);
        if (!target.people.has(account.recipientUserId)) target.people.set(account.recipientUserId, account);
      }
      if (accounts.some(account => account.recipientEmail)) dependencies.ready?.(workspaceId);
    })().finally(() => {
      target.running = false;
      if (live(workspaceId, target)) schedule(workspaceId, target);
    }); });
  }
  return {
    invalidate(workspaceId: string | null): void {
      if (workspaceId === null) caches.clear(); else caches.delete(workspaceId);
    },
    prepare(workspaceId: string, principals: readonly { userId: string; grantId?: string }[]): void {
      const snapshot = dependencies.snapshot(workspaceId);
      if (!snapshot.owner) return;
      let cache = current(workspaceId, snapshot);
      if (cache && now() < cache.retryAt) return;
      const missing = principals.filter(person => !cache?.asked.has(key(person)) && !(person.grantId === undefined ? cache?.people.has(person.userId) : cache?.grants.has(person.grantId)) && (person.grantId === undefined
        ? rosterPersonLabel(snapshot.roster, person.userId) : rosterAuthorLabel(snapshot.roster, { userId: person.userId, grantId: person.grantId })) === "Someone you shared with");
      if (missing.length === 0) return;
      if (!cache) {
        cache = { snapshot, grants: new Map(), people: new Map(), asked: new Set(), pending: new Map(), running: false, retryAt: 0 };
        caches.set(workspaceId, cache);
      }
      if (now() < cache.retryAt) return;
      for (const person of missing) {
        const id = key(person);
        if (!cache.asked.has(id) && (person.grantId === undefined ? !cache.people.has(person.userId) : !cache.grants.has(person.grantId))) cache.pending.set(id, person);
      }
      schedule(workspaceId, cache);
    },
    author(workspaceId: string, author: { userId: string; grantId: string }): string {
      const known = rosterAuthorLabel(dependencies.snapshot(workspaceId).roster, author);
      return known !== "Someone you shared with" ? known : cachedLabel(workspaceId, author.userId, author.grantId);
    },
    person(workspaceId: string, userId: string): string {
      const snapshot = dependencies.snapshot(workspaceId);
      const share = snapshot.shareView;
      if (share?.granterUserId && share.granterUserId === userId) {
        const label = share.sharerName || share.granterEmail;
        if (label) return label;
      }
      const known = rosterPersonLabel(snapshot.roster, userId);
      return known !== "Someone you shared with" ? known : cachedLabel(workspaceId, userId);
    },
  };
}
