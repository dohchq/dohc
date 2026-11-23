CREATE TABLE chat_reactions_next (
    workspace_id        TEXT    NOT NULL,
    reaction_id         TEXT    NOT NULL,
    thread_id           TEXT    NOT NULL,
    message_id          TEXT    NOT NULL,
    emoji               TEXT    NOT NULL,
    author_id           TEXT    NOT NULL,
    author_kind         TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent')),
    author_agent_id     TEXT    NOT NULL DEFAULT ''
        CHECK (author_agent_id = '' OR author_kind = 'agent'),
    author_display_name TEXT    NOT NULL,
    state               TEXT    NOT NULL CHECK (state IN ('added', 'removed')),
    at_ms               INTEGER NOT NULL,
    origin_id           TEXT    NOT NULL,
    origin_seq          INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id, emoji, author_id, author_kind, author_agent_id)
) STRICT;
INSERT INTO chat_reactions_next
    (workspace_id, reaction_id, thread_id, message_id, emoji, author_id, author_kind,
     author_display_name, state, at_ms, origin_id, origin_seq)
SELECT workspace_id, reaction_id, thread_id, message_id, emoji, author_id, author_kind,
       author_display_name, state, at_ms, origin_id, origin_seq
FROM chat_reactions;
DROP TABLE chat_reactions;
ALTER TABLE chat_reactions_next RENAME TO chat_reactions;
CREATE INDEX idx_chat_reactions_thread
    ON chat_reactions(workspace_id, thread_id, message_id);
