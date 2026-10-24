import { accountDeletionIdentity, type AccountDeletionScope } from "@dohc/workspace-auth/accountDeletion";
import { datasetPrincipalKey } from "@dohc/security-contract/dataset-artifacts";
import { normalizeEmail } from "@dohc/workspace-auth/signUp";
import { noticeIdFrom } from "./notices";
import { revokeShareInTransaction } from "./shares";
import { retireUncoveredServiceActivations, serviceHostEnrollmentsCoveredByShare } from "./serviceHostEnrollment";
import type { StorageContext } from "./context";
import type { SyncRelayStorage } from "./types";

const keys = new WeakMap<SyncRelayStorage, string>();
export function initializeAccountDeletion(storage: StorageContext, key: string): void {
  keys.set(storage, key);
  storage.tx(() => storage.db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_account_deletions (
    account_hash TEXT PRIMARY KEY, phase TEXT NOT NULL CHECK (phase IN ('fenced','runtime','sql','finished')),
    manifest_json TEXT CHECK (manifest_json IS NULL OR json_valid(manifest_json))
  ) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_deleted_workspaces (workspace_hash TEXT PRIMARY KEY) STRICT;
  CREATE TABLE IF NOT EXISTS sync_relay_ended_shares (share_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL, ended_at_ms INTEGER NOT NULL, PRIMARY KEY (share_id, recipient_user_id)) STRICT;`));
}
export function accountIsFenced(storage: SyncRelayStorage, userId: string): boolean {
  const key = keys.get(storage);
  return key !== undefined && Boolean((storage as StorageContext).db.prepare("SELECT 1 FROM sync_relay_account_deletions WHERE account_hash=?").get(accountDeletionIdentity(key, userId)));
}
export function workspaceIsDeleted(storage: SyncRelayStorage, workspaceId: string): boolean {
  const key = keys.get(storage);
  return key !== undefined && Boolean((storage as StorageContext).db.prepare("SELECT 1 FROM sync_relay_deleted_workspaces WHERE workspace_hash=?").get(accountDeletionIdentity(key,"workspace:" + workspaceId)));
}
export function deletionScope(storage: StorageContext, userId: string, email: string): AccountDeletionScope {
  return storage.readTx(() => {
    const workspaceIds = storage.db.prepare("SELECT workspace_id FROM sync_relay_workspaces WHERE owner_user_id=? ORDER BY workspace_id").all(userId).map(row => String(row.workspace_id));
    const count = (sql: string, ...params: string[]) => Number(storage.db.prepare(sql).get(...params)!.n);
    return {workspaceIds, workspaceCount: workspaceIds.length,
      ownedShareCount: count("SELECT count(*) AS n FROM sync_relay_shares WHERE granter_user_id=?", userId),
      heldGrantCount: count("SELECT count(*) AS n FROM sync_relay_share_grants WHERE principal_user_id=? OR lower(principal_email)=?", userId, normalizeEmail(email)),
      storedBytes: count("SELECT coalesce(sum(u.usage_bytes),0) AS n FROM sync_relay_workspace_usage u JOIN sync_relay_workspaces w USING(workspace_id) WHERE w.owner_user_id=?", userId)};
  });
}
export interface DeletionManifest {
  workspaces: {workspaceId: string; replicationEpoch: string | null; streamIdentity: string | null}[];
  shareIds: string[];
  datasets: {workspaceId: string; datasetId: string}[];
  grantIds: string[];
  publicationIds: string[];
}
export function fenceAccount(storage: StorageContext, key: string, userId: string, email: string): {phase: string; manifest: DeletionManifest | null} {
  return storage.tx(() => {
    const accountHash = accountDeletionIdentity(key, userId);
    const existing = storage.db.prepare("SELECT phase,manifest_json FROM sync_relay_account_deletions WHERE account_hash=?").get(accountHash);
    if (existing) return {phase: String(existing.phase), manifest: existing.manifest_json === null ? null : JSON.parse(String(existing.manifest_json)) as DeletionManifest};
    const workspaces = storage.db.prepare("SELECT workspace_id,replication_epoch,stream_identity FROM sync_relay_workspaces WHERE owner_user_id=? UNION SELECT e.workspace_id,e.replication_epoch,e.stream_identity FROM sync_relay_epoch_supersessions e JOIN sync_relay_workspaces w USING(workspace_id) WHERE w.owner_user_id=?").all(userId,userId).map(row => ({workspaceId: String(row.workspace_id), replicationEpoch: row.replication_epoch as string | null, streamIdentity: row.stream_identity as string | null}));
    const shareIds = storage.db.prepare("SELECT share_id FROM sync_relay_shares WHERE granter_user_id=?").all(userId).map(row => String(row.share_id));
    const datasetScopes = new Map<string,{workspaceId:string;datasetId:string}>();
    for (const row of storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      const table = identifier(String(row.name));
      const columns = storage.db.prepare("PRAGMA table_info(" + table + ")").all().map(column => String(column.name));
      if (!columns.includes("workspace_id") || !columns.includes("dataset_id")) continue;
      for (const scope of storage.db.prepare("SELECT DISTINCT workspace_id,dataset_id FROM " + table + " WHERE workspace_id IN (SELECT workspace_id FROM sync_relay_workspaces WHERE owner_user_id=?)").all(userId)) {
        const dataset = {workspaceId:String(scope.workspace_id),datasetId:String(scope.dataset_id)};
        datasetScopes.set(JSON.stringify(dataset),dataset);
      }
    }
    const datasets = [...datasetScopes.values()];
    const grantIds = storage.db.prepare("SELECT g.grant_id FROM sync_relay_share_grants g JOIN sync_relay_shares s USING(share_id) WHERE s.granter_user_id=?").all(userId).map(row => String(row.grant_id));
    const publicationIds = storage.db.prepare("SELECT publication_id FROM sync_relay_app_publications WHERE owner_user_id=?").all(userId).map(row => String(row.publication_id));
    const manifest = {workspaces, shareIds, datasets, grantIds, publicationIds};
    for (const row of workspaces) storage.db.prepare("INSERT OR IGNORE INTO sync_relay_deleted_workspaces VALUES(?)").run(accountDeletionIdentity(key,"workspace:"+row.workspaceId));
    for (const shareId of shareIds) {
      const recipients = storage.db.prepare("SELECT DISTINCT principal_user_id FROM sync_relay_share_grants WHERE share_id=? AND principal_kind='user' AND principal_user_id<>?").all(shareId,userId);
      for (const recipient of recipients) storage.db.prepare("INSERT OR IGNORE INTO sync_relay_ended_shares VALUES(?,?,?)").run(shareId,String(recipient.principal_user_id),Date.now());
      revokeShareInTransaction(storage, shareId, Date.now());
    }
    // Ending the person's grants can end a hosted document's last Edit grant.
    const covered = storage.db.prepare("SELECT DISTINCT share_id FROM sync_relay_share_grants WHERE status='active' AND (principal_user_id=? OR lower(principal_email)=?)")
      .all(userId, normalizeEmail(email)).flatMap(row => serviceHostEnrollmentsCoveredByShare(storage, String(row.share_id)));
    storage.db.prepare("UPDATE sync_relay_share_grants SET status='revoked',revoked_at_ms=?,generation=generation+1 WHERE status='active' AND (principal_user_id=? OR lower(principal_email)=?)").run(Date.now(), userId, normalizeEmail(email));
    retireUncoveredServiceActivations(storage, covered, Date.now());
    storage.db.prepare(`UPDATE sync_relay_share_removals SET voided = 1
      WHERE voided = 0 AND EXISTS (
        SELECT 1 FROM json_each(grants_json) receipt_grant
        JOIN sync_relay_share_grants g ON g.grant_id = json_extract(receipt_grant.value, '$.grantId')
        WHERE g.principal_user_id = ? OR lower(g.principal_email) = ?
      )`).run(userId, normalizeEmail(email));
    storage.db.prepare("DELETE FROM sync_relay_link_sessions WHERE grant_id IN (SELECT g.grant_id FROM sync_relay_share_grants g JOIN sync_relay_shares s USING(share_id) WHERE s.granter_user_id=?)").run(userId);
    storage.db.prepare("UPDATE sync_relay_service_host_enrollments SET enabled=0,retired=1 WHERE owner_user_id=?").run(userId);
    storage.db.prepare("DELETE FROM sync_relay_live_session_tickets WHERE principal_id=? OR workspace_id IN (SELECT workspace_id FROM sync_relay_workspaces WHERE owner_user_id=?)").run(userId,userId);
    storage.db.prepare("INSERT INTO sync_relay_account_deletions VALUES(?,'fenced',?)").run(accountHash, JSON.stringify(manifest));
    return {phase: "fenced", manifest};
  });
}
export function completeDeletionPhase(storage: StorageContext, key: string, userId: string, phase: "runtime" | "sql" | "finished"): void {
  storage.tx(() => storage.db.prepare("UPDATE sync_relay_account_deletions SET phase=?,manifest_json=CASE WHEN ?='finished' THEN NULL ELSE manifest_json END WHERE account_hash=?").run(phase,phase,accountDeletionIdentity(key,userId)));
}

export const RETAINED_ACCOUNT_HISTORY = new Set([
  "sync_relay_log", "sync_relay_live_update_journal", "sync_relay_live_update_struct_provenance",
  "sync_relay_live_author_clients", "sync_relay_share_discussion_messages",
]);
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export function purgeAccountRows(storage: StorageContext, userId: string, email: string, manifest: DeletionManifest): void {
  storage.tx(() => {
    storage.db.exec("PRAGMA defer_foreign_keys=ON");
    const received = storage.db.prepare("SELECT g.grant_id,g.share_id,s.workspace_id FROM sync_relay_share_grants g JOIN sync_relay_shares s USING(share_id) WHERE g.principal_user_id=? OR lower(g.principal_email)=?").all(userId,normalizeEmail(email));
    // An Undo receipt must never restore one of the deleted account's grants.
    for (const grant of received) storage.db.prepare("DELETE FROM sync_relay_share_removals WHERE share_id=? AND EXISTS(SELECT 1 FROM json_each(grants_json) WHERE json_extract(value,'$.grantId')=?)").run(String(grant.share_id),String(grant.grant_id));
    const sent = storage.db.prepare("SELECT recipient_user_id,notice_id,change_seq FROM sync_relay_notices WHERE sender_user_id=? OR workspace_id IN (SELECT workspace_id FROM sync_relay_workspaces WHERE owner_user_id=?) OR recipient_share_id IN (SELECT share_id FROM sync_relay_shares WHERE granter_user_id=?)").all(userId,userId,userId);
    for (const notice of sent) {
      storage.db.prepare("UPDATE sync_relay_notice_lists SET floor_seq=max(floor_seq,?) WHERE recipient_user_id=?").run(Number(notice.change_seq),String(notice.recipient_user_id));
      storage.db.prepare("DELETE FROM sync_relay_notice_dismissals WHERE recipient_user_id=? AND notice_id=?").run(String(notice.recipient_user_id),String(notice.notice_id));
    }
    if (storage.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dohc_dataset_automation_claims'").get()) {
      const removed = storage.db.prepare("DELETE FROM dohc_dataset_automation_presses WHERE claim_id IN (SELECT claim_id FROM dohc_dataset_automation_claims WHERE json_extract(actor,'$.userId')=?) RETURNING workspace_id,dataset_id,storage_bytes").all(userId);
      removed.push(...storage.db.prepare("DELETE FROM dohc_dataset_automation_claims WHERE json_extract(actor,'$.userId')=? RETURNING workspace_id,dataset_id,storage_bytes").all(userId));
      for (const row of removed) {
        storage.db.prepare("UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes-? WHERE workspace_id=? AND dataset_id=?").run(Number(row.storage_bytes),String(row.workspace_id),String(row.dataset_id));
        storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=?").run(Number(row.storage_bytes),String(row.workspace_id));
      }
    }
    storage.db.prepare("DELETE FROM sync_relay_ended_shares WHERE recipient_user_id=?").run(userId);
    const tables = storage.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name));
    // All authoritative dataset tables carry workspace_id, including tables
    // without a workspace foreign key. Defer constraints across this purge.
    for (const table of tables) {
      const columns = storage.db.prepare("PRAGMA table_info(" + identifier(table) + ")").all().map(row => String(row.name));
      if (table === "sync_relay_account_deletions" || table === "sync_relay_ended_shares" || table === "sync_relay_deleted_workspaces") continue;
      for (const workspace of manifest.workspaces) {
        if (columns.includes("workspace_id")) storage.db.prepare("DELETE FROM " + identifier(table) + " WHERE workspace_id=?").run(workspace.workspaceId);
        if (columns.includes("recipient_share_id")) for (const shareId of manifest.shareIds) storage.db.prepare("DELETE FROM " + identifier(table) + " WHERE recipient_share_id=?").run(shareId);
      }
      if (columns.includes("principal_key")) for (const grant of received) {
        const principalKey = datasetPrincipalKey(String(grant.workspace_id),String(grant.grant_id),userId);
        // Pending uploads and attempts in a surviving workspace give their charge back.
        const charged = columns.includes("storage_bytes") && columns.includes("dataset_id");
        const removed = storage.db.prepare("DELETE FROM " + identifier(table) + " WHERE principal_key=?" + (table === "sync_relay_dataset_files" ? " AND attached_revision IS NULL" : "") +
          (charged ? " RETURNING workspace_id,dataset_id,storage_bytes" : "")).all(principalKey);
        for (const row of charged ? removed : []) {
          storage.db.prepare("UPDATE sync_relay_dataset_usage SET storage_bytes=storage_bytes-? WHERE workspace_id=? AND dataset_id=?").run(Number(row.storage_bytes),String(row.workspace_id),String(row.dataset_id));
          storage.db.prepare("UPDATE sync_relay_workspace_usage SET usage_bytes=usage_bytes-? WHERE workspace_id=?").run(Number(row.storage_bytes),String(row.workspace_id));
        }
      }
      if (RETAINED_ACCOUNT_HISTORY.has(table)) continue;
      if (columns.includes("notice_id")) {
        const prefix = noticeIdFrom(userId, "");
        storage.db.prepare("DELETE FROM " + identifier(table) + " WHERE substr(notice_id,1,?)=?").run(prefix.length, prefix);
      }
      const identityColumns = columns.filter(column => column.endsWith("user_id") || column === "principal_id");
      for (const column of identityColumns) storage.db.prepare("DELETE FROM " + identifier(table) + " WHERE " + identifier(column) + "=?").run(userId);
      if (columns.includes("principal_email")) storage.db.prepare("DELETE FROM " + identifier(table) + " WHERE lower(principal_email)=?").run(normalizeEmail(email));
    }
  });
}
