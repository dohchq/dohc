-- A work reference can name a chat or a thread:
--
--   chat    target_id is the channel id of a Group, DM or agent chat.
--   thread  target_id is the thread id. channel_id binds it to its chat; a
--           file's conversation has no channel.
--
-- SQLite cannot change a CHECK in place, so work_references is rebuilt with
-- every row kept. With foreign keys on, DROP TABLE would cascade into the
-- outbox, so its rows are set aside first and put back unchanged. The rename
-- runs in legacy mode, so the outbox keeps naming work_references.
PRAGMA legacy_alter_table=ON;
CREATE TABLE work_references_next (
    reference     TEXT    NOT NULL PRIMARY KEY
                  CHECK (length(reference) = 43 AND reference NOT GLOB '*[^A-Za-z0-9_-]*'),
    workspace_id  TEXT    NOT NULL CHECK (length(workspace_id) > 0),
    target_kind   TEXT    NOT NULL CHECK (target_kind IN (
                    'message', 'file', 'app', 'documentRecord', 'documentCollection',
                    'transactionalCollection', 'transactionalRecord', 'chat', 'thread')),
    target_id     TEXT    NOT NULL CHECK (length(target_id) > 0),
    version_id    TEXT    CHECK (version_id IS NULL OR length(version_id) > 0),
    dataset_id    TEXT    CHECK (dataset_id IS NULL OR length(dataset_id) > 0),
    table_id      TEXT    CHECK (table_id IS NULL OR length(table_id) > 0),
    thread_id     TEXT    CHECK (thread_id IS NULL OR length(thread_id) > 0),
    channel_id    TEXT    CHECK (channel_id IS NULL OR length(channel_id) > 0),
    created_at_ms INTEGER NOT NULL,
    CHECK ((version_id IS NOT NULL) =
           (target_kind IN ('file', 'app', 'documentRecord', 'documentCollection'))),
    CHECK ((dataset_id IS NOT NULL) =
           (target_kind IN ('transactionalCollection', 'transactionalRecord'))),
    CHECK ((table_id IS NOT NULL) = (target_kind = 'transactionalRecord')),
    CHECK ((thread_id IS NOT NULL) = (target_kind = 'message')),
    CHECK (channel_id IS NULL OR target_kind IN ('message', 'thread'))
) STRICT;
INSERT INTO work_references_next SELECT * FROM work_references;
CREATE TABLE work_reference_outbox_kept (
    reference      TEXT    NOT NULL,
    enqueued_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO work_reference_outbox_kept SELECT reference, enqueued_at_ms FROM work_reference_outbox;
DELETE FROM work_reference_outbox;
DROP TABLE work_references;
ALTER TABLE work_references_next RENAME TO work_references;
INSERT INTO work_reference_outbox (reference, enqueued_at_ms)
SELECT reference, enqueued_at_ms FROM work_reference_outbox_kept;
DROP TABLE work_reference_outbox_kept;
PRAGMA legacy_alter_table=OFF;

CREATE UNIQUE INDEX work_references_target ON work_references(
    workspace_id, target_kind, target_id,
    ifnull(version_id, ''), ifnull(dataset_id, ''), ifnull(table_id, ''));

CREATE TRIGGER work_references_immutable
BEFORE UPDATE ON work_references
BEGIN
    SELECT RAISE(ABORT, 'work references are immutable');
END;
