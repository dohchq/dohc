-- The relay admits a personal agent's live update under `personal` authority,
-- which names the agent and holds no grant. SQLite cannot change a CHECK in
-- place, so the applications table is rebuilt under its own name with every
-- row kept.
--
-- Restore fences and first-seen ranges reference the table with ON DELETE
-- RESTRICT. With foreign keys deferred, the drop counts each dependent row as
-- dangling and the copy back counts it as restored, so commit fails unless
-- every row returns, and no dependent row is touched. Deferral ends at commit;
-- turning it off sooner would forget the count. The drop takes the
-- released-tail triggers, which return after the copy so it does not advance
-- any released tail.
PRAGMA defer_foreign_keys=ON;
CREATE TEMP TABLE live_device_update_applications_kept AS
    SELECT * FROM live_device_update_applications;
DROP TABLE live_device_update_applications;
CREATE TABLE live_device_update_applications (
    relay_database_namespace TEXT NOT NULL CHECK (length(CAST(relay_database_namespace AS BLOB)) > 0),
    workspace_id TEXT NOT NULL CHECK (length(CAST(workspace_id AS BLOB)) BETWEEN 1 AND 512),
    delivery_id TEXT NOT NULL CHECK (length(CAST(delivery_id AS BLOB)) BETWEEN 1 AND 512),
    main_version_id TEXT NOT NULL CHECK (length(CAST(main_version_id AS BLOB)) BETWEEN 1 AND 512),
    object_id TEXT NOT NULL CHECK (length(CAST(object_id AS BLOB)) BETWEEN 1 AND 512),
    lineage_claim_id TEXT NOT NULL CHECK (length(CAST(lineage_claim_id AS BLOB)) BETWEEN 1 AND 512),
    current_path TEXT NOT NULL CHECK (length(CAST(current_path AS BLOB)) BETWEEN 1 AND 1024),
    selector_paths_json TEXT NOT NULL CHECK (json_valid(selector_paths_json)),
    restore_fence_generation INTEGER NOT NULL CHECK (restore_fence_generation BETWEEN 0 AND 9007199254740991),
    update_digest TEXT NOT NULL CHECK (length(update_digest) = 64 AND update_digest NOT GLOB '*[^0-9a-f]*'),
    update_byte_length INTEGER NOT NULL CHECK (update_byte_length BETWEEN 1 AND 9007199254740991),
    journal_cursor INTEGER NOT NULL CHECK (journal_cursor BETWEEN 1 AND 9007199254740991),
    accepting_host_epoch INTEGER NOT NULL CHECK (accepting_host_epoch BETWEEN 1 AND 9007199254740991),
    principal_kind TEXT NOT NULL CHECK (principal_kind IN ('owner', 'personal', 'named', 'link')),
    principal_id TEXT NOT NULL CHECK (length(CAST(principal_id AS BLOB)) BETWEEN 1 AND 512),
    grant_id TEXT CHECK (grant_id IS NULL OR length(CAST(grant_id AS BLOB)) BETWEEN 1 AND 512),
    grant_generation INTEGER CHECK (grant_generation IS NULL OR grant_generation BETWEEN 1 AND 9007199254740991),
    received_at_ms INTEGER NOT NULL CHECK (received_at_ms BETWEEN 0 AND 9007199254740991),
    first_seen_count INTEGER NOT NULL CHECK (first_seen_count BETWEEN 0 AND 9007199254740991),
    local_ydoc_sequence INTEGER NOT NULL CHECK (local_ydoc_sequence BETWEEN 1 AND 9007199254740991),
    applied_host_id TEXT NOT NULL CHECK (length(CAST(applied_host_id AS BLOB)) BETWEEN 1 AND 1024),
    applied_host_epoch INTEGER NOT NULL CHECK (applied_host_epoch BETWEEN 1 AND 9007199254740991),
    applied_instance_id TEXT NOT NULL CHECK (length(CAST(applied_instance_id AS BLOB)) BETWEEN 1 AND 1024),
    applied_connection_id TEXT NOT NULL CHECK (length(CAST(applied_connection_id AS BLOB)) BETWEEN 1 AND 1024),
    admitted_metadata_json TEXT CHECK (admitted_metadata_json IS NULL OR json_valid(admitted_metadata_json)),
    CHECK ((principal_kind = 'owner' AND grant_id IS NULL AND grant_generation IS NULL)
        OR (principal_kind = 'personal' AND substr(principal_id, 1, 2) = 'p-'
            AND grant_id IS NULL AND grant_generation IS NULL)
        OR (principal_kind IN ('named', 'link') AND grant_id IS NOT NULL AND grant_generation IS NOT NULL)),
    PRIMARY KEY (relay_database_namespace, workspace_id, delivery_id),
    UNIQUE (relay_database_namespace, delivery_id),
    UNIQUE (relay_database_namespace, journal_cursor),
    FOREIGN KEY (update_digest) REFERENCES binary_blobs(sha256) ON DELETE RESTRICT
) STRICT;
INSERT INTO live_device_update_applications (
    relay_database_namespace, workspace_id, delivery_id, main_version_id, object_id,
    lineage_claim_id, current_path, selector_paths_json, restore_fence_generation,
    update_digest, update_byte_length, journal_cursor, accepting_host_epoch, principal_kind,
    principal_id, grant_id, grant_generation, received_at_ms, first_seen_count,
    local_ydoc_sequence, applied_host_id, applied_host_epoch, applied_instance_id,
    applied_connection_id, admitted_metadata_json
) SELECT
    relay_database_namespace, workspace_id, delivery_id, main_version_id, object_id,
    lineage_claim_id, current_path, selector_paths_json, restore_fence_generation,
    update_digest, update_byte_length, journal_cursor, accepting_host_epoch, principal_kind,
    principal_id, grant_id, grant_generation, received_at_ms, first_seen_count,
    local_ydoc_sequence, applied_host_id, applied_host_epoch, applied_instance_id,
    applied_connection_id, admitted_metadata_json
FROM live_device_update_applications_kept;
DROP TABLE live_device_update_applications_kept;
CREATE INDEX live_device_applications_document_cursor
    ON live_device_update_applications(relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, journal_cursor);
CREATE INDEX live_device_applications_content
    ON live_device_update_applications(relay_database_namespace, workspace_id, main_version_id, object_id, lineage_claim_id, update_digest);
CREATE TRIGGER released_tail_application_insert AFTER INSERT ON live_device_update_applications BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=NEW.delivery_id);
END;
CREATE TRIGGER released_tail_application_update AFTER UPDATE ON live_device_update_applications BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=NEW.workspace_id AND version_id=NEW.main_version_id AND object_id=NEW.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=OLD.delivery_id);
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=NEW.delivery_id);
END;
CREATE TRIGGER released_tail_application_delete AFTER DELETE ON live_device_update_applications BEGIN
    UPDATE released_tail_generations SET generation=generation+1
        WHERE workspace_id=OLD.workspace_id AND version_id=OLD.main_version_id AND object_id=OLD.object_id;
    UPDATE released_tail_generations SET generation=generation+1 WHERE (workspace_id,version_id,object_id)=
        (SELECT o.workspace_id,o.main_version_id,o.object_id FROM owner_ydoc_outbox_entries e
           JOIN owner_ydoc_outboxes o ON o.outbox_id=e.outbox_id WHERE e.delivery_id=OLD.delivery_id);
END;
