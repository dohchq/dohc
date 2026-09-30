import { z } from "zod";
import {
  isShareablePath,
  isValidShareVersionId,
  MAX_SHARE_PATHS,
  SHARE_ACCESS_VALUES,
} from "@dohc/security-contract/share-selector";
import type { FormerEditor, ReachRoster, RosterGrant, RosterProblem } from "./automationReach";

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

export const UNUSABLE_ROSTER: RosterAnswer = {
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
    if (response.status < 200 || response.status >= 300) return { ok: false, answer: UNUSABLE_ROSTER };
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
    if (page === MAX_LINK_PAGES) return UNUSABLE_ROSTER;
    const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const answer = await read(`/sync/${encodeURIComponent(workspaceId)}/shares/links${query}`);
    if (!answer.ok) return answer.answer;
    const body = LinkPage.safeParse(answer.body);
    if (!body.success) return UNUSABLE_ROSTER;
    const linked = linkListing(body.data.links);
    if (linked.grants === null) return answered(linked);
    grants.push(...linked.grants);
    links.push(...linked.links);
    cursor = body.data.nextCursor;
    if (cursor === undefined) break;
    if (cursors.has(cursor)) return UNUSABLE_ROSTER;
    cursors.add(cursor);
  }
  return answered({
    grants: grants.sort(byGrantId),
    links: links.sort((left, right) => byGrantId(left.grant, right.grant)),
    formerGrants: formerGrants.sort((left, right) => byGrantId(left.grant, right.grant)),
  });
}

export function ownerRoster(ownerUserId: string, listing: unknown, next: string): ReachRoster {
  const stored = StoredRoster.safeParse(listing);
  if (!stored.success) return { kind: "unknown", problem: { kind: "unchecked", next: next } };
  if (stored.data.grants === null) return { kind: "unknown", problem: stored.data.problem };
  const links = stored.data.links;
  return {
    kind: "owner",
    ownerUserId,
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
