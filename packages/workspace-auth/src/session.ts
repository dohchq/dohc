import type { Actor } from "@dohc/workspace-contracts";
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
