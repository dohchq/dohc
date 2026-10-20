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
    /// The caller's binding/history receipt, including its namespace and fence.
    pub authority: &'a str,
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
    resolver.resolve_snapshot(conn, key, doc, canonical, snapshot, source)
}
