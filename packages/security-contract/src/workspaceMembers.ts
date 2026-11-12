import { isRecord } from "@dohc/workspace-core/records";
import { isShareAccessValue, type ShareAccess } from "./shareSelector";

// Workspace members: the wire contract between the relay, the desktop app,
// the owner's CLI and MCP tools, and the browser. The relay is the only
// authority; every reader parses a response with the checks below and treats
// anything they refuse as unreadable, never as a narrower answer.
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

/** The most people one workspace holds: invited and active entries together. */
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
  /** GET → WorkspaceMembersView. Any person in the workspace. */
  view: "/sync/:workspaceId/members",
  /** POST {email, workspaceName?} → {ok, memberId}. Owner or admin. */
  invite: "/sync/:workspaceId/members/invites",
  /** POST {level} → WorkspaceMembersView. Owner or admin. */
  level: "/sync/:workspaceId/members/level",
  /** POST {role: "admin" | "member"} → WorkspaceMembersView. Owner only. */
  role: "/sync/:workspaceId/members/:memberId/role",
  /** POST {} → WorkspaceMembersView. Owner, or an admin for a member or an invite. */
  remove: "/sync/:workspaceId/members/:memberId/remove",
  /** POST {} → WorkspaceMembersView. Owner or admin. Restores a removed account as a member. */
  letBackIn: "/sync/:workspaceId/members/:memberId/let-back-in",
  /** POST {action, workspaceName?} → WorkspaceMembersView. Owner or admin. */
  inviteLink: "/sync/:workspaceId/members/invite-link",
  /** POST {} → {ok}. A member or an admin. The owner cannot leave. */
  leave: "/sync/:workspaceId/members/leave",
  /** POST {} → {ok}. Owner only. Ends membership for everyone. */
  end: "/sync/:workspaceId/members/end",
  /** POST {token} → WorkspaceJoinPreview. Signed in. */
  joinPreview: "/sync/members/join-preview",
  /** POST {token} → WorkspaceJoinResult. Signed in. */
  join: "/sync/members/join",
} as const;

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function isMemberState(value: unknown): value is MemberState {
  return typeof value === "string" && (MEMBER_STATES as readonly string[]).includes(value);
}

export function isInviteLinkAction(value: unknown): value is InviteLinkAction {
  return typeof value === "string" && (INVITE_LINK_ACTIONS as readonly string[]).includes(value);
}

const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";
const isNullableTime = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

function parsePerson(value: unknown): WorkspacePerson | null {
  if (!isRecord(value)) return null;
  const { memberId, role, state, name, email, invitedAtMs, joinedAtMs, removedAtMs } = value;
  if (typeof memberId !== "string" || memberId.length === 0) return null;
  if (!isWorkspaceRole(role) || !isMemberState(state)) return null;
  if (!isNullableString(name) || !isNullableString(email)) return null;
  if (!isNullableTime(invitedAtMs) || !isNullableTime(joinedAtMs) || !isNullableTime(removedAtMs)) return null;
  if ((role === "owner") !== (memberId === "owner")) return null;
  if (role === "owner" && state !== "active") return null;
  return { memberId, role, state, name, email, invitedAtMs, joinedAtMs, removedAtMs };
}

function parseInviteLink(value: unknown): WorkspaceInviteLink | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.enabled !== "boolean" || !isNullableString(value.url)) return undefined;
  if (value.enabled !== (value.url !== null)) return undefined;
  return { enabled: value.enabled, url: value.url };
}

/** Parse a relay response. Null means the response is unreadable. */
export function parseWorkspaceMembersView(value: unknown): WorkspaceMembersView | null {
  if (!isRecord(value)) return null;
  const { workspaceId, workspaceName, viewer, memberLevel, inviteLink, people } = value;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) return null;
  if (typeof workspaceName !== "string") return null;
  if (!isRecord(viewer) || typeof viewer.memberId !== "string" || !isWorkspaceRole(viewer.role)) return null;
  if (!isShareAccessValue(memberLevel)) return null;
  const link = parseInviteLink(inviteLink);
  if (link === undefined) return null;
  if (!Array.isArray(people) || people.length > MAX_WORKSPACE_MEMBERS + 1) return null;
  const parsed: WorkspacePerson[] = [];
  for (const entry of people) {
    const person = parsePerson(entry);
    if (!person) return null;
    parsed.push(person);
  }
  const manages = viewer.role !== "member";
  if (manages !== (link !== null)) return null;
  if (!manages && parsed.some((person) => person.email !== null || person.state !== "active")) return null;
  return {
    workspaceId,
    workspaceName,
    viewer: { memberId: viewer.memberId, role: viewer.role },
    memberLevel,
    inviteLink: link,
    people: parsed,
  };
}

export function parseWorkspaceJoinPreview(value: unknown): WorkspaceJoinPreview | null {
  if (!isRecord(value)) return null;
  const { workspaceName, ownerName, alreadyMember } = value;
  if (typeof workspaceName !== "string" || !isNullableString(ownerName) || typeof alreadyMember !== "boolean") return null;
  return { workspaceName, ownerName, alreadyMember };
}

export function parseWorkspaceJoinResult(value: unknown): WorkspaceJoinResult | null {
  if (!isRecord(value)) return null;
  const { workspaceId, shareId, workspaceName } = value;
  if (typeof workspaceId !== "string" || typeof shareId !== "string" || typeof workspaceName !== "string") return null;
  return { workspaceId, shareId, workspaceName };
}

/** What each role may do. The relay enforces this; clients use it only to show or hide controls. */
export function memberPermissions(viewer: WorkspaceRole) {
  return {
    invite: viewer !== "member",
    setLevel: viewer !== "member",
    manageInviteLink: viewer !== "member",
    setAdmins: viewer === "owner",
    removeMembers: viewer !== "member",
    removeAdmins: viewer === "owner",
    leave: viewer !== "owner",
    endForEveryone: viewer === "owner",
  } as const;
}
