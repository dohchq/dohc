-- Cover identity hydration without scanning or sorting aliases across versions.
CREATE INDEX conversation_file_link_alias ON path_aliases(workspace_id,version_id,object_id,path);

-- Local derived data. State exists only after a conversation is requested.
CREATE TABLE chat_conversation_file_link_state (
 request_id INTEGER PRIMARY KEY AUTOINCREMENT,
 seed_turn INTEGER NOT NULL DEFAULT 0,
 workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0,
 seed_thread TEXT NOT NULL DEFAULT '', seed_message TEXT NOT NULL DEFAULT '',
 seed_time INTEGER NOT NULL DEFAULT 9223372036854775807, seed_done INTEGER NOT NULL DEFAULT 1,
 retry_at_ms INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
 seed_after TEXT NOT NULL DEFAULT '',
 seed_phase TEXT NOT NULL DEFAULT 'scan' CHECK(seed_phase IN ('scan','ready')),
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
 UNIQUE(workspace_id,channel_id)
) STRICT;
CREATE INDEX conversation_file_link_seed ON chat_conversation_file_link_state(seed_turn,request_id) WHERE seed_phase='scan';
CREATE TABLE chat_conversation_file_links (
 workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL, file_key TEXT NOT NULL,
 attachment_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT NOT NULL,
 mentioned_at_ms INTEGER NOT NULL,
 invalid INTEGER NOT NULL DEFAULT 0 CHECK(invalid IN (0,1)),
 PRIMARY KEY(workspace_id,channel_id,file_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX conversation_file_links_page ON chat_conversation_file_links
 (workspace_id,channel_id,mentioned_at_ms DESC,attachment_id DESC,file_key DESC) WHERE invalid=0;
CREATE INDEX conversation_file_links_thread ON chat_conversation_file_links(workspace_id,channel_id,thread_id,file_key);
CREATE TABLE chat_conversation_file_link_work (
 work_id INTEGER PRIMARY KEY AUTOINCREMENT,
 workspace_id TEXT NOT NULL, channel_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('file','thread','reset')), key TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0, phase INTEGER NOT NULL DEFAULT 0,
 after_message TEXT NOT NULL DEFAULT '', after_time INTEGER NOT NULL DEFAULT 9223372036854775807,
 after_id TEXT NOT NULL DEFAULT '',
 retry_at_ms INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0,
 UNIQUE(workspace_id,channel_id,kind,key)
) STRICT;
CREATE INDEX conversation_file_link_schedule ON chat_conversation_file_link_work(phase,work_id);
CREATE INDEX conversation_file_link_seed_threads ON chat_threads(workspace_id,channel_id,thread_id);
CREATE VIEW chat_conversation_file_link_candidates AS
 SELECT a.*,t.channel_id FROM chat_attachments a
 JOIN chat_messages m ON m.workspace_id=a.workspace_id AND m.thread_id=a.thread_id AND m.message_id=a.message_id
 JOIN chat_threads t ON t.workspace_id=a.workspace_id AND t.thread_id=a.thread_id
 JOIN chat_channels ch ON ch.workspace_id=t.workspace_id AND ch.channel_id=t.channel_id
 WHERE NOT EXISTS(SELECT 1 FROM chat_channel_placeholders p WHERE p.workspace_id=t.workspace_id AND p.channel_id=t.channel_id);

CREATE TRIGGER conversation_file_link_added AFTER INSERT ON chat_conversation_file_links BEGIN
 UPDATE chat_conversation_file_link_state SET revision=revision+1 WHERE workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
END;
CREATE TRIGGER conversation_file_link_changed AFTER UPDATE ON chat_conversation_file_links
 WHEN OLD.attachment_id IS NOT NEW.attachment_id OR OLD.invalid<>NEW.invalid OR OLD.mentioned_at_ms<>NEW.mentioned_at_ms BEGIN
 UPDATE chat_conversation_file_link_state SET revision=revision+1 WHERE workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
END;
CREATE TRIGGER conversation_file_link_removed AFTER DELETE ON chat_conversation_file_links BEGIN
 UPDATE chat_conversation_file_link_state SET revision=revision+1 WHERE workspace_id=OLD.workspace_id AND channel_id=OLD.channel_id;
END;
CREATE TRIGGER conversation_file_link_work_added AFTER INSERT ON chat_conversation_file_link_work BEGIN
 UPDATE chat_conversation_file_links SET invalid=1 WHERE NEW.kind='file' AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id AND file_key=NEW.key AND invalid=0;
 UPDATE chat_conversation_file_link_state SET revision=revision+1,
 seed_phase=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 'scan' ELSE seed_phase END,
 seed_after=CASE WHEN legacy=1 OR NEW.kind='reset' THEN '' ELSE seed_after END,
 seed_thread=CASE WHEN legacy=1 OR NEW.kind='reset' THEN '' ELSE seed_thread END,
 seed_message=CASE WHEN legacy=1 OR NEW.kind='reset' THEN '' ELSE seed_message END,
 seed_time=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 9223372036854775807 ELSE seed_time END,
 seed_done=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 1 ELSE seed_done END,
 retry_at_ms=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 0 ELSE retry_at_ms END,
 failures=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 0 ELSE failures END,
 legacy=0 WHERE NEW.kind<>'file' AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
END;
CREATE TRIGGER conversation_file_link_work_replaced AFTER UPDATE OF revision ON chat_conversation_file_link_work WHEN NEW.revision<>OLD.revision BEGIN
 UPDATE chat_conversation_file_links SET invalid=1 WHERE NEW.kind='file' AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id AND file_key=NEW.key AND invalid=0;
 UPDATE chat_conversation_file_link_state SET revision=revision+1,
 seed_phase=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 'scan' ELSE seed_phase END,
 seed_after=CASE WHEN legacy=1 OR NEW.kind='reset' THEN '' ELSE seed_after END,
 seed_thread=CASE WHEN legacy=1 OR NEW.kind='reset' THEN '' ELSE seed_thread END,
 seed_message=CASE WHEN legacy=1 OR NEW.kind='reset' THEN '' ELSE seed_message END,
 seed_time=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 9223372036854775807 ELSE seed_time END,
 seed_done=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 1 ELSE seed_done END,
 retry_at_ms=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 0 ELSE retry_at_ms END,
 failures=CASE WHEN legacy=1 OR NEW.kind='reset' THEN 0 ELSE failures END,
 legacy=0 WHERE NEW.kind<>'file' AND workspace_id=NEW.workspace_id AND channel_id=NEW.channel_id;
END;
CREATE TRIGGER conversation_file_link_attachment_added AFTER INSERT ON chat_attachments WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_links(workspace_id,channel_id,file_key,attachment_id,thread_id,message_id,mentioned_at_ms)
 SELECT a.workspace_id,a.channel_id,a.object_id,a.attachment_id,a.thread_id,a.message_id,a.created_at_ms
 FROM chat_conversation_file_link_candidates a JOIN chat_conversation_file_link_state s ON s.workspace_id=a.workspace_id AND s.channel_id=a.channel_id
 WHERE a.workspace_id=NEW.workspace_id AND a.attachment_id=NEW.attachment_id AND a.object_id IS NOT NULL
 ON CONFLICT(workspace_id,channel_id,file_key) DO UPDATE SET
 attachment_id=excluded.attachment_id,thread_id=excluded.thread_id,message_id=excluded.message_id,
 mentioned_at_ms=excluded.mentioned_at_ms,invalid=0
 WHERE (excluded.mentioned_at_ms,excluded.attachment_id)>(chat_conversation_file_links.mentioned_at_ms,chat_conversation_file_links.attachment_id);
 UPDATE chat_conversation_file_link_work SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='' WHERE workspace_id=NEW.workspace_id AND kind='file' AND key=NEW.object_id AND channel_id IN (SELECT channel_id FROM chat_conversation_file_link_candidates WHERE workspace_id=NEW.workspace_id AND attachment_id=NEW.attachment_id);
 UPDATE chat_conversation_file_link_state SET legacy=1 WHERE (workspace_id,channel_id) IN
 (SELECT workspace_id,channel_id FROM chat_conversation_file_link_candidates WHERE workspace_id=NEW.workspace_id AND attachment_id=NEW.attachment_id AND object_id IS NULL);
END;
CREATE TRIGGER conversation_file_link_attachment_removed BEFORE DELETE ON chat_attachments WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'file',OLD.object_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND OLD.object_id IS NOT NULL AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=OLD.workspace_id AND t.thread_id=OLD.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'thread',OLD.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND OLD.object_id IS NULL AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=OLD.workspace_id AND t.thread_id=OLD.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_attachment_changed AFTER UPDATE ON chat_attachments WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'file',OLD.object_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND OLD.object_id IS NOT NULL AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=OLD.workspace_id AND t.thread_id=OLD.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,s.channel_id,'thread',OLD.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND OLD.object_id IS NULL AND s.channel_id=(SELECT t.channel_id FROM chat_threads t WHERE t.workspace_id=OLD.workspace_id AND t.thread_id=OLD.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
 INSERT INTO chat_conversation_file_links(workspace_id,channel_id,file_key,attachment_id,thread_id,message_id,mentioned_at_ms)
 SELECT a.workspace_id,a.channel_id,a.object_id,a.attachment_id,a.thread_id,a.message_id,a.created_at_ms
 FROM chat_conversation_file_link_candidates a JOIN chat_conversation_file_link_state s ON s.workspace_id=a.workspace_id AND s.channel_id=a.channel_id
 WHERE a.workspace_id=NEW.workspace_id AND a.attachment_id=NEW.attachment_id AND a.object_id IS NOT NULL
 ON CONFLICT(workspace_id,channel_id,file_key) DO UPDATE SET
 attachment_id=excluded.attachment_id,thread_id=excluded.thread_id,message_id=excluded.message_id,
 mentioned_at_ms=excluded.mentioned_at_ms,invalid=0
 WHERE (excluded.mentioned_at_ms,excluded.attachment_id)>(chat_conversation_file_links.mentioned_at_ms,chat_conversation_file_links.attachment_id);
 UPDATE chat_conversation_file_link_work SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='' WHERE workspace_id=NEW.workspace_id AND kind='file' AND key=NEW.object_id AND channel_id IN (SELECT channel_id FROM chat_conversation_file_link_candidates WHERE workspace_id=NEW.workspace_id AND attachment_id=NEW.attachment_id);
 UPDATE chat_conversation_file_link_state SET legacy=1 WHERE (workspace_id,channel_id) IN
 (SELECT workspace_id,channel_id FROM chat_conversation_file_link_candidates WHERE workspace_id=NEW.workspace_id AND attachment_id=NEW.attachment_id AND object_id IS NULL);
END;
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
CREATE TRIGGER conversation_file_link_thread_insert AFTER INSERT ON chat_threads WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT NEW.workspace_id,NEW.channel_id,'thread',NEW.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=NEW.workspace_id AND s.channel_id=NEW.channel_id AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=NEW.workspace_id AND a.thread_id=NEW.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_thread_delete BEFORE DELETE ON chat_threads WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,OLD.channel_id,'thread',OLD.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND s.channel_id=OLD.channel_id AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=OLD.workspace_id AND a.thread_id=OLD.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_thread_update BEFORE UPDATE ON chat_threads WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' AND (OLD.workspace_id IS NOT NEW.workspace_id OR OLD.thread_id IS NOT NEW.thread_id OR OLD.channel_id IS NOT NEW.channel_id) BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,OLD.channel_id,'thread',OLD.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND s.channel_id=OLD.channel_id AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=OLD.workspace_id AND a.thread_id=OLD.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT NEW.workspace_id,NEW.channel_id,'thread',NEW.thread_id FROM chat_conversation_file_link_state s WHERE s.workspace_id=NEW.workspace_id AND s.channel_id=NEW.channel_id AND EXISTS(SELECT 1 FROM chat_attachments a WHERE a.workspace_id=NEW.workspace_id AND a.thread_id=NEW.thread_id)
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_chat_channels_delete AFTER DELETE ON chat_channels WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,OLD.channel_id,'reset','' FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND s.channel_id=OLD.channel_id
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_chat_channels_insert AFTER INSERT ON chat_channels WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT NEW.workspace_id,NEW.channel_id,'reset','' FROM chat_conversation_file_link_state s WHERE s.workspace_id=NEW.workspace_id AND s.channel_id=NEW.channel_id
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_chat_channel_placeholders_insert AFTER INSERT ON chat_channel_placeholders WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT NEW.workspace_id,NEW.channel_id,'reset','' FROM chat_conversation_file_link_state s WHERE s.workspace_id=NEW.workspace_id AND s.channel_id=NEW.channel_id
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
CREATE TRIGGER conversation_file_link_chat_channel_placeholders_delete AFTER DELETE ON chat_channel_placeholders WHEN (SELECT store_role FROM engine_ownership WHERE rowid_guard=1)='owner' BEGIN
 INSERT INTO chat_conversation_file_link_work(workspace_id,channel_id,kind,key)
 SELECT OLD.workspace_id,OLD.channel_id,'reset','' FROM chat_conversation_file_link_state s WHERE s.workspace_id=OLD.workspace_id AND s.channel_id=OLD.channel_id
 ON CONFLICT(workspace_id,channel_id,kind,key) DO UPDATE SET revision=revision+1,retry_at_ms=0,failures=0,phase=0,after_message='',after_time=9223372036854775807,after_id='';
END;
