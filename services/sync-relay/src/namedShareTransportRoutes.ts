import { jsonResponse } from "@dohc/service-http";
import { sha256Hex } from "@dohc/workspace-core/hash";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import { arrayBufferForBytes, readBytes } from "./relayBytes";
import { assertChatAuthorship, parseLogOp } from "./relayLogInputs";
import { assertSha256, parseCursor, parseLimit, parseString, readJsonObject } from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import {
  filterOpForShareAppend,
  isChatChannelSelector,
  type ChatShareThreadResolver,
  type ThreadFileBinding,
} from "./shareFilter";
import { PROPOSAL_ORIGIN_PREFIX } from "./shareProposals";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import { MAX_BLOB_BYTES, MAX_OPS_PER_REQUEST, MAX_ORIGIN_ID_CHARS } from "./wireLimits";

export type NamedShareTransportRoute =
  | { route: "share-log"; shareId: string }
  | { route: "share-blob"; shareId: string; sha256: string };

export function createNamedShareTransportRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "findChannelCreateKind"
    | "findThreadCreateChannelWireId"
    | "findThreadCreateFileBinding"
    | "objectCurrentPath"
    | "objectIdAtPath"
    | "appendLogBatch"
    | "putBlob"
  >,
  nowMs: () => number,
  claimPendingShares: (userId: string) => Promise<void>,
  requireShareAction: (
    shareId: string,
    actorUserId: string,
    action: "read" | "append" | "propose",
  ) => AuthorizedShareAction,
  shareActionGuard: (
    shareId: string,
    actorUserId: string,
    action: "append",
    workspaceId: string,
  ) => () => void,
  filteredLogPage: ReturnType<typeof createShareReadQueries>["filteredLogPage"],
  historicalSharedBlob: ReturnType<typeof createShareReadQueries>["historicalSharedBlob"],
  discussionActivity: Pick<DiscussionActivityHub, "wake">,
) {
  return async function respondToNamedShareTransport(
    request: Request,
    route: NamedShareTransportRoute,
    actor: { userId: string },
  ): Promise<Response> {
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
      // Both routes share selector filtering and cursor behavior. The
      // accountless route applies a narrower metadata boundary afterward.
      const page = filteredLogPage(
        share.workspaceId,
        share.selector,
        since,
        limit,
        "authenticated",
      );
      // Re-check revocation immediately before returning the body: a revoke
      // that raced with this in-flight read (after the entry check, while
      // the page was assembled) must abort the response, not leak a final
      // filtered page. Re-loading the share throws the same generic 404.
      requireShareAction(route.shareId, actor.userId, "read");
      return jsonResponse({
        ok: true,
        ...page,
      });
    }

    // MU-C4 member append — the bidirectional extension of the PR-18
    // recipient model, and the first place a non-owner writes into an
    // owner's bucket. Fail-closed gauntlet, in order:
    //   1. authorizeShareAction: membership, grant status, granter standing —
    //      every denial is the same byte-identical generic 404.
    //   2. The selector must accept appends: a read-write chat-channel
    //      grant, or a file share at comment or edit. A
    //      read-only member and a VIEW file share are refused with an
    //      explicit 403 — the member legitimately knows the share exists,
    //      so this is a refusal, not a 404 — and with one code and one
    //      body, because a level-specific refusal would tell a probing
    //      recipient the selector's level.
    //   3. MU-C0 verified authorship: every authored chat op must claim the
    //      AUTHENTICATED pusher (assertChatAuthorship verifies it) — a
    //      member cannot forge a message or reaction as another member.
    //   4. Every op must pass the same fail-closed chat filter that scopes
    //      reads: chat.* only, granted channel only, earliest-thread-binding
    //      honored. One rejected op rejects the whole batch atomically.
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
      // A share's origin space is shared between the recipient's
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
      // Batch-aware channel scoping: a thread created earlier in this batch
      // is a valid target for later ops in the same batch (the composer's
      // thread.create + first message.append), but the log's earliest
      // binding always wins over the batch — a batch cannot re-bind an
      // existing thread.
      const pendingThreadBindings = new Map<string, string>();
      // The path sibling of the same rule, for a file share. A
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
        // The write filter, never the read one: what a recipient may see is
        // not what it may push into the granter's log (#646 PR3-0).
        const decision = filterOpForShareAppend(
          share.selector,
          op.opKind,
          op.payloadJson,
          resolver,
        );
        if (!decision.allowed) throw relayError("share_op_rejected");
        // Persist the filter's (possibly redacted) copy, never the pusher's
        // original bytes: the owner bucket is read back over the UNfiltered
        // owner lane, so any field the filter withholds (e.g. a member
        // attachment's objectId/pathHint) must not survive the append.
        op.payloadJson = JSON.stringify(decision.payload);
        if (op.opKind === "chat.thread.create") {
          // Read back from the served copy assigned above, which carries the
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
              // The accept door converts the binding.
              //
              // A recipient names its file by path because its own object
              // ids mean nothing here. This is the one moment the relay can
              // turn that into the granter's own object id: the filter just
              // proved an object sits at this exact path. Persisting the
              // object id instead of the path is what makes a recipient's
              // thread behave like the granter's — it follows the file
              // through a rename inside the share, and stops at one that
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
              if (!objectId) throw relayError("share_op_rejected");
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
        // Close the revoke race completely: the share is re-verified inside
        // the append's own BEGIN IMMEDIATE transaction (the same write lock
        // revokeShare takes), so a revoke committed after the entry check
        // above can never slip a write in — the guard sees it and the whole
        // batch rolls back as the same generic 404. The guard re-runs the
        // full appendability gauntlet: recipient-owned, unrevoked, granter
        // in standing, and still a selector that accepts appends at its
        // current level on the same workspace bucket — a level
        // narrowed mid-flight loses the race the same way a revoke does.
        guard: shareActionGuard(
          route.shareId,
          actor.userId,
          "append",
          share.workspaceId,
        ),
      });
      if (result.inserted > 0) {
        discussionActivity.wake(`log:${share.workspaceId}`);
      }
      return jsonResponse({
        ok: true,
        accepted: ops.length,
        inserted: result.inserted,
        skipped: result.skipped,
        currentMaxOriginSeq: result.currentMaxOriginSeq,
      });
    }
    if (route.route === "share-log") throw relayError("method_not_allowed");

    if (route.route === "share-blob" && request.method === "GET") {
      await claimPendingShares(actor.userId);
      const authorized = requireShareAction(route.shareId, actor.userId, "read");
      const share = { ...authorized.share, selector: authorized.effectiveSelector };
      assertSha256(route.sha256);
      // A blob is served to a recipient only when at least one op that
      // passes the share filter legitimately references it. Everything
      // else — a blob of an unshared file, a secret ciphertext blob, a
      // random hash — is the same generic 404 as a nonexistent share.
      // Chat shares expose no blob because their filter decisions name none.
      const blob = historicalSharedBlob(
        share.workspaceId,
        share.selector,
        route.sha256,
      );
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
    // A recipient's blob, charged to the GRANTER's workspace.
    // Same level gate as the proposal route, same refusal, so a probe cannot
    // tell the level from the code.
    //
    // It needs no bound of its own. Three already apply and all three are
    // the granter's: MAX_BLOB_BYTES per blob, the granter's workspace quota
    // per workspace (`putBlob` charges it), and the unreferenced-blob sweep,
    // which reclaims anything no open proposal claims. A blob count would
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
    throw relayError("method_not_allowed");
  };
}
