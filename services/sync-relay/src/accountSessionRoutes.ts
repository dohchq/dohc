import { randomBytes } from "node:crypto";
import { jsonResponse } from "@dohc/service-http";
import {
  UnauthorizedError,
  type AccountSessions,
  type ResolveAccountSession,
} from "@dohc/workspace-auth/session";
import type { AccountFeedWaits } from "./accountFeed";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { notFound, relayError } from "./errors";
import { accountIsFenced } from "./storage/accountDeletion";
import type { SyncRelayStorage } from "./storage";
import type { OwnerLiveSockets } from "./namedLiveRoutes";

export type AccountSessionRoute =
  | { route: "account-sessions" }
  | { route: "account-session-revoke"; sessionId: string };

/**
 * How long a revoke's fence holds before the account server answers. The
 * answer replaces it with the session's own expiry, or removes it. A revoke
 * that throws, or a relay that stops mid-revoke, leaves it until then.
 */
const REVOKE_FENCE_MS = 10 * 60_000;

/** A client sends its user agent with no length limit, so the list shows this many characters of it. */
export const ACCOUNT_SESSION_CLIENT_MAX_CHARS = 256;

/** Parses `/sync/account/sessions/...` after its first two segments. */
export function parseAccountSessionRoute(parts: readonly string[]): AccountSessionRoute {
  if (parts.length === 3) return { route: "account-sessions" };
  // An ID Better Auth could not have made answers like a session this account does not have.
  if (parts.length !== 5 || parts[4] !== "revoke" || !/^[A-Za-z0-9_-]{1,128}$/.test(parts[3]!))
    throw notFound();
  return { route: "account-session-revoke", sessionId: parts[3]! };
}

/**
 * An account's sign-ins, and ending one of them. Only a Bearer session reaches
 * them, and no answer carries a session token. A session another account holds
 * answers exactly as one that does not exist.
 */
export function createAccountSessionRoutes(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
  sessions: AccountSessions;
  feedWaits: Pick<AccountFeedWaits, "wakeAccount">;
  nowMs: () => number;
  sockets: Pick<OwnerLiveSockets, "stopSession">;
  /** Runs once a session is revoked. */
  revoked?(userId: string, sessionId: string): void;
}) {
  const { storage, sessions } = options;

  return async function respondToAccountSessions(
    request: Request,
    route: AccountSessionRoute,
  ): Promise<Response> {
    if (request.method !== (route.route === "account-sessions" ? "GET" : "POST"))
      throw relayError("method_not_allowed");
    const caller = await bearerAccountSession(storage, options.resolveAccountSession, request);
    if (route.route === "account-session-revoke") {
      // Registrations stop before the session goes, so a lookup already in flight can't bind after it.
      const fence = {
        userId: caller.userId,
        sessionId: route.sessionId,
        attemptId: randomBytes(16).toString("base64url"),
      };
      storage.fencePushSession({ ...fence, expiresAtMs: options.nowMs() + REVOKE_FENCE_MS });
      // The store deletes the row only while the caller's own session is current. Revoking that session signs it out.
      // If this throws, the delete may still have landed, so the fence stays until its own expiry.
      const revokedExpiresAtMs = await sessions.revoke({
        userId: caller.userId,
        callerSessionId: caller.sessionId,
        sessionId: route.sessionId,
      });
      if (revokedExpiresAtMs === null) {
        storage.settlePushSessionFence({ ...fence, revokedExpiresAtMs });
        throw notFound();
      }
      // Its live connections end before the answer, first, since nothing here can fail. A feed held under it checks
      // it now, instead of at the end of its hold.
      options.sockets.stopSession(caller.userId, route.sessionId);
      options.feedWaits.wakeAccount(caller.userId);
      // A revoked session's alerts end before the answer, with every delivery queued for them.
      storage.settlePushSessionFence({ ...fence, revokedExpiresAtMs });
      options.revoked?.(caller.userId, route.sessionId);
      return jsonResponse({ ok: true, sessionId: route.sessionId });
    }
    const listed = await sessions.list(caller.userId);
    // The list is one snapshot. If the caller's session is missing from it, the caller was signed out meanwhile.
    if (!listed.some((session) => session.sessionId === caller.sessionId))
      throw new UnauthorizedError();
    if (accountIsFenced(storage, caller.userId)) throw notFound();
    return jsonResponse({
      ok: true,
      sessions: listed.map((session) => ({
        sessionId: session.sessionId,
        createdAtMs: session.createdAtMs,
        client:
          session.userAgent === null
            ? null
            : [...session.userAgent].slice(0, ACCOUNT_SESSION_CLIENT_MAX_CHARS).join(""),
        current: session.sessionId === caller.sessionId,
      })),
    });
  };
}
