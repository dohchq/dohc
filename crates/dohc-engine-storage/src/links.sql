-- Derived rows deliberately have no foreign keys to authoritative parents.
-- Cascade delete triggers must be able to leave a durable cleanup obligation.
CREATE TABLE link_pending (
    pending_id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    queued_at_ms INTEGER NOT NULL,
    retry_after_ms INTEGER NOT NULL DEFAULT 0,
    UNIQUE(workspace_id, version_id, object_id)
) STRICT;
CREATE TABLE link_index_state (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    parser_generation INTEGER NOT NULL,
    seed_after_object_id TEXT NOT NULL DEFAULT '',
    seed_phase TEXT NOT NULL DEFAULT 'deferred' CHECK(seed_phase IN ('deferred','aliases','draining','ready')),
    seed_after_path TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(workspace_id, version_id)
) STRICT;
-- This object lookup is derived, so initial capture need not maintain it.
CREATE TABLE link_aliases (
    workspace_id TEXT NOT NULL, version_id TEXT NOT NULL,
    object_id TEXT NOT NULL, path TEXT NOT NULL,
    PRIMARY KEY(workspace_id,version_id,object_id,path),
    UNIQUE(workspace_id,version_id,path)
) STRICT;
CREATE TABLE link_sources (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    path TEXT NOT NULL,
    title TEXT NOT NULL,
    parser_generation INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('indexed','unindexed')),
    reason TEXT CHECK(reason IN ('byte-bound','parse-refused')),
    index_key TEXT NOT NULL,
    CHECK((status='indexed' AND reason IS NULL) OR (status='unindexed' AND reason IS NOT NULL)),
    PRIMARY KEY(workspace_id, version_id, object_id)
) STRICT;
CREATE INDEX link_sources_path ON link_sources(workspace_id, version_id, path, object_id);
CREATE TABLE links (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    index_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    literal TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('wikilink','markdown')),
    fragment TEXT,
    start_utf16 INTEGER NOT NULL,
    end_utf16 INTEGER NOT NULL,
    line INTEGER NOT NULL,
    snippet TEXT NOT NULL,
    PRIMARY KEY(workspace_id, version_id, object_id, index_key, ordinal)
) STRICT;
CREATE TABLE link_occurrence_keys (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    index_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    key_kind TEXT NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY(workspace_id, version_id, object_id, index_key, ordinal, key_kind, key)
) STRICT;
CREATE INDEX link_occurrence_probe ON link_occurrence_keys(workspace_id, version_id, key_kind, key, object_id, ordinal);
CREATE TABLE link_target_keys (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    index_key TEXT NOT NULL,
    key_kind TEXT NOT NULL,
    key TEXT NOT NULL,
    PRIMARY KEY(workspace_id, version_id, object_id, index_key, key_kind, key)
) STRICT;
CREATE INDEX link_target_probe ON link_target_keys(workspace_id, version_id, key_kind, key, object_id);

CREATE TRIGGER link_snapshots_insert AFTER INSERT ON snapshots WHEN COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;
CREATE TRIGGER link_snapshots_delete AFTER DELETE ON snapshots WHEN COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(OLD.workspace_id,OLD.version_id,OLD.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;
CREATE TRIGGER link_snapshots_update AFTER UPDATE OF blob_sha256, binary_sha256, path, content_kind ON snapshots WHEN (OLD.blob_sha256 IS NOT NEW.blob_sha256 OR OLD.binary_sha256 IS NOT NEW.binary_sha256 OR OLD.path IS NOT NEW.path OR OLD.content_kind IS NOT NEW.content_kind) AND COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(OLD.workspace_id,OLD.version_id,OLD.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;

CREATE TRIGGER link_fork_base_snapshots_insert AFTER INSERT ON fork_base_snapshots WHEN COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;
CREATE TRIGGER link_fork_base_snapshots_delete AFTER DELETE ON fork_base_snapshots WHEN COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(OLD.workspace_id,OLD.version_id,OLD.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;
CREATE TRIGGER link_fork_base_snapshots_update AFTER UPDATE OF blob_sha256, binary_sha256, path, content_kind ON fork_base_snapshots WHEN (OLD.blob_sha256 IS NOT NEW.blob_sha256 OR OLD.binary_sha256 IS NOT NEW.binary_sha256 OR OLD.path IS NOT NEW.path OR OLD.content_kind IS NOT NEW.content_kind) AND COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(OLD.workspace_id,OLD.version_id,OLD.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;

CREATE TRIGGER link_path_aliases_insert AFTER INSERT ON path_aliases WHEN COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id),'ready')<>'deferred' BEGIN INSERT INTO link_aliases(workspace_id,version_id,object_id,path) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,NEW.path) ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;
CREATE TRIGGER link_path_aliases_delete AFTER DELETE ON path_aliases WHEN COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id),'ready')<>'deferred' BEGIN DELETE FROM link_aliases WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND path=OLD.path; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(OLD.workspace_id,OLD.version_id,OLD.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;
CREATE TRIGGER link_path_aliases_update AFTER UPDATE OF path, object_id ON path_aliases WHEN (OLD.path IS NOT NEW.path OR OLD.object_id IS NOT NEW.object_id) AND COALESCE((SELECT seed_phase FROM link_index_state WHERE workspace_id=NEW.workspace_id AND version_id=NEW.version_id),'ready')<>'deferred' BEGIN DELETE FROM link_aliases WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND path=OLD.path; INSERT INTO link_aliases(workspace_id,version_id,object_id,path) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,NEW.path) ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(OLD.workspace_id,OLD.version_id,OLD.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; INSERT INTO link_pending(workspace_id,version_id,object_id,queued_at_ms) VALUES(NEW.workspace_id,NEW.version_id,NEW.object_id,CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)) ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET revision=revision+1,queued_at_ms=excluded.queued_at_ms,retry_after_ms=0; END;

CREATE TRIGGER link_version_delete AFTER DELETE ON versions BEGIN
 DELETE FROM link_index_state WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id;
END;
INSERT INTO link_index_state(workspace_id,version_id,parser_generation) SELECT workspace_id,version_id,1 FROM versions;
CREATE TRIGGER link_version_insert AFTER INSERT ON versions BEGIN
 INSERT INTO link_index_state(workspace_id,version_id,parser_generation) VALUES(NEW.workspace_id,NEW.version_id,1);
END;

CREATE TABLE link_gc (
 workspace_id TEXT NOT NULL, version_id TEXT NOT NULL, object_id TEXT NOT NULL, index_key TEXT NOT NULL,
 PRIMARY KEY(workspace_id,version_id,object_id,index_key)
) STRICT;

-- The last certification clears the obligation in its publication transaction.
CREATE TRIGGER link_seed_completed AFTER DELETE ON link_pending
 WHEN NOT EXISTS(SELECT 1 FROM link_pending WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id)
 BEGIN UPDATE link_index_state SET seed_phase='ready',seed_after_path=''
 WHERE workspace_id=OLD.workspace_id AND version_id=OLD.version_id AND seed_phase='draining'; END;
