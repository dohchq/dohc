-- The relay log's head that a share view's first page named, written before
-- any op of that page applies and never changed. A later page applies a move
-- marked across the member's reach only at or below it. It lives beside
-- `share_view_cursors` rather than in it, since a row there means the copy has
-- committed a cursor.
CREATE TABLE share_view_fences (
    workspace_id TEXT NOT NULL,
    share_id     TEXT NOT NULL,
    log_head     INTEGER NOT NULL CHECK (log_head >= 0),
    PRIMARY KEY (workspace_id, share_id)
) STRICT;
