-- A live edit an agent made in a run names that run, so two runs by one
-- agent stay two authors. Rows written before this name none.
ALTER TABLE ydoc_updates ADD COLUMN agent_run_id TEXT
    CHECK (agent_run_id IS NULL OR (actor_kind = 'agent' AND length(agent_run_id) > 0));
