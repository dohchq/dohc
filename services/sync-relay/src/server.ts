import { createHash, randomUUID } from "node:crypto";
import { MAX_SHARE_PROPOSAL_OPS } from "@dohc/security-contract/share-proposal-bound";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { stableJsonStringify } from "./canonicalJson";
import {
  PresenceCapacityError,
  PresenceHub,
  presenceScopeKey,
  type PresenceSnapshot,
} from "./presence";
import {
  MAIN_VERSION_ID,
  filterOpForShare,
  filterOpForShareAppend,
  filterProposedChangeForShare,
  isChatChannelSelector,
  parseStoredAnyShareSelectorJson,
  presenceTopicAllowedForShare,
  targetVersionId,
  validateChatChannelShareSelector,
  validateChatShareAccess,
  validateFileShareAccess,
  validateShareSelector,
  type ChatShareChannelKind,
  type ChatShareThreadResolver,
  type ShareSelector,
  type StoredAnyShareSelector,
  type ThreadFileBinding,
} from "./shareFilter";
import {
  SyncRelayBlobMissingError,
  SyncRelayConflictError,
  SyncRelayQuotaExceededError,
  type EnforceWorkspaceIdentityResult,
  type ObjectMomentRow,
  type ShareProposalOpRow,
  type SyncRelayLogInput,
  type SyncRelayShareWithGrantRow,
  type SyncRelayStorage,
} from "./storage";
import {
  authorizeShareAction,
  selectorTargetsBlockedChannel,
  type AuthorizedShareAction,
  type ShareAction,
} from "./shareAuthorization";
import { destinationPath, proposalMomentPayload } from "./shareProposals";
import { RELAY_ERRORS, type RelayErrorCode, type RelayErrorDefinition } from "./errorCodes";
import { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

export { MAX_PAYLOAD_JSON_BYTES } from "./wireLimits";

export type SyncRelayHandler = (request: Request) => Promise<Response>;

export interface CreateSyncRelayHandlerOptions {
  storage: SyncRelayStorage;
  resolveActor: ResolveActor;
  nowMs?: () => number;
  // Share-grant recipient lookup: maps an email to the relay account id, or
  // null when no account matches. Absent means email-addressed grants are
  // unavailable (grants by user id still work).
  resolveUserIdByEmail?: (email: string) => Promise<string | null> | string | null;
  // Display-only reverse lookup for share listings; never used for authz.
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
  newShareId?: () => string;
  newGrantId?: () => string;
  // #646 PR3a: ids the relay MINTS — proposal ids, and the moment and object
  // ids a proposal's accept stamps on the granter's own log. Minted, never
  // taken from the recipient: a recipient-supplied moment id could name a
  // moment the granter already holds. Injectable so tests can pin them.
  newId?: () => string;
  // The EPHEMERAL awareness transport (presence/typing). Injectable so a
  // self-hoster's single relay process shares one hub across requests, and so
  // tests can assert it holds only in-memory state (never a storage row).
  // Absent => a fresh in-memory hub, which is correct for production too.
  presence?: PresenceHub;
}

type SyncRelayRoute =
  | { route: "workspaces" }
  | { route: "blob"; workspaceId: string; sha256: string }
  | { route: "blob-have"; workspaceId: string }
  | { route: "gc"; workspaceId: string }
  | { route: "bootstrap"; workspaceId: string }
  | { route: "epoch"; workspaceId: string }
  | { route: "keys"; workspaceId: string }
  | { route: "log"; workspaceId: string }
  | { route: "log-coordinate"; workspaceId: string; originId: string; originSeq: number }
  | { route: "shares-create"; workspaceId: string }
  | { route: "shares-list" }
  | { route: "share"; shareId: string }
  | { route: "share-revoke"; shareId: string }
  | { route: "share-log"; shareId: string }
  | { route: "share-blob"; shareId: string; sha256: string }
  // #646 PR3a. The recipient's half of the proposal lane is share-scoped; the
  // granter's half is WORKSPACE-scoped, so its authorization is the one
  // ownership line every owner route already sits behind rather than a new
  // per-route check. A recipient cannot even address it: a received share
  // summary deliberately omits the workspace id.
  | { route: "share-proposals"; shareId: string }
  | { route: "share-proposal-withdraw"; shareId: string; proposalId: string }
  | { route: "workspace-proposals"; workspaceId: string }
  // ONE proposal, with its file rows. The listing above carries counts only,
  // so opening a review reads the proposal the granter opened rather than
  // every open proposal in the workspace.
  | { route: "workspace-proposal"; workspaceId: string; proposalId: string }
  // ONE op of one proposal. The review lists metadata and loads a file's
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
    }
  | { route: "presence"; workspaceId: string }
  | { route: "share-presence"; shareId: string };

// Transport cap. The relay never parses content, so it cannot tell a captured
// file from a document body from a Y.Doc payload; it carries the WIDEST engine
// ceiling and lets the Rust sync-apply path enforce the real one by referenced
// kind on hydrate. A blob a peer smuggles under this cap but over its kind's
// ceiling is rejected client-side as a protocol violation.
//
// The widest is now the Y.Doc payload bound, not the 10 MiB document body:
// #549 measured a rich document at MAX_TEXT_BYTES encoding to 14.06 MiB of
// Y.Doc full state, so MAX_YDOC_UPDATE_BYTES is 20 MiB. Under that number a
// document the engine accepts would be refused 413 here, and the base it needs
// could never reach a peer. `the_relay_transport_cap_covers_the_widest_engine_ingest_ceiling`
// (crates/dohc-engine-sync-http/tests/relay_http.rs) reads this line and fails
// if the two drift.
export const MAX_BLOB_BYTES = 20 * 1024 * 1024;
export const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;
// One PAGE of the continuous replication lane, for the two log routes. It is
// not the submit bound: a submit is one user act carrying one intent, and it
// is bounded by what a person changes (MAX_SHARE_PROPOSAL_OPS), not by what a
// page should hold. Raising this one would only lengthen each replication
// stall.
export const MAX_OPS_PER_REQUEST = 500;
export const DEFAULT_LOG_PAGE_SIZE = 100;
export const MAX_LOG_PAGE_SIZE = 500;
// Presence (ephemeral awareness) transport limits.
export const MAX_PRESENCE_TOPIC_CHARS = 1024;
export const MAX_CLIENT_ID_CHARS = 128;
export const MAX_PRESENCE_STATE_BYTES = 8 * 1024;
export const DEFAULT_PRESENCE_HOLD_MS = 25_000;
export const MAX_PRESENCE_HOLD_MS = 30_000;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const MAX_WORKSPACE_ID_CHARS = 256;
const MAX_ORIGIN_ID_CHARS = 256;
const MAX_OP_KIND_CHARS = 128;
const MAX_EMAIL_CHARS = 320;
const MAX_SHARE_ID_CHARS = 128;
// #646 PR3a. A submit's idempotency key is the client's own string, not a
// share id; it takes the same length because both are one opaque identifier,
// and its own name so the bound says what it bounds.
const MAX_SUBMIT_ID_CHARS = 128;
const MAX_IDENTITY_BYTES = 512;

// #646 PR3a. Inside a share's origin namespace (`share:<shareId>:…`), this
// prefix belongs to the relay: it names the stream one accepted proposal
// writes. A recipient's own push may not claim it.
const PROPOSAL_ORIGIN_PREFIX = "proposal:";

// The selector KIND from a stored row, without trusting the rest of it. A
// row can be damaged in every other dimension and still say honestly which
// manager owns it; `undefined` means even that could not be read.
function storedSelectorKind(
  selectorJson: string,
): { selectorKind: "chat-channel" } | Record<string, never> {
  try {
    const parsed: unknown = JSON.parse(selectorJson);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { kind?: unknown }).kind === "chat-channel"
    ) {
      return { selectorKind: "chat-channel" };
    }
  } catch {
    // Unreadable JSON names no kind.
  }
  return {};
}

export function createSyncRelayHandler({
  storage,
  resolveActor,
  nowMs = () => Date.now(),
  resolveUserIdByEmail,
  lookupUserEmail,
  newShareId = () => randomUUID(),
  newGrantId = () => randomUUID(),
  newId = () => randomUUID(),
  presence = new PresenceHub(),
}: CreateSyncRelayHandlerOptions): SyncRelayHandler {
  // Handle a publish (POST) or long-poll (GET) against an already-authorized
  // presence scope. The actor's user id is the SERVER-DERIVED attribution;
  // the client-supplied `state` is opaque display data only. `reauthorize`
  // re-runs the caller's authorization AFTER a long-poll park: a grant revoked
  // while the poll was parked must fail closed on wake, never return a final
  // snapshot for a scope the caller no longer has.
  const respondPresence = async (
    request: Request,
    scopeKey: string,
    userId: string,
    reauthorize?: () => unknown,
  ): Promise<Response> => {
    if (request.method === "POST") {
      const input = await readJsonObject(request);
      const clientId = parseString(input.clientId, "clientId", MAX_CLIENT_ID_CHARS);
      if (input.leave === true) {
        return presenceResponse(presence.leave(scopeKey, userId, clientId, nowMs()));
      }
      assertPresenceStateSize(input.state);
      try {
        return presenceResponse(
          presence.publish(scopeKey, userId, clientId, input.state ?? null, nowMs()),
        );
      } catch (error) {
        throw presenceCapacityAs429(error);
      }
    }
    if (request.method === "GET") {
      const url = new URL(request.url);
      const since = parseCursor(url.searchParams.get("since"));
      const hold = parsePresenceHold(url.searchParams.get("hold"));
      let snapshot: PresenceSnapshot;
      try {
        snapshot = await presence.wait(scopeKey, since, {
          holdMs: hold,
          nowMs: nowMs(),
          signal: request.signal,
          actorId: userId,
        });
      } catch (error) {
        throw presenceCapacityAs429(error);
      }
      // A 25s park is long enough for a revoke to land mid-poll; re-run the
      // route's authorization before returning anything.
      if (reauthorize) await reauthorize();
      return presenceResponse(snapshot);
    }
    throw methodNotAllowed();
  };

  // #646 PR3a: whether a recipient may PROPOSE changes to the files this
  // selector shares. Edit and nothing else — and the refusal is the same
  // `shareNotAppendable()` code and body a comment or a view share gets on the
  // append route, because a level-specific refusal would tell a probing
  // recipient the selector's level. Changes follow PATHS, so a version share
  // (no paths) proposes nothing at any level.
  // #646 PR3a. The granter's own facts for one proposed change, in the ONE
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

  // ONE op as the granter's review reads it. Shared by the listing and by the
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
      // WHERE accepting will put it, resolved by the SAME rule the accept
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

  // MU-C4: the thread→channel resolver the chat share filter scopes by. Backed
  // by the shared workspace's OWN log (earliest chat.thread.create wins), so a
  // member-pushed forgery can never re-bind an existing thread. Memoized per
  // resolver (= per request): the filter asks about the SAME threadId across
  // thread-scoped rows on the hot read path, and the underlying lookup is a log
  // scan. Safe because a resolver never outlives its request and the log it
  // reads is append-only with earliest-binding-wins semantics.
  const chatResolverFor = (workspaceId: string): ChatShareThreadResolver => {
    const threadCache = new Map<string, string | null | undefined>();
    const kindCache = new Map<string, ChatShareChannelKind | null | undefined>();
    const bindingCache = new Map<string, ThreadFileBinding | null | undefined>();
    const pathCache = new Map<string, string | null | undefined>();
    const objectAtPathCache = new Map<string, string | undefined>();
    return {
      channelKind: (channelWireId) => {
        if (kindCache.has(channelWireId)) return kindCache.get(channelWireId);
        const kind = storage.findChannelCreateKind(workspaceId, channelWireId);
        kindCache.set(channelWireId, kind);
        return kind;
      },
      threadChannelWireId: (threadId) => {
        if (threadCache.has(threadId)) return threadCache.get(threadId);
        const bound = storage.findThreadCreateChannelWireId(workspaceId, threadId);
        threadCache.set(threadId, bound);
        return bound;
      },
      // #646 PR2, memoized for the same reason: the file-chat filter asks
      // about the SAME threadId and the SAME objectId across every
      // thread-scoped row of a page.
      threadFileBinding: (threadId) => {
        if (bindingCache.has(threadId)) return bindingCache.get(threadId);
        const bound = storage.findThreadCreateFileBinding(workspaceId, threadId);
        bindingCache.set(threadId, bound);
        return bound;
      },
      objectCurrentPath: (objectId) => {
        if (pathCache.has(objectId)) return pathCache.get(objectId);
        const path = storage.objectCurrentPath(workspaceId, objectId);
        pathCache.set(objectId, path);
        return path;
      },
      objectIdAtPath: (path) => {
        if (objectAtPathCache.has(path)) return objectAtPathCache.get(path);
        const objectId = storage.objectIdAtPath(workspaceId, path);
        objectAtPathCache.set(path, objectId);
        return objectId;
      },
    };
  };

  // Lazy claim of pending email invites (PR 18 gate fix): the first time an
  // invited account authenticates to the relay, any share addressed to its
  // email becomes a real grant (recipient_user_id filled in). The session
  // email is server-derived (never client-supplied), so this cannot be used
  // to claim someone else's invite.
  const claimPendingShares = async (userId: string): Promise<void> => {
    if (!lookupUserEmail) return;
    const email = await lookupUserEmail(userId);
    if (email) storage.claimPendingSharesForEmail(email, userId);
  };

  function requireShareAction(
    shareId: string,
    actorUserId: string,
    action: "propose",
  ): AuthorizedShareAction<ShareSelector>;
  function requireShareAction(
    shareId: string,
    actorUserId: string,
    action: ShareAction,
  ): AuthorizedShareAction;
  function requireShareAction(
    shareId: string,
    actorUserId: string,
    action: ShareAction,
  ): AuthorizedShareAction {
    const result = authorizeShareAction({ storage, actorUserId, shareId, action });
    if (result.ok) return result;
    if (result.reason === "denied" && (action === "append" || action === "propose")) {
      throw shareNotAppendable();
    }
    throw notFound();
  }

  const shareSummary = async (
    row: SyncRelayShareWithGrantRow,
    side: "granted" | "received",
  ): Promise<Record<string, unknown>> => {
    const { share, grant } = row;
    const selector = parseStoredAnyShareSelectorJson(share.selectorJson);
    const base = {
      shareId: share.shareId,
      // An unreadable row says so. It does NOT get a stand-in scope: empty
      // paths with no version would claim the entire live workspace, on a row
      // whose own reads answer 404. The row stays listed because it is the
      // caller's own share and ending it must remain possible — the reverse
      // path is the invariant here, and listing it reveals nothing the
      // caller did not already have.
      selector,
      access: grant.access,
      grantId: grant.grantId,
      generation: grant.generation,
      // The KIND survives the damage when it can be read at all. It is what
      // routes a row to the right manager, and losing it made a damaged
      // chat-channel grant surface in the path/version lists as an unreadable
      // path share. A kind that cannot be read is not invented.
      ...(selector
        ? {}
        : { damaged: true as const, ...storedSelectorKind(share.selectorJson) }),
      createdAtMs: share.createdAtMs,
    };
    if (side === "granted") {
      // A pending invite has no recipient user id yet; surface the addressed
      // email the granter typed. A claimed/real share resolves the email from
      // its recipient id for display.
      const recipientEmail = grant.principalUserId
        ? lookupUserEmail
          ? await lookupUserEmail(grant.principalUserId)
          : null
        : grant.principalEmail;
      return {
        ...base,
        workspaceId: share.workspaceId,
        recipientUserId: grant.principalUserId,
        recipientEmail,
        revokedAtMs: grant.revokedAtMs,
      };
    }
    // Received summaries deliberately omit the workspace id: the recipient's
    // access is share-scoped, and the granter's workspace identity is not
    // theirs to see.
    return {
      ...base,
      granterUserId: share.granterUserId,
      granterEmail: lookupUserEmail ? await lookupUserEmail(share.granterUserId) : null,
    };
  };

  return async (request) => {
    try {
      const route = parseRoute(request);
      const actor = await resolveActor(request, "workspaceId" in route ? route.workspaceId : "");

      if (route.route === "workspaces" && request.method === "POST") {
        const input = await readJsonObject(request);
        const workspaceId = parseWorkspaceId(input.workspaceId);
        // Parse before claimWorkspace mutates storage: a malformed partial
        // identity must not reserve a brand-new workspace row.
        const identity = parseOptionalWorkspaceIdentity(input);
        const result = storage.claimWorkspace({
          workspaceId,
          ownerUserId: actor.userId,
          createdAtMs: nowMs(),
        });
        if (result === "not-owner") throw notFound();
        if (identity !== null) {
          assertWorkspaceIdentityResult(
            storage.claimWorkspaceIdentity({ workspaceId, ...identity }),
          );
        }
        return jsonResponse({ ok: true, workspaceId, created: result === "created" });
      }

      if (route.route === "workspaces") throw methodNotAllowed();

      if (route.route === "shares-list" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const granted = await Promise.all(
          storage.listSharesGrantedBy(actor.userId).map((row) => shareSummary(row, "granted")),
        );
        const receivedRows = await Promise.all(
          storage.listSharesReceivedBy(actor.userId).map(async (row) => ({
            row,
            summary: await shareSummary(row, "received"),
          })),
        );
        // Re-evaluate AFTER the async display-name lookups, immediately before
        // serialization. A pre-provisioned wire that became an agent channel
        // during those awaits must not get one final recipient-list exposure.
        const received = receivedRows.flatMap(({ row, summary }) => {
          const selector = parseStoredAnyShareSelectorJson(row.share.selectorJson);
          return selector && selectorTargetsBlockedChannel(storage, row.share.workspaceId, selector)
            ? []
            : [summary];
        });
        return jsonResponse({ ok: true, granted, received });
      }
      if (route.route === "shares-list") throw methodNotAllowed();

      if (route.route === "share" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "read");
        const summary = await shareSummary(
          { share: authorized.share, grant: authorized.grant },
          "received",
        );
        requireShareAction(route.shareId, actor.userId, "read");
        return jsonResponse({ ok: true, ...summary });
      }
      if (route.route === "share") throw methodNotAllowed();

      if (route.route === "share-revoke" && request.method === "POST") {
        const share = storage.getShare(route.shareId);
        // Only the granter may revoke; anyone else (including the recipient)
        // sees the byte-identical generic 404.
        if (!share || share.granterUserId !== actor.userId) throw notFound();
        storage.revokeShare(route.shareId, nowMs());
        return jsonResponse({ ok: true, shareId: route.shareId });
      }
      if (route.route === "share-revoke") throw methodNotAllowed();

      if (route.route === "share-log" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "read");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        const url = new URL(request.url);
        const channelWireId = url.searchParams.get("channelWireId");
        if (
          channelWireId !== null &&
          (!isChatChannelSelector(share.selector) ||
            share.selector.channelWireId !== channelWireId)
        ) {
          throw notFound();
        }
        const since = parseCursor(url.searchParams.get("since"));
        const limit = parseLimit(url.searchParams.get("limit"));
        const page = storage.fetchLogPage({
          workspaceId: share.workspaceId,
          sinceRelaySeq: since,
          limit,
        });
        // THE share security boundary: each op passes the fail-closed filter
        // or is dropped from the response. The cursor still advances over
        // dropped rows (the recipient sees a sparser page, never a stalled
        // one), and payloads are the filter's (possibly redacted) copy.
        const chatResolver = chatResolverFor(share.workspaceId);
        const ops: Array<Record<string, unknown>> = [];
        for (const row of page.rows) {
          const decision = filterOpForShare(share.selector, row.opKind, row.payloadJson, chatResolver);
          if (!decision.allowed) continue;
          ops.push({
            relaySeq: row.relaySeq,
            originId: row.originId,
            originSeq: row.originSeq,
            opKind: row.opKind,
            payload: decision.payload,
            recordedAtMs: row.recordedAtMs,
          });
        }
        // Re-check revocation immediately before returning the body: a revoke
        // that raced with this in-flight read (after the entry check, while
        // the page was assembled) must abort the response, not leak a final
        // filtered page. Re-loading the share throws the same generic 404.
        requireShareAction(route.shareId, actor.userId, "read");
        return jsonResponse({
          ok: true,
          ops,
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        });
      }

      // MU-C4 member append — the bidirectional extension of the PR-18
      // recipient model, and the first place a non-owner writes into an
      // owner's bucket. Fail-closed gauntlet, in order:
      //   1. authorizeShareAction: membership, grant status, granter standing —
      //      every denial is the same byte-identical generic 404.
      //   2. The selector must accept appends: a read-write chat-channel
      //      grant, or (#646 PR2) a file share at comment or edit. A
      //      read-only member and a VIEW file share are REFUSED with an
      //      explicit 403 — the member legitimately knows the share exists,
      //      so this is a refusal, not a 404 — and with ONE code and one
      //      body, because a level-specific refusal would tell a probing
      //      recipient the selector's level.
      //   3. MU-C0 verified authorship: every authored chat op must claim the
      //      AUTHENTICATED pusher (assertChatAuthorship verifies it) — a
      //      member cannot forge a message or reaction as another member.
      //   4. Every op must pass the SAME fail-closed chat filter that scopes
      //      reads: chat.* only, granted channel only, earliest-thread-binding
      //      honored. One rejected op rejects the WHOLE batch atomically.
      // Accepted ops land in the OWNER's workspace bucket under a
      // share-namespaced origin id, so a member can never extend (or collide
      // with) the owner's — or another member's — origin sequence space; the
      // relay still assigns no cross-origin order.
      // Deliberate R10b boundary: members are not workspace replicas. Their
      // share-namespaced appends are governed by the fail-closed share/channel
      // filter, so workspace epoch enforcement does not apply on this route.
      if (route.route === "share-log" && request.method === "POST") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "append");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        const input = await readJsonObject(request);
        const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
        // #646 PR3a: a share's origin space is shared between the recipient's
        // own pushes and the streams accept mints for its proposals. The
        // recipient names its half; this prefix is the relay's, and a client
        // that claimed it could take sequence numbers out of an accept stream.
        if (originId.startsWith(PROPOSAL_ORIGIN_PREFIX)) {
          throw badRequest(`originId must not start with "${PROPOSAL_ORIGIN_PREFIX}"`);
        }
        if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
        if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
        // Authorship runs before the filter and parseLogOp so neither admits nor
        // freezes a payload whose claimed author is missing or forged (MU-C0).
        assertChatAuthorship(input.ops, actor.userId);
        // Batch-aware channel scoping: a thread created earlier in THIS batch
        // is a valid target for later ops in the same batch (the composer's
        // thread.create + first message.append), but the LOG's earliest
        // binding always wins over the batch — a batch cannot re-bind an
        // existing thread.
        const pendingThreadBindings = new Map<string, string>();
        // #646 PR2: the path sibling of the same rule, for a file share. A
        // recipient's `chat.thread.create` names the granted PATH (its own
        // object ids mean nothing here), and the message it composes with
        // rides in the same batch.
        const pendingThreadFiles = new Map<string, ThreadFileBinding>();
        const resolver: ChatShareThreadResolver = {
          channelKind: (channelWireId) =>
            storage.findChannelCreateKind(share.workspaceId, channelWireId),
          threadChannelWireId: (threadId) => {
            const stored = storage.findThreadCreateChannelWireId(share.workspaceId, threadId);
            return stored !== undefined ? stored : pendingThreadBindings.get(threadId);
          },
          threadFileBinding: (threadId) => {
            const stored = storage.findThreadCreateFileBinding(share.workspaceId, threadId);
            return stored !== undefined ? stored : pendingThreadFiles.get(threadId);
          },
          objectCurrentPath: (objectId) =>
            storage.objectCurrentPath(share.workspaceId, objectId),
          objectIdAtPath: (path) => storage.objectIdAtPath(share.workspaceId, path),
        };
        const ops = input.ops.map(parseLogOp);
        for (const op of ops) {
          // The WRITE filter, never the read one: what a recipient may see is
          // not what it may push into the granter's log (#646 PR3-0).
          const decision = filterOpForShareAppend(
            share.selector,
            op.opKind,
            op.payloadJson,
            resolver,
          );
          if (!decision.allowed) throw shareOpRejected();
          // Persist the filter's (possibly redacted) copy, never the pusher's
          // original bytes: the owner bucket is read back over the UNfiltered
          // owner lane, so any field the filter withholds (e.g. a member
          // attachment's objectId/pathHint) must not survive the append.
          op.payloadJson = JSON.stringify(decision.payload);
          if (op.opKind === "chat.thread.create") {
            // Read back from the SERVED copy assigned above, which carries the
            // path this relay proved — never the pusher's own string.
            const created = JSON.parse(op.payloadJson) as {
              threadId?: unknown;
              linkedPath?: unknown;
            };
            const threadId = created.threadId;
            if (typeof threadId === "string" && threadId.length > 0) {
              if (isChatChannelSelector(share.selector)) {
                pendingThreadBindings.set(threadId, share.selector.channelWireId);
              } else if (
                typeof created.linkedPath === "string" &&
                created.linkedPath.length > 0
              ) {
                // THE ACCEPT DOOR converts the binding (#646 PR2, review).
                //
                // A recipient names its file by path because its own object
                // ids mean nothing here. This is the one moment the relay can
                // turn that into the granter's OWN object id: the filter just
                // proved an object sits at this exact path. Persisting the
                // object id instead of the path is what makes a recipient's
                // thread behave like the granter's — it follows the file
                // through a rename INSIDE the share, and stops at one that
                // leaves it, because both answers come from the same
                // object→path lookup.
                //
                // Rewriting a payload before persisting is what this route
                // already does: the served copy above is a redaction, and the
                // path in it was normalized by the filter.
                const objectId = storage.objectIdAtPath(
                  share.workspaceId,
                  created.linkedPath,
                );
                // The filter admitted this op by proving an object is there,
                // so this is unreachable through the filter's own path. A
                // batch that reaches it is refused whole rather than stored as
                // a thread bound to nothing.
                if (!objectId) throw shareOpRejected();
                const bound: Record<string, unknown> = { ...created };
                delete bound.linkedPath;
                bound.linkedObjectId = objectId;
                op.payloadJson = JSON.stringify(bound);
                pendingThreadFiles.set(threadId, { kind: "object", objectId });
              }
            }
          }
        }
        const result = storage.appendLogBatch({
          workspaceId: share.workspaceId,
          // Namespaced per share (= per member): member origins live in their
          // own corner of the owner bucket's origin space.
          originId: `share:${share.shareId}:${originId}`,
          ops,
          // Close the revoke race COMPLETELY: the share is re-verified inside
          // the append's own BEGIN IMMEDIATE transaction (the same write lock
          // revokeShare takes), so a revoke committed after the entry check
          // above can never slip a write in — the guard sees it and the whole
          // batch rolls back as the same generic 404. The guard re-runs the
          // full appendability gauntlet: recipient-owned, unrevoked, granter
          // in standing, and STILL a selector that accepts appends at its
          // current level (#646) on the same workspace bucket — a level
          // narrowed mid-flight loses the race the same way a revoke does.
          guard: () => {
            const fresh = requireShareAction(route.shareId, actor.userId, "append");
            if (fresh.share.workspaceId !== share.workspaceId) throw notFound();
          },
        });
        return jsonResponse({
          ok: true,
          accepted: ops.length,
          inserted: result.inserted,
          skipped: result.skipped,
          currentMaxOriginSeq: result.currentMaxOriginSeq,
        });
      }
      if (route.route === "share-log") throw methodNotAllowed();

      if (route.route === "share-blob" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "read");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        assertSha256(route.sha256);
        // A blob is served to a recipient ONLY when at least one op that
        // passes the share filter legitimately references it. Everything
        // else — a blob of an unshared file, a secret ciphertext blob, a
        // random hash — is the same generic 404 as a nonexistent share.
        const candidates = storage.listLogRowsReferencing(share.workspaceId, route.sha256);
        const chatResolver = chatResolverFor(share.workspaceId);
        // Chat ops are blob-free (their decisions carry no blobSha256s), so a
        // chat-channel share can never make ANY blob reachable — every blob
        // probe on one is the same generic 404.
        const reachable = candidates.some((row) => {
          const decision = filterOpForShare(share.selector, row.opKind, row.payloadJson, chatResolver);
          return decision.allowed && decision.blobSha256s.includes(route.sha256);
        });
        if (!reachable) throw notFound();
        const blob = storage.getBlob(share.workspaceId, route.sha256);
        if (!blob) throw notFound();
        // Re-check revocation immediately before returning the blob body: a
        // revoke that raced with this in-flight read must abort rather than
        // serve a final shared blob. The re-load throws the same generic 404.
        requireShareAction(route.shareId, actor.userId, "read");
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      // #646 PR3a. A recipient's blob, charged to the GRANTER's workspace.
      // Same level gate as the proposal route, same refusal, so a probe cannot
      // tell the level from the code.
      //
      // It needs no bound of its own. Three already apply and all three are
      // the granter's: MAX_BLOB_BYTES per blob, the granter's workspace quota
      // per workspace (`putBlob` charges it), and the unreferenced-blob sweep,
      // which reclaims anything no OPEN proposal claims. A blob count would
      // bound bytes less tightly than the byte quota that already refuses
      // them.
      if (route.route === "share-blob" && request.method === "PUT") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "propose");
        const share = { ...authorized.share, selector: authorized.effectiveSelector };
        assertSha256(route.sha256);
        const bytes = await readBytes(request, MAX_BLOB_BYTES);
        const actual = sha256Hex(bytes);
        if (actual !== route.sha256) {
          throw badRequest("blob content does not match sha256 path");
        }
        const put = storage.putBlob({
          workspaceId: share.workspaceId,
          sha256: route.sha256,
          content: bytes,
          createdAtMs: nowMs(),
        });
        // Re-check the grant immediately before answering, mirroring the read
        // routes: a revoke that raced this upload aborts rather than
        // confirming a write into the granter's workspace.
        requireShareAction(route.shareId, actor.userId, "propose");
        return jsonResponse({
          ok: true,
          shareId: route.shareId,
          sha256: route.sha256,
          byteLength: put.byteLength,
        });
      }
      if (route.route === "share-blob") throw methodNotAllowed();

      // #646 PR3a — the proposal lane's front door. The gauntlet mirrors the
      // share-log POST above stage for stage, and the two routes stay
      // separate on purpose: one route with two destinations is the
      // conflation that let a recipient's file moments reach the granter's log
      // in the first place (fixed by PR3-0). Nothing here can append, and
      // nothing on the append route can propose.
      if (route.route === "share-proposals" && request.method === "POST") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(route.shareId, actor.userId, "propose");
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
        // ONE net change per file, proven here rather than trusted. The
        // recipient consolidates before it submits — it knows its own object
        // ids — but a proposal carrying two changes for one file would give
        // both the SAME base and make them conflict with each other at accept.
        // So the relay refuses the shape instead of relying on the client to
        // avoid it.
        //
        // ONE set of every path ANY change touches, not one set per side: a
        // delete of `docs/a.md` beside a create of `docs/a.md` is two changes
        // for one file, and a set per side would hold one path each and admit
        // the pair. Compared across changes, never within one — a change that
        // edits a file in place names the same path on both sides.
        const touchedPaths = new Set<string>();
        const referencedShas = new Set<string>();
        for (const [index, raw] of (input.ops as unknown[]).entries()) {
          const decision = filterProposedChangeForShare(share.selector, raw);
          if (!decision.allowed) throw shareOpRejected();
          const change = decision.change;
          const paths = new Set(
            [change.basedOnPath, change.afterPath].filter(
              (path): path is string => path !== null,
            ),
          );
          for (const path of paths) {
            if (touchedPaths.has(path)) throw shareOpRejected();
          }
          for (const path of paths) touchedPaths.add(path);
          // WHICH file the change is built on, resolved HERE rather than at
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
          proposedByUserId: actor.userId,
          // PINNED from the selector the recipient just proved against,
          // through the SAME rule the read filter serves ops by, so a
          // selector edited between submit and accept cannot move these
          // changes onto a version their author never read.
          versionId: targetVersionId(share.selector),
          submitId,
          createdAtMs: nowMs(),
          ops,
          // The revoke race, closed exactly as the append route closes it: the
          // full gauntlet re-runs inside the write's own BEGIN IMMEDIATE, so a
          // revoke or a level narrowed mid-flight loses.
          guard: () => {
            const fresh = requireShareAction(route.shareId, actor.userId, "propose");
            if (fresh.share.workspaceId !== share.workspaceId) throw notFound();
          },
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
      // able to SEE the changes it can still take back after a downgrade. A
      // level that never submitted anything reads an empty list, which is the
      // same answer every level with nothing open gives.
      if (route.route === "share-proposals" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(
          route.shareId,
          actor.userId,
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
      if (route.route === "share-proposals") throw methodNotAllowed();

      // The reverse path submitting owes (`AGENTS.md`): a recipient can take
      // its changes back while they are still open.
      //
      // Deliberately NOT gated on the level. A downgrade from edit to comment
      // stops new submits, and a reverse path that a downgrade removes is not
      // a reverse path — it would strand the recipient's already-sent changes
      // in front of a granter who may never answer them. Membership is still
      // proven (`authorizeShareAction`), and the proposal must be this share's
      // and this person's.
      if (route.route === "share-proposal-withdraw" && request.method === "POST") {
        await claimPendingShares(actor.userId);
        const authorized = requireShareAction(
          route.shareId,
          actor.userId,
          "withdraw-proposal",
        );
        const share = authorized.share;
        const proposal = storage.getShareProposal(route.proposalId);
        // A proposal of another share is the same generic 404 as one that
        // never existed — and that is also what makes it this person's:
        // `authorizeShareAction` proved the caller is THIS share's recipient, and
        // a path share has exactly one.
        if (!proposal || proposal.shareId !== share.shareId) throw notFound();
        if (!storage.settleShareProposal(route.proposalId, "withdrawn", nowMs())) {
          throw proposalNotOpen();
        }
        return jsonResponse({ ok: true, proposalId: route.proposalId, state: "withdrawn" });
      }
      if (route.route === "share-proposal-withdraw") throw methodNotAllowed();

      if (route.route === "share-presence") {
        // Cross-user presence: a recipient joins the ephemeral scope for a
        // topic their grant exposes. The share is loaded FAIL-CLOSED (generic
        // 404 for no-grant / revoked / wrong-recipient), and the topic is
        // gated by the SAME visibility check the durable filter uses, so a
        // non-member can neither read nor even confirm presence for a
        // channel/DM they lack a grant for. The scope key resolves to the
        // granter's workspace, so the owner (workspace route) and recipients
        // fan into ONE scope and see each other.
        await claimPendingShares(actor.userId);
        const topic = parsePresenceTopic(new URL(request.url).searchParams.get("topic"));
        // The share + topic gate, run BEFORE joining AND re-run after a parked
        // long-poll wakes (respondPresence's reauthorize): a revoke that lands
        // while a recipient's poll is parked fails closed on wake instead of
        // leaking one final snapshot. The resolver lets a chat-channel grant
        // admit a `chat:thread:<threadId>` topic for a thread BOUND (earliest
        // binding, forge-resistant) to the granted channel — the same authority
        // the durable chat filter uses; bare wire presence also resolves kind
        // so an owner-only agent channel can never enter a share scope.
        const authorizeShare = () => {
          const authorized = requireShareAction(route.shareId, actor.userId, "presence");
          const chatResolver = chatResolverFor(authorized.share.workspaceId);
          if (
            !presenceTopicAllowedForShare(
              authorized.effectiveSelector,
              topic,
              chatResolver,
            )
          ) {
            throw notFound();
          }
          return { ...authorized.share, selector: authorized.effectiveSelector };
        };
        const share = authorizeShare();
        // `await` is load-bearing: respondPresence can reject long after this
        // frame returns (a parked long-poll), and only an awaited rejection
        // flows through the outer catch into errorResponse.
        return await respondPresence(
          request,
          presenceScopeKey(share.workspaceId, topic),
          actor.userId,
          authorizeShare,
        );
      }

      if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();

      // #646 PR3a — the granter's half. Everything below this line is
      // owner-scoped by the ONE check above, which is why accept and decline
      // live in the workspace namespace rather than the share's: ownership is
      // derived from the workspace, never from the share, so a recipient can
      // never accept its own changes.
      // What the granter still has to answer, and nothing else: this route
      // serves OPEN proposals only, so it states no `state` and no
      // `settledAtMs` — both would be constants. A settled proposal is
      // history, and this surface asks one question.
      // A SUMMARY, because this is what a timer polls. The review surface
      // renders a sender and a count from it; it does not draw files until a
      // granter opens one. Serving every op of every open proposal here
      // resolved a base per op on every tick to build rows nobody read.
      //
      // WHO sent them is resolved here from the server-derived user id on the
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
      if (route.route === "workspace-proposals") throw methodNotAllowed();

      // ONE proposal's file rows, for the review a granter opened. Still no
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
      if (route.route === "workspace-proposal") throw methodNotAllowed();

      // ONE op, for the review that opened one file. Same resolution as the
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
      if (route.route === "workspace-proposal-op") throw methodNotAllowed();

      if (route.route === "workspace-proposal-settle" && request.method === "POST") {
        const proposal = storage.getShareProposal(route.proposalId);
        // A proposal of another workspace is the same generic 404 the relay
        // gives for one that never existed.
        if (!proposal || proposal.workspaceId !== route.workspaceId) throw notFound();
        if (proposal.state !== "open") throw proposalNotOpen();
        if (route.decision === "decline") {
          // Decline never moves the changes. They stay marked declined and are
          // swept with the share; the recipient's own copy still has them.
          if (!storage.settleShareProposal(route.proposalId, "declined", nowMs())) {
            throw proposalNotOpen();
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
        // THIS proposal's own origin stream, never the recipient's push
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
            // A file the granter does not have gets a NEW object id, minted
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
          // The SAME share-namespaced origin the chat path already writes, so
          // accepted changes reach the granter over the owner lane the relay
          // already runs. Nothing new applies them.
          originId,
          ops: logOps,
          // The settle rides INSIDE the release's own transaction: the changes
          // enter the log and the proposal leaves `open` together, or neither
          // happens. A second accept finds the row already moved and its whole
          // batch rolls back.
          guard: () => {
            if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();
            if (
              !storage.settleShareProposalInTransaction(route.proposalId, "accepted", nowMs())
            ) {
              throw proposalNotOpen();
            }
          },
        });
        return jsonResponse({
          ok: true,
          proposalId: route.proposalId,
          state: "accepted",
          inserted: result.inserted,
        });
      }
      if (route.route === "workspace-proposal-settle") throw methodNotAllowed();

      if (route.route === "presence") {
        // The owner's own workspace presence (multi-device co-presence in
        // their local channels/docs, and the owner side of a shared channel).
        // Ownership was proven by the gate above; any topic in the owner's own
        // workspace is theirs to join. Ownership is also re-proven after a
        // parked long-poll wakes, mirroring the share route's posture.
        const topic = parsePresenceTopic(new URL(request.url).searchParams.get("topic"));
        // `await` is load-bearing: see the share-presence route above.
        return await respondPresence(
          request,
          presenceScopeKey(route.workspaceId, topic),
          actor.userId,
          () => {
            if (!storage.workspaceIsOwnedBy(route.workspaceId, actor.userId)) throw notFound();
          },
        );
      }

      if (route.route === "bootstrap" && request.method === "GET") {
        const bootstrap = storage.getWorkspaceBootstrap(route.workspaceId);
        return jsonResponse({
          ok: true,
          hasContent: bootstrap.hasContent,
          replicationEpoch: bootstrap.identity?.replicationEpoch ?? null,
          streamIdentity: bootstrap.identity?.streamIdentity ?? null,
        });
      }
      if (route.route === "bootstrap") throw methodNotAllowed();

      if (route.route === "epoch" && request.method === "POST") {
        const input = await readJsonObject(request);
        const replicationEpoch = parseWorkspaceIdentityValue(
          input.replicationEpoch,
          "replicationEpoch",
        );
        const streamIdentity = parseWorkspaceIdentityValue(
          input.streamIdentity,
          "streamIdentity",
        );
        const result = storage.rotateWorkspaceIdentity({
          workspaceId: route.workspaceId,
          ownerUserId: actor.userId,
          replicationEpoch,
          streamIdentity,
          rotatedAtMs: nowMs(),
        });
        if (result === "not-owner") throw notFound();
        if (result === "epoch-superseded") throw epochSuperseded();
        return jsonResponse({
          ok: true,
          rotated: result === "rotated",
          replicationEpoch,
          streamIdentity,
        });
      }
      if (route.route === "epoch") throw methodNotAllowed();

      if (route.route === "gc" && request.method === "POST") {
        const result = await storage.collectUnreferencedBlobs(route.workspaceId, {
          nowMs: nowMs(),
        });
        return jsonResponse({ ok: true, ...result });
      }
      if (route.route === "gc") throw methodNotAllowed();

      if (route.route === "shares-create" && request.method === "POST") {
        const input = await readJsonObject(request);
        // Two grant kinds share one create surface: a chat-channel grant
        // (MU-C4, addressed by channelWireId + optional access) or the PR-18
        // path/version grant. The recipient addressing, pending-invite, and
        // anti-enumeration behavior below is identical for both.
        const { selector, access } = (() => {
          if (input.channelWireId !== undefined) {
            // Fail closed on an AMBIGUOUS body: a chat-channel selector must not
            // also carry a path/version selector. Silently preferring
            // channelWireId (and dropping the paths) would turn a stale/leftover
            // `paths` field into a full chat-channel grant — a silent intent
            // mismatch. Reject it instead (hardens regular shared-channel grants
            // too).
            if (input.paths !== undefined || input.versionId !== undefined) {
              throw relayHttpError(
                RELAY_ERRORS.ambiguous_selector,
                "a chat-channel share must not also carry paths or versionId",
              );
            }
            const chatValidation = validateChatChannelShareSelector({
              channelWireId: input.channelWireId,
            });
            if (!chatValidation.ok) {
              throw relayHttpError(RELAY_ERRORS[chatValidation.code], chatValidation.message);
            }
            const accessValidation = validateChatShareAccess(input.access);
            if (!accessValidation.ok) {
              throw relayHttpError(
                RELAY_ERRORS[accessValidation.code],
                accessValidation.message,
              );
            }
            const selector = chatValidation.selector;
            if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
              throw relayHttpError(RELAY_ERRORS.invalid_channel, "channel is not shareable");
            }
            const access = accessValidation.access;
            return { selector, access };
          }

          const accessValidation = validateFileShareAccess(input.access);
          if (!accessValidation.ok) {
            throw relayHttpError(
              RELAY_ERRORS[accessValidation.code],
              accessValidation.message,
            );
          }
          const validation = validateShareSelector({
            paths: input.paths,
            versionId: input.versionId,
          });
          if (!validation.ok) {
            throw relayHttpError(RELAY_ERRORS[validation.code], validation.message);
          }
          const selector = validation.selector;
          const access = accessValidation.access;
          return { selector, access };
        })();
        const shareId = newShareId();
        const grantId = newGrantId();
        const createdAtMs = nowMs();

        // Sharing by explicit user id: the granter already knows the id, so
        // there is no account existence to leak — echo it back.
        if (input.recipientUserId !== undefined) {
          const recipientUserId = parseString(
            input.recipientUserId,
            "recipientUserId",
            MAX_ORIGIN_ID_CHARS,
          );
          if (recipientUserId === actor.userId) throw selfShare();
          if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
            throw relayHttpError(RELAY_ERRORS.invalid_channel, "channel is not shareable");
          }
          storage.createShare({
            share: {
              shareId,
              workspaceId: route.workspaceId,
              granterUserId: actor.userId,
              selectorJson: JSON.stringify(selector),
              createdAtMs,
            },
            grant: {
              grantId,
              shareId,
              principalKind: "user",
              principalUserId: recipientUserId,
              principalEmail: null,
              access,
              generation: 1,
              status: "active",
              createdAtMs,
              revokedAtMs: null,
              parentGrantId: null,
            },
          });
          return jsonResponse({
            ok: true,
            shareId,
            workspaceId: route.workspaceId,
            recipientUserId,
            selector,
            access,
            grantId,
            generation: 1,
            createdAtMs,
          });
        }

        // Sharing by email. To close the account-enumeration oracle, the
        // response is IDENTICAL whether or not the email has a dohc account:
        // a known account becomes an immediate recipient, an unknown email
        // becomes a PENDING invite (claimed when that account first touches
        // the relay). Either way the response never echoes a recipient user
        // id, so the granter cannot distinguish "has an account" from "does
        // not" by inspecting the reply.
        const email = parseString(input.recipientEmail, "recipientEmail", MAX_EMAIL_CHARS);
        if (!resolveUserIdByEmail) {
          throw badRequest("recipient email lookup is not available on this relay");
        }
        const resolved = await resolveUserIdByEmail(email);
        if (resolved === actor.userId) throw selfShare();
        // Re-check after the asynchronous account lookup: a pre-provisioned
        // wire may have become an agent channel while this request was waiting.
        if (selectorTargetsBlockedChannel(storage, route.workspaceId, selector)) {
          throw relayHttpError(RELAY_ERRORS.invalid_channel, "channel is not shareable");
        }
        storage.createShare({
          share: {
            shareId,
            workspaceId: route.workspaceId,
            granterUserId: actor.userId,
            selectorJson: JSON.stringify(selector),
            createdAtMs,
          },
          grant: {
            grantId,
            shareId,
            principalKind: resolved ? "user" : "email",
            principalUserId: resolved ?? null,
            principalEmail: resolved ? null : email.trim().toLowerCase(),
            access,
            generation: 1,
            status: "active",
            createdAtMs,
            revokedAtMs: null,
            parentGrantId: null,
          },
        });
        return jsonResponse({
          ok: true,
          shareId,
          workspaceId: route.workspaceId,
          selector,
          access,
          grantId,
          generation: 1,
          createdAtMs,
        });
      }
      if (route.route === "shares-create") throw methodNotAllowed();

      if (route.route === "blob" && request.method === "PUT") {
        assertSha256(route.sha256);
        const bytes = await readBytes(request, MAX_BLOB_BYTES);
        const actual = sha256Hex(bytes);
        if (actual !== route.sha256) {
          throw badRequest("blob content does not match sha256 path");
        }
        const put = storage.putBlob({
          workspaceId: route.workspaceId,
          sha256: route.sha256,
          content: bytes,
          createdAtMs: nowMs(),
        });
        return jsonResponse({
          ok: true,
          workspaceId: route.workspaceId,
          sha256: route.sha256,
          byteLength: put.byteLength,
          alreadyHad: put.alreadyHad,
        });
      }

      if (route.route === "blob" && request.method === "GET") {
        assertSha256(route.sha256);
        const blob = storage.getBlob(route.workspaceId, route.sha256);
        // Distinct from the absent-workspace 404: the caller already proved
        // ownership above, so this leaks nothing about other tenants, and
        // sync clients must be able to tell missing content apart from an
        // unavailable workspace.
        if (!blob) throw blobNotFound();
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }

      if (route.route === "blob-have" && request.method === "POST") {
        const input = await readJsonObject(request);
        if (!Array.isArray(input.sha256s)) throw badRequest("sha256s must be an array");
        if (input.sha256s.length > 2_000) throw badRequest("too many sha256s");
        const sha256s = input.sha256s.map((value) => {
          if (typeof value !== "string") throw badRequest("sha256s must be strings");
          assertSha256(value);
          return value;
        });
        return jsonResponse({
          ok: true,
          missing: storage.missingBlobs(route.workspaceId, sha256s),
        });
      }

      if (route.route === "keys" && request.method === "PUT") {
        const bytes = await readBytes(request, MAX_KEY_ENVELOPE_BYTES);
        const envelopeJson = Buffer.from(bytes).toString("utf8");
        try {
          const parsed = JSON.parse(envelopeJson);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("not object");
          }
        } catch {
          throw badRequest("key envelope must be a JSON object");
        }
        // Create-only on first write; CAS via If-Match (sha256 of the envelope
        // being replaced) thereafter. A stale or absent precondition is a 409,
        // never a silent overwrite — the envelope is the only recovery path
        // for the wrapped workspace key. Replaced envelopes are retained in
        // the history table by storage.putKeyEnvelope.
        const result = storage.putKeyEnvelope({
          workspaceId: route.workspaceId,
          envelopeJson,
          updatedAtMs: nowMs(),
          expectedSha256: parseIfMatchSha256(request.headers.get("if-match")),
        });
        return jsonResponse(
          { ok: true, workspaceId: route.workspaceId, sha256: result.sha256 },
          200,
          { etag: `"${result.sha256}"` },
        );
      }

      if (route.route === "keys" && request.method === "GET") {
        const envelope = storage.getKeyEnvelope(route.workspaceId);
        if (!envelope) throw keyEnvelopeNotFound();
        return new Response(envelope.envelopeJson, {
          status: 200,
          headers: {
            "content-type": "application/json",
            // Current fingerprint + write time so clients can detect that the
            // envelope they enrolled with has been replaced.
            etag: `"${envelope.sha256}"`,
            "x-key-envelope-updated-at-ms": String(envelope.updatedAtMs),
          },
        });
      }

      if (route.route === "log" && request.method === "POST") {
        const input = await readJsonObject(request);
        const identity = parseOptionalWorkspaceIdentity(input);
        const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
        if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
        if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
        // MU-C0 verified authorship — the trust boundary. Every chat op that
        // names an author must claim the authenticated pusher. The relay refuses
        // authorless messages and unknown chat ops. This check runs before
        // parseLogOp and appendLogBatch, so the relay rejects the full batch
        // before it writes any operation.
        assertChatAuthorship(input.ops, actor.userId);
        const ops = input.ops.map(parseLogOp);
        const result = storage.appendLogBatch({
          workspaceId: route.workspaceId,
          originId,
          ops,
          // Identity claim/verification rides the append's BEGIN IMMEDIATE
          // transaction. A gap/conflict/quota/blob failure later in append
          // rolls back a first-adopt claim together with the batch.
          guard: ({ enforceWorkspaceIdentity: enforceInAppend }) => {
            enforceWorkspaceIdentity(
              storage,
              route.workspaceId,
              identity,
              enforceInAppend,
            );
          },
        });
        return jsonResponse({
          ok: true,
          accepted: ops.length,
          inserted: result.inserted,
          skipped: result.skipped,
          currentMaxOriginSeq: result.currentMaxOriginSeq,
        });
      }

      if (route.route === "log" && request.method === "GET") {
        const url = new URL(request.url);
        const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
        const epochLogFloor = enforceWorkspaceIdentity(
          storage,
          route.workspaceId,
          identity,
        );
        const requestedSince = parseCursor(url.searchParams.get("since"));
        const since = Math.max(requestedSince, epochLogFloor);
        const limit = parseLimit(url.searchParams.get("limit"));
        const page = storage.fetchLogPage({
          workspaceId: route.workspaceId,
          sinceRelaySeq: since,
          limit,
        });
        return jsonResponse({
          ok: true,
          ops: page.rows.map((row) => ({
            relaySeq: row.relaySeq,
            workspaceId: row.workspaceId,
            originId: row.originId,
            originSeq: row.originSeq,
            opKind: row.opKind,
            payload: JSON.parse(row.payloadJson) as unknown,
            recordedAtMs: row.recordedAtMs,
          })),
          // A hidden epoch floor is a read filter, not a served log row. An
          // empty response therefore cannot advance the caller's cursor: the
          // strict page contract requires nextCursor to equal the final
          // relaySeq, or the requested cursor when no row was served.
          nextCursor: page.rows.length === 0 ? requestedSince : page.nextCursor,
          hasMore: page.hasMore,
        });
      }

      if (route.route === "log-coordinate" && request.method === "GET") {
        const url = new URL(request.url);
        const identity = parseOptionalWorkspaceIdentityQuery(url.searchParams);
        const epochLogFloor = enforceWorkspaceIdentity(
          storage,
          route.workspaceId,
          identity,
        );
        const row = storage.fetchLogCoordinate({
          workspaceId: route.workspaceId,
          originId: route.originId,
          originSeq: route.originSeq,
        });
        if (!row) return jsonResponse({ ok: true, status: "absent" });
        const op = {
          relaySeq: row.relaySeq,
          workspaceId: row.workspaceId,
          originId: row.originId,
          originSeq: row.originSeq,
          opKind: row.opKind,
          payload: JSON.parse(row.payloadJson) as unknown,
          recordedAtMs: row.recordedAtMs,
        };
        if (row.relaySeq <= epochLogFloor) {
          return jsonResponse({
            ok: true,
            status: "presentBelowEpochFloor",
            op,
          });
        }
        return jsonResponse({
          ok: true,
          status: "present",
          op,
        });
      }

      throw methodNotAllowed();
    } catch (error) {
      return errorResponse(error);
    }
  };
}

function parseRoute(request: Request): SyncRelayRoute {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts.length === 2 && parts[0] === "sync" && parts[1] === "workspaces") {
    return { route: "workspaces" };
  }
  if (parts[0] !== "sync" || !parts[1]) throw notFound();
  // "/sync/shares/..." is the share-scoped namespace; "shares" is reserved as
  // a workspace id (parseWorkspaceId below) so the two can never collide.
  if (parts[1] === "shares") {
    if (parts.length === 2) return { route: "shares-list" };
    const shareId = parseShareId(parts[2]);
    if (parts.length === 3) return { route: "share", shareId };
    if (parts.length === 4 && parts[3] === "revoke") return { route: "share-revoke", shareId };
    if (parts.length === 4 && parts[3] === "log") return { route: "share-log", shareId };
    if (parts.length === 4 && parts[3] === "presence") return { route: "share-presence", shareId };
    if (parts.length === 5 && parts[3] === "blobs" && parts[4]) {
      return { route: "share-blob", shareId, sha256: parts[4] };
    }
    if (parts.length === 4 && parts[3] === "proposals") {
      return { route: "share-proposals", shareId };
    }
    if (parts.length === 6 && parts[3] === "proposals" && parts[5] === "withdraw") {
      return {
        route: "share-proposal-withdraw",
        shareId,
        proposalId: parseShareId(parts[4]),
      };
    }
    throw notFound();
  }
  const workspaceId = parseWorkspaceId(parts[1]);
  if (parts.length === 4 && parts[2] === "blobs" && parts[3] === "have") {
    return { route: "blob-have", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "blobs" && parts[3]) {
    return { route: "blob", workspaceId, sha256: parts[3] };
  }
  if (parts.length === 4 && parts[2] === "maintenance" && parts[3] === "gc") {
    return { route: "gc", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "log") {
    return { route: "log", workspaceId };
  }
  if (parts.length === 5 && parts[2] === "log") {
    const originId = parseString(parts[3], "originId", MAX_ORIGIN_ID_CHARS);
    const originSeq = Number(parts[4]);
    if (!Number.isSafeInteger(originSeq) || originSeq < 0) throw notFound();
    return { route: "log-coordinate", workspaceId, originId, originSeq };
  }
  if (parts.length === 3 && parts[2] === "bootstrap") {
    return { route: "bootstrap", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "epoch") {
    return { route: "epoch", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "presence") {
    return { route: "presence", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "keys") {
    return { route: "keys", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "shares") {
    return { route: "shares-create", workspaceId };
  }
  if (parts.length === 3 && parts[2] === "proposals") {
    return { route: "workspace-proposals", workspaceId };
  }
  if (parts.length === 4 && parts[2] === "proposals") {
    return {
      route: "workspace-proposal",
      workspaceId,
      proposalId: parseShareId(parts[3]),
    };
  }
  if (parts.length === 6 && parts[2] === "proposals" && parts[4] === "ops") {
    return {
      route: "workspace-proposal-op",
      workspaceId,
      proposalId: parseShareId(parts[3]),
      opIndex: parseOpIndex(parts[5]),
    };
  }
  if (
    parts.length === 5 &&
    parts[2] === "proposals" &&
    (parts[4] === "accept" || parts[4] === "decline")
  ) {
    return {
      route: "workspace-proposal-settle",
      workspaceId,
      proposalId: parseShareId(parts[3]),
      decision: parts[4],
    };
  }
  throw notFound();
}

// A path segment naming an op's position in its proposal. Anything that is not
// a plain in-range index addresses no op, so it is the same generic 404 every
// other unresolvable lookup gives.
function parseOpIndex(value: string | undefined): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,6})$/.test(value)) {
    throw notFound();
  }
  const index = Number(value);
  if (index >= MAX_SHARE_PROPOSAL_OPS) throw notFound();
  return index;
}

function parseShareId(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SHARE_ID_CHARS ||
    !/^[a-z0-9][a-z0-9-]*$/u.test(value)
  ) {
    throw notFound();
  }
  return value;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw badRequest("request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > maxBytes) throw payloadTooLarge();
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw payloadTooLarge();
  return bytes;
}

function parseWorkspaceId(value: unknown): string {
  const workspaceId = parseString(value, "workspaceId", MAX_WORKSPACE_ID_CHARS);
  // Reserved: "/sync/shares/..." is the share-route namespace (PR 18). A
  // workspace with this id could never be addressed, so refuse the claim
  // rather than strand it.
  if (workspaceId === "shares") throw badRequest("workspaceId is reserved");
  return workspaceId;
}

// C0 controls (including NUL) and DEL. Rejected in every parsed string field:
// the presence scope key joins workspaceId/topic with NUL separators, so an
// embedded NUL in one component could collide with a DIFFERENT workspace's
// scope (workspace "a" + topic "b\0c" vs workspace "a\0b" + topic "c") and
// leak presence across tenants. Refusing control characters at the parse
// boundary makes the composite keys unambiguous.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function parseString(value: unknown, name: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw badRequest(`${name} must be a non-empty trimmed string`);
  }
  if (value.length > maxChars) throw badRequest(`${name} is too long`);
  if (CONTROL_CHARS.test(value)) {
    throw badRequest(`${name} must not contain control characters`);
  }
  return value;
}

function parseWorkspaceIdentityValue(value: unknown, name: string): string {
  const parsed = parseString(value, name, MAX_IDENTITY_BYTES);
  if (Buffer.byteLength(parsed, "utf8") > MAX_IDENTITY_BYTES) {
    throw badRequest(`${name} is too long`);
  }
  return parsed;
}

interface OptionalWorkspaceIdentity {
  replicationEpoch: string;
  streamIdentity: string;
}

function parseOptionalWorkspaceIdentity(
  input: Record<string, unknown>,
): OptionalWorkspaceIdentity | null {
  return parseOptionalWorkspaceIdentityValues(
    input.replicationEpoch,
    input.streamIdentity,
  );
}

function parseOptionalWorkspaceIdentityQuery(
  searchParams: URLSearchParams,
): OptionalWorkspaceIdentity | null {
  return parseOptionalWorkspaceIdentityValues(
    searchParams.has("replicationEpoch")
      ? searchParams.get("replicationEpoch")
      : undefined,
    searchParams.has("streamIdentity") ? searchParams.get("streamIdentity") : undefined,
  );
}

function parseOptionalWorkspaceIdentityValues(
  replicationEpochValue: unknown,
  streamIdentityValue: unknown,
): OptionalWorkspaceIdentity | null {
  const hasReplicationEpoch = replicationEpochValue !== undefined;
  const hasStreamIdentity = streamIdentityValue !== undefined;
  if (!hasReplicationEpoch && !hasStreamIdentity) return null;
  if (hasReplicationEpoch !== hasStreamIdentity) {
    throw badRequest("replicationEpoch and streamIdentity must be supplied together");
  }
  return {
    replicationEpoch: parseWorkspaceIdentityValue(
      replicationEpochValue,
      "replicationEpoch",
    ),
    streamIdentity: parseWorkspaceIdentityValue(
      streamIdentityValue,
      "streamIdentity",
    ),
  };
}

function enforceWorkspaceIdentity(
  storage: SyncRelayStorage,
  workspaceId: string,
  identity: OptionalWorkspaceIdentity | null,
  claimInAppend?: (
    identity: OptionalWorkspaceIdentity | null,
  ) => EnforceWorkspaceIdentityResult,
): number {
  if (claimInAppend) {
    assertWorkspaceIdentityResult(claimInAppend(identity));
    return 0;
  }
  if (identity === null) {
    if (storage.getWorkspaceIdentity(workspaceId) !== null) {
      throw identityRequired();
    }
    return 0;
  }
  // GET is strictly read-only. An unset workspace cannot first-adopt identity
  // through a pull; there is no coordinate to verify, so it is reported as
  // unrecognized without writing.
  assertWorkspaceIdentityResult(
    storage.verifyWorkspaceIdentity({ workspaceId, ...identity }),
  );
  return storage.getEpochLogFloor(workspaceId);
}

function assertWorkspaceIdentityResult(
  result: EnforceWorkspaceIdentityResult,
): void {
  if (result === "epoch-superseded") throw epochSuperseded();
  if (result === "epoch-unknown") throw epochUnknown();
  if (result === "stream-mismatch") throw streamIdentityMismatch();
  if (result === "identity-required") throw identityRequired();
}

function parseLogOp(value: unknown): SyncRelayLogInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequest("each op must be a JSON object");
  }
  const op = value as Record<string, unknown>;
  const originSeq = Number(op.originSeq);
  if (!Number.isInteger(originSeq) || originSeq < 0) {
    throw badRequest("originSeq must be a non-negative integer");
  }
  const opKind = parseString(op.opKind, "opKind", MAX_OP_KIND_CHARS);
  if (!op.payload || typeof op.payload !== "object" || Array.isArray(op.payload)) {
    throw badRequest("payload must be a JSON object");
  }
  const recordedAtMs = op.recordedAtMs;
  if (typeof recordedAtMs !== "number" || !Number.isSafeInteger(recordedAtMs)) {
    throw badRequest("recordedAtMs must be an integer in the safe wire range");
  }
  const payloadJson = stableJsonStringify(op.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_JSON_BYTES) {
    throw badRequest("payload is too large");
  }
  return { originSeq, opKind, payloadJson, recordedAtMs };
}

// MU-C0 verified authorship. The relay authenticates WHO is pushing
// (actor.userId, server-derived from the Better Auth session — a client cannot
// assert it). For every chat op that names an author, that author MUST be the
// pusher, or the whole batch is rejected. This is the one place the relay reads
// into a chat payload — a second narrow, tested relaxation of "payloads are
// opaque", after PR-18's share filter, scoped to the author field, fail-closed.
//
// FAIL-CLOSED COMPLETENESS. The chat.* namespace is EXHAUSTIVE here: every
// chat op is either an explicitly-enumerated structural (no-author) op or an
// authored op with a known author field. An unknown/unmapped chat.* op (a
// future chat.thread.update, chat.message.edit, ...) is REJECTED, never
// admitted unverified — shipping a new authored chat op without extending this
// policy fails CLOSED, not open. Non-chat ops stay fully opaque and pass
// through untouched.
//
// Author identity is always the OPAQUE relay user id (never a raw email — PII
// must not enter the replicated CRDT):
//  - chat.message.append.authorUserId — REQUIRED. Messages without a verified
//    relay identity stay in the local engine and never enter a relay log.
//  - chat.reaction.set.authorId       — REQUIRED. A reaction is inherently an
//    authored act, so a missing/non-string author id is a malformed op and is
//    rejected (fail-closed), same as a mismatch.
//  - chat.decision.set / chat.attachment.add carry no author field. They are
//    derived from messages whose authorship was already verified, so they are
//    explicitly structural here and receive no separate authorship assertion.
//
// A future authored chat op is verified by adding it to CHAT_OP_POLICY; a
// future no-author chat op by enumerating it as "structural".
type ChatOpPolicy =
  | { kind: "structural" }
  | {
      kind: "authored";
      field: string;
    };
const CHAT_OP_POLICY: Record<string, ChatOpPolicy> = {
  // No-author structural/derived ops: nothing to verify, pass through.
  "chat.channel.create": { kind: "structural" },
  "chat.thread.create": { kind: "structural" },
  "chat.decision.set": { kind: "structural" },
  "chat.attachment.add": { kind: "structural" },
  // Authored ops: a present author field MUST equal the authenticated pusher.
  "chat.message.append": {
    kind: "authored",
    field: "authorUserId",
  },
  "chat.reaction.set": { kind: "authored", field: "authorId" },
  // Receiver-private state still rides the owner's ordinary workspace log.
  // It never appears in a channel share, and the authenticated pusher must be
  // the receiver named by the durable record.
  "chat.follow.set": { kind: "authored", field: "ownerUserId" },
  "chat.feed.read.set": { kind: "authored", field: "ownerUserId" },
};

// Verifies chat authorship before parseLogOp freezes the exact payload bytes.
// The relay never mutates replicated payloads because the author reads its own
// operations back and compares those bytes with its local replication log.
export function assertChatAuthorship(
  rawOps: unknown[],
  actorUserId: string,
): void {
  for (const rawOp of rawOps) {
    if (!rawOp || typeof rawOp !== "object" || Array.isArray(rawOp)) continue;
    const op = rawOp as Record<string, unknown>;
    const opKind = op.opKind;
    if (typeof opKind !== "string") continue;
    // Only chat.* ops are subject to the authorship gate; everything else is an
    // opaque payload and passes through even if it carries an author-shaped field.
    if (!opKind.startsWith("chat.")) continue;
    const policy = CHAT_OP_POLICY[opKind];
    if (!policy) throw unknownChatOp(); // fail-closed: an unrecognized chat op.
    if (policy.kind === "structural") continue;
    const payload = op.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      // An authored op with no object payload cannot be verified — reject
      // (fail-closed). parseLogOp would also reject it, but authorship first.
      throw authorshipMismatch();
    }
    const bag = payload as Record<string, unknown>;
    const claimed = bag[policy.field];
    if (claimed === undefined || claimed === null) {
      throw authorshipMismatch();
    }
    if (typeof claimed !== "string" || claimed !== actorUserId) {
      throw authorshipMismatch();
    }
  }
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  const cursor = Number(value);
  if (!Number.isInteger(cursor) || cursor < 0) throw badRequest("since must be a non-negative integer");
  return cursor;
}

function parseLimit(value: string | null): number {
  if (value === null || value === "") return DEFAULT_LOG_PAGE_SIZE;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) throw badRequest("limit must be a positive integer");
  return Math.min(limit, MAX_LOG_PAGE_SIZE);
}

function parsePresenceTopic(value: string | null): string {
  if (value === null) throw badRequest("topic is required");
  return parseString(value, "topic", MAX_PRESENCE_TOPIC_CHARS);
}

function parsePresenceHold(value: string | null): number {
  if (value === null || value === "") return DEFAULT_PRESENCE_HOLD_MS;
  const hold = Number(value);
  if (!Number.isInteger(hold) || hold < 0) throw badRequest("hold must be a non-negative integer");
  return Math.min(hold, MAX_PRESENCE_HOLD_MS);
}

function assertPresenceStateSize(state: unknown): void {
  if (state === undefined || state === null) return;
  let json: string | undefined;
  try {
    json = JSON.stringify(state);
  } catch {
    throw badRequest("presence state must be JSON-serializable");
  }
  if (json === undefined) throw badRequest("presence state must be JSON-serializable");
  if (Buffer.byteLength(json, "utf8") > MAX_PRESENCE_STATE_BYTES) {
    throw badRequest("presence state is too large");
  }
}

function presenceResponse(snapshot: PresenceSnapshot): Response {
  return jsonResponse({ ok: true, version: snapshot.version, peers: snapshot.peers });
}

// Capacity refusals (scope/entry/waiter caps) are a client-visible 429 so a
// well-behaved client backs off; anything else re-throws unchanged.
function presenceCapacityAs429(error: unknown): unknown {
  if (error instanceof PresenceCapacityError) {
    return relayHttpError(RELAY_ERRORS.presence_capacity, error.message);
  }
  return error;
}

function assertSha256(value: string): void {
  if (!SHA256_HEX.test(value)) throw badRequest("sha256 must be 64 lowercase hex characters");
}

// If-Match for PUT /keys: absent means create-only; otherwise a (optionally
// quoted) sha256 of the envelope the caller intends to replace. Wildcard and
// weak validators are refused — an unconditional overwrite is exactly the
// write this endpoint exists to prevent.
function parseIfMatchSha256(header: string | null): string | null {
  if (header === null) return null;
  const value = header.trim().replace(/^"(.*)"$/u, "$1");
  if (!SHA256_HEX.test(value)) {
    throw badRequest("if-match must be the sha256 of the current key envelope");
  }
  return value;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function arrayBufferForBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(error: unknown): Response {
  // Classified errors carry an intentional 4xx statusCode: our own typed
  // HttpError/SyncRelayConflictError, plus duck-typed auth errors from
  // workspace-api (UnauthorizedError). Everything else is UNEXPECTED
  // (SQLite failures, auth-DB hiccups): log it server-side and answer with a
  // generic 500 — never echo error.message, which can leak internals.
  const duckStatus =
    typeof error === "object" && error && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : undefined;
  const classified =
    error instanceof HttpError ||
    error instanceof SyncRelayConflictError ||
    error instanceof SyncRelayQuotaExceededError ||
    error instanceof SyncRelayBlobMissingError ||
    (Number.isInteger(duckStatus) && duckStatus! >= 400 && duckStatus! <= 499);
  if (!classified) {
    console.error("[sync-relay] unhandled error", error);
    return jsonResponse(
      { ok: false, error: "internal error", code: RELAY_ERRORS.internal_error.code },
      RELAY_ERRORS.internal_error.status,
    );
  }
  const status =
    error instanceof HttpError ||
    error instanceof SyncRelayConflictError ||
    error instanceof SyncRelayQuotaExceededError ||
    error instanceof SyncRelayBlobMissingError
      ? error.statusCode
      : duckStatus!;
  const code =
    error instanceof HttpError ||
    error instanceof SyncRelayConflictError ||
    error instanceof SyncRelayQuotaExceededError ||
    error instanceof SyncRelayBlobMissingError
      ? error.code
      : typeof error === "object" && error && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
  const message = error instanceof Error ? error.message : "request failed";
  return jsonResponse(
    {
      ok: false,
      error: message,
      ...(code ? { code } : {}),
    },
    status,
  );
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: RelayErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function relayHttpError(error: RelayErrorDefinition, message: string): HttpError {
  return new HttpError(error.status, error.code, message);
}

function badRequest(message: string): HttpError {
  return relayHttpError(RELAY_ERRORS.bad_request, message);
}

function epochSuperseded(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.epoch_superseded,
    "replication epoch has been superseded",
  );
}

// `identity_not_recognized` means the coordinate is unknown/newer, not proven
// stale. Clients must preserve local state and must not discard/reseed it.
function epochUnknown(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.identity_not_recognized,
    "replication coordinate is not recognized",
  );
}

function identityRequired(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.identity_required,
    "this workspace requires replication identity",
  );
}

function streamIdentityMismatch(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.stream_identity_mismatch,
    "stream identity does not match",
  );
}

function selfShare(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.self_share,
    "a share needs a recipient other than yourself",
  );
}

// MU-C0: a chat op claimed an author other than the authenticated pusher (or a
// required author was missing). 403 (not 404): the caller IS authenticated and
// owns the bucket — the request is forbidden, not hidden. Non-retryable; the
// client must send its OWN identity. Deliberately does not name which op failed.
function authorshipMismatch(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.authorship_mismatch,
    "chat op author does not match the authenticated actor",
  );
}

// MU-C0 fail-closed completeness: a chat.* op the authorship policy does not
// recognize. It may carry author-shaped fields the relay cannot verify, so it
// is refused rather than admitted unverified. 403 (not 400): the caller is
// authenticated and owns the bucket; the op is forbidden until the policy
// learns to verify it. Non-retryable as sent.
function unknownChatOp(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.unknown_chat_op,
    "unrecognized chat op cannot be authorship-verified",
  );
}

// MU-C4: an append addressed to a share that takes no appends — a read-only
// chat-channel grant (the broadcast opt-in) or a PR-18 path/version share
// (read-only by contract). 403, not 404: the caller IS the legitimate
// recipient and may keep reading; only writing is refused. Deliberately one
// code for both cases so the response does not reveal the selector kind.
function shareNotAppendable(): HttpError {
  return relayHttpError(RELAY_ERRORS.share_read_only, "this share does not accept appends");
}

// MU-C4 fail-closed append scoping: an op in the batch is not something this
// share admits — a chat op for another channel, a foreign thread, a forged
// thread re-bind, a file/secret/unknown op, or (#646 PR3a) a proposed change
// outside the shared paths or naming a file twice. The whole batch is rejected
// atomically. Deliberately does not name which op failed or why: the same code
// and body for every cause is what keeps a probing recipient from reading the
// share's shape out of its refusals.
function shareOpRejected(): HttpError {
  return relayHttpError(RELAY_ERRORS.share_op_rejected, "an op is outside this share");
}

// #646 PR3a: the proposal already moved out of `open`. Every mover — accept,
// decline, withdraw — races through the same single-row UPDATE, so exactly one
// wins and the losers all land here rather than acting on stale state.
function proposalNotOpen(): HttpError {
  return relayHttpError(
    RELAY_ERRORS.conflict,
    "these changes were already accepted, declined, or withdrawn",
  );
}

function notFound(): HttpError {
  return relayHttpError(RELAY_ERRORS.not_found, "not found");
}

function blobNotFound(): HttpError {
  return relayHttpError(RELAY_ERRORS.blob_not_found, "blob not found");
}

function keyEnvelopeNotFound(): HttpError {
  return relayHttpError(RELAY_ERRORS.key_envelope_not_found, "key envelope not found");
}

function methodNotAllowed(): HttpError {
  return relayHttpError(RELAY_ERRORS.method_not_allowed, "method not allowed");
}

function payloadTooLarge(): HttpError {
  return relayHttpError(RELAY_ERRORS.payload_too_large, "payload too large");
}
