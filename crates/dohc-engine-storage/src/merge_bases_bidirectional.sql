ALTER TABLE merge_bases RENAME TO merge_bases_v1;

CREATE TABLE merge_bases (
    workspace_id TEXT NOT NULL,
    source_version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    base_exists INTEGER NOT NULL CHECK (base_exists IN (0, 1)),
    base_object_id TEXT,
    base_content_kind TEXT CHECK (base_content_kind IN ('text', 'binary')),
    base_blob_sha256 TEXT REFERENCES blobs(sha256),
    base_binary_sha256 TEXT REFERENCES binary_blobs(sha256),
    base_updated_at_ms INTEGER,
    base_latest_moment_id TEXT,
    base_metadata_origin TEXT,
    base_metadata_summary TEXT,
    base_metadata_correlation_id TEXT,
    prior_exists INTEGER NOT NULL CHECK (prior_exists IN (0, 1)),
    prior_object_id TEXT,
    prior_content_kind TEXT CHECK (prior_content_kind IN ('text', 'binary')),
    prior_blob_sha256 TEXT REFERENCES blobs(sha256),
    prior_binary_sha256 TEXT REFERENCES binary_blobs(sha256),
    prior_updated_at_ms INTEGER,
    prior_latest_moment_id TEXT,
    prior_metadata_origin TEXT,
    prior_metadata_summary TEXT,
    prior_metadata_correlation_id TEXT,
    target_before_kind TEXT CHECK (target_before_kind IN ('text', 'binary')),
    target_before_sha256 TEXT,
    target_after_kind TEXT CHECK (target_after_kind IN ('text', 'binary')),
    target_after_sha256 TEXT,
    merged_into TEXT NOT NULL DEFAULT 'main' CHECK (merged_into IN ('main', 'named')),
    merge_seq INTEGER NOT NULL DEFAULT 1,
    CHECK (base_exists = 0 OR (base_object_id IS NOT NULL AND base_updated_at_ms IS NOT NULL
        AND base_latest_moment_id IS NOT NULL AND base_metadata_origin IS NOT NULL
        AND ((base_content_kind = 'text' AND base_blob_sha256 IS NOT NULL AND base_binary_sha256 IS NULL)
          OR (base_content_kind = 'binary' AND base_binary_sha256 IS NOT NULL AND base_blob_sha256 IS NULL)))),
    CHECK (prior_exists = 0 OR (prior_object_id IS NOT NULL AND prior_updated_at_ms IS NOT NULL
        AND prior_latest_moment_id IS NOT NULL AND prior_metadata_origin IS NOT NULL
        AND ((prior_content_kind = 'text' AND prior_blob_sha256 IS NOT NULL AND prior_binary_sha256 IS NULL)
          OR (prior_content_kind = 'binary' AND prior_binary_sha256 IS NOT NULL AND prior_blob_sha256 IS NULL)))),
    CHECK ((target_before_kind IS NULL) = (target_before_sha256 IS NULL)),
    CHECK ((target_after_kind IS NULL) = (target_after_sha256 IS NULL)),
    PRIMARY KEY (workspace_id, source_version_id, path, merged_into),
    FOREIGN KEY (workspace_id, source_version_id)
        REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;

INSERT INTO merge_bases SELECT *, 'main', 1 FROM merge_bases_v1;
DROP TABLE merge_bases_v1;

CREATE INDEX merge_bases_base_binary ON merge_bases(base_binary_sha256)
    WHERE base_binary_sha256 IS NOT NULL;
CREATE INDEX merge_bases_prior_binary ON merge_bases(prior_binary_sha256)
    WHERE prior_binary_sha256 IS NOT NULL;

CREATE TABLE secret_merge_bases (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
    merged_into TEXT NOT NULL DEFAULT 'main' CHECK (merged_into IN ('main', 'named')),
    merge_seq INTEGER NOT NULL DEFAULT 1,
    base_exists INTEGER NOT NULL CHECK (base_exists IN (0, 1)),
    iv_base64 TEXT,
    auth_tag_base64 TEXT,
    ciphertext_base64 TEXT,
    byte_length INTEGER,
    prior_exists INTEGER NOT NULL CHECK (prior_exists IN (0, 1)),
    prior_iv_base64 TEXT,
    prior_auth_tag_base64 TEXT,
    prior_ciphertext_base64 TEXT,
    prior_byte_length INTEGER,
    target_before_sha256 TEXT,
    target_after_sha256 TEXT,
    CHECK (base_exists = 0 OR (iv_base64 IS NOT NULL AND auth_tag_base64 IS NOT NULL
        AND ciphertext_base64 IS NOT NULL AND byte_length IS NOT NULL)),
    CHECK (prior_exists = 0 OR (prior_iv_base64 IS NOT NULL AND prior_auth_tag_base64 IS NOT NULL
        AND prior_ciphertext_base64 IS NOT NULL AND prior_byte_length IS NOT NULL)),
    PRIMARY KEY (workspace_id, version_id, path, merged_into),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;
