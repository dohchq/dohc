-- One committed chat write stage, keyed by its request's idempotency key in
-- its workspace. `coordinates_json` lists, as `{originId, originSeq}`, the
-- local `replication_log` rows the stage's transaction inserted. A `lost`
-- resolve names the reply that had already resolved the question, when the
-- question names one. A decision or reaction stage keeps in `result_json` the
-- cell it answered, so a retry answers it again after the cell changes.
CREATE TABLE chat_stage_receipts (
    workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) > 0),
    stage_key TEXT NOT NULL CHECK (length(CAST(stage_key AS BLOB)) > 0),
    outcome TEXT NOT NULL CHECK (outcome IN ('written', 'no-op', 'lost')),
    thread_id TEXT NOT NULL CHECK (length(CAST(thread_id AS BLOB)) > 0),
    winner_message_id TEXT CHECK (winner_message_id IS NULL OR outcome = 'lost'),
    coordinates_json TEXT NOT NULL
        CHECK (json_valid(coordinates_json) AND json_type(coordinates_json) = 'array'),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    PRIMARY KEY (workspace_id, stage_key)
) STRICT;
