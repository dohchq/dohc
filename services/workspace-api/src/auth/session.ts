import type { Actor } from "@dohc/workspace-contracts";
import { actorFromSession, type WorkspaceAuth } from "./betterAuth";

export type ResolveActor = (request: Request, workspaceId: string) => Actor | Promise<Actor>;

// Thrown shape the API layer maps to a 401 — statusForError keys on `code`.
export class UnauthorizedError extends Error {
  readonly statusCode = 401;
  readonly code = "unauthorized";
  constructor() {
    super("unauthorized");
  }
}

// The production ResolveActor: identity comes ONLY from a validated Better
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

// Local-only desktop flows never construct a cloud client, so they never hit
// this resolver — auth is required only once a request reaches the cloud API.
export async function resolveSessionActor(_request: Request, _workspaceId: string): Promise<Actor> {
  throw new Error(
    "workspace API requires a server-side actor resolver (wire createSessionActorResolver)",
  );
}
