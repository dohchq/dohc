import { z } from "zod";
import {
  isShareablePath,
  isValidShareVersionId,
  MAX_SHARE_PATHS,
  SHARE_ACCESS_VALUES,
} from "@dohc/security-contract/share-selector";
import type { RegistryEntry } from "../workspaces/registryStore";
import {
  shareImpactOf,
  type ReachAutomation,
  type ReachRoster,
  type ReachShare,
  type RosterGrant,
  type RosterProblem,
  type StoppedStep,
} from "./automationReach";

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
// 50 pages of 1,000 share links. Past this the listing is not one dohc can
// check.
const MAX_LINK_PAGES = 50;

const ID = z.string().min(1).max(256);
const PATHS = z.array(z.string().refine(isShareablePath)).max(MAX_SHARE_PATHS);
const VERSION_ID = z.string().refine(isValidShareVersionId);
const CHAT_ACCESS = z.enum(["read-write", "read-only"]);
const BASE = {
  grantId: ID,
  recipientUserId: ID.nullable(),
  recipientEmail: z.string().min(1).max(320).nullable(),
};

// A grant as the relay lists it, with the relay's own scope rules
// (services/sync-relay/src/shareFilter.ts). The same schema reads the relay's
// answer and the registry's copy, so a damaged copy cannot widen a grant.
const GroupGrant = z.object({
  ...BASE,
  selector: z.object({ kind: z.literal("group"), channelWireId: ID, paths: PATHS.min(1), versionId: z.null() }),
  access: CHAT_ACCESS,
});
const ChatGrant = z.object({
  ...BASE,
  selector: z.object({ kind: z.literal("chat-channel"), channelWireId: ID }),
  access: CHAT_ACCESS,
});
const FileGrant = z.object({
  ...BASE,
  selector: z
    .object({ kind: z.never().optional(), paths: PATHS, versionId: VERSION_ID.nullable() })
    .refine((selector) => selector.paths.length > 0 || selector.versionId !== null),
  access: z.enum(SHARE_ACCESS_VALUES),
});
const ListedGrantSchema = z
  .union([GroupGrant, ChatGrant, FileGrant])
  .refine((grant) => grant.recipientUserId !== null || grant.recipientEmail !== null);
export type ListedGrant = z.infer<typeof ListedGrantSchema>;

const ProblemSchema = z.union([
  z.object({ kind: z.literal("damaged-share"), recipientEmail: z.string().min(1).max(320).nullable() }),
  z.object({ kind: z.literal("damaged-link") }),
  z.object({ kind: z.literal("unusable-listing") }),
]);

/** What one listing found: the grants, or why dohc cannot use them. */
export type RosterListing =
  | { grants: ListedGrant[] }
  | { grants: null; problem: Exclude<RosterProblem, { kind: "unchecked" }> };

/**
 * The registry's copy. `version` rises when the listing changes.
 * `pulledAfter` records that this computer started a pull from the relay
 * after this listing started, so the pull may have brought changes the
 * listing did not see. It is written before the pull request is sent, and
 * only the next listing replaces it.
 */
export type ShareRoster = RosterListing & { version: number; pulledAfter?: true };

const StoredRoster = z.union([
  z.object({ grants: z.array(ListedGrantSchema) }),
  z.object({ grants: z.null(), problem: ProblemSchema }),
]);

/**
 * A relay listing, or the Next a person needs when the relay did not answer.
 * `partial` is true when the relay answered one request of the listing and
 * then stopped answering, so the relay was up.
 */
export type RosterAnswer =
  | { kind: "answered"; listing: RosterListing }
  | { kind: "unanswered"; next: string; partial: boolean };

const UNUSABLE: RosterAnswer = {
  kind: "answered",
  listing: { grants: null, problem: { kind: "unusable-listing" } },
};

function answered(listing: RosterListing): RosterAnswer {
  return { kind: "answered", listing };
}

function isFileGrant(grant: ListedGrant): grant is z.infer<typeof FileGrant> {
  return grant.selector.kind === undefined;
}

function isGroupGrant(grant: ListedGrant): grant is z.infer<typeof GroupGrant> {
  return grant.selector.kind === "group";
}

function rosterGrantOf(grant: ListedGrant): RosterGrant {
  const recipient = { recipientUserId: grant.recipientUserId, recipientEmail: grant.recipientEmail };
  if (isFileGrant(grant)) {
    const { paths, versionId } = grant.selector;
    return { ...recipient, files: { paths, versionId, access: grant.access }, channel: null };
  }
  // A Group's read-write edits its folder and posts in its chat. Read-only
  // views both.
  const canPost = grant.access === "read-write";
  const channel = { wireId: grant.selector.channelWireId, canPost };
  if (isGroupGrant(grant)) {
    return { ...recipient, files: { paths: grant.selector.paths, versionId: null, access: canPost ? "edit" : "view" }, channel };
  }
  return { ...recipient, files: null, channel };
}

const RecipientEmail = z.object({ recipientEmail: z.string().min(1).max(320) });
const RowWorkspace = z.object({ workspaceId: z.string() });
const RowState = z.object({ revokedAtMs: z.number().nullable(), principalKind: z.enum(["user", "email", "link"]) });
const LinkRow = z.object({
  status: z.enum(["active", "revoked"]),
  selector: z.unknown(),
  dependents: z.array(z.object({ grantId: z.unknown(), recipientUserId: z.unknown(), recipientEmail: z.unknown(), access: z.unknown() })),
});

const LinkPage = z.object({ links: z.array(z.unknown()), nextCursor: z.string().min(1).max(1024).optional() });

// The owner's grants on this workspace from GET /sync/shares. Rows for other
// workspaces are skipped before anything else is read, so their damage cannot
// hide this workspace's grants.
function grantedListing(workspaceId: string, shares: unknown): RosterListing {
  const listing = z.object({ granted: z.array(z.unknown()) }).safeParse(shares);
  if (!listing.success) return { grants: null, problem: { kind: "unusable-listing" } };
  const grants: ListedGrant[] = [];
  for (const row of listing.data.granted) {
    const where = RowWorkspace.safeParse(row);
    if (!where.success) return { grants: null, problem: { kind: "unusable-listing" } };
    if (where.data.workspaceId !== workspaceId) continue;
    const state = RowState.safeParse(row);
    const grant = ListedGrantSchema.safeParse(row);
    if (state.success && (state.data.revokedAtMs !== null || state.data.principalKind === "link")) continue;
    if (!state.success || !grant.success) {
      const email = RecipientEmail.safeParse(row);
      return { grants: null, problem: { kind: "damaged-share", recipientEmail: email.success ? email.data.recipientEmail : null } };
    }
    grants.push(grant.data);
  }
  return { grants };
}

// The dependents on one page of the owner's share links.
function linkListing(links: readonly unknown[]): RosterListing {
  const grants: ListedGrant[] = [];
  for (const value of links) {
    const link = LinkRow.safeParse(value);
    if (!link.success) return { grants: null, problem: { kind: "damaged-link" } };
    if (link.data.status !== "active") continue;
    for (const dependent of link.data.dependents) {
      const grant = ListedGrantSchema.safeParse({ ...dependent, selector: link.data.selector });
      if (!grant.success) return { grants: null, problem: { kind: "damaged-link" } };
      grants.push(grant.data);
    }
  }
  return { grants };
}

/**
 * Lists the roster for one workspace from the relay: the owner's granted
 * rows, and the dependents of the owner's share links. `get` sends one GET
 * with the owner's session and throws only when no response arrives.
 *
 * Link holders are not on the roster: they cannot change files other than
 * live documents (ADR 0002). A dependent is different. It is a person who
 * opened a link in dohc, and the relay lets a dependent with Edit send change
 * proposals, so the roster lists dependents like named grants.
 *
 * Each answer is read as it arrives. Damage or a refusal decides the listing
 * at once, whatever happens to the requests after it.
 */
export async function listRosterGrants(
  workspaceId: string,
  get: (path: string) => Promise<{ status: number; body: unknown }>,
): Promise<RosterAnswer> {
  let partial = false;
  const noAnswer = (next: string) => ({ ok: false, answer: { kind: "unanswered", next, partial } }) as const;
  async function read(path: string): Promise<{ ok: true; body: unknown } | { ok: false; answer: RosterAnswer }> {
    let response: { status: number; body: unknown };
    try {
      response = await get(path);
    } catch {
      return noAnswer("Check your connection, then try again.");
    }
    if (response.status === 401) return noAnswer("Sign in again, then try again.");
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      return noAnswer("Your server is not answering. Try again later.");
    }
    if (response.status < 200 || response.status >= 300) return { ok: false, answer: UNUSABLE };
    partial = true;
    return { ok: true, body: response.body };
  }

  const shares = await read("/sync/shares");
  if (!shares.ok) return shares.answer;
  const granted = grantedListing(workspaceId, shares.body);
  if (granted.grants === null) return answered(granted);
  const grants = granted.grants;
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page === MAX_LINK_PAGES) return UNUSABLE;
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const answer = await read(`/sync/${encodeURIComponent(workspaceId)}/shares/links${query}`);
    if (!answer.ok) return answer.answer;
    const body = LinkPage.safeParse(answer.body);
    if (!body.success) return UNUSABLE;
    const linked = linkListing(body.data.links);
    if (linked.grants === null) return answered(linked);
    grants.push(...linked.grants);
    cursor = body.data.nextCursor;
    if (cursor === undefined) break;
    if (cursors.has(cursor)) return UNUSABLE;
    cursors.add(cursor);
  }
  return answered({ grants: grants.sort((left, right) => (left.grantId < right.grantId ? -1 : left.grantId > right.grantId ? 1 : 0)) });
}

/**
 * What the reach check knows on this computer.
 *
 * `latest` is a listing this computer learned but could not save yet. It is
 * newer than the registry's copy, so it wins. `next` is what a person can do
 * when dohc has no listing it can use.
 */
export function reachRosterFor(input: {
  entry: RegistryEntry;
  localUserId: string | null;
  latest: RosterListing | null;
  next: string;
}): ReachRoster {
  const { entry } = input;
  if (entry.shareView) return { kind: "shared-view" };
  // Only this computer's person can edit a workspace that does not sync, even
  // with no account signed in.
  if (!entry.remote) return { kind: "owner", ownerUserId: input.localUserId, grants: [] };
  // The registry is a file on disk. A copy it cannot read is unchecked, not empty.
  const stored = StoredRoster.safeParse(input.latest ?? entry.shareRoster);
  if (!stored.success) return { kind: "unknown", problem: { kind: "unchecked", next: input.next } };
  if (stored.data.grants === null) return { kind: "unknown", problem: stored.data.problem };
  return { kind: "owner", ownerUserId: entry.remote.ownerUserId, grants: stored.data.grants.map(rosterGrantOf) };
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
  logError(workspaceId: string, error: unknown): void;
  // A clock that never steps backwards, for pacing listings.
  nowMs?: () => number;
}) {
  const nowMs = dependencies.nowMs ?? (() => performance.now());
  const states = new Map<string, RosterState>();

  function stateFor(workspaceId: string): RosterState {
    let state = states.get(workspaceId);
    if (!state) {
      state = {
        timer: null, lastAttemptMs: null, pullStarts: 0, pullsRunning: 0,
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
      return;
    }
    const stored = dependencies.findWorkspace(workspaceId)?.shareRoster;
    if (!stored || stored.pulledAfter) return;
    dependencies.markRosterPulled(workspaceId);
  }

  // The latest listing got no answer, and the roster it would fall back to
  // may be missing an editor.
  function stale(workspaceId: string, state: RosterState): boolean {
    if (state.noAnswer === null) return false;
    if (state.noAnswer.partial) return true;
    if (state.unsaved) return state.unsaved.pulledAfter;
    return dependencies.findWorkspace(workspaceId)?.shareRoster?.pulledAfter === true;
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
      answer = UNUSABLE;
    }
    if (answer.kind === "unanswered") {
      state.noAnswer = { next: answer.next, partial: (state.noAnswer?.partial ?? false) || answer.partial };
      return;
    }
    state.noAnswer = null;
    state.unsaved = { listing: answer.listing, pulledAfter: pullRunning || state.pullStarts !== pullStartsBefore };
    save(workspaceId, state);
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
    // run does not wait on another listing.
    const cacheStandsIn = state.noAnswer !== null && !stale(workspaceId, state);
    if (state.running) await state.running;
    else if (due(state) && !cacheStandsIn) await refresh(workspaceId);
    save(workspaceId, state);
    const entry = dependencies.findWorkspace(workspaceId);
    if (!entry) return { kind: "unknown", problem: { kind: "unchecked", next: "Open this workspace, then try again." } };
    const noAnswer = state.noAnswer;
    if (entry.remote && !entry.shareView && noAnswer && stale(workspaceId, state)) {
      return { kind: "unknown", problem: { kind: "unchecked", next: noAnswer.next } };
    }
    return reachRosterFor({
      entry,
      localUserId: entry.remote ? null : await dependencies.localUserId(),
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

    /** Which automation steps would stop if this share were created. */
    async shareImpact(
      workspaceId: string,
      share: ReachShare,
      automations: readonly ReachAutomation[],
    ): Promise<StoppedStep[]> {
      return shareImpactOf(await forRun(workspaceId), share, automations);
    },
  };
}
