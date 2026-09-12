use super::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const MAX_SOURCE_CAPTURE_FILES: usize = 512;
pub const MAX_SOURCE_CAPTURE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_SOURCE_CAPTURE_METADATA_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCaptureBounds {
    pub max_input_files: usize,
    pub max_input_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedSource {
    pub path: String,
    pub object_id: String,
    pub content_kind: String,
    pub sha256: String,
    pub byte_length: u64,
    pub latest_moment_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCapture {
    pub workspace_id: String,
    pub version_id: String,
    pub source_digest: String,
    pub total_bytes: u64,
    pub files: Vec<CapturedSource>,
}

impl VersionedTextStore<'_> {
    /// Pin selected source identities without Y.Doc lineage in one SQLite
    /// read snapshot. Live lineage markers survive settlement, so even a
    /// settled live document is unsupported here. Hydrate blobs later by hash.
    pub fn capture_sources(
        &self,
        workspace_id: &str,
        version_id: &str,
        paths: &[String],
        bounds: &SourceCaptureBounds,
    ) -> Result<SourceCapture, DomainError> {
        validate_identifier(workspace_id, "workspace_id")?;
        validate_identifier(version_id, "version_id")?;
        let invalid = |reason| DomainError::InvalidInput { reason };
        if bounds.max_input_files == 0
            || bounds.max_input_files > MAX_SOURCE_CAPTURE_FILES
            || bounds.max_input_bytes == 0
            || bounds.max_input_bytes > MAX_SOURCE_CAPTURE_BYTES
            || paths.is_empty()
            || paths.len() > bounds.max_input_files
        {
            return Err(invalid("source capture bounds exceeded"));
        }
        let mut selected = BTreeSet::new();
        let mut metadata_bytes = workspace_id.len() + version_id.len();
        for path in paths {
            metadata_bytes = metadata_bytes
                .checked_add(path.len())
                .filter(|size| *size <= MAX_SOURCE_CAPTURE_METADATA_BYTES)
                .ok_or_else(|| invalid("source capture metadata bounds exceeded"))?;
            let normalized = validate_plaintext_storable_path(path)?;
            if normalized != *path || !selected.insert(path.as_str()) {
                return Err(invalid("source paths must be canonical and unique"));
            }
        }
        self.store.read_with(|conn| {
            let tx = conn.unchecked_transaction().map_err(DomainError::sql_corrupt)?;
            if !version_exists(&tx, workspace_id, version_id)? {
                return Err(DomainError::VersionNotFound);
            }
            let mut files = Vec::with_capacity(selected.len());
            let mut total_bytes = 0u64;
            for path in selected {
                // Size strings before materializing them. The same transaction
                // holds both this preflight and the subsequent identity read.
                let size: Option<i64> = tx.query_row(
                    "SELECT LENGTH(CAST(s.object_id AS BLOB)) + LENGTH(CAST(s.latest_moment_id AS BLOB)) + LENGTH(CAST(COALESCE(s.content_kind,'text') AS BLOB)) + LENGTH(CAST(CASE COALESCE(s.content_kind,'text') WHEN 'binary' THEN s.binary_sha256 ELSE s.blob_sha256 END AS BLOB)) FROM path_aliases a JOIN snapshots s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id AND s.path=a.path WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path=?3",
                    params![workspace_id, version_id, path], |row| row.get(0),
                ).optional().map_err(DomainError::sql_corrupt)?;
                let size = size.ok_or_else(|| invalid("selected source is missing"))?;
                metadata_bytes = usize::try_from(size).ok().and_then(|size| size.checked_add(128)).and_then(|size| metadata_bytes.checked_add(size))
                    .filter(|size| *size <= MAX_SOURCE_CAPTURE_METADATA_BYTES)
                    .ok_or_else(|| invalid("source capture metadata bounds exceeded"))?;
                let (file, live): (CapturedSource, bool) = tx.query_row(
                    "SELECT s.object_id, COALESCE(s.content_kind,'text'), CASE COALESCE(s.content_kind,'text') WHEN 'binary' THEN bb.sha256 ELSE b.sha256 END, CASE COALESCE(s.content_kind,'text') WHEN 'binary' THEN bb.byte_length ELSE LENGTH(CAST(b.text AS BLOB)) END, s.latest_moment_id, EXISTS(SELECT 1 FROM ydoc_docs d WHERE d.workspace_id=s.workspace_id AND d.version_id=s.version_id AND d.object_id=s.object_id) FROM path_aliases a JOIN snapshots s ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id AND s.object_id=a.object_id AND s.path=a.path LEFT JOIN blobs b ON b.sha256=s.blob_sha256 LEFT JOIN binary_blobs bb ON bb.sha256=s.binary_sha256 WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path=?3",
                    params![workspace_id, version_id, path], |row| Ok((CapturedSource {
                        path: path.to_owned(), object_id: row.get(0)?, content_kind: row.get(1)?,
                        sha256: row.get(2)?, byte_length: row.get::<_, i64>(3)?.try_into().map_err(|_| rusqlite::Error::IntegralValueOutOfRange(3, -1))?, latest_moment_id: row.get(4)?,
                    }, row.get(5)?)),
                ).map_err(DomainError::sql_corrupt)?;
                if live { return Err(invalid("live-backed sources are not supported by this capture operation")); }
                if !matches!(file.content_kind.as_str(), "text" | "binary")
                    || file.sha256.len() != 64 || !file.sha256.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                {
                    return Err(DomainError::StateCorrupt { reason: "invalid selected source identity" });
                }
                total_bytes = total_bytes.checked_add(file.byte_length)
                    .filter(|size| *size <= bounds.max_input_bytes)
                    .ok_or_else(|| invalid("source capture input bytes exceeded"))?;
                files.push(file);
            }
            // Versioned, length-delimited JSON avoids ambiguous concatenation.
            let identity = serde_json::to_vec(&("dohc-source-capture-v1", workspace_id, version_id, &files))
                .map_err(|_| DomainError::StateCorrupt { reason: "source identity encoding failed" })?;
            let source_digest = hex(&Sha256::digest(identity));
            tx.commit().map_err(DomainError::sql_corrupt)?;
            Ok(SourceCapture { workspace_id: workspace_id.to_owned(), version_id: version_id.to_owned(), source_digest, total_bytes, files })
        })
    }
}
