import { isApprovalErrorReason } from "@dohc/workspace-contracts";
import type { Actor, WorkspaceErrorCode } from "@dohc/workspace-contracts";
import type { ResolveActor } from "@dohc/workspace-auth/session";
import { mintCollabToken, type CollabTokenDeps, type CollabTokenRequest } from "./routes/collab";

// The reduced dohc Cloud surface: this service is now collab + auth only. Its
// single application route is the collab-token endpoint the desktop calls to
// join a live co-editing session (POST /workspaces/:id/collab/token); auth is
// mounted in main.ts via @dohc/workspace-auth. The former sharing/members/
// invites/files/sync/workspaces surface was retired with apps/web.

export type WorkspaceApiHandler = (request: Request) => Promise<Response>;

export type CreateWorkspaceApiHandlerOptions = {
  resolveActor: ResolveActor;
  // The collab-token minter's deps (Postgres pool + the HS256 secret shared
  // with hocuspocus). Unset deployments 400 the collab route (collab-disabled).
  collab?: CollabTokenDeps;
};

export function createWorkspaceApiHandler({
  resolveActor,
  collab,
}: CreateWorkspaceApiHandlerOptions): WorkspaceApiHandler {
  return async (request) => {
    try {
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      // POST /workspaces/:id/collab/token
      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "workspaces" &&
        parts[1] &&
        parts[2] === "collab" &&
        parts[3] === "token"
      ) {
        const actor = await actorForRequest(resolveActor, request, parts[1]);
        return jsonResponse(
          await mintCollabToken(collab, actor, await readJson<CollabTokenRequest>(request)),
        );
      }

      return jsonResponse({ ok: false, error: "route not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

async function actorForRequest(
  resolveActor: ResolveActor,
  request: Request,
  workspaceId: string,
): Promise<Actor> {
  const actor = await resolveActor(request, workspaceId);
  return { ...actor, workspaceId };
}

async function readJson<T>(request: Request): Promise<T> {
  const raw = await request.text();
  if (!raw.trim()) throw badRequest("request body must be valid JSON");
  return JSON.parse(raw) as T;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
  const path = typeof error === "object" && error && "path" in error ? String((error as { path?: unknown }).path) : undefined;
  return jsonResponse(
    {
      ok: false,
      error: message,
      ...(code ? { code } : {}),
      ...(path ? { path } : {}),
    },
    statusForError(message, code),
  );
}

function statusForError(message: string, code?: string) {
  switch (normalizeErrorCode(code)) {
    case "unauthorized":
      return 401;
    case "forbidden":
    case "locked":
    case "review_required":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "unsupported_media_type":
      return 415;
    case "invalid_path":
    case "invalid_manifest":
      return 400;
  }
  if (isApprovalErrorReason(code) || isApprovalErrorReason(message)) {
    return 403;
  }
  if (/stale|revision|conflict/i.test(message)) return 409;
  if (/not found|missing/i.test(message)) return 404;
  return 400;
}

function normalizeErrorCode(code?: string): WorkspaceErrorCode | undefined {
  if (!code) return undefined;
  const normalized = code.replace(/-/g, "_");
  if (
    normalized === "unauthorized" ||
    normalized === "forbidden" ||
    normalized === "not_found" ||
    normalized === "conflict" ||
    normalized === "locked" ||
    normalized === "review_required" ||
    normalized === "invalid_path" ||
    normalized === "invalid_manifest" ||
    normalized === "unsupported_media_type"
  ) {
    return normalized;
  }
  return undefined;
}

function badRequest(message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = "invalid-manifest";
  return error;
}
