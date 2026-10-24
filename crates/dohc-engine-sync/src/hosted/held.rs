//! The documents a hosted replica holds for retained work a released chain
//! left, as their owner reviews them: found in object ID order from durable
//! state alone, so discovery needs no editor and survives a restart, and each
//! inspected against its stored binding. Inspection proves off the store's
//! actor and is released there only while what it read still stands. Only
//! the proof decodes a binding; nothing here writes.

use std::sync::Arc;

use dohc_engine_collab::DocKey;
use dohc_engine_collab::live_update_application::{
    self as live, Charged, ContributionArtifact, HeldInspection, HeldProofJob, LineageCoordinates,
    Preservation, UnprovenCommitment, Work, inspect_held, store_identity,
};

use super::*;
use crate::ydoc_apply::protection_failure;

/// What one held proof answers every caller that shares it: what it found,
/// or why it failed.
pub type ProvedHeld = Result<HeldProof, Arc<SyncError>>;

/// The held-document proofs of one store's actor, each keyed by what its
/// caller reads of the hold at admission: callers share a proof only when
/// they ask the same of the same hold.
pub type HeldProofs = live::HeldProofs<HeldKey, ProvedHeld>;

/// [`admit_held_proof`]'s answer.
pub type HeldProofAdmission = live::HeldProofAdmission<HeldKey, ProvedHeld>;

/// A held document's inspection as its caller released it, which keeps the
/// proof's shared result, and the memory the daemon charges for it, until
/// the last caller drops it.
#[derive(Debug, Clone)]
pub struct HeldAnswer {
    inspection: Arc<HeldDocumentInspection>,
    _proved: Arc<Charged<ProvedHeld>>,
}

impl HeldAnswer {
    pub fn new(inspection: Arc<HeldDocumentInspection>, proved: Arc<Charged<ProvedHeld>>) -> Self {
        Self {
            inspection,
            _proved: proved,
        }
    }
}

impl std::ops::Deref for HeldAnswer {
    type Target = HeldDocumentInspection;

    fn deref(&self) -> &HeldDocumentInspection {
        &self.inspection
    }
}

impl PartialEq for HeldAnswer {
    fn eq(&self, other: &Self) -> bool {
        self.inspection == other.inspection
    }
}

/// One document the replica holds for released retained work, as its hold
/// names it. The binding itself stays stored; only a proof decodes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocument {
    pub object_id: String,
    /// The path its scope names it at.
    pub path: String,
    /// The digest of the binding the hold stores.
    pub binding_digest: String,
    pub continuation: ReleasedHoldContinuation,
    /// The stored hold already claims no currency for its binding.
    pub binding_stale: bool,
}

/// One page of [`list_held_documents`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocumentsPage {
    pub documents: Vec<HeldDocument>,
    /// Another page follows, after the last document of this one.
    pub has_more: bool,
}

/// Whether a held document's binding still names what its document holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldBindingStatus {
    Current,
    /// The document, its feed or its retained work changed since the binding
    /// was derived. The next pass derives it again from the held row.
    Stale,
}

impl HeldBindingStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::Stale => "stale",
        }
    }
}

/// [`inspect_held_document`]'s answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocumentInspection {
    pub document: HeldDocument,
    pub status: HeldBindingStatus,
    /// What the binding preserves; only a current binding has one.
    pub preservation: Option<Preservation>,
    /// The binding and the work that preservation covers and merged, as
    /// the owner downloads them; present with the preservation.
    pub contributions: Option<HeldContributions>,
}

/// A current inspection's contribution artifact, or that it has none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeldContributions {
    Artifact(ContributionArtifact),
    /// The artifact would pass what one blob streams, so only its merged
    /// list's commitment, hashed as a stream, answers. The preservation, and
    /// its Markdown, still answer.
    TooLarge {
        merged: UnprovenCommitment,
    },
}

impl HeldContributions {
    pub fn artifact(&self) -> Option<&ContributionArtifact> {
        match self {
            Self::Artifact(artifact) => Some(artifact),
            Self::TooLarge { .. } => None,
        }
    }

    /// The merged list's commitment, whether or not its artifact streams.
    pub fn merged(&self) -> &UnprovenCommitment {
        match self {
            Self::Artifact(artifact) => &artifact.merged,
            Self::TooLarge { merged } => merged,
        }
    }
}

/// The most memory decoding a stored binding holds for each of its bytes:
/// its JSON value, the binding, its canonical JSON compared with the stored
/// bytes, and the binding inspection derives again to compare.
const BINDING_BYTES_PER_STORED_BYTE: u64 = 16;

/// The largest page [`list_held_documents`] answers.
pub const MAX_HELD_DOCUMENTS_PAGE: usize = 256;

/// The documents the replica's current scope holds for released retained
/// work, in object ID order after `after_object_id`, at most `limit`. None
/// for a workspace that is not hosted.
pub fn list_held_documents(
    store: &EngineStore,
    workspace_id: &str,
    after_object_id: Option<&str>,
    limit: usize,
) -> Result<Option<HeldDocumentsPage>, SyncError> {
    if !(1..=MAX_HELD_DOCUMENTS_PAGE).contains(&limit) {
        return Err(SyncError::InvalidInput {
            reason: "held document page limit is out of range",
        });
    }
    store.read_with(|conn| {
        if !replica_exists(conn, workspace_id)? {
            return Ok(None);
        }
        let mut statement = conn
            .prepare_cached(&format!(
                "SELECT {HELD_DOCUMENT_COLUMNS} FROM hosted_documents \
                 WHERE workspace_id=?1 AND held_reason=?2 AND (?3 IS NULL OR object_id>?3) \
                 AND scope_generation=(SELECT scope_generation FROM hosted_replicas \
                   WHERE workspace_id=?1) \
                 ORDER BY object_id LIMIT ?4"
            ))
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map(
                params![
                    workspace_id,
                    RELEASED_LINEAGE_UNSETTLED,
                    after_object_id,
                    (limit + 1) as i64
                ],
                held_row,
            )
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?;
        let has_more = rows.len() > limit;
        let documents = rows
            .into_iter()
            .take(limit)
            .map(held_document)
            .collect::<Result<_, _>>()?;
        Ok(Some(HeldDocumentsPage {
            documents,
            has_more,
        }))
    })
}

/// The held document `object_id` of the replica's current scope, its binding
/// checked against what the store holds now and, while it stands, what it
/// preserves. Inspection reads the state of the lineage the binding names,
/// an archived one included. None when the workspace is not hosted or the
/// document is not held for released work. [`prove_held_document`] and
/// [`release_held_proof`] in turn, for a caller with no actor to keep free.
pub fn inspect_held_document(
    store: &EngineStore,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HeldDocumentInspection>, SyncError> {
    let proof = prove_held_document(&HeldProofJob::of(store), workspace_id, object_id)?;
    let released = release_held_proof(store, &proof)?;
    drop(proof);
    Ok(released
        .map(|inspection| Arc::try_unwrap(inspection).unwrap_or_else(|shared| (*shared).clone())))
}

/// What a held document's proof found, and what it read to find it. Only
/// [`HeldProof::released`] hands its inspection over.
#[derive(Debug)]
pub struct HeldProof {
    inspection: Option<Arc<HeldDocumentInspection>>,
    freshness: HeldFreshness,
}

/// What a request for a held document reads of its hold, by key and without
/// the binding, so the store's writer reads it in a handful of statements
/// however much the hold covers: the open and identity of the store, the
/// workspace and its main version, the replica's scope and the feed it
/// reads, and the hold with its binding's digest, its path, continuation and
/// stale flag, and its revision. Proofs are coalesced by it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldKey {
    opening: u64,
    engine: String,
    workspace_id: String,
    object_id: String,
    /// None once the workspace is gone.
    main_version_id: Option<String>,
    /// None for a workspace that is not hosted.
    scope_generation: Option<i64>,
    /// The replication epoch and stream the replica reads.
    feed: Option<(String, String)>,
    hold: Option<HeldDocument>,
    /// What every change to the document's hold binding advances, so two
    /// writes that change it and restore its digest still move the key.
    /// None before its first hold.
    hold_revision: Option<i64>,
}

/// What a held document's proof read beyond the evidence its document's
/// released tail generation covers, each by key, so the store's writer can
/// compare it again without decoding, enumerating, replaying or hashing
/// anything: the proof's [`HeldKey`], and the coordinates of the lineage the
/// binding it decoded names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldFreshness {
    key: HeldKey,
    /// The binding's document and lineage, and where that lineage stood.
    lineage: Option<(DocKey, String, LineageCoordinates)>,
}

/// What the store's writer finds of a proof once it ends.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeldRelease {
    /// Everything the proof read still stands, and so does its inspection.
    Current,
    /// Something it read moved: the document as the store holds it now,
    /// stale, with nothing preserved and no artifact, or none when nothing
    /// holds it now. Nothing proves again.
    Stale(Option<Arc<HeldDocumentInspection>>),
}

impl HeldProof {
    /// What the proof read, for [`check_held_freshness`].
    pub fn freshness(&self) -> &HeldFreshness {
        &self.freshness
    }

    /// The proof's answer, once [`check_held_freshness`] found `release`.
    /// Each caller that shared the proof releases it for itself.
    pub fn released(&self, release: HeldRelease) -> Option<Arc<HeldDocumentInspection>> {
        match release {
            HeldRelease::Current => self.inspection.clone(),
            HeldRelease::Stale(now) => now,
        }
    }

    /// The bytes the proof's inspection keeps: what its preservation keeps,
    /// findings included, and its artifact.
    pub fn retained_bytes(&self) -> u64 {
        self.inspection.as_ref().map_or(0, |inspection| {
            let preservation = inspection
                .preservation
                .as_ref()
                .map_or(0, Preservation::retained_bytes);
            let artifact = inspection
                .contributions
                .as_ref()
                .and_then(HeldContributions::artifact)
                .map_or(0, |artifact| artifact.bytes.capacity());
            u64::try_from(preservation + artifact).unwrap_or(u64::MAX)
        })
    }
}

/// Inspect the held document `object_id` as [`inspect_held_document`]
/// describes, off the store's writer: on `job`'s own reader, in one read
/// transaction whose snapshot is fixed before the hold is read. Everything
/// the inspection needs runs here: decoding the binding, tail enumeration,
/// provenance validation, replay, merging and projection inside the
/// transaction, then the contribution artifact once the reader closed, each
/// checking between its units whether `job` stopped. What each works with
/// is reserved of `job`'s memory before it is allocated, decoding the
/// binding from its stored length first. The inspection reserves what its
/// preservation keeps before it gives back the work that made it, and the
/// artifact reserves its own as it grows; one past its cap leaves the
/// inspection with none but its merged list's commitment, and the rest still
/// answers. The reader closes before this returns, however it returns. A
/// reader that cannot open is a locked store, never corrupt evidence.
pub fn prove_held_document(
    job: &HeldProofJob,
    workspace_id: &str,
    object_id: &str,
) -> Result<HeldProof, SyncError> {
    let stop = job.stop();
    // What the decoded binding holds, until the artifact names it.
    let mut working = stop.working();
    let mut reader = job.reader().map_err(protection_failure)?;
    let (tx, engine) = job.snapshot(&mut reader).map_err(protection_failure)?;
    let key = held_key(&tx, job.opening(), engine, workspace_id, object_id)?;
    let binding = key
        .hold
        .as_ref()
        .map(|document| held_binding(&tx, workspace_id, document, &mut working))
        .transpose()?;
    let lineage = binding
        .as_ref()
        .map(|binding| {
            let doc = DocKey {
                workspace_id: binding.workspace_id.clone(),
                version_id: binding.main_version_id.clone(),
                object_id: binding.object_id.clone(),
            };
            LineageCoordinates::read(&tx, &doc, &binding.lineage_claim_id)
                .map(|coordinates| (doc, binding.lineage_claim_id.clone(), coordinates))
        })
        .transpose()
        .map_err(protection_failure)?;
    let preservation = match (&key.hold, &binding) {
        (Some(document), Some(binding))
            if !document.binding_stale && binding_matches(&key, binding) =>
        {
            match inspect_held(&tx, binding, stop).map_err(protection_failure)? {
                HeldInspection::Current(preservation) => Some(preservation),
                HeldInspection::Stale => None,
            }
        }
        _ => None,
    };
    tx.rollback().map_err(SyncError::corrupt)?;
    drop(reader);
    let contributions = match (&binding, &preservation) {
        (Some(binding), Some(preservation)) => Some(
            match ContributionArtifact::of(binding, preservation, stop)
                .map_err(protection_failure)?
            {
                Some(artifact) => HeldContributions::Artifact(artifact),
                None => HeldContributions::TooLarge {
                    merged: UnprovenCommitment::of_merged(&preservation.merged, stop)
                        .map_err(protection_failure)?,
                },
            },
        ),
        _ => None,
    };
    let inspection = key.hold.clone().map(|document| {
        Arc::new(HeldDocumentInspection {
            document,
            status: if preservation.is_some() {
                HeldBindingStatus::Current
            } else {
                HeldBindingStatus::Stale
            },
            preservation,
            contributions,
        })
    });
    Ok(HeldProof {
        inspection,
        freshness: HeldFreshness { key, lineage },
    })
}

/// Admit a proof of the held document `object_id` to `proofs`, keyed by its
/// hold as `store`, the store's writer, reads it now with bounded reads that
/// never reach the binding: a caller that asks the same of the same hold
/// joins the running proof, and any other request for the workspace while
/// one runs is busy. A request [`HeldProofs::refuses`] is busy before this
/// reads anything.
pub fn admit_held_proof(
    store: &EngineStore,
    proofs: &HeldProofs,
    workspace_id: &str,
    object_id: &str,
) -> Result<HeldProofAdmission, SyncError> {
    if proofs.refuses(workspace_id) {
        return Ok(HeldProofAdmission::Busy);
    }
    let opening = store.opening();
    let key = store.read_with(|conn| {
        read_only(conn, |tx| {
            let engine = store_identity(tx).map_err(protection_failure)?;
            held_key(tx, opening, engine, workspace_id, object_id)
        })
    })?;
    Ok(proofs.admit(store, workspace_id, key)?)
}

/// Whether everything `freshness` names still stands on `store`, the store's
/// writer, as one read transaction finds it: the hold's row without its
/// binding, then, while that stands, the coordinates of the lineage the
/// proof found the binding naming. Nothing decodes, enumerates, replays or
/// hashes, however much the hold covers.
pub fn check_held_freshness(
    store: &EngineStore,
    freshness: &HeldFreshness,
) -> Result<HeldRelease, SyncError> {
    let proved = &freshness.key;
    let opening = store.opening();
    store.read_with(|conn| {
        read_only(conn, |tx| {
            let engine = store_identity(tx).map_err(protection_failure)?;
            let key = held_key(tx, opening, engine, &proved.workspace_id, &proved.object_id)?;
            let stands = key == *proved
                && match &freshness.lineage {
                    None => true,
                    Some((doc, lineage, coordinates)) => {
                        LineageCoordinates::read(tx, doc, lineage).map_err(protection_failure)?
                            == *coordinates
                    }
                };
            Ok(if stands {
                HeldRelease::Current
            } else {
                HeldRelease::Stale(key.hold.map(|document| {
                    Arc::new(HeldDocumentInspection {
                        document,
                        status: HeldBindingStatus::Stale,
                        preservation: None,
                        contributions: None,
                    })
                }))
            })
        })
    })
}

/// `proof`'s answer once [`check_held_freshness`] compared what it read on
/// `store`, the store's writer.
pub fn release_held_proof(
    store: &EngineStore,
    proof: &HeldProof,
) -> Result<Option<Arc<HeldDocumentInspection>>, SyncError> {
    Ok(proof.released(check_held_freshness(store, &proof.freshness)?))
}

/// A failed proof's error, again for each caller that shared it, in the
/// class and with the message of the proof's own.
pub fn shared_proof_failure(error: &Arc<SyncError>) -> SyncError {
    SyncError::Shared(Arc::clone(error))
}

/// What `conn` reads of a held document's hold, by key alone, on the store
/// open `opening` whose identity is `engine`.
fn held_key(
    conn: &Connection,
    opening: u64,
    engine: String,
    workspace_id: &str,
    object_id: &str,
) -> Result<HeldKey, SyncError> {
    let main_version_id = conn
        .query_row(
            "SELECT main_version_id FROM versioned_workspaces WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let scope_generation = conn
        .query_row(
            "SELECT scope_generation FROM hosted_replicas WHERE workspace_id=?1",
            [workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let feed = conn
        .query_row(
            "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
            [workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let hold_revision = conn
        .query_row(
            "SELECT revision FROM released_hold_revisions WHERE workspace_id=?1 AND object_id=?2",
            params![workspace_id, object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(HeldKey {
        opening,
        engine,
        workspace_id: workspace_id.to_owned(),
        object_id: object_id.to_owned(),
        main_version_id,
        scope_generation,
        feed,
        hold: held_in(conn, workspace_id, object_id)?,
        hold_revision,
    })
}

/// `read` in one transaction that always rolls back, so whatever it or
/// anything it calls writes is undone and every read agrees.
fn read_only<T>(
    conn: &Connection,
    read: impl FnOnce(&Connection) -> Result<T, SyncError>,
) -> Result<T, SyncError> {
    let tx = conn.unchecked_transaction().map_err(SyncError::corrupt)?;
    let answer = read(&tx)?;
    tx.rollback().map_err(SyncError::corrupt)?;
    Ok(answer)
}

fn replica_exists(conn: &Connection, workspace_id: &str) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM hosted_replicas WHERE workspace_id=?1)",
        [workspace_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// The document's stored hold, while the replica's current scope holds it
/// for released retained work.
fn held_in(
    conn: &Connection,
    workspace_id: &str,
    object_id: &str,
) -> Result<Option<HeldDocument>, SyncError> {
    conn.prepare_cached(&format!(
        "SELECT {HELD_DOCUMENT_COLUMNS} FROM hosted_documents \
         WHERE workspace_id=?1 AND object_id=?2 AND held_reason=?3 \
         AND scope_generation=(SELECT scope_generation FROM hosted_replicas \
           WHERE workspace_id=?1)"
    ))
    .map_err(SyncError::corrupt)?
    .query_row(
        params![workspace_id, object_id, RELEASED_LINEAGE_UNSETTLED],
        held_row,
    )
    .optional()
    .map_err(SyncError::corrupt)?
    .map(held_document)
    .transpose()
}

/// The binding `document`'s hold stores, which must be the one its digest
/// names. Only a proof decodes it: what decoding holds is reserved in
/// `working` from the binding's stored length before its bytes are read,
/// and they decode only once they hash, as they are, to that digest. A
/// binding that decodes is its canonical JSON, so that hash is its digest.
fn held_binding(
    conn: &Connection,
    workspace_id: &str,
    document: &HeldDocument,
    working: &mut Work<'_>,
) -> Result<ReleasedLineageBinding, SyncError> {
    if working.limited() {
        let length: Option<i64> = conn
            .query_row(
                "SELECT octet_length(released_hold_binding_json) FROM hosted_documents \
                 WHERE workspace_id=?1 AND object_id=?2",
                params![workspace_id, document.object_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        let length = u64::try_from(length.unwrap_or(0)).unwrap_or(0);
        working
            .grow(length.saturating_mul(BINDING_BYTES_PER_STORED_BYTE))
            .map_err(protection_failure)?;
    }
    let stored: String = conn
        .query_row(
            "SELECT released_hold_binding_json FROM hosted_documents \
             WHERE workspace_id=?1 AND object_id=?2",
            params![workspace_id, document.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if ReleasedLineageBinding::canonical_digest(&stored) != document.binding_digest {
        return Err(malformed());
    }
    ReleasedLineageBinding::from_canonical_json(&stored).ok_or_else(malformed)
}

/// The `hosted_documents` columns that say what holds a document for
/// released retained work, in [`held_row`]'s order: every one but the
/// binding, which comes after them in the row, so reading them never reaches
/// its bytes.
const HELD_DOCUMENT_COLUMNS: &str = "object_id,path,released_hold_binding_digest,\
    released_hold_continuation,released_hold_binding_stale";

type HeldRow = (String, String, Option<String>, Option<String>, bool);

fn held_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HeldRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn held_document(
    (object_id, path, binding_digest, continuation, binding_stale): HeldRow,
) -> Result<HeldDocument, SyncError> {
    Ok(HeldDocument {
        object_id,
        path,
        binding_digest: binding_digest.ok_or_else(malformed)?,
        continuation: continuation
            .as_deref()
            .and_then(ReleasedHoldContinuation::parse)
            .ok_or_else(malformed)?,
        binding_stale,
    })
}

fn malformed() -> SyncError {
    crate::error::local_corruption("a hosted document's state is malformed")
}

/// Whether `binding` names the row that stores it, in its workspace's main
/// version, and the replica still reads the feed its update arrived on. A
/// binding naming another document proves that one, never this.
fn binding_matches(key: &HeldKey, binding: &ReleasedLineageBinding) -> bool {
    let incoming = &binding.incoming;
    key.workspace_id == binding.workspace_id
        && key.object_id == binding.object_id
        && key.main_version_id.as_ref() == Some(&binding.main_version_id)
        && key
            .feed
            .as_ref()
            .map(|(epoch, stream)| (epoch.as_str(), stream.as_str()))
            == Some((
                incoming.replication_epoch.as_str(),
                incoming.stream_identity.as_str(),
            ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opus's r2a F4: inspection's transaction rolls back, so a write made
    /// inside it, by inspection or anything it calls, never lands.
    #[test]
    fn inspection_rolls_its_transaction_back() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE probe (value INTEGER)")
            .unwrap();
        let count = |conn: &Connection| {
            conn.query_row("SELECT count(*) FROM probe", [], |row| row.get::<_, i64>(0))
                .map_err(SyncError::corrupt)
        };
        let inside = read_only(&conn, |tx| {
            tx.execute("INSERT INTO probe VALUES (1)", [])
                .map_err(SyncError::corrupt)?;
            count(tx)
        })
        .unwrap();
        assert_eq!(inside, 1, "the transaction reads its own write");
        assert_eq!(count(&conn).unwrap(), 0, "which never lands");
        assert!(conn.is_autocommit(), "the transaction ended");
    }

    /// Sol's r2c-3c-2 finding 6 and Opus's finding 4: a stopped read stays
    /// cancelled and a locked store locked, never corrupt evidence. Opus's
    /// r2c-3c-4 finding 5: a failure a proof's callers share keeps, for
    /// each, the class, disposition and message of the original, whatever
    /// its class.
    #[test]
    fn a_shared_failure_keeps_its_class_for_every_caller() {
        use dohc_engine_collab::live_update_application::ApplicationError;
        use dohc_engine_storage::StorageError;
        assert!(matches!(
            protection_failure(ApplicationError::Cancelled),
            SyncError::Cancelled
        ));
        assert!(matches!(
            protection_failure(ApplicationError::Storage(StorageError::FileLocked)),
            SyncError::Storage(StorageError::FileLocked)
        ));
        for failure in [
            SyncError::Storage(StorageError::FileLocked),
            SyncError::Cancelled,
            SyncError::RetryableState {
                reason: "live document is stopped",
            },
            SyncError::Storage(StorageError::PermissionDenied { source: None }),
            SyncError::Storage(StorageError::persist_public(std::io::Error::other("disk"))),
            SyncError::LiveDocumentBindingActive,
            SyncError::ProjectionTooLarge {
                constraint: "the projection limit",
                actual_bytes: 2,
                limit_bytes: 1,
            },
            SyncError::InvalidInput { reason: "bad" },
            malformed(),
        ] {
            let (code, disposition, message) = (
                failure.code(),
                failure.share_disposition(),
                failure.to_string(),
            );
            let shared = Arc::new(failure);
            for caller in 0..2 {
                let answered = shared_proof_failure(&shared);
                assert_eq!(answered.code(), code, "caller {caller}");
                assert_eq!(answered.share_disposition(), disposition, "caller {caller}");
                assert_eq!(answered.to_string(), message, "caller {caller}");
                assert!(
                    std::ptr::eq(answered.original(), &*shared),
                    "caller {caller}"
                );
            }
        }
    }
}
