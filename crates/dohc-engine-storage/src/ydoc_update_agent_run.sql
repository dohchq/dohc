-- A live edit an agent made in a run names that run, so two runs by one
-- agent stay two authors. Rows written before this name none.
ALTER TABLE ydoc_updates ADD COLUMN agent_run_id TEXT
    CHECK (agent_run_id IS NULL OR (actor_kind = 'agent' AND length(agent_run_id) > 0));
-- A queued owner draft keeps the run beside its declared agent. The
-- declaration a recipient sees never names it.
ALTER TABLE owner_ydoc_outbox_entries ADD COLUMN agent_run_id TEXT
    CHECK (agent_run_id IS NULL OR (agent_declaration_json IS NOT NULL AND length(agent_run_id) > 0));
