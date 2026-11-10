import { jsonResponse, readBoundedJson, TokenBucketLimiter } from "@dohc/service-http";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import { isAccountOperation, runAccountOperation } from "./accountOperations";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { badRequest, notFound, RelayError, relayError } from "./errors";
import { parseWorkspaceId } from "./requestInputs";
import type { ServerCopies } from "./serverCopies";
import type { SyncRelayStorage } from "./storage";

export type AccountOperationRoute = { route: "account-operation"; workspaceId: string; operation: string };

/** The most an operation's arguments take. */
const ACCOUNT_OPERATION_MAX_BODY_BYTES = 256 * 1024;
// How long the arguments take to arrive.
const BODY_RECEIPT_MS = 10_000;

/** One sign-in's reads: a burst for opening a workspace, then a steady pace. */
export function createAccountOperationRateLimiter(): TokenBucketLimiter {
  return new TokenBucketLimiter(60, 2, 4096);
}

/** Parses `/sync/:workspaceId/ops/:operation`, already split into segments. */
export function parseAccountOperationRoute(parts: readonly string[]): AccountOperationRoute {
  // An ID that cannot be a workspace answers as one this account does not own.
  try { return { route: "account-operation", workspaceId: parseWorkspaceId(parts[1]), operation: parts[3]! }; }
  catch { throw notFound(); }
}

/**
 * A signed-in account's reads of a workspace it owns, through this server's
 * copy of it, while it shows on the phone. Only a Bearer session reaches
 * them, and the route checks the operation and the owner before it reads the
 * arguments. The sign-in, its fence, the owner and "Show on phone" are
 * checked again once the arguments arrive, once the copy is open, once it
 * has synced, and once the answer is ready. A workspace the account does not own, one that does not exist,
 * and an ID that cannot be one answer alike.
 */
export function createAccountOperationRoute(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
  copies(): ServerCopies | undefined;
  nowMs(): number;
  /** Keyed by sign-in. */
  limiter: TokenBucketLimiter;
}) {
  const { storage, limiter } = options;
  const session = (request: Request) => bearerAccountSession(storage, options.resolveAccountSession, request);

  return async function respondToAccountOperation(request: Request, route: AccountOperationRoute): Promise<Response> {
    if (request.method !== "POST") throw relayError("method_not_allowed");
    const caller = await session(request);
    if (!limiter.allow(caller.sessionId, options.nowMs())) {
      throw new RelayError("server_busy", "This sign-in is reading faster than your server answers. Try again shortly.");
    }
    // The phone reaches a workspace its account owns while it shows on the phone.
    const reaches = (userId: string) =>
      storage.workspaceIsOwnedBy(route.workspaceId, userId) && storage.showsOnPhone(userId, route.workspaceId);
    if (!isAccountOperation(route.operation) || !reaches(caller.userId)) throw notFound();
    const authorize = async () => {
      const current = await session(request);
      if (current.sessionId !== caller.sessionId || current.userId !== caller.userId || !reaches(caller.userId)) throw notFound();
    };
    let args: unknown;
    try {
      args = await readBoundedJson(request, ACCOUNT_OPERATION_MAX_BODY_BYTES, AbortSignal.any([request.signal, AbortSignal.timeout(BODY_RECEIPT_MS)]));
    } catch (error) {
      throw error instanceof RangeError ? relayError("payload_too_large") : badRequest("request body must be valid JSON");
    }
    await authorize();
    const copies = options.copies();
    if (copies === undefined) throw notFound();
    const result = await runAccountOperation({ storage, copies }, {
      owner: caller.userId, workspaceId: route.workspaceId, operation: route.operation, args, authorize,
      // A Bearer session reads what shows on the phone, whatever the request says.
      visitor: { reason: "account", caller: caller.sessionId, signal: request.signal, phone: true },
    });
    return jsonResponse({ ok: true, result });
  };
}
