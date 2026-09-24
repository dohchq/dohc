import type { SqliteDb } from "./types";

export const NOTICE_LISTS = "sync_relay_notice_lists";
export const NOTICES = "sync_relay_notices";
const MARKER = "notices-v1";

// One list per person. `change_seq` is the list's change counter and never
// goes back, so a pull cursor stays valid after rows go. `floor_seq` is the
// highest change of any row removed from the list: a cursor below it missed
// a removal and must take the whole list again. `removed_seq` is the change
// at which the list last lost rows, so a pull that is taking the whole list
// starts over only when rows go after it began. All count per person so a
// cursor says nothing about anyone else's notices.
//
// A notice row names the workspace the recipient may see (`workspace_id`)
// or the share the recipient reads it through (`recipient_share_id`), never
// both. `target_json` is null once the recipient lost access to the target.
const NOTICE_SCHEMA = {
  [NOTICE_LISTS]: `CREATE TABLE sync_relay_notice_lists (
  recipient_user_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(CAST(recipient_user_id AS BLOB)) BETWEEN 1 AND 1024),
  change_seq INTEGER NOT NULL CHECK (change_seq BETWEEN 1 AND 9007199254740991),
  floor_seq INTEGER NOT NULL CHECK (floor_seq BETWEEN 0 AND change_seq),
  removed_seq INTEGER NOT NULL CHECK (removed_seq BETWEEN 0 AND change_seq)
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
  CHECK ((workspace_id IS NULL) <> (recipient_share_id IS NULL)),
  PRIMARY KEY (recipient_user_id, notice_id),
  UNIQUE (recipient_user_id, change_seq)
) STRICT`,
  idx_sync_relay_notices_expiry: `CREATE INDEX idx_sync_relay_notices_expiry
  ON sync_relay_notices(expires_at_ms)`,
  idx_sync_relay_notices_sender: `CREATE INDEX idx_sync_relay_notices_sender
  ON sync_relay_notices(recipient_user_id, sender_user_id, created_at_ms)`,
} as const;

function sameSql(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/;$/, "").replace(/\s+/g, " ");
  return normalize(left) === normalize(right);
}

function assertNoticeSchema(db: SqliteDb): void {
  const objects = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (?, ?) AND sql IS NOT NULL ORDER BY name")
    .all(NOTICE_LISTS, NOTICES);
  const expected = Object.keys(NOTICE_SCHEMA).sort();
  if (
    objects.length !== expected.length ||
    objects.some((row, index) => row.name !== expected[index] ||
      typeof row.sql !== "string" ||
      !sameSql(row.sql, NOTICE_SCHEMA[row.name as keyof typeof NOTICE_SCHEMA]))
  ) {
    throw new Error("notice schema is missing or damaged");
  }
}

export function initializeNoticeSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER);
  if (marked) {
    assertNoticeSchema(db);
    return;
  }
  const names = Object.keys(NOTICE_SCHEMA);
  const existing = db
    .prepare(`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`)
    .all(...names);
  if (existing.length) throw new Error("unmarked notice schema already exists");
  for (const sql of Object.values(NOTICE_SCHEMA)) db.exec(sql);
  assertNoticeSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
    .run(MARKER, Date.now());
}
