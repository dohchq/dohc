CREATE TABLE live_restore_refusals (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) BETWEEN 1 AND 512),
    operation_id TEXT NOT NULL CHECK (length(CAST(operation_id AS BLOB)) BETWEEN 1 AND 512),
    workspace_id TEXT NOT NULL REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    input_json TEXT NOT NULL CHECK (length(CAST(input_json AS BLOB)) <= 1048576 AND json_valid(input_json)),
    reason TEXT NOT NULL CHECK (reason IN ('binding-changed','reader-unavailable','source-unavailable','source-too-large','incomplete-witness')),
    recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY (relay_database_namespace, operation_id)
) STRICT;
CREATE TRIGGER live_restore_refusals_immutable BEFORE UPDATE ON live_restore_refusals
BEGIN
    SELECT RAISE(ABORT, 'restore refusal is immutable');
END;
