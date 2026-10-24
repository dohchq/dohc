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
pub const MAX_FOLD_SOURCE_BYTES: usize = 100 * 1024;

pub struct FoldPreparation {
    request: Request,
    marker: crate::Marker,
    vector: Vec<u8>,
    deletes: Vec<u8>,
}

pub struct PreparedFold {
    pub key: DocKey,
    pub path: String,
    marker: crate::Marker,
    vector: Vec<u8>,
    deletes: Vec<u8>,
    source_sha: String,
    pub delta: Vec<u8>,
}

impl PreparedFold {
    pub fn matches(&self, key: &DocKey, marker: &crate::Marker, doc: &Ydoc, source: &str) -> bool {
        self.key == *key
            && self.marker == *marker
            && self.vector == doc.encode_state_vector()
            && self.deletes == doc.encode_delete_set()
            && self.source_sha == crate::hex_sha256(source.as_bytes())
    }
}

impl FoldPreparation {
    pub async fn construct(self, resolver: &ReaderResolver) -> Option<PreparedFold> {
        let key = DocKey::new(
            &self.request.document.workspace_id,
            &self.request.document.main_version_id,
            &self.request.document.object_id,
        )
        .ok()?;
        let path = self.request.current_path.clone();
        let source_sha = crate::hex_sha256(&self.request.source);
        let delta = resolver.construct_fold(self.request).await?;
        Some(PreparedFold {
            key,
            path,
            source_sha,
            delta,
            marker: self.marker,
            vector: self.vector,
            deletes: self.deletes,
        })
    }
}

/// Copy the inputs only. No child is started while this connection is borrowed.
pub fn prepare_fold(
    conn: &Connection,
    key: &DocKey,
    path: &str,
    source: &str,
) -> Result<Option<FoldPreparation>, CollabError> {
    if source.len() > MAX_FOLD_SOURCE_BYTES {
        return Ok(None);
    }
    let Some(marker) = crate::read_marker_in(conn, key)? else {
        return Ok(None);
    };
    if marker.content_kind != crate::ContentKind::Richdoc
        || marker.lineage_claim_status != crate::LineageClaimStatus::Exact
        || marker.path.as_deref() != Some(path)
    {
        return Ok(None);
    }
    let Some(claim) = marker.lineage_claim_id.clone() else {
        return Ok(None);
    };
    let doc = crate::load_doc_in(conn, key)?;
    if doc.has_reader_source() || doc.has_pending_dependencies() {
        return Ok(None);
    }
    Ok(Some(FoldPreparation {
        vector: doc.encode_state_vector(),
        deletes: doc.encode_delete_set(),
        marker,
        request: Request {
            method: Method::ConstructFold,
            document: Document {
                workspace_id: key.workspace_id.clone(),
                main_version_id: key.version_id.clone(),
                object_id: key.object_id.clone(),
                lineage_claim_id: claim,
            },
            current_path: path.to_owned(),
            source: source.as_bytes().to_vec(),
            checkpoint: doc.encode_full_state(),
        },
    }))
}

fn transient(failure: &Failure) -> bool {
    matches!(
        failure,
        Failure::Crashed | Failure::TimedOut | Failure::Overloaded | Failure::Superseded
    )
}

#[derive(PartialEq, Eq)]
struct Key {
    document: DocKey,
    marker: Option<crate::Marker>,
    authority: String,
    lineage: String,
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
pub(crate) mod tests;

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
                let checkpoint =
                    (request.method == Method::Construct).then(|| request.checkpoint.clone());
                match self.reader.request(request).await? {
                    Outcome::Constructed {
                        proof,
                        delta,
                        checkpoint_sha256,
                    } if checkpoint_sha256 == self.checkpoint_sha
                        && proof.source_sha256 == self.source_sha
                        && proof.source_byte_length == self.source_length
                        && checkpoint.as_ref().is_some_and(|checkpoint| {
                            constructed_source(checkpoint, &delta, &proof)
                        }) =>
                    {
                        // Construct refreshes the old projection hash; constructed_source checks its replacement.
                        // This is a proof on a clone. No returned edit enters the
                        // live document, and no content clock may be changed.
                        Ok(true)
                    }
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

fn constructed_source(checkpoint: &[u8], delta: &[u8], proof: &dohc_engine_reader::Proof) -> bool {
    let check = || -> Result<bool, CollabError> {
        if !crate::replay_parity::reader_metadata_only(checkpoint, delta)? {
            return Ok(false);
        }
        let doc = Ydoc::wire();
        doc.apply(checkpoint)?;
        doc.apply(delta)?;
        Ok(!doc.has_pending_dependencies()
            && doc.markdown_source_reference().is_some_and(|reference| {
                reference.source_sha256 == proof.source_sha256
                    && reference.projection_sha256 == proof.projection_sha256
                    && doc
                        .markdown_source(&reference)
                        .is_some_and(|source| source.len() == proof.source_byte_length)
            }))
    };
    check().unwrap_or(false)
}

/// Each cache belongs to one immutable reader configuration and build lifetime.
/// Restart creates an empty cache. Entries retain strict proof of the exact checkpoint.
pub struct ReaderResolver {
    reader: Arc<Reader>,
    entries: Mutex<VecDeque<Entry>>,
}
impl ReaderResolver {
    /// Outside-fold construction has no snapshot-witness cache or retry policy.
    /// Its caller must await this future outside the writer and recheck its inputs.
    pub async fn construct_fold(&self, request: Request) -> Option<Vec<u8>> {
        let checkpoint_sha = crate::hex_sha256(&request.checkpoint);
        let source_sha = crate::hex_sha256(&request.source);
        let source_length = request.source.len();
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            self.reader.request(request),
        )
        .await
        .ok()?
        .ok()?;
        match outcome {
            Outcome::Constructed {
                proof,
                delta,
                checkpoint_sha256,
            } if checkpoint_sha256 == checkpoint_sha
                && proof.source_sha256 == source_sha
                && proof.source_byte_length == source_length =>
            {
                Some(delta)
            }
            _ => None,
        }
    }

    pub fn new(reader: Arc<Reader>) -> Self {
        Self {
            reader,
            entries: Mutex::new(VecDeque::new()),
        }
    }

    pub(crate) fn resolve_snapshot(
        &self,
        conn: &Connection,
        key: &DocKey,
        doc: &Ydoc,
        canonical: &str,
        snapshot: &crate::reader_snapshot::SnapshotIdentity<'_>,
        source: String,
    ) -> Result<String, CollabError> {
        if !self.check_snapshot(conn, key, doc, canonical, snapshot, &source)? {
            return Err(CollabError::MarkdownReaderUnavailable);
        }
        Ok(source)
    }

    /// Expiry validates an edited prefix, but cannot authorize exact source output.
    pub(crate) fn verify_snapshot(
        &self,
        conn: &Connection,
        key: &DocKey,
        doc: &Ydoc,
        canonical: &str,
        snapshot: &crate::reader_snapshot::SnapshotIdentity<'_>,
        source: &str,
    ) -> Result<(), CollabError> {
        self.check_snapshot(conn, key, doc, canonical, snapshot, source)
            .map(|_| ())
    }

    pub(crate) fn check_snapshot(
        &self,
        conn: &Connection,
        key: &DocKey,
        doc: &Ydoc,
        canonical: &str,
        snapshot: &crate::reader_snapshot::SnapshotIdentity<'_>,
        source: &str,
    ) -> Result<bool, CollabError> {
        let reference = doc
            .markdown_source_reference()
            .ok_or(CollabError::MarkdownReaderUnavailable)?;
        if reference.source_sha256 != snapshot.digest || doc.markdown_source(&reference).is_none() {
            return Err(CollabError::MarkdownReaderUnavailable);
        }
        let checkpoint = doc.encode_full_state();
        let content_digest = crate::replay_parity::reader_checkpoint_content_digest(&checkpoint)?;
        let request = Request {
            method: if reference.projection_sha256 == crate::hex_sha256(canonical.as_bytes()) {
                Method::Construct
            } else {
                Method::Prove
            },
            document: Document {
                workspace_id: key.workspace_id.clone(),
                main_version_id: key.version_id.clone(),
                object_id: key.object_id.clone(),
                lineage_claim_id: snapshot.lineage.to_owned(),
            },
            current_path: snapshot.path.to_owned(),
            source: source.as_bytes().to_vec(),
            checkpoint,
        };
        let restore_generation = if let Some(expected) = snapshot.restore_fence {
            let current =
                crate::live_update_application::restore_fence::latest_generation(conn, key)?
                    .map(|row| row.0);
            if current != Some(expected) {
                return Err(CollabError::RestoreFenced);
            }
            current
        } else {
            crate::live_update_application::restore_generation(conn, key)?
        };
        let fresh = self.lookup(
            Key {
                document: key.clone(),
                marker: crate::read_marker_in(conn, key)?,
                authority: snapshot.authority.to_owned(),
                lineage: snapshot.lineage.to_owned(),
                restore_generation,
                moment: snapshot.moment.to_owned(),
                path: snapshot.path.to_owned(),
                source_sha: snapshot.digest.to_owned(),
                source_length: source.len(),
                projection_sha: reference.projection_sha256,
                content_digest,
            },
            request,
            crate::hex_sha256(canonical.as_bytes()),
        )?;
        Ok(fresh)
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
        method: if reference.source_sha256 == source_sha
            && reference.projection_sha256 == crate::hex_sha256(canonical.as_bytes())
        {
            Method::Construct
        } else {
            Method::Prove
        },
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
            marker: Some(marker),
            authority: "current-snapshot".into(),
            lineage: request.document.lineage_claim_id.clone(),
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
