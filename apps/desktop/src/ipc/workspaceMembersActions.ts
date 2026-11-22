import {
  type GroupRuleLevel,
  MESSAGE_DELETE_OFFLINE,
  MESSAGE_DELETE_REFUSED,
  WORKSPACE_MEMBER_ROUTES,
} from "@dohc/security-contract/workspace-members";
import { MembersResult, type MembersRequest } from "@dohc/cli/members";
import { createOwnerRelayShareOperation } from "./ownerRelayShareHandler";
import { shareViewIsPresent } from "../workspaces/shareViewMarker";
import { recordedShareSelector } from "../workspaces/shareViewRecords";
import { joinedByAccount } from "../workspaces/shareWriteGate";
import { JOINED_BY_ANOTHER_ACCOUNT } from "./joinedAccountWords";

type MembersWorkspace = { workspaceId: string; rootPath: string; shareView?: unknown };
type MembersOperation<Workspace> = { workspace: Workspace; assertCurrent(): void };
interface MembersDependencies<Workspace, Credentials> {
  remoteForWorkspace(
    workspace: Workspace,
    options?: { allowPaused: boolean },
  ): Promise<{ credentials: Credentials; credentialGeneration: number }>;
  /** The signed-in account, when it is the one that joined this workspace. Rejects with why not. */
  remoteForJoinedWorkspace(
    workspace: Workspace,
  ): Promise<{ credentials: Credentials; credentialGeneration: number }>;
  currentCredentialGeneration(): number;
  /** One relay request with the signed-in account's bearer. Resolves with any status; rejects when the server is unreachable. */
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
  /** The relay accepted a change, so this computer's grant listings refresh now. */
  sharesChanged(workspaceId: string): void;
  /** The relay answered, so a sync that last found it unreachable tries again now. */
  serverAnswered(): void;
}

export const MEMBERS_UNREACHABLE = "dohc could not reach your server. Check your connection.";
const SHARE_VIEW_REFUSAL = "Open the original workspace to manage its members.";
const NO_PLACE =
  "dohc does not know where this workspace's Members are yet. Refresh the workspace, then try again.";

// Where a workspace's Members live on the relay: the workspace's own id for
// one this computer owns, the owner's for a joined one, and null for any
// other share view.
export function membersPlace(
  workspace: MembersWorkspace,
): { workspaceId: string; workspaceName: string } | "joined-unknown" | null {
  if (!shareViewIsPresent(workspace.shareView))
    return { workspaceId: workspace.workspaceId, workspaceName: folderName(workspace.rootPath) };
  const view = workspace.shareView as {
    grantedSelector?: unknown;
    membersWorkspaceId?: unknown;
    subjectName?: unknown;
  };
  if (recordedShareSelector(view.grantedSelector)?.wholeWorkspace !== true) return null;
  if (typeof view.membersWorkspaceId !== "string" || view.membersWorkspaceId.length === 0)
    return "joined-unknown";
  return {
    workspaceId: view.membersWorkspaceId,
    workspaceName:
      typeof view.subjectName === "string" && view.subjectName
        ? view.subjectName
        : folderName(workspace.rootPath),
  };
}

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
  group: "change this Group's access",
  deleteMessage: "delete the message",
};

function failure(action: MembersRequest["action"], status: number): Error {
  const phrase = PHRASES[action];
  switch (status) {
    case 400:
      return new Error(
        `dohc could not ${phrase} because the server refused the request. Check what you entered, then try again.`,
      );
    case 403:
      return new Error(
        action === "invite"
          ? "dohc could not send the invite. Only the owner and admins can invite."
          : `dohc could not ${phrase} because your role in this workspace does not allow it. Reload Members to see what you can do.`,
      );
    case 404:
      return new Error(
        `dohc could not ${phrase} because the server no longer lists it. Reload Members, then try again.`,
      );
    case 409:
      return new Error(
        `dohc could not ${phrase} because Members changed first. Reload Members, then try again.`,
      );
    case 429:
      return new Error(
        `dohc could not ${phrase} because the server is busy. Try again in a minute.`,
      );
    default:
      return new Error(`dohc could not ${phrase}. The server answered ${status}. Try again.`);
  }
}

// The folder name, as the workspace list shows it. The relay keeps it as the
// workspace's name for invites and the join page.
function folderName(rootPath: string): string {
  return (
    rootPath
      .replace(/[\\/]+$/u, "")
      .split(/[\\/]/u)
      .pop() || "Workspace"
  );
}

function route(
  template: string,
  workspaceId: string,
  memberId?: string,
  channelWireId?: string,
): string {
  return template
    .replace(":workspaceId", encodeURIComponent(workspaceId))
    .replace(":memberId", encodeURIComponent(memberId ?? ""))
    .replace(":channelWireId", encodeURIComponent(channelWireId ?? ""));
}

/**
 * The Members page's actions, for the app and for agents through the CLI and MCP. Main
 * names the workspace the caller's operation holds and the account its
 * credentials belong to; the relay decides every action.
 */
export function createWorkspaceMembersActions<Workspace extends MembersWorkspace, Credentials>(
  dependencies: MembersDependencies<Workspace, Credentials>,
) {
  // A joined workspace asks with the account that joined it; any other
  // with the workspace's own remote.
  const relayOperation = createOwnerRelayShareOperation<
    Workspace,
    MembersOperation<Workspace>,
    Credentials
  >({
    remoteForWorkspace: (workspace, options) =>
      shareViewIsPresent(workspace.shareView)
        ? dependencies.remoteForJoinedWorkspace(workspace)
        : dependencies.remoteForWorkspace(workspace, options),
    credentialGeneration: dependencies.currentCredentialGeneration,
  });
  const assertMembersWorkspace = (workspace: Workspace) => {
    const place = membersPlace(workspace);
    if (place === null) throw new Error(SHARE_VIEW_REFUSAL);
    if (place === "joined-unknown") throw new Error(NO_PLACE);
  };

  return function workspaceMembers(
    operation: MembersOperation<Workspace>,
    request: MembersRequest,
  ): Promise<MembersResult> {
    return relayOperation(
      operation,
      async (operation, credentials, session) => {
        const place = membersPlace(operation.workspace);
        if (place === null || place === "joined-unknown") throw new Error(SHARE_VIEW_REFUSAL);
        const { workspaceId, workspaceName } = place;
        const localWorkspaceId = operation.workspace.workspaceId;

        const call = async (
          path: string,
          body?: unknown,
          method: "POST" | "PUT" = "POST",
          unreachable = MEMBERS_UNREACHABLE,
        ): Promise<{ status: number; data: unknown }> => {
          const init: RequestInit =
            body === undefined
              ? { method: "GET", headers: { accept: "application/json" } }
              : {
                  method,
                  headers: { accept: "application/json", "content-type": "application/json" },
                  body: JSON.stringify(body),
                };
          let response: Response;
          try {
            response = await dependencies.relayResponse(credentials, path, init);
          } catch {
            session.assertCurrent();
            throw new Error(unreachable);
          }
          dependencies.serverAnswered();
          let data: unknown = null;
          if (response.ok) {
            try {
              data = await response.json();
            } catch {
              data = undefined;
            }
          } else {
            await response.body?.cancel().catch(() => undefined);
          }
          // Every other POST and PUT here changes Members. Refresh before the
          // currency check, because the relay made the change even if this
          // window moved on.
          if (body !== undefined && response.status === 200 && request.action !== "deleteMessage")
            dependencies.sharesChanged(localWorkspaceId);
          session.assertCurrent();
          return { status: response.status, data };
        };

        const ready = (data: unknown): MembersResult => {
          const parsed = MembersResult.safeParse({ status: "ready", view: data });
          if (
            !parsed.success ||
            parsed.data.status !== "ready" ||
            parsed.data.view.workspaceId !== workspaceId
          ) {
            throw new Error("dohc could not read Members from your server. Try again.");
          }
          const { view } = parsed.data;
          // With no membership, as before the first invite or after End
          // membership, the relay has no name for the workspace.
          return { status: "ready", view: view.workspaceName ? view : { ...view, workspaceName } };
        };

        const list = async (): Promise<MembersResult> => {
          const { status, data } = await call(route(WORKSPACE_MEMBER_ROUTES.view, workspaceId));
          if (status === 403 || status === 404) return { status: "refused" };
          if (status !== 200) throw failure("list", status);
          return ready(data);
        };

        // An email names an invite or a person; anything else is a member id
        // from the list.
        const memberId = async (person: string): Promise<string> => {
          if (!person.includes("@")) return person;
          const listed = await list();
          if (listed.status !== "ready") throw failure(request.action, 403);
          const wanted = person.toLowerCase();
          const match = listed.view.people.find((entry) => entry.email?.toLowerCase() === wanted);
          if (!match)
            throw new Error(
              `No one in this workspace has the email ${person}. Run the list to see who is in it.`,
            );
          return match.memberId;
        };

        const changed = (status: number) => {
          if (status !== 200) throw failure(request.action, status);
        };

        const change = async (
          path: string,
          body: unknown,
          method?: "PUT",
        ): Promise<MembersResult> => {
          const { status, data } = await call(path, body, method);
          changed(status);
          return ready(data);
        };

        switch (request.action) {
          case "list":
            return list();
          case "invite":
            return change(route(WORKSPACE_MEMBER_ROUTES.invite, workspaceId), {
              email: request.email,
              workspaceName,
            });
          case "level":
            // The name lets the relay start the membership when there is none.
            return change(route(WORKSPACE_MEMBER_ROUTES.level, workspaceId), {
              level: request.level,
              workspaceName,
            });
          case "role":
            return change(
              route(WORKSPACE_MEMBER_ROUTES.role, workspaceId, await memberId(request.person)),
              { role: request.role },
            );
          case "remove":
            return change(
              route(WORKSPACE_MEMBER_ROUTES.remove, workspaceId, await memberId(request.person)),
              {},
            );
          case "letBackIn":
            return change(
              route(WORKSPACE_MEMBER_ROUTES.letBackIn, workspaceId, await memberId(request.person)),
              {},
            );
          case "link":
            return change(
              route(WORKSPACE_MEMBER_ROUTES.inviteLink, workspaceId),
              request.change === "turn-off"
                ? { action: request.change }
                : { action: request.change, workspaceName },
            );
          case "leave": {
            const { status, data } = await call(
              route(WORKSPACE_MEMBER_ROUTES.leave, workspaceId),
              {},
            );
            changed(status);
            if (
              typeof data !== "object" ||
              data === null ||
              (data as { ok?: unknown }).ok !== true
            ) {
              throw new Error(
                "dohc could not read your server's answer. Reload Members to check whether you left.",
              );
            }
            return { status: "done" };
          }
          case "end":
            return change(route(WORKSPACE_MEMBER_ROUTES.end, workspaceId), {});
          case "group":
            // `group` is the Group's wire id here; the CLI resolves a name first.
            if (request.level === undefined) return list();
            return change(
              route(WORKSPACE_MEMBER_ROUTES.groupRule, workspaceId, undefined, request.group),
              { level: request.level },
              "PUT",
            );
          case "deleteMessage": {
            // The copy shows the deleted line when it pulls the delete, which
            // the relay wakes it for.
            const { status } = await call(
              route(WORKSPACE_MEMBER_ROUTES.messageDelete, workspaceId).replace(
                ":messageId",
                encodeURIComponent(request.messageId),
              ),
              { threadId: request.threadId },
              "POST",
              MESSAGE_DELETE_OFFLINE,
            );
            // The relay answers not-found to every refusal.
            if (status === 404) throw new Error(MESSAGE_DELETE_REFUSED);
            changed(status);
            return { status: "done" };
          }
        }
      },
      assertMembersWorkspace,
      { allowPaused: true },
    );
  };
}

export interface JoinedWorkspaceGroupInput {
  name: string;
  type?: "posts" | "chat" | "both";
  purpose?: string;
  // The members' level, kept as the Group's rule. Absent, the Group takes the member level.
  level?: GroupRuleLevel;
}

/**
 * New group in a joined workspace, for an admin. The relay reads the role
 * from its own records and writes the Group into the owner's workspace; the
 * view's next pull brings it here. Main names the share and the account.
 */
export function createJoinedWorkspaceGroupAction<
  Credentials extends { userId: string; relayUrl?: string },
>(dependencies: {
  credentials(): Promise<Credentials | null>;
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
}) {
  return async function createJoinedWorkspaceGroup(
    view: { shareId?: string; relayUrl?: string; recipientUserId?: string } | undefined,
    input: JoinedWorkspaceGroupInput,
  ): Promise<{ channelWireId: string }> {
    const credentials = await dependencies.credentials();
    if (!view?.shareId || !joinedByAccount(view, credentials))
      throw new Error(JOINED_BY_ANOTHER_ACCOUNT);
    return requestGroupCreate(
      (path, init) => dependencies.relayResponse(credentials, path, init),
      { shareId: view.shareId },
      input,
      "your membership ended",
    );
  };
}

/**
 * New group with a level, in a workspace this computer owns. A rule needs
 * the relay, which writes the Group and its rule together; the owner's next
 * sync brings the Group here.
 */
export function createOwnedWorkspaceGroupAction<Credentials>(dependencies: {
  // The account this workspace syncs with. Rejects with why there is none.
  credentials(workspaceId: string): Promise<Credentials>;
  relayResponse(credentials: Credentials, path: string, init: RequestInit): Promise<Response>;
}) {
  return async function createOwnedWorkspaceGroup(
    workspaceId: string,
    input: JoinedWorkspaceGroupInput,
  ): Promise<{ channelWireId: string }> {
    const credentials = await dependencies.credentials(workspaceId);
    return requestGroupCreate(
      (path, init) => dependencies.relayResponse(credentials, path, init),
      { workspaceId },
      input,
      "this workspace has not synced to your server yet. Try again once it has",
    );
  };
}

async function requestGroupCreate(
  relayResponse: (path: string, init: RequestInit) => Promise<Response>,
  place: { shareId: string } | { workspaceId: string },
  input: JoinedWorkspaceGroupInput,
  // Why a 404 refused it, after "because".
  notFound: string,
): Promise<{ channelWireId: string }> {
  let response: Response;
  try {
    response = await relayResponse(WORKSPACE_MEMBER_ROUTES.groupCreate, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ ...place, ...input }),
    });
  } catch {
    throw new Error(MEMBERS_UNREACHABLE);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    switch (response.status) {
      case 400:
        throw new Error("Use 1 to 80 characters, including at least one letter or number.");
      case 403:
        throw new Error(
          `dohc could not create ${input.name} because only admins create Groups here.`,
        );
      case 404:
        throw new Error(`dohc could not create ${input.name} because ${notFound}.`);
      case 413:
        throw new Error(
          `dohc could not create ${input.name} because this workspace is out of space.`,
        );
      default:
        throw new Error(
          `dohc could not create ${input.name}. The server answered ${response.status}. Try again.`,
        );
    }
  }
  const data: unknown = await response.json().catch(() => null);
  const channelWireId =
    typeof data === "object" && data !== null
      ? (data as { channelWireId?: unknown }).channelWireId
      : undefined;
  if (typeof channelWireId !== "string" || channelWireId.length === 0) {
    throw new Error(
      `dohc could not read your server's answer. Look for ${input.name} in Chats before you try again.`,
    );
  }
  return { channelWireId };
}
