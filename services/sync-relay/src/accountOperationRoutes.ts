import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import {
  isPhoneWriteOperation,
  parseMarkRead,
  parsePhoneWrite,
  parseRetryWake,
  runAccountMarkRead,
  runAccountRetryWake,
  runAccountWrite,
} from "./accountChatWrites";
import { accountDisplayName, type LookupUserDisplayName } from "./accountDisplayName";
import { readAccountFeed, type AccountFeedWaits } from "./accountFeed";
import { isAccountOperation, runAccountOperation } from "./accountOperations";
import { parseChatContext, readWakeChanges, runAccountChatContext } from "./accountTalkContext";
import { isPhoneAppOperation, type PhoneApps } from "./phoneApps";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import type { ChatWakeWaits } from "./chatWakeRoutes";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import type { PhonePages } from "./phonePages";
import { parseWorkspaceId } from "./requestInputs";
import type { ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";
import { parseLogHold } from "./workspaceReplicationRoutes";

export type AccountOperationRoute = {
  route: "account-operation";
  workspaceId: string;
  operation: string;
};

const ACCOUNT_OPERATION_MAX_BODY_BYTES = 256 * 1024;
// How long the arguments take to arrive.
const BODY_RECEIPT_MS = 10_000;

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
 * phone; its published apps (phoneApps.ts); its change feed, at
 * `GET .../ops/changes?since=&hold=`; and its wake changes there, at
 * `GET .../ops/wakeChanges?since=&hold=`. Only a Bearer session
 * reaches them, and the route checks the operation and the owner before it
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
  /** The account's name, which a write's author takes. */
  lookupUserDisplayName?: LookupUserDisplayName;
  /** This server's public origin, which issues its accounts' actor keys. Writes need it. */
  serverUrl?: string;
  /** The workspace's published apps, their review and approval, and launch grants. */
  phoneApps?: PhoneApps;
  /** Opens a page for the phone to edit live. Absent while this server hosts no live pages. */
  phonePages?: () => PhonePages | undefined;
}) {
  const { storage, limiter } = options;
  const session = (request: Request) =>
    bearerAccountSession(storage, options.resolveAccountSession, request);

  return async function respondToAccountOperation(
    request: Request,
    route: AccountOperationRoute,
  ): Promise<Response> {
    const feed = route.operation === "changes" && request.method === "GET";
    const wakeFeed = route.operation === "wakeChanges" && request.method === "GET";
    if (!feed && !wakeFeed && request.method !== "POST") throw relayError("method_not_allowed");
    const caller = await session(request);
    const page = route.operation === "openPage";
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
    // The feeds, the app operations, and a page open read only the relay's own tables and its live host; every other
    // operation needs a copy.
    if (!feed && !wakeFeed && !app && !page && options.copies() === undefined)
      throw copiesUnavailable();
    // The phone reaches a workspace its account owns while it shows on the phone.
    const reaches = (userId: string) =>
      storage.workspaceIsOwnedBy(route.workspaceId, userId) &&
      storage.showsOnPhone(userId, route.workspaceId);
    const write = isPhoneWriteOperation(route.operation);
    const mark = route.operation === "markRead";
    const retry = route.operation === "retryWake";
    const context = route.operation === "chatContext";
    if (
      !(
        feed ||
        wakeFeed ||
        app ||
        write ||
        mark ||
        retry ||
        context ||
        page ||
        isAccountOperation(route.operation)
      ) ||
      !reaches(caller.userId)
    )
      throw notFound();
    const authorize = async () => {
      const current = await session(request);
      if (
        current.sessionId !== caller.sessionId ||
        current.userId !== caller.userId ||
        !reaches(caller.userId)
      )
        throw notFound();
    };
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
        authorize,
      });
      await authorize();
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
    let args: unknown;
    try {
      args = await readBoundedJson(
        request,
        ACCOUNT_OPERATION_MAX_BODY_BYTES,
        AbortSignal.any([request.signal, AbortSignal.timeout(BODY_RECEIPT_MS)]),
      );
    } catch (error) {
      throw error instanceof RangeError
        ? relayError("payload_too_large")
        : badRequest("request body must be valid JSON");
    }
    await authorize();
    // Synchronous on the relay's tables, so nothing changes between the check above and the answer.
    if (app)
      return jsonResponse({
        ok: true,
        result: options.phoneApps!.run(caller, route.workspaceId, route.operation, args),
      });
    // A page open reads only the relay's own tables and the live host.
    if (page) {
      const pages = options.phonePages?.();
      const result = pages
        ? await pages.open({
            caller,
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
      caller: caller.sessionId,
      signal: request.signal,
      phone: true,
    } as const;
    if (write) {
      const parsed = parsePhoneWrite(route.operation, args);
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
        owner: caller.userId,
        workspaceId: route.workspaceId,
        operation: route.operation,
        args,
        authorize,
        visitor,
      },
    );
    return jsonResponse({ ok: true, result, cursor });
  };
}
