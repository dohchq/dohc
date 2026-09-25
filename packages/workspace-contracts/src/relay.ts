export interface SyncRelayConnection {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export interface RelayMaterializedPath {
  // The version that was active when the relay applied this change. Retries
  // keep this binding even if the user enters another version before the
  // caller materializes the path.
  versionId: string;
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary" | "secret";
}

// Called once for each relay pull page. The pull commits that page's cursor
// only after this resolves, so a failed or interrupted disk projection makes
// the relay offer the same page again on the next pass.
export type MaterializeRelayPullPage = (
  paths: readonly RelayMaterializedPath[],
) => Promise<void>;

export interface SharingDeclined {
  path: string;
  constraint: string;
  limitBytes: number;
  observedBytes: number;
}

export interface PullWorkspaceFromRelayResult {
  fetched: number;
  applied: number;
  skipped: number;
  conflictsOpened: number;
  sharingDeclined: SharingDeclined[];
  fastForwardedPaths: RelayMaterializedPath[];
  // The last cursor durably committed by this pull. Every page has already
  // passed through MaterializeRelayPullPage before the pull returns.
  nextCursor: number;
}

export interface OwnerAdmissionPending {
  workspaceId: string;
  originId: string;
  originSeq: number;
  versionId: string;
  objectId: string;
  path: string;
}

export interface PushWorkspaceToRelayResult {
  ownerAdmissionPending: OwnerAdmissionPending[];
  pushed: number;
  originsPushed: string[];
  sharingDeclined: SharingDeclined[];
}

export interface CommitRelayCursorResult {
  sharingDeclined: SharingDeclined[];
}

export class RelayUnauthorizedError extends Error {
  constructor(message = "Relay authorization failed.") {
    super(message);
    this.name = "RelayUnauthorizedError";
  }
}

export class RelayWorkspaceUnavailableError extends Error {
  constructor(message = "Relay workspace is unavailable.") {
    super(message);
    this.name = "RelayWorkspaceUnavailableError";
  }
}

export class RelayConflictError extends Error {
  constructor(message = "Relay rejected the operation batch.") {
    super(message);
    this.name = "RelayConflictError";
  }
}

// The relay log for this origin disagrees with the local journal (the relay
// is ahead of local reality, or holds the same origin seq with different
// content). That means the local engine.db was restored/cloned from an older
// snapshot — pushing must fail closed rather than silently drop local ops.
// Recovering via an origin reset is 0P-C follow-up work.
export class RelayOriginDivergedError extends Error {
  constructor(message = "Relay log for this origin diverged from the local journal.") {
    super(message);
    this.name = "RelayOriginDivergedError";
  }
}

export class RelayKeyEnvelopeMissingError extends Error {
  constructor(message = "Relay is missing the workspace key envelope.") {
    super(message);
    this.name = "RelayKeyEnvelopeMissingError";
  }
}

// The relay does not serve the relay API version this build speaks. "app"
// means the relay needs a newer dohc; "server" means the relay is older than
// this dohc and must be updated first.
export class RelayApiVersionError extends Error {
  constructor(readonly update: "app" | "server") {
    super(
      update === "app"
        ? "This server needs a newer version of dohc. Update dohc, then try again."
        : "This server runs an older version of dohc. Ask the person who runs it to update it.",
    );
    this.name = "RelayApiVersionError";
  }
}

export interface RecoverRelayOriginResult {
  // The diverged origin id the relay is authoritative for; it is retired
  // locally (never pushed again) but its ops stay as shared history.
  oldOriginId: string;
  // The fresh origin id this machine adopts for all future local writes.
  newOriginId: string;
  // How many leading local ops the relay also holds byte-identically — the
  // shared history prefix, kept as-is.
  sharedPrefixLength: number;
  // Genuinely-unpushed / divergent local ops re-journaled under the fresh
  // origin so they push cleanly and surface as conflicts where they clash —
  // never silently dropped.
  preservedOps: number;
}

export interface ProbeRelayWorkspaceResult {
  hasContent: boolean;
}

export interface RelayWorkspaceIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

export interface RelayWorkspaceBootstrapResult {
  hasContent: boolean;
  identity: RelayWorkspaceIdentity | null;
}

const MAX_RELAY_IDENTITY_BYTES = 512;
const RELAY_IDENTITY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function relayIdentityValue(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    RELAY_IDENTITY_CONTROL_CHARS.test(value) ||
    new TextEncoder().encode(value).byteLength > MAX_RELAY_IDENTITY_BYTES
  ) {
    return null;
  }
  return value;
}

export function decodeRelayWorkspaceBootstrap(
  value: unknown,
): RelayWorkspaceBootstrapResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay bootstrap response is invalid.");
  }
  const result = value as Record<string, unknown>;
  if (result.ok !== true || typeof result.hasContent !== "boolean") {
    throw new Error("Relay bootstrap response is invalid.");
  }
  if (result.replicationEpoch === null && result.streamIdentity === null) {
    return { hasContent: result.hasContent, identity: null };
  }
  const replicationEpoch = relayIdentityValue(result.replicationEpoch);
  const streamIdentity = relayIdentityValue(result.streamIdentity);
  if (replicationEpoch === null || streamIdentity === null) {
    throw new Error("Relay bootstrap response is invalid.");
  }
  return {
    hasContent: result.hasContent,
    identity: { replicationEpoch, streamIdentity },
  };
}

export class SharedChannelReadOnlyError extends Error {
  constructor(message = "You can only read this.") {
    super(message);
    this.name = "SharedChannelReadOnlyError";
  }
}

// The file sibling of the class above. A file share at `view`
// carries the chat about its files to read, and refuses to add to it — in
// main before any durable row, and again at the relay, which answers the
// same `share_read_only` code a read-only channel gets.
export class SharedFileReadOnlyError extends Error {
  constructor(message = "This shared file is read-only for you.") {
    super(message);
    this.name = "SharedFileReadOnlyError";
  }
}

export interface PullSharedChannelResult {
  fetched: number;
  applied: number;
  skipped: number;
  nextCursor: number;
}

export interface PushSharedChannelResult {
  pushed: number;
}

export class ShareUnavailableError extends Error {
  constructor(
    message = "This share was ended, or the code does not match your account.",
  ) {
    super(message);
    this.name = "ShareUnavailableError";
  }
}

// What a share view's identity call did.
//
// A share view replicates through its SHARE, not the owner relay lane, so it
// needs a sync identity of its own before it can journal a local write or
// push one back. The engine writes that row once; every later refresh answers
// "already-recorded".
//
// "not-required" is a `view` share, which may push nothing and so is given no
// identity — the absence is what keeps its local writes local.
type ShareViewEnrolment =
  | "recorded"
  | "already-recorded"
  | "not-required";

export interface RecordShareViewIdentityResult {
  identity: ShareViewEnrolment;
}

export interface ShareViewChangedPath {
  path: string;
  operation: "write" | "delete";
  contentKind: "text" | "binary";
}

// One op the pull refused. A share-view pull skips an op it will not apply
// rather than failing the page — one op a diverging relay serves must not
// wedge the share — so this is how the skip stops being silent. `detail` is
// the engine's refusal message: it names the constraint, and for a version
// refusal its limit, unit and observed usage.
export interface ShareViewRefusal {
  originId: string;
  originSeq: number;
  opKind: string;
  code: string;
  detail: string;
}

// How many refusals one pull keeps in memory across its pages. The durable
// record is the truth (each page is handed to the caller's recorder before
// its cursor commits); this aggregate is for logging and the immediate
// result, and a hostile relay must not be able to grow it in proportion to
// its log.
export const MAX_REPORTED_REFUSALS = 20;

export interface PullShareViewResult {
  fetched: number;
  applied: number;
  skipped: number;
  // Up to MAX_REPORTED_REFUSALS entries, in page order. `refusalCount` is the
  // true total.
  refusals: ShareViewRefusal[];
  refusalCount: number;
  changedPaths: ShareViewChangedPath[];
  nextCursor: number;
  // Persist the cursor only after the caller has materialized changedPaths
  // to disk — the same contract as pullWorkspaceFromRelay. A crash before
  // the commit re-fetches (and re-replays) the delta; replay is
  // content-compared so an already-applied op is a no-op.
  commitCursor: () => Promise<void>;
}

// A proposal is the set of changes a recipient offered in one
// submit. It exists only from submit — there is no draft state at the relay —
// and it leaves `open` exactly once.
export type ShareProposalState =
  | "open"
  | "accepted"
  | "declined"
  | "withdrawn";

export type ShareProposalDecision = "accept" | "decline";

// What one submit offered. `proposalId` is null exactly when nothing was
// offered: a share below edit level, or a scan that found no change. It is
// not a failure — a failed submit throws.
export interface SubmitShareProposalResult {
  submitted: number;
  proposalId: string | null;
  // Files the scan dropped because an edit put them outside the shared paths.
  // The recipient is told; silence would mean pressing send and having some of
  // the work simply not go.
  skippedOutsideShare: number;
  // More changes are waiting than one submit carries, so the next submit
  // sends the rest. A flag, not a count: the scan stops at the bound and never
  // measures what is behind it.
  morePending: boolean;
}

// One net change to one file, as the GRANTER sees it. The `current*` fields
// are the granter's own state now, so the reviewer can see the change against
// what it will actually land on rather than against what the recipient had.
export interface ShareProposalOp {
  opIndex: number;
  // The granter's path for this file when the recipient started, or null for
  // a file the recipient created.
  basedOnPath: string | null;
  operation: "write" | "delete";
  // Where the change puts the file. Null for a delete.
  afterPath: string | null;
  afterBlobSha256: string | null;
  afterContentKind: "text" | "binary" | null;
  // How big the incoming side is, so a review row can describe a file before
  // anything fetches it. Null for a delete and for a size the relay did not
  // state.
  afterByteLength: number | null;
  // Where the granter holds this file NOW. Null when the granter no longer
  // has it.
  currentPath: string | null;
  // The granter moved on since the recipient's base — decided by the RELAY,
  // against the granter's own head in the version this share exposes.
  // Accepting still works, but it opens a conflict instead of
  // fast-forwarding.
  drifted: boolean;
}

// A proposal waiting on the granter, with every op expanded for review. This
// surface serves only what is still open, so there is no state to carry.
export interface ShareProposal {
  proposalId: string;
  shareId: string;
  // Who sent it, resolved by the relay from the server-derived user id on the
  // proposal row. Null when the relay cannot name them.
  proposedByEmail: string | null;
  createdAtMs: number;
  ops: ShareProposalOp[];
}

// A proposal as the granter's listing states it: who sent it, when, and how
// many files it carries. No op rows — a timer polls that listing, and the
// review draws files only once a granter opens one proposal.
export interface ShareProposalSummary {
  proposalId: string;
  shareId: string;
  proposedByEmail: string | null;
  createdAtMs: number;
  ops: number;
}

// A proposal as its own sender sees it: the states behind "sent", "accepted"
// and "declined". The recipient gets a count, not the granter's review view.
export interface SentShareProposal {
  proposalId: string;
  state: ShareProposalState;
  createdAtMs: number;
  settledAtMs: number | null;
  ops: number;
}

// What a settle or a withdraw left behind. The state is read back rather than
// assumed: a decision that raced another one answers with the state that won.
export interface ShareProposalSettlement {
  proposalId: string;
  state: ShareProposalState;
}
// A Notice sent to a person lives in that person's notice list on the relay,
// so it reaches every computer they sign in on. The relay derives who sent
// it, what kind of sender it shows, and the sender's name. `recipients` says
// who a kind may be sent to: "self" kinds describe the sender's own work, and
// "readers" kinds may go to anyone who can read the notice's target path.
export type NoticeSenderKind = "person" | "agent" | "automation";

export const NOTICE_KINDS = {
  mention: { senderKind: "person", recipients: "self" },
  "agent-run": { senderKind: "agent", recipients: "self" },
  "schedule-skipped": { senderKind: "automation", recipients: "self" },
  "automation-failed": { senderKind: "automation", recipients: "readers" },
  "automation-notify": { senderKind: "automation", recipients: "readers" },
} as const satisfies Record<string, {
  senderKind: NoticeSenderKind;
  recipients: "self" | "readers";
}>;

export type NoticeKind = keyof typeof NOTICE_KINDS;

// Lengths count code points, as a person counts characters.
export const NOTICE_TITLE_MAX_CHARS = 120;
export const NOTICE_BODY_MAX_CHARS = 500;
// The relay's display-name limit for a sender.
export const NOTICE_SENDER_LABEL_MAX_CHARS = 40;
// The target as JSON, in UTF-8 bytes.
const NOTICE_TARGET_MAX_BYTES = 2_048;
export const NOTICE_TARGET_FIELD_MAX_CHARS = 1_024;
// The id a sender posts.
export const NOTICE_POSTED_ID_MAX_CHARS = 256;
// The id the relay stores and serves. A notice from another person is
// stored as `from:<sender user id, percent-encoded>:<posted id>`, so no
// sender can take an id that another sender, or the recipient, will use.
export const NOTICE_ID_MAX_CHARS = 1_024;
export const NOTICE_FROM_PREFIX = "from:";
export const NOTICE_MARKS_PER_REQUEST = 100;
export const NOTICE_PAGE_MAX = 200;

// A person's notice list keeps at most this many rows. A new notice past it
// removes read and dismissed rows first, oldest first, then the oldest unread.
export const NOTICE_LIST_ROW_LIMIT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// How long a row stays after it arrives unread, after it is read, and after
// it is dismissed. A dismissed row stays as a tombstone so a computer that
// was away still learns of the dismissal.
export const NOTICE_UNREAD_RETENTION_MS = 180 * DAY_MS;
export const NOTICE_READ_RETENTION_MS = 90 * DAY_MS;
export const NOTICE_DISMISSED_RETENTION_MS = 30 * DAY_MS;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
// A body may carry tabs and line feeds, and no other control character.
const BODY_CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

// A non-empty, trimmed line of at most `maxChars` code points with no
// control characters. Titles, ids, labels, and target fields are lines.
export function isNoticeLine(value: unknown, maxChars: number): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    !CONTROL_CHARS.test(value) && [...value].length <= maxChars;
}

export function isNoticeBody(value: unknown): value is string {
  return typeof value === "string" && !BODY_CONTROL_CHARS.test(value) &&
    [...value].length <= NOTICE_BODY_MAX_CHARS;
}

// What a notice points at. Every field is optional; a notice for someone
// other than its sender must name a path both of them can read.
export interface NoticeTarget {
  path?: string;
  record?: string;
  thread?: string;
  message?: string;
  share?: string;
  automation?: string;
  run?: string;
}

const NOTICE_TARGET_FIELDS = [
  "path", "record", "thread", "message", "share", "automation", "run",
] as const satisfies readonly (keyof NoticeTarget)[];

export function isNoticeTarget(value: unknown): value is NoticeTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([field, fieldValue]) =>
    (NOTICE_TARGET_FIELDS as readonly string[]).includes(field) &&
    isNoticeLine(fieldValue, NOTICE_TARGET_FIELD_MAX_CHARS)) &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= NOTICE_TARGET_MAX_BYTES;
}

// How the sender reaches the notice's workspace: the owner names the
// workspace, and a person it was shared with names the share. The relay
// derives the workspace from a share and never serves a grantee the owner's
// workspace id.
export type NoticeReach =
  | { workspaceId: string; shareId?: undefined }
  | { shareId: string; workspaceId?: undefined };

// POST /sync/notices. A second post of the same `noticeId` for the same
// recipient changes nothing, so two computers of one sender post one notice.
// Posting to yourself always works. A notice for another person needs a
// "readers" kind and a `target.path` both people can read, and only the
// workspace owner or a person the work was shared with by name can send one.
export type PostNoticeRequest = NoticeReach & {
  noticeId: string;
  recipientUserId: string;
  kind: NoticeKind;
  title: string;
  body: string;
  target: NoticeTarget;
  // The computer that posted. It names where a notice started and grants
  // nothing: an action a notice offers, such as Try again on a failed
  // automation, must check that the notice's sender is the person acting,
  // never this value.
  originInstallId: string;
};

// One row of GET /sync/notices?cursor=<nextCursor>. `changeSeq` rises on every
// change to the row, including read and dismissed, and counts per person.
export interface RelayNotice {
  noticeId: string;
  changeSeq: number;
  // Exactly one of these is set. `workspaceId` is the workspace when the
  // recipient owns it or named it in its own post. `recipientShareId` is the
  // share through which the recipient reads the notice's target.
  workspaceId: string | null;
  recipientShareId: string | null;
  kind: NoticeKind;
  senderKind: NoticeSenderKind;
  senderUserId: string;
  senderLabel: string;
  title: string;
  body: string;
  // Null once the recipient can no longer read what the notice pointed at.
  target: NoticeTarget | null;
  originInstallId: string;
  createdAtMs: number;
  readAtMs: number | null;
  dismissedAtMs: number | null;
  // The relay removed the row to make room in the list. Drop it; its body
  // and target are gone.
  removed: boolean;
}

export interface RelayNoticePage {
  notices: RelayNotice[];
  // Opaque. Pass it back as `cursor` for the changes after this page; no
  // cursor asks for the whole list.
  nextCursor: string;
  hasMore: boolean;
  // The page starts the list over, because the cursor is older than the
  // relay keeps removed rows or came from another relay history. Drop every
  // cached row, keep your own waiting posts and marks, and take this page
  // and the pages after it as the whole list.
  replace: boolean;
}

// POST /sync/notices/marks. Read and dismissed are one-way: marking a row
// again, or a row the relay no longer holds, changes nothing.
export type NoticeMark = "read" | "dismissed";
