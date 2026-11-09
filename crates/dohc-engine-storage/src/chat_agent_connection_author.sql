-- An agent that signs in with a share link posts as that link's principal.
-- Its message also names its agent connection, which only the relay writes,
-- so only a link message names one.
ALTER TABLE chat_messages ADD COLUMN agent_connection_id TEXT
    CHECK (agent_connection_id IS NULL OR (author_kind = 'link' AND link_principal_id IS NOT NULL
        AND length(agent_connection_id) > 0));
