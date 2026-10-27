CREATE TABLE markdown_write_obligations (
    obligation_order INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
    kind TEXT NOT NULL CHECK (kind IN (
        'session', 'audited-settle', 'owner-stop', 'collection-adoption',
        'relation-cleanup', 'link-baseline', 'sync-projection', 'witness-refresh'
    )),
    path TEXT NOT NULL,
    retry_inputs_json TEXT NOT NULL CHECK (json_valid(retry_inputs_json)),
    held_checkpoint_sha256 TEXT,
    held_head_sha256 TEXT,
    settled_cut INTEGER,
    settled_head_sha256 TEXT,
    completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    UNIQUE (workspace_id, version_id, object_id, lineage_claim_id, operation_id, kind),
    CHECK ((settled_cut IS NULL) = (settled_head_sha256 IS NULL)),
    CHECK (kind != 'witness-refresh' OR settled_cut IS NOT NULL),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX markdown_write_obligations_pending
ON markdown_write_obligations(workspace_id, completed, obligation_order);
