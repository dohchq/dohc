import {
  parseWorkspaceMembersView, WORKSPACE_MEMBER_ROUTES, type WorkspaceMembersView,
} from "@dohc/security-contract/workspace-members";
import { MembersResult, type MembersRequest } from "@dohc/cli/members";
import { assertOriginalWorkspace, createOwnerRelayShareOperation } from "./ownerRelayShareHandler";

type MembersWorkspace = { workspaceId: string; rootPath: string; shareView?: unknown };
type MembersOperation<Workspace> = { workspace: Workspace; assertCurrent(): void };
interface MembersDependencies<Workspace, Credentials> {
  remoteForWorkspace(workspace: Workspace, options?: { allowPaused: boolean }): Promise<{ credentials: Credentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  /** One relay request with the signed-in account's bearer. Resolves with any status; rejects when the server is unreachable. */
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
}

export const MEMBERS_UNREACHABLE = "dohc could not reach your server. Check your connection, then try again.";
const SHARE_VIEW_REFUSAL = "Open the original workspace to manage its members.";

const PHRASES: Record<MembersRequest["action"], string> = {
  list: "load Members",
  invite: "send the invite",
  level: "change what members can do",
  role: "change this person's role",
  remove: "remove this person",
  letBackIn: "let this person back in",
  link: "change the invite link",
  leave: "leave this workspace",
  end: "end membership",
};

function failure(action: MembersRequest["action"], status: number): Error {
  const phrase = PHRASES[action];
  switch (status) {
    case 400: return new Error(`dohc could not ${phrase} because the server refused the request. Check what you entered, then try again.`);
    case 403: return new Error(`dohc could not ${phrase} because your role in this workspace no longer allows it. Reload Members to see what you can do.`);
    case 404: return new Error(`dohc could not ${phrase} because the server no longer lists it. Reload Members, then try again.`);
    case 409: return new Error(`dohc could not ${phrase} because Members changed first. Reload Members, then try again.`);
    case 429: return new Error(`dohc could not ${phrase} because the server is busy. Try again in a minute.`);
    default: return new Error(`dohc could not ${phrase}. The server answered ${status}. Try again.`);
  }
}

// The folder name, as the workspace list shows it. The relay keeps it as the
// workspace's name for invites and the join page.
function folderName(rootPath: string): string {
  return rootPath.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() || "Workspace";
}

function route(template: string, workspaceId: string, memberId?: string): string {
  return template
    .replace(":workspaceId", encodeURIComponent(workspaceId))
    .replace(":memberId", encodeURIComponent(memberId ?? ""));
}

/**
 * The Members page's actions, for the app, the owner's CLI, and MCP. Main
 * names the workspace the caller's operation holds and the account its
 * credentials belong to; the relay decides every action.
 */
export function createWorkspaceMembersActions<Workspace extends MembersWorkspace, Credentials>(
  dependencies: MembersDependencies<Workspace, Credentials>,
) {
  const ownerRelayOperation = createOwnerRelayShareOperation<Workspace, MembersOperation<Workspace>, Credentials>({
    remoteForWorkspace: dependencies.remoteForWorkspace,
    credentialGeneration: dependencies.currentCredentialGeneration,
  });
  const assertMembersWorkspace = (workspace: Workspace) => {
    try { assertOriginalWorkspace(workspace); } catch { throw new Error(SHARE_VIEW_REFUSAL); }
  };

  return function workspaceMembers(operation: MembersOperation<Workspace>, request: MembersRequest): Promise<MembersResult> {
    return ownerRelayOperation(operation, async (operation, credentials, session) => {
      const workspaceId = operation.workspace.workspaceId;
      const workspaceName = folderName(operation.workspace.rootPath);

      const call = async (path: string, body?: unknown): Promise<{ status: number; data: unknown }> => {
        const init: RequestInit = body === undefined
          ? { method: "GET", headers: { accept: "application/json" } }
          : { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) };
        let response: Response;
        try {
          response = await dependencies.relayResponse(credentials, path, init);
        } catch {
          session.assertCurrent();
          throw new Error(MEMBERS_UNREACHABLE);
        }
        let data: unknown = null;
        if (response.ok) {
          try { data = await response.json(); } catch { data = undefined; }
        } else {
          await response.body?.cancel().catch(() => undefined);
        }
        session.assertCurrent();
        return { status: response.status, data };
      };

      const readView = (data: unknown): WorkspaceMembersView => {
        const view = parseWorkspaceMembersView(data);
        if (!view || view.workspaceId !== workspaceId) {
          throw new Error(`dohc could not read Members from your server. Try again.`);
        }
        return view;
      };

      const list = async (): Promise<MembersResult> => {
        const { status, data } = await call(route(WORKSPACE_MEMBER_ROUTES.view, workspaceId));
        if (status === 403 || status === 404) return { status: "refused" };
        if (status !== 200) throw failure("list", status);
        return MembersResult.parse({ status: "ready", view: readView(data) });
      };

      // An email names an invite or a person; anything else is a member id
      // from the list.
      const memberId = async (person: string): Promise<string> => {
        if (!person.includes("@")) return person;
        const listed = await list();
        if (listed.status !== "ready") throw failure(request.action, 403);
        const wanted = person.toLowerCase();
        const match = listed.view.people.find(entry => entry.email?.toLowerCase() === wanted);
        if (!match) throw new Error(`No one in this workspace has the email ${person}. Run the list to see who is in it.`);
        return match.memberId;
      };

      const change = async (path: string, body: unknown): Promise<MembersResult> => {
        const { status, data } = await call(path, body);
        if (status !== 200) throw failure(request.action, status);
        return MembersResult.parse({ status: "ready", view: readView(data) });
      };

      const finish = async (path: string): Promise<MembersResult> => {
        const { status, data } = await call(path, {});
        if (status !== 200) throw failure(request.action, status);
        if (typeof data !== "object" || data === null || (data as { ok?: unknown }).ok !== true) {
          throw new Error("dohc could not read your server's answer. Reload Members to check what changed.");
        }
        return { status: "done" };
      };

      switch (request.action) {
        case "list":
          return list();
        case "invite": {
          const { status, data } = await call(route(WORKSPACE_MEMBER_ROUTES.invite, workspaceId), { email: request.email, workspaceName });
          if (status !== 200) throw failure("invite", status);
          if (typeof data !== "object" || data === null || (data as { ok?: unknown }).ok !== true) {
            throw new Error("dohc could not read your server's answer. Reload Members to check whether the invite was sent.");
          }
          return list();
        }
        case "level":
          return change(route(WORKSPACE_MEMBER_ROUTES.level, workspaceId), { level: request.level });
        case "role":
          return change(route(WORKSPACE_MEMBER_ROUTES.role, workspaceId, await memberId(request.person)), { role: request.role });
        case "remove":
          return change(route(WORKSPACE_MEMBER_ROUTES.remove, workspaceId, await memberId(request.person)), {});
        case "letBackIn":
          return change(route(WORKSPACE_MEMBER_ROUTES.letBackIn, workspaceId, await memberId(request.person)), {});
        case "link":
          return change(route(WORKSPACE_MEMBER_ROUTES.inviteLink, workspaceId),
            request.change === "turn-off" ? { action: request.change } : { action: request.change, workspaceName });
        case "leave":
          return finish(route(WORKSPACE_MEMBER_ROUTES.leave, workspaceId));
        case "end":
          return finish(route(WORKSPACE_MEMBER_ROUTES.end, workspaceId));
      }
    }, assertMembersWorkspace, { allowPaused: true });
  };
}
