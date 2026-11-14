-- An owner device's edit of a note this host holds live joins the note's
-- owner queue. This row ties the file change that edit came from to the
-- queue entry, so the file change waits until the relay answers the entry,
-- and applies with no file write once the relay accepts it.
CREATE TABLE live_device_update_covers (
    workspace_id TEXT NOT NULL,
    update_origin_id TEXT NOT NULL,
    moment_id TEXT NOT NULL CHECK (length(CAST(moment_id AS BLOB)) BETWEEN 1 AND 512),
    update_origin_seq INTEGER NOT NULL CHECK (update_origin_seq >= 0),
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    delivery_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, update_origin_id, moment_id),
    UNIQUE (workspace_id, update_origin_id, update_origin_seq),
    FOREIGN KEY (workspace_id) REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE
) STRICT;
