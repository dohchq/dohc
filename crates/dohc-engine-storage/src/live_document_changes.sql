CREATE TABLE live_document_changes (
    workspace_id TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('pending','last')),
    object_id TEXT NOT NULL,
    change_id TEXT,
    action TEXT NOT NULL CHECK (action IN ('stopped','resumed')),
    path TEXT NOT NULL,
    before_status TEXT CHECK (before_status IN ('ready','preparing','paused','retired','unavailable','absent')),
    at_ms INTEGER NOT NULL CHECK (at_ms >= 0),
    author_json TEXT NOT NULL CHECK (json_valid(author_json)),
    CHECK ((slot = 'pending') = (change_id IS NOT NULL)),
    CHECK ((slot = 'pending') = (before_status IS NOT NULL)),
    PRIMARY KEY(workspace_id,slot,object_id)
) STRICT;
