//! The documents a hosted replica holds for retained work a released chain
//! left, as their owner reviews them: found in object ID order from durable
//! state alone, so discovery needs no editor and survives a restart, and each
//! inspected against its stored binding. Inspection proves off the store's
//! actor and is released there only while what it read still stands. Nothing
//! here writes.

use dohc_engine_collab::DocKey;
use dohc_engine_collab::live_update_application::{
    ContributionArtifact, HeldInspection, HeldProofJob, HeldProofs, LineageCoordinates,
    Preservation, inspect_held, store_identity,
};

use super::*;
use crate::ydoc_apply::protection_failure;

/// One document the replica holds for released retained work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldDocument {
    pub object_id: String,
    /// The path its scope names it at.
    pub path: String,
    pub binding: Box<ReleasedLineageBinding>,
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
    pub contributions: Option<ContributionArtifact>,
}

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
                "SELECT object_id,path,state,{HELD_COLUMNS} FROM hosted_documents \
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
    let job = HeldProofs::default().job(store);
    let proof = prove_held_document(&job, workspace_id, object_id)?;
    release_held_proof(store, proof)
}

/// What a held document's proof found, and what it read to find it. Only
/// [`release_held_proof`] hands its inspection over.
#[derive(Debug)]
pub struct HeldProof {
    inspection: Option<HeldDocumentInspection>,
    freshness: HeldFreshness,
}

/// What a held document's proof read beyond the evidence its document's
/// released tail generation covers, each by key, so the store's writer can
/// compare it again without enumerating, replaying or hashing anything: the
/// open and identity of the store, the workspace and its main version, the
/// replica's scope and the feed it reads, the hold with its binding, reason,
/// continuation and stale flag, and the coordinates of the lineage that
/// binding names.
#[derive(Debug, Clone, PartialEq, Eq)]
struct HeldFreshness {
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
    lineage: Option<LineageCoordinates>,
}

/// Inspect the held document `object_id` as [`inspect_held_document`]
/// describes, off the store's writer: on `job`'s own reader, in one read
/// transaction whose snapshot is fixed before the hold is read. Everything
/// the inspection needs runs here: tail enumeration, provenance validation,
/// replay, merging, projection and the contribution artifact. The reader
/// closes before this returns.
pub fn prove_held_document(
    job: &HeldProofJob,
    workspace_id: &str,
    object_id: &str,
) -> Result<HeldProof, SyncError> {
    let mut reader = job.reader().map_err(protection_failure)?;
    let (tx, engine) = job.snapshot(&mut reader).map_err(protection_failure)?;
    let freshness = freshness(&tx, job.opening(), engine, workspace_id, object_id)?;
    let inspection = match &freshness.hold {
        None => None,
        Some(document) => {
            let preservation = if document.binding_stale
                || !feed_matches(&freshness, &document.binding)
            {
                None
            } else {
                match inspect_held(&tx, &document.binding).map_err(protection_failure)? {
                    HeldInspection::Current(preservation) => Some(preservation),
                    HeldInspection::Stale => None,
                }
            };
            let contributions = preservation
                .as_ref()
                .map(|preservation| ContributionArtifact::of(&document.binding, preservation));
            Some(HeldDocumentInspection {
                document: document.clone(),
                status: if preservation.is_some() {
                    HeldBindingStatus::Current
                } else {
                    HeldBindingStatus::Stale
                },
                preservation,
                contributions,
            })
        }
    };
    tx.rollback().map_err(SyncError::corrupt)?;
    drop(reader);
    Ok(HeldProof {
        inspection,
        freshness,
    })
}

/// `proof`'s inspection, while everything it read still stands on `store`,
/// the store's writer, as one read transaction of bounded reads finds it.
/// Otherwise the document as the store holds it now, stale, with nothing
/// preserved and no artifact; nothing proves again. None when nothing holds
/// the document now.
pub fn release_held_proof(
    store: &EngineStore,
    proof: HeldProof,
) -> Result<Option<HeldDocumentInspection>, SyncError> {
    let HeldProof {
        inspection,
        freshness: proved,
    } = proof;
    let opening = store.opening();
    store.read_with(|conn| {
        read_only(conn, |tx| {
            let engine = store_identity(tx).map_err(protection_failure)?;
            let now = freshness(tx, opening, engine, &proved.workspace_id, &proved.object_id)?;
            if now == proved {
                return Ok(inspection);
            }
            Ok(now.hold.map(|document| HeldDocumentInspection {
                document,
                status: HeldBindingStatus::Stale,
                preservation: None,
                contributions: None,
            }))
        })
    })
}

/// What `conn` reads of a held document's freshness, by key alone, on the
/// store open `opening` whose identity is `engine`.
fn freshness(
    conn: &Connection,
    opening: u64,
    engine: String,
    workspace_id: &str,
    object_id: &str,
) -> Result<HeldFreshness, SyncError> {
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
    let hold = held_in(conn, workspace_id, object_id)?;
    let lineage = hold
        .as_ref()
        .map(|document| {
            let binding = &document.binding;
            let doc = DocKey {
                workspace_id: binding.workspace_id.clone(),
                version_id: binding.main_version_id.clone(),
                object_id: binding.object_id.clone(),
            };
            LineageCoordinates::read(conn, &doc, &binding.lineage_claim_id)
        })
        .transpose()
        .map_err(protection_failure)?;
    Ok(HeldFreshness {
        opening,
        engine,
        workspace_id: workspace_id.to_owned(),
        object_id: object_id.to_owned(),
        main_version_id,
        scope_generation,
        feed,
        hold,
        lineage,
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
    if !replica_exists(conn, workspace_id)? {
        return Ok(None);
    }
    conn.query_row(
        &format!(
            "SELECT object_id,path,state,{HELD_COLUMNS} FROM hosted_documents \
             WHERE workspace_id=?1 AND object_id=?2 AND held_reason=?3 \
             AND scope_generation=(SELECT scope_generation FROM hosted_replicas \
               WHERE workspace_id=?1)"
        ),
        params![workspace_id, object_id, RELEASED_LINEAGE_UNSETTLED],
        held_row,
    )
    .optional()
    .map_err(SyncError::corrupt)?
    .map(held_document)
    .transpose()
}

type HeldRow = (String, String, String, HeldColumns);

fn held_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HeldRow> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, HeldColumns::read(row, 3)?))
}

fn held_document((object_id, path, state, held): HeldRow) -> Result<HeldDocument, SyncError> {
    match decode_status(&path, &state, held)? {
        HostedDocumentStatus::Held(HostedHold::ReleasedLineageUnsettled {
            binding,
            continuation,
            binding_stale,
        }) => Ok(HeldDocument {
            object_id,
            path,
            binding,
            continuation,
            binding_stale,
        }),
        _ => Err(crate::error::local_corruption(
            "a hosted document's state is malformed",
        )),
    }
}

/// Whether the replica still reads the feed `binding`'s update arrived on.
fn feed_matches(freshness: &HeldFreshness, binding: &ReleasedLineageBinding) -> bool {
    let incoming = &binding.incoming;
    freshness.workspace_id == binding.workspace_id
        && freshness
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
        conn.execute_batch("CREATE TABLE probe (value INTEGER)").unwrap();
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
}
