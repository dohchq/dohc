import { z } from "zod";
import {
  isShareablePath,
  isValidShareVersionId,
  MAX_SHARE_PATHS,
  SHARE_ACCESS_VALUES,
} from "@dohc/security-contract/share-selector";
import type { RegistryEntry } from "../workspaces/registryStore";
import type { FormerEditor, ReachRoster, RosterGrant, RosterProblem } from "@dohc/automation-executor/automation-reach";

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
  selector: z.object({ kind: z.literal("chat"), channelWireId: ID }),
  access: CHAT_ACCESS,
});
const FileGrant = z.object({
  ...BASE,
  selector: z
    .object({ kind: z.never().optional(), paths: PATHS, versionId: VERSION_ID.nullable() })
    .refine((selector) => selector.paths.length > 0 || selector.versionId !== null),
  access: z.enum(SHARE_ACCESS_VALUES),
});
const GrantSchema = z.union([GroupGrant, ChatGrant, FileGrant]);
const ListedGrantSchema = GrantSchema.refine((grant) => grant.recipientUserId !== null || grant.recipientEmail !== null);
export type ListedGrant = z.infer<typeof ListedGrantSchema>;

// A share link's own grant. It names nobody: whoever holds the link is one
// editor, the link. `ended` is a revoked link, kept only when it wrote a
// Collection's automations.yaml directly (ADR 0013), so the reach check can
// still hold what it may have written. `automationsGeneration` is the newest
// grant generation it wrote one under, or null.
const GENERATION = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ListedLinkSchema = z.object({
  grant: GrantSchema.refine((grant) => grant.recipientUserId === null && grant.recipientEmail === null),
  ended: z.boolean(),
  automationsGeneration: GENERATION.nullable(),
}).refine((link) => link.automationsGeneration === null || coversFiles(link.grant));

// A grant that wrote automations covered files by path. One that says it
// wrote them and covers none, such as a chat grant, is damaged: read as
// covering nothing, it would hold nothing.
function coversFiles(grant: z.infer<typeof GrantSchema>): boolean {
  return (rosterGrantOf(grant).files?.paths.length ?? 0) > 0;
}
export type ListedLink = z.infer<typeof ListedLinkSchema>;

// A named grant that wrote a Collection's automations.yaml directly (ADR
// 0013) and can no longer edit files: revoked, or narrowed below Edit.
const FormerGrantSchema = z.object({ grant: ListedGrantSchema, automationsGeneration: GENERATION })
  .refine((former) => coversFiles(former.grant));
export type FormerGrant = z.infer<typeof FormerGrantSchema>;

const ProblemSchema = z.union([
  z.object({ kind: z.literal("damaged-share"), recipientEmail: z.string().min(1).max(320).nullable() }),
  z.object({ kind: z.literal("damaged-link") }),
  z.object({ kind: z.literal("unusable-listing") }),
  z.object({ kind: z.literal("outdated-server") }),
]);

/**
 * What one listing found: the active grants, the share links, and the named
 * grants that wrote automations and stopped editing; or why dohc cannot use
 * them.
 */
export type RosterListing =
  | { grants: ListedGrant[]; links: ListedLink[]; formerGrants: FormerGrant[] }
  | { grants: null; problem: Exclude<RosterProblem, { kind: "unchecked" }> };

/**
 * The registry's copy. `version` rises when the listing changes.
 * `pulledAfter` records that this computer started a pull from the relay
 * after this listing started, so the pull may have brought changes the
 * listing did not see. It is written before the pull request is sent, and
 * only the next listing replaces it.
 */
export type ShareRoster = RosterListing & { version: number; pulledAfter?: true };

// A copy from before links were listed has no `links`, so it reads as
// unchecked rather than as a workspace with no links.
const StoredRoster = z.union([
  z.object({ grants: z.array(ListedGrantSchema), links: z.array(ListedLinkSchema), formerGrants: z.array(FormerGrantSchema) }),
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
  const recipient = { grantId: grant.grantId, recipientUserId: grant.recipientUserId, recipientEmail: grant.recipientEmail };
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
const RowState = z.object({
  revokedAtMs: z.number().nullable(),
  principalKind: z.enum(["user", "email", "link"]),
  automationsGeneration: GENERATION.nullable(),
});
const LinkRow = z.object({
  grantId: z.unknown(),
  status: z.enum(["active", "revoked"]),
  selector: z.unknown(),
  access: z.unknown(),
  automationsGeneration: GENERATION.nullable(),
  dependents: z.array(z.object({ grantId: z.unknown(), recipientUserId: z.unknown(), recipientEmail: z.unknown(), access: z.unknown() })),
});

const LinkPage = z.object({ links: z.array(z.unknown()), nextCursor: z.string().min(1).max(1024).optional() });

// The owner's grants on this workspace from GET /sync/shares. Rows for other
// workspaces are skipped before anything else is read, so their damage cannot
// hide this workspace's grants. A revoked grant is gone unless it wrote
// automations directly; then it stays as a former editor.
function grantedListing(
  workspaceId: string,
  shares: unknown,
): { grants: ListedGrant[]; formerGrants: FormerGrant[] } | Extract<RosterListing, { grants: null }> {
  const listing = z.object({ granted: z.array(z.unknown()) }).safeParse(shares);
  if (!listing.success) return { grants: null, problem: { kind: "unusable-listing" } };
  const grants: ListedGrant[] = [];
  const formerGrants: FormerGrant[] = [];
  for (const row of listing.data.granted) {
    const where = RowWorkspace.safeParse(row);
    if (!where.success) return { grants: null, problem: { kind: "unusable-listing" } };
    if (where.data.workspaceId !== workspaceId) continue;
    // A relay from before grants reported their automations writes.
    if (row !== null && typeof row === "object" && !("automationsGeneration" in row)) {
      return { grants: null, problem: { kind: "outdated-server" } };
    }
    const state = RowState.safeParse(row);
    if (state.success && state.data.principalKind === "link") continue;
    const generation = state.success ? state.data.automationsGeneration : null;
    const revoked = state.success && state.data.revokedAtMs !== null;
    if (revoked && generation === null) continue;
    const grant = ListedGrantSchema.safeParse(row);
    if (!state.success || !grant.success || (generation !== null && !coversFiles(grant.data))) {
      const email = RecipientEmail.safeParse(row);
      return { grants: null, problem: { kind: "damaged-share", recipientEmail: email.success ? email.data.recipientEmail : null } };
    }
    if (!revoked) grants.push(grant.data);
    if (generation !== null && (revoked || rosterGrantOf(grant.data).files?.access !== "edit")) {
      formerGrants.push({ grant: grant.data, automationsGeneration: generation });
    }
  }
  return { grants, formerGrants };
}

// One page of the owner's share links: each link that can edit files or
// wrote automations directly, and the dependents of every active link. A
// link that can only view never edits an automation and reaches nothing for
// one, so leaving it out keeps a workspace with many such links cheap to
// check.
function linkListing(links: readonly unknown[]): RosterListing {
  const grants: ListedGrant[] = [];
  const listed: ListedLink[] = [];
  const damaged = { grants: null, problem: { kind: "damaged-link" } } as const;
  for (const value of links) {
    // A relay from before links reported their automations writes leaves
    // the field out. Ending the link would not help; updating the relay does.
    if (value !== null && typeof value === "object" && !("automationsGeneration" in value)) {
      return { grants: null, problem: { kind: "outdated-server" } };
    }
    const link = LinkRow.safeParse(value);
    if (!link.success) return damaged;
    const ended = link.data.status !== "active";
    const wroteAutomations = link.data.automationsGeneration !== null;
    if (ended && !wroteAutomations) continue;
    const own = ListedLinkSchema.safeParse({
      grant: { grantId: link.data.grantId, recipientUserId: null, recipientEmail: null, selector: link.data.selector, access: link.data.access },
      ended,
      automationsGeneration: link.data.automationsGeneration,
    });
    if (!own.success) return damaged;
    if (wroteAutomations || (!ended && rosterGrantOf(own.data.grant).files?.access === "edit")) listed.push(own.data);
    if (ended) continue;
    for (const dependent of link.data.dependents) {
      const grant = ListedGrantSchema.safeParse({ ...dependent, selector: link.data.selector });
      if (!grant.success) return damaged;
      grants.push(grant.data);
    }
  }
  return { grants, links: listed, formerGrants: [] };
}

const byGrantId = (left: { grantId: string }, right: { grantId: string }) =>
  left.grantId < right.grantId ? -1 : left.grantId > right.grantId ? 1 : 0;

/**
 * Lists the roster for one workspace from the relay: the owner's granted
 * rows, and the dependents of the owner's share links. `get` sends one GET
 * with the owner's session and throws only when no response arrives.
 *
 * Every active share link is on the roster, as one editor keyed by its
 * grant, even before anyone opens it: an Edit link can change a Collection's
 * own files (ADR 0013). A dependent is a person who opened a link in dohc.
 * The relay lets a dependent with Edit send change proposals, so the roster
 * lists dependents like named grants, apart from their link.
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
  const { grants, formerGrants } = granted;
  const links: ListedLink[] = [];
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
    links.push(...linked.links);
    cursor = body.data.nextCursor;
    if (cursor === undefined) break;
    if (cursors.has(cursor)) return UNUSABLE;
    cursors.add(cursor);
  }
  return answered({
    grants: grants.sort(byGrantId),
    links: links.sort((left, right) => byGrantId(left.grant, right.grant)),
    formerGrants: formerGrants.sort((left, right) => byGrantId(left.grant, right.grant)),
  });
}

/**
 * What the reach check knows on this computer.
 *
 * `latest` is a listing this computer learned but could not save yet. It is
 * newer than the registry's copy, so it wins. `next` is what a person can do
 * when dohc has no listing it can use. `localPersonId` is this computer's
 * own id for its person, given only for a workspace proved never shared.
 */
export function reachRosterFor(input: {
  entry: RegistryEntry;
  localUserId: string | null;
  localPersonId: string | null;
  latest: RosterListing | null;
  next: string;
}): ReachRoster {
  const { entry } = input;
  if (entry.shareView) return { kind: "shared-view" };
  // Only this computer's person can edit a workspace that does not sync, even
  // with no account signed in.
  if (!entry.remote) {
    const local = input.localPersonId === null ? {} : { localPersonId: input.localPersonId };
    return { kind: "owner", ownerUserId: input.localUserId, grants: [], ...local };
  }
  // The registry is a file on disk. A copy it cannot read is unchecked, not empty.
  const stored = StoredRoster.safeParse(input.latest ?? entry.shareRoster);
  if (!stored.success) return { kind: "unknown", problem: { kind: "unchecked", next: input.next } };
  if (stored.data.grants === null) return { kind: "unknown", problem: stored.data.problem };
  const links = stored.data.links;
  return {
    kind: "owner",
    ownerUserId: entry.remote.ownerUserId,
    grants: [...stored.data.grants, ...links.filter((link) => !link.ended).map((link) => link.grant)].map(rosterGrantOf),
    formerEditors: [
      ...stored.data.formerGrants.flatMap(({ grant, automationsGeneration }) => formerEditorOf(grant, automationsGeneration, "person")),
      ...links.flatMap(formerLinkOf),
    ],
  };
}

// A grant that wrote automations directly, as the former editor it was: the
// files it covered, read as Edit.
function formerEditorOf(
  grant: ListedGrant | ListedLink["grant"],
  generation: number,
  holder: FormerEditor["holder"],
): FormerEditor[] {
  const { files } = rosterGrantOf(grant);
  if (files === null) return [];
  return [{
    grantId: grant.grantId, generation, holder, recipientEmail: grant.recipientEmail,
    files: { paths: files.paths, versionId: files.versionId },
  }];
}

// A link that wrote automations directly and can no longer edit files.
function formerLinkOf(link: ListedLink): FormerEditor[] {
  const generation = link.automationsGeneration;
  if (generation === null) return [];
  if (!link.ended && rosterGrantOf(link.grant).files?.access === "edit") return [];
  return formerEditorOf(link.grant, generation, "link");
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
      answer = UNUSABLE;
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
