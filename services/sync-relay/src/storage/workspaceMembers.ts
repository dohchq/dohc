import { randomUUID } from "node:crypto";
import {
  DEFAULT_MEMBER_LEVEL,
  MAX_WORKSPACE_MEMBERS,
  type MemberLevel,
  type WorkspaceRole,
} from "@dohc/security-contract/workspace-members";
import { accountIsFenced } from "./accountDeletion";
import type { StorageContext } from "./context";
import { insertShare, insertShareGrant, revokeShareGrantInTransaction, revokeShareInTransaction } from "./shares";
import type { SqliteDb } from "./types";
import { forgetReplicaCurrentViewCaches } from "../replicaCurrentViewReads";

// Workspace members (docs/engineering/plans/workspace-members.md, piece 1).
//
// A workspace has at most one membership. It names one `{"kind":"workspace"}`
// share, and every person in the workspace holds one independent grant on it
// through their member entry. The owner is the workspace's owner
// (`sync_relay_workspaces.owner_user_id`) and has no entry.
//
// Storage holds the entries and grants together:
// - An active grant on the share needs an entry with that grant: an active
//   entry for its account, or an invited entry for its email, at the access
//   the entry's role gives (Edit for an admin, the member level otherwise).
// - An entry cannot leave, be removed, take another grant, or be deleted while
//   its grant is still active.
// The relay revokes the grant first and changes the entry second, in one
// transaction.

const MARKER = "workspace-members-v1";
const MEMBERSHIPS = "sync_relay_workspace_memberships";
const MEMBERS = "sync_relay_workspace_members";
const INVITE_LINKS = "sync_relay_workspace_invite_links";
export const WORKSPACE_NAME_MAX_CHARS = 160;
export const WORKSPACE_SHARE_SELECTOR_JSON = '{"kind":"workspace"}';

const consistentGrant = `NEW.parent_grant_id IS NULL AND EXISTS (
    SELECT 1 FROM ${MEMBERS} AS m JOIN ${MEMBERSHIPS} AS ms ON ms.workspace_id = m.workspace_id
    WHERE ms.share_id = NEW.share_id AND m.grant_id = NEW.grant_id
      AND ((NEW.principal_kind = 'user' AND m.state = 'active' AND m.user_id = NEW.principal_user_id)
        OR (NEW.principal_kind = 'email' AND m.state = 'invited' AND m.email = NEW.principal_email))
      AND NEW.access = CASE m.role WHEN 'admin' THEN 'edit' ELSE ms.member_level END)`;
const onWorkspaceShare = `NEW.status = 'active' AND EXISTS (SELECT 1 FROM ${MEMBERSHIPS} WHERE share_id = NEW.share_id)`;
const grantStillActive = (grantId: string) =>
  `EXISTS (SELECT 1 FROM sync_relay_share_grants WHERE grant_id = ${grantId} AND status = 'active')`;

const SCHEMA = {
  [MEMBERSHIPS]: `CREATE TABLE ${MEMBERSHIPS} (
  workspace_id TEXT PRIMARY KEY REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  share_id TEXT NOT NULL UNIQUE REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
  member_level TEXT NOT NULL DEFAULT 'comment' CHECK (member_level IN ('view', 'comment', 'edit')),
  workspace_name TEXT NOT NULL CHECK (length(workspace_name) BETWEEN 1 AND ${WORKSPACE_NAME_MAX_CHARS}),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
) STRICT`,
  [MEMBERS]: `CREATE TABLE ${MEMBERS} (
  member_id TEXT PRIMARY KEY CHECK (length(member_id) BETWEEN 1 AND 128 AND member_id <> 'owner'),
  workspace_id TEXT NOT NULL REFERENCES ${MEMBERSHIPS}(workspace_id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL UNIQUE,
  user_id TEXT,
  email TEXT CHECK (email IS NULL OR length(email) BETWEEN 1 AND 320),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'left', 'removed')),
  invited_at_ms INTEGER,
  joined_at_ms INTEGER,
  ended_at_ms INTEGER,
  CHECK ((state = 'invited') = (user_id IS NULL)),
  CHECK (state <> 'invited' OR email IS NOT NULL),
  CHECK ((state IN ('left', 'removed')) = (ended_at_ms IS NOT NULL)),
  CHECK (state <> 'active' OR joined_at_ms IS NOT NULL)
) STRICT`,
  idx_sync_relay_workspace_members_account: `CREATE UNIQUE INDEX idx_sync_relay_workspace_members_account
  ON ${MEMBERS}(workspace_id, user_id) WHERE user_id IS NOT NULL`,
  idx_sync_relay_workspace_members_invite: `CREATE UNIQUE INDEX idx_sync_relay_workspace_members_invite
  ON ${MEMBERS}(workspace_id, email) WHERE state = 'invited'`,
  idx_sync_relay_workspace_members_email: `CREATE INDEX idx_sync_relay_workspace_members_email
  ON ${MEMBERS}(email) WHERE state = 'invited'`,
  [INVITE_LINKS]: `CREATE TABLE ${INVITE_LINKS} (
  workspace_id TEXT PRIMARY KEY REFERENCES ${MEMBERSHIPS}(workspace_id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  secret_sealed TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT`,
  sync_relay_workspace_membership_share: `CREATE TRIGGER sync_relay_workspace_membership_share
  BEFORE INSERT ON ${MEMBERSHIPS} BEGIN
  SELECT RAISE(ABORT, 'workspace membership needs its workspace share') WHERE NOT EXISTS (
    SELECT 1 FROM sync_relay_shares AS s JOIN sync_relay_workspaces AS w ON w.workspace_id = s.workspace_id
    WHERE s.share_id = NEW.share_id AND s.workspace_id = NEW.workspace_id
      AND s.selector_json = '${WORKSPACE_SHARE_SELECTOR_JSON}' AND s.granter_user_id = w.owner_user_id); END`,
  sync_relay_workspace_member_grant_insert: `CREATE TRIGGER sync_relay_workspace_member_grant_insert
  BEFORE INSERT ON sync_relay_share_grants WHEN ${onWorkspaceShare} BEGIN
  SELECT RAISE(ABORT, 'workspace share grant needs a matching member entry') WHERE NOT (${consistentGrant}); END`,
  sync_relay_workspace_member_grant_update: `CREATE TRIGGER sync_relay_workspace_member_grant_update
  BEFORE UPDATE ON sync_relay_share_grants WHEN ${onWorkspaceShare} BEGIN
  SELECT RAISE(ABORT, 'workspace share grant needs a matching member entry') WHERE NOT (${consistentGrant}); END`,
  sync_relay_workspace_member_ends: `CREATE TRIGGER sync_relay_workspace_member_ends
  BEFORE UPDATE ON ${MEMBERS}
  WHEN (NEW.state IN ('left', 'removed') OR NEW.grant_id <> OLD.grant_id) AND ${grantStillActive("OLD.grant_id")} BEGIN
  SELECT RAISE(ABORT, 'revoke the member grant before ending the entry'); END`,
  sync_relay_workspace_member_deleted: `CREATE TRIGGER sync_relay_workspace_member_deleted
  BEFORE DELETE ON ${MEMBERS}
  WHEN EXISTS (SELECT 1 FROM ${MEMBERSHIPS} WHERE workspace_id = OLD.workspace_id) AND ${grantStillActive("OLD.grant_id")} BEGIN
  SELECT RAISE(ABORT, 'revoke the member grant before deleting the entry'); END`,
} as const;

const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

function assertSchema(db: SqliteDb): void {
  const names = Object.keys(SCHEMA);
  const rows = db.prepare(`SELECT name, sql FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`).all(...names);
  const schema: Record<string, string> = SCHEMA;
  if (rows.length !== names.length || rows.some((row) =>
    typeof row.sql !== "string" || normalize(row.sql) !== normalize(schema[row.name as string]!))) {
    throw new Error("workspace member schema is missing or damaged");
  }
}

export function initializeWorkspaceMemberSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assertSchema(db);
    return;
  }
  const names = Object.keys(SCHEMA);
  if (db.prepare(`SELECT 1 FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`).get(...names)) {
    throw new Error("unmarked workspace member schema already exists");
  }
  for (const sql of Object.values(SCHEMA)) db.exec(sql);
  assertSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(MARKER, Date.now());
}

export type StoredMemberState = "invited" | "active" | "left" | "removed";

export interface WorkspaceMembershipRow {
  workspaceId: string;
  shareId: string;
  memberLevel: MemberLevel;
  workspaceName: string;
  createdAtMs: number;
}

export interface WorkspaceMemberRow {
  memberId: string;
  workspaceId: string;
  grantId: string;
  userId: string | null;
  email: string | null;
  role: "admin" | "member";
  state: StoredMemberState;
  invitedAtMs: number | null;
  joinedAtMs: number | null;
  endedAtMs: number | null;
}

export interface WorkspaceInviteLinkRow {
  workspaceId: string;
  secretHash: string;
  secretSealed: string;
  generation: number;
  enabled: boolean;
}

/** The sealed secret for a link generation. The relay derives both from one fresh token. */
export interface MintedInviteSecret {
  secretHash: string;
  secretSealed: string;
}

export interface WorkspaceMembersSnapshot {
  workspaceId: string;
  ownerUserId: string;
  membership: WorkspaceMembershipRow | null;
  viewer: { role: WorkspaceRole; memberId: string };
  /** Invited, active, and removed entries. People who left are not listed. */
  members: WorkspaceMemberRow[];
  inviteLink: WorkspaceInviteLinkRow | null;
}

const nullableString = (value: unknown) => (value === null || value === undefined ? null : String(value));
const nullableNumber = (value: unknown) => (value === null || value === undefined ? null : Number(value));

function rowToMembership(row: Record<string, unknown>): WorkspaceMembershipRow {
  return {
    workspaceId: String(row.workspace_id),
    shareId: String(row.share_id),
    memberLevel: String(row.member_level) as MemberLevel,
    workspaceName: String(row.workspace_name),
    createdAtMs: Number(row.created_at_ms),
  };
}

function rowToMember(row: Record<string, unknown>): WorkspaceMemberRow {
  return {
    memberId: String(row.member_id),
    workspaceId: String(row.workspace_id),
    grantId: String(row.grant_id),
    userId: nullableString(row.user_id),
    email: nullableString(row.email),
    role: String(row.role) as WorkspaceMemberRow["role"],
    state: String(row.state) as StoredMemberState,
    invitedAtMs: nullableNumber(row.invited_at_ms),
    joinedAtMs: nullableNumber(row.joined_at_ms),
    endedAtMs: nullableNumber(row.ended_at_ms),
  };
}

function rowToInviteLink(row: Record<string, unknown>): WorkspaceInviteLinkRow {
  return {
    workspaceId: String(row.workspace_id),
    secretHash: String(row.secret_hash),
    secretSealed: String(row.secret_sealed),
    generation: Number(row.generation),
    enabled: Number(row.enabled) === 1,
  };
}

export function getWorkspaceMembership(storage: StorageContext, workspaceId: string): WorkspaceMembershipRow | null {
  const row = storage.db.prepare(`SELECT * FROM ${MEMBERSHIPS} WHERE workspace_id = ?`).get(workspaceId);
  return row ? rowToMembership(row) : null;
}

export function getWorkspaceMembershipByShare(storage: StorageContext, shareId: string): WorkspaceMembershipRow | null {
  const row = storage.db.prepare(`SELECT * FROM ${MEMBERSHIPS} WHERE share_id = ?`).get(shareId);
  return row ? rowToMembership(row) : null;
}

function memberById(storage: StorageContext, workspaceId: string, memberId: string): WorkspaceMemberRow | null {
  const row = storage.db.prepare(`SELECT * FROM ${MEMBERS} WHERE workspace_id = ? AND member_id = ?`).get(workspaceId, memberId);
  return row ? rowToMember(row) : null;
}

function memberByAccount(storage: StorageContext, workspaceId: string, userId: string): WorkspaceMemberRow | null {
  const row = storage.db.prepare(`SELECT * FROM ${MEMBERS} WHERE workspace_id = ? AND user_id = ?`).get(workspaceId, userId);
  return row ? rowToMember(row) : null;
}

function inviteLinkOf(storage: StorageContext, workspaceId: string): WorkspaceInviteLinkRow | null {
  const row = storage.db.prepare(`SELECT * FROM ${INVITE_LINKS} WHERE workspace_id = ?`).get(workspaceId);
  return row ? rowToInviteLink(row) : null;
}

function ownerOf(storage: StorageContext, workspaceId: string): string | null {
  const row = storage.db.prepare("SELECT owner_user_id FROM sync_relay_workspaces WHERE workspace_id = ?").get(workspaceId);
  return row ? String(row.owner_user_id) : null;
}

/**
 * Whether a grant on a workspace share belongs to an active entry at the
 * access its role gives. Authorization asks this for every workspace grant,
 * on top of the triggers that keep the two in step.
 */
export function workspaceMemberGrantIsCurrent(storage: StorageContext, shareId: string, grantId: string): boolean {
  return !!storage.db.prepare(
    `SELECT 1 FROM ${MEMBERS} AS m
     JOIN ${MEMBERSHIPS} AS ms ON ms.workspace_id = m.workspace_id
     JOIN sync_relay_share_grants AS g ON g.grant_id = m.grant_id
     WHERE ms.share_id = ? AND m.grant_id = ? AND m.state = 'active' AND g.share_id = ms.share_id
       AND g.principal_kind = 'user' AND g.principal_user_id = m.user_id AND g.parent_grant_id IS NULL
       AND g.access = CASE m.role WHEN 'admin' THEN 'edit' ELSE ms.member_level END`,
  ).get(shareId, grantId);
}

/** The caller's role in the workspace, or null when they are not in it. */
export function workspaceRoleOf(storage: StorageContext, workspaceId: string, userId: string): { role: WorkspaceRole; memberId: string } | null {
  if (accountIsFenced(storage, userId)) return null;
  const owner = ownerOf(storage, workspaceId);
  if (owner === null) return null;
  if (owner === userId) return { role: "owner", memberId: "owner" };
  const membership = getWorkspaceMembership(storage, workspaceId);
  const entry = membership && memberByAccount(storage, workspaceId, userId);
  if (!membership || !entry || entry.state !== "active" || !workspaceMemberGrantIsCurrent(storage, membership.shareId, entry.grantId)) return null;
  return { role: entry.role, memberId: entry.memberId };
}

export function readWorkspaceMembers(storage: StorageContext, workspaceId: string, viewerUserId: string): WorkspaceMembersSnapshot | null {
  return storage.readTx(() => {
    const viewer = workspaceRoleOf(storage, workspaceId, viewerUserId);
    if (!viewer) return null;
    const membership = getWorkspaceMembership(storage, workspaceId);
    const members = membership
      ? storage.db.prepare(
        `SELECT * FROM ${MEMBERS} WHERE workspace_id = ? AND state <> 'left'
         ORDER BY CASE state WHEN 'active' THEN 0 WHEN 'invited' THEN 1 ELSE 2 END,
           CASE role WHEN 'admin' THEN 0 ELSE 1 END, COALESCE(joined_at_ms, invited_at_ms, ended_at_ms), member_id`,
      ).all(workspaceId).map(rowToMember)
      : [];
    return {
      workspaceId,
      ownerUserId: ownerOf(storage, workspaceId)!,
      membership,
      viewer,
      members,
      inviteLink: membership ? inviteLinkOf(storage, workspaceId) : null,
    };
  });
}

// --- changes ----------------------------------------------------------------

export type MemberChangeRefusal =
  | "not-found"
  | "forbidden"
  | "name-required"
  | "already-member"
  | "already-invited"
  | "removed"
  | "full"
  | "account-unavailable";

export type MemberChangeResult<T = Record<never, never>> = ({ ok: true } & T) | { ok: false; reason: MemberChangeRefusal };

const refuse = (reason: MemberChangeRefusal) => ({ ok: false as const, reason });
const manages = (role: WorkspaceRole) => role === "owner" || role === "admin";

function accessFor(membership: WorkspaceMembershipRow, role: "admin" | "member"): MemberLevel {
  return role === "admin" ? "edit" : membership.memberLevel;
}

function seatsTaken(storage: StorageContext, workspaceId: string): number {
  return Number(storage.db.prepare(
    `SELECT COUNT(*) AS n FROM ${MEMBERS} WHERE workspace_id = ? AND state IN ('invited', 'active')`,
  ).get(workspaceId)!.n);
}

/** The membership, made on first use with the owner's name for the workspace. */
function ensureMembership(storage: StorageContext, input: {
  workspaceId: string; ownerUserId: string; workspaceName: string | undefined; newShareId: () => string; nowMs: number;
}): WorkspaceMembershipRow | null {
  const existing = getWorkspaceMembership(storage, input.workspaceId);
  if (existing) return existing;
  const name = input.workspaceName;
  if (name === undefined) return null;
  const shareId = input.newShareId();
  insertShare(storage, {
    shareId,
    workspaceId: input.workspaceId,
    granterUserId: input.ownerUserId,
    selectorJson: WORKSPACE_SHARE_SELECTOR_JSON,
    createdAtMs: input.nowMs,
  });
  storage.db.prepare(
    `INSERT INTO ${MEMBERSHIPS} (workspace_id, share_id, member_level, workspace_name, created_at_ms) VALUES (?, ?, ?, ?, ?)`,
  ).run(input.workspaceId, shareId, DEFAULT_MEMBER_LEVEL, name, Math.trunc(input.nowMs));
  return getWorkspaceMembership(storage, input.workspaceId);
}

function grantFor(input: {
  grantId: string; shareId: string; access: MemberLevel; nowMs: number;
  principal: { kind: "user"; userId: string } | { kind: "email"; email: string };
}) {
  return {
    grantId: input.grantId,
    shareId: input.shareId,
    principalKind: input.principal.kind,
    principalUserId: input.principal.kind === "user" ? input.principal.userId : null,
    principalEmail: input.principal.kind === "email" ? input.principal.email : null,
    access: input.access,
    generation: 1,
    status: "active" as const,
    createdAtMs: Math.trunc(input.nowMs),
    revokedAtMs: null,
    parentGrantId: null,
  };
}

/** A notice tells the person they were added. It waits while the grant is still an email invite. */
function queueAddedNotice(storage: StorageContext, grantId: string, nowMs: number): void {
  storage.db.prepare(
    "INSERT INTO sync_relay_share_notice_deliveries (grant_id, created_at_ms) VALUES (?, ?)",
  ).run(grantId, Math.trunc(nowMs));
}

/** Gives an account's existing entry a fresh grant: a return after leaving, or Let back in. */
function rejoin(storage: StorageContext, membership: WorkspaceMembershipRow, entry: WorkspaceMemberRow, input: {
  grantId: string; userId: string; nowMs: number; invited: boolean;
}): void {
  storage.db.prepare(
    `UPDATE ${MEMBERS} SET grant_id = ?, role = 'member', state = 'active', joined_at_ms = ?, ended_at_ms = NULL,
       invited_at_ms = CASE WHEN ? THEN ? ELSE invited_at_ms END
     WHERE member_id = ?`,
  ).run(input.grantId, Math.trunc(input.nowMs), input.invited ? 1 : 0, Math.trunc(input.nowMs), entry.memberId);
  insertShareGrant(storage, grantFor({
    grantId: input.grantId, shareId: membership.shareId, access: accessFor(membership, "member"), nowMs: input.nowMs,
    principal: { kind: "user", userId: input.userId },
  }));
}

export function inviteWorkspaceMember(storage: StorageContext, input: {
  workspaceId: string;
  actorUserId: string;
  workspaceName: string | undefined;
  email: string;
  /** The account that holds this verified email, when one does. */
  recipientUserId: string | null;
  newMemberId: () => string;
  newGrantId: () => string;
  newShareId: () => string;
  nowMs: number;
}): MemberChangeResult<{ memberId: string }> {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (!manages(actor.role)) return refuse("forbidden");
    const ownerUserId = ownerOf(storage, input.workspaceId)!;
    if (input.recipientUserId === ownerUserId) return refuse("already-member");
    if (input.recipientUserId !== null && accountIsFenced(storage, input.recipientUserId)) return refuse("account-unavailable");
    const membership = ensureMembership(storage, { ...input, ownerUserId });
    if (!membership) return refuse("name-required");
    const nowMs = Math.trunc(input.nowMs);
    if (input.recipientUserId !== null) {
      const existing = memberByAccount(storage, input.workspaceId, input.recipientUserId);
      if (existing?.state === "active") return refuse("already-member");
      if (existing?.state === "removed") return refuse("removed");
      if (seatsTaken(storage, input.workspaceId) >= MAX_WORKSPACE_MEMBERS) return refuse("full");
      const grantId = input.newGrantId();
      if (existing) {
        rejoin(storage, membership, existing, { grantId, userId: input.recipientUserId, nowMs, invited: true });
        queueAddedNotice(storage, grantId, nowMs);
        forgetReplicaCurrentViewCaches(storage, input.workspaceId);
        return { ok: true, memberId: existing.memberId };
      }
      const memberId = input.newMemberId();
      storage.db.prepare(
        `INSERT INTO ${MEMBERS} (member_id, workspace_id, grant_id, user_id, email, role, state, invited_at_ms, joined_at_ms)
         VALUES (?, ?, ?, ?, NULL, 'member', 'active', ?, ?)`,
      ).run(memberId, input.workspaceId, grantId, input.recipientUserId, nowMs, nowMs);
      insertShareGrant(storage, grantFor({
        grantId, shareId: membership.shareId, access: accessFor(membership, "member"), nowMs,
        principal: { kind: "user", userId: input.recipientUserId },
      }));
      queueAddedNotice(storage, grantId, nowMs);
      forgetReplicaCurrentViewCaches(storage, input.workspaceId);
      return { ok: true, memberId };
    }
    const pending = storage.db.prepare(
      `SELECT member_id FROM ${MEMBERS} WHERE workspace_id = ? AND state = 'invited' AND email = ?`,
    ).get(input.workspaceId, input.email);
    if (pending) return refuse("already-invited");
    if (seatsTaken(storage, input.workspaceId) >= MAX_WORKSPACE_MEMBERS) return refuse("full");
    const memberId = input.newMemberId();
    const grantId = input.newGrantId();
    storage.db.prepare(
      `INSERT INTO ${MEMBERS} (member_id, workspace_id, grant_id, user_id, email, role, state, invited_at_ms)
       VALUES (?, ?, ?, NULL, ?, 'member', 'invited', ?)`,
    ).run(memberId, input.workspaceId, grantId, input.email, nowMs);
    insertShareGrant(storage, grantFor({
      grantId, shareId: membership.shareId, access: accessFor(membership, "member"), nowMs,
      principal: { kind: "email", email: input.email },
    }));
    queueAddedNotice(storage, grantId, nowMs);
    return { ok: true, memberId };
  });
}

/** Re-grants every entry at its role's access. A level or role change ends held requests, as revocation does. */
function retuneGrants(storage: StorageContext, membership: WorkspaceMembershipRow, entries: readonly WorkspaceMemberRow[]): void {
  const update = storage.db.prepare(
    `UPDATE sync_relay_share_grants SET access = ?, generation = generation + 1
     WHERE grant_id = ? AND share_id = ? AND status = 'active' AND access <> ?`,
  );
  for (const entry of entries) {
    if (entry.state !== "active" && entry.state !== "invited") continue;
    const access = accessFor(membership, entry.role);
    update.run(access, entry.grantId, membership.shareId, access);
  }
  forgetReplicaCurrentViewCaches(storage, membership.workspaceId);
}

export function setWorkspaceMemberLevel(storage: StorageContext, input: {
  workspaceId: string; actorUserId: string; level: MemberLevel;
}): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (!manages(actor.role)) return refuse("forbidden");
    const before = getWorkspaceMembership(storage, input.workspaceId);
    if (!before) return refuse("not-found");
    if (before.memberLevel === input.level) return { ok: true };
    storage.db.prepare(`UPDATE ${MEMBERSHIPS} SET member_level = ? WHERE workspace_id = ?`).run(input.level, input.workspaceId);
    const membership = getWorkspaceMembership(storage, input.workspaceId)!;
    const entries = storage.db.prepare(
      `SELECT * FROM ${MEMBERS} WHERE workspace_id = ? AND role = 'member' AND state IN ('invited', 'active')`,
    ).all(input.workspaceId).map(rowToMember);
    retuneGrants(storage, membership, entries);
    return { ok: true };
  });
}

export function setWorkspaceMemberRole(storage: StorageContext, input: {
  workspaceId: string; actorUserId: string; memberId: string; role: "admin" | "member";
}): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (actor.role !== "owner") return refuse("forbidden");
    const membership = getWorkspaceMembership(storage, input.workspaceId);
    const entry = membership && memberById(storage, input.workspaceId, input.memberId);
    if (!membership || !entry || (entry.state !== "active" && entry.state !== "invited")) return refuse("not-found");
    if (entry.role === input.role) return { ok: true };
    storage.db.prepare(`UPDATE ${MEMBERS} SET role = ? WHERE member_id = ?`).run(input.role, entry.memberId);
    retuneGrants(storage, membership, [{ ...entry, role: input.role }]);
    return { ok: true };
  });
}

function endEntry(storage: StorageContext, membership: WorkspaceMembershipRow, entry: WorkspaceMemberRow, state: "left" | "removed", nowMs: number): void {
  revokeShareGrantInTransaction(storage, { shareId: membership.shareId, grantId: entry.grantId, revokedAtMs: nowMs });
  if (entry.state === "invited") {
    // An invite nobody claimed has no account to keep out, so it goes.
    storage.db.prepare(`DELETE FROM ${MEMBERS} WHERE member_id = ?`).run(entry.memberId);
    return;
  }
  storage.db.prepare(`UPDATE ${MEMBERS} SET state = ?, ended_at_ms = ? WHERE member_id = ?`)
    .run(state, Math.trunc(nowMs), entry.memberId);
}

export function removeWorkspaceMember(storage: StorageContext, input: {
  workspaceId: string; actorUserId: string; memberId: string; nowMs: number;
}): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (!manages(actor.role)) return refuse("forbidden");
    const membership = getWorkspaceMembership(storage, input.workspaceId);
    const entry = membership && memberById(storage, input.workspaceId, input.memberId);
    if (!membership || !entry || (entry.state !== "active" && entry.state !== "invited")) return refuse("not-found");
    // Only the owner removes an admin. An admin removes members and invites.
    if (entry.role === "admin" && actor.role !== "owner") return refuse("forbidden");
    endEntry(storage, membership, entry, "removed", input.nowMs);
    return { ok: true };
  });
}

export function letWorkspaceMemberBackIn(storage: StorageContext, input: {
  workspaceId: string; actorUserId: string; memberId: string; newGrantId: () => string; nowMs: number;
}): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (!manages(actor.role)) return refuse("forbidden");
    const membership = getWorkspaceMembership(storage, input.workspaceId);
    const entry = membership && memberById(storage, input.workspaceId, input.memberId);
    if (!membership || !entry || entry.state !== "removed" || entry.userId === null) return refuse("not-found");
    if (accountIsFenced(storage, entry.userId)) return refuse("account-unavailable");
    if (seatsTaken(storage, input.workspaceId) >= MAX_WORKSPACE_MEMBERS) return refuse("full");
    const grantId = input.newGrantId();
    rejoin(storage, membership, entry, { grantId, userId: entry.userId, nowMs: input.nowMs, invited: false });
    queueAddedNotice(storage, grantId, input.nowMs);
    forgetReplicaCurrentViewCaches(storage, input.workspaceId);
    return { ok: true };
  });
}

export function leaveWorkspace(storage: StorageContext, input: { workspaceId: string; userId: string; nowMs: number }): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.userId);
    if (!actor) return refuse("not-found");
    if (actor.role === "owner") return refuse("forbidden");
    const membership = getWorkspaceMembership(storage, input.workspaceId)!;
    endEntry(storage, membership, memberById(storage, input.workspaceId, actor.memberId)!, "left", input.nowMs);
    return { ok: true };
  });
}

/** Ends membership for everyone: every grant is revoked and the membership, its entries, and its link are gone. */
export function endWorkspaceMembership(storage: StorageContext, input: { workspaceId: string; actorUserId: string; nowMs: number }): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (actor.role !== "owner") return refuse("forbidden");
    const membership = getWorkspaceMembership(storage, input.workspaceId);
    if (!membership) return { ok: true };
    revokeShareInTransaction(storage, membership.shareId, input.nowMs);
    storage.db.prepare(`DELETE FROM ${MEMBERSHIPS} WHERE workspace_id = ?`).run(input.workspaceId);
    return { ok: true };
  });
}

export function changeWorkspaceInviteLink(storage: StorageContext, input: {
  workspaceId: string;
  actorUserId: string;
  action: "turn-on" | "turn-off" | "reset";
  workspaceName: string | undefined;
  newShareId: () => string;
  /** Mints the secret for `generation` of this workspace's link. */
  mint: (generation: number) => MintedInviteSecret;
  nowMs: number;
}): MemberChangeResult {
  return storage.tx(() => {
    const actor = workspaceRoleOf(storage, input.workspaceId, input.actorUserId);
    if (!actor) return refuse("not-found");
    if (!manages(actor.role)) return refuse("forbidden");
    const nowMs = Math.trunc(input.nowMs);
    const ownerUserId = ownerOf(storage, input.workspaceId)!;
    const membership = input.action === "turn-on"
      ? ensureMembership(storage, { ...input, ownerUserId })
      : getWorkspaceMembership(storage, input.workspaceId);
    if (!membership) return refuse(input.action === "turn-on" ? "name-required" : "not-found");
    const link = inviteLinkOf(storage, input.workspaceId);
    if (input.action === "turn-off") {
      if (link) storage.db.prepare(`UPDATE ${INVITE_LINKS} SET enabled = 0, updated_at_ms = ? WHERE workspace_id = ?`).run(nowMs, input.workspaceId);
      return { ok: true };
    }
    if (!link) {
      if (input.action === "reset") return { ok: true };
      const minted = input.mint(1);
      storage.db.prepare(
        `INSERT INTO ${INVITE_LINKS} (workspace_id, secret_hash, secret_sealed, generation, enabled, updated_at_ms) VALUES (?, ?, ?, 1, 1, ?)`,
      ).run(input.workspaceId, minted.secretHash, minted.secretSealed, nowMs);
      return { ok: true };
    }
    if (input.action === "turn-on") {
      storage.db.prepare(`UPDATE ${INVITE_LINKS} SET enabled = 1, updated_at_ms = ? WHERE workspace_id = ?`).run(nowMs, input.workspaceId);
      return { ok: true };
    }
    const generation = link.generation + 1;
    const minted = input.mint(generation);
    storage.db.prepare(
      `UPDATE ${INVITE_LINKS} SET secret_hash = ?, secret_sealed = ?, generation = ?, updated_at_ms = ? WHERE workspace_id = ?`,
    ).run(minted.secretHash, minted.secretSealed, generation, nowMs, input.workspaceId);
    return { ok: true };
  });
}

/** The workspace an enabled invite link opens, when its workspace still has an owner who can share. */
function linkedMembership(storage: StorageContext, secretHash: string): { membership: WorkspaceMembershipRow; ownerUserId: string } | null {
  const row = storage.db.prepare(
    `SELECT ms.*, w.owner_user_id FROM ${INVITE_LINKS} AS l
     JOIN ${MEMBERSHIPS} AS ms ON ms.workspace_id = l.workspace_id
     JOIN sync_relay_workspaces AS w ON w.workspace_id = l.workspace_id
     JOIN sync_relay_shares AS s ON s.share_id = ms.share_id AND s.granter_user_id = w.owner_user_id
     WHERE l.secret_hash = ? AND l.enabled = 1`,
  ).get(secretHash);
  if (!row) return null;
  const ownerUserId = String(row.owner_user_id);
  return accountIsFenced(storage, ownerUserId) ? null : { membership: rowToMembership(row), ownerUserId };
}

/** Whether a sign-up presenting this link may make an account. */
export function inviteLinkAdmitsSignUp(storage: StorageContext, secretHash: string): boolean {
  return storage.readTx(() => linkedMembership(storage, secretHash) !== null);
}

export function previewWorkspaceJoin(storage: StorageContext, input: { secretHash: string; userId: string }):
  { workspaceId: string; workspaceName: string; ownerUserId: string; alreadyMember: boolean } | null {
  return storage.readTx(() => {
    const linked = linkedMembership(storage, input.secretHash);
    if (!linked) return null;
    const { membership, ownerUserId } = linked;
    const entry = memberByAccount(storage, membership.workspaceId, input.userId);
    return {
      workspaceId: membership.workspaceId,
      workspaceName: membership.workspaceName,
      ownerUserId,
      alreadyMember: ownerUserId === input.userId || entry?.state === "active",
    };
  });
}

export type WorkspaceJoinOutcome =
  | { ok: true; workspaceId: string; shareId: string; workspaceName: string }
  | { ok: false; reason: "not-found" | "removed" | "full" | "account-unavailable" | "owner" };

export function joinWorkspace(storage: StorageContext, input: {
  secretHash: string; userId: string; newMemberId: () => string; newGrantId: () => string; nowMs: number;
}): WorkspaceJoinOutcome {
  return storage.tx(() => {
    const linked = linkedMembership(storage, input.secretHash);
    if (!linked) return { ok: false, reason: "not-found" };
    if (accountIsFenced(storage, input.userId)) return { ok: false, reason: "account-unavailable" };
    const { membership, ownerUserId } = linked;
    const joined = { ok: true as const, workspaceId: membership.workspaceId, shareId: membership.shareId, workspaceName: membership.workspaceName };
    if (ownerUserId === input.userId) return { ok: false, reason: "owner" };
    const entry = memberByAccount(storage, membership.workspaceId, input.userId);
    if (entry?.state === "active") return joined;
    // A removed account stays out until the owner or an admin lets it back in.
    if (entry?.state === "removed") return { ok: false, reason: "removed" };
    if (seatsTaken(storage, membership.workspaceId) >= MAX_WORKSPACE_MEMBERS) return { ok: false, reason: "full" };
    const nowMs = Math.trunc(input.nowMs);
    const grantId = input.newGrantId();
    if (entry) {
      rejoin(storage, membership, entry, { grantId, userId: input.userId, nowMs, invited: false });
    } else {
      storage.db.prepare(
        `INSERT INTO ${MEMBERS} (member_id, workspace_id, grant_id, user_id, email, role, state, joined_at_ms)
         VALUES (?, ?, ?, ?, NULL, 'member', 'active', ?)`,
      ).run(input.newMemberId(), membership.workspaceId, grantId, input.userId, nowMs);
      insertShareGrant(storage, grantFor({
        grantId, shareId: membership.shareId, access: accessFor(membership, "member"), nowMs,
        principal: { kind: "user", userId: input.userId },
      }));
    }
    forgetReplicaCurrentViewCaches(storage, membership.workspaceId);
    return joined;
  });
}

/**
 * Binds the email invites for `email` to `userId`, inside the transaction
 * that claims that email's share grants. Run before the grant claim: the
 * grant triggers then find each entry already active. An account that
 * already has an entry in the workspace keeps that entry and the invite
 * ends, so a removed account stays removed.
 */
export function claimWorkspaceInvitesInTransaction(storage: StorageContext, email: string, userId: string, nowMs: number): void {
  // An invite whose grant ended (an earlier account at this address was
  // deleted) admits nobody.
  storage.db.prepare(
    `DELETE FROM ${MEMBERS} WHERE state = 'invited' AND email = ?
       AND NOT EXISTS (SELECT 1 FROM sync_relay_share_grants g WHERE g.grant_id = ${MEMBERS}.grant_id AND g.status = 'active')`,
  ).run(email);
  const invites = storage.db.prepare(
    `SELECT * FROM ${MEMBERS} WHERE state = 'invited' AND email = ?`,
  ).all(email).map(rowToMember);
  for (const invite of invites) {
    const membership = getWorkspaceMembership(storage, invite.workspaceId)!;
    const owner = ownerOf(storage, invite.workspaceId);
    const existing = memberByAccount(storage, invite.workspaceId, userId);
    if (owner === userId || existing) {
      revokeShareGrantInTransaction(storage, { shareId: membership.shareId, grantId: invite.grantId, revokedAtMs: nowMs });
      storage.db.prepare(`DELETE FROM ${MEMBERS} WHERE member_id = ?`).run(invite.memberId);
      if (existing?.state === "left") {
        const grantId = randomUUID();
        rejoin(storage, membership, existing, { grantId, userId, nowMs, invited: true });
        queueAddedNotice(storage, grantId, nowMs);
      }
      continue;
    }
    storage.db.prepare(
      `UPDATE ${MEMBERS} SET user_id = ?, email = NULL, state = 'active', joined_at_ms = ? WHERE member_id = ?`,
    ).run(userId, Math.trunc(nowMs), invite.memberId);
    forgetReplicaCurrentViewCaches(storage, invite.workspaceId);
  }
}
