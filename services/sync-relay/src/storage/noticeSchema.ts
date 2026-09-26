import type { SqliteDb } from "./types";

export const NOTICE_LISTS = "sync_relay_notice_lists";
export const NOTICES = "sync_relay_notices";
export const NOTICE_DISMISSALS = "sync_relay_notice_dismissals";
export const NOTICE_DISMISSAL_FLOORS = "sync_relay_notice_dismissal_floors";
const MARKER = "notices-v1";
const DISMISSALS_MARKER = "notice-dismissals-v1";

// One list per person. `change_seq` is the list's change counter and never
// goes back, so a pull cursor stays valid after rows go. `floor_seq` is the
// newest change of any row deleted from the list: a cursor below it missed
// that change and takes the whole list again. The counters are per person so
// a cursor says nothing about anyone else's notices. `reach_token` digests
// the reads that decided the person's access when it was last checked.
//
// A notice row names the workspace the recipient may see (`workspace_id`)
// or the share the recipient reads it through (`recipient_share_id`), never
// both. `target_json` is null once the recipient lost access to the target.
// A row removed to make room stays briefly as a tombstone (`removed_at_ms`)
// with a new change, so each computer drops it through an ordinary pull.
const NOTICE_SCHEMA = {
  [NOTICE_LISTS]: `CREATE TABLE sync_relay_notice_lists (
  recipient_user_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(CAST(recipient_user_id AS BLOB)) BETWEEN 1 AND 1024),
  change_seq INTEGER NOT NULL CHECK (change_seq BETWEEN 1 AND 9007199254740991),
  floor_seq INTEGER NOT NULL CHECK (floor_seq BETWEEN 0 AND change_seq),
  reach_token TEXT CHECK (reach_token IS NULL OR (length(reach_token) = 64 AND reach_token NOT GLOB '*[^0-9a-f]*'))
) STRICT`,
  [NOTICES]: `CREATE TABLE sync_relay_notices (
  recipient_user_id TEXT NOT NULL REFERENCES sync_relay_notice_lists(recipient_user_id),
  notice_id TEXT NOT NULL CHECK (length(notice_id) BETWEEN 1 AND 1024),
  change_seq INTEGER NOT NULL CHECK (change_seq BETWEEN 1 AND 9007199254740991),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 1024),
  recipient_share_id TEXT CHECK (recipient_share_id IS NULL OR length(recipient_share_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  sender_kind TEXT NOT NULL CHECK (sender_kind IN ('person', 'agent', 'automation')),
  sender_user_id TEXT NOT NULL CHECK (length(CAST(sender_user_id AS BLOB)) BETWEEN 1 AND 1024),
  sender_label TEXT NOT NULL CHECK (length(sender_label) BETWEEN 1 AND 40),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body TEXT NOT NULL CHECK (length(body) <= 500),
  target_json TEXT CHECK (target_json IS NULL OR (json_valid(target_json) AND length(CAST(target_json AS BLOB)) <= 2048)),
  origin_install_id TEXT NOT NULL CHECK (length(origin_install_id) BETWEEN 1 AND 256),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  read_at_ms INTEGER CHECK (read_at_ms IS NULL OR read_at_ms BETWEEN 0 AND 9007199254740991),
  dismissed_at_ms INTEGER CHECK (dismissed_at_ms IS NULL OR dismissed_at_ms BETWEEN 0 AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
  removed_at_ms INTEGER CHECK (removed_at_ms IS NULL OR removed_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK ((workspace_id IS NULL) <> (recipient_share_id IS NULL)),
  CHECK (removed_at_ms IS NULL OR (body = '' AND target_json IS NULL)),
  PRIMARY KEY (recipient_user_id, notice_id),
  UNIQUE (recipient_user_id, change_seq)
) STRICT`,
  idx_sync_relay_notices_expiry: `CREATE INDEX idx_sync_relay_notices_expiry
  ON sync_relay_notices(expires_at_ms)`,
  idx_sync_relay_notices_sender: `CREATE INDEX idx_sync_relay_notices_sender
  ON sync_relay_notices(recipient_user_id, sender_user_id, created_at_ms)`,
} as const;

// Each notice's first dismissal, kept after the notice row itself goes, so a
// notice posted again after its retention cannot be dismissed first twice.
// Run now on a skipped schedule relies on that to run once. The receipt
// names the computer that dismissed first, so that computer, asking again
// after a lost answer or a crash, hears that the dismissal was its. A person keeps
// at most NOTICE_DISMISSAL_RECEIPTS receipts. Reclaiming a skipped-schedule
// notice's receipt raises that schedule's `reclaimed_through_ms`, and a
// notice for the schedule first skipped at or before it is refused, so a
// reclaimed one never runs again.
const DISMISSAL_SCHEMA = {
  [NOTICE_DISMISSALS]: `CREATE TABLE sync_relay_notice_dismissals (
  recipient_user_id TEXT NOT NULL CHECK (length(CAST(recipient_user_id AS BLOB)) BETWEEN 1 AND 1024),
  notice_id TEXT NOT NULL CHECK (length(notice_id) BETWEEN 1 AND 1024),
  dismissed_at_ms INTEGER NOT NULL CHECK (dismissed_at_ms BETWEEN 0 AND 9007199254740991),
  winner_install_id TEXT CHECK (winner_install_id IS NULL OR length(winner_install_id) BETWEEN 1 AND 256),
  PRIMARY KEY (recipient_user_id, notice_id)
) STRICT`,
  idx_sync_relay_notice_dismissals_age: `CREATE INDEX idx_sync_relay_notice_dismissals_age
  ON sync_relay_notice_dismissals(recipient_user_id, dismissed_at_ms, notice_id)`,
  [NOTICE_DISMISSAL_FLOORS]: `CREATE TABLE sync_relay_notice_dismissal_floors (
  recipient_user_id TEXT NOT NULL CHECK (length(CAST(recipient_user_id AS BLOB)) BETWEEN 1 AND 1024),
  schedule_key TEXT NOT NULL CHECK (length(schedule_key) BETWEEN 1 AND 1024),
  reclaimed_through_ms INTEGER NOT NULL CHECK (reclaimed_through_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (recipient_user_id, schedule_key)
) STRICT`,
} as const;

function sameSql(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/;$/, "").replace(/\s+/g, " ");
  return normalize(left) === normalize(right);
}

function assertSchema(db: SqliteDb, schema: Record<string, string>, tables: readonly string[]): void {
  const objects = db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (${tables.map(() => "?").join(", ")}) AND sql IS NOT NULL ORDER BY name`)
    .all(...tables);
  const expected = Object.keys(schema).sort();
  if (
    objects.length !== expected.length ||
    objects.some((row, index) => row.name !== expected[index] ||
      typeof row.sql !== "string" ||
      !sameSql(row.sql, schema[row.name as string]!))
  ) {
    throw new Error("notice schema is missing or damaged");
  }
}

// Share notices waiting to be delivered, one per named grant, written with
// the grant and removed once delivered or settled, or when the grant is
// revoked.
export function initializeShareNoticeDeliverySchema(db: SqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_relay_share_notice_deliveries (
    grant_id TEXT NOT NULL PRIMARY KEY
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991)
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS sync_relay_share_notice_deliveries_revoked
    AFTER UPDATE OF status ON sync_relay_share_grants WHEN NEW.status <> 'active' BEGIN
    DELETE FROM sync_relay_share_notice_deliveries WHERE grant_id = NEW.grant_id; END`);
}

function initializeSchema(db: SqliteDb, schema: Record<string, string>, tables: readonly string[], marker: string): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker);
  if (marked) {
    assertSchema(db, schema, tables);
    return;
  }
  const names = Object.keys(schema);
  const existing = db
    .prepare(`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`)
    .all(...names);
  if (existing.length) throw new Error("unmarked notice schema already exists");
  for (const sql of Object.values(schema)) db.exec(sql);
  assertSchema(db, schema, tables);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
    .run(marker, Date.now());
}

export function initializeNoticeSchema(db: SqliteDb): void {
  initializeSchema(db, NOTICE_SCHEMA, [NOTICE_LISTS, NOTICES], MARKER);
  initializeSchema(db, DISMISSAL_SCHEMA, [NOTICE_DISMISSALS, NOTICE_DISMISSAL_FLOORS], DISMISSALS_MARKER);
}
