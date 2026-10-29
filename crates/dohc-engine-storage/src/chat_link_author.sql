-- A link holder posts through a share link, and only the relay writes that
-- message. It names the link grant and link principal, and no account, owner,
-- origin, automation or actor key. SQLite cannot change a CHECK in place, so
-- the message and mention tables are rebuilt with every row kept.
--
-- While chat_messages is gone, the conversation-links view and the triggers
-- that read it name a missing table, so the rename runs in legacy mode, which
-- leaves them alone. DROP TABLE takes the message triggers with it, and with
-- foreign keys on it cascades into the dispatch discovery rows. Those rows are
-- set aside and cleared first, so the migration runs the same either way, and
-- both are put back unchanged.
PRAGMA legacy_alter_table=ON;
CREATE TABLE chat_messages_next (
    workspace_id              TEXT    NOT NULL,
    thread_id                 TEXT    NOT NULL,
    message_order             INTEGER NOT NULL,
    message_id                TEXT    NOT NULL,
    author_kind               TEXT    NOT NULL
                              CHECK (author_kind IN ('human', 'agent', 'automation', 'link')),
    author_display_name       TEXT    NOT NULL,
    author_user_id            TEXT,
    parent_message_id         TEXT,
    origin                    TEXT,
    body                      TEXT    NOT NULL,
    created_at_ms             INTEGER NOT NULL,
    author_owner_display_name TEXT,
    automation_id             TEXT,
    chain_depth               INTEGER CHECK (chain_depth IS NULL OR chain_depth >= 1),
    author_actor_key          TEXT CHECK (author_actor_key IS NULL OR json_valid(author_actor_key)),
    link_grant_id             TEXT,
    link_principal_id         TEXT,
    PRIMARY KEY (workspace_id, message_id),
    UNIQUE (workspace_id, thread_id, message_order),
    FOREIGN KEY (workspace_id, thread_id)
      REFERENCES chat_threads(workspace_id, thread_id) ON DELETE CASCADE,
    CHECK ((automation_id IS NULL) = (chain_depth IS NULL)),
    CHECK (automation_id IS NULL OR author_kind = 'automation'),
    CHECK ((author_kind = 'link') = (link_grant_id IS NOT NULL)),
    CHECK ((link_grant_id IS NULL) = (link_principal_id IS NULL)),
    CHECK (author_kind <> 'link' OR (author_user_id IS NULL AND author_owner_display_name IS NULL
                                     AND origin IS NULL AND author_actor_key IS NULL))
) STRICT;
INSERT INTO chat_messages_next
    (workspace_id, thread_id, message_order, message_id, author_kind, author_display_name,
     author_user_id, parent_message_id, origin, body, created_at_ms, author_owner_display_name,
     automation_id, chain_depth, author_actor_key)
SELECT workspace_id, thread_id, message_order, message_id, author_kind, author_display_name,
       author_user_id, parent_message_id, origin, body, created_at_ms, author_owner_display_name,
       automation_id, chain_depth, author_actor_key
FROM chat_messages;
CREATE TABLE chat_dispatch_local_discovery_kept (
    workspace_id TEXT NOT NULL,
    message_id   TEXT NOT NULL
) STRICT;
INSERT INTO chat_dispatch_local_discovery_kept (workspace_id, message_id)
SELECT workspace_id, message_id FROM chat_dispatch_local_discovery;
DELETE FROM chat_dispatch_local_discovery;
DROP TABLE chat_messages;
ALTER TABLE chat_messages_next RENAME TO chat_messages;
INSERT INTO chat_dispatch_local_discovery (workspace_id, message_id)
SELECT workspace_id, message_id FROM chat_dispatch_local_discovery_kept;
DROP TABLE chat_dispatch_local_discovery_kept;
CREATE INDEX idx_chat_messages_thread_order
    ON chat_messages(workspace_id, thread_id, message_order);
CREATE INDEX idx_chat_messages_thread_created
    ON chat_messages(workspace_id, thread_id, created_at_ms, message_id);
CREATE INDEX idx_chat_messages_workspace_created
    ON chat_messages(workspace_id, created_at_ms, message_id);
CREATE INDEX idx_chat_messages_author_feed
    ON chat_messages(workspace_id, author_user_id, author_kind, created_at_ms DESC, message_id DESC);
CREATE TRIGGER conversation_file_link_message_insert AFTER INSERT ON chat_messages WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_links(workspace_id,channel_id,file_key,attachment_id,thread_id,message_id,mentioned_at_ms)
 SELECT a.workspace_id,a.channel_id,a.object_id,a.attachment_id,a.thread_id,a.message_id,a.created_at_ms
 FROM chat_conversation_file_link_candidates a JOIN chat_conversation_file_link_state s ON s.workspace_id=a.workspace_id AND s.channel_id=a.channel_id
 WHERE a.workspace_id=NEW.workspace_id AND a.thread_id=NEW.thread_id AND a.message_id=NEW.message_id AND a.object_id IS NOT NULL
 ON CONFLICT(workspace_id,channel_id,file_key) DO UPDATE SET
 attachment_id=excluded.attachment_id,thread_id=excluded.thread_id,message_id=excluded.message_id,
 mentioned_at_ms=excluded.mentioned_at_ms,invalid=0
 WHERE (excluded.mentioned_at_ms,excluded.attachment_id)>(chat_conversation_file_links.mentioned_at_ms,chat_conversation_file_links.attachment_id);
 UPDATE chat_conversation_file_link_work SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='' WHERE workspace_id=NEW.workspace_id AND kind='file' AND key IN (SELECT object_id FROM chat_attachments WHERE workspace_id=NEW.workspace_id AND thread_id=NEW.thread_id AND message_id=NEW.message_id AND object_id IS NOT NULL) AND channel_id IN (SELECT channel_id FROM chat_conversation_file_link_candidates WHERE workspace_id=NEW.workspace_id AND thread_id=NEW.thread_id AND message_id=NEW.message_id);
 UPDATE chat_conversation_file_link_state SET legacy=1 WHERE (workspace_id,channel_id) IN
 (SELECT workspace_id,channel_id FROM chat_conversation_file_link_candidates WHERE workspace_id=NEW.workspace_id AND thread_id=NEW.thread_id AND message_id=NEW.message_id AND object_id IS NULL);
END;
CREATE TRIGGER conversation_file_link_message_delete BEFORE DELETE ON chat_messages WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'file',a.object_id FROM chat_attachments a
 JOIN chat_threads t ON t.workspace_id=a.workspace_id AND t.thread_id=a.thread_id
 JOIN chat_conversation_file_link_state s ON s.workspace_id=t.workspace_id AND s.channel_id=t.channel_id
 WHERE a.workspace_id=OLD.workspace_id AND a.thread_id=OLD.thread_id AND a.message_id=OLD.message_id AND a.object_id IS NOT NULL GROUP BY a.object_id
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'thread',OLD.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=OLD.workspace_id AND t.thread_id=OLD.thread_id) AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=OLD.workspace_id AND a.thread_id=OLD.thread_id AND a.message_id=OLD.message_id AND a.object_id IS NULL)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_message_update BEFORE UPDATE OF workspace_id,thread_id,message_id ON chat_messages WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' AND (OLD.workspace_id IS NOT NEW.workspace_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.message_id IS NOT NEW.message_id) BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'thread',OLD.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=OLD.workspace_id AND t.thread_id=OLD.thread_id) AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=OLD.workspace_id AND a.thread_id=OLD.thread_id AND a.message_id=OLD.message_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT NEW.workspace_id,s.channel_id,'thread',NEW.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=NEW.workspace_id AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=NEW.workspace_id AND t.thread_id=NEW.thread_id) AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=NEW.workspace_id AND a.thread_id=NEW.thread_id AND a.message_id=NEW.message_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TABLE chat_mentions_next (
    workspace_id  TEXT    NOT NULL,
    thread_id     TEXT    NOT NULL,
    message_id    TEXT    NOT NULL,
    handle        TEXT    NOT NULL,
    author_kind   TEXT    NOT NULL CHECK (author_kind IN ('human', 'agent', 'automation', 'link')),
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, message_id, handle)
) STRICT;
INSERT INTO chat_mentions_next
    (workspace_id, thread_id, message_id, handle, author_kind, created_at_ms)
SELECT workspace_id, thread_id, message_id, handle, author_kind, created_at_ms
FROM chat_mentions;
DROP TABLE chat_mentions;
ALTER TABLE chat_mentions_next RENAME TO chat_mentions;
CREATE INDEX idx_chat_mentions_handle
    ON chat_mentions(workspace_id, handle, created_at_ms, message_id);
PRAGMA legacy_alter_table=OFF;
