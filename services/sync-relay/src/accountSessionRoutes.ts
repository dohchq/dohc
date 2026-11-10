import { jsonResponse } from "@dohc/service-http";
import { UnauthorizedError, type AccountSessions, type ResolveAccountSession } from "@dohc/workspace-auth/session";
import type { AccountFeedWaits } from "./accountFeed";
import { bearerAccountSession } from "./accountWorkspaceRoutes";
import { notFound, relayError } from "./errors";
import { accountIsFenced } from "./storage/accountDeletion";
import type { SyncRelayStorage } from "./storage";

export type AccountSessionRoute =
  | { route: "account-sessions" }
  | { route: "account-session-revoke"; sessionId: string };

/** A client sends its user agent with no length limit, so the list shows this many characters of it. */
export const ACCOUNT_SESSION_CLIENT_MAX_CHARS = 256;

/** Parses `/sync/account/sessions/...` after its first two segments. */
export function parseAccountSessionRoute(parts: readonly string[]): AccountSessionRoute {
  if (parts.length === 3) return { route: "account-sessions" };
  // An ID Better Auth could not have made answers like a session this account does not have.
  if (parts.length !== 5 || parts[4] !== "revoke" || !/^[A-Za-z0-9_-]{1,128}$/.test(parts[3]!)) throw notFound();
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
}) {
  const { storage, sessions } = options;

  return async function respondToAccountSessions(request: Request, route: AccountSessionRoute): Promise<Response> {
    if (request.method !== (route.route === "account-sessions" ? "GET" : "POST")) throw relayError("method_not_allowed");
    const caller = await bearerAccountSession(storage, options.resolveAccountSession, request);
    if (route.route === "account-session-revoke") {
      // The store deletes the row only while the caller's own session is current. Revoking that session signs it out.
      if (!await sessions.revoke({ userId: caller.userId, callerSessionId: caller.sessionId, sessionId: route.sessionId })) throw notFound();
      // A feed held under the revoked session checks it now, instead of at the end of its hold.
      options.feedWaits.wakeAccount(caller.userId);
      return jsonResponse({ ok: true, sessionId: route.sessionId });
    }
    const listed = await sessions.list(caller.userId);
    // The list is one snapshot. If the caller's session is missing from it, the caller was signed out meanwhile.
    if (!listed.some(session => session.sessionId === caller.sessionId)) throw new UnauthorizedError();
    if (accountIsFenced(storage, caller.userId)) throw notFound();
    return jsonResponse({ ok: true, sessions: listed.map(session => ({
      sessionId: session.sessionId,
      createdAtMs: session.createdAtMs,
      client: session.userAgent === null ? null : [...session.userAgent].slice(0, ACCOUNT_SESSION_CLIENT_MAX_CHARS).join(""),
      current: session.sessionId === caller.sessionId,
    })) });
  };
}
