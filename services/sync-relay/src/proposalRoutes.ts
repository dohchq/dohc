import { jsonResponse } from "@dohc/service-http";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import { stableJsonStringify } from "./canonicalJson";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import { parseString, readJsonObject } from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import {
  filterProposedChangeForShare,
  targetVersionId,
  type ShareSelector,
} from "./shareFilter";
import {
  destinationPath,
  proposalMomentPayload,
  PROPOSAL_ORIGIN_PREFIX,
} from "./shareProposals";
import {
  SyncRelayBlobMissingError,
  type ObjectMomentRow,
  type ShareProposalOpRow,
  type SyncRelayLogInput,
  type SyncRelayStorage,
} from "./storage";

export type ShareProposalRoute =
  // The recipient's half of the proposal lane is share-scoped; the
  // granter's half is WORKSPACE-scoped, so its authorization is the one
  // ownership line every owner route already sits behind rather than a new
  // per-route check. A recipient cannot even address it: a received share
  // summary deliberately omits the workspace id.
  | { route: "share-proposals"; shareId: string }
  | { route: "share-proposal-withdraw"; shareId: string; proposalId: string };

export type WorkspaceProposalRoute =
  | { route: "workspace-proposals"; workspaceId: string }
  // One proposal, with its file rows. The listing above carries counts only,
  // so opening a review reads the proposal the granter opened rather than
  // every open proposal in the workspace.
  | { route: "workspace-proposal"; workspaceId: string; proposalId: string }
  // One op of one proposal. The review lists metadata and loads a file's
  // content only when the granter opens that file, so this route answers the
  // opening — without re-serving every op of every open proposal to do it.
  | {
      route: "workspace-proposal-op";
      workspaceId: string;
      proposalId: string;
      opIndex: number;
    }
  | {
      route: "workspace-proposal-settle";
      workspaceId: string;
      proposalId: string;
      decision: "accept" | "decline";
    };

// A submit's idempotency key is the client's own string, not a
// share id; it takes the same length because both are one opaque identifier,
// and its own name so the bound says what it bounds.
const MAX_SUBMIT_ID_CHARS = 128;

export function createProposalRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "objectMoment"
    | "objectIdAtPathInVersion"
    | "missingBlobs"
    | "insertShareProposal"
    | "listShareProposalsForShare"
    | "getShareProposal"
    | "settleShareProposal"
    | "listShareProposalsForWorkspace"
    | "maxOriginSeq"
    | "appendLogBatch"
    | "workspaceIsOwnedBy"
    | "settleShareProposalInTransaction"
    | "findChannelCreateKind"
  >,
  nowMs: () => number,
  newId: () => string,
  lookupUserEmail: ((userId: string) => Promise<string | null> | string | null) | undefined,
  claimPendingShares: (userId: string) => Promise<void>,
  requireShareAction: {
    (shareId: string, actorUserId: string, action: "propose"): AuthorizedShareAction<ShareSelector>;
    (
      shareId: string,
      actorUserId: string,
      action: "list-own-proposals" | "withdraw-proposal",
    ): AuthorizedShareAction;
  },
  shareActionGuard: (
    shareId: string,
    actorUserId: string,
    action: "propose",
    workspaceId: string,
  ) => () => void,
  discussionActivity: Pick<DiscussionActivityHub, "wakeLog">,
) {
  // Whether a recipient may propose changes to the files this
  // selector shares. Edit and nothing else — and the refusal is the same
  // `relayError("share_read_only")` code and body a comment or a view share gets on the
  // append route, because a level-specific refusal would tell a probing
  // recipient the selector's level. Changes follow PATHS, so a version share
  // (no paths) proposes nothing at any level.
  // The granter's own facts for one proposed change, in the one
  // version the proposal was submitted against: which file it is, where that
  // file is now, and the moment that produced the content the recipient
  // started from.
  //
  // One place, because the review listing and the accept door must agree.
  // The listing tells the granter "this file changed since they sent it";
  // accept is what turns that into a conflict with a real three-way base. Two
  // copies of this resolution could disagree, and the granter would be told
  // one thing and given another.
  const proposalBase = (
    workspaceId: string,
    versionId: string,
    op: ShareProposalOpRow,
  ): { head: ObjectMomentRow | null; base: ObjectMomentRow | null } => {
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
  };

  // One op as the granter's review reads it. Shared by the listing and by the
  // single-op route, so a row and the file it opens can never disagree about
  // where a change lands or whether it drifted.
  //
  // It states no content, only where the content is: the review lists
  // thousands of these and loads a file's text only when the granter opens
  // that file.
  const reviewOpRow = (workspaceId: string, versionId: string, op: ShareProposalOpRow) => {
    const resolved = proposalBase(workspaceId, versionId, op);
    return {
      opIndex: op.opIndex,
      basedOnPath: op.basedOnPath,
      operation: op.operation,
      // WHERE accepting will put it, resolved by the same rule the accept
      // door uses. The review must name the path the write will use: a
      // content-only change lands at the granter's current path, so showing
      // the recipient's path would tell the granter one thing and do another.
      afterPath: destinationPath(op, {
        currentPath: resolved.head?.path ?? null,
        base: resolved.base,
      }),
      afterBlobSha256: op.afterBlobSha256,
      afterContentKind: op.afterContentKind,
      // How big the incoming side is, so a row can say so before anyone pays
      // to fetch it.
      afterByteLength: op.afterByteLength,
      currentPath: resolved.head?.path ?? null,
      // What the review surface says out loud: this file changed since they
      // sent it. Read from the granter's own head IN THE VERSION this share
      // exposes, never from anything the recipient claimed.
      drifted:
        op.basedOnBlobSha256 !== null &&
        (resolved.head?.blobSha256 ?? null) !== op.basedOnBlobSha256,
    };
  };

  const respondToShareProposals = async (
    request: Request,
    route: ShareProposalRoute,
    actorUserId: string,
  ): Promise<Response> => {
    // The proposal lane's front door. The gauntlet mirrors the
    // share-log POST above stage for stage, and the two routes stay
    // separate on purpose: one route with two destinations is the
    // conflation that let a recipient's file moments reach the granter's log
    // in the first place (fixed by PR3-0). Nothing here can append, and
    // nothing on the append route can propose.
    if (route.route === "share-proposals" && request.method === "POST") {
      await claimPendingShares(actorUserId);
      const authorized = requireShareAction(route.shareId, actorUserId, "propose");
      const share = { ...authorized.share, selector: authorized.effectiveSelector };
      const input = await readJsonObject(request);
      const submitId = parseString(input.submitId, "submitId", MAX_SUBMIT_ID_CHARS);
      if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
      if (input.ops.length === 0) throw badRequest("ops must not be empty");
      if (input.ops.length > MAX_SHARE_PROPOSAL_OPS) {
        throw badRequest(
          `this submit carries ${input.ops.length} changes; the limit is ` +
            `${MAX_SHARE_PROPOSAL_OPS} changes per submit. Send the rest in the next submit`,
        );
      }
      const ops: ShareProposalOpRow[] = [];
      // One net change per file, proven here rather than trusted. The
      // recipient consolidates before it submits — it knows its own object
      // ids — but a proposal carrying two changes for one file would give
      // both the same base and make them conflict with each other at accept.
      // So the relay refuses the shape instead of relying on the client to
      // avoid it.
      //
      // One set of every path any change touches, not one set per side: a
      // delete of `docs/a.md` beside a create of `docs/a.md` is two changes
      // for one file, and a set per side would hold one path each and admit
      // the pair. Compared across changes, never within one — a change that
      // edits a file in place names the same path on both sides.
      const touchedPaths = new Set<string>();
      const referencedShas = new Set<string>();
      for (const [index, raw] of (input.ops as unknown[]).entries()) {
        const decision = filterProposedChangeForShare(share.selector, raw, {
          channelKind: (wireId) => storage.findChannelCreateKind(share.workspaceId, wireId),
        });
        if (!decision.allowed) throw relayError("share_op_rejected");
        const change = decision.change;
        const paths = new Set(
          [change.basedOnPath, change.afterPath].filter(
            (path): path is string => path !== null,
          ),
        );
        for (const path of paths) {
          if (touchedPaths.has(path)) throw relayError("share_op_rejected");
        }
        for (const path of paths) touchedPaths.add(path);
        // Which file the change is built on, resolved here rather than at
        // accept. The path is where the granter had the file when the
        // recipient read it, and a path is not an identity: a rename between
        // submit and accept moves it to another file, and a delete leaves it
        // naming none — which accept would then mint as a create, putting
        // back a file the granter removed. The object id does not move, so
        // the relay resolves it while the file is provably there and accept
        // follows what it stored.
        let basedOnObjectId: string | null = null;
        if (change.basedOnPath !== null) {
          basedOnObjectId =
            storage.objectIdAtPathInVersion({
              workspaceId: share.workspaceId,
              versionId: targetVersionId(share.selector),
              path: change.basedOnPath,
            }) ?? null;
          if (basedOnObjectId === null) {
            // Atomic, like every other refusal on this route: one
            // unresolvable base refuses the whole submit rather than
            // dropping one change out of an intent the recipient stated as
            // a unit. It names the file because the recipient chose it.
            throw badRequest(
              `no file is shared at ${change.basedOnPath} any more, so this change ` +
                `has nothing to build on; refresh the share and send again`,
            );
          }
        }
        if (change.afterBlobSha256 !== null) referencedShas.add(change.afterBlobSha256);
        ops.push({ opIndex: index, basedOnObjectId, ...change });
      }
      // The same data-integrity gate appendLogBatch applies, run at SUBMIT
      // so a recipient learns its blob is missing while it can still
      // re-upload — rather than at accept, where the granter would meet a
      // failure it did not cause.
      if (referencedShas.size > 0) {
        const missing = storage.missingBlobs(share.workspaceId, [...referencedShas]);
        if (missing.length > 0) {
          throw new SyncRelayBlobMissingError(
            `this submit references ${missing.length} blob(s) not stored on the relay ` +
              `(first: ${missing[0]}); (re-)upload the blob(s) and retry`,
          );
        }
      }
      const result = storage.insertShareProposal({
        proposalId: newId(),
        shareId: share.shareId,
        workspaceId: share.workspaceId,
        // SERVER-derived. The body never states who proposed anything.
        proposedByUserId: actorUserId,
        // PINNED from the selector the recipient just proved against,
        // through the same rule the read filter serves ops by, so a
        // selector edited between submit and accept cannot move these
        // changes onto a version their author never read.
        versionId: targetVersionId(share.selector),
        submitId,
        createdAtMs: nowMs(),
        ops,
        // The revoke race, closed exactly as the append route closes it: the
        // full gauntlet re-runs inside the write's own BEGIN IMMEDIATE, so a
        // revoke or a level narrowed mid-flight loses.
        guard: shareActionGuard(
          route.shareId,
          actorUserId,
          "propose",
          share.workspaceId,
        ),
      });
      return jsonResponse({
        ok: true,
        proposalId: result.proposalId,
        state: "open",
        ops: ops.length,
        created: result.created,
      });
    }

    // Not level-gated, for the reason withdraw is not: a recipient must be
    // able to see the changes it can still take back after a downgrade. A
    // level that never submitted anything reads an empty list, which is the
    // same answer every level with nothing open gives.
    if (route.route === "share-proposals" && request.method === "GET") {
      await claimPendingShares(actorUserId);
      const authorized = requireShareAction(
        route.shareId,
        actorUserId,
        "list-own-proposals",
      );
      const share = authorized.share;
      return jsonResponse({
        ok: true,
        proposals: storage.listShareProposalsForShare(share.shareId).map((proposal) => ({
          proposalId: proposal.proposalId,
          state: proposal.state,
          createdAtMs: proposal.createdAtMs,
          settledAtMs: proposal.settledAtMs,
          ops: proposal.opCount,
        })),
      });
    }
    if (route.route === "share-proposals") throw relayError("method_not_allowed");

    // The reverse path submitting owes (`AGENTS.md`): a recipient can take
    // its changes back while they are still open.
    //
    // Deliberately not gated on the level. A downgrade from edit to comment
    // stops new submits, and a reverse path that a downgrade removes is not
    // a reverse path — it would strand the recipient's already-sent changes
    // in front of a granter who may never answer them. Membership is still
    // proven (`authorizeShareAction`), and the proposal must be this share's
    // and this person's.
    if (route.route === "share-proposal-withdraw" && request.method === "POST") {
      await claimPendingShares(actorUserId);
      const authorized = requireShareAction(
        route.shareId,
        actorUserId,
        "withdraw-proposal",
      );
      const share = authorized.share;
      const proposal = storage.getShareProposal(route.proposalId);
      // A proposal of another share is the same generic 404 as one that
      // never existed — and that is also what makes it this person's:
      // `authorizeShareAction` proved the caller is this share's recipient, and
      // a path share has exactly one.
      if (!proposal || proposal.shareId !== share.shareId) throw notFound();
      if (!storage.settleShareProposal(route.proposalId, "withdrawn", nowMs())) {
        throw relayError("conflict", "these changes were already accepted, declined, or withdrawn");
      }
      return jsonResponse({ ok: true, proposalId: route.proposalId, state: "withdrawn" });
    }
    throw relayError("method_not_allowed");
  };

  const respondToWorkspaceProposals = async (
    request: Request,
    route: WorkspaceProposalRoute,
    actorUserId: string,
  ): Promise<Response> => {
    // What the granter still has to answer, and nothing else: this route
    // serves open proposals only, so it states no `state` and no
    // `settledAtMs` — both would be constants. A settled proposal is
    // history, and this surface asks one question.
    // A summary, because this is what a timer polls. The review surface
    // renders a sender and a count from it; it does not draw files until a
    // granter opens one. Serving every op of every open proposal here
    // resolved a base per op on every tick to build rows nobody read.
    //
    // Who sent them is resolved here from the server-derived user id on the
    // proposal row. The granter's client used to rebuild this by fetching
    // its whole share list and matching share ids — a second request per
    // review, and wrong the moment a share has more than one recipient.
    if (route.route === "workspace-proposals" && request.method === "GET") {
      const rows = await Promise.all(
        storage.listShareProposalsForWorkspace(route.workspaceId).map(async (proposal) => ({
          proposalId: proposal.proposalId,
          shareId: proposal.shareId,
          proposedByEmail: lookupUserEmail
            ? await lookupUserEmail(proposal.proposedByUserId)
            : null,
          createdAtMs: proposal.createdAtMs,
          ops: proposal.opCount,
        })),
      );
      return jsonResponse({ ok: true, proposals: rows });
    }
    if (route.route === "workspace-proposals") throw relayError("method_not_allowed");

    // One proposal's file rows, for the review a granter opened. Still no
    // content: the rows say where each change lands and whether it drifted,
    // and a file's text arrives through the op route below.
    if (route.route === "workspace-proposal" && request.method === "GET") {
      const proposal = storage.getShareProposal(route.proposalId);
      if (!proposal || proposal.workspaceId !== route.workspaceId) throw notFound();
      if (proposal.state !== "open") throw notFound();
      return jsonResponse({
        ok: true,
        proposal: {
          proposalId: proposal.proposalId,
          shareId: proposal.shareId,
          proposedByEmail: lookupUserEmail
            ? await lookupUserEmail(proposal.proposedByUserId)
            : null,
          createdAtMs: proposal.createdAtMs,
          ops: proposal.ops.map((op) =>
            reviewOpRow(route.workspaceId, proposal.versionId, op),
          ),
        },
      });
    }
    if (route.route === "workspace-proposal") throw relayError("method_not_allowed");

    // One op, for the review that opened one file. Same resolution as the
    // listing above, so the row a granter expands states exactly what the
    // row it clicked stated.
    if (route.route === "workspace-proposal-op" && request.method === "GET") {
      const proposal = storage.getShareProposal(route.proposalId);
      if (!proposal || proposal.workspaceId !== route.workspaceId) throw notFound();
      // Settled proposals are history. The review answers one question, and
      // that question closes when the proposal leaves `open`.
      if (proposal.state !== "open") throw notFound();
      const op = proposal.ops.find((candidate) => candidate.opIndex === route.opIndex);
      if (!op) throw notFound();
      return jsonResponse({
        ok: true,
        op: reviewOpRow(route.workspaceId, proposal.versionId, op),
      });
    }
    if (route.route === "workspace-proposal-op") throw relayError("method_not_allowed");

    if (route.route === "workspace-proposal-settle" && request.method === "POST") {
      const proposal = storage.getShareProposal(route.proposalId);
      // A proposal of another workspace is the same generic 404 the relay
      // gives for one that never existed.
      if (!proposal || proposal.workspaceId !== route.workspaceId) throw notFound();
      if (proposal.state !== "open") throw relayError("conflict", "these changes were already accepted, declined, or withdrawn");
      if (route.decision === "decline") {
        // Decline never moves the changes. They stay marked declined and are
        // swept with the share; the recipient's own copy still has them.
        if (!storage.settleShareProposal(route.proposalId, "declined", nowMs())) {
          throw relayError("conflict", "these changes were already accepted, declined, or withdrawn");
        }
        return jsonResponse({ ok: true, proposalId: route.proposalId, state: "declined" });
      }
      const proposerEmail = lookupUserEmail
        ? await lookupUserEmail(proposal.proposedByUserId)
        : null;
      // Provenance that survives into the granter's History. A moment cannot
      // name a human author, so this line is what History shows and the
      // proposal record is the real provenance.
      const summary = proposerEmail ? `Accepted changes from ${proposerEmail}` : null;
      const versionId = proposal.versionId;
      // This proposal's own origin stream, never the recipient's push
      // origin. The recipient numbers its own stream densely from its own
      // journal, so ops the relay inserted there would take sequence
      // numbers the recipient's next push claims — and `appendLogBatch`
      // refuses a re-used sequence with different content, permanently. One
      // accept would wedge the recipient's chat for the life of the share.
      // A fresh origin per proposal cannot collide with anything: nothing
      // else ever writes it.
      const originId = `share:${proposal.shareId}:${PROPOSAL_ORIGIN_PREFIX}${route.proposalId}`;
      // The relay assigns the coordinates, because a proposal's ops carry
      // none: they were never a log. A concurrent accept that took the same
      // numbers loses on appendLogBatch's own dense-sequence check.
      let originSeq = storage.maxOriginSeq(route.workspaceId, originId);
      const logOps: SyncRelayLogInput[] = [];
      for (const op of proposal.ops) {
        const resolved = proposalBase(route.workspaceId, versionId, op);
        const built = proposalMomentPayload(op, {
          versionId,
          // A file the granter does not have gets a new object id, minted
          // here. The recipient's own id names nothing in this workspace.
          objectId: op.basedOnObjectId ?? newId(),
          objectCreatedAtMs: op.recordedAtMs,
          base: resolved.base,
          currentPath: resolved.head?.path ?? null,
          momentId: newId(),
          summary,
        });
        if (!built.ok) throw badRequest(built.reason);
        originSeq += 1;
        logOps.push({
          originSeq,
          opKind: "moment.append",
          payloadJson: stableJsonStringify(built.payload),
          recordedAtMs: op.recordedAtMs,
        });
      }
      const result = storage.appendLogBatch({
        workspaceId: route.workspaceId,
        // The same share-namespaced origin the chat path already writes, so
        // accepted changes reach the granter over the owner lane the relay
        // already runs. Nothing new applies them.
        originId,
        ops: logOps,
        // The settle rides inside the release's own transaction: the changes
        // enter the log and the proposal leaves `open` together, or neither
        // happens. A second accept finds the row already moved and its whole
        // batch rolls back.
        guard: () => {
          if (!storage.workspaceIsOwnedBy(route.workspaceId, actorUserId)) throw notFound();
          if (
            !storage.settleShareProposalInTransaction(route.proposalId, "accepted", nowMs())
          ) {
            throw relayError("conflict", "these changes were already accepted, declined, or withdrawn");
          }
        },
      });
      if (result.inserted > 0) {
        discussionActivity.wakeLog(route.workspaceId);
      }
      return jsonResponse({
        ok: true,
        proposalId: route.proposalId,
        state: "accepted",
        inserted: result.inserted,
      });
    }
    throw relayError("method_not_allowed");
  };

  return { respondToShareProposals, respondToWorkspaceProposals };
}
