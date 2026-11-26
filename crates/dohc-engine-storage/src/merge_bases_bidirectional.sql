ALTER TABLE merge_bases ADD COLUMN merged_into TEXT NOT NULL DEFAULT 'main'
    CHECK (merged_into IN ('main', 'named'));

CREATE TABLE secret_merge_bases (
    workspace_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    path TEXT NOT NULL,
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
    merged_into TEXT NOT NULL DEFAULT 'main' CHECK (merged_into IN ('main', 'named')),
    CHECK (base_exists = 0 OR (iv_base64 IS NOT NULL AND auth_tag_base64 IS NOT NULL
        AND ciphertext_base64 IS NOT NULL AND byte_length IS NOT NULL)),
    CHECK (prior_exists = 0 OR (prior_iv_base64 IS NOT NULL AND prior_auth_tag_base64 IS NOT NULL
        AND prior_ciphertext_base64 IS NOT NULL AND prior_byte_length IS NOT NULL)),
    PRIMARY KEY (workspace_id, version_id, path),
    FOREIGN KEY (workspace_id, version_id) REFERENCES versions(workspace_id, version_id) ON DELETE CASCADE
) STRICT;
