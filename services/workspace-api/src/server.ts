// The reduced dohc Cloud surface: this service is now AUTH ONLY. Better Auth is
// mounted in main.ts on /api/auth/* (the desktop's device sign-in flow mints
// the bearer tokens the sync relay validates). This handler owns no application
// routes and returns 404 for everything outside auth, health, and test routes.

export type WorkspaceApiHandler = (request: Request) => Promise<Response>;

export function createWorkspaceApiHandler(): WorkspaceApiHandler {
  return async () =>
    new Response(JSON.stringify({ ok: false, error: "route not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
}
