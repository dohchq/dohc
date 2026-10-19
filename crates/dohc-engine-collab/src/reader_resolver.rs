//! Snapshot authority for existing reader witnesses. Proofs never enter the store.
use crate::{CollabError, DocKey, Ydoc};
use dohc_engine_reader::{Document, Failure, Method, Outcome, Reader, Request};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::OnceCell;

const MAX_ENTRIES: usize = 16;

fn transient(failure: &Failure) -> bool {
    matches!(
        failure,
        Failure::Crashed | Failure::TimedOut | Failure::Overloaded | Failure::Superseded
    )
}

#[derive(PartialEq, Eq)]
struct Key {
    document: DocKey,
    marker: crate::Marker,
    restore_generation: Option<i64>,
    moment: String,
    path: String,
    source_sha: String,
    source_length: usize,
    projection_sha: String,
    content_digest: String,
}

#[cfg(test)]
#[path = "reader_resolver_tests.rs"]
mod tests;

/// A miss leaves the writer before the caller starts or waits for the process.
pub struct PendingProof {
    reader: Arc<Reader>,
    request: Mutex<Option<Request>>,
    result: OnceCell<Result<bool, Failure>>,
    source_sha: String,
    source_length: usize,
    projection_sha: String,
    canonical_sha: String,
    checkpoint_sha: String,
}
impl std::fmt::Debug for PendingProof {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PendingProof")
    }
}
impl PendingProof {
    pub async fn resolve(&self) {
        self.result
            .get_or_init(|| async {
                let request = self
                    .request
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or(Failure::Superseded)?;
                match self.reader.request(request).await? {
                    Outcome::Proved {
                        proof,
                        checkpoint_sha256,
                    } if checkpoint_sha256 == self.checkpoint_sha
                        && proof.source_sha256 == self.source_sha
                        && proof.source_byte_length == self.source_length
                        && proof.projection_sha256 == self.projection_sha =>
                    {
                        Ok(true)
                    }
                    Outcome::Expired {
                        proof,
                        checkpoint_sha256,
                    } if checkpoint_sha256 == self.checkpoint_sha
                        && proof.source_sha256 == self.source_sha
                        && proof.source_byte_length == self.source_length
                        && proof.projection_sha256 == self.canonical_sha =>
                    {
                        Ok(false)
                    }
                    _ => Err(Failure::Unavailable),
                }
            })
            .await;
    }
}

struct Entry {
    key: Key,
    pending: Arc<PendingProof>,
    retries: u8,
}

/// Each cache belongs to one immutable reader configuration and build lifetime.
/// Restart creates an empty cache. Entries retain strict proof of the exact checkpoint.
pub struct ReaderResolver {
    reader: Arc<Reader>,
    entries: Mutex<VecDeque<Entry>>,
}
impl ReaderResolver {
    pub fn new(reader: Arc<Reader>) -> Self {
        Self {
            reader,
            entries: Mutex::new(VecDeque::new()),
        }
    }

    fn lookup(
        &self,
        key: Key,
        request: Request,
        canonical_sha: String,
    ) -> Result<bool, CollabError> {
        let mut entries = self.entries.lock().unwrap();
        let mut retries = 0;
        if let Some(index) = entries.iter().position(|entry| entry.key == key) {
            let entry = entries.remove(index).unwrap();
            match entry.pending.result.get() {
                Some(Err(_)) if Arc::strong_count(&entry.pending) > 1 => {
                    entries.push_back(entry);
                    return Err(CollabError::MarkdownReaderUnavailable);
                }
                Some(Ok(fresh)) => {
                    let fresh = *fresh;
                    entries.push_back(entry);
                    return Ok(fresh);
                }
                Some(Err(failure)) if transient(failure) && entry.retries == 0 => retries = 1,
                Some(Err(failure)) => {
                    if !transient(failure) {
                        entries.push_back(entry);
                    }
                    return Err(CollabError::MarkdownReaderUnavailable);
                }
                None => {
                    let pending = entry.pending.clone();
                    entries.push_back(entry);
                    return Err(CollabError::MarkdownReaderPending(pending));
                }
            }
        }
        while entries.len() >= MAX_ENTRIES {
            let Some(index) = entries
                .iter()
                .position(|entry| Arc::strong_count(&entry.pending) == 1)
            else {
                return Err(CollabError::MarkdownReaderUnavailable);
            };
            entries.remove(index);
        }
        let pending = Arc::new(PendingProof {
            reader: self.reader.clone(),
            source_sha: key.source_sha.clone(),
            source_length: request.source.len(),
            projection_sha: key.projection_sha.clone(),
            canonical_sha,
            checkpoint_sha: crate::hex_sha256(&request.checkpoint),
            request: Mutex::new(Some(request)),
            result: OnceCell::new(),
        });
        entries.push_back(Entry {
            key,
            pending: pending.clone(),
            retries,
        });
        Err(CollabError::MarkdownReaderPending(pending))
    }
}

/// The caller reobserves this authority on every use, including cache hits.
pub fn resolve(
    conn: &Connection,
    key: &DocKey,
    doc: &Ydoc,
    canonical: &str,
    resolver: Option<&ReaderResolver>,
) -> Result<Option<String>, CollabError> {
    let resolver = resolver.ok_or(CollabError::MarkdownReaderUnavailable)?;
    let reference = doc
        .markdown_source_reference()
        .ok_or(CollabError::MarkdownReaderUnavailable)?;
    let marker = crate::read_marker_in(conn, key)?.ok_or(CollabError::NoMarker)?;
    let snapshot: Option<(String, String, String, String, i64)> = conn
        .query_row(
            "SELECT s.latest_moment_id,s.path,s.blob_sha256,b.text,b.byte_length \
         FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 \
         WHERE s.workspace_id=?1 AND s.version_id=?2 AND s.object_id=?3 AND s.content_kind='text'",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(crate::durable::map_sql)?;
    let (moment, path, source_sha, source, length) =
        snapshot.ok_or(CollabError::MarkdownReaderUnavailable)?;
    if length != source.len() as i64
        || crate::hex_sha256(source.as_bytes()) != source_sha
        || doc.markdown_source(&reference).is_none()
        || marker.path.as_deref() != Some(&path)
        || doc.has_pending_dependencies()
        || marker.lineage_epoch_tag != doc.lineage_epoch_tag()
    {
        return Err(CollabError::MarkdownReaderUnavailable);
    }
    let claim = marker
        .lineage_claim_id
        .clone()
        .or_else(|| marker.lineage_epoch_tag.clone())
        .ok_or(CollabError::MarkdownReaderUnavailable)?;
    let checkpoint = doc.encode_full_state();
    let content_digest = crate::replay_parity::reader_checkpoint_content_digest(&checkpoint)?;
    let restore_generation = crate::live_update_application::restore_generation(conn, key)?;
    if reference.source_sha256 != source_sha
        && crate::durable::last_settled_sha(conn, key)?.as_deref() != Some(&source_sha)
    {
        return Err(CollabError::MarkdownReaderUnavailable);
    }
    let request = Request {
        method: Method::Prove,
        document: Document {
            workspace_id: key.workspace_id.clone(),
            main_version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            lineage_claim_id: claim,
        },
        current_path: path.clone(),
        source: source.as_bytes().to_vec(),
        checkpoint,
    };
    let fresh = resolver.lookup(
        Key {
            document: key.clone(),
            marker,
            restore_generation,
            moment,
            path,
            source_sha,
            source_length: source.len(),
            projection_sha: reference.projection_sha256,
            content_digest,
        },
        request,
        crate::hex_sha256(canonical.as_bytes()),
    )?;
    Ok(fresh.then_some(source))
}
