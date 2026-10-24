CREATE TABLE live_accepted_reader_history (
    relay_database_namespace TEXT NOT NULL,
    workspace_id TEXT NOT NULL REFERENCES versioned_workspaces(workspace_id) ON DELETE CASCADE,
    main_version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    lineage_claim_id TEXT NOT NULL,
    may_have_reader INTEGER NOT NULL CHECK (may_have_reader IN (0,1)),
    PRIMARY KEY (relay_database_namespace,workspace_id,main_version_id,object_id,lineage_claim_id)
) STRICT;
