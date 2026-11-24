import type { SqliteDb } from "./types";

/**
 * Every table a live connection's standing check reads: the owner, named,
 * member, link and agent paths of `resolveCurrentLiveDocumentBinding`,
 * which calls `authorizeNamedLiveEditShareGrant`. A write to one may change
 * a live connection's authority. New log rows cannot: a check reads only the
 * log row its document's baseline already names.
 */
export const LIVE_AUTHORITY_TABLES = [
  "sync_relay_workspaces",
  "sync_relay_shares",
  "sync_relay_share_grants",
  "sync_relay_workspace_memberships",
  "sync_relay_workspace_members",
  "sync_relay_access_rules",
  "sync_relay_account_emails",
  "sync_relay_link_sessions",
  "sync_relay_link_principals",
  "sync_relay_link_credentials",
  "sync_relay_agent_connections",
  "sync_relay_agent_tokens",
  "sync_relay_session_host_control",
  "sync_relay_service_host_enrollments",
  "sync_relay_service_activations",
  "sync_relay_live_documents",
  "sync_relay_live_document_baseline_ranges",
  "sync_relay_live_document_ordinary_bases",
  "sync_relay_live_delivery_owners",
  "sync_relay_object_moments",
  "sync_relay_blobs",
  "sync_relay_log",
  "sync_relay_folder_rules",
  "sync_relay_folder_rule_bindings",
] as const;

const WRITES = "sync_relay_live_authority_writes";

/** This connection's count of writes to those tables. Each write transaction compares it. */
export const LIVE_AUTHORITY_WRITE_COUNT = `(SELECT count FROM temp.${WRITES})`;

/** Temp triggers count every such write made on this connection, so a write classed as changing no live authority is checked. */
export function watchLiveAuthorityWrites(db: SqliteDb): void {
  db.exec(`CREATE TEMP TABLE ${WRITES} (count INTEGER NOT NULL)`);
  db.exec(`INSERT INTO temp.${WRITES} (count) VALUES (0)`);
  for (const table of LIVE_AUTHORITY_TABLES) {
    for (const event of ["INSERT", "UPDATE", "DELETE"] as const) {
      if (table === "sync_relay_log" && event === "INSERT") continue;
      db.exec(`CREATE TEMP TRIGGER ${WRITES}_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN UPDATE ${WRITES} SET count = count + 1; END`);
    }
  }
}
