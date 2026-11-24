-- A message the relay deleted. The row stays: an append that applies after
-- the delete, parked or from another origin, goes in as deleted.
CREATE TABLE chat_deleted_messages (
    workspace_id  TEXT    NOT NULL,
    message_id    TEXT    NOT NULL,
    thread_id     TEXT    NOT NULL,
    deleted_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id)
) STRICT;

-- A deleted message keeps its line, with an empty body.
ALTER TABLE chat_messages ADD COLUMN deleted_at_ms INTEGER
    CHECK (deleted_at_ms IS NULL OR body = '');
