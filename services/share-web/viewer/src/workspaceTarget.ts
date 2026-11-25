import { namedInvitationGrant } from "./namedInvitation";
import { WORKSPACES_PATH } from "./pages";

/** What a workspace page opens: a member's grant, a workspace its owner opens, or the list of the account's workspaces. */
export type WorkspaceTarget =
  | { kind: "member"; grantId: string }
  | { kind: "owner"; workspaceId: string }
  | { kind: "list" };

const WORKSPACE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

export function workspaceId(value: string): string | null {
  return WORKSPACE_ID.test(value) ? value : null;
}

export function workspaceTarget(pathname: string): WorkspaceTarget | null {
  if (pathname === WORKSPACES_PATH) return { kind: "list" };
  const owner = /^\/s\/workspace\/owner\/([^/]+)\/?$/.exec(pathname);
  if (owner) {
    try {
      const id = workspaceId(decodeURIComponent(owner[1]!));
      return id ? { kind: "owner", workspaceId: id } : null;
    } catch {
      return null;
    }
  }
  const grantId = namedInvitationGrant(pathname, "workspace");
  return grantId ? { kind: "member", grantId } : null;
}

/** The view routes' session: the grant or the owned workspace, which the account cookie must hold. */
export const viewSession = (
  target: { kind: "member"; grantId: string } | { kind: "owner"; workspaceId: string },
) => (target.kind === "owner" ? `owner.${target.workspaceId}` : `member.${target.grantId}`);

export const ownerPagePath = (id: string) => `/s/workspace/owner/${encodeURIComponent(id)}`;
export const memberPagePath = (grantId: string) => `/s/workspace/${encodeURIComponent(grantId)}`;
