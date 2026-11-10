import type { Actor } from "@dohc/workspace-contracts";
import type { Pool } from "pg";
import type { WorkspaceAuth } from "./betterAuth";

export type ResolveActor = (request: Request, workspaceId: string) => Actor | Promise<Actor>;

// The caller supplies a validated session. Identity comes from its user,
// and the downstream authorization check enforces workspace membership.
export function actorFromSession(
  session: { user: { id: string } },
  workspaceId: string,
): Actor {
  return { userId: session.user.id, workspaceId };
}

// Thrown shape the API layer maps to a 401 — statusForError keys on `code`.
export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly code = "unauthorized";
  constructor() {
    super("unauthorized");
  }
}

// The production ResolveActor: identity comes only from a validated Better
// Auth session (Bearer token from the desktop's device-flow login, or a
// browser cookie) — never from client-supplied ids. Workspace MEMBERSHIP is
// enforced downstream by the backend's authz (assertWorkspaceMember), which
// consumes the Actor this returns.
export function createSessionActorResolver(auth: WorkspaceAuth): ResolveActor {
  return async (request, workspaceId) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new UnauthorizedError();
    return actorFromSession(session, workspaceId);
  };
}

/** The account and the one sign-in a request was validated under. */
export interface AccountSession {
  userId: string;
  sessionId: string;
  expiresAtMs: number;
  displayName?: string;
}

export type ResolveAccountSession = (request: Request) => Promise<AccountSession>;

// State bound to a sign-in, such as a browser's push subscription, ends with
// it: signing out or in again gives a different session id.
export function accountSessionFrom(session: {
  user: { id: string; name?: string };
  session: { id: string; userId: string; expiresAt: Date | string | number };
}): AccountSession {
  const expiresAtMs = new Date(session.session.expiresAt).getTime();
  if (session.session.userId !== session.user.id || !session.session.id || !Number.isSafeInteger(expiresAtMs)) {
    throw new UnauthorizedError();
  }
  return { userId: session.user.id, sessionId: session.session.id, expiresAtMs,
    ...(typeof session.user.name === "string" ? {displayName: session.user.name} : {}) };
}

export function createAccountSessionResolver(auth: WorkspaceAuth): ResolveAccountSession {
  return async (request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) throw new UnauthorizedError();
    return accountSessionFrom(session);
  };
}

/** One of an account's sign-ins as its owner may see it. It never carries the session token. */
export interface AccountSessionSummary {
  sessionId: string;
  createdAtMs: number;
  /** The client's user agent when it signed in; null when it sent none. */
  userAgent: string | null;
}

export interface AccountSessions {
  /** The account's unexpired sessions, newest first. */
  list(userId: string): Promise<AccountSessionSummary[]>;
  /**
   * Deletes one of the account's unexpired sessions while the caller's own is
   * still current. False when either is missing, expired, or another account's.
   */
  revoke(input: { userId: string; callerSessionId: string; sessionId: string }): Promise<boolean>;
}

// Reads Better Auth's session table directly, because its own list returns every session's token.
export function createPostgresAccountSessions(pool: Pool): AccountSessions {
  return {
    async list(userId) {
      const result = await pool.query<{ id: string; createdAt: Date; userAgent: string | null }>(
        'select "id", "createdAt", "userAgent" from "session" where "userId" = $1 and "expiresAt" > now() order by "createdAt" desc, "id"',
        [userId],
      );
      return result.rows.map(row => ({ sessionId: row.id, createdAtMs: row.createdAt.getTime(), userAgent: row.userAgent || null }));
    },
    async revoke({ userId, callerSessionId, sessionId }) {
      const result = await pool.query(
        `delete from "session" where "id" = $1 and "userId" = $2 and "expiresAt" > now()
          and exists (select 1 from "session" where "id" = $3 and "userId" = $2 and "expiresAt" > now())`,
        [sessionId, userId, callerSessionId],
      );
      return result.rowCount === 1;
    },
  };
}
