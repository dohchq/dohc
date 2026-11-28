import { isShareAccessValue } from "@dohc/security-contract/share-selector";
import { jsonResponse } from "@dohc/service-http";
import { randomBytes } from "node:crypto";
import { sha256Hex } from "@dohc/workspace-core/hash";
import {
  accountDisplayName,
  chatMentionBodies,
  type RefreshMentionAccountNames,
} from "./accountDisplayName";
import {
  DiscussionActivityCapacityError,
  linkLogWaitGroup,
  type DiscussionActivityHub,
} from "./discussionActivity";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import { arrayBufferForBytes, readBytes } from "./relayBytes";
import {
  assertChatAuthorship,
  assertClientLogProvenance,
  MESSAGE_TOMBSTONE_OP_KIND,
  namedShareOrigin,
  type LogAuthorNameLookup,
} from "./relayLogInputs";
import { prepareNamedShareAppendOps } from "./namedRecipientChat";
import {
  assertSha256,
  parseCursor,
  parseLimit,
  parseLinkLogHold,
  parseString,
  readJsonObject,
} from "./requestInputs";
import type { AuthorizedShareAction } from "./shareAuthorization";
import {
  chatSideFor,
  fileSideOf,
  filterOpForShareAppend,
  isGroupSelector,
  isWorkspaceSelector,
  type AnyShareSelector,
} from "./shareFilter";
import { PROPOSAL_ORIGIN_PREFIX } from "./shareProposals";
import type { createShareReadQueries } from "./shareReadQueries";
import type { SyncRelayStorage } from "./storage";
import type { MemberReach } from "./storage/memberReach";
import { StaleReferenceCollection } from "./storage/workReferences";
import { MAX_BLOB_BYTES, MAX_OPS_PER_REQUEST, MAX_ORIGIN_ID_CHARS } from "./wireLimits";

/** How old a member's stored account email may be when their feed or browser reads. */
export const MEMBER_IDENTITY_MAX_AGE_MS = 60_000;

export type NamedShareTransportRoute =
  | { route: "share-log"; shareId: string }
  | { route: "share-blob"; shareId: string; sha256: string };

/** What a share reaches, without its level. */
function shareScopeKey(selector: AnyShareSelector): string {
  if (isWorkspaceSelector(selector))
    return JSON.stringify({ kind: "workspace", role: selector.role });
  if (!("access" in selector))
    return JSON.stringify({ paths: selector.paths, versionId: selector.versionId });
  const { access: _access, ...scope } = selector;
  return JSON.stringify(scope);
}

// What the Members page shows for a person with no account name.
const NO_NAME = "No name";

type ServedOp = Record<string, unknown>;

/**
 * A joined workspace names each person by their account, as the Members page
 * does, never as the author's own computer named them: that computer calls a
 * person with no profile name "You". An agent's or automation's message
 * names the account it ran for the same way. Each account is looked up once
 * per page.
 */
async function nameAuthorsByAccount(
  ops: ServedOp[],
  lookup: LogAuthorNameLookup | undefined,
): Promise<ServedOp[]> {
  const names = new Map<string, Promise<string>>();
  const nameOf = (userId: string) => {
    let name = names.get(userId);
    if (!name) {
      name = accountDisplayName(lookup, userId).then((found) => found ?? NO_NAME);
      names.set(userId, name);
    }
    return name;
  };
  return Promise.all(
    ops.map(async (op) => {
      const payload = op.payload;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return op;
      const fields = payload as Record<string, unknown>;
      if (
        (op.opKind === "chat.message.append" || op.opKind === MESSAGE_TOMBSTONE_OP_KIND) &&
        typeof fields.authorUserId === "string"
      ) {
        if (fields.authorKind === "human") {
          return {
            ...op,
            payload: { ...fields, authorDisplayName: await nameOf(fields.authorUserId) },
          };
        }
        if (
          (fields.authorKind === "agent" || fields.authorKind === "automation") &&
          typeof fields.authorOwnerDisplayName === "string"
        ) {
          return {
            ...op,
            payload: { ...fields, authorOwnerDisplayName: await nameOf(fields.authorUserId) },
          };
        }
      }
      if (
        op.opKind === "chat.reaction.set" &&
        fields.authorKind === "human" &&
        typeof fields.authorId === "string"
      ) {
        return { ...op, payload: { ...fields, authorDisplayName: await nameOf(fields.authorId) } };
      }
      return op;
    }),
  );
}

export function createNamedShareTransportRoutes(
  storage: Pick<
    SyncRelayStorage,
    | "findChannelCreateKind"
    | "findThreadCreateChannelWireId"
    | "findThreadCreateFileBinding"
    | "objectCurrentPath"
    | "objectIdAtPath"
    | "messageDeleted"
    | "deletedMessageCount"
    | "appendLogBatch"
    | "putBlob"
    | "listWorkReferences"
    | "shareLogHead"
    | "readShareTx"
  >,
  nowMs: () => number,
  claimPendingShares: (userId: string, signal?: AbortSignal, maxAgeMs?: number) => Promise<void>,
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
  namedShareBlob: ReturnType<typeof createShareReadQueries>["namedShareBlob"],
  discussionActivity: Pick<DiscussionActivityHub, "wakeLog" | "wait">,
  lookupUserDisplayName?: LogAuthorNameLookup,
  identityKey?: string | Uint8Array,
  refreshMentionAccountNames?: RefreshMentionAccountNames,
) {
  // A relay without a link key runs only in development or test. Its reach
  // signatures change at each start, which costs a member a rebuild.
  const reachKey = identityKey ?? randomBytes(32);
  return async function respondToNamedShareTransport(
    request: Request,
    route: NamedShareTransportRoute,
    actor: { userId: string },
  ): Promise<Response> {
    if (route.route === "share-log" && request.method === "GET") {
      let authorized: AuthorizedShareAction;
      let claimed = false;
      try {
        authorized = requireShareAction(route.shareId, actor.userId, "read");
      } catch (error) {
        if (
          !(error instanceof RelayError) ||
          (error.code !== "not_found" && error.code !== "share_access_removed")
        )
          throw error;
        await claimPendingShares(actor.userId);
        claimed = true;
        authorized = requireShareAction(route.shareId, actor.userId, "read");
      }
      if (!claimed && isWorkspaceSelector(authorized.effectiveSelector)) {
        // A member's feed polls often; an email change applies within a minute.
        await claimPendingShares(actor.userId, undefined, MEMBER_IDENTITY_MAX_AGE_MS);
        authorized = requireShareAction(route.shareId, actor.userId, "read");
      }
      const share = { ...authorized.share, selector: authorized.effectiveSelector };
      const url = new URL(request.url);
      const channelWireId = url.searchParams.get("channelWireId");
      const clientOrigin = url.searchParams.get("originId");
      const ownOriginId =
        clientOrigin === null || clientOrigin === ""
          ? null
          : namedShareOrigin(
              share.shareId,
              actor.userId,
              parseString(clientOrigin, "originId", MAX_ORIGIN_ID_CHARS),
            );
      const channelKinds = {
        channelKind: (id: string) => storage.findChannelCreateKind(share.workspaceId, id),
      };
      // What this pull reads: the whole grant, or, when it names a channel,
      // that channel. A workspace share's Group pull reads that Group alone.
      const pullSelector = (selector: AnyShareSelector): AnyShareSelector => {
        if (channelWireId === null) return selector;
        const side = chatSideFor(selector, channelWireId, channelKinds);
        if (!side) throw notFound();
        return isWorkspaceSelector(selector) ? side : selector;
      };
      const readSelector = pullSelector(share.selector);
      const since = parseCursor(url.searchParams.get("since"));
      const limit = parseLimit(url.searchParams.get("limit"));
      const scan = url.searchParams.get("scan");
      if (scan !== null && scan !== "page") throw badRequest("scan must be page");
      // A group is read one half at a time. The channel pull names the
      // channel and gets its chat; the folder mount names nothing and gets
      // its files. Each client refuses the other half's ops, so one page
      // carrying both would only produce refusals.
      const half = isGroupSelector(readSelector)
        ? channelWireId !== null
          ? ("chat" as const)
          : ("files" as const)
        : undefined;
      // Both routes share selector filtering and cursor behavior. The
      // accountless route applies a narrower metadata boundary afterward.
      // A member's page, a Group pull's included, lists their reach as the
      // page's own transaction read it: its levels, and keyed signatures that
      // tell the member when the levels, or what they reach, changed. It names
      // the log's head as that transaction read it too: an engine's first pull
      // reads moves marked at or below its first page's head, which the reach
      // already placed, and rebuilds for a later one.
      let reach: MemberReach | undefined;
      let logHead = 0;
      const signed = () => (reach ? { reach: reach.listed(reachKey), logHead } : {});
      // What the page's read decided by, as one value. The selector holds the
      // member's evaluated reach, so a level or Group rule change moves it.
      // Deletes only add rows, so the count moves with each one, as the
      // highest relay_seq would not for an older message deleted after a
      // newer one.
      const markOf = (selector: AnyShareSelector) =>
        JSON.stringify({ selector, deleted: storage.deletedMessageCount(share.workspaceId) });
      let pageMark = "";
      const authorizeRead = () => {
        const selector = requireShareAction(route.shareId, actor.userId, "read").effectiveSelector;
        reach = isWorkspaceSelector(selector) ? selector.reach : undefined;
        if (reach) logHead = storage.shareLogHead(share.workspaceId);
        pageMark = markOf(selector);
        return pullSelector(selector);
      };
      let page = filteredLogPage(
        share.workspaceId,
        share.shareId,
        authorizeRead,
        since,
        limit,
        "authenticated",
        half,
        ["user", actor.userId],
        false,
        0,
        scan === "page" ? limit : undefined,
      );
      const hold = parseLinkLogHold(url.searchParams.get("hold"));
      const knew = url.searchParams.get("level");
      const accessOf = (selector: AnyShareSelector) => {
        if (isWorkspaceSelector(selector)) return selector.reach.evaluated.level;
        const files = fileSideOf(selector);
        return files && "access" in files ? files.access : "view";
      };
      if (
        isShareAccessValue(knew) &&
        knew !== accessOf(authorized.effectiveSelector) &&
        (isWorkspaceSelector(authorized.effectiveSelector) ||
          (page.ops.length === 0 && !page.hasMore))
      ) {
        return jsonResponse({
          ok: true,
          ops: [],
          nextCursor: since,
          hasMore: false,
          ownOriginId,
          levelChanged: true,
          ...signed(),
        });
      }
      if (hold > 0 && page.ops.length === 0 && !page.hasMore && page.nextCursor === since) {
        const deadline = Date.now() + hold;
        let scanSince = since;
        let levelChanged = false;
        const readPage = (): typeof page => {
          const fresh = requireShareAction(route.shareId, actor.userId, "read");
          // A changed scope ends the hold. A changed level alone answers
          // with an empty page that says so, and the reader checks its access.
          if (
            fresh.share.workspaceId !== share.workspaceId ||
            shareScopeKey(fresh.effectiveSelector) !== shareScopeKey(authorized.effectiveSelector)
          )
            throw notFound();
          if (
            JSON.stringify(fresh.effectiveSelector) !== JSON.stringify(authorized.effectiveSelector)
          ) {
            levelChanged = true;
            return page;
          }
          const next = filteredLogPage(
            share.workspaceId,
            share.shareId,
            authorizeRead,
            scanSince,
            limit,
            "authenticated",
            half,
            ["user", actor.userId],
          );
          return next;
        };
        while (!request.signal.aborted && Date.now() < deadline) {
          try {
            await discussionActivity.wait(
              linkLogWaitGroup(share.workspaceId),
              `named:${actor.userId}`,
              {
                holdMs: Math.max(1, deadline - Date.now()),
                signal: request.signal,
                shouldPark: () => {
                  try {
                    page = readPage();
                    scanSince = page.nextCursor;
                    return !levelChanged && page.ops.length === 0 && !page.hasMore;
                  } catch {
                    return false;
                  }
                },
              },
            );
          } catch (error) {
            if (error instanceof DiscussionActivityCapacityError)
              throw relayError("share_access_rate_limited");
            throw error;
          }
          if (!levelChanged && page.ops.length === 0 && !page.hasMore) page = readPage();
          scanSince = page.nextCursor;
          if (levelChanged || page.ops.length > 0 || page.hasMore) break;
        }
        if (levelChanged) {
          // The reach and the head, from one read, as a page's are.
          storage.readShareTx(authorizeRead);
          return jsonResponse({
            ok: true,
            ops: [],
            nextCursor: since,
            hasMore: false,
            ownOriginId,
            levelChanged: true,
            ...signed(),
          });
        }
      }
      const referenceAfter = url.searchParams.get("referenceAfter") || undefined;
      // Builds the answer from `held`, a page already read, after its last
      // await. Throws not-found when the share or the pulled channel is gone;
      // returns null when the reader still holds it but what decided the page
      // changed while it was assembled.
      const buildAnswer = async (held: typeof page): Promise<Response | null> => {
        const mark = pageMark;
        const stillHeld = () => {
          const latest = requireShareAction(route.shareId, actor.userId, "read");
          pullSelector(latest.effectiveSelector);
          return latest;
        };
        let mappings: Awaited<ReturnType<typeof storage.listWorkReferences>>;
        try {
          mappings =
            !identityKey || url.searchParams.get("includeReferences") === "false" || held.hasMore
              ? { references: [], nextAfter: "", hasMore: false }
              : await storage.listWorkReferences({
                  workspaceId: share.workspaceId,
                  reader: { kind: "user", userId: actor.userId, grantId: authorized.grant.grantId },
                  identityKey,
                  after: referenceAfter,
                });
        } catch (error) {
          if (!(error instanceof StaleReferenceCollection)) throw error;
          stillHeld();
          return null;
        }
        const ops = isWorkspaceSelector(share.selector)
          ? await nameAuthorsByAccount(held.ops, lookupUserDisplayName)
          : held.ops;
        const latest = stillHeld();
        if (markOf(latest.effectiveSelector) !== mark) return null;
        const levelChanged =
          isShareAccessValue(knew) && knew !== accessOf(latest.effectiveSelector);
        return jsonResponse({
          ok: true,
          ...(mappings.references.length || mappings.nextAfter
            ? {
                workReferences: mappings.references,
                nextReferenceAfter: mappings.nextAfter,
                referenceHasMore: mappings.hasMore,
              }
            : {}),
          ...held,
          ops,
          ownOriginId,
          ...(levelChanged ? { levelChanged: true } : {}),
          ...signed(),
        });
      };
      // A change while the answer was assembled drops all of it. The rerun
      // reads from the client's cursor with no hold, so no earlier window is
      // reused. A second change answers busy, and nothing from either read leaves.
      const answer =
        (await buildAnswer(page)) ??
        (await buildAnswer(
          filteredLogPage(
            share.workspaceId,
            share.shareId,
            authorizeRead,
            since,
            limit,
            "authenticated",
            half,
            ["user", actor.userId],
          ),
        ));
      if (!answer) throw relayError("server_busy");
      return answer;
    }

    // Member append: the first place a non-owner writes into an owner's
    // bucket. Fail-closed checks, in order:
    //   1. authorizeShareAction: membership, grant status, granter standing.
    //      Every denial is the same byte-identical generic 404.
    //   2. The selector must accept appends: a read-write chat grant, or a
    //      file share at comment or edit. A read-only member and a view file
    //      share are refused with an explicit 403, because the member
    //      legitimately knows the share exists. The refusal has one code and
    //      one body, because a level-specific refusal would tell a probing
    //      recipient the selector's level.
    //   3. Verified authorship: every authored chat op must claim the
    //      authenticated pusher (assertChatAuthorship verifies it), so a
    //      member cannot forge a message or reaction as another member.
    //   4. Every op must pass the same fail-closed chat filter that scopes
    //      reads: chat.* only, granted channel only, earliest-thread-binding
    //      honored. One rejected op rejects the whole batch atomically.
    // Accepted ops land in the owner's workspace bucket under a
    // share-namespaced origin id, so a member can never extend or collide
    // with the owner's or another member's origin sequence space. The relay
    // still assigns no cross-origin order. Members are not workspace
    // replicas: the fail-closed share/channel filter governs their appends,
    // so workspace epoch enforcement does not apply on this route.
    if (route.route === "share-log" && request.method === "POST") {
      await claimPendingShares(actor.userId);
      const appendable = () => requireShareAction(route.shareId, actor.userId, "append");
      const authorized = appendable();
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
      if (originId === "browser-chat") {
        throw badRequest("originId is reserved for browser chat");
      }
      if (!Array.isArray(input.ops)) throw badRequest("ops must be an array");
      if (input.ops.length > MAX_OPS_PER_REQUEST) throw badRequest("too many ops");
      // Authorship runs before the filter and parseLogOp so neither admits nor
      // freezes a payload whose claimed author is missing or forged.
      assertChatAuthorship(input.ops, actor.userId);
      assertClientLogProvenance(originId, input.ops);
      const { ops, resolver } = await prepareNamedShareAppendOps(
        storage,
        share.workspaceId,
        share.selector,
        input.ops,
        actor.userId,
        lookupUserDisplayName,
      );
      if (refreshMentionAccountNames) {
        const mentionBodies = chatMentionBodies(ops);
        if (mentionBodies.length > 0)
          await refreshMentionAccountNames(share.workspaceId, mentionBodies);
      }
      const result = storage.appendLogBatch({
        workspaceId: share.workspaceId,
        // Authentication, not the caller, selects the member sequence space.
        originId: namedShareOrigin(share.shareId, actor.userId, originId),
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
        guard: () => {
          shareActionGuard(route.shareId, actor.userId, "append", share.workspaceId)();
          const fresh = appendable();
          for (const op of ops) {
            if (
              !filterOpForShareAppend(fresh.effectiveSelector, op.opKind, op.payloadJson, resolver)
                .allowed
            )
              throw relayError("share_op_rejected");
          }
        },
      });
      if (result.inserted > 0) {
        discussionActivity.wakeLog(share.workspaceId);
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
      // passes the share filter legitimately references it, and below Edit
      // only while that op is still its file's current state. Everything
      // else — a replaced version, a blob of an unshared file, a secret
      // ciphertext blob, a random hash — is the same generic 404 as a
      // nonexistent share.
      // Chat shares expose no blob because their filter decisions name none.
      const blob = namedShareBlob(
        share.workspaceId,
        () => requireShareAction(route.shareId, actor.userId, "read").effectiveSelector,
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
