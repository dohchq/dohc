import { jsonResponse } from "@dohc/service-http";
import { normalizeShareLabel } from "@dohc/security-contract/share-labels";
import { isShareAccessValue } from "@dohc/security-contract/share-selector";
import {
  isInviteLinkAction,
  MAX_MEMBER_EMAIL_CHARS,
  type WorkspaceJoinPreview,
  type WorkspaceJoinResult,
  type WorkspaceMembersView,
  type WorkspacePerson,
} from "@dohc/security-contract/workspace-members";
import { normalizeEmail } from "@dohc/workspace-auth/signUp";
import { accountDisplayName, type LookupUserDisplayName } from "./accountDisplayName";
import type { DiscussionActivityHub } from "./discussionActivity";
import { badRequest, notFound, relayError } from "./errors";
import { hashLinkBearer, mintLinkBearer, sealLinkBearer, unsealLinkBearer } from "./linkSecurity";
import { parseShareId, parseWorkspaceId, readJsonObject } from "./requestInputs";
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
  | { route: "members-role"; workspaceId: string; memberId: string }
  | { route: "members-remove"; workspaceId: string; memberId: string }
  | { route: "members-let-back-in"; workspaceId: string; memberId: string }
  | { route: "members-join-preview" }
  | { route: "members-join" };

export const WORKSPACE_MEMBER_ROUTE_PATTERNS = {
  members: "/sync/:workspaceId/members",
  "members-invite": "/sync/:workspaceId/members/invites",
  "members-level": "/sync/:workspaceId/members/level",
  "members-invite-link": "/sync/:workspaceId/members/invite-link",
  "members-leave": "/sync/:workspaceId/members/leave",
  "members-end": "/sync/:workspaceId/members/end",
  "members-role": "/sync/:workspaceId/members/:memberId/role",
  "members-remove": "/sync/:workspaceId/members/:memberId/remove",
  "members-let-back-in": "/sync/:workspaceId/members/:memberId/let-back-in",
  "members-join-preview": "/sync/members/join-preview",
  "members-join": "/sync/members/join",
} as const satisfies Record<WorkspaceMemberRoute["route"], string>;

export function isWorkspaceMemberRoute(route: { route: string }): route is WorkspaceMemberRoute {
  return Object.hasOwn(WORKSPACE_MEMBER_ROUTE_PATTERNS, route.route);
}

const WORKSPACE_ACTIONS = { invites: "members-invite", level: "members-level", "invite-link": "members-invite-link", leave: "members-leave", end: "members-end" } as const;
const MEMBER_ACTIONS = { role: "members-role", remove: "members-remove", "let-back-in": "members-let-back-in" } as const;

/** Parses `/sync/members/join*` and `/sync/:workspaceId/members/...`; null for any other path. */
export function parseWorkspaceMemberRoute(parts: readonly string[]): WorkspaceMemberRoute | null {
  if (parts[0] !== "sync") return null;
  if (parts.length === 3 && parts[1] === "members") {
    if (parts[2] === "join") return { route: "members-join" };
    if (parts[2] === "join-preview") return { route: "members-join-preview" };
    return null;
  }
  if (parts[2] !== "members" || parts.length < 3 || parts.length > 5) return null;
  let workspaceId: string;
  try { workspaceId = parseWorkspaceId(parts[1]); } catch { return null; }
  if (parts.length === 3) return { route: "members", workspaceId };
  if (parts.length === 4) {
    const route = WORKSPACE_ACTIONS[parts[3] as keyof typeof WORKSPACE_ACTIONS];
    return route ? { route, workspaceId } : null;
  }
  const route = MEMBER_ACTIONS[parts[4] as keyof typeof MEMBER_ACTIONS];
  return route ? { route, workspaceId, memberId: parseShareId(parts[3]) } : null;
}

const INVITE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/u;

/** The invite link's token, as a URL fragment or a sign-up field. Anything else opens nothing. */
export function isWorkspaceInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN.test(value);
}

/** The stored form of an invite-link token. Domain-separated from share-link secrets. */
export function hashWorkspaceInviteToken(token: string, key: string | Uint8Array): string {
  return hashLinkBearer(`workspace-invite-v1:${token}`, key);
}

type MemberRouteStorage = Pick<SyncRelayStorage,
  | "readWorkspaceMembers" | "inviteWorkspaceMember" | "setWorkspaceMemberLevel" | "setWorkspaceMemberRole"
  | "removeWorkspaceMember" | "letWorkspaceMemberBackIn" | "leaveWorkspace" | "endWorkspaceMembership"
  | "changeWorkspaceInviteLink" | "previewWorkspaceJoin" | "joinWorkspace">;

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
  discussionActivity: Pick<DiscussionActivityHub, "wakeLog">;
}) {
  const { storage, linkKey, shareWebOrigin } = options;
  const sealContext = (workspaceId: string, generation: number) => [`workspace-invite:${workspaceId}`, String(generation)] as const;
  const hashToken = (token: string) => hashWorkspaceInviteToken(token, linkKey!);

  const inviteUrl = (link: WorkspaceInviteLinkRow | null): string | null => {
    if (!link?.enabled || !linkKey || !shareWebOrigin) return null;
    const token = unsealLinkBearer(link.secretSealed, linkKey, ...sealContext(link.workspaceId, link.generation));
    return token === null ? null : `${shareWebOrigin}/join#${token}`;
  };

  const lookupEmail = async (userId: string) => {
    try { return (await options.lookupUserEmail?.(userId)) ?? null; } catch { return null; }
  };

  const view = async (snapshot: WorkspaceMembersSnapshot): Promise<WorkspaceMembersView> => {
    const manages = snapshot.viewer.role !== "member";
    const shown = manages ? snapshot.members : snapshot.members.filter((entry) => entry.state === "active");
    const owner: WorkspacePerson = {
      memberId: "owner",
      role: "owner",
      state: "active",
      name: await accountDisplayName(options.lookupUserDisplayName, snapshot.ownerUserId),
      email: manages ? await lookupEmail(snapshot.ownerUserId) : null,
      invitedAtMs: null,
      joinedAtMs: snapshot.membership?.createdAtMs ?? null,
      removedAtMs: null,
    };
    const people = await Promise.all(shown.map(async (entry): Promise<WorkspacePerson> => ({
      memberId: entry.memberId,
      role: entry.role,
      state: entry.state === "invited" ? "invited" : entry.state === "active" ? "active" : "removed",
      name: entry.userId === null ? null : await accountDisplayName(options.lookupUserDisplayName, entry.userId),
      email: !manages ? null : entry.userId === null ? entry.email : await lookupEmail(entry.userId),
      invitedAtMs: entry.invitedAtMs,
      joinedAtMs: entry.state === "active" ? entry.joinedAtMs : null,
      removedAtMs: entry.state === "removed" ? entry.endedAtMs : null,
    })));
    const url = manages ? inviteUrl(snapshot.inviteLink) : null;
    return {
      workspaceId: snapshot.workspaceId,
      workspaceName: snapshot.membership?.workspaceName ?? "",
      viewer: snapshot.viewer,
      memberLevel: snapshot.membership?.memberLevel ?? "comment",
      inviteLink: manages ? { enabled: url !== null, url } : null,
      people: [owner, ...people],
    };
  };

  const respondWithView = async (workspaceId: string, userId: string) => {
    const snapshot = storage.readWorkspaceMembers(workspaceId, userId);
    if (!snapshot) throw notFound();
    return jsonResponse(await view(snapshot), 200, { "cache-control": "private, no-store" });
  };

  const settle = (result: MemberChangeResult, workspaceId: string) => {
    if (result.ok) {
      // Held reads re-check their grant when woken, so a change that ends or
      // narrows access ends them now rather than at their deadline.
      options.discussionActivity.wakeLog(workspaceId);
      return;
    }
    switch (result.reason) {
      case "not-found": throw notFound();
      case "forbidden": throw relayError("members_forbidden");
      case "name-required": throw relayError("workspace_name_required");
      case "already-member":
      case "already-invited": throw relayError("member_exists");
      case "removed": throw relayError("member_removed");
      case "full": throw relayError("workspace_full");
      case "account-unavailable": throw notFound();
    }
  };

  const parseWorkspaceName = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length > WORKSPACE_NAME_MAX_CHARS * 4) throw badRequest("workspaceName is invalid");
    const name = normalizeShareLabel(value, WORKSPACE_NAME_MAX_CHARS);
    if (name === null || [...value.trim()].length > WORKSPACE_NAME_MAX_CHARS) throw badRequest(`workspaceName must be 1 to ${WORKSPACE_NAME_MAX_CHARS} characters`);
    return name;
  };

  const parseToken = (value: unknown): string => {
    if (!isWorkspaceInviteToken(value)) throw notFound();
    return value;
  };

  return async function respondToWorkspaceMembers(request: Request, route: WorkspaceMemberRoute, actor: { userId: string }): Promise<Response> {
    // A browser signs in with a cookie. Only the share site may send it here,
    // so another site cannot invite, remove, or join on a person's behalf.
    if (request.headers.has("cookie") && (!shareWebOrigin || request.headers.get("origin") !== shareWebOrigin)) throw notFound();
    const userId = actor.userId;
    if (route.route === "members") {
      if (request.method !== "GET") throw relayError("method_not_allowed");
      await options.claimPendingShares(userId, request.signal);
      return respondWithView(route.workspaceId, userId);
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
        };
        return jsonResponse(body, 200, { "cache-control": "private, no-store" });
      }
      const joined = storage.joinWorkspace({
        secretHash, userId, newMemberId: options.newId, newGrantId: options.newGrantId, nowMs: options.nowMs(),
      });
      if (!joined.ok) {
        if (joined.reason === "removed") throw relayError("member_removed");
        if (joined.reason === "full") throw relayError("workspace_full");
        // The owner opening their own link is already in the workspace.
        if (joined.reason !== "owner") throw notFound();
        throw relayError("member_exists");
      }
      options.discussionActivity.wakeLog(joined.workspaceId);
      const body: WorkspaceJoinResult = { workspaceId: joined.workspaceId, shareId: joined.shareId, workspaceName: joined.workspaceName };
      return jsonResponse(body, 200, { "cache-control": "private, no-store" });
    }

    const { workspaceId } = route;
    const input = await readJsonObject(request);
    const nowMs = options.nowMs();
    switch (route.route) {
      case "members-invite": {
        if (!options.resolveUserIdByEmail) throw badRequest("recipient email lookup is not available on this relay");
        if (typeof input.email !== "string" || input.email.length > MAX_MEMBER_EMAIL_CHARS) throw badRequest("email is invalid");
        const email = normalizeEmail(input.email);
        if (!/^[^\s@]+@[^\s@]+$/u.test(email)) throw badRequest("email is invalid");
        const workspaceName = parseWorkspaceName(input.workspaceName);
        const resolved = await options.resolveUserIdByEmail(email);
        const invite = (recipientUserId: string | null) => storage.inviteWorkspaceMember({
          workspaceId, actorUserId: userId, workspaceName, email, recipientUserId,
          newMemberId: options.newId, newGrantId: options.newGrantId, newShareId: options.newShareId, nowMs,
        });
        let result = invite(resolved);
        // An account being deleted counts as no account: its address gets an email invite.
        if (!result.ok && result.reason === "account-unavailable" && resolved !== null) result = invite(null);
        settle(result, workspaceId);
        return jsonResponse({ ok: true, memberId: (result as { memberId: string }).memberId }, 200, { "cache-control": "no-store" });
      }
      case "members-level": {
        if (!isShareAccessValue(input.level)) throw badRequest('level must be "view", "comment", or "edit"');
        settle(storage.setWorkspaceMemberLevel({ workspaceId, actorUserId: userId, level: input.level }), workspaceId);
        return respondWithView(workspaceId, userId);
      }
      case "members-role": {
        if (input.role !== "admin" && input.role !== "member") throw badRequest('role must be "admin" or "member"');
        settle(storage.setWorkspaceMemberRole({ workspaceId, actorUserId: userId, memberId: route.memberId, role: input.role }), workspaceId);
        return respondWithView(workspaceId, userId);
      }
      case "members-remove":
        settle(storage.removeWorkspaceMember({ workspaceId, actorUserId: userId, memberId: route.memberId, nowMs }), workspaceId);
        return respondWithView(workspaceId, userId);
      case "members-let-back-in":
        settle(storage.letWorkspaceMemberBackIn({ workspaceId, actorUserId: userId, memberId: route.memberId, newGrantId: options.newGrantId, nowMs }), workspaceId);
        return respondWithView(workspaceId, userId);
      case "members-invite-link": {
        if (!isInviteLinkAction(input.action)) throw badRequest('action must be "turn-on", "turn-off", or "reset"');
        if (input.action !== "turn-off" && (!linkKey || !shareWebOrigin)) throw notFound();
        const workspaceName = parseWorkspaceName(input.workspaceName);
        settle(storage.changeWorkspaceInviteLink({
          workspaceId, actorUserId: userId, action: input.action, workspaceName, newShareId: options.newShareId, nowMs,
          mint: (generation) => {
            const token = mintLinkBearer();
            return { secretHash: hashToken(token), secretSealed: sealLinkBearer(token, linkKey!, ...sealContext(workspaceId, generation)) };
          },
        }), workspaceId);
        return respondWithView(workspaceId, userId);
      }
      case "members-leave":
        settle(storage.leaveWorkspace({ workspaceId, userId, nowMs }), workspaceId);
        return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
      case "members-end":
        settle(storage.endWorkspaceMembership({ workspaceId, actorUserId: userId, nowMs }), workspaceId);
        return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
    }
  };
}
