-- What an agent reports about work it does outside dohc: a status and an
-- optional link to where the work is. Only an agent message carries one. A
-- thread's Work card shows its newest report, which the index finds.
ALTER TABLE chat_messages ADD COLUMN work TEXT
    CHECK (work IS NULL OR (author_kind = 'agent' AND json_valid(work)));

CREATE INDEX idx_chat_messages_thread_work
    ON chat_messages(workspace_id, thread_id, created_at_ms DESC, message_id DESC)
    WHERE work IS NOT NULL;
