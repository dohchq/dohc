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
import { applyWorkspaceSync, type ApplySyncRequest } from "./routes/sync";
import { listWorkspaceEvents, type WorkspaceEventSource } from "./realtime/events";

export type WorkspaceApiHandler = (request: Request) => Promise<Response>;

export type CreateWorkspaceApiHandlerOptions = {
  backend: WorkspaceBackend;
  resolveActor: ResolveActor;
  events?: WorkspaceEventSource;
};

type WorkspaceRoute =
  | { route: "files"; workspaceId: string; filePath?: string }
  | { route: "assets"; workspaceId: string }
  | { route: "sync"; workspaceId: string; action: "apply" }
  | { route: "events"; workspaceId: string };

export function createWorkspaceApiHandler({
  backend,
  resolveActor,
  events,
}: CreateWorkspaceApiHandlerOptions): WorkspaceApiHandler {
  return async (request) => {
    try {
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
      if (route.route === "events" && request.method === "GET") {
        return jsonResponse(await listWorkspaceEvents(actor, events));
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
  if (section === "events" && parts.length === 3) {
    return { route: "events", workspaceId };
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
