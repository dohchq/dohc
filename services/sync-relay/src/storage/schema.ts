import { initializeAppPublicationSchema } from "./publicationSchema";
import { initializeAppCollectionSchema } from "./appCollectionSchema";
import { initializeLiveCommittedDeliverySchema } from "./liveCommittedDeliverySchema";
import { initializeServiceActivationSchema } from "./serviceActivationSchema";
import { initializeServiceHostEnrollmentSchema } from "./serviceHostEnrollment";
import { initializeLiveRestoreOperationSchema } from "./liveRestoreOperationSchema";
import { initializeNoticeSchema, initializeShareNoticeDeliverySchema } from "./noticeSchema";
import { initializeAutomationHostSchema } from "./automationHostSchema";
import { initializeAutomationGroupHandoverSchema } from "./automationHosts";
import { initializeCollectionWriteSchema } from "./collectionWrites";
import { initializeAutomationPressSchema } from "./automationPresses";
import { initializeCurrentFileKeySchema } from "./currentFiles";
import {
  LINK_DISCUSSION_NAME_CODE_POINT_LIMIT,
  LINK_DISCUSSION_NAME_BYTE_LIMIT,
  LINK_DISCUSSION_BODY_CODE_POINT_LIMIT,
  LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT,
} from "./limits";
import type { SqliteDb } from "./types";

const NORMALIZED_SHARE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sync_relay_shares (
    share_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    granter_user_id TEXT NOT NULL,
    selector_json TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    link_writes_paused_at_ms INTEGER,
    discussion_revision INTEGER NOT NULL DEFAULT 0 CHECK (discussion_revision >= 0),
    FOREIGN KEY (workspace_id)
      REFERENCES sync_relay_workspaces(workspace_id)
      ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_shares_granter
    ON sync_relay_shares(granter_user_id, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_shares_workspace
    ON sync_relay_shares(workspace_id, created_at_ms, share_id);

  CREATE TABLE IF NOT EXISTS sync_relay_share_grants (
    grant_id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'email', 'link')),
    principal_user_id TEXT,
    principal_email TEXT,
    access TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at_ms INTEGER NOT NULL,
    revoked_at_ms INTEGER,
    parent_grant_id TEXT,
    CHECK (
      (principal_kind = 'user' AND principal_user_id IS NOT NULL AND principal_email IS NULL)
      OR
      (principal_kind = 'email' AND principal_user_id IS NULL AND principal_email IS NOT NULL)
      OR
      (principal_kind = 'link' AND principal_user_id IS NULL AND principal_email IS NULL)
    ),
    CHECK (
      (status = 'active' AND revoked_at_ms IS NULL)
      OR
      (status = 'revoked' AND revoked_at_ms IS NOT NULL)
    ),
    CHECK (parent_grant_id IS NULL OR principal_kind = 'user'),
    FOREIGN KEY (share_id)
      REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_grant_id)
      REFERENCES sync_relay_share_grants(grant_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_share
    ON sync_relay_share_grants(share_id, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_restore_page
    ON sync_relay_share_grants(share_id, created_at_ms, grant_id);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_user
    ON sync_relay_share_grants(principal_user_id, created_at_ms);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_grants_email
    ON sync_relay_share_grants(principal_email, created_at_ms);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_share_grants_grant_share
    ON sync_relay_share_grants(grant_id, share_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_share_grants_active_dependent
    ON sync_relay_share_grants(parent_grant_id, principal_user_id)
    WHERE status = 'active' AND parent_grant_id IS NOT NULL;

  CREATE TABLE IF NOT EXISTS sync_relay_share_removals (
    undo_id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    grants_json TEXT NOT NULL,
    credentials_json TEXT NOT NULL,
    proposals_json TEXT NOT NULL,
    removed_grant_id TEXT,
    undone INTEGER NOT NULL DEFAULT 0 CHECK (undone IN (0, 1)),
    voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1)),
    FOREIGN KEY (share_id) REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_removals_expiry ON sync_relay_share_removals(expires_at_ms);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_removals_share ON sync_relay_share_removals(share_id, removed_grant_id, expires_at_ms);

  CREATE TABLE IF NOT EXISTS sync_relay_link_credentials (
    credential_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    minted_at_ms INTEGER NOT NULL,
    retired_at_ms INTEGER,
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_link_credentials_current
    ON sync_relay_link_credentials(grant_id)
    WHERE retired_at_ms IS NULL;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_credentials_hash
    ON sync_relay_link_credentials(secret_hash);

  CREATE TABLE IF NOT EXISTS sync_relay_link_usage (
    grant_id TEXT PRIMARY KEY,
    last_used_at_ms INTEGER NOT NULL CHECK (last_used_at_ms >= 0),
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sync_relay_link_principals (
    principal_id TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    mint_generation INTEGER NOT NULL CHECK (mint_generation >= 1),
    profile_token_hash TEXT NOT NULL CHECK (length(profile_token_hash) > 0),
    display_name TEXT CHECK (
      display_name IS NULL OR (
        length(display_name) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT}
        AND length(CAST(display_name AS BLOB)) <= ${LINK_DISCUSSION_NAME_BYTE_LIMIT}
      )
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    blocked_at_ms INTEGER,
    discussion_revision INTEGER NOT NULL DEFAULT 0 CHECK (discussion_revision >= 0),
    storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
    UNIQUE (grant_id, profile_token_hash),
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_principals_budget
    ON sync_relay_link_principals(grant_id, mint_generation, created_at_ms, principal_id);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_principals_activity
    ON sync_relay_link_principals(grant_id, discussion_revision);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_link_principals_principal_grant
    ON sync_relay_link_principals(principal_id, grant_id);

  CREATE TABLE IF NOT EXISTS sync_relay_link_sessions (
    session_id TEXT PRIMARY KEY,
    capability_hash TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    minted_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    principal_id TEXT,
    CHECK (expires_at_ms > minted_at_ms),
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
    FOREIGN KEY (principal_id, grant_id)
      REFERENCES sync_relay_link_principals(principal_id, grant_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_sessions_grant
    ON sync_relay_link_sessions(grant_id, generation, expires_at_ms);

  CREATE TABLE IF NOT EXISTS sync_relay_share_discussion_messages (
    message_id TEXT PRIMARY KEY,
    share_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 64),
    request_hash TEXT NOT NULL CHECK (length(request_hash) > 0),
    author_kind TEXT NOT NULL CHECK (author_kind IN ('owner', 'named', 'link')),
    author_user_id TEXT,
    link_grant_id TEXT,
    link_principal_id TEXT,
    display_name_snapshot TEXT NOT NULL CHECK (
      length(display_name_snapshot) BETWEEN 1 AND ${LINK_DISCUSSION_NAME_CODE_POINT_LIMIT}
      AND length(CAST(display_name_snapshot AS BLOB)) <= ${LINK_DISCUSSION_NAME_BYTE_LIMIT}
    ),
    body TEXT CHECK (
      body IS NULL OR (
        length(body) BETWEEN 1 AND ${LINK_DISCUSSION_BODY_CODE_POINT_LIMIT}
        AND length(CAST(body AS BLOB)) <= ${LINK_DISCUSSION_BODY_INPUT_BYTE_LIMIT}
        AND instr(body, char(0)) = 0
      )
    ),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    deleted_at_ms INTEGER,
    deleted_by_user_id TEXT,
    discussion_revision INTEGER NOT NULL DEFAULT 0 CHECK (discussion_revision >= 0),
    storage_bytes INTEGER NOT NULL CHECK (storage_bytes > 0),
    CHECK (
      (author_kind IN ('owner', 'named')
       AND author_user_id IS NOT NULL
       AND link_grant_id IS NULL
       AND link_principal_id IS NULL)
      OR
      (author_kind = 'link'
       AND author_user_id IS NULL
       AND link_grant_id IS NOT NULL
       AND link_principal_id IS NOT NULL)
    ),
    CHECK (
      (deleted_at_ms IS NULL AND deleted_by_user_id IS NULL AND body IS NOT NULL)
      OR
      (deleted_at_ms IS NOT NULL AND deleted_by_user_id IS NOT NULL AND body IS NULL)
    ),
    FOREIGN KEY (share_id)
      REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
    FOREIGN KEY (link_grant_id, share_id)
      REFERENCES sync_relay_share_grants(grant_id, share_id) ON DELETE CASCADE,
    FOREIGN KEY (link_principal_id, link_grant_id)
      REFERENCES sync_relay_link_principals(principal_id, grant_id) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_page
    ON sync_relay_share_discussion_messages(share_id, created_at_ms, message_id);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_activity
    ON sync_relay_share_discussion_messages(share_id, discussion_revision);
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_principal_budget
    ON sync_relay_share_discussion_messages(
      link_principal_id, created_at_ms, message_id
    ) WHERE author_kind = 'link';
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_named_budget
    ON sync_relay_share_discussion_messages(
      share_id, author_user_id, created_at_ms, message_id
    ) WHERE author_kind = 'named';
  CREATE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_non_owner_budget
    ON sync_relay_share_discussion_messages(share_id, author_kind, message_id)
    WHERE author_kind IN ('named', 'link');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_user_replay
    ON sync_relay_share_discussion_messages(share_id, author_user_id, idempotency_key)
    WHERE author_kind IN ('owner', 'named');
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_relay_share_discussion_link_replay
    ON sync_relay_share_discussion_messages(
      share_id, link_principal_id, idempotency_key
    ) WHERE author_kind = 'link';

  CREATE TABLE IF NOT EXISTS sync_relay_link_handoff_codes (
    code_id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    grant_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    minted_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    result_grant_id TEXT,
    CHECK (expires_at_ms > minted_at_ms),
    FOREIGN KEY (grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE,
    FOREIGN KEY (result_grant_id)
      REFERENCES sync_relay_share_grants(grant_id) ON DELETE CASCADE
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE INDEX IF NOT EXISTS idx_sync_relay_link_handoff_codes_grant
    ON sync_relay_link_handoff_codes(grant_id, minted_at_ms);
`;

const SESSION_HOST_CONTROL_MIGRATION_ID = "session-host-control-v1";
export const SESSION_HOST_CONTROL_TABLE = "sync_relay_session_host_control";
const SESSION_HOST_CONTROL_COLUMNS = [
  "singleton_id",
  "configured_mode",
  "configured_host_id",
  "host_epoch",
  "transition_generation",
  "admission_state",
  "registered_instance_id",
  "registered_connection_id",
  "transition_phase",
  "transition_id",
  "transition_from_mode",
  "transition_from_host_id",
  "transition_from_instance_id",
  "transition_from_connection_id",
  "transition_from_epoch",
  "transition_to_mode",
  "transition_to_host_id",
  "transition_started_at_ms",
  "last_completed_transition_id",
  "updated_at_ms",
] as const;

const SESSION_HOST_CONTROL_SCHEMA_SQL = `
CREATE TABLE sync_relay_session_host_control (
  singleton_id INTEGER NOT NULL PRIMARY KEY CHECK (singleton_id = 1),
  configured_mode TEXT NOT NULL
    CHECK (configured_mode IN ('device', 'service')),
  configured_host_id TEXT NOT NULL
    CHECK (length(CAST(configured_host_id AS BLOB)) BETWEEN 1 AND 1024),
  host_epoch INTEGER NOT NULL
    CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
  transition_generation INTEGER NOT NULL
    CHECK (transition_generation BETWEEN 0 AND 9007199254740991),
  admission_state TEXT NOT NULL
    CHECK (admission_state IN ('closed', 'open', 'draining')),
  registered_instance_id TEXT
    CHECK (
      registered_instance_id IS NULL OR
      length(CAST(registered_instance_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  registered_connection_id TEXT
    CHECK (
      registered_connection_id IS NULL OR
      length(CAST(registered_connection_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  transition_phase TEXT
    CHECK (transition_phase IN ('draining', 'activating')),
  transition_id TEXT
    CHECK (
      transition_id IS NULL OR
      length(CAST(transition_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  transition_from_mode TEXT
    CHECK (transition_from_mode IN ('device', 'service')),
  transition_from_host_id TEXT
    CHECK (
      transition_from_host_id IS NULL OR
      length(CAST(transition_from_host_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  transition_from_instance_id TEXT
    CHECK (
      transition_from_instance_id IS NULL OR
      length(CAST(transition_from_instance_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  transition_from_connection_id TEXT
    CHECK (
      transition_from_connection_id IS NULL OR
      length(CAST(transition_from_connection_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  transition_from_epoch INTEGER
    CHECK (
      transition_from_epoch IS NULL OR
      transition_from_epoch BETWEEN 1 AND 9007199254740991
    ),
  transition_to_mode TEXT
    CHECK (transition_to_mode IN ('device', 'service')),
  transition_to_host_id TEXT
    CHECK (
      transition_to_host_id IS NULL OR
      length(CAST(transition_to_host_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  transition_started_at_ms INTEGER
    CHECK (
      transition_started_at_ms IS NULL OR
      transition_started_at_ms BETWEEN 0 AND 9007199254740991
    ),
  last_completed_transition_id TEXT
    CHECK (
      last_completed_transition_id IS NULL OR
      length(CAST(last_completed_transition_id AS BLOB)) BETWEEN 1 AND 1024
    ),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms BETWEEN 0 AND 9007199254740991),
  CHECK (
    admission_state <> 'open' OR
    (registered_instance_id IS NOT NULL AND registered_connection_id IS NOT NULL)
  ),
  CHECK (
    registered_connection_id IS NULL OR registered_instance_id IS NOT NULL
  ),
  CHECK (
    admission_state <> 'closed' OR registered_connection_id IS NULL
  ),
  CHECK (
    last_completed_transition_id IS NULL OR transition_generation >= 1
  ),
  CHECK (
    (
      transition_phase IS NULL AND
      transition_id IS NULL AND
      transition_from_mode IS NULL AND
      transition_from_host_id IS NULL AND
      transition_from_instance_id IS NULL AND
      transition_from_connection_id IS NULL AND
      transition_from_epoch IS NULL AND
      transition_to_mode IS NULL AND
      transition_to_host_id IS NULL AND
      transition_started_at_ms IS NULL AND
      admission_state IN ('closed', 'open') AND
      (admission_state = 'open' OR last_completed_transition_id IS NULL)
    ) OR (
      transition_phase = 'draining' AND
      admission_state = 'draining' AND
      transition_generation >= 1 AND
      last_completed_transition_id IS NULL AND
      transition_id IS NOT NULL AND
      transition_from_mode IS NOT NULL AND
      transition_from_host_id IS NOT NULL AND
      transition_from_instance_id IS NOT NULL AND
      transition_from_connection_id IS NOT NULL AND
      transition_from_epoch IS NOT NULL AND
      transition_to_mode IS NOT NULL AND
      transition_to_host_id IS NOT NULL AND
      transition_started_at_ms IS NOT NULL AND
      configured_mode = transition_from_mode AND
      configured_host_id = transition_from_host_id AND
      registered_instance_id = transition_from_instance_id AND
      registered_connection_id = transition_from_connection_id AND
      host_epoch = transition_from_epoch AND
      transition_to_mode <> transition_from_mode
    ) OR (
      transition_phase = 'activating' AND
      admission_state = 'closed' AND
      transition_generation >= 1 AND
      last_completed_transition_id IS NULL AND
      transition_id IS NOT NULL AND
      transition_from_mode IS NOT NULL AND
      transition_from_host_id IS NOT NULL AND
      transition_from_instance_id IS NOT NULL AND
      transition_from_connection_id IS NOT NULL AND
      transition_from_epoch IS NOT NULL AND
      transition_to_mode IS NOT NULL AND
      transition_to_host_id IS NOT NULL AND
      transition_started_at_ms IS NOT NULL AND
      configured_mode = transition_to_mode AND
      configured_host_id = transition_to_host_id AND
      registered_instance_id IS NULL AND
      registered_connection_id IS NULL AND
      host_epoch = transition_from_epoch + 1 AND
      transition_to_mode <> transition_from_mode
    )
  )
) STRICT;
`;

function normalizedSchemaSql(value: string): string {
  // Preserve quoted values: changing 'main' to 'MAIN' changes the constraint.
  return value.trim().replace(/;$/, "").replace(/\s+/g, " ");
}

function assertSessionHostControlSchema(db: SqliteDb): void {
  const columns = db
    .prepare(`PRAGMA table_info(${SESSION_HOST_CONTROL_TABLE})`)
    .all()
    .map((row) => String(row.name));
  const schema = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(SESSION_HOST_CONTROL_TABLE);
  if (
    columns.join("\u0000") !== SESSION_HOST_CONTROL_COLUMNS.join("\u0000") ||
    typeof schema?.sql !== "string" ||
    normalizedSchemaSql(schema.sql) !== normalizedSchemaSql(SESSION_HOST_CONTROL_SCHEMA_SQL)
  ) {
    throw new Error("session host control schema is missing or damaged");
  }
}

function initializeSessionHostControlSchema(db: SqliteDb): void {
  const marker = db
    .prepare(
      "SELECT EXISTS(SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?) AS complete",
    )
    .get(SESSION_HOST_CONTROL_MIGRATION_ID);
  const existing = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(SESSION_HOST_CONTROL_TABLE);
  const marked = Number(marker?.complete ?? 0) === 1;

  if (marked) {
    if (existing === undefined) {
      throw new Error("session host control migration is marked but its table is missing");
    }
    assertSessionHostControlSchema(db);
    return;
  }
  if (existing !== undefined) {
    throw new Error("unmarked session host control table already exists");
  }

  db.exec(SESSION_HOST_CONTROL_SCHEMA_SQL);
  assertSessionHostControlSchema(db);
  db.prepare(
    "INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)",
  ).run(SESSION_HOST_CONTROL_MIGRATION_ID, Date.now());
}

const LIVE_DOCUMENT_AUTHORITY_MIGRATION_ID = "live-document-authority-v1";
const LIVE_DOCUMENT_AUTHORITY_SCHEMA = {
  sync_relay_live_documents: `
CREATE TABLE sync_relay_live_documents (
  workspace_id TEXT NOT NULL
    CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
  main_version_id TEXT NOT NULL
    CHECK (main_version_id = 'main'),
  object_id TEXT NOT NULL
    CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
  lineage_claim_id TEXT NOT NULL
    CHECK (
      length(lineage_claim_id) = 64 AND
      lineage_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
  replaces_lineage_claim_id TEXT
    CHECK (
      replaces_lineage_claim_id IS NULL OR (
        length(replaces_lineage_claim_id) = 64 AND
        replaces_lineage_claim_id NOT GLOB '*[^0-9a-f]*' AND
        replaces_lineage_claim_id <> lineage_claim_id
      )
    ),
  current_path TEXT NOT NULL
    CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
  baseline_moment_relay_seq INTEGER NOT NULL
    CHECK (baseline_moment_relay_seq BETWEEN 1 AND 9007199254740991),
  baseline_projected_sha256 TEXT NOT NULL
    CHECK (
      length(baseline_projected_sha256) = 64 AND
      baseline_projected_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  baseline_projected_byte_length INTEGER NOT NULL
    CHECK (baseline_projected_byte_length BETWEEN 0 AND 2097152),
  baseline_digest TEXT NOT NULL
    CHECK (
      length(baseline_digest) = 64 AND
      baseline_digest NOT GLOB '*[^0-9a-f]*'
    ),
  baseline_bytes BLOB NOT NULL
    CHECK (length(baseline_bytes) BETWEEN 1 AND 20971520),
  lineage_state TEXT NOT NULL CHECK (lineage_state IN ('current', 'retired')),
  admission_state TEXT NOT NULL CHECK (admission_state IN ('closed', 'open')),
  restore_fence_generation INTEGER NOT NULL
    CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
  registered_at_ms INTEGER NOT NULL
    CHECK (registered_at_ms BETWEEN 0 AND 9007199254740991),
  retired_at_ms INTEGER
    CHECK (retired_at_ms IS NULL OR retired_at_ms BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (workspace_id, main_version_id, object_id, lineage_claim_id),
  CHECK (lineage_claim_id = baseline_digest),
  CHECK (
    (lineage_state = 'current' AND retired_at_ms IS NULL)
    OR
    (lineage_state = 'retired' AND admission_state = 'closed' AND retired_at_ms IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id)
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
  `,
  idx_sync_relay_live_documents_current: `
CREATE UNIQUE INDEX idx_sync_relay_live_documents_current
  ON sync_relay_live_documents(workspace_id, main_version_id, object_id)
  WHERE lineage_state = 'current';
  `,
  sync_relay_live_document_baseline_ranges: `
CREATE TABLE sync_relay_live_document_baseline_ranges (
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  client_id INTEGER NOT NULL
    CHECK (client_id BETWEEN 0 AND 9007199254740991),
  start_clock INTEGER NOT NULL
    CHECK (start_clock BETWEEN 0 AND 4294967294),
  end_clock INTEGER NOT NULL
    CHECK (end_clock BETWEEN 1 AND 4294967295 AND start_clock < end_clock),
  PRIMARY KEY (
    workspace_id, main_version_id, object_id, lineage_claim_id,
    client_id, start_clock
  ),
  FOREIGN KEY (workspace_id, main_version_id, object_id, lineage_claim_id)
    REFERENCES sync_relay_live_documents(
      workspace_id, main_version_id, object_id, lineage_claim_id
    ) ON DELETE CASCADE
) STRICT;
  `,
  idx_sync_relay_live_document_baseline_coverage: `
CREATE INDEX idx_sync_relay_live_document_baseline_coverage
  ON sync_relay_live_document_baseline_ranges(
    workspace_id, main_version_id, object_id, lineage_claim_id,
    client_id, start_clock, end_clock
  );
  `,
} as const;

const LIVE_DOCUMENT_AUTHORITY_COLUMNS = {
  sync_relay_live_documents: [
    ["workspace_id", "TEXT", 1, 1], ["main_version_id", "TEXT", 1, 2],
    ["object_id", "TEXT", 1, 3], ["lineage_claim_id", "TEXT", 1, 4],
    ["replaces_lineage_claim_id", "TEXT", 0, 0], ["current_path", "TEXT", 1, 0],
    ["baseline_moment_relay_seq", "INTEGER", 1, 0], ["baseline_projected_sha256", "TEXT", 1, 0],
    ["baseline_projected_byte_length", "INTEGER", 1, 0], ["baseline_digest", "TEXT", 1, 0],
    ["baseline_bytes", "BLOB", 1, 0], ["lineage_state", "TEXT", 1, 0],
    ["admission_state", "TEXT", 1, 0], ["restore_fence_generation", "INTEGER", 1, 0],
    ["registered_at_ms", "INTEGER", 1, 0], ["retired_at_ms", "INTEGER", 0, 0],
  ],
  sync_relay_live_document_baseline_ranges: [
    ["workspace_id", "TEXT", 1, 1], ["main_version_id", "TEXT", 1, 2],
    ["object_id", "TEXT", 1, 3], ["lineage_claim_id", "TEXT", 1, 4],
    ["client_id", "INTEGER", 1, 5], ["start_clock", "INTEGER", 1, 6],
    ["end_clock", "INTEGER", 1, 0],
  ],
} as const;

function assertLiveDocumentAuthoritySchema(db: SqliteDb): void {
  const fail = (): never => { throw new Error("live document authority schema is missing or damaged"); };
  const same = (actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail();
  };
  for (const [name, sql] of Object.entries(LIVE_DOCUMENT_AUTHORITY_SCHEMA)) {
    const rows = db.prepare("SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?").all(name);
    const row = rows[0];
    const table = name === "sync_relay_live_documents" || name === "idx_sync_relay_live_documents_current"
      ? "sync_relay_live_documents" : "sync_relay_live_document_baseline_ranges";
    if (rows.length !== 1 || !row || row.type !== (name.startsWith("idx_") ? "index" : "table")
      || row.tbl_name !== table || typeof row.sql !== "string" || normalizedSchemaSql(row.sql) !== normalizedSchemaSql(sql)) fail();
  }
  const documentKey = ["workspace_id", "main_version_id", "object_id", "lineage_claim_id"];
  for (const [table, columns] of Object.entries(LIVE_DOCUMENT_AUTHORITY_COLUMNS)) {
    same(db.prepare(`PRAGMA table_info(${table})`).all().map(row =>
      [row.cid, row.name, row.type, row.notnull, row.dflt_value, row.pk]),
    columns.map(([name, type, notnull, pk], cid) => [cid, name, type, notnull, null, pk]));
    const parent = table === "sync_relay_live_documents" ? "sync_relay_workspaces" : "sync_relay_live_documents";
    const foreignColumns = table === "sync_relay_live_documents" ? ["workspace_id"] : documentKey;
    same(db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(row =>
      [row.id, row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match]),
    foreignColumns.map((name, seq) => [0, seq, parent, name, name, "NO ACTION", "CASCADE", "NONE"]));
    const namedIndex = table === "sync_relay_live_documents"
      ? "idx_sync_relay_live_documents_current" : "idx_sync_relay_live_document_baseline_coverage";
    const primaryColumns = table === "sync_relay_live_documents" ? documentKey : [...documentKey, "client_id", "start_clock"];
    const indexedColumns = table === "sync_relay_live_documents"
      ? documentKey.slice(0, 3) : [...documentKey, "client_id", "start_clock", "end_clock"];
    const expectedIndexes = [
      [namedIndex, table === "sync_relay_live_documents" ? 1 : 0, "c", table === "sync_relay_live_documents" ? 1 : 0],
      [`sqlite_autoindex_${table}_1`, 1, "pk", 0],
    ];
    const orderIndexes = (rows: unknown[][]): unknown[][] => rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    same(orderIndexes(db.prepare(`PRAGMA index_list(${table})`).all().map(row =>
      [row.name, row.unique, row.origin, row.partial])), orderIndexes(expectedIndexes));
    for (const [name, indexColumns] of [[namedIndex, indexedColumns], [`sqlite_autoindex_${table}_1`, primaryColumns]] as const) {
      same(db.prepare(`PRAGMA index_info(${name})`).all().map(row => [row.seqno, row.cid, row.name]),
        indexColumns.map((column, seq) => [seq, columns.findIndex(entry => entry[0] === column), column]));
    }
  }
}

function initializeLiveDocumentAuthoritySchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?")
    .get(LIVE_DOCUMENT_AUTHORITY_MIGRATION_ID) !== undefined;
  const existing = db.prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?, ?)")
    .all(...Object.keys(LIVE_DOCUMENT_AUTHORITY_SCHEMA));
  if (marked) {
    assertLiveDocumentAuthoritySchema(db);
    return;
  }
  if (existing.length > 0) throw new Error("unmarked live document authority schema already exists");
  for (const sql of Object.values(LIVE_DOCUMENT_AUTHORITY_SCHEMA)) db.exec(sql);
  assertLiveDocumentAuthoritySchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
    .run(LIVE_DOCUMENT_AUTHORITY_MIGRATION_ID, Date.now());
}

const LIVE_JOURNAL_MARKER = "live-update-journal-v1";
export const LIVE_JOURNAL_TABLE = "sync_relay_live_update_journal";
export const LIVE_JOURNAL_PROVENANCE = "sync_relay_live_update_struct_provenance";
const LIVE_JOURNAL_SCHEMA = {
  sync_relay_live_update_journal: `
CREATE TABLE sync_relay_live_update_journal (
  journal_cursor INTEGER PRIMARY KEY AUTOINCREMENT
    CHECK (journal_cursor BETWEEN 1 AND 9007199254740991),
  delivery_id TEXT NOT NULL UNIQUE
    CHECK (length(CAST(delivery_id AS BLOB)) BETWEEN 1 AND 512),
  update_digest TEXT NOT NULL
    CHECK (
      length(update_digest) = 64 AND
      update_digest NOT GLOB '*[^0-9a-f]*'
    ),
  workspace_id TEXT NOT NULL
    CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
  main_version_id TEXT NOT NULL
    CHECK (main_version_id = 'main'),
  object_id TEXT NOT NULL
    CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
  lineage_claim_id TEXT NOT NULL
    CHECK (
      length(lineage_claim_id) = 64 AND
      lineage_claim_id NOT GLOB '*[^0-9a-f]*'
    ),
  current_path TEXT NOT NULL
    CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
  selector_paths_json TEXT NOT NULL
    CHECK (length(CAST(selector_paths_json AS BLOB)) BETWEEN 5 AND 205101),
  restore_fence_generation INTEGER NOT NULL
    CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
  principal_kind TEXT NOT NULL
    CHECK (principal_kind IN ('owner', 'named', 'link')),
  principal_id TEXT NOT NULL
    CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
  grant_id TEXT
    CHECK (
      grant_id IS NULL OR
      length(CAST(grant_id AS BLOB)) BETWEEN 1 AND 512
    ),
  grant_generation INTEGER
    CHECK (
      grant_generation IS NULL OR
      grant_generation BETWEEN 1 AND 9007199254740991
    ),
  accepting_host_epoch INTEGER NOT NULL
    CHECK (accepting_host_epoch BETWEEN 1 AND 9007199254740991),
  received_at_ms INTEGER NOT NULL
    CHECK (received_at_ms BETWEEN 0 AND 9007199254740991),
  update_bytes BLOB NOT NULL
    CHECK (length(update_bytes) BETWEEN 1 AND 20971520),
  validation_checkpoint_sha256 TEXT
    CHECK (
      validation_checkpoint_sha256 IS NULL OR (
        length(validation_checkpoint_sha256) = 64 AND
        validation_checkpoint_sha256 NOT GLOB '*[^0-9a-f]*'
      )
    ),
  validation_checkpoint_bytes BLOB
    CHECK (
      validation_checkpoint_bytes IS NULL OR
      length(validation_checkpoint_bytes) BETWEEN 1 AND 20971520
    ),
  relay_database_namespace TEXT NOT NULL
    CHECK (length(CAST(relay_database_namespace AS BLOB)) BETWEEN 1 AND 512),
  accepted_event_count INTEGER NOT NULL
    CHECK (accepted_event_count BETWEEN 1 AND 9007199254740991),
  accepted_evidence_digest TEXT NOT NULL
    CHECK (length(accepted_evidence_digest) = 64 AND accepted_evidence_digest NOT GLOB '*[^0-9a-f]*'),
  accepted_metadata_bytes INTEGER NOT NULL CHECK (accepted_metadata_bytes > 0),
  restore_operation_id TEXT CHECK (length(CAST(restore_operation_id AS BLOB)) BETWEEN 1 AND 512),
  CHECK (restore_operation_id IS NULL OR validation_checkpoint_bytes IS NOT NULL),
  UNIQUE (
    journal_cursor,
    workspace_id, main_version_id, object_id, lineage_claim_id
  ),
  CHECK (
    (principal_kind = 'owner' AND grant_id IS NULL AND grant_generation IS NULL)
    OR
    (principal_kind IN ('named', 'link') AND grant_id IS NOT NULL AND grant_generation IS NOT NULL)
  ),
  CHECK (
    (validation_checkpoint_sha256 IS NULL AND validation_checkpoint_bytes IS NULL)
    OR
    (validation_checkpoint_sha256 IS NOT NULL AND validation_checkpoint_bytes IS NOT NULL)
  ),
  FOREIGN KEY (workspace_id)
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (relay_database_namespace,restore_operation_id)
    REFERENCES sync_relay_live_restore_operations(relay_database_namespace,operation_id) ON DELETE NO ACTION
) STRICT;
`,
  idx_sync_relay_live_update_journal_restore: `
CREATE UNIQUE INDEX idx_sync_relay_live_update_journal_restore
  ON sync_relay_live_update_journal(relay_database_namespace,restore_operation_id)
  WHERE restore_operation_id IS NOT NULL;
`,
  idx_sync_relay_live_update_journal_document: `
CREATE INDEX idx_sync_relay_live_update_journal_document
  ON sync_relay_live_update_journal(
    workspace_id, main_version_id, object_id, lineage_claim_id, journal_cursor
  );
`,
  idx_sync_relay_live_update_journal_checkpoint: `
CREATE INDEX idx_sync_relay_live_update_journal_checkpoint
  ON sync_relay_live_update_journal(
    workspace_id, main_version_id, object_id, lineage_claim_id, journal_cursor
  ) WHERE validation_checkpoint_bytes IS NOT NULL;
`,
  sync_relay_live_update_struct_provenance: `
CREATE TABLE sync_relay_live_update_struct_provenance (
  workspace_id TEXT NOT NULL,
  main_version_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  lineage_claim_id TEXT NOT NULL,
  client_id INTEGER NOT NULL
    CHECK (client_id BETWEEN 0 AND 9007199254740991),
  start_clock INTEGER NOT NULL
    CHECK (start_clock BETWEEN 0 AND 4294967294),
  end_clock INTEGER NOT NULL
    CHECK (end_clock BETWEEN 1 AND 4294967295 AND start_clock < end_clock),
  journal_cursor INTEGER NOT NULL
    CHECK (journal_cursor BETWEEN 1 AND 9007199254740991),
  PRIMARY KEY (
    workspace_id, main_version_id, object_id, lineage_claim_id,
    client_id, start_clock
  ),
  FOREIGN KEY (
    journal_cursor,
    workspace_id, main_version_id, object_id, lineage_claim_id
  ) REFERENCES sync_relay_live_update_journal(
    journal_cursor,
    workspace_id, main_version_id, object_id, lineage_claim_id
  ) ON DELETE CASCADE
) STRICT;
`,
  idx_sync_relay_live_update_struct_provenance_coverage: `
CREATE INDEX idx_sync_relay_live_update_struct_provenance_coverage
  ON sync_relay_live_update_struct_provenance(
    workspace_id, main_version_id, object_id, lineage_claim_id,
    client_id, start_clock, end_clock, journal_cursor
  );
`,
  idx_sync_relay_live_update_struct_provenance_journal: `
CREATE INDEX idx_sync_relay_live_update_struct_provenance_journal
  ON sync_relay_live_update_struct_provenance(
    journal_cursor, client_id, start_clock
  );
`,
} as const;
const LIVE_JOURNAL_SHAPE = {
  sync_relay_live_update_journal: {
    columns: [
      [0,"journal_cursor","INTEGER",0,null,1],
      [1,"delivery_id","TEXT",1,null,0],
      [2,"update_digest","TEXT",1,null,0],
      [3,"workspace_id","TEXT",1,null,0],
      [4,"main_version_id","TEXT",1,null,0],
      [5,"object_id","TEXT",1,null,0],
      [6,"lineage_claim_id","TEXT",1,null,0],
      [7,"current_path","TEXT",1,null,0],
      [8,"selector_paths_json","TEXT",1,null,0],
      [9,"restore_fence_generation","INTEGER",1,null,0],
      [10,"principal_kind","TEXT",1,null,0],
      [11,"principal_id","TEXT",1,null,0],
      [12,"grant_id","TEXT",0,null,0],
      [13,"grant_generation","INTEGER",0,null,0],
      [14,"accepting_host_epoch","INTEGER",1,null,0],
      [15,"received_at_ms","INTEGER",1,null,0],
      [16,"update_bytes","BLOB",1,null,0],
      [17,"validation_checkpoint_sha256","TEXT",0,null,0],
      [18,"validation_checkpoint_bytes","BLOB",0,null,0],
      [19,"relay_database_namespace","TEXT",1,null,0],
      [20,"accepted_event_count","INTEGER",1,null,0],
      [21,"accepted_evidence_digest","TEXT",1,null,0],
      [22,"accepted_metadata_bytes","INTEGER",1,null,0],
      [23,"restore_operation_id","TEXT",0,null,0],
    ],
    foreignKeys: [
      [0,0,"sync_relay_live_restore_operations","relay_database_namespace","relay_database_namespace","NO ACTION","NO ACTION","NONE"],
      [0,1,"sync_relay_live_restore_operations","restore_operation_id","operation_id","NO ACTION","NO ACTION","NONE"],
      [1,0,"sync_relay_workspaces","workspace_id","workspace_id","NO ACTION","CASCADE","NONE"],
    ],
    indexes: [
      ["idx_sync_relay_live_update_journal_checkpoint",0,"c",1],
      ["idx_sync_relay_live_update_journal_document",0,"c",0],
      ["idx_sync_relay_live_update_journal_restore",1,"c",1],
      ["sqlite_autoindex_sync_relay_live_update_journal_1",1,"u",0],
      ["sqlite_autoindex_sync_relay_live_update_journal_2",1,"u",0],
    ],
    indexColumns: {
      idx_sync_relay_live_update_journal_checkpoint: [[0,3,"workspace_id"],[1,4,"main_version_id"],[2,5,"object_id"],[3,6,"lineage_claim_id"],[4,0,"journal_cursor"]],
      idx_sync_relay_live_update_journal_document: [[0,3,"workspace_id"],[1,4,"main_version_id"],[2,5,"object_id"],[3,6,"lineage_claim_id"],[4,0,"journal_cursor"]],
      idx_sync_relay_live_update_journal_restore: [[0,19,"relay_database_namespace"],[1,23,"restore_operation_id"]],
      sqlite_autoindex_sync_relay_live_update_journal_1: [[0,1,"delivery_id"]],
      sqlite_autoindex_sync_relay_live_update_journal_2: [[0,0,"journal_cursor"],[1,3,"workspace_id"],[2,4,"main_version_id"],[3,5,"object_id"],[4,6,"lineage_claim_id"]],
    },
  },
  sync_relay_live_update_struct_provenance: {
    columns: [
      [0,"workspace_id","TEXT",1,null,1],
      [1,"main_version_id","TEXT",1,null,2],
      [2,"object_id","TEXT",1,null,3],
      [3,"lineage_claim_id","TEXT",1,null,4],
      [4,"client_id","INTEGER",1,null,5],
      [5,"start_clock","INTEGER",1,null,6],
      [6,"end_clock","INTEGER",1,null,0],
      [7,"journal_cursor","INTEGER",1,null,0],
    ],
    foreignKeys: [
      [0,0,"sync_relay_live_update_journal","journal_cursor","journal_cursor","NO ACTION","CASCADE","NONE"],
      [0,1,"sync_relay_live_update_journal","workspace_id","workspace_id","NO ACTION","CASCADE","NONE"],
      [0,2,"sync_relay_live_update_journal","main_version_id","main_version_id","NO ACTION","CASCADE","NONE"],
      [0,3,"sync_relay_live_update_journal","object_id","object_id","NO ACTION","CASCADE","NONE"],
      [0,4,"sync_relay_live_update_journal","lineage_claim_id","lineage_claim_id","NO ACTION","CASCADE","NONE"],
    ],
    indexes: [
      ["idx_sync_relay_live_update_struct_provenance_coverage",0,"c",0],
      ["idx_sync_relay_live_update_struct_provenance_journal",0,"c",0],
      ["sqlite_autoindex_sync_relay_live_update_struct_provenance_1",1,"pk",0],
    ],
    indexColumns: {
      idx_sync_relay_live_update_struct_provenance_coverage: [[0,0,"workspace_id"],[1,1,"main_version_id"],[2,2,"object_id"],[3,3,"lineage_claim_id"],[4,4,"client_id"],[5,5,"start_clock"],[6,6,"end_clock"],[7,7,"journal_cursor"]],
      idx_sync_relay_live_update_struct_provenance_journal: [[0,7,"journal_cursor"],[1,4,"client_id"],[2,5,"start_clock"]],
      sqlite_autoindex_sync_relay_live_update_struct_provenance_1: [[0,0,"workspace_id"],[1,1,"main_version_id"],[2,2,"object_id"],[3,3,"lineage_claim_id"],[4,4,"client_id"],[5,5,"start_clock"]],
    },
  },
};
function assertLiveJournalSchema(db: SqliteDb): void {
  const same = (actual: unknown, expected: unknown) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("live update journal schema is missing or damaged"); };
  for (const [name, sql] of Object.entries(LIVE_JOURNAL_SCHEMA)) {
    const rows = db.prepare("SELECT type,tbl_name,sql FROM sqlite_schema WHERE name=?").all(name);
    const row = rows[0];
    same(rows.length, 1);
    same(row?.type, name.startsWith("idx_") ? "index" : "table");
    same(row?.tbl_name, name.includes("struct_provenance") ? LIVE_JOURNAL_PROVENANCE : LIVE_JOURNAL_TABLE);
    same(typeof row?.sql === "string" ? normalizedSchemaSql(row.sql) : null, normalizedSchemaSql(sql));
  }
  for (const [table, expected] of Object.entries(LIVE_JOURNAL_SHAPE)) {
    same(db.prepare(`PRAGMA table_info(${table})`).all().map(r => [r.cid,r.name,r.type,r.notnull,r.dflt_value,r.pk]), expected.columns);
    same(db.prepare(`PRAGMA foreign_key_list(${table})`).all().map(r => [r.id,r.seq,r.table,r.from,r.to,r.on_update,r.on_delete,r.match]), expected.foreignKeys);
    same(db.prepare(`PRAGMA index_list(${table})`).all().map(r => [r.name,r.unique,r.origin,r.partial]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))), expected.indexes);
    for (const [name, columns] of Object.entries(expected.indexColumns)) same(db.prepare(`PRAGMA index_info(${name})`).all().map(r => [r.seqno,r.cid,r.name]), columns);
  }
}
function initializeLiveJournalSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id=?").get(LIVE_JOURNAL_MARKER);
  if (marked) { assertLiveJournalSchema(db); return; }
  const existing = db.prepare(`SELECT name FROM sqlite_schema WHERE name IN (${Object.keys(LIVE_JOURNAL_SCHEMA).map(()=>"?").join(",")})`).all(...Object.keys(LIVE_JOURNAL_SCHEMA));
  if (existing.length) throw new Error("unmarked live update journal schema already exists");
  for (const sql of Object.values(LIVE_JOURNAL_SCHEMA)) db.exec(sql);
  assertLiveJournalSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations(migration_id,completed_at_ms) VALUES (?,?)").run(LIVE_JOURNAL_MARKER,Date.now());
}

export function initializeSyncRelaySchema(db: SqliteDb): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_relay_workspaces (
        workspace_id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        replication_epoch TEXT,
        stream_identity TEXT,
        epoch_log_floor INTEGER
      );

      CREATE TABLE IF NOT EXISTS sync_relay_workspace_usage (
        workspace_id TEXT PRIMARY KEY,
        usage_bytes INTEGER NOT NULL CHECK (usage_bytes >= 0),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      ) STRICT;

      -- Every epoch that stops being active remains durable here. This makes
      -- stale pre-reset credentials permanently identifiable after rotation.
      CREATE TABLE IF NOT EXISTS sync_relay_epoch_supersessions (
        workspace_id TEXT NOT NULL,
        replication_epoch TEXT NOT NULL,
        stream_identity TEXT NOT NULL,
        superseded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, replication_epoch, stream_identity),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_relay_log (
        workspace_id TEXT NOT NULL,
        origin_id TEXT NOT NULL,
        origin_seq INTEGER NOT NULL,
        op_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        recorded_at_ms REAL NOT NULL,
        relay_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        UNIQUE(workspace_id, origin_id, origin_seq),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_page
        ON sync_relay_log(workspace_id, relay_seq);
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_document_page
        ON sync_relay_log(workspace_id, json_extract(payload_json, '$.versionId'),
          json_extract(payload_json, '$.objectId'), relay_seq);
      -- MU-C4: findThreadCreateChannelWireId's LIKE pre-filter cannot use an
      -- index on payload_json, but this PARTIAL index confines the scan to a
      -- workspace's chat.thread.create rows (a tiny slice of a busy log) in
      -- relay order, instead of every log row. Per-request memoization in the
      -- caller (server.ts chatResolverFor) removes the per-message repeats;
      -- if channel history ever makes even the confined scan hot, the upgrade
      -- path is a dedicated thread_channel_bindings table filled at insert.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_thread_creates
        ON sync_relay_log(workspace_id, relay_seq)
        WHERE op_kind = 'chat.thread.create';
      CREATE INDEX IF NOT EXISTS idx_sync_relay_log_channel_creates
        ON sync_relay_log(workspace_id, relay_seq)
        WHERE op_kind = 'chat.channel.create';

      CREATE TABLE IF NOT EXISTS sync_relay_blobs (
        workspace_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL,
        content BLOB NOT NULL,
        created_at_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (workspace_id, sha256),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sync_relay_key_envelopes (
        workspace_id TEXT PRIMARY KEY,
        envelope_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );

      -- Append-only audit trail: every replaced key envelope is retained with
      -- when it was replaced and by what (sha256 of the successor). The
      -- envelope is the only recovery path for the wrapped workspace key, so
      -- an overwrite — even a CAS-correct one — must never destroy the prior
      -- copy; a lockout caused by a bad replacement stays recoverable
      -- server-side.
      CREATE TABLE IF NOT EXISTS sync_relay_key_envelope_history (
        history_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        envelope_sha256 TEXT NOT NULL,
        replaced_at_ms INTEGER NOT NULL,
        replaced_by_sha256 TEXT NOT NULL,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id)
          ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_key_envelope_history
        ON sync_relay_key_envelope_history(workspace_id, history_seq);

      ${NORMALIZED_SHARE_SCHEMA_SQL}

      -- #646 PR2: where every object the relay has ever seen sits RIGHT NOW,
      -- maintained at insert time by appendLogBatch. The file-chat share
      -- filter resolves a thread's object to its current path and tests that
      -- path against the selector, so this lookup is on the share read path
      -- and must be a primary-key read. A LIKE scan cannot serve it:
      -- moment.append rows are most of a busy log, so the partial-index trick
      -- above would confine nothing.
      --
      -- The path column is NULL when the object's latest moment deletes it,
      -- or when that moment names no readable path. Both read as "deny" — the
      -- filter fails closed on NULL exactly as it does on an absent row.
      CREATE TABLE IF NOT EXISTS sync_relay_object_paths (
        workspace_id TEXT NOT NULL,
        object_id    TEXT NOT NULL,
        path         TEXT,
        relay_seq    INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, object_id),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      -- The reverse lookup: which object sits at this path now. A thread bound
      -- by PATH is re-proved through this on every serve, so it is on the
      -- share read path and must not scan.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_paths_path
        ON sync_relay_object_paths(workspace_id, path);

      -- #646 PR3a: one row per moment the relay has seen for an object, which
      -- is what the base rewrite resolves against. sync_relay_object_paths
      -- above answers "where is this object NOW?"; accept needs the harder
      -- question, "which of your own moments produced the content the
      -- recipient started from?", because that moment is the correct
      -- three-way base. A blob hash is the only identifier both sides of a
      -- share genuinely share, so the hash is what the lookup keys on.
      --
      -- path and blob_sha256 are NULL when the moment deletes the object.
      -- A NULL hash is never a lookup target: an absent base reads as
      -- "unknown", and unknown opens a conflict rather than claiming a base.
      CREATE TABLE IF NOT EXISTS sync_relay_object_moments (
        workspace_id   TEXT NOT NULL,
        object_id      TEXT NOT NULL,
        relay_seq      INTEGER NOT NULL,
        moment_id      TEXT NOT NULL,
        version_id     TEXT NOT NULL,
        path           TEXT,
        blob_sha256    TEXT,
        content_kind   TEXT,
        byte_length    INTEGER,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, object_id, relay_seq),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      -- Base resolution by content hash. Latest matching moment wins, because
      -- content can return to an earlier state and the recipient started from
      -- the most recent moment that produced it.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_moments_blob
        ON sync_relay_object_moments(workspace_id, object_id, blob_sha256, relay_seq);
      -- Blob authorization knows the share's target version and hash, but not
      -- the object. The object-first index above serves proposal-base lookups
      -- and cannot seek this query.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_moments_blob_lookup
        ON sync_relay_object_moments(
          workspace_id, version_id, blob_sha256, object_id, relay_seq DESC
        );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_moments_latest
        ON sync_relay_object_moments(
          workspace_id, version_id, object_id, relay_seq DESC
        );
      -- WHICH object sits at a path IN ONE VERSION. sync_relay_object_paths
      -- answers the same question across every version at once, latest-wins,
      -- so a path last touched in a side version resolves to the wrong object
      -- for a share that exposes another one. The proposal lane asks this
      -- instead, and it must not scan.
      CREATE INDEX IF NOT EXISTS idx_sync_relay_object_moments_path
        ON sync_relay_object_moments(workspace_id, version_id, path, relay_seq);

      -- version.create can establish snapshot blobs without a moment.append
      -- row. Keep those log rows discoverable by exact workspace/hash lookup;
      -- authorization still runs against the original version.create payload.
      CREATE TABLE IF NOT EXISTS sync_relay_version_snapshot_blobs (
        workspace_id TEXT NOT NULL,
        relay_seq     INTEGER NOT NULL,
        version_id    TEXT NOT NULL,
        blob_sha256  TEXT NOT NULL,
        PRIMARY KEY (workspace_id, relay_seq, blob_sha256),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
        FOREIGN KEY (relay_seq)
          REFERENCES sync_relay_log(relay_seq) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_sync_relay_version_snapshot_blobs_lookup
        ON sync_relay_version_snapshot_blobs(
          workspace_id, version_id, blob_sha256, relay_seq DESC
        );

      -- The public viewer starts from this accepted current state and uses the
      -- relay log only for forward changes. This is deliberately keyed by
      -- version and path: the viewer fold resolves path occupancy and applies
      -- before-path/hash compare-and-swap rules, so latest raw object moments
      -- are not an equivalent current-state model.
      CREATE TABLE IF NOT EXISTS sync_relay_current_files (
        workspace_id    TEXT NOT NULL,
        version_id      TEXT NOT NULL,
        path            TEXT NOT NULL,
        blob_sha256     TEXT NOT NULL,
        content_kind    TEXT NOT NULL CHECK (content_kind IN ('text', 'binary')),
        state_relay_seq INTEGER NOT NULL,
        PRIMARY KEY (workspace_id, version_id, path),
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE,
        FOREIGN KEY (state_relay_seq)
          REFERENCES sync_relay_log(relay_seq) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_sync_relay_current_files_path
        ON sync_relay_current_files(
          workspace_id, version_id, path, state_relay_seq
        );
      CREATE INDEX IF NOT EXISTS idx_sync_relay_current_files_blob
        ON sync_relay_current_files(
          workspace_id, version_id, blob_sha256, path, state_relay_seq
        );

      -- #646 PR3a: a recipient's submitted changes, held until the granter
      -- accepts or declines them. Nothing here is in the granter's log: accept
      -- is what releases it, through the same appendLogBatch the chat path
      -- already uses.
      --
      -- workspace_id is denormalized so the granter's owner-scoped read
      -- never joins through a share the granter may have revoked.
      -- submit_id makes one submit idempotent: a retried POST returns the
      -- proposal it already made instead of a second one.
      -- version_id is PINNED at submit from the selector the recipient read.
      -- Accept and the review listing both resolve the granter's moments
      -- within it, so a selector edited mid-flight cannot move a proposal to a
      -- version its author never saw.
      CREATE TABLE IF NOT EXISTS sync_relay_share_proposals (
        proposal_id         TEXT PRIMARY KEY,
        share_id            TEXT NOT NULL,
        workspace_id        TEXT NOT NULL,
        proposed_by_user_id TEXT NOT NULL,
        version_id          TEXT NOT NULL,
        submit_id           TEXT NOT NULL,
        state               TEXT NOT NULL,
        created_at_ms       INTEGER NOT NULL,
        settled_at_ms       INTEGER,
        UNIQUE (share_id, submit_id),
        FOREIGN KEY (share_id)
          REFERENCES sync_relay_shares(share_id) ON DELETE CASCADE,
        FOREIGN KEY (workspace_id)
          REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_sync_relay_share_proposals_workspace
        ON sync_relay_share_proposals(workspace_id, state, created_at_ms);
      CREATE INDEX IF NOT EXISTS idx_sync_relay_share_proposals_share
        ON sync_relay_share_proposals(share_id, created_at_ms);

      -- One NET change to one file. Not a moment, and deliberately not shaped
      -- like one: a recipient never learns a granter moment id, so it states
      -- what it read and what it wants, and the relay mints the moment.
      --
      -- based_on_object_id is resolved AT SUBMIT, from the path the recipient
      -- named. The path is where the granter had the file when the recipient
      -- read it; the object id is which file it is. Resolving at accept
      -- instead would follow the path, so a rename between submit and accept
      -- would find a different file and a delete would find none — and a
      -- change whose base resolved to nothing is minted as a create, which
      -- resurrects a file the granter deleted. The object id does not move.
      CREATE TABLE IF NOT EXISTS sync_relay_share_proposal_ops (
        proposal_id          TEXT NOT NULL,
        op_index             INTEGER NOT NULL,
        based_on_path        TEXT,
        based_on_object_id   TEXT,
        based_on_blob_sha256 TEXT,
        operation            TEXT NOT NULL,
        after_path           TEXT,
        after_blob_sha256    TEXT,
        after_content_kind   TEXT,
        after_byte_length    INTEGER,
        recorded_at_ms       INTEGER NOT NULL,
        PRIMARY KEY (proposal_id, op_index),
        FOREIGN KEY (proposal_id)
          REFERENCES sync_relay_share_proposals(proposal_id) ON DELETE CASCADE
      ) STRICT;
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_relay_migrations (
        migration_id TEXT PRIMARY KEY,
        completed_at_ms INTEGER NOT NULL
      ) STRICT;
    `);
    initializeSessionHostControlSchema(db);
    initializeDeviceHostCredentialSchema(db);
    initializeLiveDocumentAuthoritySchema(db);
    initializeServiceActivationSchema(db);
    initializeServiceHostEnrollmentSchema(db);
    initializeLiveRestoreOperationSchema(db);
    initializeLiveJournalSchema(db);
    initializeLiveCommittedDeliverySchema(db);
    initializeLiveTicketSchema(db);
    initializeAppPublicationSchema(db);
    initializeAppCollectionSchema(db);
    initializeNoticeSchema(db);
    initializeShareNoticeDeliverySchema(db);
    initializeAutomationHostSchema(db);
    initializeAutomationGroupHandoverSchema(db);
    initializeCurrentFileKeySchema(db);
    initializeCollectionWriteSchema(db);
    initializeAutomationPressSchema(db);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sync_relay_link_handoff_codes_result_grant
        ON sync_relay_link_handoff_codes(result_grant_id)
        WHERE result_grant_id IS NOT NULL
    `);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_insert
      AFTER INSERT ON sync_relay_workspaces
      BEGIN
        INSERT INTO sync_relay_workspace_usage (workspace_id, usage_bytes)
        VALUES (NEW.workspace_id, 0)
        ON CONFLICT(workspace_id) DO NOTHING;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_blob_insert
      AFTER INSERT ON sync_relay_blobs
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.byte_length
        WHERE workspace_id = NEW.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_blob_delete
      AFTER DELETE ON sync_relay_blobs
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.byte_length
        WHERE workspace_id = OLD.workspace_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_log_insert
      AFTER INSERT ON sync_relay_log
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + length(CAST(NEW.payload_json AS BLOB))
        WHERE workspace_id = NEW.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_log_delete
      AFTER DELETE ON sync_relay_log
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - length(CAST(OLD.payload_json AS BLOB))
        WHERE workspace_id = OLD.workspace_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_envelope_insert
      AFTER INSERT ON sync_relay_key_envelopes
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + length(CAST(NEW.envelope_json AS BLOB))
        WHERE workspace_id = NEW.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_envelope_update
      AFTER UPDATE OF envelope_json ON sync_relay_key_envelopes
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes
          - length(CAST(OLD.envelope_json AS BLOB))
          + length(CAST(NEW.envelope_json AS BLOB))
        WHERE workspace_id = NEW.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_envelope_delete
      AFTER DELETE ON sync_relay_key_envelopes
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - length(CAST(OLD.envelope_json AS BLOB))
        WHERE workspace_id = OLD.workspace_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_envelope_history_insert
      AFTER INSERT ON sync_relay_key_envelope_history
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + length(CAST(NEW.envelope_json AS BLOB))
        WHERE workspace_id = NEW.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_envelope_history_delete
      AFTER DELETE ON sync_relay_key_envelope_history
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - length(CAST(OLD.envelope_json AS BLOB))
        WHERE workspace_id = OLD.workspace_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_supersession_insert
      AFTER INSERT ON sync_relay_epoch_supersessions
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes
          + length(CAST(NEW.replication_epoch AS BLOB))
          + length(CAST(NEW.stream_identity AS BLOB))
        WHERE workspace_id = NEW.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_supersession_delete
      AFTER DELETE ON sync_relay_epoch_supersessions
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes
          - length(CAST(OLD.replication_epoch AS BLOB))
          - length(CAST(OLD.stream_identity AS BLOB))
        WHERE workspace_id = OLD.workspace_id;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_share_delete
      BEFORE DELETE ON sync_relay_shares
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes
          - COALESCE((
              SELECT SUM(message.storage_bytes)
              FROM sync_relay_share_discussion_messages AS message
              WHERE message.share_id = OLD.share_id
            ), 0)
          - COALESCE((
              SELECT SUM(principal.storage_bytes)
              FROM sync_relay_link_principals AS principal
              JOIN sync_relay_share_grants AS grant
                ON grant.grant_id = principal.grant_id
              WHERE grant.share_id = OLD.share_id
            ), 0)
        WHERE workspace_id = OLD.workspace_id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_grant_delete
      BEFORE DELETE ON sync_relay_share_grants
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - COALESCE((
          SELECT SUM(storage_bytes)
          FROM sync_relay_link_principals
          WHERE grant_id = OLD.grant_id
        ), 0)
        WHERE workspace_id = (
          SELECT workspace_id FROM sync_relay_shares WHERE share_id = OLD.share_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_message_insert
      AFTER INSERT ON sync_relay_share_discussion_messages
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = (
          SELECT workspace_id FROM sync_relay_shares WHERE share_id = NEW.share_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_message_delete
      AFTER DELETE ON sync_relay_share_discussion_messages
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = (
          SELECT workspace_id FROM sync_relay_shares WHERE share_id = OLD.share_id
        );
      END;

      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_principal_insert
      AFTER INSERT ON sync_relay_link_principals
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes + NEW.storage_bytes
        WHERE workspace_id = (
          SELECT share.workspace_id
          FROM sync_relay_share_grants AS grant
          JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
          WHERE grant.grant_id = NEW.grant_id
        );
      END;
      CREATE TRIGGER IF NOT EXISTS trg_sync_relay_workspace_usage_principal_delete
      AFTER DELETE ON sync_relay_link_principals
      BEGIN
        UPDATE sync_relay_workspace_usage
        SET usage_bytes = usage_bytes - OLD.storage_bytes
        WHERE workspace_id = (
          SELECT share.workspace_id
          FROM sync_relay_share_grants AS grant
          JOIN sync_relay_shares AS share ON share.share_id = grant.share_id
          WHERE grant.grant_id = OLD.grant_id
        );
      END;
    `);
}

export const DEVICE_HOST_CREDENTIAL_TABLE = "sync_relay_device_host_credential";

const DEVICE_HOST_CREDENTIAL_MIGRATION = "device-host-credential-v1";

const DEVICE_HOST_CREDENTIAL_SCHEMA = `
CREATE TABLE sync_relay_device_host_credential (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  host_id TEXT NOT NULL CHECK (length(CAST(host_id AS BLOB)) BETWEEN 1 AND 1024),
  instance_id TEXT NOT NULL CHECK (length(CAST(instance_id AS BLOB)) BETWEEN 1 AND 1024),
  host_epoch INTEGER NOT NULL CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
  verifier TEXT NOT NULL CHECK (length(verifier) = 64 AND verifier NOT GLOB '*[^0-9a-f]*'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 9007199254740991),
  revoked_at_ms INTEGER CHECK (revoked_at_ms BETWEEN created_at_ms AND 9007199254740991)
) STRICT;`;

function initializeDeviceHostCredentialSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(DEVICE_HOST_CREDENTIAL_MIGRATION);
  const existing = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(DEVICE_HOST_CREDENTIAL_TABLE);
  if (marked) {
    if (typeof existing?.sql !== "string" || normalizedSchemaSql(existing.sql) !== normalizedSchemaSql(DEVICE_HOST_CREDENTIAL_SCHEMA)) {
      throw new Error("Device host credential schema is missing or damaged.");
    }
    return;
  }
  if (existing) throw new Error("Unmarked device host credential table exists.");
  db.exec(DEVICE_HOST_CREDENTIAL_SCHEMA);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)")
    .run(DEVICE_HOST_CREDENTIAL_MIGRATION, Date.now());
}

export const LIVE_TICKET_TABLE = "sync_relay_live_session_tickets";

const LIVE_TICKET_MIGRATION = "live-session-tickets-v1";

const LIVE_TICKET_SCHEMA = {
  sync_relay_live_session_tickets: `
CREATE TABLE sync_relay_live_session_tickets (
  ticket_id TEXT NOT NULL
    CHECK (length(CAST(ticket_id AS BLOB)) BETWEEN 1 AND 512),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 43 AND length(CAST(token_hash AS BLOB)) = 43
    AND token_hash NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  audience TEXT NOT NULL
    CHECK (length(CAST(audience AS BLOB)) BETWEEN 1 AND 2048),
  workspace_id TEXT NOT NULL
    CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
  main_version_id TEXT NOT NULL CHECK (main_version_id = 'main'),
  object_id TEXT NOT NULL
    CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
  lineage_claim_id TEXT NOT NULL CHECK (
    length(lineage_claim_id) = 64 AND length(CAST(lineage_claim_id AS BLOB)) = 64
    AND lineage_claim_id NOT GLOB '*[^0-9a-f]*'
  ),
  current_path TEXT NOT NULL
    CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
  selector_paths_json TEXT NOT NULL CHECK (
    length(CAST(selector_paths_json AS BLOB)) BETWEEN 2 AND (100 * (6 * 1024 + 3) + 1)
  ),
  restore_fence_generation INTEGER NOT NULL
    CHECK (restore_fence_generation BETWEEN 1 AND 9007199254740991),
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('named', 'link')),
  principal_id TEXT NOT NULL
    CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
  grant_id TEXT NOT NULL
    CHECK (length(CAST(grant_id AS BLOB)) BETWEEN 1 AND 512),
  grant_generation INTEGER NOT NULL
    CHECK (grant_generation BETWEEN 1 AND 9007199254740991),
  host_epoch INTEGER NOT NULL
    CHECK (host_epoch BETWEEN 1 AND 9007199254740991),
  minted_at_ms INTEGER NOT NULL
    CHECK (minted_at_ms BETWEEN 0 AND 9007199254710991),
  expires_at_ms INTEGER NOT NULL CHECK (
    expires_at_ms BETWEEN 0 AND 9007199254740991
    AND expires_at_ms = minted_at_ms + 30000
  ),
  redeemed_at_ms INTEGER CHECK (
    redeemed_at_ms IS NULL OR (
      redeemed_at_ms BETWEEN 0 AND 9007199254740991
      AND minted_at_ms <= redeemed_at_ms AND redeemed_at_ms < expires_at_ms
    )
  ),
  link_session_id TEXT CHECK (
    (principal_kind = 'named' AND link_session_id IS NULL) OR
    (principal_kind = 'link' AND link_session_id IS NOT NULL AND length(CAST(link_session_id AS BLOB)) BETWEEN 1 AND 512)
  ),
  PRIMARY KEY (ticket_id),
  FOREIGN KEY (workspace_id)
    REFERENCES sync_relay_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
`,
  idx_sync_relay_live_session_tickets_hash: `
CREATE UNIQUE INDEX idx_sync_relay_live_session_tickets_hash
  ON sync_relay_live_session_tickets(token_hash);
`,
  idx_sync_relay_live_session_tickets_scope_expiry: `
CREATE INDEX idx_sync_relay_live_session_tickets_scope_expiry
  ON sync_relay_live_session_tickets(
    workspace_id, principal_kind, principal_id, grant_id, expires_at_ms, ticket_id
  );
`,
  idx_sync_relay_live_session_tickets_expiry: `
CREATE INDEX idx_sync_relay_live_session_tickets_expiry
  ON sync_relay_live_session_tickets(expires_at_ms, ticket_id);
`,
} as const;

export const LIVE_TICKET_COLUMNS = [
  "ticket_id", "token_hash", "audience", "workspace_id", "main_version_id", "object_id",
  "lineage_claim_id", "current_path", "selector_paths_json", "restore_fence_generation",
  "principal_kind", "principal_id", "grant_id", "grant_generation", "host_epoch",
  "minted_at_ms", "expires_at_ms", "redeemed_at_ms", "link_session_id",
] as const;

export const LIVE_TICKET_INTEGER_COLUMNS = new Set<string>([
  "restore_fence_generation", "grant_generation", "host_epoch", "minted_at_ms", "expires_at_ms", "redeemed_at_ms",
]);

function assertLiveTicketSchema(db: SqliteDb): void {
  const fail = (): never => { throw new Error("live-ticket schema is missing or damaged"); };
  const same = (actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail();
  };
  for (const [name, sql] of Object.entries(LIVE_TICKET_SCHEMA)) {
    const rows = db.prepare("SELECT type, tbl_name, sql FROM sqlite_schema WHERE name = ?").all(name);
    const row = rows[0];
    if (rows.length !== 1 || !row || row.type !== (name === LIVE_TICKET_TABLE ? "table" : "index") ||
      row.tbl_name !== LIVE_TICKET_TABLE || typeof row.sql !== "string" || normalizedSchemaSql(row.sql) !== normalizedSchemaSql(sql)) fail();
  }
  same(db.prepare(`PRAGMA table_info(${LIVE_TICKET_TABLE})`).all().map(row =>
    [row.cid, row.name, row.type, row.notnull, row.dflt_value, row.pk]),
  LIVE_TICKET_COLUMNS.map((name, cid) => [cid, name, LIVE_TICKET_INTEGER_COLUMNS.has(name) ? "INTEGER" : "TEXT",
    (name === "redeemed_at_ms" || name === "link_session_id") ? 0 : 1, null, name === "ticket_id" ? 1 : 0]));
  same(db.prepare(`PRAGMA foreign_key_list(${LIVE_TICKET_TABLE})`).all().map(row =>
    [row.id, row.seq, row.table, row.from, row.to, row.on_update, row.on_delete, row.match]),
  [[0, 0, "sync_relay_workspaces", "workspace_id", "workspace_id", "NO ACTION", "CASCADE", "NONE"]]);
  const indexes = [
    ["idx_sync_relay_live_session_tickets_hash", 1, "c", ["token_hash"]],
    ["idx_sync_relay_live_session_tickets_scope_expiry", 0, "c", ["workspace_id", "principal_kind", "principal_id", "grant_id", "expires_at_ms", "ticket_id"]],
    ["idx_sync_relay_live_session_tickets_expiry", 0, "c", ["expires_at_ms", "ticket_id"]],
    [`sqlite_autoindex_${LIVE_TICKET_TABLE}_1`, 1, "pk", ["ticket_id"]],
  ] as const;
  const sorted = (rows: unknown[][]): unknown[][] => rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  same(sorted(db.prepare(`PRAGMA index_list(${LIVE_TICKET_TABLE})`).all().map(row => [row.name, row.unique, row.origin, row.partial])),
    sorted(indexes.map(([name, unique, origin]) => [name, unique, origin, 0])));
  for (const [name, , , columns] of indexes) {
    same(db.prepare(`PRAGMA index_info(${name})`).all().map(row => [row.seqno, row.cid, row.name]),
      columns.map((column, seq) => [seq, LIVE_TICKET_COLUMNS.findIndex(value => value === column), column]));
  }
  same(db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ?").all(LIVE_TICKET_TABLE), []);
}

function initializeLiveTicketSchema(db: SqliteDb): void {
  const marked = db.prepare("SELECT 1 FROM sync_relay_migrations WHERE migration_id = ?").get(LIVE_TICKET_MIGRATION) !== undefined;
  if (marked) { assertLiveTicketSchema(db); return; }
  const existing = db.prepare("SELECT name FROM sqlite_schema WHERE name IN (?, ?, ?, ?)").all(...Object.keys(LIVE_TICKET_SCHEMA));
  if (existing.length) throw new Error("unmarked live-ticket schema already exists");
  for (const sql of Object.values(LIVE_TICKET_SCHEMA)) db.exec(sql);
  assertLiveTicketSchema(db);
  db.prepare("INSERT INTO sync_relay_migrations (migration_id, completed_at_ms) VALUES (?, ?)").run(LIVE_TICKET_MIGRATION, Date.now());
}
