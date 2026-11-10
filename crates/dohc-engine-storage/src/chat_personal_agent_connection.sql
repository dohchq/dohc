-- A personal agent's message names the connection it signed in with. Only the
-- relay writes one, from that agent's own origin, so only an agent message
-- whose author is a personal agent names one.
ALTER TABLE chat_messages ADD COLUMN personal_agent_connection_id TEXT
    CHECK (personal_agent_connection_id IS NULL OR (author_kind = 'agent'
        AND author_agent_id IS NOT NULL AND author_agent_id GLOB 'p-*'
        AND length(personal_agent_connection_id) > 0));
