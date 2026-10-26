-- A person can have more than one agent, each with an id from their settings
-- file. Each agent has its own chat, and every run, its messages, and each
-- request it answers name the agent. The one agent chat a store already has
-- belongs to the default agent, and so do its runs and requests.
--
-- A message's sender now writes its requests, one per agent it wakes, so the
-- timestamp scan, its cursor, and its queue of local messages go. The request
-- ledger is rebuilt with the agent in its key; nothing refers to it, so the
-- rename runs in its normal mode.
ALTER TABLE chat_channels ADD COLUMN agent_id TEXT;
UPDATE chat_channels SET agent_id = 'default' WHERE kind = 'agent' AND slug = 'my-agent';
-- An earlier build refused another agent's chat and kept that chat's threads
-- in a hidden group for its wire id. The chat's create never comes again, so
-- the group becomes the agent's chat. A wire id whose suffix is not an agent id
-- is an ordinary wire id.
UPDATE chat_channels
SET kind = 'agent', name = substr(p.wire_id, 23), agent_id = substr(p.wire_id, 23)
FROM chat_channel_placeholders AS p
WHERE p.workspace_id = chat_channels.workspace_id
  AND p.channel_id = chat_channels.channel_id
  AND chat_channels.kind = 'channel'
  AND p.wire_id GLOB 'channel_wire_agent_v1_[a-z]*'
  AND length(p.wire_id) <= 22 + 64
  AND substr(p.wire_id, 23) NOT GLOB '*[^a-z0-9-]*'
  AND p.wire_id <> 'channel_wire_agent_v1_default';
DELETE FROM chat_channel_placeholders
WHERE wire_id GLOB 'channel_wire_agent_v1_*'
  AND EXISTS (SELECT 1 FROM chat_channels AS c
              WHERE c.workspace_id = chat_channel_placeholders.workspace_id
                AND c.channel_id = chat_channel_placeholders.channel_id
                AND c.agent_id IS NOT NULL);
CREATE UNIQUE INDEX idx_chat_channels_agent
    ON chat_channels(workspace_id, agent_id) WHERE agent_id IS NOT NULL;
ALTER TABLE chat_messages ADD COLUMN author_agent_id TEXT
    CHECK (author_agent_id IS NULL OR author_kind = 'agent');
ALTER TABLE agent_run_records ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'default';
CREATE TABLE chat_dispatch_ledger_next (
    workspace_id       TEXT    NOT NULL,
    trigger_message_id TEXT    NOT NULL,
    agent_id           TEXT    NOT NULL,
    thread_id          TEXT    NOT NULL,
    state              TEXT    NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed')),
    run_id             TEXT,
    failure_reason     TEXT,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    created_at_ms      INTEGER NOT NULL,
    updated_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, trigger_message_id, agent_id)
) STRICT;
INSERT INTO chat_dispatch_ledger_next
    (workspace_id, trigger_message_id, agent_id, thread_id, state, run_id, failure_reason,
     attempt_count, created_at_ms, updated_at_ms)
SELECT workspace_id, trigger_message_id, 'default', thread_id, state, run_id, failure_reason,
       attempt_count, created_at_ms, updated_at_ms
FROM chat_dispatch_ledger;
DROP TABLE chat_dispatch_ledger;
ALTER TABLE chat_dispatch_ledger_next RENAME TO chat_dispatch_ledger;
CREATE INDEX idx_chat_dispatch_ledger_state
    ON chat_dispatch_ledger(workspace_id, state, created_at_ms, trigger_message_id);
DROP TABLE chat_dispatch_scan_cursor;
DROP TABLE chat_dispatch_local_discovery;
