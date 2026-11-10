import { jsonResponse } from "@dohc/service-http";
import type { ResolveAccountSession } from "@dohc/workspace-auth/session";
import { badRequest, notFound, relayError } from "./errors";
import { parseWorkspaceId, readJsonObject, relayPathSegments } from "./requestInputs";
import { accountIsFenced } from "./storage/accountDeletion";
import type { SyncRelayStorage } from "./storage";

export type AccountWorkspaceRoute =
  | { route: "account-workspaces" }
  | { route: "account-workspace"; workspaceId: string };

/** A "Show on phone" change is one small object. */
export const ACCOUNT_WORKSPACE_MAX_BODY_BYTES = 1024;

export function isAccountWorkspacePath(pathname: string): boolean {
  let parts: readonly string[];
  try {
    parts = relayPathSegments(pathname);
  } catch {
    return false;
  }
  return parts[0] === "sync" && parts[1] === "account" && parts[2] === "workspaces";
}

/** Parses `/sync/account/...` after its first two segments. */
export function parseAccountRoute(parts: readonly string[]): AccountWorkspaceRoute {
  if (parts[2] !== "workspaces") throw notFound();
  if (parts.length === 3) return { route: "account-workspaces" };
  if (parts.length !== 4) throw notFound();
  // An ID that cannot be a workspace answers as one this account does not own.
  try { return { route: "account-workspace", workspaceId: parseWorkspaceId(parts[3]) }; }
  catch { throw notFound(); }
}

/**
 * The workspaces a signed-in account owns, and whether each shows on its
 * phone. Only a Bearer session reaches them, so a page in a browser can never
 * change them with the person's cookie. A workspace the account does not own
 * answers exactly as one that does not exist.
 */
export function createAccountWorkspaceRoutes(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
}) {
  const { storage } = options;

  async function account(request: Request): Promise<string> {
    const authorization = request.headers.get("authorization");
    if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? "")) throw notFound();
    const session = await options.resolveAccountSession(new Request(request.url, {
      headers: { authorization: authorization! }, signal: request.signal,
    }));
    if (accountIsFenced(storage, session.userId)) throw notFound();
    return session.userId;
  }

  return async function respondToAccountWorkspaces(request: Request, route: AccountWorkspaceRoute): Promise<Response> {
    if (route.route === "account-workspaces") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      const userId = await account(request);
      return jsonResponse({ ok: true, workspaces: storage.listAccountWorkspaces(userId) });
    }
    if (request.method !== "PATCH") throw relayError("method_not_allowed");
    const userId = await account(request);
    if (!storage.workspaceIsOwnedBy(route.workspaceId, userId)) throw notFound();
    const body = await readJsonObject(request);
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "showOnPhone" || typeof body.showOnPhone !== "boolean") {
      throw badRequest("the body must be exactly { showOnPhone: boolean }");
    }
    // Reading the body waited, so the sign-in and the workspace's owner are checked again.
    if (await account(request) !== userId || !storage.setShowOnPhone({ ownerUserId: userId, workspaceId: route.workspaceId, showOnPhone: body.showOnPhone })) {
      throw notFound();
    }
    return jsonResponse({ ok: true, workspaceId: route.workspaceId, showOnPhone: body.showOnPhone });
  };
}
