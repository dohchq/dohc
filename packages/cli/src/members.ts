import { z } from "zod";
import {
  MAX_MEMBER_EMAIL_CHARS, MAX_WORKSPACE_MEMBERS, MEMBER_STATES, WORKSPACE_ROLES,
  type InviteLinkAction, type WorkspaceMembersView,
} from "@dohc/security-contract/workspace-members";
import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";

// One request shape for the Members page, the owner's CLI, and MCP. The
// desktop names the workspace; the relay decides every action.

const level = z.enum(["view", "comment", "edit"]);
/** A member id from `list`, or the email of an invite or a person. */
const person = z.string().trim().min(1).max(MAX_MEMBER_EMAIL_CHARS);
const email = z.string().trim().min(3).max(MAX_MEMBER_EMAIL_CHARS).regex(/^[^\s@]+@[^\s@]+$/, "Enter an email address.");
const linkChange = z.enum(["turn-on", "turn-off", "reset"] satisfies [InviteLinkAction, ...InviteLinkAction[]]);

const ownerActions = [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("invite"), email }).strict(),
  z.object({ action: z.literal("level"), level }).strict(),
  z.object({ action: z.literal("role"), person, role: z.enum(["admin", "member"]) }).strict(),
  z.object({ action: z.literal("remove"), person }).strict(),
  z.object({ action: z.literal("letBackIn"), person }).strict(),
  z.object({ action: z.literal("link"), change: linkChange }).strict(),
  z.object({ action: z.literal("end") }).strict(),
] as const;

/** What the owner's CLI and MCP send. The owner cannot leave. */
export const OwnerMembersRequest = z.discriminatedUnion("action", [...ownerActions]);
export type OwnerMembersRequest = z.infer<typeof OwnerMembersRequest>;

/** What the Members page sends. Admins and members can also leave. */
export const MembersRequest = z.discriminatedUnion("action", [...ownerActions, z.object({ action: z.literal("leave") }).strict()]);
export type MembersRequest = z.infer<typeof MembersRequest>;

export const MEMBERS_CAPABILITIES = {
  list: "members.list",
  invite: "members.invite",
  level: "members.level.set",
  role: "members.role.set",
  remove: "members.remove",
  letBackIn: "members.readmit",
  link: "members.link.change",
  end: "members.end",
  leave: "members.leave",
} as const satisfies Record<MembersRequest["action"], CapabilityId>;

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const WorkspacePersonSchema = z.object({
  memberId: z.string().min(1).max(256),
  role: z.enum(WORKSPACE_ROLES),
  state: z.enum(MEMBER_STATES),
  name: z.string().max(1024).nullable(),
  email: z.string().max(MAX_MEMBER_EMAIL_CHARS).nullable(),
  invitedAtMs: time,
  joinedAtMs: time,
  removedAtMs: time,
}).strict();

export const WorkspaceMembersViewSchema = z.object({
  workspaceId: z.string().min(1).max(256),
  workspaceName: z.string().max(1024),
  viewer: z.object({ memberId: z.string().min(1).max(256), role: z.enum(WORKSPACE_ROLES) }).strict(),
  memberLevel: level,
  inviteLink: z.object({ enabled: z.boolean(), url: z.string().url().max(4096).nullable() }).strict().nullable(),
  people: z.array(WorkspacePersonSchema).max(MAX_WORKSPACE_MEMBERS + 1),
}).strict() satisfies z.ZodType<WorkspaceMembersView>;

export const MembersResult = z.discriminatedUnion("status", [
  // The workspace's people as the relay answered them for this account.
  z.object({ status: z.literal("ready"), view: WorkspaceMembersViewSchema }).strict(),
  // The relay lists no Members page for this account: membership ended, the
  // account was removed, or the workspace was never shared with members.
  z.object({ status: z.literal("refused") }).strict(),
  // Leave or end membership finished. There is no page left to show.
  z.object({ status: z.literal("done") }).strict(),
]);
export type MembersResult = z.infer<typeof MembersResult>;
