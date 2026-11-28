import { jsonResponse } from "@dohc/service-http";
import type { AccountSession, ResolveAccountSession } from "@dohc/workspace-auth/session";
import { badRequest, notFound, relayError } from "./errors";
import { parseWorkspaceId, readJsonObject, relayPathSegments } from "./requestInputs";
import { accountIsFenced } from "./storage/accountDeletion";
import type { SyncRelayStorage } from "./storage";
import type { OwnerLiveSockets } from "./namedLiveRoutes";

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
  try {
    return { route: "account-workspace", workspaceId: parseWorkspaceId(parts[3]) };
  } catch {
    throw notFound();
  }
}

/**
 * The signed-in account behind a request's Bearer session. A cookie is
 * refused, so a page in a browser can never act with the person's sign-in,
 * and so is a fenced account.
 */
export async function bearerAccountSession(
  storage: SyncRelayStorage,
  resolveAccountSession: ResolveAccountSession,
  request: Request,
): Promise<AccountSession> {
  const authorization = request.headers.get("authorization");
  if (request.headers.has("cookie") || !/^Bearer [^\s]+$/.test(authorization ?? ""))
    throw notFound();
  const session = await resolveAccountSession(
    new Request(request.url, {
      headers: { authorization: authorization! },
      signal: request.signal,
    }),
  );
  if (accountIsFenced(storage, session.userId)) throw notFound();
  return session;
}

/**
 * The workspaces a signed-in account owns or joined, its role in each, and
 * whether each shows on its phones. Only a Bearer session reaches them. A
 * workspace the account is not in answers exactly as one that does not exist.
 */
export function createAccountWorkspaceRoutes(options: {
  storage: SyncRelayStorage;
  resolveAccountSession: ResolveAccountSession;
  sockets: Pick<OwnerLiveSockets, "stopPhoneWorkspace">;
  /** Runs once a workspace stops showing on the person's phone. */
  hidden?(userId: string, workspaceId: string): void;
  /** Whether this server can perform owner file lifecycle writes through ServerCopies. */
  fileWritesAvailable?(): boolean;
}) {
  const { storage } = options;
  const account = async (request: Request) =>
    (await bearerAccountSession(storage, options.resolveAccountSession, request)).userId;

  return async function respondToAccountWorkspaces(
    request: Request,
    route: AccountWorkspaceRoute,
  ): Promise<Response> {
    if (route.route === "account-workspaces") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      const userId = await account(request);
      const fileWritesAvailable = options.fileWritesAvailable?.() ?? false;
      return jsonResponse({
        ok: true,
        workspaces: storage.listAccountWorkspaces(userId).map((workspace) => ({
          ...workspace,
          fileWritesAvailable:
            fileWritesAvailable &&
            workspace.role === "owner" &&
            workspace.showOnPhone &&
            workspace.canOpen,
        })),
      });
    }
    if (request.method !== "PATCH") throw relayError("method_not_allowed");
    const userId = await account(request);
    if (!storage.workspaceRoleOf(route.workspaceId, userId)) throw notFound();
    const body = await readJsonObject(request);
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== "showOnPhone" || typeof body.showOnPhone !== "boolean") {
      throw badRequest("the body must be exactly { showOnPhone: boolean }");
    }
    // Reading the body waited, so the sign-in and the person's place in the workspace are checked again.
    if (
      (await account(request)) !== userId ||
      !storage.setShowOnPhone({
        userId,
        workspaceId: route.workspaceId,
        showOnPhone: body.showOnPhone,
      })
    ) {
      throw notFound();
    }
    // Turning it off ends the person's phone pages and apps in the workspace before the answer.
    if (!body.showOnPhone) {
      options.sockets.stopPhoneWorkspace(userId, route.workspaceId);
      options.hidden?.(userId, route.workspaceId);
    }
    return jsonResponse({
      ok: true,
      workspaceId: route.workspaceId,
      showOnPhone: body.showOnPhone,
    });
  };
}
