-- Each attributed update keeps its author until a settlement names it, or an
-- accepted delivery of the same update names the same author.
-- coverage: 'update' while its update holds the author; 'interval' once a
-- fold removed the journal row or an accepted delivery did not name the
-- author; 'moment' while an unresolved settlement's moment names it;
-- 'replaced' when an accepted delivery named it after that moment.
CREATE TABLE ydoc_native_authors (
    workspace_id     TEXT    NOT NULL,
    version_id       TEXT    NOT NULL,
    object_id        TEXT    NOT NULL,
    lineage_claim_id TEXT    NOT NULL,
    update_digest    TEXT    NOT NULL,
    seq              INTEGER NOT NULL CHECK (seq > 0),
    actor_origin_id  TEXT    NOT NULL,
    actor_kind       TEXT    NOT NULL CHECK (actor_kind IN ('human','agent','automation')),
    on_behalf_of     TEXT,
    chain_depth      INTEGER NOT NULL CHECK (chain_depth >= 0),
    agent_run_id     TEXT
        CHECK (agent_run_id IS NULL OR (actor_kind = 'agent' AND length(agent_run_id) > 0)),
    coverage         TEXT    NOT NULL DEFAULT 'update'
        CHECK (coverage IN ('update','interval','moment','replaced')),
    -- The bytes admission counts for this author in a moment's author list:
    -- its entry, with each identifier escaped as JSON escapes it, and room
    -- for its depth to grow. The depth adds the same bytes at every value.
    author_bytes     INTEGER GENERATED ALWAYS AS (
        CASE actor_kind WHEN 'human' THEN 27 WHEN 'agent' THEN 38 ELSE 48 END
        + length(CAST(json_quote(actor_origin_id) AS BLOB))
        + CASE WHEN on_behalf_of IS NULL THEN 0
               ELSE 14 + length(CAST(json_quote(on_behalf_of) AS BLOB)) END
        + CASE WHEN agent_run_id IS NULL THEN 0
               ELSE 14 + length(CAST(json_quote(agent_run_id) AS BLOB)) END) VIRTUAL,
    PRIMARY KEY (workspace_id, version_id, object_id, lineage_claim_id, update_digest),
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id)
      ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- A read of one coverage skips the rows of every other, and reads its rows
-- one identity at a time, so admission finds an identity with one seek.
CREATE INDEX ydoc_native_authors_coverage
    ON ydoc_native_authors (workspace_id, version_id, object_id, coverage,
                            actor_origin_id, actor_kind, on_behalf_of, agent_run_id,
                            chain_depth, seq);
-- The interval-wide rows above, one per identity and depth with their count,
-- so admission reads each identity once however many updates it wrote. A
-- missing scope or run is ''; a recorded one is never empty.
CREATE TABLE ydoc_native_interval_authors (
    workspace_id    TEXT    NOT NULL,
    version_id      TEXT    NOT NULL,
    object_id       TEXT    NOT NULL,
    actor_origin_id TEXT    NOT NULL,
    actor_kind      TEXT    NOT NULL CHECK (actor_kind IN ('human','agent','automation')),
    on_behalf_of    TEXT    NOT NULL,
    agent_run_id    TEXT    NOT NULL,
    chain_depth     INTEGER NOT NULL CHECK (chain_depth >= 0),
    updates         INTEGER NOT NULL CHECK (updates > 0),
    PRIMARY KEY (workspace_id, version_id, object_id, actor_origin_id, actor_kind,
                 on_behalf_of, agent_run_id, chain_depth),
    FOREIGN KEY (workspace_id, version_id, object_id)
      REFERENCES ydoc_docs(workspace_id, version_id, object_id)
      ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
-- How many identities an update still holds the author of on this document,
-- and their author_bytes. A held lineage's release brings them all into its
-- interval at once, so its admission counts a new identity with one read.
ALTER TABLE ydoc_docs ADD COLUMN private_authors INTEGER NOT NULL DEFAULT 0
    CHECK (private_authors >= 0);
ALTER TABLE ydoc_docs ADD COLUMN private_author_bytes INTEGER NOT NULL DEFAULT 0
    CHECK (private_author_bytes >= 0);
-- An identity counts from its first 'update' row until its last one goes or
-- leaves 'update'. No row returns to 'update'. Each check is one seek.
CREATE TRIGGER ydoc_native_private_author_added AFTER INSERT ON ydoc_native_authors
WHEN NEW.coverage = 'update' AND NOT EXISTS (
    SELECT 1 FROM ydoc_native_authors o
    WHERE o.workspace_id = NEW.workspace_id AND o.version_id = NEW.version_id
      AND o.object_id = NEW.object_id AND o.coverage = 'update'
      AND o.actor_origin_id = NEW.actor_origin_id AND o.actor_kind = NEW.actor_kind
      AND o.on_behalf_of IS NEW.on_behalf_of AND o.agent_run_id IS NEW.agent_run_id
      AND (o.lineage_claim_id <> NEW.lineage_claim_id OR o.update_digest <> NEW.update_digest))
BEGIN
    UPDATE ydoc_docs SET private_authors = private_authors + 1,
        private_author_bytes = private_author_bytes + NEW.author_bytes
    WHERE workspace_id = NEW.workspace_id AND version_id = NEW.version_id
      AND object_id = NEW.object_id;
END;
CREATE TRIGGER ydoc_native_private_author_deleted AFTER DELETE ON ydoc_native_authors
WHEN OLD.coverage = 'update' AND NOT EXISTS (
    SELECT 1 FROM ydoc_native_authors o
    WHERE o.workspace_id = OLD.workspace_id AND o.version_id = OLD.version_id
      AND o.object_id = OLD.object_id AND o.coverage = 'update'
      AND o.actor_origin_id = OLD.actor_origin_id AND o.actor_kind = OLD.actor_kind
      AND o.on_behalf_of IS OLD.on_behalf_of AND o.agent_run_id IS OLD.agent_run_id)
BEGIN
    UPDATE ydoc_docs SET private_authors = private_authors - 1,
        private_author_bytes = private_author_bytes - OLD.author_bytes
    WHERE workspace_id = OLD.workspace_id AND version_id = OLD.version_id
      AND object_id = OLD.object_id;
END;
CREATE TRIGGER ydoc_native_private_author_covered AFTER UPDATE OF coverage ON ydoc_native_authors
WHEN OLD.coverage = 'update' AND NEW.coverage <> 'update' AND NOT EXISTS (
    SELECT 1 FROM ydoc_native_authors o
    WHERE o.workspace_id = OLD.workspace_id AND o.version_id = OLD.version_id
      AND o.object_id = OLD.object_id AND o.coverage = 'update'
      AND o.actor_origin_id = OLD.actor_origin_id AND o.actor_kind = OLD.actor_kind
      AND o.on_behalf_of IS OLD.on_behalf_of AND o.agent_run_id IS OLD.agent_run_id)
BEGIN
    UPDATE ydoc_docs SET private_authors = private_authors - 1,
        private_author_bytes = private_author_bytes - OLD.author_bytes
    WHERE workspace_id = OLD.workspace_id AND version_id = OLD.version_id
      AND object_id = OLD.object_id;
END;
-- Unsettled updates already in the journal keep their authors.
INSERT OR IGNORE INTO ydoc_native_authors
    (workspace_id, version_id, object_id, lineage_claim_id, update_digest, seq,
     actor_origin_id, actor_kind, on_behalf_of, chain_depth, agent_run_id)
SELECT u.workspace_id, u.version_id, u.object_id, COALESCE(d.lineage_claim_id, ''),
       u.update_blob_sha256, u.seq, u.actor_origin_id, u.actor_kind, u.on_behalf_of,
       COALESCE(u.chain_depth, 0), u.agent_run_id
FROM ydoc_updates u JOIN ydoc_docs d
  ON d.workspace_id = u.workspace_id AND d.version_id = u.version_id
 AND d.object_id = u.object_id
WHERE u.is_seed = 0 AND u.actor_origin_id IS NOT NULL AND u.actor_kind IS NOT NULL
  AND u.seq > COALESCE(d.settled_update_seq, -1);
