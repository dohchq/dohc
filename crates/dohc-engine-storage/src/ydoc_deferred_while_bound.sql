-- A service host's update that an owner queued while a binding not released by
-- a Stop existed for its lineage. A held update is decided only after the feed
-- that could deliver its echo has ended for good: when its binding is deleted,
-- when a Stop is recorded, at the first pass after the device becomes the
-- note's own live host, at a restore fence, or at the re-judge after the
-- binding is rebound. A device that is a note's own live host holds nothing;
-- its host updates are decided as on main. Anything else decides nothing, and
-- checks that the note's queue is empty skip the held update. Deciding it, an
-- echo leaves and anything else is refused as on arrival. A lineage is not
-- bound again while one of these remains. Rows already queued stay unmarked:
-- an older build queued none while bound, so each was queued with no binding
-- and is decided as before.
ALTER TABLE ydoc_deferred_updates ADD COLUMN deferred_while_bound INTEGER NOT NULL DEFAULT 0
    CHECK (deferred_while_bound IN (0, 1));
CREATE INDEX ydoc_deferred_updates_while_bound
    ON ydoc_deferred_updates(workspace_id, version_id, object_id, lineage_claim_id)
    WHERE deferred_while_bound=1;
