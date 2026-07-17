import { createHash, randomUUID } from "node:crypto";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import {
  PresenceCapacityError,
  PresenceHub,
  presenceScopeKey,
  type PresenceSnapshot,
} from "./presence";
import {
  filterOpForShare,
  isChatChannelSelector,
  parseAnyShareSelectorJson,
  presenceTopicAllowedForShare,
  validateChatChannelShareSelector,
  validateShareSelector,
  type AnyShareSelector,
  type ChatShareChannelKind,
  type ChatShareThreadResolver,
} from "./shareFilter";
import {
  SyncRelayBlobMissingError,
  SyncRelayConflictError,
  SyncRelayQuotaExceededError,
  type EnforceWorkspaceIdentityResult,
  type SyncRelayLogInput,
  type SyncRelayShareRow,
  type SyncRelayStorage,
} from "./storage";

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
  | { route: "epoch"; workspaceId: string }
  | { route: "keys"; workspaceId: string }
  | { route: "log"; workspaceId: string }
  | { route: "shares-create"; workspaceId: string }
  | { route: "shares-list" }
  | { route: "share"; shareId: string }
  | { route: "share-revoke"; shareId: string }
  | { route: "share-log"; shareId: string }
  | { route: "share-blob"; shareId: string; sha256: string }
  | { route: "presence"; workspaceId: string }
  | { route: "share-presence"; shareId: string };

// Transport cap, deliberately LARGER than the engine's 5 MiB binary-file
// limit (MAX_VERSIONED_BINARY_FILE_BYTES): text blobs need the headroom and
// the relay never parses content, so it cannot tell text from binary.
// Clients enforce the engine limit by referenced kind on hydrate
// (workspace-engine syncApply) — an oversized BINARY blob a peer smuggles
// under this cap is rejected client-side as a protocol violation.
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const MAX_KEY_ENVELOPE_BYTES = 16 * 1024;
export const MAX_OPS_PER_REQUEST = 500;
export const MAX_PAYLOAD_JSON_BYTES = 256 * 1024;
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
const MAX_IDENTITY_BYTES = 512;

export function createSyncRelayHandler({
  storage,
  resolveActor,
  nowMs = () => Date.now(),
  resolveUserIdByEmail,
  lookupUserEmail,
  newShareId = () => randomUUID(),
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

  const selectorTargetsBlockedChannel = (
    workspaceId: string,
    selector: AnyShareSelector,
  ): boolean => {
    if (!isChatChannelSelector(selector)) return false;
    const channelKind = storage.findChannelCreateKind(workspaceId, selector.channelWireId);
    return channelKind === "agent" || channelKind === null;
  };

  // Loads a share for RECIPIENT access. Every failure mode — no such share,
  // revoked share, caller is not the recipient, granter lost the workspace —
  // is the same generic 404 the relay uses for absent workspaces, so probing
  // recipients cannot distinguish "never existed" from "exists but not
  // yours" from "was revoked".
  const shareForRecipient = (shareId: string, userId: string): SyncRelayShareRow & { selector: AnyShareSelector } => {
    const share = storage.getShare(shareId);
    if (!share) throw notFound();
    if (share.recipientUserId !== userId) throw notFound();
    if (share.revokedAtMs !== null) throw notFound();
    // Defensive: the grant is only as good as the granter's own standing.
    if (!storage.workspaceIsOwnedBy(share.workspaceId, share.granterUserId)) throw notFound();
    const selector = parseAnyShareSelectorJson(share.selectorJson);
    if (!selector) throw notFound();
    // Agent channels are owner-only and never use the per-recipient grant
    // lane. Reject historical/corrupt rows centrally so metadata, log reads,
    // append, blobs, and presence all remain byte-identical to an absent share.
    if (selectorTargetsBlockedChannel(share.workspaceId, selector)) throw notFound();
    return { ...share, selector };
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

  const shareSummary = async (
    share: SyncRelayShareRow,
    side: "granted" | "received",
  ): Promise<Record<string, unknown>> => {
    const selector = parseAnyShareSelectorJson(share.selectorJson);
    const base = {
      shareId: share.shareId,
      selector: selector ?? { paths: [], versionId: null },
      createdAtMs: share.createdAtMs,
    };
    if (side === "granted") {
      // A pending invite has no recipient user id yet; surface the addressed
      // email the granter typed. A claimed/real share resolves the email from
      // its recipient id for display.
      const recipientEmail = share.recipientUserId
        ? lookupUserEmail
          ? await lookupUserEmail(share.recipientUserId)
          : null
        : share.recipientEmail;
      return {
        ...base,
        workspaceId: share.workspaceId,
        recipientUserId: share.recipientUserId,
        recipientEmail,
        revokedAtMs: share.revokedAtMs,
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
          storage.listSharesGrantedBy(actor.userId).map((share) => shareSummary(share, "granted")),
        );
        const receivedRows = await Promise.all(
          storage.listSharesReceivedBy(actor.userId).map(async (share) => ({
            share,
            summary: await shareSummary(share, "received"),
          })),
        );
        // Re-evaluate AFTER the async display-name lookups, immediately before
        // serialization. A pre-provisioned wire that became an agent channel
        // during those awaits must not get one final recipient-list exposure.
        const received = receivedRows.flatMap(({ share, summary }) => {
          const selector = parseAnyShareSelectorJson(share.selectorJson);
          return selector && selectorTargetsBlockedChannel(share.workspaceId, selector)
            ? []
            : [summary];
        });
        return jsonResponse({ ok: true, granted, received });
      }
      if (route.route === "shares-list") throw methodNotAllowed();

      if (route.route === "share" && request.method === "GET") {
        await claimPendingShares(actor.userId);
        const share = shareForRecipient(route.shareId, actor.userId);
        const summary = await shareSummary(share, "received");
        shareForRecipient(route.shareId, actor.userId);
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
        const share = shareForRecipient(route.shareId, actor.userId);
        const url = new URL(request.url);
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
        shareForRecipient(route.shareId, actor.userId);
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
      //   1. shareForRecipient: membership, revocation, granter standing —
      //      every denial is the same byte-identical generic 404.
      //   2. The selector must be a chat-channel grant with read-write
      //      access; a read-only member (and any path/version share) is
      //      REFUSED with an explicit 403 — the member legitimately knows the
      //      share exists, so this is a refusal, not a 404.
      //   3. MU-C0 verified authorship: every authored chat op must claim the
      //      AUTHENTICATED pusher (assertChatAuthorship stamps/verifies) — a
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
        const share = shareForRecipient(route.shareId, actor.userId);
        if (!isChatChannelSelector(share.selector)) throw shareNotAppendable();
        if (share.selector.access !== "read-write") throw shareNotAppendable();
        const input = await readJsonObject(request);
        const originId = parseString(input.originId, "originId", MAX_ORIGIN_ID_CHARS);
        if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
        if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
        // Authorship BEFORE the filter so a stamped authorUserId is what the
        // filter sees and parseLogOp freezes into payloadJson (MU-C0).
        assertChatAuthorship(input.ops, actor.userId);
        // Batch-aware channel scoping: a thread created earlier in THIS batch
        // is a valid target for later ops in the same batch (the composer's
        // thread.create + first message.append), but the LOG's earliest
        // binding always wins over the batch — a batch cannot re-bind an
        // existing thread.
        const pendingThreadBindings = new Map<string, string>();
        const resolver: ChatShareThreadResolver = {
          channelKind: (channelWireId) =>
            storage.findChannelCreateKind(share.workspaceId, channelWireId),
          threadChannelWireId: (threadId) => {
            const stored = storage.findThreadCreateChannelWireId(share.workspaceId, threadId);
            return stored !== undefined ? stored : pendingThreadBindings.get(threadId);
          },
        };
        const ops = input.ops.map(parseLogOp);
        for (const op of ops) {
          const decision = filterOpForShare(share.selector, op.opKind, op.payloadJson, resolver);
          if (!decision.allowed) throw shareOpRejected();
          // Persist the filter's (possibly redacted) copy, never the pusher's
          // original bytes: the owner bucket is read back over the UNfiltered
          // owner lane, so any field the filter withholds (e.g. a member
          // attachment's objectId/pathHint) must not survive the append.
          op.payloadJson = JSON.stringify(decision.payload);
          if (op.opKind === "chat.thread.create") {
            const threadId = (JSON.parse(op.payloadJson) as { threadId?: unknown }).threadId;
            if (typeof threadId === "string" && threadId.length > 0) {
              pendingThreadBindings.set(threadId, share.selector.channelWireId);
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
          // in standing, still a read-write chat-channel grant on the same
          // workspace bucket.
          guard: () => {
            const fresh = shareForRecipient(route.shareId, actor.userId);
            if (fresh.workspaceId !== share.workspaceId) throw notFound();
            if (!isChatChannelSelector(fresh.selector)) throw shareNotAppendable();
            if (fresh.selector.access !== "read-write") throw shareNotAppendable();
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
        const share = shareForRecipient(route.shareId, actor.userId);
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
        shareForRecipient(route.shareId, actor.userId);
        return new Response(arrayBufferForBytes(blob), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      }
      if (route.route === "share-blob") throw methodNotAllowed();

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
          const share = shareForRecipient(route.shareId, actor.userId);
          const chatResolver = chatResolverFor(share.workspaceId);
          if (!presenceTopicAllowedForShare(share.selector, topic, chatResolver)) throw notFound();
          return share;
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
        let selector: AnyShareSelector;
        if (input.channelWireId !== undefined) {
          // Fail closed on an AMBIGUOUS body: a chat-channel selector must not
          // also carry a path/version selector. Silently preferring
          // channelWireId (and dropping the paths) would turn a stale/leftover
          // `paths` field into a full chat-channel grant — a silent intent
          // mismatch. Reject it instead (hardens regular shared-channel grants
          // too).
          if (input.paths !== undefined || input.versionId !== undefined) {
            throw new HttpError(
              400,
              "ambiguous_selector",
              "a chat-channel share must not also carry paths or versionId",
            );
          }
          const chatValidation = validateChatChannelShareSelector(
            {
              channelWireId: input.channelWireId,
              access: input.access,
            },
            chatResolverFor(route.workspaceId),
          );
          if (!chatValidation.ok) {
            throw new HttpError(400, chatValidation.code, chatValidation.message);
          }
          selector = chatValidation.selector;
        } else {
          const validation = validateShareSelector({
            paths: input.paths,
            versionId: input.versionId,
          });
          if (!validation.ok) {
            throw new HttpError(400, validation.code, validation.message);
          }
          selector = validation.selector;
        }
        const shareId = newShareId();
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
          if (selectorTargetsBlockedChannel(route.workspaceId, selector)) {
            throw new HttpError(400, "invalid_channel", "channel is not shareable");
          }
          storage.createShare({
            shareId,
            workspaceId: route.workspaceId,
            granterUserId: actor.userId,
            recipientUserId,
            recipientEmail: null,
            selectorJson: JSON.stringify(selector),
            createdAtMs,
          });
          return jsonResponse({
            ok: true,
            shareId,
            workspaceId: route.workspaceId,
            recipientUserId,
            selector: selector,
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
        if (selectorTargetsBlockedChannel(route.workspaceId, selector)) {
          throw new HttpError(400, "invalid_channel", "channel is not shareable");
        }
        storage.createShare({
          shareId,
          workspaceId: route.workspaceId,
          granterUserId: actor.userId,
          recipientUserId: resolved ?? null,
          recipientEmail: resolved ? null : email.trim().toLowerCase(),
          selectorJson: JSON.stringify(selector),
          createdAtMs,
        });
        return jsonResponse({
          ok: true,
          shareId,
          workspaceId: route.workspaceId,
          selector: selector,
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
        // carries an author identity must claim the AUTHENTICATED pusher; a
        // client can no longer forge a message/reaction as another user, and an
        // unrecognized chat op is refused (fail-closed). Runs BEFORE parseLogOp
        // so a stamped message.append authorUserId is frozen into payloadJson,
        // and BEFORE appendLogBatch so a batch mixing one forged/unknown op with
        // valid ones is rejected atomically (nothing is admitted to the log).
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
        const since = Math.max(
          parseCursor(url.searchParams.get("since")),
          epochLogFloor,
        );
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
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
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
  throw notFound();
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
  const recordedAtMs = Number(op.recordedAtMs);
  if (!Number.isFinite(recordedAtMs)) throw badRequest("recordedAtMs must be finite");
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
// into (and, for message.append, stamps) a chat payload — a second narrow,
// tested relaxation of "payloads are opaque", after PR-18's share filter,
// scoped to the author field, fail-closed.
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
//  - chat.message.append.authorUserId — verified when present; STAMPED to the
//    pusher when absent. The relay only ever sees authenticated pushes, so an
//    append is always attributable to actor.userId; a NULL/unattributed author
//    survives only in the engine-local/no-relay path, which never reaches here.
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
  | { kind: "authored"; field: string; onMissing: "reject" | "stamp" };
const CHAT_OP_POLICY: Record<string, ChatOpPolicy> = {
  // No-author structural/derived ops: nothing to verify, pass through.
  "chat.channel.create": { kind: "structural" },
  "chat.thread.create": { kind: "structural" },
  "chat.decision.set": { kind: "structural" },
  "chat.attachment.add": { kind: "structural" },
  // Authored ops: the author field MUST equal the authenticated pusher.
  "chat.message.append": { kind: "authored", field: "authorUserId", onMissing: "stamp" },
  "chat.reaction.set": { kind: "authored", field: "authorId", onMissing: "reject" },
  // Receiver-private state still rides the owner's ordinary workspace log.
  // It never appears in a channel share, and the authenticated pusher must be
  // the receiver named by the durable record.
  "chat.follow.set": { kind: "authored", field: "ownerUserId", onMissing: "reject" },
  "chat.feed.read.set": { kind: "authored", field: "ownerUserId", onMissing: "reject" },
};

// Verifies (and, for message.append, STAMPS) chat authorship on the RAW op
// payloads in place — so a stamped authorUserId is what parseLogOp later freezes
// into payloadJson and replicates. Must run BEFORE parseLogOp for the stamp to
// take effect.
export function assertChatAuthorship(rawOps: unknown[], actorUserId: string): void {
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
      if (policy.onMissing === "reject") throw authorshipMismatch();
      // stamp: attribute the op to the authenticated pusher so it replicates
      // VERIFIED rather than as a NULL/forgeable-display-name author.
      bag[policy.field] = actorUserId;
      continue;
    }
    if (typeof claimed !== "string" || claimed !== actorUserId) {
      throw authorshipMismatch();
    }
  }
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
    return new HttpError(429, "presence_capacity", error.message);
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
    return jsonResponse({ ok: false, error: "internal error", code: "internal_error" }, 500);
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
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function badRequest(message: string): HttpError {
  return new HttpError(400, "bad_request", message);
}

function epochSuperseded(): HttpError {
  return new HttpError(409, "epoch_superseded", "replication epoch has been superseded");
}

// `identity_not_recognized` means the coordinate is unknown/newer, not proven
// stale. Clients must preserve local state and must not discard/reseed it.
function epochUnknown(): HttpError {
  return new HttpError(
    409,
    "identity_not_recognized",
    "replication coordinate is not recognized",
  );
}

function identityRequired(): HttpError {
  return new HttpError(
    409,
    "identity_required",
    "this workspace requires replication identity",
  );
}

function streamIdentityMismatch(): HttpError {
  return new HttpError(409, "stream_identity_mismatch", "stream identity does not match");
}

function selfShare(): HttpError {
  return new HttpError(400, "self_share", "a share needs a recipient other than yourself");
}

// MU-C0: a chat op claimed an author other than the authenticated pusher (or a
// required author was missing). 403 (not 404): the caller IS authenticated and
// owns the bucket — the request is forbidden, not hidden. Non-retryable; the
// client must send its OWN identity. Deliberately does not name which op failed.
function authorshipMismatch(): HttpError {
  return new HttpError(403, "authorship_mismatch", "chat op author does not match the authenticated actor");
}

// MU-C0 fail-closed completeness: a chat.* op the authorship policy does not
// recognize. It may carry author-shaped fields the relay cannot verify, so it
// is refused rather than admitted unverified. 403 (not 400): the caller is
// authenticated and owns the bucket; the op is forbidden until the policy
// learns to verify it. Non-retryable as sent.
function unknownChatOp(): HttpError {
  return new HttpError(403, "unknown_chat_op", "unrecognized chat op cannot be authorship-verified");
}

// MU-C4: an append addressed to a share that takes no appends — a read-only
// chat-channel grant (the broadcast opt-in) or a PR-18 path/version share
// (read-only by contract). 403, not 404: the caller IS the legitimate
// recipient and may keep reading; only writing is refused. Deliberately one
// code for both cases so the response does not reveal the selector kind.
function shareNotAppendable(): HttpError {
  return new HttpError(403, "share_read_only", "this share does not accept appends");
}

// MU-C4 fail-closed append scoping: an op in the batch is not a chat op for
// the granted channel (wrong channel, foreign thread, a file/secret/unknown
// op, or a forged thread re-bind). The whole batch is rejected atomically.
// Deliberately does not name which op failed or why.
function shareOpRejected(): HttpError {
  return new HttpError(403, "share_op_rejected", "an op is outside the shared channel");
}

function notFound(): HttpError {
  return new HttpError(404, "not_found", "not found");
}

function blobNotFound(): HttpError {
  return new HttpError(404, "blob_not_found", "blob not found");
}

function keyEnvelopeNotFound(): HttpError {
  return new HttpError(404, "key_envelope_not_found", "key envelope not found");
}

function methodNotAllowed(): HttpError {
  return new HttpError(405, "method_not_allowed", "method not allowed");
}

function payloadTooLarge(): HttpError {
  return new HttpError(413, "payload_too_large", "payload too large");
}
