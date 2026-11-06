import type { SqliteDb } from "./types";

export const PUSH_SUBSCRIPTIONS = "sync_relay_push_subscriptions";
export const PUSH_GENERATIONS = "sync_relay_push_generations";
const MARKER = "push-subscriptions-v1";

// One row per browser installation that has alerts on. The row names the
// account and the sign-in (`session_id`) that turned them on; another sign-in
// on the same browser does not inherit it. An endpoint belongs to one
// installation. `generation` comes from one server-wide counter, so a
// binding that ends and a later one never share a generation.
// `expires_at_ms` is the earlier of the sign-in's and the browser
// subscription's expiry.
const PUSH_SCHEMA = {
  [PUSH_SUBSCRIPTIONS]: `CREATE TABLE sync_relay_push_subscriptions (
  installation_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(installation_id) = 22 AND installation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  account_user_id TEXT NOT NULL CHECK (length(CAST(account_user_id AS BLOB)) BETWEEN 1 AND 1024),
  session_id TEXT NOT NULL CHECK (length(CAST(session_id AS BLOB)) BETWEEN 1 AND 1024),
  endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 9 AND 2048 AND substr(endpoint, 1, 8) = 'https://'),
  p256dh TEXT NOT NULL CHECK (length(p256dh) = 87 AND p256dh NOT GLOB '*[^A-Za-z0-9_-]*'),
  auth TEXT NOT NULL CHECK (length(auth) = 22 AND auth NOT GLOB '*[^A-Za-z0-9_-]*'),
  vapid_key_id TEXT NOT NULL CHECK (length(vapid_key_id) = 64 AND vapid_key_id NOT GLOB '*[^0-9a-f]*'),
  generation INTEGER NOT NULL UNIQUE CHECK (generation BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991)
) STRICT`,
  idx_sync_relay_push_subscriptions_account: `CREATE INDEX idx_sync_relay_push_subscriptions_account
  ON sync_relay_push_subscriptions(account_user_id)`,
  [PUSH_GENERATIONS]: `CREATE TABLE sync_relay_push_generations (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  last_generation INTEGER NOT NULL CHECK (last_generation BETWEEN 0 AND 9007199254740991)
) STRICT`,
} as const;
const TABLES = [PUSH_SUBSCRIPTIONS, PUSH_GENERATIONS];

const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

function assertSchema(db: SqliteDb): void {
  const objects = db
    .prepare(`SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (${TABLES.map(() => "?").join(", ")}) AND sql IS NOT NULL ORDER BY name`)
    .all(...TABLES);
  const expected = Object.keys(PUSH_SCHEMA).sort();
  const schema: Record<string, string> = PUSH_SCHEMA;
  if (
    objects.length !== expected.length ||
    objects.some((row, index) => row.name !== expected[index] || typeof row.sql !== "string" ||
      normalize(row.sql) !== normalize(schema[row.name as string]!)) ||
    !db.prepare(`SELECT 1 FROM ${PUSH_GENERATIONS} WHERE singleton = 1`).get()
  ) {
    throw new Error("push subscription schema is missing or damaged");
  }
}

export function initializePushSchema(db: SqliteDb): void {
  if (db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER)) {
    assertSchema(db);
    return;
  }
  const names = Object.keys(PUSH_SCHEMA);
  if (db.prepare(`SELECT 1 FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`).get(...names)) {
    throw new Error("unmarked push subscription schema already exists");
  }
  for (const sql of Object.values(PUSH_SCHEMA)) db.exec(sql);
  db.prepare(`INSERT INTO ${PUSH_GENERATIONS} (singleton, last_generation) VALUES (1, 0)`).run();
  assertSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(MARKER, Date.now());
}
