import type { SqliteDb } from "./types";
import { LIVE_RESTORE_OPERATIONS } from "./liveRestoreOperationSchema";

export const LIVE_RESTORE_CANCELLATIONS = "sync_relay_live_restore_cancellations";
const marker = "live-restore-cancellation-v1";
const safe = Number.MAX_SAFE_INTEGER;
// A restore the owner ends after the relay fenced it. The row is recorded
// before the host is asked, so relay admission refuses from then on, and
// holds the host's authenticated answer once it is known. A committed native
// fence ends at its own journal cursor, the control entry passive replicas
// apply between deliveries; it is no delivery. Its bytes come out of the
// operation's reservation, so a full workspace can still decline.
const tableSql = `CREATE TABLE ${LIVE_RESTORE_CANCELLATIONS} (
    relay_database_namespace TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms BETWEEN 0 AND ${safe}),
    outcome TEXT CHECK (outcome IN ('cancelled','fence-cancelled')),
    acknowledgment_json TEXT CHECK (json_valid(acknowledgment_json)),
    journal_cursor INTEGER UNIQUE CHECK (journal_cursor BETWEEN 1 AND ${safe}),
    accounted_bytes INTEGER NOT NULL CHECK (accounted_bytes BETWEEN 1 AND ${safe}),
    PRIMARY KEY (relay_database_namespace,operation_id),
    FOREIGN KEY (relay_database_namespace,operation_id) REFERENCES ${LIVE_RESTORE_OPERATIONS}(relay_database_namespace,operation_id) ON DELETE CASCADE,
    CHECK ((outcome IS NULL) = (acknowledgment_json IS NULL)),
    CHECK ((journal_cursor IS NOT NULL) = (COALESCE(outcome,'')='fence-cancelled'))
  ) STRICT`;
const indexName = "sync_relay_live_restore_cancellation_entries";
const indexSql = `CREATE INDEX ${indexName} ON ${LIVE_RESTORE_CANCELLATIONS}(workspace_id,journal_cursor) WHERE journal_cursor IS NOT NULL`;

export function initializeLiveRestoreCancellationSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(marker) !== undefined;
  const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
  for (const [name, type, sql] of [[LIVE_RESTORE_CANCELLATIONS, "table", tableSql], [indexName, "index", indexSql]] as const) {
    const row = db.prepare("SELECT type,sql FROM sqlite_schema WHERE name=?").get(name);
    if (!marked) {
      if (row) throw new Error("Unmarked live restore cancellation schema already exists.");
      db.exec(sql);
    } else if (!row || row.type !== type || typeof row.sql !== "string" || normalize(row.sql) !== normalize(sql)) {
      throw new Error("Live restore cancellation schema is missing or damaged.");
    }
  }
  if (db.prepare(`PRAGMA foreign_key_check(${LIVE_RESTORE_CANCELLATIONS})`).all().length) throw new Error("Live restore cancellation storage is damaged.");
  if (!marked) db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(marker, Date.now());
}
