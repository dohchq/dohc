import type { Actor, WorkspaceBackend, WorkspaceErrorCode } from "@dohc/workspace-contracts";
import type { ResolveActor } from "./auth/session";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  uploadWorkspaceAsset,
  writeWorkspaceTextFile,
  type UploadAssetRequest,
  type WriteTextFileRequest,
} from "./routes/files";
import { mintCollabToken, type CollabTokenDeps, type CollabTokenRequest } from "./routes/collab";
import { createInvite, listInvites, revokeInvite } from "./routes/invites";
import { listWorkspaceMembers } from "./routes/members";
import { resolveSharedAtom, type SharedAtomDeps } from "./routes/shared";
import {
  createShare,
  listMyShares,
  listWorkspaceShares,
  revokeShare,
  type CreateShareRequest,
} from "./routes/shares";
import { applyWorkspaceSync, type ApplySyncRequest } from "./routes/sync";
import {
  createWorkspace as createWorkspaceRoute,
  listWorkspaces,
  parseCreateWorkspaceRequest,
  type CreateWorkspaceFn,
} from "./routes/workspaces";
import { listWorkspaceEvents, type WorkspaceEventSource } from "./realtime/events";

export type WorkspaceApiHandler = (request: Request) => Promise<Response>;

export type CreateWorkspaceApiHandlerOptions = {
  backend: WorkspaceBackend;
  resolveActor: ResolveActor;
  events?: WorkspaceEventSource;
  createWorkspace?: CreateWorkspaceFn;
  collab?: CollabTokenDeps;
  // Routes that resolve access directly against Postgres (workspace listing,
  // shared-atom links). Unset deployments 404 those routes.
  shared?: SharedAtomDeps;
};

type WorkspaceRoute =
  | { route: "files"; workspaceId: string; filePath?: string }
  | { route: "assets"; workspaceId: string }
  | { route: "sync"; workspaceId: string; action: "apply" }
  | { route: "collab"; workspaceId: string; action: "token" }
  | { route: "events"; workspaceId: string }
  | { route: "shares"; workspaceId: string }
  | { route: "members"; workspaceId: string }
  | { route: "invites"; workspaceId: string };

export function createWorkspaceApiHandler({
  backend,
  resolveActor,
  events,
  createWorkspace,
  collab,
  shared,
}: CreateWorkspaceApiHandlerOptions): WorkspaceApiHandler {
  return async (request) => {
    try {
      if (
        createWorkspace &&
        request.method === "POST" &&
        new URL(request.url).pathname === "/workspaces"
      ) {
        const input = parseCreateWorkspaceRequest(await readJson(request));
        const actor = await actorForRequest(resolveActor, request, input.workspaceId);
        return jsonResponse(await createWorkspaceRoute(createWorkspace, actor, input));
      }

      // Workspace-less routes: the session alone identifies the user; the
      // workspace (if any) comes from the data, so the resolver gets "" and
      // only actor.userId is consumed.
      if (shared) {
        const parts = new URL(request.url).pathname
          .split("/")
          .filter(Boolean)
          .map(decodeURIComponent);
        if (request.method === "GET" && parts.length === 1 && parts[0] === "workspaces") {
          const actor = await resolveActor(request, "");
          return jsonResponse(await listWorkspaces(shared.pool, actor));
        }
        if (request.method === "GET" && parts.length === 3 && parts[0] === "shared" && parts[1] === "atoms" && parts[2]) {
          const actor = await resolveActor(request, "");
          return jsonResponse(await resolveSharedAtom(shared, actor.userId, parts[2]));
        }
        if (request.method === "GET" && parts.length === 2 && parts[0] === "me" && parts[1] === "shares") {
          const actor = await resolveActor(request, "");
          return jsonResponse(await listMyShares(shared, actor.userId));
        }
        if (request.method === "DELETE" && parts.length === 2 && parts[0] === "shares" && parts[1]) {
          const actor = await resolveActor(request, "");
          return jsonResponse(await revokeShare(shared, actor.userId, parts[1]));
        }
        if (request.method === "DELETE" && parts.length === 2 && parts[0] === "invites" && parts[1]) {
          const actor = await resolveActor(request, "");
          return jsonResponse(await revokeInvite(shared, actor.userId, parts[1]));
        }
      }

      const route = parseWorkspaceRoute(request);
      const actor = await actorForRequest(resolveActor, request, route.workspaceId);

      if (route.route === "files" && request.method === "GET" && !route.filePath) {
        return jsonResponse(await listWorkspaceFiles(backend, actor));
      }
      if (route.route === "files" && request.method === "GET" && route.filePath) {
        return jsonResponse(await readWorkspaceFile(backend, actor, route.filePath));
      }
      if (route.route === "files" && request.method === "POST" && route.filePath) {
        return jsonResponse(
          await writeWorkspaceTextFile(
            backend,
            actor,
            route.filePath,
            await readJson<WriteTextFileRequest>(request),
          ),
        );
      }
      if (route.route === "assets" && request.method === "POST") {
        return jsonResponse(await uploadWorkspaceAsset(backend, actor, await readJson<UploadAssetRequest>(request)));
      }
      if (route.route === "sync" && route.action === "apply" && request.method === "POST") {
        return jsonResponse(await applyWorkspaceSync(backend, actor, await readJson<ApplySyncRequest>(request)));
      }
      if (route.route === "collab" && route.action === "token" && request.method === "POST") {
        return jsonResponse(
          await mintCollabToken(collab, actor, await readJson<CollabTokenRequest>(request)),
        );
      }
      if (route.route === "events" && request.method === "GET") {
        return jsonResponse(await listWorkspaceEvents(actor, events));
      }
      if (route.route === "shares" && request.method === "POST") {
        // Body parsing is DEFERRED into the route so workspace authz runs
        // first: non-members get the uniform 403 whatever they POST
        // (security review P3 schema oracle). Same for invites below.
        return jsonResponse(await createShare(shared, actor, () => readJson<CreateShareRequest>(request)));
      }
      if (route.route === "shares" && request.method === "GET") {
        return jsonResponse(await listWorkspaceShares(shared, actor));
      }
      if (route.route === "members" && request.method === "GET") {
        return jsonResponse(await listWorkspaceMembers(shared, actor));
      }
      if (route.route === "invites" && request.method === "POST") {
        return jsonResponse(await createInvite(shared, actor, () => readJson<{ email?: string }>(request)));
      }
      if (route.route === "invites" && request.method === "GET") {
        return jsonResponse(await listInvites(shared, actor));
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

function parseWorkspaceRoute(request: Request): WorkspaceRoute {
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== "workspaces" || !parts[1]) {
    throw notFound("workspace route not found");
  }

  const workspaceId = parts[1];
  const section = parts[2];
  if (section === "files") {
    const filePath = parts.length > 3 ? parts.slice(3).join("/") : undefined;
    return { route: "files", workspaceId, filePath };
  }
  if (section === "assets" && parts.length === 3) {
    return { route: "assets", workspaceId };
  }
  if (section === "sync" && parts[3] === "apply" && parts.length === 4) {
    return { route: "sync", workspaceId, action: "apply" };
  }
  if (section === "collab" && parts[3] === "token" && parts.length === 4) {
    return { route: "collab", workspaceId, action: "token" };
  }
  if (section === "events" && parts.length === 3) {
    return { route: "events", workspaceId };
  }
  if (section === "shares" && parts.length === 3) {
    return { route: "shares", workspaceId };
  }
  if (section === "members" && parts.length === 3) {
    return { route: "members", workspaceId };
  }
  if (section === "invites" && parts.length === 3) {
    return { route: "invites", workspaceId };
  }
  throw notFound("workspace route not found");
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
  if (code === "approval-required" || message === "approval required" || message === "approval-required") return 403;
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

function notFound(message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = "not-found";
  return error;
}

function badRequest(message: string) {
  const error = new Error(message);
  (error as Error & { code?: string }).code = "invalid-manifest";
  return error;
}
