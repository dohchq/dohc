-- A file changed outside dohc while its note was live. Capture records no
-- moment for those bytes and does not read them again until they change. The
-- row ends when the file matches the note again, when the person keeps the
-- change as a copy, or when the note stops being live.
CREATE TABLE held_outside_changes (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    path TEXT NOT NULL,
    observed_sha256 TEXT NOT NULL
        CHECK (length(observed_sha256)=64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'),
    observed_size INTEGER NOT NULL CHECK (observed_size>=0),
    first_observed_at_ms INTEGER NOT NULL,
    observed_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, path),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id),
    FOREIGN KEY (workspace_id, object_id) REFERENCES file_objects(workspace_id, object_id)
) STRICT;
CREATE INDEX held_outside_changes_object
    ON held_outside_changes(workspace_id, version_id, object_id);
