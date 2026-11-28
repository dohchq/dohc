import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import {
  isAccountFileWriteOperation,
  runAccountFileWrite,
  type AccountFileWriteLiveHost,
} from "./accountFileWrites";
import type { LiveRooms } from "./liveRoom";
import {
  isPhoneWriteOperation,
  parseMarkRead,
  parsePhoneWrite,
  parseRetryWake,
  runAccountMarkRead,
  runAccountRetryWake,
  runAccountWrite,
} from "./accountChatWrites";
import {
  accountDisplayName,
  type LookupUserDisplayName,
  type RefreshMentionAccountNames,
} from "./accountDisplayName";
import {
  cursorReaches,
  currentAccountFeedCursor,
  readAccountFeed,
  type AccountFeedWaits,
} from "./accountFeed";
import {
  isAccountOperation,
  runAccountOperation,
  withAccountReadDeadline,
} from "./accountOperations";
import type { DiscussionActivityHub } from "./discussionActivity";
import { untilAborted } from "./namedLiveFrameHost";
import { appendNamedChatMessage } from "./namedRecipientChat";
import { COULD_NOT_SEND } from "./operationPublication";
import { parseChatContext, readWakeChanges, runAccountChatContext } from "./accountTalkContext";
import { isPhoneAppOperation, type PhoneApps } from "./phoneApps";
import { isPhoneCollectionOperation, type PhoneCollections } from "./phoneCollections";
import {
  isPhoneDocumentCollectionReadOperation,
  isPhoneDocumentCollectionWriteOperation,
  runPhoneDocumentCollectionRead,
  runPhoneDocumentCollectionWrite,
} from "./phoneDocumentCollections";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import type { ChatWakeWaits } from "./chatWakeRoutes";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import type { PhonePages } from "./phonePages";
import {
  isPhoneSketchOperation,
  runPhoneSketchOperation,
  SAVE_SKETCH_MAX_BODY_BYTES,
} from "./phoneSketches";
import { phoneMember, type PhoneMember } from "./phoneMember";
import { authorizeShareGrantAction } from "./shareAuthorization";
import { isWorkspaceSelector } from "./shareFilter";
import { accountIsFenced } from "./storage/accountDeletion";
import { parseWorkspaceId } from "./requestInputs";
import type { ServerCopies } from "./serverCopies";
import { SyncRelayConflictError, type SyncRelayStorage } from "./storage";
import { workspaceChatAccess, workspaceGroupReachable } from "./workspaceReach";
import { parseLogHold } from "./workspaceReplicationRoutes";

export type AccountOperationRoute = {
  route: "account-operation";
  workspaceId: string;
  operation: string;
};

const ACCOUNT_OPERATION_MAX_BODY_BYTES = 256 * 1024;
// How long the arguments take to arrive.
const BODY_RECEIPT_MS = 10_000;
const SAVE_SKETCH_BODY_RECEIPT_MS = 30_000;

/**
 * The answer while this server has no copies to read from, as when it is still starting. It is the copies' own refusal
 * of a visit they can't take (serverCopies.ts), and every workspace gets it alike, before any is looked at.
 */
const copiesUnavailable = () =>
  new RelayError(
    "server_busy",
    "Your server can't open workspaces for the phone right now. Try again later.",
  );

/** One sign-in's reads: a burst for opening a workspace, then a steady pace. */
export function createAccountOperationRateLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(60, 2, 4096);
}

/** Parses `/sync/:workspaceId/ops/:operation`, already split into segments. */
export function parseAccountOperationRoute(parts: readonly string[]): AccountOperationRoute {
  // An ID that cannot be a workspace answers as one this account does not own.
  try {
    return {
      route: "account-operation",
      workspaceId: parseWorkspaceId(parts[1]),
      operation: parts[3]!,
    };
  } catch {
    throw notFound();
  }
}

/**
 * A signed-in account's reads, chat writes, read marks, wake retries,
 * conversation contexts, and a phone's page opens for live editing in a
 * workspace it owns, through this server's copy of it, while it shows on the
 * phone; its published apps (phoneApps.ts); its transactional Collections
 * (phoneCollections.ts); its change feed, at `GET .../ops/changes?since=&hold=`;
 * and its wake changes there, at `GET .../ops/wakeChanges?since=&hold=`. A
 * Member or an Admin reaches only the reads, the change feed, the apps and the
 * Collections of a workspace they joined, while it shows on their own phone,
 * each narrowed by their reach. Only a Bearer session
 * reaches them, except a page open share-web forwards for the owner's browser.
 * The route checks the operation and the owner before it
 * reads the arguments or the cursor. The sign-in, its fence, the owner and
 * "Show on phone" are checked again once the arguments arrive, after the
 * account's name is looked up for a write, once the copy is open, once it
 * has synced, after every wait, and once the answer is ready. A workspace
 * the account does not own, one that does not exist, and an ID that cannot
 * be one answer alike. Each read carries the feed's cursor for what its
 * copy had synced before it ran. A write's cursor is the relay's position
 * when it ran, which its copy may not have pulled, so it never moves a
 * read's starting point.
 */
class MemberTargetMissing extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export function createAccountOperationRoute(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
  copies(): ServerCopies | undefined;
  nowMs(): number;
  /** Keyed by sign-in. */
  limiter: TokenBucketLimiter;
  feedWaits: AccountFeedWaits;
  /** The account's wake reads, which wake changes park in. */
  wakeWaits: Pick<ChatWakeWaits, "wait">;
  activity?: Pick<DiscussionActivityHub, "wakeLog">;
  /** Reads the account's verified email again when it is old, so a folder or Group rule that names it reaches them. */
  refreshAccountEmail?(userId: string, signal: AbortSignal): Promise<void>;
  /** The account's name, which a write's author takes. */
  lookupUserDisplayName?: LookupUserDisplayName;
  refreshMentionAccountNames?: RefreshMentionAccountNames;
  /** This server's public origin, which issues its accounts' actor keys. Writes need it. */
  serverUrl?: string;
  /** The workspace's published apps, their review and approval, and launch grants. */
  phoneApps?: PhoneApps;
  /** The workspace's transactional Collections, read through the dataset host. */
  phoneCollections?: PhoneCollections;
  /** Opens a page for the phone to edit live. Absent while this server hosts no live pages. */
  phonePages?: () => PhonePages | undefined;
  /** The self-hosted live host, for cleanly retiring idle enrollments on rename/delete. */
  liveHost?: () => AccountFileWriteLiveHost | undefined;
  /** Live rooms, so rename/delete saves buffered live edits before retiring idle enrollments. */
  liveRooms?: () => Pick<LiveRooms, "saveFirst"> | undefined;
  /** share-web's origin and its exchange key check, with which it forwards the owner's browser to open a page. */
  browser?: { origin: string; hasExchangeKey(request: Request): boolean };
}) {
  const { storage, limiter } = options;
  const session = async (request: Request, browser = false) => {
    if (!browser) return bearerAccountSession(storage, options.resolveAccountSession, request);
    const cookie = request.headers.get("cookie");
    if (
      !cookie ||
      request.headers.get("origin") !== options.browser?.origin ||
      !options.browser?.hasExchangeKey(request)
    )
      throw notFound();
    const caller = await options
      .resolveAccountSession(
        new Request(request.url, { headers: { cookie }, signal: request.signal }),
      )
      .catch(() => {
        throw notFound();
      });
    if (caller.clientKind !== "browser" || accountIsFenced(storage, caller.userId))
      throw notFound();
    return caller;
  };

  const respond = async (
    request: Request,
    route: AccountOperationRoute,
    readSignal: AbortSignal | undefined,
  ): Promise<Response> => {
    const feed = route.operation === "changes" && request.method === "GET";
    const wakeFeed = route.operation === "wakeChanges" && request.method === "GET";
    if (!feed && !wakeFeed && request.method !== "POST") throw relayError("method_not_allowed");
    const page = route.operation === "openPage";
    const browser = page && !request.headers.has("authorization");
    const checkSignIn = () =>
      readSignal ? untilAborted(session(request, browser), readSignal) : session(request, browser);
    const caller = await checkSignIn();
    if (page && !browser && caller.clientKind !== "phone") throw notFound();
    if (
      !limiter.allow(caller.sessionId, options.nowMs()) ||
      // An open can enroll a page, so the account's sign-ins also share one pace for it.
      (page && !limiter.allow(`account:${caller.userId}`, options.nowMs()))
    ) {
      throw new RelayError(
        "server_busy",
        "This sign-in is asking faster than your server answers. Try again shortly.",
      );
    }
    const app = options.phoneApps !== undefined && isPhoneAppOperation(route.operation);
    const collection =
      options.phoneCollections !== undefined && isPhoneCollectionOperation(route.operation);
    const sketch = isPhoneSketchOperation(route.operation);
    const fileWrite = isAccountFileWriteOperation(route.operation);
    const docCollectionRead = isPhoneDocumentCollectionReadOperation(route.operation);
    const docCollectionWrite = isPhoneDocumentCollectionWriteOperation(route.operation);
    const write = isPhoneWriteOperation(route.operation);
    const memberWrite = route.operation === "post" || route.operation === "reply";
    if (
      !feed &&
      !wakeFeed &&
      !app &&
      !collection &&
      !page &&
      !sketch &&
      !fileWrite &&
      !write &&
      !docCollectionRead &&
      !docCollectionWrite &&
      options.copies() === undefined
    )
      throw copiesUnavailable();
    const joinedAllowed =
      feed || app || collection || page || memberWrite || isAccountOperation(route.operation);
    const owner = storage.workspaceOwner(route.workspaceId);
    const reaches = (userId: string) => {
      if (browser) return storage.workspaceIsOwnedBy(route.workspaceId, userId);
      const role = storage.phoneRole(userId, route.workspaceId);
      return role === "owner" || (role !== null && joinedAllowed);
    };
    const memberOf = (userId: string): PhoneMember | null => {
      if (userId === owner) return null;
      const found = phoneMember(storage, route.workspaceId, userId);
      if (found === null) throw notFound();
      return found;
    };
    const mark = route.operation === "markRead";
    const retry = route.operation === "retryWake";
    const context = route.operation === "chatContext";
    if (
      !(
        feed ||
        wakeFeed ||
        app ||
        collection ||
        docCollectionRead ||
        docCollectionWrite ||
        fileWrite ||
        write ||
        sketch ||
        mark ||
        retry ||
        context ||
        page ||
        isAccountOperation(route.operation)
      ) ||
      !reaches(caller.userId) ||
      owner === null
    )
      throw notFound();
    if ((sketch || fileWrite || docCollectionWrite) && options.copies() === undefined)
      throw copiesUnavailable();
    if (caller.userId !== owner)
      await options.refreshAccountEmail?.(caller.userId, readSignal ?? request.signal);
    const member = memberOf(caller.userId);
    const check = async (sameReach: boolean) => {
      const current = await checkSignIn();
      if (
        current.sessionId !== caller.sessionId ||
        current.userId !== caller.userId ||
        !reaches(caller.userId) ||
        storage.workspaceOwner(route.workspaceId) !== owner
      )
        throw notFound();
      if (
        sameReach &&
        memberOf(caller.userId)?.selector.reach.signature() !== member?.selector.reach.signature()
      )
        throw new RelayError(
          "server_busy",
          "Your access to this workspace changed. Try again.",
          503,
        );
    };
    const authorize = () => check(true);
    if (feed) {
      const url = new URL(request.url);
      const hold = url.searchParams.get("hold");
      const answer = await readAccountFeed(storage, options.feedWaits, {
        workspaceId: route.workspaceId,
        userId: caller.userId,
        caller: caller.sessionId,
        since: url.searchParams.get("since"),
        holdMs: hold === null ? 0 : parseLogHold(hold),
        signal: request.signal,
        member: () => memberOf(caller.userId),
        authorize: () => check(false),
      });
      await check(false);
      const now = memberOf(caller.userId);
      if (!cursorReaches(answer.cursor, now))
        return jsonResponse({
          ok: true,
          cursor: currentAccountFeedCursor(storage, route.workspaceId, now),
          replace: true,
        });
      return jsonResponse({ ok: true, ...answer });
    }
    if (wakeFeed) {
      const url = new URL(request.url);
      const hold = url.searchParams.get("hold");
      // It checks access last, then judges the threads it answers, with nothing awaited between.
      const answer = await readWakeChanges(storage, options.wakeWaits, {
        workspaceId: route.workspaceId,
        accountId: caller.userId,
        sessionId: caller.sessionId,
        since: url.searchParams.get("since"),
        holdMs: hold === null ? 0 : parseLogHold(hold),
        signal: request.signal,
        authorize,
      });
      return jsonResponse({ ok: true, ...answer });
    }
    const maxBodyBytes =
      route.operation === "saveSketch"
        ? SAVE_SKETCH_MAX_BODY_BYTES
        : ACCOUNT_OPERATION_MAX_BODY_BYTES;
    const bodyReceiptMs =
      route.operation === "saveSketch" ? SAVE_SKETCH_BODY_RECEIPT_MS : BODY_RECEIPT_MS;
    let args: unknown;
    try {
      args = await readBoundedJson(
        request,
        maxBodyBytes,
        AbortSignal.any([request.signal, AbortSignal.timeout(bodyReceiptMs)]),
      );
    } catch (error) {
      throw error instanceof RangeError
        ? relayError("payload_too_large")
        : badRequest("request body must be valid JSON");
    }
    await authorize();
    // Synchronous on the relay's tables, so nothing changes between the check above and the answer. A read that shows
    // authors' names looks them up first, then checks the sign-in again.
    if (app) {
      const names = await options.phoneApps!.names(route.workspaceId, route.operation, args);
      if (names) await authorize();
      return jsonResponse({
        ok: true,
        result: options.phoneApps!.run(
          caller,
          route.workspaceId,
          route.operation,
          args,
          names ?? undefined,
        ),
      });
    }
    // A read checks the sign-in, the owner and Show on phone again after its wait, and before it answers.
    if (collection)
      return await options.phoneCollections!.respond({
        caller,
        member,
        workspaceId: route.workspaceId,
        operation: route.operation,
        args,
        authorize,
        signal: request.signal,
      });
    if (isPhoneDocumentCollectionReadOperation(route.operation)) {
      const { result, cursor } = runPhoneDocumentCollectionRead(storage, {
        workspaceId: route.workspaceId,
        operation: route.operation,
        args,
      });
      return jsonResponse({ ok: true, result, cursor });
    }
    // A page open reads only the relay's own tables and the live host.
    if (page) {
      const pages = options.phonePages?.();
      const result = pages
        ? await pages.open({
            caller,
            member,
            workspaceId: route.workspaceId,
            args,
            authorize,
            signal: request.signal,
          })
        : { status: "refused", reason: "live_hosting_unsupported" };
      return jsonResponse({ ok: true, result });
    }
    // A Bearer session reaches what shows on the phone, whatever the request says.
    const visitor = {
      reason: "account",
      userId: caller.userId,
      caller: caller.sessionId,
      signal: readSignal ?? request.signal,
      phone: true,
    } as const;
    if (write) {
      const parsed = parsePhoneWrite(route.operation, args);
      if (member !== null) {
        if (parsed.operation !== "post" && parsed.operation !== "reply") throw notFound();
        if (
          parsed.args.needsDecision !== undefined ||
          parsed.args.options !== undefined ||
          (parsed.operation === "reply" && parsed.args.resolves !== undefined)
        )
          throw badRequest("decisions are not supported");
        const replyAnswer = async (result: unknown) => {
          await check(false);
          return jsonResponse({
            ok: true,
            result,
            cursor: currentAccountFeedCursor(storage, route.workspaceId, memberOf(caller.userId)),
          });
        };
        const channelWireId =
          parsed.operation === "post"
            ? parsed.args.groupId
            : storage.findThreadCreateChannelWireId(route.workspaceId, parsed.args.threadId);
        if (typeof channelWireId !== "string")
          return await replyAnswer({
            ok: false,
            refusal: "missing",
            reason: `chat thread not found: ${parsed.operation === "reply" ? parsed.args.threadId : ""}`,
          });
        const authorizeMemberGroup = (action: "read" | "append") => {
          const role = storage.phoneRole(caller.userId, route.workspaceId);
          if (
            role === null ||
            role === "owner" ||
            storage.workspaceOwner(route.workspaceId) !== owner
          )
            throw notFound();
          const fresh = phoneMember(storage, route.workspaceId, caller.userId);
          if (
            fresh === null ||
            fresh.shareId !== member.shareId ||
            fresh.grantId !== member.grantId
          )
            throw notFound();
          if (
            !workspaceGroupReachable(fresh.selector, channelWireId, {
              channelKind: (wireId) => storage.findChannelCreateKind(route.workspaceId, wireId),
            })
          )
            throw new MemberTargetMissing(
              parsed.operation === "post"
                ? `no such group: ${channelWireId}`
                : `chat thread not found: ${parsed.args.threadId}`,
            );
          if (action === "read") {
            return {
              share: { shareId: fresh.shareId, workspaceId: route.workspaceId },
              effectiveSelector: fresh.selector,
            };
          }
          const granted = authorizeShareGrantAction({
            storage,
            grantId: fresh.grantId,
            action: "append",
            principal: { kind: "user", userId: caller.userId },
          });
          if (!granted.ok)
            throw granted.reason === "denied" ? relayError("share_read_only") : notFound();
          if (
            granted.share.workspaceId !== route.workspaceId ||
            granted.share.shareId !== member.shareId ||
            !isWorkspaceSelector(granted.effectiveSelector)
          )
            throw notFound();
          if (workspaceChatAccess(granted.effectiveSelector, channelWireId) !== "read-write")
            throw relayError("share_read_only");
          if (
            parsed.operation === "post" &&
            storage
              .listChannelCreates(route.workspaceId)
              .find((group) => group.channelWireId === channelWireId)?.type === "chat"
          )
            throw relayError("share_op_rejected");
          return {
            share: { shareId: granted.share.shareId, workspaceId: granted.share.workspaceId },
            effectiveSelector: granted.effectiveSelector,
          };
        };
        try {
          const saved = await appendNamedChatMessage({
            storage,
            workspaceId: route.workspaceId,
            shareId: member.shareId,
            userId: caller.userId,
            humanOnly: true,
            allowPostParent: true,
            redactFileLinks: true,
            bindRequest: true,
            channelWireId,
            id: parsed.args.operationId,
            body: parsed.args.body,
            ...(parsed.operation === "post"
              ? { lane: "posts" as const, title: parsed.args.title }
              : { threadId: parsed.args.threadId, parentMessageId: parsed.args.parentMessageId }),
            nowMs: () => options.nowMs(),
            signal: visitor.signal,
            lookupUserDisplayName: options.lookupUserDisplayName,
            refreshMentionAccountNames: options.refreshMentionAccountNames,
            activity: options.activity,
            authorizeRetry: () => {
              authorizeMemberGroup("read");
            },
            authorizeAppend: () => authorizeMemberGroup("append"),
            requireParentMessage: (tid, parentId) => {
              if (!storage.hasThreadMessage(route.workspaceId, tid, parentId))
                throw new MemberTargetMissing(`chat message not found: ${parentId}`);
            },
            afterNameLookup: () => check(false),
          });
          return await replyAnswer({
            ok: true,
            state: "saved",
            threadId: saved.threadId,
            messageId: saved.messageId,
          });
        } catch (error) {
          if (error instanceof MemberTargetMissing)
            return await replyAnswer({ ok: false, refusal: "missing", reason: error.reason });
          if (
            error instanceof SyncRelayConflictError ||
            (error instanceof RelayError &&
              (error.code === "share_read_only" || error.code === "share_op_rejected"))
          )
            return await replyAnswer({ ok: false, refusal: "refused", reason: COULD_NOT_SEND });
          throw error;
        }
      }
      // The author is the session's account, by the name it has now.
      const displayName = await accountDisplayName(options.lookupUserDisplayName, caller.userId);
      await authorize();
      const copies = options.copies();
      if (copies === undefined || options.serverUrl === undefined) throw copiesUnavailable();
      const { result, cursor } = await runAccountWrite(
        { storage, copies },
        {
          workspaceId: route.workspaceId,
          write: parsed,
          visitor,
          authorize,
          writer: { accountId: caller.userId, displayName, serverUrl: options.serverUrl },
          // One clock with the runner declarations, so their leases read the same here.
          nowMs: () => options.nowMs(),
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    const copies = options.copies();
    if (copies === undefined) throw copiesUnavailable();
    if (isPhoneSketchOperation(route.operation)) {
      const { result, cursor } = await runPhoneSketchOperation(
        { storage, copies },
        {
          owner,
          workspaceId: route.workspaceId,
          operation: route.operation,
          args,
          visitor,
          authorize,
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    if (isPhoneDocumentCollectionWriteOperation(route.operation)) {
      const { result, cursor } = await runPhoneDocumentCollectionWrite(
        { storage, copies },
        {
          workspaceId: route.workspaceId,
          owner,
          operation: route.operation,
          args,
          visitor,
          authorize,
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    if (isAccountFileWriteOperation(route.operation)) {
      const { result, cursor } = await runAccountFileWrite(
        { storage, copies, liveHost: options.liveHost, liveRooms: options.liveRooms },
        {
          workspaceId: route.workspaceId,
          owner,
          operation: route.operation,
          args,
          visitor,
          authorize,
          nowMs: () => options.nowMs(),
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    if (context) {
      const { result, cursor } = await runAccountChatContext(
        { storage, copies },
        {
          workspaceId: route.workspaceId,
          accountId: caller.userId,
          target: parseChatContext(args),
          visitor,
          authorize,
          // One clock with the runner declarations and the wakes, so leases and waits read the same here.
          nowMs: () => options.nowMs(),
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    if (retry) {
      const { result, cursor } = await runAccountRetryWake(
        { storage, copies },
        {
          workspaceId: route.workspaceId,
          accountId: caller.userId,
          retry: parseRetryWake(args),
          visitor,
          authorize,
          nowMs: () => options.nowMs(),
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    if (mark) {
      const { result, cursor } = await runAccountMarkRead(
        { storage, copies },
        {
          workspaceId: route.workspaceId,
          accountId: caller.userId,
          mark: parseMarkRead(args),
          visitor,
          authorize,
        },
      );
      return jsonResponse({ ok: true, result, cursor });
    }
    const { result, cursor } = await runAccountOperation(
      { storage, copies },
      {
        owner,
        member,
        workspaceId: route.workspaceId,
        operation: route.operation,
        args,
        authorize,
        visitor,
      },
    );
    return jsonResponse({ ok: true, result, cursor });
  };

  return async function respondToAccountOperation(
    request: Request,
    route: AccountOperationRoute,
  ): Promise<Response> {
    if (request.method === "POST" && isAccountOperation(route.operation))
      return await withAccountReadDeadline(request.signal, (signal) =>
        respond(request, route, signal),
      );
    return await respond(request, route, undefined);
  };
}
