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
export const PUSH_SCHEMA = {
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
const DEVICES_MARKER = "push-native-devices-v1";

// The same rows, now a checked `web | apns` variant. A web row keeps every
// browser column and check above. An apns row is one phone sign-in's
// binding: no installation, at most one per session, and a token held by
// one binding per topic and environment.
const PUSH_DEVICE_SCHEMA = {
  [PUSH_SUBSCRIPTIONS]: `CREATE TABLE sync_relay_push_subscriptions (
  kind TEXT NOT NULL CHECK (kind IN ('web', 'apns')),
  installation_id TEXT UNIQUE
    CHECK (length(installation_id) = 22 AND installation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  account_user_id TEXT NOT NULL CHECK (length(CAST(account_user_id AS BLOB)) BETWEEN 1 AND 1024),
  session_id TEXT NOT NULL CHECK (length(CAST(session_id AS BLOB)) BETWEEN 1 AND 1024),
  endpoint TEXT UNIQUE CHECK (length(endpoint) BETWEEN 9 AND 2048 AND substr(endpoint, 1, 8) = 'https://'),
  p256dh TEXT CHECK (length(p256dh) = 87 AND p256dh NOT GLOB '*[^A-Za-z0-9_-]*'),
  auth TEXT CHECK (length(auth) = 22 AND auth NOT GLOB '*[^A-Za-z0-9_-]*'),
  vapid_key_id TEXT CHECK (length(vapid_key_id) = 64 AND vapid_key_id NOT GLOB '*[^0-9a-f]*'),
  apns_token TEXT CHECK (length(apns_token) BETWEEN 64 AND 200 AND length(apns_token) % 2 = 0
    AND apns_token NOT GLOB '*[^0-9a-f]*'),
  apns_environment TEXT CHECK (apns_environment IN ('sandbox', 'production')),
  apns_topic TEXT CHECK (length(apns_topic) BETWEEN 1 AND 255 AND apns_topic NOT GLOB '*[^A-Za-z0-9.-]*'),
  generation INTEGER NOT NULL UNIQUE CHECK (generation BETWEEN 1 AND 9007199254740991),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 9007199254740991),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (CASE kind
    WHEN 'web' THEN installation_id IS NOT NULL AND endpoint IS NOT NULL AND p256dh IS NOT NULL
      AND auth IS NOT NULL AND vapid_key_id IS NOT NULL
      AND apns_token IS NULL AND apns_environment IS NULL AND apns_topic IS NULL
    ELSE installation_id IS NULL AND endpoint IS NULL AND p256dh IS NULL AND auth IS NULL
      AND vapid_key_id IS NULL
      AND apns_token IS NOT NULL AND apns_environment IS NOT NULL AND apns_topic IS NOT NULL END),
  UNIQUE (apns_topic, apns_environment, apns_token)
) STRICT`,
  idx_sync_relay_push_subscriptions_account: PUSH_SCHEMA.idx_sync_relay_push_subscriptions_account,
  idx_sync_relay_push_subscriptions_device: `CREATE UNIQUE INDEX idx_sync_relay_push_subscriptions_device
  ON sync_relay_push_subscriptions(session_id) WHERE kind = 'apns'`,
  [PUSH_GENERATIONS]: PUSH_SCHEMA[PUSH_GENERATIONS],
} as const;

const normalize = (sql: string) => sql.trim().replace(/;$/u, "").replace(/\s+/gu, " ");

function assertSchema(db: SqliteDb, schema: Record<string, string>): void {
  const objects = db
    .prepare(
      `SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (${TABLES.map(() => "?").join(", ")}) AND sql IS NOT NULL ORDER BY name`,
    )
    .all(...TABLES);
  const expected = Object.keys(schema).sort();
  if (
    objects.length !== expected.length ||
    objects.some(
      (row, index) =>
        row.name !== expected[index] ||
        typeof row.sql !== "string" ||
        normalize(row.sql) !== normalize(schema[row.name as string]!),
    ) ||
    !db.prepare(`SELECT 1 FROM ${PUSH_GENERATIONS} WHERE singleton = 1`).get()
  ) {
    throw new Error("push subscription schema is missing or damaged");
  }
}

const marked = (db: SqliteDb, marker: string) =>
  db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(marker) !==
  undefined;

export function initializePushSchema(db: SqliteDb): void {
  if (marked(db, MARKER)) {
    // A store that took the phone's bindings is checked against that schema instead.
    if (!marked(db, DEVICES_MARKER)) assertSchema(db, PUSH_SCHEMA);
    return;
  }
  const names = Object.keys(PUSH_SCHEMA);
  if (
    db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`)
      .get(...names)
  ) {
    throw new Error("unmarked push subscription schema already exists");
  }
  for (const sql of Object.values(PUSH_SCHEMA)) db.exec(sql);
  db.prepare(`INSERT INTO ${PUSH_GENERATIONS} (singleton, last_generation) VALUES (1, 0)`).run();
  assertSchema(db, PUSH_SCHEMA);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    MARKER,
    Date.now(),
  );
}

const WEB_COLUMNS =
  "installation_id, account_user_id, session_id, endpoint, p256dh, auth, vapid_key_id, generation, created_at_ms, updated_at_ms, expires_at_ms";

/**
 * Rebuilds the browser subscriptions as the `web` rows of the checked
 * variant. Runs inside the relay's schema transaction, after the delivery
 * schema removed the installation account names.
 */
export function initializePushDeviceSchema(db: SqliteDb): void {
  if (marked(db, DEVICES_MARKER)) {
    assertSchema(db, PUSH_DEVICE_SCHEMA);
    return;
  }
  db.exec(`CREATE TEMP TABLE push_subscriptions_previous AS SELECT * FROM main.${PUSH_SUBSCRIPTIONS};
    DROP TABLE main.${PUSH_SUBSCRIPTIONS};`);
  db.exec(PUSH_DEVICE_SCHEMA[PUSH_SUBSCRIPTIONS]);
  db.exec(PUSH_DEVICE_SCHEMA.idx_sync_relay_push_subscriptions_account);
  db.exec(PUSH_DEVICE_SCHEMA.idx_sync_relay_push_subscriptions_device);
  db.exec(`INSERT INTO main.${PUSH_SUBSCRIPTIONS} (kind, ${WEB_COLUMNS})
      SELECT 'web', ${WEB_COLUMNS} FROM temp.push_subscriptions_previous;
    DROP TABLE temp.push_subscriptions_previous;`);
  assertSchema(db, PUSH_DEVICE_SCHEMA);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    DEVICES_MARKER,
    Date.now(),
  );
}

export const PUSH_REVOKED_SESSIONS = "sync_relay_push_revoked_sessions";
const REVOKED_MARKER = "push-revoked-sessions-v1";
// One row per revoke attempt on a sign-in, written before the account
// server deletes the session, so a registration whose session lookup began
// before the revoke cannot bind. A failed attempt removes its own row; a
// successful one keeps it until the sign-in would have expired.
const PUSH_REVOKED_SCHEMA = `CREATE TABLE sync_relay_push_revoked_sessions (
  session_id TEXT NOT NULL CHECK (length(CAST(session_id AS BLOB)) BETWEEN 1 AND 1024),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 64),
  account_user_id TEXT NOT NULL CHECK (length(CAST(account_user_id AS BLOB)) BETWEEN 1 AND 1024),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (session_id, attempt_id)
) STRICT`;

export function initializePushRevokedSessionSchema(db: SqliteDb): void {
  const sql = db
    .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
    .get(PUSH_REVOKED_SESSIONS)?.sql;
  if (marked(db, REVOKED_MARKER)) {
    if (typeof sql !== "string" || normalize(sql) !== normalize(PUSH_REVOKED_SCHEMA))
      throw new Error("push subscription schema is missing or damaged");
    return;
  }
  if (sql !== undefined) throw new Error("unmarked push subscription schema already exists");
  db.exec(PUSH_REVOKED_SCHEMA);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(
    REVOKED_MARKER,
    Date.now(),
  );
}
