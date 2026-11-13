-- An account's read place in one chat thread: the newest message it has read,
-- by (created_at_ms, message_id). A mark only moves forward, and copies merge
-- by the later coordinate. origin_id and origin_seq name the journal row that
-- last moved it, as in chat_feed_read_state.
CREATE TABLE chat_account_thread_read_state (
    workspace_id            TEXT    NOT NULL,
    account_user_id         TEXT    NOT NULL CHECK (length(CAST(account_user_id AS BLOB)) > 0),
    thread_id               TEXT    NOT NULL CHECK (length(CAST(thread_id AS BLOB)) > 0),
    last_read_created_at_ms INTEGER NOT NULL,
    last_read_message_id    TEXT    NOT NULL CHECK (length(CAST(last_read_message_id AS BLOB)) > 0),
    updated_at_ms           INTEGER NOT NULL,
    origin_id               TEXT    NOT NULL,
    origin_seq              INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, account_user_id, thread_id)
) STRICT;

-- The account whose read places this copy shows. It is recorded once per
-- workspace, on the first open with the owner's replication context, in the
-- transaction that seeds from this copy's local counts. A server copy seeds
-- nothing. A workspace without a row keeps local counts.
CREATE TABLE chat_account_read_seeds (
    workspace_id    TEXT    NOT NULL PRIMARY KEY,
    account_user_id TEXT    NOT NULL CHECK (length(CAST(account_user_id AS BLOB)) > 0),
    seeded_local    INTEGER NOT NULL CHECK (seeded_local IN (0, 1)),
    completed_at_ms INTEGER NOT NULL
) STRICT;

-- A replicated account mark can arrive before its message. SQLite cannot
-- change a CHECK in place, so the parking table is rebuilt with every row kept.
CREATE TABLE chat_pending_replication_next (
    workspace_id    TEXT    NOT NULL,
    origin_id       TEXT    NOT NULL,
    origin_seq      INTEGER NOT NULL,
    dependency_kind TEXT    NOT NULL CHECK (
      dependency_kind IN (
        'follow-target',
        'feed-message',
        'attachment-message',
        'message-thread',
        'thread-read-message'
      )
    ),
    dependency_id   TEXT    NOT NULL,
    PRIMARY KEY (workspace_id, origin_id, origin_seq)
) STRICT;
INSERT INTO chat_pending_replication_next
    (workspace_id, origin_id, origin_seq, dependency_kind, dependency_id)
SELECT workspace_id, origin_id, origin_seq, dependency_kind, dependency_id
FROM chat_pending_replication;
DROP TABLE chat_pending_replication;
ALTER TABLE chat_pending_replication_next RENAME TO chat_pending_replication;
CREATE INDEX chat_pending_replication_by_dependency
    ON chat_pending_replication (workspace_id, dependency_kind, dependency_id);
