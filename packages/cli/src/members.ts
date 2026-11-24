import { z } from "zod";
import {
  GROUP_RULE_LEVELS,
  FOLDER_RULE_STATES,
  isPaletteSlot,
  MAX_MEMBER_EMAIL_CHARS,
  MEMBER_STATES,
  WORKSPACE_ROLES,
  type InviteLinkAction,
  type WorkspaceMembersView,
} from "@dohc/security-contract/workspace-members";
import type { CapabilityId } from "@dohc/workspace-contracts/capabilities";
import { isFolderRuleId } from "@dohc/security-contract/access-rules";

// One request shape for the Members page and for agents through the CLI and
// MCP, in a workspace the person owns or joined. The desktop names the
// workspace and the account; the relay decides every action.

const level = z.enum(["view", "comment", "edit"]);
/** A member id from `list`, or the email of an invite or a person. */
const person = z.string().trim().min(1).max(MAX_MEMBER_EMAIL_CHARS);
const email = z
  .string()
  .trim()
  .min(3)
  .max(MAX_MEMBER_EMAIL_CHARS)
  .regex(/^[^\s@]+@[^\s@]+$/, "Enter an email address.");
/** A Group: its name or wire id from the CLI, its wire id from the Members page. */
const group = z.string().trim().min(1).max(256);
const groupRuleLevel = z.enum(GROUP_RULE_LEVELS);
const folder = z.string().max(4096);
const ruleVersion = {
  ruleId: z.string().refine(isFolderRuleId),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const folderAccess = {
  members: level.nullable(),
  people: z.array(z.object({ email, level }).strict()).max(1_000),
};
const linkChange = z.enum(["turn-on", "turn-off", "reset"] satisfies [
  InviteLinkAction,
  ...InviteLinkAction[],
]);

const agentActions = [
  z.object({ action: z.literal("list") }).strict(),
  z.object({ action: z.literal("invite"), email }).strict(),
  z.object({ action: z.literal("level"), level }).strict(),
  z.object({ action: z.literal("role"), person, role: z.enum(["admin", "member"]) }).strict(),
  z.object({ action: z.literal("remove"), person }).strict(),
  z.object({ action: z.literal("letBackIn"), person }).strict(),
  z.object({ action: z.literal("link"), change: linkChange }).strict(),
  z.object({ action: z.literal("end") }).strict(),
  // A Group's access for members. No `level` reads it; null clears the rule,
  // so the Group takes the member level.
  z
    .object({ action: z.literal("group"), group, level: groupRuleLevel.nullable().optional() })
    .strict(),
  z
    .object({
      action: z.literal("folder"),
      change: z.union([
        z.object({ folder, ...folderAccess, create: z.literal(true).optional() }).strict(),
        z.object({ ...ruleVersion, ...folderAccess }).strict(),
        z.object({ folder, clear: z.literal(true) }).strict(),
        z.object({ ...ruleVersion, clear: z.literal(true) }).strict(),
      ]),
    })
    .strict(),
  z.object({ action: z.literal("folderMarker"), folder }).strict(),
] as const;

/** What agents send through the CLI and MCP. Leaving stays in the app. */
export const AgentMembersRequest = z.discriminatedUnion("action", [...agentActions]);
export type AgentMembersRequest = z.infer<typeof AgentMembersRequest>;

/** What the Members page sends. Admins and members can also leave. */
export const MembersRequest = z.discriminatedUnion("action", [
  ...agentActions,
  z.object({ action: z.literal("leave") }).strict(),
]);
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
  group: "members.group.rule",
  folder: "members.folder.rule",
  folderMarker: "members.folder.marker.remove",
} as const satisfies Record<MembersRequest["action"], CapabilityId>;

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const WorkspacePersonSchema = z
  .object({
    memberId: z.string().min(1).max(256),
    role: z.enum(WORKSPACE_ROLES),
    state: z.enum(MEMBER_STATES),
    name: z.string().max(1024).nullable(),
    paletteSlot: z.number().refine(isPaletteSlot),
    email: z.string().max(MAX_MEMBER_EMAIL_CHARS).nullable(),
    invitedAtMs: time,
    joinedAtMs: time,
    removedAtMs: time,
  })
  .strict()
  .refine(
    (person) =>
      (person.role === "owner") === (person.memberId === "owner") &&
      (person.role !== "owner" || person.state === "active"),
    "Only the owner's entry is the owner, and it is active.",
  );

const InviteLinkSchema = z
  .object({ enabled: z.boolean(), url: z.string().url().max(4096).nullable() })
  .strict()
  .refine(
    (link) => link.enabled === (link.url !== null),
    "An invite link has a URL exactly while it is on.",
  );

const FolderRuleSchema = z
  .object({
    ...ruleVersion,
    members: level.nullable(),
    people: z
      .array(z.object({ email: z.string().max(MAX_MEMBER_EMAIL_CHARS), level }).strict())
      .max(1_000),
    folders: z
      .array(z.object({ path: z.string().max(4096), state: z.enum(FOLDER_RULE_STATES) }).strict())
      .max(10_000),
  })
  .strict();

/**
 * The relay's Members answer. A view that breaks a rule is unreadable, never
 * a narrower answer: the owner and admins get the invite link, and a member
 * sees only active people and no emails.
 */
const WorkspaceMembersViewSchema = z
  .object({
    workspaceId: z.string().min(1).max(256),
    workspaceName: z.string().max(1024),
    viewer: z
      .object({ memberId: z.string().min(1).max(256), role: z.enum(WORKSPACE_ROLES) })
      .strict(),
    memberLevel: level,
    inviteLink: InviteLinkSchema.nullable(),
    groupRules: z
      .array(
        z
          .object({ channelWireId: z.string().min(1).max(256), level: z.enum(GROUP_RULE_LEVELS) })
          .strict(),
      )
      .nullable(),
    folderRules: z.array(FolderRuleSchema).nullable(),
    people: z.array(WorkspacePersonSchema),
  })
  .strict()
  .refine(
    (view) => (view.viewer.role !== "member") === (view.inviteLink !== null),
    "Only the owner and admins get the invite link.",
  )
  .refine(
    (view) => (view.viewer.role !== "member") === (view.groupRules !== null),
    "Only the owner and admins get Group rules.",
  )
  .refine(
    (view) => (view.viewer.role !== "member") === (view.folderRules !== null),
    "Only the owner and admins get folder rules.",
  )
  .refine(
    (view) =>
      view.viewer.role !== "member" ||
      view.people.every((person) => person.email === null && person.state === "active"),
    "A member sees only active people and no emails.",
  ) satisfies z.ZodType<WorkspaceMembersView>;

export const MembersResult = z.discriminatedUnion("status", [
  // The workspace's people as the relay answered them for this account.
  z.object({ status: z.literal("ready"), view: WorkspaceMembersViewSchema }).strict(),
  // The relay lists no Members page for this account: membership ended, the
  // account was removed, or the workspace was never shared with members.
  z.object({ status: z.literal("refused") }).strict(),
  // Leave finished. This account has no page left to show.
  z.object({ status: z.literal("done") }).strict(),
  // One Group's access, as `dohc members group` shows it. Null is no rule:
  // the Group takes the member level.
  z
    .object({
      status: z.literal("group"),
      name: z.string().max(1024),
      level: groupRuleLevel.nullable(),
      memberLevel: level,
    })
    .strict(),
]);
export type MembersResult = z.infer<typeof MembersResult>;
export const MEMBERS_REFUSED = "Your server does not list Members for this workspace and account.";

// The desktop's Members words point at its page. A terminal has no page to
// reload, so they name the command that lists Members.
export function membersWordsForCli(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const words = error.message.replaceAll("Reload Members", "Run dohc members list");
  return words === error.message ? error : new Error(words);
}
