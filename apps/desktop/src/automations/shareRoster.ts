import type { RegistryEntry } from "../workspaces/registryStore";
import type { SyncHistory } from "../workspaces/syncHistory";
import type { ReachRoster } from "@dohc/automation-executor/automation-reach";
import {
  ownerRoster,
  UNUSABLE_ROSTER,
  type ListedGrant,
  type RosterAnswer,
  type RosterListing,
} from "@dohc/automation-executor/roster-listing";

// The share roster: the grants the owner gave on one workspace, as the relay
// last listed them. Grants live only on the relay, and the reach check
// (automationReach.ts) must answer without a network round trip, so the
// owner's computer keeps this copy in the workspace registry.
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
 * The registry's copy. `version` rises when the listing changes.
 * `pulledAfter` records that this computer started a pull from the relay
 * after this listing started, so the pull may have brought changes the
 * listing did not see. It is written before the pull request is sent, and
 * only the next listing replaces it.
 */
export type ShareRoster = RosterListing & { version: number; pulledAfter?: true };

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
  // A workspace that synced keeps its grants on the relay even after it is
  // forgotten and attached again, which drops its server connection from the
  // registry. With no connection dohc cannot list them, so who can edit it
  // is unknown until it syncs again. A record dohc cannot read may say it
  // synced, so it counts the same. Only a folder with no record, as one made
  // before dohc kept it, or one that says it never synced, is its owner's.
  if (!entry.remote && (input.history === "synced" || input.history === "unknown")) {
    return { kind: "unknown", problem: { kind: "unchecked", next: SYNC_AGAIN } };
  }
  // Only this computer's person can edit a workspace that does not sync, even
  // with no account signed in.
  if (!entry.remote) {
    const local = input.localPersonId === null ? {} : { localPersonId: input.localPersonId };
    return { kind: "owner", ownerUserId: input.localUserId, grants: [], ...local };
  }
  // The registry is a file on disk. A copy it cannot read is unchecked, not empty.
  return ownerRoster(entry.remote.ownerUserId, input.latest ?? entry.shareRoster, input.next);
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
  unsaved: { listing: RosterListing; pulledAfter: boolean } | null;
  running: Promise<void> | null;
  again: boolean;
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
  saveRoster(workspaceId: string, listing: RosterListing, pulledAfter: boolean): void;
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
}) {
  const nowMs = dependencies.nowMs ?? (() => performance.now());
  const states = new Map<string, RosterState>();

  function stateFor(workspaceId: string): RosterState {
    let state = states.get(workspaceId);
    if (!state) {
      state = {
        timer: null, lastAttemptMs: null, pullStarts: 0, pullsRunning: 0, markFailed: false,
        noAnswer: null, unsaved: null, running: null, again: false,
      };
      states.set(workspaceId, state);
    }
    return state;
  }

  function save(workspaceId: string, state: RosterState): void {
    if (!state.unsaved) return;
    try {
      dependencies.saveRoster(workspaceId, state.unsaved.listing, state.unsaved.pulledAfter);
      state.unsaved = null;
      state.markFailed = false;
    } catch (error) {
      dependencies.logError(workspaceId, error);
    }
  }

  // Record, before its request is sent, that a pull follows the latest
  // listing. Throws when the registry cannot be written.
  function markPulled(workspaceId: string, state: RosterState): void {
    if (state.unsaved) {
      state.unsaved.pulledAfter = true;
      dependencies.saveRoster(workspaceId, state.unsaved.listing, true);
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

  async function listOnce(workspaceId: string, state: RosterState): Promise<void> {
    const workspace = dependencies.findWorkspace(workspaceId);
    if (!workspace?.remote || workspace.shareView) return;
    state.lastAttemptMs = nowMs();
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
    if (answer.kind === "unanswered") {
      state.noAnswer = { next: answer.next, partial: (state.noAnswer?.partial ?? false) || answer.partial };
      return;
    }
    state.noAnswer = null;
    state.unsaved = { listing: answer.listing, pulledAfter: pullRunning || state.pullStarts !== pullStartsBefore };
    save(workspaceId, state);
    dependencies.onListed?.(workspaceId);
  }

  // A request made while a listing runs gets one more listing after it, so a
  // share changed mid-listing is never missed.
  function refresh(workspaceId: string): Promise<void> {
    const state = stateFor(workspaceId);
    if (state.running) {
      state.again = true;
      return state.running;
    }
    const running = (async () => {
      do {
        state.again = false;
        await listOnce(workspaceId, state);
      } while (state.again);
    })().finally(() => {
      state.running = null;
    });
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
    if (!entry) return { kind: "unknown", problem: { kind: "unchecked", next: "Open this workspace, then try again." } };
    const noAnswer = state.noAnswer;
    if (entry.remote && !entry.shareView && (overlapped || stale(workspaceId, state))) {
      const next = state.markFailed
        ? "Check that your disk has free space, then try again."
        : noAnswer?.next ?? "Try again in a moment.";
      return { kind: "unknown", problem: { kind: "unchecked", next } };
    }
    return reachRosterFor({
      entry,
      localUserId: entry.remote ? null : await dependencies.localUserId(),
      localPersonId: entry.remote ? null : await dependencies.localPersonId(entry),
      history: entry.remote ? null : await dependencies.syncHistory(entry),
      latest: state.unsaved?.listing ?? null,
      next: noAnswer?.next ?? "Try again in a moment.",
    });
  }

  return {
    open(workspaceId: string): void {
      const state = stateFor(workspaceId);
      if (state.timer) return;
      state.timer = setInterval(() => void refresh(workspaceId), SHARE_ROSTER_REFRESH_MS);
      state.timer.unref?.();
      void refresh(workspaceId);
    },

    close(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (!state?.timer) return;
      clearInterval(state.timer);
      state.timer = null;
    },

    /** This computer created, ended, or changed a share. Null names no workspace, so every open one refreshes. */
    sharesChanged(workspaceId: string | null): void {
      if (workspaceId !== null) {
        void refresh(workspaceId);
        return;
      }
      for (const [id, state] of states) if (state.timer) void refresh(id);
    },

    /**
     * A relay sync pass succeeded, so the relay answers. `recovered` is true
     * when the pass before it failed. The roster lists again then, and after a
     * listing that got no answer, at most once a minute either way. Resolves
     * when that listing ends.
     */
    pulled(workspaceId: string, recovered: boolean): Promise<void> {
      const state = stateFor(workspaceId);
      return (recovered || state.noAnswer !== null) && due(state) ? refresh(workspaceId) : Promise.resolve();
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
 * "ana@example.com (Edit)". A grant the roster no longer lists, such as a
 * revoked one, still names the person by another grant of theirs, without
 * a level. Anyone else is "Someone you shared with".
 */
export function rosterAuthorLabel(
  roster: ShareRoster | undefined,
  author: { userId: string; grantId: string },
): string {
  const grants = roster?.grants ?? [];
  const grant = grants.find((candidate) => candidate.grantId === author.grantId);
  if (grant?.recipientEmail && (grant.recipientUserId === null || grant.recipientUserId === author.userId)) {
    return `${grant.recipientEmail} (${ACCESS_WORDS[grant.access]})`;
  }
  const email = grants.find(
    (candidate) => candidate.recipientUserId === author.userId && candidate.recipientEmail !== null,
  )?.recipientEmail;
  return email ?? "Someone you shared with";
}
