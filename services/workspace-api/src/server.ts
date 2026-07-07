// The reduced dohc Cloud surface: this service is now AUTH ONLY. Better Auth is
// mounted in main.ts on /api/auth/* (the desktop's device sign-in flow mints
// the bearer tokens the sync-relay validates); this handler owns NO application
// routes and 404s everything that is not an auth/health/test route. The former
// sharing/members/invites/files/sync/workspaces surface was retired with
// apps/web, and the live co-editing collab-token route was retired with
// Hocuspocus (G2-C-3) — co-editing is now engine-native over the sync-relay.

export type WorkspaceApiHandler = (request: Request) => Promise<Response>;

export function createWorkspaceApiHandler(): WorkspaceApiHandler {
  return async () =>
    new Response(JSON.stringify({ ok: false, error: "route not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
}
