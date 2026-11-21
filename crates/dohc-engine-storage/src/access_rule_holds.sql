-- A folder whose access rule changed on disk in a way capture does not publish
-- by itself: the rule widens someone's reach, or it was removed while the
-- folder still holds files. Each row is the owner's notice. Capture judges the
-- disk again on every write under the folder and removes the row once the disk
-- no longer widens; the owner's accept or restore removes it too.
CREATE TABLE access_rule_holds (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    folder TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('widened', 'removed')),
    observed_sha256 TEXT CHECK (
        observed_sha256 IS NULL
        OR (length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*')
    ),
    recorded_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, version_id, folder),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;
