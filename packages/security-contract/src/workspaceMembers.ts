import { isRecord } from "@dohc/workspace-core/records";
import type { ShareAccess } from "./shareSelector";

// Workspace members: the wire contract between the relay, the desktop app,
// the owner's CLI and MCP tools, and the browser. The relay is the only
// authority.
//
// See docs/engineering/plans/workspace-members.md.

export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** The one level every member reaches the workspace at. Admins and the owner always have Edit. */
export type MemberLevel = ShareAccess;
export const DEFAULT_MEMBER_LEVEL: MemberLevel = "comment";

/**
 * - `invited`: an email invite nobody has claimed yet. The entry has no account.
 * - `active`: a member or admin.
 * - `removed`: an account the owner or an admin removed. It cannot rejoin
 *   through the invite link until someone lets it back in.
 * People who leave are not listed.
 */
export const MEMBER_STATES = ["invited", "active", "removed"] as const;
export type MemberState = (typeof MEMBER_STATES)[number];

/**
 * The most people one workspace holds besides its owner: invited and active
 * entries together. Removed entries take no seat. The relay enforces it.
 */
export const MAX_WORKSPACE_MEMBERS = 1_000;

export const MAX_MEMBER_EMAIL_CHARS = 320;

export interface WorkspacePerson {
  /** Stable id of this entry. The owner's entry uses `"owner"`. */
  memberId: string;
  role: WorkspaceRole;
  state: MemberState;
  /** The account's name. Null for an invite, or when the account has no name. */
  name: string | null;
  /** Present only when the viewer is the owner or an admin. */
  email: string | null;
  invitedAtMs: number | null;
  joinedAtMs: number | null;
  removedAtMs: number | null;
}

export interface WorkspaceInviteLink {
  enabled: boolean;
  /** The link to copy. Null while the link is off. */
  url: string | null;
}

export interface WorkspaceMembersView {
  workspaceId: string;
  /** The workspace name the owner gave when they first invited someone. */
  workspaceName: string;
  viewer: { memberId: string; role: WorkspaceRole };
  memberLevel: MemberLevel;
  /** Present only for the owner and admins. */
  inviteLink: WorkspaceInviteLink | null;
  /**
   * Everyone in the workspace, owner first. Members see only active entries
   * and no emails. The owner and admins also see invites and removed accounts.
   */
  people: WorkspacePerson[];
}

/** What the relay answers for a join link before the person joins. */
export interface WorkspaceJoinPreview {
  workspaceName: string;
  ownerName: string | null;
  /** True when the signed-in account already belongs to the workspace. */
  alreadyMember: boolean;
}

export interface WorkspaceJoinResult {
  workspaceId: string;
  shareId: string;
  workspaceName: string;
}

export type InviteLinkAction = "turn-on" | "turn-off" | "reset";
export const INVITE_LINK_ACTIONS: readonly InviteLinkAction[] = ["turn-on", "turn-off", "reset"];

/** The relay paths. `:workspaceId` and `:memberId` are URL path segments. */
export const WORKSPACE_MEMBER_ROUTES = {
  /** GET → WorkspaceMembersView. */
  view: "/sync/:workspaceId/members",
  /** POST {email, workspaceName?} → WorkspaceMembersView. */
  invite: "/sync/:workspaceId/members/invites",
  /** POST {level} → WorkspaceMembersView. */
  level: "/sync/:workspaceId/members/level",
  /** POST {role: "admin" | "member"} → WorkspaceMembersView. */
  role: "/sync/:workspaceId/members/:memberId/role",
  /** POST {} → WorkspaceMembersView. */
  remove: "/sync/:workspaceId/members/:memberId/remove",
  /** POST {} → WorkspaceMembersView. Restores a removed account as a member. */
  letBackIn: "/sync/:workspaceId/members/:memberId/let-back-in",
  /** POST {action, workspaceName?} → WorkspaceMembersView. */
  inviteLink: "/sync/:workspaceId/members/invite-link",
  /** POST {} → {ok}. */
  leave: "/sync/:workspaceId/members/leave",
  /** POST {} → WorkspaceMembersView. Ends membership for everyone. */
  end: "/sync/:workspaceId/members/end",
  /** POST {token} → WorkspaceJoinPreview. Signed in. */
  joinPreview: "/sync/members/join-preview",
  /** POST {token} → WorkspaceJoinResult. Signed in. */
  join: "/sync/members/join",
} as const;

export function isInviteLinkAction(value: unknown): value is InviteLinkAction {
  return typeof value === "string" && (INVITE_LINK_ACTIONS as readonly string[]).includes(value);
}

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

export function parseWorkspaceJoinPreview(value: unknown): WorkspaceJoinPreview | null {
  if (!isRecord(value)) return null;
  const { workspaceName, ownerName, alreadyMember } = value;
  if (
    typeof workspaceName !== "string" ||
    !isNullableString(ownerName) ||
    typeof alreadyMember !== "boolean"
  )
    return null;
  return { workspaceName, ownerName, alreadyMember };
}

export function parseWorkspaceJoinResult(value: unknown): WorkspaceJoinResult | null {
  if (!isRecord(value)) return null;
  const { workspaceId, shareId, workspaceName } = value;
  if (
    typeof workspaceId !== "string" ||
    typeof shareId !== "string" ||
    typeof workspaceName !== "string"
  )
    return null;
  return { workspaceId, shareId, workspaceName };
}

/**
 * Who may do each Members action: anyone in the workspace, a manager (the
 * owner or an admin), or only the owner. The relay enforces it inside each
 * change; clients read it only to show or hide controls. Leaving is not here:
 * it needs a member entry, which the owner does not have.
 */
export const MEMBER_ACTION_ROLES = {
  list: "anyone",
  invite: "manager",
  level: "manager",
  link: "manager",
  remove: "manager",
  letBackIn: "manager",
  role: "owner",
  end: "owner",
} as const satisfies Record<string, "anyone" | "manager" | "owner">;
export type MemberAction = keyof typeof MEMBER_ACTION_ROLES;

/** Whether `viewer` may do `action`, to a person whose role is `target` when it acts on one. */
export function memberMay(
  viewer: WorkspaceRole,
  action: MemberAction,
  target?: WorkspaceRole,
): boolean {
  // The one exception to the table: only the owner removes an admin.
  const needs = action === "remove" && target === "admin" ? "owner" : MEMBER_ACTION_ROLES[action];
  return needs === "anyone" || viewer === "owner" || (needs === "manager" && viewer === "admin");
}
