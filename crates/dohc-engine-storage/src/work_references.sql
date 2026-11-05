-- A work reference names one piece of work in one workspace. This device
-- makes it as 256 random bits in unpadded base64url, and it names the same
-- target for as long as the row exists. A path or a name is display data and
-- never part of the target:
--
--   message                  target_id is the message id. thread_id and
--                            channel_id bind it to its thread and chat; a
--                            file's conversation has no channel.
--   file, app                target_id is a file object id in version_id. An
--                            app is named by its entry file.
--   documentRecord           target_id is a record id in version_id.
--   documentCollection       target_id is the object id of the Collection's
--                            schema file in version_id.
--   transactionalCollection  target_id is a table id in dataset_id.
--   transactionalRecord      target_id is the record id as JSON, so a number
--                            and a string stay different; table_id and
--                            dataset_id name its table.
--
-- Each target has at most one reference in this store, so asking again
-- returns it. Another device may make a different reference to the same
-- target. A new reference waits in work_reference_outbox until the
-- workspace's server registers it; both rows commit in one transaction. A
-- reference with an outbox row is pending, and one without is registered.
CREATE TABLE work_references (
    reference     TEXT    NOT NULL PRIMARY KEY
                  CHECK (length(reference) = 43 AND reference NOT GLOB '*[^A-Za-z0-9_-]*'),
    workspace_id  TEXT    NOT NULL CHECK (length(workspace_id) > 0),
    target_kind   TEXT    NOT NULL CHECK (target_kind IN (
                    'message', 'file', 'app', 'documentRecord', 'documentCollection',
                    'transactionalCollection', 'transactionalRecord')),
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
    CHECK (channel_id IS NULL OR target_kind = 'message')
) STRICT;

-- Columns a kind does not use are NULL, so the target is the whole tuple.
CREATE UNIQUE INDEX work_references_target ON work_references(
    workspace_id, target_kind, target_id,
    ifnull(version_id, ''), ifnull(dataset_id, ''), ifnull(table_id, ''));

CREATE TRIGGER work_references_immutable
BEFORE UPDATE ON work_references
BEGIN
    SELECT RAISE(ABORT, 'work references are immutable');
END;

CREATE TABLE work_reference_outbox (
    reference      TEXT    NOT NULL PRIMARY KEY
                   REFERENCES work_references(reference) ON DELETE CASCADE,
    enqueued_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX work_reference_outbox_order
    ON work_reference_outbox(enqueued_at_ms, reference);
