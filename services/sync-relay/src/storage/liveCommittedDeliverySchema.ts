import type { SqliteDb } from "./types";
import { HOST_CONTROL_IDENTIFIER_MAX_BYTES } from "@dohc/live-session-contract/host-control";

export const LIVE_DELIVERY_BOOTSTRAPS = "sync_relay_live_delivery_bootstraps";
export const LIVE_DELIVERY_EDGES = "sync_relay_live_delivery_edges";
export const LIVE_DELIVERY_HOSTS = "sync_relay_live_delivery_hosts";
export const LIVE_DELIVERY_RESERVATIONS = "sync_relay_live_delivery_reservations";
export const LIVE_DELIVERY_DOCUMENTS = "sync_relay_live_delivery_documents";
export const LIVE_DELIVERY_OWNERS = "sync_relay_live_delivery_owners";
const MARKER = "live-committed-delivery-v1";
const SAFE = 9_007_199_254_740_991;
const identifier = (name: string) =>
  `${name} TEXT NOT NULL CHECK (length(CAST(${name} AS BLOB)) BETWEEN 1 AND 512)`;
const hostIdentifier = (name: string) =>
  `${name} TEXT NOT NULL CHECK (length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${HOST_CONTROL_IDENTIFIER_MAX_BYTES})`;
const integer = (name: string, minimum = 0) =>
  `${name} INTEGER NOT NULL CHECK (${name} BETWEEN ${minimum} AND ${SAFE})`;
const digest = (name: string) =>
  `${name} TEXT NOT NULL CHECK (length(${name})=64 AND ${name} NOT GLOB '*[^0-9a-f]*')`;
const objects = {
  [LIVE_DELIVERY_OWNERS]: `CREATE TABLE ${LIVE_DELIVERY_OWNERS} (
    ${identifier("relay_database_namespace")}, ${identifier("workspace_id")},
    main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    ${identifier("object_id")}, ${digest("lineage_claim_id")}, ${hostIdentifier("host_id")},
    origin_json TEXT NOT NULL CHECK (json_valid(origin_json)),
    tip_receipt_json TEXT NOT NULL CHECK (json_valid(tip_receipt_json)),
    ${integer("tip_cursor")}, ${integer("tip_sequence")}, ${integer("tip_application_sequence")}, ${integer("accounted_bytes",1)},
    CHECK (tip_application_sequence <= tip_sequence),
    PRIMARY KEY (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id),
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id) REFERENCES ${LIVE_DELIVERY_DOCUMENTS}(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE,
    FOREIGN KEY (host_id,workspace_id) REFERENCES ${LIVE_DELIVERY_HOSTS}(host_id,workspace_id)
  ) STRICT`,
  [LIVE_DELIVERY_HOSTS]: `CREATE TABLE ${LIVE_DELIVERY_HOSTS} (
    ${hostIdentifier("host_id")}, ${identifier("workspace_id")},
    history_namespace TEXT CHECK (length(CAST(history_namespace AS BLOB)) BETWEEN 1 AND 512),
    ${integer("funded_document_sequence")}, ${integer("funded_journal_cursor")},
    ${integer("accounted_bytes", 1)},
    PRIMARY KEY (host_id,workspace_id),
    FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
  ) STRICT`,
  [LIVE_DELIVERY_DOCUMENTS]: `CREATE TABLE ${LIVE_DELIVERY_DOCUMENTS} (
    registration_sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK (registration_sequence BETWEEN 1 AND ${SAFE}),
    ${identifier("workspace_id")}, main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    ${identifier("object_id")}, ${digest("lineage_claim_id")},
    ${integer("accounted_bytes", 1)},
    UNIQUE (workspace_id,main_version_id,object_id,lineage_claim_id),
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id) REFERENCES sync_relay_live_documents(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
  ) STRICT`,
  [LIVE_DELIVERY_RESERVATIONS]: `CREATE TABLE ${LIVE_DELIVERY_RESERVATIONS} (
    ${identifier("workspace_id")}, main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    ${identifier("object_id")}, ${digest("lineage_claim_id")}, ${hostIdentifier("host_id")},
    ${integer("journal_cursor")}, ${integer("reserved_bytes", 1)},
    ${integer("accounted_bytes", 1)},
    PRIMARY KEY (workspace_id,main_version_id,object_id,lineage_claim_id,host_id,journal_cursor),
    FOREIGN KEY (workspace_id,main_version_id,object_id,lineage_claim_id) REFERENCES ${LIVE_DELIVERY_DOCUMENTS}(workspace_id,main_version_id,object_id,lineage_claim_id) ON DELETE CASCADE,
    FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    FOREIGN KEY (host_id,workspace_id) REFERENCES ${LIVE_DELIVERY_HOSTS}(host_id,workspace_id)
  ) STRICT`,
  [LIVE_DELIVERY_BOOTSTRAPS]: `CREATE TABLE ${LIVE_DELIVERY_BOOTSTRAPS} (
    ${identifier("bootstrap_id")}, ${identifier("bootstrap_moment_id")},
    ${identifier("relay_database_namespace")}, ${identifier("workspace_id")},
    main_version_id TEXT NOT NULL CHECK (main_version_id='main'),
    ${identifier("object_id")}, ${digest("lineage_claim_id")}, ${hostIdentifier("host_id")},
    binding_json TEXT NOT NULL CHECK (length(CAST(binding_json AS BLOB)) BETWEEN 2 AND 1048576),
    ${integer("baseline_moment_relay_seq", 1)}, ${integer("baseline_registered_at_ms")},
    ${digest("baseline_digest")}, baseline_byte_length INTEGER NOT NULL CHECK (baseline_byte_length BETWEEN 1 AND 20971520),
    ${digest("projected_markdown_digest")}, projected_markdown_byte_length INTEGER NOT NULL CHECK (projected_markdown_byte_length BETWEEN 0 AND 2097152),
    local_ydoc_sequence INTEGER CHECK (local_ydoc_sequence BETWEEN 0 AND ${SAFE}),
    ack_host_mode TEXT CHECK (ack_host_mode IN ('service','device')),
    ack_host_epoch INTEGER CHECK (ack_host_epoch BETWEEN 1 AND ${SAFE}),
    ack_instance_id TEXT CHECK (length(CAST(ack_instance_id AS BLOB)) BETWEEN 1 AND ${HOST_CONTROL_IDENTIFIER_MAX_BYTES}),
    ack_connection_id TEXT CHECK (length(CAST(ack_connection_id AS BLOB)) BETWEEN 1 AND ${HOST_CONTROL_IDENTIFIER_MAX_BYTES}),
    ${integer("accounted_bytes", 1)},
    PRIMARY KEY (bootstrap_id),
    UNIQUE (bootstrap_id,workspace_id),
    UNIQUE (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id,host_id),
    UNIQUE (workspace_id,bootstrap_moment_id),
    FOREIGN KEY (workspace_id) REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
    CHECK (baseline_digest=lineage_claim_id),
    CHECK ((local_ydoc_sequence IS NULL AND ack_host_mode IS NULL AND ack_host_epoch IS NULL AND ack_instance_id IS NULL AND ack_connection_id IS NULL)
      OR (local_ydoc_sequence IS NOT NULL AND ack_host_mode IS NOT NULL AND ack_host_epoch IS NOT NULL AND ack_instance_id IS NOT NULL AND ack_connection_id IS NOT NULL))
  ) STRICT`,
  [LIVE_DELIVERY_EDGES]: `CREATE TABLE ${LIVE_DELIVERY_EDGES} (
    ${identifier("bootstrap_id")}, ${identifier("workspace_id")},
    ${integer("journal_cursor", 1)}, ${integer("predecessor_cursor")},
    ${identifier("delivery_id")}, ${digest("update_digest")},
    ${integer("accepting_host_epoch", 1)}, ${integer("local_ydoc_sequence", 1)},
    ack_host_mode TEXT NOT NULL CHECK (ack_host_mode IN ('service','device')),
    ${integer("ack_host_epoch", 1)}, ${hostIdentifier("ack_instance_id")}, ${hostIdentifier("ack_connection_id")},
    ${integer("accounted_bytes", 1)},
    PRIMARY KEY (bootstrap_id,journal_cursor),
    UNIQUE (bootstrap_id,predecessor_cursor),
    FOREIGN KEY (bootstrap_id,workspace_id) REFERENCES ${LIVE_DELIVERY_BOOTSTRAPS}(bootstrap_id,workspace_id) ON DELETE CASCADE,
    CHECK (predecessor_cursor < journal_cursor)
  ) STRICT`,
};
const normalized = (sql: string) =>
  sql.trim().replace(/;$/, "").replace(/\s+/g, " ");

function assertSchema(db: SqliteDb): void {
  for (const [name, sql] of Object.entries(objects)) {
    const row = db
      .prepare("SELECT type,sql FROM sqlite_schema WHERE name=?")
      .get(name);
    if (
      row?.type !== "table" ||
      typeof row.sql !== "string" ||
      normalized(row.sql) !== normalized(sql)
    ) {
      throw new Error("Live committed delivery schema is damaged.");
    }
  }
  for (const [table, expectedCount] of [
    [LIVE_DELIVERY_HOSTS, 1],
    [LIVE_DELIVERY_OWNERS, 1],
    [LIVE_DELIVERY_DOCUMENTS, 1],
    [LIVE_DELIVERY_RESERVATIONS, 1],
    [LIVE_DELIVERY_BOOTSTRAPS, 4],
    [LIVE_DELIVERY_EDGES, 2],
  ] as const) {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all();
    if (
      indexes.length !== expectedCount ||
      indexes.some(
        (row) =>
          row.unique !== 1 ||
          row.partial !== 0 ||
          (row.origin !== "pk" && row.origin !== "u"),
      )
    ) {
      throw new Error("Live committed delivery index is damaged.");
    }
  }
  for (const table of Object.keys(objects)) {
    if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length) {
      throw new Error("Live committed delivery parent is damaged.");
    }
  }
}

export function initializeLiveCommittedDeliverySchema(db: SqliteDb): void {
  const marked = db
    .prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?")
    .get(MARKER);
  if (marked) {
    assertSchema(db);
    return;
  }
  const names = Object.keys(objects);
  if (
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE name IN (${names.map(() => "?").join(",")})`)
      .all(...names).length
  ) {
    throw new Error("Unmarked live committed delivery schema already exists.");
  }
  for (const sql of Object.values(objects)) db.exec(sql);
  assertSchema(db);
  db.prepare(
    "INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)",
  ).run(MARKER, Date.now());
}
