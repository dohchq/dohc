import type { SqliteDb } from "./types";

export const AUTOMATION_HOSTS = "sync_relay_automation_hosts";
export const AUTOMATION_COMPUTERS = "sync_relay_automation_computers";
const MARKER = "automation-hosts-v1";

// One host per workspace: the computer that runs its schedules and
// Group-message automations. `generation` rises on every change.
// `handover_from` names the computer still running them after the owner
// chose another. `released_through_ms` is the latest time any computer
// that handed over reported when it stopped; it stays through later
// handovers and never goes back.
//
// The owner's computers, as each last checked in. The relay keeps a bounded
// list per workspace and forgets the computer seen longest ago.
const AUTOMATION_HOST_SCHEMA = {
  [AUTOMATION_HOSTS]: `CREATE TABLE sync_relay_automation_hosts (
  workspace_id TEXT NOT NULL PRIMARY KEY
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 1 AND 256),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  handover_from TEXT CHECK (handover_from IS NULL OR length(handover_from) BETWEEN 1 AND 256),
  released_through_ms INTEGER
    CHECK (released_through_ms IS NULL OR released_through_ms BETWEEN 0 AND 9007199254740991),
  CHECK (handover_from IS NULL OR handover_from <> install_id)
) STRICT`,
  [AUTOMATION_COMPUTERS]: `CREATE TABLE sync_relay_automation_computers (
  workspace_id TEXT NOT NULL
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 1 AND 256),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  last_seen_ms INTEGER NOT NULL CHECK (last_seen_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, install_id)
) STRICT`,
} as const;

function sameSql(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/;$/, "").replace(/\s+/g, " ");
  return normalize(left) === normalize(right);
}

function assertAutomationHostSchema(db: SqliteDb): void {
  const objects = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name IN (?, ?) AND sql IS NOT NULL ORDER BY name")
    .all(AUTOMATION_HOSTS, AUTOMATION_COMPUTERS);
  const expected = Object.keys(AUTOMATION_HOST_SCHEMA).sort();
  if (
    objects.length !== expected.length ||
    objects.some((row, index) => row.name !== expected[index] ||
      typeof row.sql !== "string" ||
      !sameSql(row.sql, AUTOMATION_HOST_SCHEMA[row.name as keyof typeof AUTOMATION_HOST_SCHEMA]))
  ) {
    throw new Error("automation host schema is missing or damaged");
  }
}

export function initializeAutomationHostSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(MARKER);
  if (marked) {
    assertAutomationHostSchema(db);
    return;
  }
  const names = Object.keys(AUTOMATION_HOST_SCHEMA);
  const existing = db
    .prepare(`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(", ")})`)
    .all(...names);
  if (existing.length) throw new Error("unmarked automation host schema already exists");
  for (const sql of Object.values(AUTOMATION_HOST_SCHEMA)) db.exec(sql);
  assertAutomationHostSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
    .run(MARKER, Date.now());
}
