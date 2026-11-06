CREATE TABLE learned_work_references (
    reference TEXT NOT NULL PRIMARY KEY
        CHECK (length(reference) = 43 AND reference NOT GLOB '*[^A-Za-z0-9_-]*'),
    workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
    target_json TEXT NOT NULL CHECK (json_valid(target_json)),
    created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX learned_work_references_workspace ON learned_work_references(workspace_id, reference);

CREATE TRIGGER learned_work_references_immutable
BEFORE UPDATE ON learned_work_references
BEGIN SELECT RAISE(ABORT, 'work references are immutable'); END;

CREATE TABLE work_reference_sync_pages (
    workspace_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    after_reference TEXT,
    log_pages_pending INTEGER NOT NULL DEFAULT 0 CHECK(log_pages_pending IN (0,1)),
    reference_pages_pending INTEGER NOT NULL DEFAULT 0 CHECK(reference_pages_pending IN (0,1)),
    PRIMARY KEY(workspace_id, scope_id)
) STRICT;
