-- An agent you run reads a request in a thread it posted in. This index finds
-- the threads one agent posted in without reading every message.
CREATE INDEX idx_chat_messages_agent_author
    ON chat_messages(workspace_id, author_agent_id, thread_id)
    WHERE author_agent_id IS NOT NULL;
