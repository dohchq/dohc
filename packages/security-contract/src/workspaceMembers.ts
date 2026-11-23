import { ACTOR_HUES } from "@dohc/workspace-contracts/actor-presentation";
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

/** The longest message or thread id any door takes to delete a message. */
export const MESSAGE_DELETE_ID_MAX_CHARS = 512;

// A failed delete's words on the desktop, in the CLI and on the share page.
// The failure leads; the refusal or the offline words follow it. The relay
// answers not-found to every refused delete, so the refusal fits a message
// that is gone, someone else's, or one a changed role no longer covers.
export const MESSAGE_DELETE_FAILED = "dohc could not delete the message.";
export const MESSAGE_DELETE_REFUSED = "It is gone, or your role does not let you delete it.";
export const MESSAGE_DELETE_OFFLINE = "Deleting needs a connection.";

export interface WorkspacePerson {
  /** Stable id of this entry. The owner's entry uses `"owner"`. */
  memberId: string;
  role: WorkspaceRole;
  state: MemberState;
  /** The account's name. Null for an invite, or when the account has no name. */
  name: string | null;
  /**
   * The person's colour, the one presence and direct messages give the same account.
   * An invite, which has no account yet, takes it from `memberId`.
   */
  paletteSlot: number;
  /** Present only when the viewer is the owner or an admin. */
  email: string | null;
  invitedAtMs: number | null;
  joinedAtMs: number | null;
  removedAtMs: number | null;
}

/**
 * A Group's rule: one level for every member. Group settings shows them as
 * "Can post", "View only" and "No access". Admins and the owner always reach
 * every Group at Edit.
 */
export const GROUP_RULE_LEVELS = ["comment", "view", "none"] as const;
export type GroupRuleLevel = (typeof GROUP_RULE_LEVELS)[number];

export function isGroupRuleLevel(value: unknown): value is GroupRuleLevel {
  return typeof value === "string" && (GROUP_RULE_LEVELS as readonly string[]).includes(value);
}

export interface WorkspaceGroupRule {
  channelWireId: string;
  level: GroupRuleLevel;
}

/**
 * A folder a rule covers, as the relay sees the owner's files:
 * - `covered`: the folder holds the rule's marker.
 * - `marker-missing`: the folder has files but no marker naming the rule.
 * - `folder-missing`: no file is left at that path.
 */
export const FOLDER_RULE_STATES = ["covered", "marker-missing", "folder-missing"] as const;
export type FolderRuleState = (typeof FOLDER_RULE_STATES)[number];

export const FOLDER_RULE_CHANGED =
  "Someone changed this folder's access. Reload Members, check the rule, and save again.";

/** A folder access rule the relay keeps (ADR 0017). */
export interface WorkspaceFolderRule {
  ruleId: string;
  /** Send it back with a change, so a change made from an older read is refused. */
  revision: number;
  /** The level for members no person entry names. Null hides the folder from them. */
  members: ShareAccess | null;
  people: Array<{ email: string; level: ShareAccess }>;
  folders: Array<{ path: string; state: FolderRuleState }>;
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
  /** Present only for the owner and admins, since it names folders hidden from members. */
  folderRules: WorkspaceFolderRule[] | null;
  /**
   * Each Group with a rule. Present only for the owner and admins, since it
   * names Groups hidden from members. A Group not listed takes `memberLevel`.
   */
  groupRules: WorkspaceGroupRule[] | null;
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
  /** The account's own membership grant, which opens the workspace in a browser. Null for the owner and for someone not yet in it. */
  grantId: string | null;
}

export interface WorkspaceJoinResult {
  workspaceId: string;
  shareId: string;
  workspaceName: string;
  /** The account's own membership grant, which opens the workspace in a browser. */
  grantId: string;
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
  /**
   * POST {shareId, name, type?, purpose?, level?} → {ok, channelWireId, name}.
   * Owner or admin, through the membership share. The relay writes an
   * ordinary Group into the owner's workspace, and `level` as its rule.
   */
  groupCreate: "/sync/members/groups",
  /**
   * PUT {level: GroupRuleLevel | null} → WorkspaceMembersView. Owner or
   * admin. Null clears the rule, so the Group takes the member level.
   */
  groupRule: "/sync/:workspaceId/members/groups/:channelWireId/rule",
  /**
   * POST {threadId} → {messageId, threadId, deletedAtMs}. Deletes a message in a Group or
   * a file's Comments: the owner or an admin any message, a member their own.
   * Every refusal answers not-found.
   */
  messageDelete: "/sync/:workspaceId/chat/messages/:messageId/delete",
  /**
   * POST → WorkspaceMembersView. Owner or admin. One of:
   * - {folder, members, people}: a new rule for a workspace-relative folder
   *   ("" is the workspace root).
   * - {ruleId, revision, members, people}: change a rule.
   * - {ruleId, revision, clear: true}: clear a rule.
   * `members` is a level or null; `people` is [{email, level}].
   */
  folderRules: "/sync/:workspaceId/members/folder-rules",
  /**
   * POST {folder} → WorkspaceMembersView. Owner or admin. Removes a marker
   * that names no rule, so the folder it hides opens again.
   */
  folderMarkers: "/sync/:workspaceId/members/folder-markers",
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
export const isPaletteSlot = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < ACTOR_HUES.length;

export function parseWorkspaceJoinPreview(value: unknown): WorkspaceJoinPreview | null {
  if (!isRecord(value)) return null;
  const { workspaceName, ownerName, alreadyMember, grantId } = value;
  if (
    typeof workspaceName !== "string" ||
    !isNullableString(ownerName) ||
    typeof alreadyMember !== "boolean" ||
    !isNullableString(grantId) ||
    (grantId !== null && !alreadyMember)
  )
    return null;
  return { workspaceName, ownerName, alreadyMember, grantId };
}

export function parseWorkspaceJoinResult(value: unknown): WorkspaceJoinResult | null {
  if (!isRecord(value)) return null;
  const { workspaceId, shareId, workspaceName, grantId } = value;
  if (
    typeof workspaceId !== "string" ||
    typeof shareId !== "string" ||
    typeof workspaceName !== "string" ||
    typeof grantId !== "string"
  )
    return null;
  return { workspaceId, shareId, workspaceName, grantId };
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
