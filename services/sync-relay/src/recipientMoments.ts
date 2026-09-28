import type { ObjectMomentRow, ShareProposalOpRow, SyncRelayStorage } from "./storage";

// How a recipient's change becomes one of the granter's own moments. Two
// lanes use it: an accepted proposal, and a direct write to a Collection's
// own files, which the relay mints at once under a named author.
//
// A recipient states a NET CHANGE, never a moment: the served moment drops
// `momentId`, `objectId` and every `before*` field (`shareFilter.ts`), so a
// recipient never learns a granter moment id and could not state a lineage the
// granter recognizes. This module is where the relay turns the change into one
// of the granter's OWN moments, built from facts the granter's log already
// holds.
//
// The rewrite is what makes accept free. The granter's engine decides "does
// this moment's base match my head?" by comparing its snapshot's
// `latest_moment_id` against the payload's `beforeLatestMomentId`
// (`crates/dohc-engine-sync/src/moment_apply.rs`, `head_fast_forward`). A
// mismatch is not an error — apply falls through to the conflict branch and
// opens a durable conflict row. So:
//
//   - the recipient was current -> the base IS the object's head -> clean
//     apply, no conflict;
//   - the file drifted -> the base is a real, older granter moment -> one
//     conflict with a correct three-way base, resolved in the conflict UI that
//     already exists;
//   - the base resolves to no moment -> the payload states `beforePresent:
//     "null"`, which fast-forwards only onto an object the granter does not
//     have. A file the granter does have therefore opens a conflict instead of
//     being silently overwritten by a change with no stated base.
//
// No new merge code, no new arbitration.

export interface ProposalMomentContext {
  // The one version the share exposes, from the selector.
  versionId: string;
  // The GRANTER's object id, or a freshly minted one for a file the recipient
  // created. Never the recipient's: its object ids name nothing here.
  objectId: string;
  objectCreatedAtMs: number;
  // The granter's own moment that produced the content the recipient started
  // from, or null when the base cannot be resolved.
  base: ObjectMomentRow | null;
  // Where the granter has this object right now, or null when it has it
  // nowhere. Decides `rename` against `write`.
  currentPath: string | null;
  // Minted by the relay. A recipient-supplied id could name a moment the
  // granter already holds.
  momentId: string;
  // Provenance that survives into the granter's History. An accepted
  // proposal names its sender here, and the proposal record is the real
  // record.
  summary: string | null;
  // The named recipient or Edit link of a direct write, which only the
  // relay's collection-file origin may carry. Null for an accepted proposal.
  author: DirectWriteMomentAuthor | null;
}

// A share recipient named by the relay: an opaque user id and the grant and
// generation that authorized the write, never an email.
export interface NamedMomentAuthor {
  kind: "named";
  userId: string;
  grantId: string;
  grantGeneration: number;
}

// An Edit share link named by the relay: the link's grant and generation,
// and the server-minted principal that tells its browser sessions apart.
// Never a person, and never a name the holder claimed.
export interface LinkMomentAuthor {
  kind: "link";
  grantId: string;
  grantGeneration: number;
  principalId: string;
}

export type DirectWriteMomentAuthor = NamedMomentAuthor | LinkMomentAuthor;

export type ProposalMomentResult =
  | { ok: true; payload: Record<string, unknown>; blobSha256: string }
  | { ok: false; reason: string };

// Whether the recipient moved the file, as opposed to editing it where it
// found it. Stating the same path on both sides is stating no opinion about
// where the file lives.
function recipientMoved(op: ShareProposalOpRow): boolean {
  return (
    op.basedOnPath !== null && op.afterPath !== null && op.basedOnPath !== op.afterPath
  );
}

// WHERE the change lands.
//
// Decided by what the recipient expressed, never by the path it happened to
// read. A recipient that edited a file in place said nothing about its
// location, so if the granter moved the file since, the content belongs at
// the granter's current path: a deliberate rename must survive an accepted
// content edit, and naming the recipient's stale path would silently undo it.
//
// A recipient that moved the file said exactly that, and it applies. If the
// granter moved it somewhere else meanwhile, the review already shows the
// drift and the granter accepts knowing it.
//
// A delete lands where the granter has the file now, for the same reason.
export function destinationPath(
  op: ShareProposalOpRow,
  context: { currentPath: string | null; base?: { path: string | null } | null },
): string | null {
  if (op.operation === "delete") return context.currentPath ?? context.base?.path ?? null;
  if (recipientMoved(op)) return op.afterPath;
  return context.currentPath ?? op.afterPath;
}

// The operation a moment records, derived from where the granter has the file
// and where the change puts it. The domain derives it the same way when it
// builds a compensating moment (`crates/dohc-engine-domain/src/store/rollback.rs`):
// gone is a delete, moved is a rename, and anything else is a write.
function derivedOperation(
  op: ShareProposalOpRow,
  destination: string | null,
  currentPath: string | null,
): "write" | "rename" | "delete" {
  if (op.operation === "delete") return "delete";
  if (currentPath !== null && destination !== currentPath) return "rename";
  return "write";
}

// The granter's own facts for one change, in the one version it was made
// against: which file it is, where that file is now, and the moment that
// produced the content the recipient started from.
//
// One place, because the proposal review, the proposal accept, and a direct
// write must agree. The review tells the granter "this file changed since
// they sent it"; accept turns that into a conflict with a real three-way
// base. Two copies of this resolution could disagree.
export function proposalBase(
  storage: Pick<SyncRelayStorage, "objectMoment">,
  workspaceId: string,
  versionId: string,
  op: ShareProposalOpRow,
): { head: ObjectMomentRow | null; base: ObjectMomentRow | null } {
  const objectId = op.basedOnObjectId;
  if (objectId === null) return { head: null, base: null };
  return {
    head: storage.objectMoment({ workspaceId, objectId, versionId }),
    base:
      op.basedOnBlobSha256 === null
        ? null
        : storage.objectMoment({
            workspaceId,
            objectId,
            versionId,
            blobSha256: op.basedOnBlobSha256,
          }),
  };
}

export function proposalMomentPayload(
  op: ShareProposalOpRow,
  context: ProposalMomentContext,
): ProposalMomentResult {
  // A delete removes content the granter holds, and the moment it writes
  // carries that content on both sides — the same shape the domain's own
  // delete emits. Without a resolvable base there is no content to name, so
  // the change cannot be expressed and the accept refuses rather than
  // inventing one.
  const isDelete = op.operation === "delete";
  if (isDelete && (!context.base || !context.base.blobSha256 || !context.base.path)) {
    return { ok: false, reason: "the file this change deletes is no longer in the granter's log" };
  }
  const afterPath = destinationPath(op, context);
  const afterBlobSha256 = isDelete ? context.base!.blobSha256! : op.afterBlobSha256;
  if (!afterPath || !afterBlobSha256) {
    return { ok: false, reason: "the change names no destination" };
  }
  const afterContentKind = isDelete
    ? (context.base!.contentKind ?? "text")
    : (op.afterContentKind ?? "text");
  const afterByteLength = isDelete ? context.base!.byteLength : op.afterByteLength;

  const operation = derivedOperation(op, afterPath, context.currentPath);
  const base = context.base;
  // The change description's source side. Both halves travel together or
  // neither does — apply refuses a half-stated pair outright.
  const beforePath = base?.path ?? null;
  const beforeBlobSha256 = base?.blobSha256 ?? null;
  const statesBefore = beforePath !== null && beforeBlobSha256 !== null;

  const payload: Record<string, unknown> = {
    momentId: context.momentId,
    versionId: context.versionId,
    objectId: context.objectId,
    objectCreatedAtMs: context.objectCreatedAtMs,
    path: afterPath,
    recordedAtMs: op.recordedAtMs,
    operation,
    payloadBeforeBlobSha256: statesBefore ? beforeBlobSha256 : null,
    payloadBeforePath: statesBefore ? beforePath : null,
    payloadAfterBlobSha256: afterBlobSha256,
    payloadAfterPath: afterPath,
    payloadAfterContentKind: afterContentKind,
    ...(afterByteLength !== null ? { payloadAfterByteLength: afterByteLength } : {}),
    metadata: {
      origin: "sync",
      summary: context.summary,
      correlationId: null,
    },
    ...(context.author ? { author: context.author } : {}),
    beforePresent: statesBefore ? "present" : "null",
  };

  if (statesBefore) {
    payload.payloadBeforeContentKind = base!.contentKind ?? "text";
    if (base!.byteLength !== null) payload.payloadBeforeByteLength = base!.byteLength;
    payload.beforeObjectId = context.objectId;
    payload.beforeVersionId = base!.versionId;
    payload.beforePath = beforePath;
    payload.beforeBlobSha256 = beforeBlobSha256;
    payload.beforeContentKind = base!.contentKind ?? "text";
    if (base!.byteLength !== null) payload.beforeByteLength = base!.byteLength;
    payload.beforeUpdatedAtMs = base!.recordedAtMs;
    // The base. Equal to the granter's head when the recipient was current,
    // an older real moment when the file drifted.
    payload.beforeLatestMomentId = base!.momentId;
  }

  return { ok: true, payload, blobSha256: afterBlobSha256 };
}
