//! Exact output from a caller-selected, already authorized artifact moment.
use crate::{reader_resolver::ReaderResolver, CollabError, DocKey, Ydoc};
use rusqlite::{params, Connection, OptionalExtension};

/// Callers verify the binding, claim and history selection before every lookup.
/// This identity names stored bytes; a witness cannot supply the artifact.
pub struct SnapshotIdentity<'a> {
    pub moment: &'a str,
    pub path: &'a str,
    pub digest: &'a str,
    pub lineage: &'a str,
    pub restore_fence: Option<i64>,
    /// The caller's binding/history receipt, including its namespace and fence.
    pub authority: &'a str,
}

/// The caller authenticates history; its witness selects the artifact and digest.
pub struct HistoryIdentity<'a> {
    pub path: &'a str,
    pub lineage: &'a str,
    pub restore_fence: Option<i64>,
    pub authority: &'a str,
}

/// Only after the caller authenticates its selected history and restore operation.
/// A verified expired witness authorizes canonical output, never its old source.
pub fn resolve_history(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    canonical: &str,
    history: &HistoryIdentity<'_>,
    resolver: Option<&ReaderResolver>,
    max_source_bytes: usize,
) -> Result<String, CollabError> {
    let reference = doc
        .markdown_source_reference()
        .ok_or(CollabError::MarkdownReaderUnavailable)?;
    let digest = reference.source_sha256;
    let (moment, _) = history_artifact(conn, key, history.path, &digest, max_source_bytes)?;
    let snapshot = SnapshotIdentity {
        moment: &moment,
        digest: &digest,
        path: history.path,
        lineage: history.lineage,
        restore_fence: history.restore_fence,
        authority: history.authority,
    };
    let resolver = resolver.ok_or(CollabError::MarkdownReaderUnavailable)?;
    let source = artifact_source(conn, key, doc, &snapshot)?;
    if resolver.check_snapshot(conn, key, doc, canonical, &snapshot, &source)? {
        Ok(source)
    } else {
        Ok(canonical.to_owned())
    }
}

/// Select stored bytes by the frozen witness, independently of the current snapshot.
pub(crate) fn history_artifact(
    conn: &Connection,
    key: &DocKey,
    path: &str,
    digest: &str,
    max_source_bytes: usize,
) -> Result<(String, i64), CollabError> {
    let (moment, length) = history_artifact_header(conn, key, path, digest)?
        .ok_or(CollabError::MarkdownReaderUnavailable)?;
    if usize::try_from(length)
        .ok()
        .filter(|n| *n <= max_source_bytes)
        .is_none()
    {
        return Err(CollabError::ConfiguredByteBudgetExceeded);
    }
    Ok((moment, length))
}

pub(crate) fn history_artifact_header(
    conn: &Connection,
    key: &DocKey,
    path: &str,
    digest: &str,
) -> Result<Option<(String, i64)>, CollabError> {
    conn.query_row(
        concat!("SELECT moment_id,b.byte_length FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
          AND path=?4 AND after_content_kind='text' AND after_blob_sha256=?5 AND ",
          dohc_engine_domain::exclude_capture_recovery_sql!("m"), " ORDER BY moment_order LIMIT 1"),
        params![key.workspace_id,key.version_id,key.object_id,path,digest], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(crate::durable::map_sql)
}

pub fn resolve(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    canonical: &str,
    snapshot: &SnapshotIdentity<'_>,
    resolver: Option<&ReaderResolver>,
) -> Result<String, CollabError> {
    let resolver = resolver.ok_or(CollabError::MarkdownReaderUnavailable)?;
    let source = artifact_source(conn, key, doc, snapshot)?;
    resolver.resolve_snapshot(conn, key, doc, canonical, snapshot, source)
}

fn artifact_source(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    snapshot: &SnapshotIdentity<'_>,
) -> Result<String, CollabError> {
    let artifact: Option<(String, i64)> = conn.query_row(
        concat!("SELECT b.sha256,b.byte_length FROM moments m JOIN blobs b ON b.sha256=m.after_blob_sha256
          WHERE m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 AND m.moment_id=?4
          AND m.path=?5 AND m.after_content_kind='text' AND m.after_blob_sha256=?6 AND ",
          dohc_engine_domain::exclude_capture_recovery_sql!("m")),
        params![key.workspace_id,key.version_id,key.object_id,snapshot.moment,snapshot.path,snapshot.digest],
        |row| Ok((dohc_engine_storage::text::from_row(conn, row, 0)?,row.get(1)?)),
    ).optional().map_err(crate::durable::map_sql)?;
    let (source, length) = artifact.ok_or(CollabError::MarkdownReaderUnavailable)?;
    if length != source.len() as i64
        || crate::hex_sha256(source.as_bytes()) != snapshot.digest
        || snapshot.lineage.is_empty()
        || snapshot.authority.is_empty()
        || doc.has_pending_dependencies()
    {
        return Err(CollabError::MarkdownReaderUnavailable);
    }
    Ok(source)
}

/// Validate the current E prefix before an explicit restore to a native point.
/// An expired source is evidence about that prefix, never permission to rewrite it.
pub(crate) fn verify_restore_prefix(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    history: &HistoryIdentity<'_>,
    resolver: Option<&ReaderResolver>,
    max_source_bytes: usize,
) -> Result<usize, CollabError> {
    let resolver = resolver.ok_or(CollabError::MarkdownReaderUnavailable)?;
    let reference = doc
        .markdown_source_reference()
        .ok_or(CollabError::MarkdownReaderUnavailable)?;
    let digest = reference.source_sha256;
    let (moment, _) = history_artifact(conn, key, history.path, &digest, max_source_bytes)?;
    let snapshot = SnapshotIdentity {
        moment: &moment,
        digest: &digest,
        path: history.path,
        lineage: history.lineage,
        authority: history.authority,
        restore_fence: history.restore_fence,
    };
    let source = artifact_source(conn, key, doc, &snapshot)?;
    resolver.verify_snapshot(
        conn,
        key,
        doc,
        &doc.project(crate::ContentKind::Richdoc)?.content,
        &snapshot,
        &source,
    )?;
    Ok(source.len())
}
