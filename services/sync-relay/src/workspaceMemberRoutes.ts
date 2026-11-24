import { jsonResponse } from "@dohc/service-http";
import { normalizeShareLabel } from "@dohc/security-contract/share-labels";
import {
  ACCESS_RULE_MAX_PEOPLE,
  formatAccessRule,
  isFolderRuleId,
  normalizeRuleEmail,
  prepareFolderRulePath,
  type AccessRule,
} from "@dohc/security-contract/access-rules";
import { isShareAccessValue, type ShareAccess } from "@dohc/security-contract/share-selector";
import {
  type BrowserWorkspaceList,
  isGroupRuleLevel,
  isInviteLinkAction,
  type GroupRuleLevel,
  MAX_MEMBER_EMAIL_CHARS,
  MESSAGE_DELETE_ID_MAX_CHARS,
  type WorkspaceJoinPreview,
  type WorkspaceJoinResult,
  type WorkspaceMembersView,
  type WorkspacePerson,
} from "@dohc/security-contract/workspace-members";
import { actorHueSlot } from "@dohc/workspace-contracts/actor-presentation";
import { nameSlug } from "@dohc/workspace-contracts/names";
import { normalizeEmail } from "@dohc/workspace-auth/signUp";
import { accountDisplayName, type LookupUserDisplayName } from "./accountDisplayName";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import type { FolderRuleChange, FolderRuleResult } from "./storage/folderRules";
import { hashLinkBearer, mintLinkBearer, sealLinkBearer, unsealLinkBearer } from "./linkSecurity";
import { parseShareId, parseString, parseWorkspaceId, readJsonObject } from "./requestInputs";
import type { SyncRelayStorage } from "./storage";
import {
  WORKSPACE_NAME_MAX_CHARS,
  type MemberChangeResult,
  type WorkspaceInviteLinkRow,
  type WorkspaceMembersSnapshot,
} from "./storage/workspaceMembers";

// The relay half of WORKSPACE_MEMBER_ROUTES in
// packages/security-contract/src/workspaceMembers.ts. Every role check runs
// in storage, inside the transaction that acts on it.

export type WorkspaceMemberRoute =
  | { route: "members"; workspaceId: string }
  | { route: "members-invite"; workspaceId: string }
  | { route: "members-level"; workspaceId: string }
  | { route: "members-invite-link"; workspaceId: string }
  | { route: "members-leave"; workspaceId: string }
  | { route: "members-end"; workspaceId: string }
  | { route: "members-folder-rules"; workspaceId: string }
  | { route: "members-folder-markers"; workspaceId: string }
  | { route: "members-role"; workspaceId: string; memberId: string }
  | { route: "members-remove"; workspaceId: string; memberId: string }
  | { route: "members-let-back-in"; workspaceId: string; memberId: string }
  | { route: "members-group-rule"; workspaceId: string; channelWireId: string }
  | { route: "members-join-preview" }
  | { route: "members-join" }
  | { route: "members-workspaces" }
  | { route: "members-group-create" }
  | { route: "members-message-delete"; workspaceId: string; messageId: string };

export const WORKSPACE_MEMBER_ROUTE_PATTERNS = {
  members: "/sync/:workspaceId/members",
  "members-invite": "/sync/:workspaceId/members/invites",
  "members-level": "/sync/:workspaceId/members/level",
  "members-invite-link": "/sync/:workspaceId/members/invite-link",
  "members-leave": "/sync/:workspaceId/members/leave",
  "members-end": "/sync/:workspaceId/members/end",
  "members-folder-rules": "/sync/:workspaceId/members/folder-rules",
  "members-folder-markers": "/sync/:workspaceId/members/folder-markers",
  "members-role": "/sync/:workspaceId/members/:memberId/role",
  "members-remove": "/sync/:workspaceId/members/:memberId/remove",
  "members-let-back-in": "/sync/:workspaceId/members/:memberId/let-back-in",
  "members-group-rule": "/sync/:workspaceId/members/groups/:channelWireId/rule",
  "members-join-preview": "/sync/members/join-preview",
  "members-join": "/sync/members/join",
  "members-workspaces": "/sync/members/workspaces",
  "members-group-create": "/sync/members/groups",
  "members-message-delete": "/sync/:workspaceId/chat/messages/:messageId/delete",
} as const satisfies Record<WorkspaceMemberRoute["route"], string>;

export function isWorkspaceMemberRoute(route: { route: string }): route is WorkspaceMemberRoute {
  return Object.hasOwn(WORKSPACE_MEMBER_ROUTE_PATTERNS, route.route);
}

const WORKSPACE_ACTIONS = {
  invites: "members-invite",
  level: "members-level",
  "invite-link": "members-invite-link",
  leave: "members-leave",
  end: "members-end",
  "folder-rules": "members-folder-rules",
  "folder-markers": "members-folder-markers",
} as const;
const MEMBER_ACTIONS = {
  role: "members-role",
  remove: "members-remove",
  "let-back-in": "members-let-back-in",
} as const;

/**
 * Parses `/sync/members/...`, `/sync/:workspaceId/members/...` and
 * `/sync/:workspaceId/chat/messages/:messageId/delete`; null for any other path.
 */
export function parseWorkspaceMemberRoute(parts: readonly string[]): WorkspaceMemberRoute | null {
  if (parts[0] !== "sync") return null;
  if (
    parts.length === 6 &&
    parts[2] === "chat" &&
    parts[3] === "messages" &&
    parts[5] === "delete"
  ) {
    try {
      return {
        route: "members-message-delete",
        workspaceId: parseWorkspaceId(parts[1]),
        messageId: parseString(parts[4], "messageId", MESSAGE_DELETE_ID_MAX_CHARS),
      };
    } catch {
      return null;
    }
  }
  if (parts.length === 3 && parts[1] === "members") {
    if (parts[2] === "join") return { route: "members-join" };
    if (parts[2] === "join-preview") return { route: "members-join-preview" };
    if (parts[2] === "workspaces") return { route: "members-workspaces" };
    if (parts[2] === "groups") return { route: "members-group-create" };
  }
  if (parts[2] !== "members" || parts.length < 3 || parts.length > 6) return null;
  let workspaceId: string;
  try {
    workspaceId = parseWorkspaceId(parts[1]);
  } catch {
    return null;
  }
  if (parts.length === 6) {
    return parts[3] === "groups" && parts[5] === "rule" && parts[4]
      ? { route: "members-group-rule", workspaceId, channelWireId: parts[4] }
      : null;
  }
  if (parts.length === 3) return { route: "members", workspaceId };
  if (parts.length === 4) {
    const route = WORKSPACE_ACTIONS[parts[3] as keyof typeof WORKSPACE_ACTIONS];
    return route ? { route, workspaceId } : null;
  }
  const route = MEMBER_ACTIONS[parts[4] as keyof typeof MEMBER_ACTIONS];
  return route ? { route, workspaceId, memberId: parseShareId(parts[3]) } : null;
}

const GROUP_NAME_MAX_CHARS = 80;
const GROUP_PURPOSE_MAX_CHARS = 200;
// The slug of the default agent's chat. It and every slug under it belong to
// agent chats, and the owner's computer refuses a Group that takes one.
const AGENT_CHAT_SLUG = "my-agent";

const FOLDER_RULE_TAKEN = "That folder already has an access rule. Change that rule instead.";
const FOLDER_RULE_CHANGED =
  "Someone changed this folder's access since you opened it. Open Members again.";

const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;

/** The invite link's token, as a URL fragment or a sign-up field. Anything else opens nothing. */
export function isWorkspaceInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN.test(value);
}

/** The stored form of an invite-link token. Domain-separated from share-link secrets. */
export function hashWorkspaceInviteToken(token: string, key: string | Uint8Array): string {
  return hashLinkBearer(`workspace-invite-v1:${token}`, key);
}

type MemberRouteStorage = Pick<
  SyncRelayStorage,
  | "readWorkspaceMembers"
  | "inviteWorkspaceMember"
  | "setWorkspaceMemberLevel"
  | "setWorkspaceMemberRole"
  | "removeWorkspaceMember"
  | "letWorkspaceMemberBackIn"
  | "leaveWorkspace"
  | "endWorkspaceMembership"
  | "changeWorkspaceInviteLink"
  | "previewWorkspaceJoin"
  | "joinWorkspace"
  | "createWorkspaceGroup"
  | "setWorkspaceGroupRule"
  | "deleteWorkspaceMessage"
  | "changeFolderRule"
  | "removeFolderMarkers"
  | "readFolderRules"
  | "listAccountWorkspaces"
  | "listJoinedWorkspaces"
  | "workspaceRoleOf"
>;

export function createWorkspaceMemberRoutes(options: {
  storage: MemberRouteStorage;
  nowMs: () => number;
  newId: () => string;
  newShareId: () => string;
  newGrantId: () => string;
  claimPendingShares: (userId: string, signal?: AbortSignal) => Promise<void>;
  resolveUserIdByEmail?: (email: string) => Promise<string | null> | string | null;
  lookupUserEmail?: (userId: string) => Promise<string | null> | string | null;
  lookupUserDisplayName?: LookupUserDisplayName;
  linkKey?: string | Uint8Array;
  shareWebOrigin?: string;
  hasValidRelayExchangeKey(request: Request): boolean;
  discussionActivity: Pick<DiscussionActivityHub, "wakeLog">;
}) {
  const { storage, linkKey, shareWebOrigin } = options;
  const sealContext = (workspaceId: string, generation: number) =>
    [`workspace-invite:${workspaceId}`, String(generation)] as const;
  const hashToken = (token: string) => hashWorkspaceInviteToken(token, linkKey!);

  const inviteUrl = (link: WorkspaceInviteLinkRow | null): string | null => {
    if (!link?.enabled || !linkKey || !shareWebOrigin) return null;
    const token = unsealLinkBearer(
      link.secretSealed,
      linkKey,
      ...sealContext(link.workspaceId, link.generation),
    );
    return token === null ? null : `${shareWebOrigin}/join#${token}`;
  };

  const lookupEmail = async (userId: string) => {
    try {
      return (await options.lookupUserEmail?.(userId)) ?? null;
    } catch {
      return null;
    }
  };

  const view = async (snapshot: WorkspaceMembersSnapshot): Promise<WorkspaceMembersView> => {
    const manages = snapshot.viewer.role !== "member";
    const shown = manages
      ? snapshot.members
      : snapshot.members.filter((entry) => entry.state === "active");
    const owner: WorkspacePerson = {
      memberId: "owner",
      role: "owner",
      state: "active",
      name: await accountDisplayName(options.lookupUserDisplayName, snapshot.ownerUserId),
      paletteSlot: actorHueSlot(snapshot.ownerUserId),
      email: manages ? await lookupEmail(snapshot.ownerUserId) : null,
      invitedAtMs: null,
      joinedAtMs: snapshot.membership?.createdAtMs ?? null,
      removedAtMs: null,
    };
    const people = await Promise.all(
      shown.map(async (entry): Promise<WorkspacePerson> => ({
        memberId: entry.memberId,
        role: entry.role,
        state: entry.state,
        name:
          entry.userId === null
            ? null
            : await accountDisplayName(options.lookupUserDisplayName, entry.userId),
        paletteSlot: actorHueSlot(entry.userId ?? entry.memberId),
        email: !manages
          ? null
          : entry.userId === null
            ? entry.email
            : await lookupEmail(entry.userId),
        invitedAtMs: entry.invitedAtMs,
        joinedAtMs: entry.state === "active" ? entry.joinedAtMs : null,
        removedAtMs: entry.state === "removed" ? entry.endedAtMs : null,
      })),
    );
    const url = manages ? inviteUrl(snapshot.inviteLink) : null;
    return {
      workspaceId: snapshot.workspaceId,
      workspaceName: snapshot.membership?.workspaceName ?? "",
      viewer: snapshot.viewer,
      memberLevel: snapshot.membership?.memberLevel ?? "comment",
      inviteLink: manages ? { enabled: url !== null, url } : null,
      groupRules: manages
        ? (snapshot.groupRules ?? []).map(({ channelWireId, level }) => ({
            channelWireId,
            level: level === null ? "none" : level === "view" ? "view" : "comment",
          }))
        : null,
      folderRules: manages
        ? storage.readFolderRules(snapshot.workspaceId).map(({ rule, ...entry }) => ({
            ...entry,
            members: rule.members,
            people: [...rule.people].map(([email, level]) => ({ email, level })),
          }))
        : null,
      people: [owner, ...people],
    };
  };

  const respondWithView = async (workspaceId: string, userId: string) => {
    let snapshot = storage.readWorkspaceMembers(workspaceId, userId);
    for (;;) {
      if (!snapshot) throw notFound();
      const body = await view(snapshot);
      // The account lookups wait, and the viewer's role can change meanwhile.
      // Without this check a removed or demoted admin receives emails and the
      // invite link.
      const current = storage.readWorkspaceMembers(workspaceId, userId);
      if (current?.viewer.role === snapshot.viewer.role)
        return jsonResponse(body, 200, { "cache-control": "private, no-store" });
      snapshot = current;
    }
  };

  const settle = (result: MemberChangeResult, workspaceId: string) => {
    if (result.ok) {
      // Held reads re-check their grant when woken, so a change that ends or
      // narrows access ends them now rather than at their deadline.
      options.discussionActivity.wakeLog(workspaceId);
      return;
    }
    switch (result.reason) {
      case "not-found":
        throw notFound();
      case "forbidden":
        throw relayError("members_forbidden");
      case "name-required":
        throw relayError("workspace_name_required");
      case "already-member":
      case "already-invited":
        throw relayError("member_exists");
      case "removed":
        throw relayError("member_removed");
      case "full":
        throw relayError("workspace_full");
      case "account-unavailable":
        throw notFound();
    }
  };

  const parseWorkspaceName = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > WORKSPACE_NAME_MAX_CHARS * 4)
      throw badRequest("workspaceName is invalid");
    const name = normalizeShareLabel(value, WORKSPACE_NAME_MAX_CHARS);
    if (name === null || [...value.trim()].length > WORKSPACE_NAME_MAX_CHARS)
      throw badRequest(`workspaceName must be 1 to ${WORKSPACE_NAME_MAX_CHARS} characters`);
    return name;
  };

  // A Group's name, its slug, and its kind and purpose, held to the rules the
  // owner's computer applies to a Group it receives.
  const parseGroup = (input: Record<string, unknown>) => {
    if (typeof input.name !== "string" || input.name.length > GROUP_NAME_MAX_CHARS * 4)
      throw badRequest("name is invalid");
    const name = input.name.normalize("NFC").trim();
    // eslint-disable-next-line no-control-regex
    if (!name || name.length > GROUP_NAME_MAX_CHARS || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw badRequest(`name must be 1 to ${GROUP_NAME_MAX_CHARS} characters`);
    }
    const slug = nameSlug(name);
    if (!slug) throw badRequest("name needs a letter or a number");
    if (slug === AGENT_CHAT_SLUG || slug.startsWith(`${AGENT_CHAT_SLUG}-`))
      throw badRequest("name is kept for agent chats");
    if (
      input.type !== undefined &&
      input.type !== "posts" &&
      input.type !== "chat" &&
      input.type !== "both"
    ) {
      throw badRequest('type must be "posts", "chat", or "both"');
    }
    if (
      input.purpose !== undefined &&
      (typeof input.purpose !== "string" ||
        /[\n\r]/u.test(input.purpose) ||
        input.purpose.trim().length > GROUP_PURPOSE_MAX_CHARS)
    ) {
      throw badRequest(`purpose is one line of at most ${GROUP_PURPOSE_MAX_CHARS} characters`);
    }
    return {
      name,
      slug,
      type: input.type as "posts" | "chat" | "both" | undefined,
      purpose: input.purpose?.trim(),
    };
  };

  // A Group's rule names one level for every member. Person entries are not taken here.
  const parseGroupRuleLevel = (value: unknown): GroupRuleLevel => {
    if (!isGroupRuleLevel(value)) throw badRequest('level must be "comment", "view", or "none"');
    return value;
  };
  const storedLevel = (level: GroupRuleLevel) => (level === "none" ? null : level);

  // A workspace-relative folder, "" for the root, checked as the path its
  // marker takes.
  const parseFolder = (value: unknown): string => {
    const folder = typeof value === "string" ? prepareFolderRulePath(value) : null;
    if (folder === null) throw badRequest("folder is invalid");
    return folder;
  };

  const parseLevel = (value: unknown, name: string): ShareAccess => {
    if (!isShareAccessValue(value))
      throw badRequest(`${name} must be "view", "comment", or "edit"`);
    return value;
  };

  const parseRule = (input: Record<string, unknown>): AccessRule => {
    const members = input.members === null ? null : parseLevel(input.members, "members");
    if (!Array.isArray(input.people) || input.people.length > ACCESS_RULE_MAX_PEOPLE)
      throw badRequest("people is invalid");
    const people = new Map<string, ShareAccess>();
    for (const entry of input.people as unknown[]) {
      const { email, level } = (entry ?? {}) as Record<string, unknown>;
      if (typeof email !== "string" || email.length > MAX_MEMBER_EMAIL_CHARS)
        throw badRequest("people is invalid");
      const key = normalizeRuleEmail(email);
      if (!/^[^\s@]+@[^\s@]+$/u.test(key) || people.has(key)) throw badRequest("people is invalid");
      people.set(key, parseLevel(level, "level"));
    }
    const rule = { members, people };
    if (formatAccessRule(rule) === null) throw badRequest("people is invalid");
    return rule;
  };

  const parseFolderRuleChange = (input: Record<string, unknown>): FolderRuleChange => {
    if (input.ruleId === undefined) {
      return { kind: "create", folder: parseFolder(input.folder), rule: parseRule(input) };
    }
    if (!isFolderRuleId(input.ruleId)) throw badRequest("ruleId is invalid");
    if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1)
      throw badRequest("revision is invalid");
    const revision = input.revision as number;
    if (input.clear === true) return { kind: "clear", ruleId: input.ruleId, revision };
    return { kind: "change", ruleId: input.ruleId, revision, rule: parseRule(input) };
  };

  const settleFolderRule = (
    result: FolderRuleResult | { ok: true } | { ok: false; reason: "not-found" | "forbidden" },
    workspaceId: string,
    conflict = FOLDER_RULE_CHANGED,
  ) => {
    if (result.ok) {
      // Held reads re-check their grant when woken, as `settle` explains.
      options.discussionActivity.wakeLog(workspaceId);
      return;
    }
    if (result.reason === "forbidden") throw relayError("members_forbidden");
    if (result.reason === "conflict") throw relayError("conflict", conflict);
    throw notFound();
  };

  const parseToken = (value: unknown): string => {
    if (!isWorkspaceInviteToken(value)) throw notFound();
    return value;
  };

  return async function respondToWorkspaceMembers(
    request: Request,
    route: WorkspaceMemberRoute,
    actor: { userId: string },
  ): Promise<Response> {
    // A browser signs in with a cookie. Only the share site may send it here,
    // so another site cannot invite, remove, or join on a person's behalf.
    if (
      request.headers.has("cookie") &&
      (!shareWebOrigin || request.headers.get("origin") !== shareWebOrigin)
    )
      throw notFound();
    const userId = actor.userId;
    if (route.route === "members") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      await options.claimPendingShares(userId, request.signal);
      return respondWithView(route.workspaceId, userId);
    }
    if (route.route === "members-group-rule") {
      if (request.method !== "PUT") throw relayError("method_not_allowed");
      const input = await readJsonObject(request);
      if (Object.keys(input).some((key) => key !== "level"))
        throw badRequest("a Group's rule takes only level");
      const level =
        input.level === null ? undefined : storedLevel(parseGroupRuleLevel(input.level));
      const result = storage.setWorkspaceGroupRule({
        workspaceId: route.workspaceId,
        channelWireId: route.channelWireId,
        actorUserId: userId,
        level,
        nowMs: options.nowMs(),
      });
      if (!result.ok) throw notFound();
      // Held reads and personal-agent waits recheck when woken, so a Group
      // that became hidden leaves them now.
      options.discussionActivity.wakeLog(route.workspaceId);
      return respondWithView(route.workspaceId, userId);
    }
    if (route.route === "members-workspaces") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      // Only share-web asks, for the browser signed in with this cookie.
      if (!request.headers.has("cookie") || !options.hasValidRelayExchangeKey(request))
        throw notFound();
      const body: BrowserWorkspaceList = {
        ok: true,
        owned: storage
          .listAccountWorkspaces(userId)
          .filter(
            ({ workspaceId }) => storage.workspaceRoleOf(workspaceId, userId)?.role === "owner",
          )
          .map(({ workspaceId, name }) => ({ workspaceId, name })),
        joined: storage.listJoinedWorkspaces(userId),
      };
      return jsonResponse(body, 200, { "cache-control": "private, no-store" });
    }
    if (request.method !== "POST") throw relayError("method_not_allowed");

    if (route.route === "members-join-preview" || route.route === "members-join") {
      if (!linkKey) throw notFound();
      const secretHash = hashToken(parseToken((await readJsonObject(request)).token));
      if (route.route === "members-join-preview") {
        const preview = storage.previewWorkspaceJoin({ secretHash, userId });
        if (!preview) throw notFound();
        const body: WorkspaceJoinPreview = {
          workspaceName: preview.workspaceName,
          ownerName: await accountDisplayName(options.lookupUserDisplayName, preview.ownerUserId),
          alreadyMember: preview.alreadyMember,
          grantId: preview.grantId,
        };
        return jsonResponse(body, 200, { "cache-control": "private, no-store" });
      }
      const joined = storage.joinWorkspace({
        secretHash,
        userId,
        newMemberId: options.newId,
        newGrantId: options.newGrantId,
        nowMs: options.nowMs(),
      });
      if (!joined.ok) {
        if (joined.reason === "removed") throw relayError("member_removed");
        if (joined.reason === "full") throw relayError("workspace_full");
        // The owner opening their own link is already in the workspace.
        if (joined.reason !== "owner") throw notFound();
        throw relayError("member_exists");
      }
      options.discussionActivity.wakeLog(joined.workspaceId);
      await accountDisplayName(options.lookupUserDisplayName, userId);
      const body: WorkspaceJoinResult = {
        workspaceId: joined.workspaceId,
        shareId: joined.shareId,
        workspaceName: joined.workspaceName,
        grantId: joined.grantId,
      };
      return jsonResponse(body, 200, { "cache-control": "private, no-store" });
    }

    if (route.route === "members-group-create") {
      const input = await readJsonObject(request);
      // The membership share names the workspace, or the owner's computer
      // names its own; the caller's role in it decides.
      const place =
        typeof input.shareId === "string" && input.workspaceId === undefined
          ? { shareId: parseShareId(input.shareId) }
          : typeof input.workspaceId === "string" && input.shareId === undefined
            ? { workspaceId: parseWorkspaceId(input.workspaceId) }
            : null;
      if (!place) throw badRequest("shareId is invalid");
      const group = parseGroup(input);
      const created = storage.createWorkspaceGroup({
        ...place,
        actorUserId: userId,
        ...group,
        ...(input.level === undefined
          ? {}
          : { level: storedLevel(parseGroupRuleLevel(input.level)) }),
        nowMs: options.nowMs(),
      });
      if (!created.ok) {
        if (created.reason === "forbidden") throw relayError("members_forbidden");
        if (created.reason === "workspace-quota") throw relayError("quota_exceeded");
        throw notFound();
      }
      options.discussionActivity.wakeLog(created.workspaceId);
      return jsonResponse(
        { ok: true, channelWireId: created.channelWireId, name: group.name },
        200,
        { "cache-control": "no-store" },
      );
    }

    if (route.route === "members-message-delete") {
      const input = await readJsonObject(request);
      const threadId = parseString(input.threadId, "threadId", MESSAGE_DELETE_ID_MAX_CHARS);
      const deleted = storage.deleteWorkspaceMessage({
        workspaceId: route.workspaceId,
        threadId,
        messageId: route.messageId,
        actor: { kind: "account", userId },
        nowMs: options.nowMs(),
      });
      if (!deleted.ok) throw notFound();
      // Copies and open follows pull the delete now.
      if (!deleted.repeated) options.discussionActivity.wakeLog(route.workspaceId);
      const { messageId, threadId: deletedThreadId, deletedAtMs } = deleted.tombstone.payload;
      return jsonResponse({ messageId, threadId: deletedThreadId, deletedAtMs }, 200, {
        "cache-control": "no-store",
      });
    }

    const { workspaceId } = route;
    const input = await readJsonObject(request);
    const nowMs = options.nowMs();
    switch (route.route) {
      case "members-invite": {
        if (!options.resolveUserIdByEmail)
          throw badRequest("recipient email lookup is not available on this relay");
        if (typeof input.email !== "string" || input.email.length > MAX_MEMBER_EMAIL_CHARS)
          throw badRequest("email is invalid");
        const email = normalizeEmail(input.email);
        if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw badRequest("email is invalid");
        const workspaceName = parseWorkspaceName(input.workspaceName);
        const resolved = await options.resolveUserIdByEmail(email);
        const invite = (recipientUserId: string | null) =>
          storage.inviteWorkspaceMember({
            workspaceId,
            actorUserId: userId,
            workspaceName,
            email,
            recipientUserId,
            newMemberId: options.newId,
            newGrantId: options.newGrantId,
            newShareId: options.newShareId,
            nowMs,
          });
        let result = invite(resolved);
        // An account being deleted counts as no account: its address gets an email invite.
        if (!result.ok && result.reason === "account-unavailable" && resolved !== null)
          result = invite(null);
        settle(result, workspaceId);
        return respondWithView(workspaceId, userId);
      }
      case "members-level": {
        if (!isShareAccessValue(input.level))
          throw badRequest('level must be "view", "comment", or "edit"');
        const workspaceName = parseWorkspaceName(input.workspaceName);
        settle(
          storage.setWorkspaceMemberLevel({
            workspaceId,
            actorUserId: userId,
            level: input.level,
            workspaceName,
            newShareId: options.newShareId,
            nowMs,
          }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
      }
      case "members-role": {
        if (input.role !== "admin" && input.role !== "member")
          throw badRequest('role must be "admin" or "member"');
        settle(
          storage.setWorkspaceMemberRole({
            workspaceId,
            actorUserId: userId,
            memberId: route.memberId,
            role: input.role,
          }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
      }
      case "members-remove":
        settle(
          storage.removeWorkspaceMember({
            workspaceId,
            actorUserId: userId,
            memberId: route.memberId,
            nowMs,
          }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
      case "members-let-back-in":
        settle(
          storage.letWorkspaceMemberBackIn({
            workspaceId,
            actorUserId: userId,
            memberId: route.memberId,
            newGrantId: options.newGrantId,
            nowMs,
          }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
      case "members-invite-link": {
        if (!isInviteLinkAction(input.action))
          throw badRequest('action must be "turn-on", "turn-off", or "reset"');
        if (input.action !== "turn-off" && (!linkKey || !shareWebOrigin)) throw notFound();
        const workspaceName = parseWorkspaceName(input.workspaceName);
        settle(
          storage.changeWorkspaceInviteLink({
            workspaceId,
            actorUserId: userId,
            action: input.action,
            workspaceName,
            newShareId: options.newShareId,
            nowMs,
            mint: (generation) => {
              const token = mintLinkBearer();
              return {
                secretHash: hashToken(token),
                secretSealed: sealLinkBearer(
                  token,
                  linkKey!,
                  ...sealContext(workspaceId, generation),
                ),
              };
            },
          }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
      }
      case "members-leave":
        settle(storage.leaveWorkspace({ workspaceId, userId, nowMs }), workspaceId);
        return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
      case "members-end":
        settle(
          storage.endWorkspaceMembership({ workspaceId, actorUserId: userId, nowMs }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
      case "members-folder-rules": {
        const change = parseFolderRuleChange(input);
        settleFolderRule(
          storage.changeFolderRule({ workspaceId, actorUserId: userId, change, nowMs }),
          workspaceId,
          change.kind === "create" ? FOLDER_RULE_TAKEN : FOLDER_RULE_CHANGED,
        );
        return respondWithView(workspaceId, userId);
      }
      case "members-folder-markers":
        settleFolderRule(
          storage.removeFolderMarkers({
            workspaceId,
            actorUserId: userId,
            folder: parseFolder(input.folder),
            nowMs,
          }),
          workspaceId,
        );
        return respondWithView(workspaceId, userId);
    }
  };
}
