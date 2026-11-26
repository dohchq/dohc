import { createHash } from "node:crypto";
import type { ApprovalAgent } from "@dohc/security-contract/approval-provenance";
import type { AppPublicationCandidate } from "@dohc/security-contract/app-publication";
import { APP_PUBLICATION_MAX_BUNDLE_BYTES } from "@dohc/security-contract/app-publication";
import type { SqliteDb } from "./types";
import type { StorageContext } from "./context";
import { initializeMarkedTable } from "./publicationSchema";
import { getWorkspaceMembership, workspaceRoleOf } from "./workspaceMembers";
import {
  assertPublishingNotHeld,
  putPublicationBlob,
  recordApproval,
  validateBuildIdentity,
} from "./publications";
import { notFound, relayError } from "../errors";

const MEMBER_APPS = "sync_relay_member_apps";
const CONSENTS = "sync_relay_app_viewer_consents";
const SETTINGS = "sync_relay_member_app_settings";
const MEMBER_APPS_SQL = `CREATE TABLE ${MEMBER_APPS} (
  publication_id TEXT PRIMARY KEY REFERENCES sync_relay_app_publications(publication_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  publisher_user_id TEXT NOT NULL,
  publisher_kind TEXT NOT NULL CHECK (publisher_kind IN ('owner', 'member')),
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 64 AND slug NOT GLOB '*[^a-z0-9-]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT`;
const CONSENTS_SQL = `CREATE TABLE ${CONSENTS} (
  workspace_id TEXT NOT NULL,
  viewer_user_id TEXT NOT NULL,
  publication_id TEXT NOT NULL REFERENCES sync_relay_app_publications(publication_id) ON DELETE CASCADE,
  scope_digest TEXT NOT NULL CHECK (scope_digest = '' OR length(scope_digest) = 64),
  operations_json TEXT NOT NULL,
  consented_at_ms INTEGER NOT NULL CHECK (consented_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, viewer_user_id, publication_id)
) STRICT`;
const SETTINGS_SQL = `CREATE TABLE ${SETTINGS} (
  workspace_id TEXT PRIMARY KEY REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  members_can_share INTEGER NOT NULL CHECK (members_can_share IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991)
) STRICT`;

/** Runs after the publication table's last rebuild, which would drop references to it. */
export function initializeMemberAppSchema(db: SqliteDb): void {
  initializeMarkedTable(db, "member-apps-v1", MEMBER_APPS, MEMBER_APPS_SQL, "Member app");
  initializeMarkedTable(db, "member-app-consents-v1", CONSENTS, CONSENTS_SQL, "Member app consent");
  initializeMarkedTable(db, "member-app-settings-v1", SETTINGS, SETTINGS_SQL, "Member app setting");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sync_relay_member_app_slots
    ON ${MEMBER_APPS}(workspace_id, publisher_user_id, slug);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_app_viewer_consents_publication
    ON ${CONSENTS}(publication_id)`);
}

export const MEMBER_APP_STORAGE_BYTES = 4 * APP_PUBLICATION_MAX_BUNDLE_BYTES;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const mib = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);

export const memberAppIdOf = (
  workspaceId: string,
  publisherUserId: string,
  slug: string,
  manifestHash: string,
) => sha(JSON.stringify(["dohc-member-app-v1", workspaceId, publisherUserId, slug, manifestHash]));

export interface MemberAppScopeCollection {
  datasetId: string;
  operationIds: string[];
}
export const memberAppScopeDigest = (publicationId: string, scope: MemberAppScopeCollection[]) =>
  sha(
    JSON.stringify([
      "dohc-member-app-scope-v1",
      publicationId,
      scope.map((entry) => [entry.datasetId, entry.operationIds]),
    ]),
  );

export function memberAppRow(storage: StorageContext, publicationId: string) {
  const row = storage.db
    .prepare(
      `SELECT workspace_id,publisher_user_id,slug,created_at_ms FROM ${MEMBER_APPS} WHERE publication_id=?`,
    )
    .get(publicationId);
  return row
    ? {
        workspaceId: String(row.workspace_id),
        publisherUserId: String(row.publisher_user_id),
        slug: String(row.slug),
        createdAtMs: Number(row.created_at_ms),
      }
    : null;
}

export function memberAppSetting(storage: StorageContext, workspaceId: string) {
  const row = storage.db
    .prepare(`SELECT members_can_share,generation FROM ${SETTINGS} WHERE workspace_id=?`)
    .get(workspaceId);
  return {
    membersCanShare: row?.members_can_share === 1,
    generation: Number(row?.generation ?? 0),
  };
}

function requireManager(storage: StorageContext, workspaceId: string, userId: string) {
  const role = workspaceRoleOf(storage, workspaceId, userId)?.role;
  if (role !== "owner" && role !== "admin") throw relayError("members_forbidden");
}

export function readMemberAppSetting(storage: StorageContext, workspaceId: string, userId: string) {
  return storage.readTx(() => {
    requireManager(storage, workspaceId, userId);
    return { membersCanShare: memberAppSetting(storage, workspaceId).membersCanShare };
  });
}

export function setMemberAppSetting(
  storage: StorageContext,
  input: { workspaceId: string; actorUserId: string; membersCanShare: boolean },
) {
  return storage.tx(() => {
    requireManager(storage, input.workspaceId, input.actorUserId);
    storage.db
      .prepare(
        `INSERT INTO ${SETTINGS} VALUES(?,?,1) ON CONFLICT(workspace_id) DO UPDATE SET members_can_share=excluded.members_can_share,generation=generation+1`,
      )
      .run(input.workspaceId, input.membersCanShare ? 1 : 0);
    return { membersCanShare: input.membersCanShare };
  });
}

export type MemberAppConsent = "none" | "current" | "changed";
/** Current when the viewer allowed every operation the app now reaches; narrowing never asks again. */
export function memberAppConsent(
  storage: StorageContext,
  input: { workspaceId: string; viewerUserId: string; publicationId: string },
  scope: MemberAppScopeCollection[],
): MemberAppConsent {
  const row = storage.db
    .prepare(
      `SELECT scope_digest,operations_json FROM ${CONSENTS} WHERE workspace_id=? AND viewer_user_id=? AND publication_id=?`,
    )
    .get(input.workspaceId, input.viewerUserId, input.publicationId);
  if (!row) return "none";
  const allowed = new Map(JSON.parse(String(row.operations_json)) as [string, string[]][]);
  return row.scope_digest !== "" &&
    scope.every((entry) =>
      entry.operationIds.every((id) => allowed.get(entry.datasetId)?.includes(id)),
    )
    ? "current"
    : "changed";
}

export function recordMemberAppConsent(
  storage: StorageContext,
  input: {
    workspaceId: string;
    viewerUserId: string;
    publicationId: string;
    scopeDigest: string;
    scope: MemberAppScopeCollection[];
    nowMs: number;
  },
): void {
  storage.db
    .prepare(`INSERT OR REPLACE INTO ${CONSENTS} VALUES(?,?,?,?,?,?)`)
    .run(
      input.workspaceId,
      input.viewerUserId,
      input.publicationId,
      input.scopeDigest,
      JSON.stringify(input.scope.map((entry) => [entry.datasetId, entry.operationIds])),
      input.nowMs,
    );
}

function retire(storage: StorageContext, publicationId: string): void {
  storage.db
    .prepare(
      "UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1 WHERE publication_id=? AND active=1",
    )
    .run(publicationId);
  storage.db
    .prepare(
      "DELETE FROM sync_relay_app_publications WHERE publication_id=? AND NOT EXISTS (SELECT 1 FROM sync_relay_app_publication_takedowns WHERE publication_id=?)",
    )
    .run(publicationId, publicationId);
}

export interface WriteMemberAppInput {
  workspaceId: string;
  publisherUserId: string;
  slug: string;
  publicationId: string;
  candidate: AppPublicationCandidate;
  manifest: Uint8Array;
  manifestHash: string;
  blobs: ReadonlyMap<string, Uint8Array>;
  agent: ApprovalAgent | null;
  nowMs: number;
}
/** Call inside the transaction that binds the revision's Collections. */
export function writeMemberApp(storage: StorageContext, input: WriteMemberAppInput) {
  const { workspaceId, publisherUserId, publicationId } = input;
  validateBuildIdentity(input.candidate);
  const role = workspaceRoleOf(storage, workspaceId, publisherUserId)?.role;
  if (!role) throw notFound();
  if (role === "owner")
    throw relayError("members_forbidden", "The owner shares apps as official workspace apps.");
  if (role === "member" && !memberAppSetting(storage, workspaceId).membersCanShare)
    throw relayError(
      "members_forbidden",
      "Members can't share apps in this workspace. The owner or an admin can turn on sharing.",
    );
  assertPublishingNotHeld(storage, publisherUserId);
  const shareId = getWorkspaceMembership(storage, workspaceId)?.shareId;
  if (!shareId) throw notFound();
  const existing = storage.db
    .prepare("SELECT active FROM sync_relay_app_publications WHERE publication_id=?")
    .get(publicationId);
  if (existing?.active === 1) return { publicationId, superseded: [] as string[] };
  if (existing)
    throw relayError("conflict", "This version was taken down. Change the app to share it again.");
  for (const [hash, bytes] of input.blobs)
    putPublicationBlob(storage, workspaceId, hash, bytes, input.nowMs);
  putPublicationBlob(storage, workspaceId, input.manifestHash, input.manifest, input.nowMs);
  storage.db
    .prepare(`INSERT INTO sync_relay_app_publications(publication_id,workspace_id,share_id,grant_id,grant_generation,owner_user_id,manifest_sha256,created_at_ms,active,authority_revision,audience)
    VALUES(?,?,?,NULL,NULL,?,?,?,1,1,'workspace')`)
    .run(publicationId, workspaceId, shareId, publisherUserId, input.manifestHash, input.nowMs);
  storage.db
    .prepare(`INSERT INTO ${MEMBER_APPS} VALUES(?,?,?,'member',?,?)`)
    .run(publicationId, workspaceId, publisherUserId, input.slug, input.nowMs);
  for (const hash of new Set([input.manifestHash, ...input.blobs.keys()]))
    storage.db
      .prepare("INSERT INTO sync_relay_app_publication_blobs VALUES(?,?,?)")
      .run(publicationId, workspaceId, hash);
  recordApproval(
    storage,
    publicationId,
    1,
    { workspaceId, shareId, ownerUserId: publisherUserId },
    input.candidate,
    input.agent,
  );
  const previous = storage.db
    .prepare(`SELECT m.publication_id FROM ${MEMBER_APPS} m JOIN sync_relay_app_publications p USING(publication_id)
    WHERE m.workspace_id=? AND m.publisher_user_id=? AND m.slug=? AND p.active=1 AND m.publication_id<>?`)
    .all(workspaceId, publisherUserId, input.slug, publicationId)
    .map((row) => String(row.publication_id));
  for (const old of previous) {
    storage.db
      .prepare(
        `UPDATE ${CONSENTS} SET publication_id=?,scope_digest='',operations_json='[]' WHERE publication_id=?`,
      )
      .run(publicationId, old);
    retire(storage, old);
  }
  const used = Number(
    storage.db
      .prepare(`SELECT coalesce(sum(byte_length),0) AS n FROM sync_relay_blobs WHERE workspace_id=? AND sha256 IN (
      SELECT b.sha256 FROM sync_relay_app_publication_blobs b JOIN ${MEMBER_APPS} m USING(publication_id)
      WHERE m.workspace_id=? AND m.publisher_user_id=?)`)
      .get(workspaceId, workspaceId, publisherUserId)!.n,
  );
  if (used > MEMBER_APP_STORAGE_BYTES)
    throw relayError(
      "quota_exceeded",
      `Member apps can keep up to ${mib(MEMBER_APP_STORAGE_BYTES)} MiB per person in a workspace. Yours would use ${mib(used)} MiB.`,
    );
  return { publicationId, superseded: previous };
}

export function withdrawMemberApp(
  storage: StorageContext,
  input: { workspaceId: string; actorUserId: string; publicationId: string },
) {
  return storage.tx(() => {
    const app = memberAppRow(storage, input.publicationId);
    const role = workspaceRoleOf(storage, input.workspaceId, input.actorUserId)?.role;
    if (
      !app ||
      app.workspaceId !== input.workspaceId ||
      !role ||
      (role === "member" && app.publisherUserId !== input.actorUserId)
    )
      throw notFound();
    retire(storage, input.publicationId);
    return { publicationId: input.publicationId, active: false };
  });
}

export function memberAppPage(storage: StorageContext, workspaceId: string, cursor: string) {
  const rows = storage.db
    .prepare(`SELECT m.publication_id,m.publisher_user_id,m.slug,m.created_at_ms FROM ${MEMBER_APPS} m
    JOIN sync_relay_app_publications p USING(publication_id)
    WHERE m.workspace_id=? AND p.active=1 AND m.publication_id>? ORDER BY m.publication_id LIMIT 26`)
    .all(workspaceId, cursor);
  return {
    rows: rows.slice(0, 25).map((row) => ({
      publicationId: String(row.publication_id),
      publisherUserId: String(row.publisher_user_id),
      slug: String(row.slug),
      createdAtMs: Number(row.created_at_ms),
    })),
    nextCursor: rows.length > 25 ? String(rows[24]!.publication_id) : null,
  };
}

/** Stops an author's Member apps, so their bindings go before the account's rows do. */
export function retireMemberAppsOf(storage: StorageContext, userId: string): void {
  storage.db
    .prepare(`UPDATE sync_relay_app_publications SET active=0,authority_revision=authority_revision+1
    WHERE active=1 AND publication_id IN (SELECT publication_id FROM ${MEMBER_APPS} WHERE publisher_user_id=?)`)
    .run(userId);
}

const REFUSALS = {
  none: [409, "member_app_review_required", "Review this app before you open it."],
  changed: [
    409,
    "member_app_review_changed",
    "This app changed. Review it again before you open it.",
  ],
  agent: [403, "member_app_person_only", "Only a person can allow a Member app, not an agent."],
} as const;
/** A Member app refusal the viewer acts on: review it, review it again, or allow it themselves. */
export class MemberAppRefusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(kind: keyof typeof REFUSALS) {
    const [status, code, message] = REFUSALS[kind];
    super(message);
    this.status = status;
    this.code = code;
  }
}
