use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    CollabError, DocKey, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update,
    apply_remote_update_in_transaction, maybe_compact,
};
use dohc_engine_domain::{
    ConflictFileState, DomainError, WriteText, enqueue_write, select_snapshot_by_path_in_tx,
    write_projected_text_in_tx,
};
use dohc_engine_storage::{
    EngineStore, FaultInjector, Preimage, StorageError, TxnOutcome, get_binary_blob, hex_sha256,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;

use dohc_engine_files::{
    PathClassification, classify_engine_file_path_normalized, search_policy::SearchPolicySnapshot,
};

use crate::error::local_corruption;
use crate::file_search::{search_policy_for_store, upsert_file_search_index};
use crate::{ApplyOutcome, ReplicationEnvelope, SyncError};

fn projection_too_large_reason(
    content_kind: dohc_engine_collab::ContentKind,
    constraint: &'static str,
    actual_bytes: usize,
    limit_bytes: usize,
) -> String {
    let format = content_kind.as_str();
    format!(
        "{format} projection exceeds {constraint}: limit {limit_bytes} bytes, observed at least {actual_bytes} bytes"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct YdocUpdatePayload {
    version_id: String,
    object_id: String,
    path: String,
    content_kind: String,
    update_blob_sha256: String,
    #[serde(default)]
    is_base_state: bool,
}

/// Read-only lease seam used by sync apply to avoid mutating a lineage while
/// an interactive daemon session owns it.
pub trait LeaseProbe: Send + Sync {
    fn is_live(&self, key: &DocKey) -> bool;
}

/// Default probe for callers that do not own an interactive session registry.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoLiveLeases;

impl LeaseProbe for NoLiveLeases {
    fn is_live(&self, _key: &DocKey) -> bool {
        false
    }
}

impl LeaseProbe for dohc_engine_collab::LeaseRegistry {
    fn is_live(&self, key: &DocKey) -> bool {
        self.is_held(key)
    }
}

/// Direct-applier diagnostic result. A deferred update needs no caller action:
/// its coordinate is durably parked with the ack and is replayed by
/// [`drain_deferred_ydoc_for_key`] on lease teardown/open or before the next
/// non-leased update.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocApplyResult {
    pub deferred: bool,
    pub reason: Option<&'static str>,
    /// Sync conflicts this envelope opened (the first-base-over-divergent-head
    /// branch). Counted like the moment lane so the pull pass reports it.
    pub conflicts_opened: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct YdocDrainResult {
    pub drained: usize,
    pub refusals: Vec<crate::ReplicationRefusal>,
    pub sharing_declined: Vec<crate::SharingDeclined>,
}

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Ok(Vec::new());
    }
    let payload: YdocUpdatePayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update payload is malformed",
        })?;
    let fingerprint = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        envelope.workspace_id,
        payload.version_id,
        payload.object_id,
        payload.path,
        envelope.origin_id,
        envelope.origin_seq
    );
    let job_id = format!(
        "ydoc-mat_moment-ydoc-apply-{}",
        dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
    );
    let change = store.read_with(|conn| {
        conn.query_row(
            "SELECT target_path, operation FROM materialization_jobs WHERE job_id=?1",
            [&job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })?;
    let Some((path, operation)) = change else {
        return Ok(Vec::new());
    };
    let operation = match operation.as_str() {
        "write" => "write",
        "delete" => "delete",
        _ => {
            return Err(SyncError::InvalidInput {
                reason: "ydoc materialization operation is invalid",
            });
        }
    };
    Ok(vec![crate::MomentMaterializationChange {
        path,
        operation,
        content_kind: "text",
    }])
}

/// Recount the conflicts a redelivered `ydoc.update` base opened, keyed by
/// the deterministic incoming-side moment id (moment-lane parity: a crash
/// between commit and cursor advance redelivers the envelope as a skip, and
/// the caller still reports the conflict it opened).
pub(crate) fn redelivered_conflicts_opened(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<i64, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Ok(0);
    }
    // NEVER reparse the payload here. A malformed `ydoc.update` is refused
    // and ACKED; if the process then crashes before the relay cursor
    // commits, the next pull replays that coordinate as `Skipped` and asks
    // this helper to recount. Decoding the payload again returns
    // InvalidInput and aborts the whole pull, so every retry wedges on an
    // operation already durably handled. The decision record is keyed by
    // the ENVELOPE coordinate, which needs no payload at all: read it, and
    // read its absence as zero.
    let recorded: Option<String> = store.read_with(|conn| {
        conn.query_row(
            "SELECT payload_hash FROM engine_requests \
             WHERE request_id=?1 AND kind='sync-ydoc-conflict'",
            [ydoc_conflict_decision_id(envelope)],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })?;
    match recorded {
        Some(count) => count.parse::<i64>().map_err(|_| SyncError::InvalidInput {
            reason: "recorded ydoc conflict count is invalid",
        }),
        None => Ok(0),
    }
}

/// The immutable per-envelope decision id for the conflicts a base opened
/// (crash-redelivery recount). The CONFLICT row itself is mutable — a later
/// delta coalesces it and rewrites its incoming anchor — so the recount must
/// never depend on it.
fn ydoc_conflict_decision_id(envelope: &ReplicationEnvelope) -> String {
    let coordinate = format!(
        "{}\0{}\0{}",
        envelope.workspace_id, envelope.origin_id, envelope.origin_seq
    );
    format!(
        "sync-ydoc-conflict:{}",
        dohc_engine_storage::hex_sha256(coordinate.as_bytes())
    )
}

fn record_ydoc_conflicts_opened(
    tx: &rusqlite::Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflicts_opened: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO engine_requests \
         (request_id,payload_hash,result_seq,committed_at,kind) \
         VALUES (?1,?2,?3,?4,'sync-ydoc-conflict')",
        params![
            ydoc_conflict_decision_id(envelope),
            conflicts_opened.to_string(),
            envelope.origin_seq,
            envelope.recorded_at_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Drain acked Y.Doc envelopes deferred while `key` was leased. The
/// `ydoc_deferred_updates` table records exactly which coordinates are
/// pending (written in the same transaction as their ack); the imported
/// replication log keeps the payloads. Only those rows replay — never the
/// whole history, which after compaction would re-append non-dedupable
/// updates and cost O(history) per open. Each drained coordinate's marker
/// row is removed after a successful apply/dedup. Terminal payload refusals
/// are returned as well as persisted so the triggering caller can report them.
pub fn drain_deferred_ydoc_for_key(
    store: &mut EngineStore,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
    let pending: Vec<(String, i64, i64, YdocUpdatePayload)> = store.read_with(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT log.origin_id, log.origin_seq, log.recorded_at_ms, log.payload_json \
                 FROM ydoc_deferred_updates AS deferred \
                 JOIN replication_log AS log \
                   ON log.workspace_id = deferred.workspace_id \
                  AND log.origin_id = deferred.origin_id \
                  AND log.origin_seq = deferred.origin_seq \
                 WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2 \
                   AND deferred.object_id = ?3 AND log.op_kind = 'ydoc.update' \
                 ORDER BY log.recorded_at_ms, log.origin_id, log.origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        let rows = stmt
            .query_map(
                params![key.workspace_id, key.version_id, key.object_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .map_err(SyncError::corrupt)?;
        let mut pending = Vec::new();
        for row in rows {
            let (origin_id, origin_seq, recorded_at_ms, payload_json) =
                row.map_err(SyncError::corrupt)?;
            let payload = serde_json::from_str::<YdocUpdatePayload>(&payload_json)
                .map_err(|_| local_corruption("parked ydoc.update payload is malformed"))?;
            pending.push((origin_id, origin_seq, recorded_at_ms, payload));
        }
        Ok::<_, SyncError>(pending)
    })?;
    if pending.is_empty() {
        return Ok(YdocDrainResult::default());
    }
    let search_policy = search_policy_for_store(store);
    let mut applied = 0usize;
    let mut refusals = Vec::new();
    let mut sharing_declined = Vec::new();
    let mut last_payload: Option<YdocUpdatePayload> = None;
    let mut payload_recorded_at = 0_i64;
    let mut drained_coordinates: Vec<(String, i64)> = Vec::new();
    let mut last_coordinate: Option<(String, i64)> = None;
    for (origin_id, origin_seq, recorded_at_ms, payload) in pending {
        let established_kind = dohc_engine_collab::read_marker(store, key)
            .map_err(map_collab_hard_error)?
            .map(|marker| marker.content_kind);
        let content_kind_refusal =
            match dohc_engine_collab::ContentKind::parse(&payload.content_kind) {
                Ok(payload_kind) if established_kind.is_some_and(|kind| kind != payload_kind) => {
                    Some("ydoc.update content kind does not match the established lineage")
                }
                Ok(_) => None,
                Err(_) => {
                    Some("ydoc.update content kind must be `plaintext`, `richdoc`, or `scene`")
                }
            };
        // Once the base arrives it establishes the authoritative path. A
        // queued payload naming another path is still refused, but its valid
        // CRDT bytes must enter the lineage first so descendants do not retain
        // an impossible missing-client-clock dependency.
        let identity_refusal =
            match store.read_with(|conn| validate_ydoc_identity(conn, key, &payload.path)) {
                Ok(_) => None,
                Err(SyncError::InvalidInput { reason }) => Some(reason),
                Err(hard) => return Err(hard),
            };
        let bytes = store
            .get_binary_blob(&payload.update_blob_sha256)?
            .ok_or(SyncError::BlobInvalid)?;
        if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        let outcome = match apply_remote_update(
            store,
            key,
            &RemoteUpdate {
                origin_id: origin_id.clone(),
                origin_seq,
                bytes,
            },
            faults,
            recorded_at_ms,
        ) {
            Ok(outcome) => outcome,
            Err(error) => {
                match map_collab_payload_error(error, "parked ydoc.update could not be applied") {
                    SyncError::InvalidInput { reason } => {
                        refusals.push(refuse_deferred_ydoc(
                            store, key, &origin_id, origin_seq, reason, faults,
                        )?);
                        continue;
                    }
                    hard => return Err(hard),
                }
            }
        };
        match outcome {
            TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. }) => applied += 1,
            TxnOutcome::Committed(ReplicationApplyOutcome::Deduped { .. }) => {}
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
        if let Some(reason) = content_kind_refusal.or(identity_refusal) {
            // The CRDT bytes landed even though the established path identity
            // forbids projection. Count the coordinate as drained before its
            // already-ACKed queue row is converted into a refusal: a live
            // client's doc has not integrated these bytes, so settle must
            // force a resync instead of materializing unseen remote content.
            drained_coordinates.push((origin_id.clone(), origin_seq));
            refusals.push(refuse_deferred_ydoc(
                store, key, &origin_id, origin_seq, reason, faults,
            )?);
            continue;
        }
        // The payload tracks for DEDUPED rows too: a crash between an
        // earlier drain's apply and its marker delete redelivers the row as
        // a dedupe, and the projection below must still run or the visible
        // head stays behind the already-applied CRDT forever.
        payload_recorded_at = recorded_at_ms;
        last_payload = Some(payload);
        last_coordinate = Some((origin_id.clone(), origin_seq));
        drained_coordinates.push((origin_id, origin_seq));
    }
    // Drained content must reach the VISIBLE head here, not only the CRDT
    // log: the drain runs outside `apply_envelope_with`, so a redelivery of
    // an already-acked coordinate skips its mutation closure — if the drain
    // did not project, the snapshot/materialization would stay stale until
    // some unrelated open/settle. Same idempotent-by-sha write as the pull
    // path; skipped while cross-origin dependencies are still pending.
    let (drain_origin, drain_seq) = match &last_coordinate {
        Some((origin, seq)) => (origin.as_str(), *seq),
        None => ("deferred-drain", payload_recorded_at),
    };
    if let Some(payload) = last_payload
        && let Some(persisted) =
            dohc_engine_collab::load_persisted(store, key).map_err(map_collab_hard_error)?
        && !persisted.doc.has_pending_dependencies()
    {
        let projected = store.write_with(faults, |tx| {
            project_and_write_in_tx(
                tx,
                key,
                &payload.path,
                &persisted.doc,
                persisted.marker.content_kind,
                // The REAL last drained coordinate keys the moment id: a
                // synthetic (origin, recorded_at_ms) pair collides when two
                // drain batches land updates in the same millisecond, and
                // the duplicate id wedges the projection write.
                drain_origin,
                drain_seq,
                payload_recorded_at,
                search_policy.as_ref(),
            )?;
            crate::originate_ydoc_base_in_tx(tx, key, &payload.path, payload_recorded_at)
        });
        match projected {
            Ok(TxnOutcome::Committed(crate::BaseOrigination::Declined(declined))) => {
                sharing_declined.push(declined);
            }
            Ok(TxnOutcome::Committed(_)) => {}
            Ok(TxnOutcome::Crashed { .. }) => return Err(SyncError::FaultCrash),
            // These rows are already ACKed and therefore cannot be retried
            // from the relay. If an identity pin now blocks projection,
            // retaining the marker would wedge every later drain. The CRDT
            // content is durable above; the visible path legitimately remains
            // governed by its current owner, so consume the marker.
            Err(SyncError::InvalidInput { .. } | SyncError::ProjectionTooLarge { .. }) => {}
            // Anything else (storage) is retryable: keep the markers so the
            // next drain retries the projection.
            Err(other) => return Err(other),
        }
    }
    // The durable markers clear LAST — after the projection committed. A
    // crash anywhere above leaves the rows in place, and the retry re-runs
    // apply (content-deduped) AND the projection; deleting first opened a
    // window where the CRDT held the edit but nothing would ever project it.
    let cleared = store.write_with(faults, |tx| {
        for (origin_id, origin_seq) in &drained_coordinates {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![key.workspace_id, origin_id, origin_seq],
            )
            .map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    })?;
    if matches!(cleared, TxnOutcome::Crashed { .. }) {
        return Err(SyncError::FaultCrash);
    }
    // The count is DRAINED COORDINATES, not newly-applied rows: a marker
    // surviving an earlier failed drain redelivers its row as a dedupe, and
    // callers (the settle's remote-updates-pending refusal) must still see
    // that remote content landed which the live client has not resynced.
    let _ = applied;
    Ok(YdocDrainResult {
        drained: drained_coordinates.len(),
        refusals,
        sharing_declined,
    })
}

/// Permanently dispose one already-ACKed deferred coordinate once the eventual
/// base proves its bytes payload-invalid. The refusal record and queue delete
/// share a transaction: a crash leaves the marker retryable, while a commit
/// guarantees this coordinate can never wedge later valid updates.
fn refuse_deferred_ydoc(
    store: &mut EngineStore,
    key: &DocKey,
    origin_id: &str,
    origin_seq: i64,
    reason: &'static str,
    faults: &dyn FaultInjector,
) -> Result<crate::ReplicationRefusal, SyncError> {
    let refusal = crate::ReplicationRefusal {
        workspace_id: key.workspace_id.clone(),
        origin_id: origin_id.to_owned(),
        origin_seq,
        op_kind: "ydoc.update".to_owned(),
        reason: crate::RefusalReason::InvalidInput {
            reason: reason.to_owned(),
        },
    };
    match store.write_with(faults, |tx| {
        crate::apply::persist_refusal(tx, &refusal)?;
        tx.execute(
            "DELETE FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![key.workspace_id, origin_id, origin_seq],
        )
        .map_err(SyncError::persist)?;
        Ok::<_, SyncError>(())
    })? {
        TxnOutcome::Committed(()) => Ok(refusal),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// The deterministic per-envelope moment id the projection mints. Also the
/// incoming-side anchor of a base-divergence conflict, so a crash-redelivery
/// can recount the conflict it opened.
fn ydoc_apply_moment_id(key: &DocKey, path: &str, origin_id: &str, origin_seq: i64) -> String {
    let fingerprint = format!(
        "{}\0{}\0{}\0{}\0{}\0{}",
        key.workspace_id, key.version_id, key.object_id, path, origin_id, origin_seq
    );
    format!(
        "moment-ydoc-apply-{}",
        dohc_engine_storage::hex_sha256(fingerprint.as_bytes())
    )
}

/// The open sync conflict currently anchored on this object, if any. The
/// daemon's settle freeze reads the same probe the projection guard uses, so
/// the two cannot disagree about whether the head is under review.
pub fn open_sync_conflict_for_object(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT conflict_id FROM conflicts \
         WHERE workspace_id=?1 AND status='open' AND metadata_origin='sync' \
           AND target_version_id=?2 AND incoming_object_id=?3 \
         ORDER BY created_at_ms, conflict_id LIMIT 1",
        params![workspace_id, version_id, object_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn open_sync_conflict_id(
    conn: &rusqlite::Connection,
    key: &DocKey,
) -> Result<Option<String>, SyncError> {
    open_sync_conflict_for_object(conn, &key.workspace_id, &key.version_id, &key.object_id)
}

/// Retire a tracked head's Y.Doc lineage in the transaction that deletes it.
///
/// Removing the CRDT rows and marker prevents a later delta from projecting
/// deleted content back into a snapshot. A later base starts a fresh lineage.
/// Scene lineages stay durable because their delete-time asset authority and
/// rollback both depend on the canonical scene records.
pub fn retire_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
) -> Result<(), SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "Y.Doc lineage coordinates are invalid",
        })?;
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, &key)?;
    if complete
        .state
        .as_ref()
        .is_some_and(|(marker, _)| marker.content_kind == dohc_engine_collab::ContentKind::Scene)
    {
        return Ok(());
    }
    retire_complete_ydoc_lineage_in_tx(tx, &complete)
}

pub(crate) struct CompleteYdocLineage {
    key: DocKey,
    state: Option<(dohc_engine_collab::Marker, dohc_engine_collab::Ydoc)>,
}

/// The durable file head that must remain canonical after a non-Y.Doc
/// mutation commits.
pub enum ResultingHead<'a> {
    Text { path: &'a str, text: &'a str },
    BinaryOrAbsent,
}

pub(crate) fn retire_complete_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
) -> Result<(), SyncError> {
    let key = &complete.key;
    for statement in [
        "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        "DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        "DELETE FROM ydoc_deferred_updates \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        "DELETE FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
    ] {
        tx.execute(
            statement,
            params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(SyncError::persist)?;
    }
    Ok(())
}

pub(crate) fn ydoc_lineage_has_durable_state_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM ydoc_updates
              WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
             UNION ALL
             SELECT 1 FROM ydoc_snapshots
              WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
             UNION ALL
             SELECT 1 FROM ydoc_deferred_updates
              WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
             UNION ALL
             SELECT 1 FROM ydoc_docs
              WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
                AND (head_update_seq > 0 OR head_snapshot_seq > 0
                     OR lineage_claim_status <> 'unclaimed')
         )",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

enum YdocLineageCompleteness {
    Complete(Option<(dohc_engine_collab::Marker, dohc_engine_collab::Ydoc)>),
    DeferredUpdates,
    PendingDependencies,
}

fn ydoc_lineage_completeness_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<YdocLineageCompleteness, SyncError> {
    let deferred: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if deferred {
        return Ok(YdocLineageCompleteness::DeferredUpdates);
    }
    let Some(marker) =
        dohc_engine_collab::read_marker_in_tx(tx, key).map_err(map_collab_hard_error)?
    else {
        return Ok(YdocLineageCompleteness::Complete(None));
    };
    let doc = dohc_engine_collab::load_doc_in_tx(tx, key).map_err(map_collab_hard_error)?;
    if doc.has_pending_dependencies() {
        return Ok(YdocLineageCompleteness::PendingDependencies);
    }
    Ok(YdocLineageCompleteness::Complete(Some((marker, doc))))
}

pub(crate) fn ensure_ydoc_lineage_complete_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<CompleteYdocLineage, SyncError> {
    match ydoc_lineage_completeness_in_tx(tx, key)? {
        YdocLineageCompleteness::Complete(state) => Ok(CompleteYdocLineage {
            key: key.clone(),
            state,
        }),
        YdocLineageCompleteness::DeferredUpdates => Err(SyncError::RetryableState {
            reason: "ydoc-deferred-updates-pending",
        }),
        YdocLineageCompleteness::PendingDependencies => Err(SyncError::RetryableState {
            reason: "ydoc-incomplete-lineage",
        }),
    }
}

pub(crate) struct CompleteYdocProjection {
    pub content: Option<String>,
    pub claim_status: dohc_engine_collab::LineageClaimStatus,
}

/// Inspect one closed lineage after proving that none of its durable updates
/// are deferred or dependency-incomplete.
pub(crate) fn complete_ydoc_projection_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<Option<CompleteYdocProjection>, SyncError> {
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, key)?;
    let Some((marker, doc)) = complete.state.as_ref() else {
        return Ok(None);
    };
    let has_content = marker.lineage_claim_status.has_claimed_base()
        || marker.head_update_seq > 0
        || marker.head_snapshot_seq > 0;
    let content = if has_content {
        Some(project_ydoc_with_store(tx, key, doc, marker.content_kind)?.content)
    } else {
        None
    };
    Ok(Some(CompleteYdocProjection {
        content,
        claim_status: marker.lineage_claim_status,
    }))
}

/// Reconcile a strict conflict parent with a receiver-local closed lineage.
/// The parent is the replicated operation, so the local CRDT rewrite must not
/// emit a second `ydoc.update`.
pub(crate) fn reconcile_conflict_parent_resulting_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    resulting: ResultingHead<'_>,
    now_ms: i64,
) -> Result<(), SyncError> {
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, key)?;
    match resulting {
        ResultingHead::Text { path, text } => {
            fold_complete_ydoc_lineage_in_tx(tx, &complete, path, text, now_ms, false)
        }
        ResultingHead::BinaryOrAbsent => retire_complete_ydoc_lineage_in_tx(tx, &complete),
    }
}

/// Reconcile a locally-originated file mutation with its closed Y.Doc
/// lineage. The generated CRDT update is journaled before the mutation's
/// artifact operation, so every peer applies one canonical rewrite.
pub fn reconcile_local_resulting_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    resulting: ResultingHead<'_>,
    now_ms: i64,
) -> Result<(), SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "Y.Doc lineage coordinates are invalid",
        })?;
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, &key)?;
    match resulting {
        ResultingHead::Text { path, text } => {
            fold_complete_ydoc_lineage_in_tx(tx, &complete, path, text, now_ms, true)
        }
        ResultingHead::BinaryOrAbsent => retire_complete_ydoc_lineage_in_tx(tx, &complete),
    }
}

/// Finalize an imported file mutation without creating a second CRDT edit.
/// A text mutation must follow its origin's ordered Y.Doc rewrite; if that
/// rewrite is not present yet, the envelope remains unacknowledged.
pub fn reconcile_imported_resulting_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    resulting: ResultingHead<'_>,
    now_ms: i64,
) -> Result<(), SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "Y.Doc lineage coordinates are invalid",
        })?;
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, &key)?;
    reconcile_imported_complete_resulting_head_in_tx(tx, &complete, resulting, now_ms)
}

pub(crate) fn reconcile_imported_complete_resulting_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
    resulting: ResultingHead<'_>,
    now_ms: i64,
) -> Result<(), SyncError> {
    match resulting {
        ResultingHead::BinaryOrAbsent => retire_complete_ydoc_lineage_in_tx(tx, complete),
        ResultingHead::Text { path, text } => {
            let Some((marker, doc)) = complete.state.as_ref() else {
                return Ok(());
            };
            let has_content = marker.lineage_claim_status.has_claimed_base()
                || marker.head_update_seq > 0
                || marker.head_snapshot_seq > 0;
            if has_content {
                let projection =
                    project_ydoc_with_store(tx, &complete.key, doc, marker.content_kind)?;
                if projection.content != text {
                    return Err(SyncError::RetryableState {
                        reason: "ydoc-resulting-head-pending",
                    });
                }
            }
            settle_ydoc_marker_to_text(tx, &complete.key, path, text, now_ms)
        }
    }
}

/// Fold a conflict resolution's chosen text into the object's canonical
/// Y.Doc, inside the resolution's own transaction.
///
/// The invariant, stated once: an OPEN sync conflict on a Y.Doc object
/// freezes the visible head (`project_and_write_in_tx` coalesces the
/// conflict's incoming side instead of writing) and the settle (the daemon
/// refuses with `ydoc-conflict-open`, the same shape as #338's refusal of
/// the clobbering settle). RESOLUTION lifts the freeze by making the choice
/// durable here — one update that rewrites the lineage's projection to the
/// chosen bytes, journaled when the workspace replicates — in the SAME
/// transaction that closes the row, so the next inbound delta merges with
/// the choice instead of silently reversing it.
///
/// A non-Y.Doc object, an unclaimed lineage (local-only cache; the file is
/// canonical and reseeds it), and a projection that already equals the
/// choice are all no-ops.
pub fn fold_resolution_into_ydoc_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    path: &str,
    chosen_text: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "conflict resolution coordinates are invalid",
        })?;
    // Acked-but-parked remote updates for this object were never part of
    // EITHER reviewed side, and the drain that lands them runs after the
    // review gate would have closed. Refuse the resolution while they are
    // queued: a resync or session close drains them, the open conflict
    // coalesces to the freshest incoming state, and the user resolves what
    // they can actually see.
    let complete = match ydoc_lineage_completeness_in_tx(tx, &key)? {
        YdocLineageCompleteness::Complete(complete) => complete,
        YdocLineageCompleteness::DeferredUpdates => {
            return Err(SyncError::InvalidInput {
                reason: "ydoc-deferred-updates-pending",
            });
        }
        YdocLineageCompleteness::PendingDependencies => {
            return Err(SyncError::InvalidInput {
                reason: "ydoc-incomplete-lineage",
            });
        }
    };
    let complete = CompleteYdocLineage {
        key,
        state: complete,
    };
    fold_complete_ydoc_lineage_in_tx(tx, &complete, path, chosen_text, now_ms, true)
}

pub(crate) fn fold_complete_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
    path: &str,
    chosen_text: &str,
    now_ms: i64,
    journal: bool,
) -> Result<(), SyncError> {
    let key = &complete.key;
    let Some((marker, doc)) = complete.state.as_ref() else {
        return Ok(());
    };
    let has_content = marker.lineage_claim_status.has_claimed_base()
        || marker.head_update_seq > 0
        || marker.head_snapshot_seq > 0;
    if !has_content {
        tx.execute(
            "UPDATE ydoc_docs SET path=?4, updated_at_ms=?5 \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                path,
                now_ms,
            ],
        )
        .map_err(SyncError::persist)?;
        return Ok(());
    }
    let projection = project_ydoc_with_store(tx, key, doc, marker.content_kind)?;
    if projection.content != chosen_text {
        let update = doc
            .rewrite_content_to_markdown(marker.content_kind, chosen_text)
            .map_err(|_| SyncError::InvalidInput {
                reason: "the content kind does not support Markdown conflict resolution",
            })?;
        // VERIFY THE FOLD'S OWN OUTPUT. The markdown parser behind the
        // rewrite is asserted to be the projector's inverse, and nothing
        // makes that true: a construct it does not model round-trips through
        // the projector's escaping (a deep `>` chain returns as `&gt;`), and
        // the fold would then commit a lineage whose projection is NOT the
        // chosen text while stamping last_settled_sha with the chosen text's
        // hash in the same statement — the head file saying one thing, the
        // CRDT another, and the marker asserting they agree. That is the
        // silent reversal this whole PR exists to close, reintroduced by the
        // fold. Re-project and compare instead of trusting the parser: the
        // doc and the transaction are already in hand, so the check is one
        // projection, and it covers every construct the parser will ever
        // fail to model rather than the ones known today.
        // SIZE FIRST (#660): check length before the projection below — an
        // oversized doc trips a bare, limit-less `InvalidInput` there (#643).
        if update.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(SyncError::BlobTooLarge {
                constraint: "MAX_YDOC_UPDATE_BYTES (conflict resolution fold)",
                limit_bytes: dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
                observed_bytes: update.len(),
            });
        }
        let refolded = project_ydoc_with_store(tx, &key, &doc, marker.content_kind)?;
        if refolded.content != chosen_text {
            return Err(SyncError::InvalidInput {
                reason: "ydoc-resolution-not-representable",
            });
        }
        let outcome =
            dohc_engine_collab::record_update_in_tx(tx, key, &update, now_ms).map_err(|error| {
                map_collab_payload_error(error, "conflict resolution fold could not be appended")
            })?;
        // Journal only when this workspace actually replicates: a receiver
        // that never enrolled has no sync identity, and its choice needs no
        // peer. `emit_outbound` alone cannot gate this — a claimed lineage
        // exists on identity-less receivers too.
        if journal
            && marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
            && !outcome.deduped
            && crate::journal::workspace_replicates_with_relay_in_tx(tx, &key.workspace_id)?
        {
            crate::journal::journal_local_op_in_tx(
                tx,
                &key.workspace_id,
                "ydoc.update",
                &crate::ydoc_update_payload(
                    key,
                    path,
                    marker.content_kind,
                    &dohc_engine_storage::hex_sha256(&update),
                    false,
                ),
                now_ms,
            )?;
        }
    }
    // The resolution's head IS the settled artifact now: align the settle
    // expectation so the next session does not refuse ConflictStaleTarget
    // over the very state the user just chose.
    settle_ydoc_marker_to_text(tx, key, path, chosen_text, now_ms)
}

fn settle_ydoc_marker_to_text(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    text: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "UPDATE ydoc_docs SET path=?4, last_settled_sha=?5, updated_at_ms=?6 \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            path,
            dohc_engine_storage::hex_sha256(text.as_bytes()),
            now_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Store the projected content as a text blob so a conflict side can
/// reference it (the conflict UI hydrates sides from `blobs`).
fn put_projection_text_blob(
    tx: &rusqlite::Transaction<'_>,
    content: &str,
    sha256: &str,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
        params![sha256, content.len() as i64, content],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Project one canonical live document through authoritative versioned state.
/// Scene bytes never enter the Y.Doc; they resolve from the same workspace and
/// version as its lineage and are injected only into the portable artifact.
pub fn project_ydoc_with_store(
    conn: &Connection,
    key: &DocKey,
    doc: &dohc_engine_collab::Ydoc,
    content_kind: dohc_engine_collab::ContentKind,
) -> Result<dohc_engine_collab::Projection, SyncError> {
    if content_kind != dohc_engine_collab::ContentKind::Scene {
        return doc.project(content_kind).map_err(map_projection_error);
    }
    let folded = doc.fold_scene();
    // The unhydrated portable form bounds the scene-owned JSON before any
    // binary reads. Track a lower bound for the final data URLs as each asset
    // is resolved so repeated files cannot accumulate unbounded raw blobs only
    // to be refused by the serializer afterward.
    let mut projected_bytes = folded
        .portable_json()
        .map_err(map_scene_projection_error)?
        .len();
    let referenced: std::collections::BTreeSet<&str> = folded
        .elements
        .iter()
        .filter(|element| element.get("type").and_then(serde_json::Value::as_str) == Some("image"))
        .filter_map(|element| element.get("fileId").and_then(serde_json::Value::as_str))
        .collect();
    let mut bytes_by_id = std::collections::BTreeMap::new();
    for id in referenced {
        let asset = folded.assets.get(id).ok_or(SyncError::InvalidInput {
            reason: "scene asset record is invalid",
        })?;
        let expected = dohc_engine_collab::scene_asset_ref(
            &key.workspace_id,
            &key.version_id,
            &key.object_id,
            &asset.sha256,
            &asset.mime_type,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "scene asset authority is invalid",
        })?;
        let (classification, normalized) = classify_engine_file_path_normalized(&asset.path);
        if asset.path != expected
            || classification != PathClassification::Tracked
            || normalized.as_deref() != Some(asset.path.as_str())
        {
            return Err(SyncError::InvalidInput {
                reason: "scene asset authority is invalid",
            });
        }
        let head: Option<(String, Option<String>, Option<i64>)> = conn
            .query_row(
                "SELECT COALESCE(s.content_kind, 'text'), s.binary_sha256, b.byte_length \
                 FROM path_aliases a JOIN snapshots s \
                    ON s.workspace_id=a.workspace_id AND s.version_id=a.version_id \
                   AND s.object_id=a.object_id \
                 LEFT JOIN binary_blobs b ON b.sha256=s.binary_sha256 \
                  WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path=?3",
                params![key.workspace_id, key.version_id, asset.path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        let Some((kind, sha256, byte_length)) = head else {
            return Err(SyncError::RetryableState {
                reason: "scene asset head is pending",
            });
        };
        if kind != "binary" || sha256.as_deref() != Some(asset.sha256.as_str()) {
            return Err(SyncError::InvalidInput {
                reason: "scene asset authority is invalid",
            });
        }
        let byte_length = byte_length
            .ok_or(SyncError::RetryableState {
                reason: "scene asset blob is pending",
            })
            .and_then(|value| {
                usize::try_from(value).map_err(|_| SyncError::InvalidInput {
                    reason: "scene asset authority is invalid",
                })
            })?;
        let data_url_len = dohc_engine_collab::scene_data_url_len(&asset.mime_type, byte_length)
            .map_err(map_scene_projection_error)?;
        projected_bytes =
            projected_bytes
                .checked_add(data_url_len)
                .ok_or(SyncError::ProjectionTooLarge {
                    constraint: "MAX_PROJECTION_BYTES",
                    actual_bytes: usize::MAX,
                    limit_bytes: dohc_engine_collab::limits::MAX_PROJECTION_BYTES,
                })?;
        if projected_bytes > dohc_engine_collab::limits::MAX_PROJECTION_BYTES {
            return Err(SyncError::ProjectionTooLarge {
                constraint: "MAX_PROJECTION_BYTES",
                actual_bytes: projected_bytes,
                limit_bytes: dohc_engine_collab::limits::MAX_PROJECTION_BYTES,
            });
        }
        let bytes = get_binary_blob(conn, &asset.sha256)?.ok_or(SyncError::RetryableState {
            reason: "scene asset blob is pending",
        })?;
        if hex_sha256(&bytes) != asset.sha256 {
            return Err(SyncError::InvalidInput {
                reason: "scene asset authority is invalid",
            });
        }
        bytes_by_id.insert(id.to_owned(), bytes);
    }
    let content = folded
        .portable_json_with_asset_bytes(&bytes_by_id)
        .map_err(map_scene_projection_error)?;
    Ok(dohc_engine_collab::Projection {
        content,
        content_kind,
        source_state_vector_sha256: hex_sha256(&doc.encode_state_vector()),
        destructive: false,
    })
}

fn map_scene_projection_error(error: dohc_engine_collab::CollabError) -> SyncError {
    match error {
        dohc_engine_collab::CollabError::ProjectionTooLarge { actual, max } => {
            SyncError::ProjectionTooLarge {
                constraint: "MAX_PROJECTION_BYTES",
                actual_bytes: actual,
                limit_bytes: max,
            }
        }
        _ => SyncError::InvalidInput {
            reason: "scene projection is invalid",
        },
    }
}

fn map_projection_error(error: dohc_engine_collab::CollabError) -> SyncError {
    match error {
        dohc_engine_collab::CollabError::ProjectionTooLarge { actual, max } => {
            SyncError::ProjectionTooLarge {
                constraint: "MAX_PROJECTION_BYTES",
                actual_bytes: actual,
                limit_bytes: max,
            }
        }
        _ => SyncError::InvalidInput {
            reason: "ydoc projection is invalid",
        },
    }
}

/// Oracle parity for applied `ydoc.update` ops (`projectYDocUpdate` →
/// `writeTextFileInDb` → CRDT rows): every NON-DEFERRED apply materializes
/// its projection — moment, snapshot, and durable materialization job — in
/// the SAME admission transaction, so `versionedText.read`, search, and the
/// disk pipeline advance with the relay cursor instead of trailing it until
/// someone manually opens and settles the doc.
#[allow(clippy::too_many_arguments)]
pub fn project_and_write_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    doc: &dohc_engine_collab::Ydoc,
    content_kind: dohc_engine_collab::ContentKind,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<(), SyncError> {
    let current = validate_ydoc_identity(tx, key, path)?;
    let projection = project_ydoc_with_store(tx, key, doc, content_kind)?;
    // While a sync conflict is open on this object, the visible head belongs
    // to the user's review: writing through it would clobber the exact state
    // the conflict preserves. Coalesce the incoming side to the freshest
    // remote projection instead (moment-lane parity) and leave the head and
    // the settle marker alone until a resolution closes the conflict.
    if let Some(conflict_id) = open_sync_conflict_id(tx, key)? {
        let projected_sha = dohc_engine_storage::hex_sha256(projection.content.as_bytes());
        put_projection_text_blob(tx, &projection.content, &projected_sha)?;
        let matches_reviewed_side: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM conflicts \
                 WHERE workspace_id=?1 AND conflict_id=?2 AND (\
                   (current_exists=1 AND current_content_kind='text' \
                    AND current_blob_sha256=?3) OR \
                   (incoming_exists=1 AND incoming_content_kind='text' \
                    AND incoming_blob_sha256=?3)))",
                params![key.workspace_id, conflict_id, projected_sha],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        // A resolution rewrite names bytes the open conflict already shows.
        // Keep both side anchors stable for the ordered resolve that follows.
        if !matches_reviewed_side {
            crate::moment_apply::coalesce_conflict_sides(
                tx,
                &key.workspace_id,
                &conflict_id,
                &crate::moment_apply::ConflictSide {
                    exists: true,
                    path: path.to_owned(),
                    object_id: Some(key.object_id.clone()),
                    kind: Some(crate::moment_apply::ContentKind::Text),
                    digest: Some(projected_sha),
                    updated_at_ms: Some(now_ms),
                    latest_moment_id: Some(ydoc_apply_moment_id(key, path, origin_id, origin_seq)),
                    metadata: Some(crate::moment_apply::Metadata {
                        origin: "sync".to_owned(),
                        summary: None,
                        correlation_id: None,
                    }),
                },
                now_ms,
            )?;
        }
        return Ok(());
    }
    // Idempotent skip: a redelivered (or content-converged) envelope whose
    // projection already IS the head mints no duplicate moment/job — but the
    // MARKER still advances: the head may have reached these bytes via
    // capture/local write while last_settled_sha points at an older settle,
    // and leaving it stale would wedge the next settle in
    // ConflictStaleTarget over a converged doc.
    let projected_sha = dohc_engine_storage::hex_sha256(projection.content.as_bytes());
    if let Some(snapshot) = current
        .snapshot
        .as_ref()
        .filter(|snapshot| snapshot.blob_sha256 == projected_sha)
    {
        tx.execute(
            "UPDATE ydoc_docs SET last_settled_sha = ?4, updated_at_ms = ?5              WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                snapshot.blob_sha256,
                now_ms,
            ],
        )
        .map_err(SyncError::persist)?;
        return Ok(());
    }
    let preimage = current
        .snapshot
        .as_ref()
        .map_or(Preimage::Absent, |snapshot| {
            Preimage::Present(snapshot.blob_sha256.clone())
        });
    // Deterministic per-envelope moment id: a crash between commit and
    // cursor advance redelivers the envelope, whose re-apply lands in the
    // idempotent skip above (same projection) — the id can never collide.
    let moment_id = ydoc_apply_moment_id(key, path, origin_id, origin_seq);
    let result = write_projected_text_in_tx(
        tx,
        &WriteText {
            workspace_id: key.workspace_id.clone(),
            version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            path: path.to_owned(),
            text: projection.content.clone(),
            moment_id,
            metadata_origin: "ydoc".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms,
            request_id: None,
        },
    )
    .map_err(|error| map_domain_payload_error(error, "ydoc.update projection write failed"))?;
    if !result.deduped {
        upsert_file_search_index(
            tx,
            &key.workspace_id,
            &key.version_id,
            &result.snapshot.object_id,
            &result.snapshot.path,
            Some(&result.snapshot.text),
            search_policy,
        )?;
    }
    enqueue_write(tx, &result, preimage, "ydoc").map_err(map_domain_hard_error)?;
    // The pulled projection IS the settled artifact (its job materializes
    // it): advance the marker exactly like a local settle would. Leaving the
    // OLD locally-settled sha behind would make the next session's settle
    // expectation trail the remote head — permanent ConflictStaleTarget.
    tx.execute(
        "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6          WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            result.moment.moment_order,
            projected_sha,
            now_ms,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub fn apply_ydoc_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Err(SyncError::UnsupportedOperation);
    }
    let payload: YdocUpdatePayload = match serde_json::from_value(envelope.payload.clone()) {
        Ok(payload) => payload,
        Err(_) => {
            return refuse_ydoc(store, envelope, faults, "ydoc.update payload is malformed");
        }
    };
    let search_policy = search_policy_for_store(store);
    // Gate on the SAME floor the projection sink applies
    // (`validate_plaintext_storable_path`) rather than R10's narrow
    // share-boundary classifier, which misses reserved 8.3 aliases (`dohc~1`
    // aliases `.dohc`) and dots-and-spaces segments. The path is persisted as a
    // durable alias key, so it must already be canonical.
    let (classification, normalized) = classify_engine_file_path_normalized(&payload.path);
    if classification != PathClassification::Tracked
        || normalized.as_deref() != Some(payload.path.as_str())
        || !matches!(
            payload.content_kind.as_str(),
            "plaintext" | "richdoc" | "scene"
        )
    {
        return refuse_ydoc(
            store,
            envelope,
            faults,
            "ydoc.update path or content kind is invalid",
        );
    }
    let key = match DocKey::new(
        envelope.workspace_id.clone(),
        payload.version_id,
        payload.object_id,
    ) {
        Ok(key) => key,
        Err(_) => {
            return refuse_ydoc(
                store,
                envelope,
                faults,
                "ydoc.update coordinates are invalid",
            );
        }
    };
    // The blob is validated BEFORE any ack path — including the live-lease
    // defer. A defer acks the coordinate with the imported log as the durable
    // queue; if the referenced blob were missing or tampered, the peer cursor
    // would already be past a row the drain can never apply, and the bad
    // coordinate cannot be re-fetched. Missing/corrupt blob leaves the
    // coordinate unacked instead.
    let bytes: Vec<u8> = store.read_with(|conn| {
        conn.query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&payload.update_blob_sha256],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::BlobInvalid)
    })?;
    if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
        return Err(SyncError::BlobInvalid);
    }
    if leases.is_live(&key) {
        // FULL durable validation BEFORE admission: byte caps, abort-safe
        // prevalidation, AND the replay-parity gate — replayed on top of the
        // ALREADY-QUEUED deferred predecessors, because a later update can
        // only become invalid after they apply, and the drain will apply
        // them first. Anything the drain would reject becomes a refusal, not a
        // deferred update.
        let queued: Vec<Vec<u8>> = {
            let mut queued = Vec::new();
            let rows: Vec<String> = store.read_with(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT log.payload_json                          FROM ydoc_deferred_updates AS deferred                          JOIN replication_log AS log                            ON log.workspace_id = deferred.workspace_id                           AND log.origin_id = deferred.origin_id                           AND log.origin_seq = deferred.origin_seq                          WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2                            AND deferred.object_id = ?3                          ORDER BY log.recorded_at_ms, log.origin_id, log.origin_seq",
                    )
                    .map_err(SyncError::corrupt)?;
                let mapped = stmt
                    .query_map(
                        params![key.workspace_id, key.version_id, key.object_id],
                        |row| row.get::<_, String>(0),
                    )
                    .map_err(SyncError::corrupt)?;
                mapped
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(SyncError::corrupt)
            })?;
            for payload_json in rows {
                let queued_payload = serde_json::from_str::<YdocUpdatePayload>(&payload_json)
                    .map_err(|_| local_corruption("parked ydoc.update payload is malformed"))?;
                let queued_bytes = store
                    .get_binary_blob(&queued_payload.update_blob_sha256)?
                    .ok_or(SyncError::BlobInvalid)?;
                queued.push(queued_bytes);
            }
            queued
        };
        if let Err(error) =
            dohc_engine_collab::validate_remote_update_with_pending(store, &key, &queued, &bytes)
        {
            return match map_collab_payload_error(
                error,
                "ydoc.update bytes fail durable validation",
            ) {
                SyncError::InvalidInput { reason } => refuse_ydoc(store, envelope, faults, reason),
                hard => Err(hard),
            };
        }
        // A deferred coordinate is ACKED — it must be drainable later, which
        // the close/open drains only do for REPLICATED markers. A live lease
        // over a local-only lineage is a transient local-state race. It stays
        // hard and unacked so the peer coordinate can be retried after the
        // session settles or closes.
        let marker = dohc_engine_collab::read_marker(store, &key).map_err(map_collab_hard_error)?;
        if !marker.is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated) {
            return Err(SyncError::RetryableState {
                reason: "live lease on a non-replicated Y.Doc lineage",
            });
        }
        let deferred_key = key.clone();
        return crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
            // Record WHICH coordinate is pending in the same transaction as
            // the ack: drains replay exactly these rows, never the whole
            // imported history (which after compaction would re-append
            // non-dedupable updates and cost O(history) per open).
            tx.execute(
                "INSERT OR IGNORE INTO ydoc_deferred_updates                  (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms)                  VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    deferred_key.workspace_id,
                    deferred_key.version_id,
                    deferred_key.object_id,
                    op.origin_id,
                    op.origin_seq,
                    op.recorded_at_ms,
                ],
            )
            .map_err(SyncError::persist)?;
            Ok(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-session-live"),
                conflicts_opened: 0,
            })
        });
    }
    // Base bootstrap: a fresh replica's FIRST op for a replicated doc is the
    // base full-state — apply_remote_update requires an existing marker, so
    // without this branch the pull wedges on NoMarker before the ack. The
    // claim is idempotent (an existing claimed base resumes), so a crash
    // between claim and ack replays safely; the coordinate then acks below.
    if payload.is_base_state {
        // The claim runs INSIDE the admission transaction: a standalone claim
        // before apply_envelope_with would persist the marker/base for an
        // envelope the sequence/divergence checks then reject (out-of-order
        // or divergent redelivery), leaving state for an unacked coordinate.
        let kind = dohc_engine_collab::ContentKind::parse(&payload.content_kind)
            .map_err(map_collab_hard_error)?;
        let sv_bytes = {
            let doc = dohc_engine_collab::Ydoc::wire();
            if doc.apply(&bytes).is_err() {
                return refuse_ydoc(
                    store,
                    envelope,
                    faults,
                    "ydoc.update base bytes fail validation",
                );
            }
            doc.encode_state_vector()
        };
        let claim_key = key.clone();
        let claim_bytes = bytes.clone();
        // The claim can PROMOTE a local-only lineage that already holds
        // update rows (a crash left them behind): the projection must be the
        // reconstructed lineage PLUS the base, or the visible snapshot would
        // drop local content that is still durably part of the CRDT.
        let (base_doc, _lineage_has_state) = {
            let persisted =
                dohc_engine_collab::load_persisted(store, &key).map_err(map_collab_hard_error)?;
            let lineage_has_state = persisted.as_ref().is_some_and(|persisted| {
                persisted.marker.head_update_seq > 0 || persisted.marker.head_snapshot_seq > 0
            });
            let doc = match persisted {
                Some(persisted) => persisted.doc,
                None => dohc_engine_collab::Ydoc::wire(),
            };
            if doc.apply(&claim_bytes).is_err() {
                return refuse_ydoc(
                    store,
                    envelope,
                    faults,
                    "ydoc.update base bytes fail validation",
                );
            }
            (doc, lineage_has_state)
        };
        let base_path = payload.path.clone();
        let outcome = crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
            // Cross-origin file edits can temporarily occupy this path before
            // the base arrives. Retrying after the later delete/rename is
            // convergence-safe; refusing and ACKing would lose the base
            // forever on this receiver.
            let current = validate_retryable_ydoc_identity(tx, &claim_key, &base_path)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id, object_id, created_at_ms)                  VALUES (?1, ?2, ?3)",
                rusqlite::params![claim_key.workspace_id, claim_key.object_id, op.recorded_at_ms],
            )
            .map_err(SyncError::persist)?;
            // A non-base update can preallocate the FK parent before the base
            // establishes the lineage. That bare placeholder is not the
            // object's provenance: the base coordinate is. Match the daemon's
            // preallocated-object rule by correcting only an unbound,
            // markerless object that actually has a pre-base queue entry.
            tx.execute(
                "UPDATE file_objects SET created_at_ms=?3 \
                 WHERE workspace_id=?1 AND object_id=?2 \
                   AND EXISTS(SELECT 1 FROM ydoc_deferred_updates \
                     WHERE workspace_id=?1 AND version_id=?4 AND object_id=?2) \
                   AND NOT EXISTS(SELECT 1 FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?4 AND object_id=?2) \
                   AND NOT EXISTS(SELECT 1 FROM path_aliases \
                     WHERE workspace_id=?1 AND object_id=?2) \
                   AND NOT EXISTS(SELECT 1 FROM snapshots \
                     WHERE workspace_id=?1 AND object_id=?2)",
                params![
                    claim_key.workspace_id,
                    claim_key.object_id,
                    op.recorded_at_ms,
                    claim_key.version_id,
                ],
            )
            .map_err(SyncError::persist)?;
            dohc_engine_collab::claim_base_in_tx(
                tx,
                &claim_key,
                kind,
                &claim_bytes,
                &sv_bytes,
                op.recorded_at_ms,
            )
            .map_err(|error| {
                map_collab_payload_error(error, "ydoc.update base could not be claimed")
            })?;
            // A shipped fork snapshot preserves its source metadata in
            // `fork_base_snapshots`. Copy that existing ancestry marker onto
            // the newly claimed target lineage only while the current head is
            // still the exact fork materialization.
            tx.execute(
                "UPDATE ydoc_docs SET last_settled_sha=(
                     SELECT f.blob_sha256 FROM fork_base_snapshots f
                     JOIN snapshots s
                       ON s.workspace_id=f.workspace_id
                      AND s.version_id=f.version_id
                      AND s.object_id=f.object_id
                      AND s.path=f.path
                      AND s.blob_sha256=f.blob_sha256
                      AND s.latest_moment_id=f.latest_moment_id
                    WHERE f.workspace_id=?1 AND f.version_id=?2 AND f.object_id=?3
                      AND f.path=?4 AND f.metadata_origin='ydoc'
                 ) WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3
                       AND last_settled_sha IS NULL",
                params![
                    claim_key.workspace_id,
                    claim_key.version_id,
                    claim_key.object_id,
                    base_path
                ],
            )
            .map_err(SyncError::persist)?;
            // The FIRST base is not a CRDT merge: a local head that no shared
            // lineage ever merged (capture or an external editor wrote it, and
            // the receiver holds no durable Y.Doc rows to union with) must not
            // be silently replaced by the sender's projection. Keep the head,
            // land the lineage, and open the same reviewable sync conflict the
            // moment lane opens for a diverged file — one resolution settles
            // both machines. A head that already equals the base's projection
            // needs no conflict, and a lineage WITH durable rows takes the
            // union path below (the projection carries the local content).
            // Whether the head is REPRESENTED in this union, not whether the
            // lineage happens to hold rows. `lineage_has_state` was a proxy
            // for "the head was merged" and the two come apart exactly where
            // it matters: a local-only session that crashed leaves durable
            // unmaterialized rows, capture then records an external disk
            // edit, and the union is the crashed draft plus the peer's base
            // — not the newer captured head. The proxy said "rows exist, so
            // the CRDT is the merge" and the projection overwrote the user's
            // external edit with no conflict at all.
            //
            // The fact is `last_settled_sha`: the content this lineage last
            // put on disk. A head equal to it came from this lineage and is
            // therefore inside the union. A head that differs was written by
            // someone else — capture, an external editor — and nothing has
            // merged it, which is the same reasoning that replaced
            // `metadata_origin == "sync"` with the payload's head ids in the
            // resolve path.
            let head_settled_by_this_lineage: Option<String> = tx
                .query_row(
                    "SELECT last_settled_sha FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![
                        claim_key.workspace_id,
                        claim_key.version_id,
                        claim_key.object_id
                    ],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(SyncError::corrupt)?
                .flatten();
            let head_is_in_the_union = current.snapshot.as_ref().is_some_and(|snapshot| {
                head_settled_by_this_lineage.as_deref() == Some(snapshot.blob_sha256.as_str())
            });
            if !head_is_in_the_union && let Some(snapshot) = current.snapshot.as_ref() {
                let projection = project_ydoc_with_store(tx, &claim_key, &base_doc, kind)?;
                let projected_sha = dohc_engine_storage::hex_sha256(projection.content.as_bytes());
                if snapshot.blob_sha256 != projected_sha {
                    put_projection_text_blob(tx, &projection.content, &projected_sha)?;
                    let incoming_moment_id =
                        ydoc_apply_moment_id(&claim_key, &base_path, &op.origin_id, op.origin_seq);
                    let conflict_id = crate::moment_apply::sync_conflict_id(
                        &claim_key.workspace_id,
                        &claim_key.version_id,
                        &claim_key.object_id,
                        None,
                        Some((
                            Some(snapshot.latest_moment_id.as_str()),
                            Some(incoming_moment_id.as_str()),
                        )),
                    );
                    let base_side = crate::moment_apply::ConflictSide::absent(&base_path);
                    let current_side = crate::moment_apply::ConflictSide {
                        exists: true,
                        path: snapshot.path.clone(),
                        object_id: Some(snapshot.object_id.clone()),
                        kind: Some(crate::moment_apply::ContentKind::Text),
                        digest: Some(snapshot.blob_sha256.clone()),
                        updated_at_ms: Some(snapshot.updated_at_ms),
                        latest_moment_id: Some(snapshot.latest_moment_id.clone()),
                        metadata: Some(crate::moment_apply::Metadata {
                            origin: snapshot.metadata_origin.clone(),
                            summary: snapshot.metadata_summary.clone(),
                            correlation_id: snapshot.metadata_correlation_id.clone(),
                        }),
                    };
                    let incoming_side = crate::moment_apply::ConflictSide {
                        exists: true,
                        path: base_path.clone(),
                        object_id: Some(claim_key.object_id.clone()),
                        kind: Some(crate::moment_apply::ContentKind::Text),
                        digest: Some(projected_sha),
                        updated_at_ms: Some(op.recorded_at_ms),
                        latest_moment_id: Some(incoming_moment_id.clone()),
                        metadata: Some(crate::moment_apply::Metadata {
                            origin: "sync".to_owned(),
                            summary: None,
                            correlation_id: None,
                        }),
                    };
                    let conflicts_opened = crate::moment_apply::open_or_coalesce(
                        tx,
                        &claim_key.workspace_id,
                        crate::moment_apply::OpenConflict {
                            version_id: &claim_key.version_id,
                            anchor: crate::moment_apply::CoalesceAnchor::SameObject {
                                diverging_object_id: &claim_key.object_id,
                                incoming_branch_base: None,
                            },
                            conflict_id: &conflict_id,
                            path: &snapshot.path,
                            base: &base_side,
                            current: &current_side,
                            incoming: &incoming_side,
                            recorded_at_ms: op.recorded_at_ms,
                        },
                    )?;
                    // Immutable per-envelope record of what THIS coordinate
                    // opened: a later delta coalesces the conflict and
                    // rewrites its incoming anchor, so a crash-redelivery
                    // recount must not depend on the mutable conflict row.
                    record_ydoc_conflicts_opened(tx, op, conflicts_opened)?;
                    return Ok(YdocApplyResult {
                        deferred: false,
                        reason: Some("ydoc-base-conflict"),
                        conflicts_opened,
                    });
                }
            }
            // A fresh base-only replica gets its FILE, not just CRDT rows.
            project_and_write_in_tx(
                tx,
                &claim_key,
                &base_path,
                &base_doc,
                kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            )?;
            Ok(YdocApplyResult {
                deferred: false,
                reason: None,
                conflicts_opened: 0,
            })
        });
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(SyncError::InvalidInput { reason }) => {
                return refuse_ydoc(store, envelope, faults, reason);
            }
            Err(SyncError::ProjectionTooLarge {
                constraint,
                actual_bytes,
                limit_bytes,
            }) => {
                return refuse_ydoc_with_reason(
                    store,
                    envelope,
                    faults,
                    projection_too_large_reason(kind, constraint, actual_bytes, limit_bytes),
                );
            }
            Err(hard) => return Err(hard),
        };
        if matches!(outcome, ApplyOutcome::Applied(_) | ApplyOutcome::Skipped)
            && dohc_engine_collab::read_marker(store, &key)
                .map_err(map_collab_hard_error)?
                .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
        {
            let drain = drain_deferred_ydoc_for_key(store, &key, faults)?;
            return Ok(outcome
                .with_sharing_declined(drain.sharing_declined)
                .with_refusals(drain.refusals));
        }
        return Ok(outcome);
    }
    // The lease is NOT live: any coordinates parked by an earlier live
    // phase drain FIRST, so the projection below reconstructs the COMPLETE
    // applied lineage (a partial projection would materialize a file missing
    // parked content).
    let drain = if dohc_engine_collab::read_marker(store, &key)
        .map_err(map_collab_hard_error)?
        .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
    {
        drain_deferred_ydoc_for_key(store, &key, faults)?
    } else {
        YdocDrainResult::default()
    };
    // Reconstruct the post-apply doc OUTSIDE the admission tx (commutative:
    // the in-tx apply of the same bytes yields the same converged state, and
    // a dedup changes nothing).
    let projected_doc = {
        let Some(persisted) =
            dohc_engine_collab::load_persisted(store, &key).map_err(map_collab_hard_error)?
        else {
            if let Err(error) = dohc_engine_collab::Ydoc::wire().apply(&bytes) {
                return match map_collab_payload_error(
                    error,
                    "ydoc.update bytes fail durable validation",
                ) {
                    SyncError::InvalidInput { reason } => {
                        refuse_ydoc(store, envelope, faults, reason)
                    }
                    hard => Err(hard),
                };
            }
            let deferred_key = key.clone();
            return crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
                let version_exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM versions \
                         WHERE workspace_id=?1 AND version_id=?2)",
                        params![deferred_key.workspace_id, deferred_key.version_id],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                if !version_exists {
                    return Err(SyncError::RetryableState {
                        reason: "ydoc.update version is missing",
                    });
                }
                // Validate every identity fact already knowable from this
                // payload before its coordinate is ACKed and parked. For a
                // genuinely new object the eventual base path is unknown; the
                // drain repeats this gate after the base establishes it.
                validate_retryable_ydoc_identity(tx, &deferred_key, &payload.path)?;
                tx.execute(
                    "INSERT OR IGNORE INTO file_objects \
                     (workspace_id, object_id, created_at_ms) VALUES (?1, ?2, ?3)",
                    params![
                        deferred_key.workspace_id,
                        deferred_key.object_id,
                        op.recorded_at_ms
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT OR IGNORE INTO ydoc_deferred_updates \
                     (workspace_id, version_id, object_id, origin_id, origin_seq, recorded_at_ms) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        deferred_key.workspace_id,
                        deferred_key.version_id,
                        deferred_key.object_id,
                        op.origin_id,
                        op.origin_seq,
                        op.recorded_at_ms,
                    ],
                )
                .map_err(SyncError::persist)?;
                Ok(YdocApplyResult {
                    deferred: true,
                    reason: Some("ydoc-lineage-absent"),
                    conflicts_opened: 0,
                })
            });
        };
        if persisted.doc.apply(&bytes).is_err() {
            return refuse_ydoc(
                store,
                envelope,
                faults,
                "ydoc.update bytes fail durable validation",
            )
            .map(|outcome| {
                outcome
                    .with_sharing_declined(drain.sharing_declined)
                    .with_refusals(drain.refusals)
            });
        }
        persisted
    };
    let update_path = payload.path.clone();
    let update_kind = projected_doc.marker.content_kind;
    let remote = RemoteUpdate {
        origin_id: envelope.origin_id.clone(),
        origin_seq: envelope.origin_seq,
        bytes,
    };
    let mut sharing_declined = None;
    let outcome =
        crate::apply::apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
            let applied = apply_remote_update_in_transaction(tx, &key, &remote, op.recorded_at_ms)
                .map_err(|error| {
                    map_collab_payload_error(error, "ydoc.update could not be applied")
                })?;
            // An out-of-order cross-origin update parks durably with missing
            // dependencies; a projection taken NOW would omit the pending remote
            // content and materialize an incomplete view. Skip — the envelope
            // that completes the dependency projects the full doc.
            if projected_doc.doc.has_pending_dependencies() {
                return Ok(crate::apply::MutationOutcome::Applied(applied));
            }
            tx.execute_batch("SAVEPOINT dohc_ydoc_projection")
                .map_err(SyncError::persist)?;
            match project_and_write_in_tx(
                tx,
                &key,
                &update_path,
                &projected_doc.doc,
                update_kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            ) {
                Ok(()) => {
                    if let crate::BaseOrigination::Declined(declined) =
                        crate::originate_ydoc_base_in_tx(tx, &key, &update_path, op.recorded_at_ms)?
                    {
                        sharing_declined = Some(declined);
                    }
                    tx.execute_batch("RELEASE dohc_ydoc_projection")
                        .map_err(SyncError::persist)?;
                }
                Err(SyncError::InvalidInput { reason }) => {
                    tx.execute_batch(
                        "ROLLBACK TO dohc_ydoc_projection; \
                     RELEASE dohc_ydoc_projection",
                    )
                    .map_err(SyncError::persist)?;
                    return Ok(crate::apply::MutationOutcome::RefusedRetainingMutation {
                        reason: reason.to_owned(),
                    });
                }
                Err(SyncError::ProjectionTooLarge {
                    constraint,
                    actual_bytes,
                    limit_bytes,
                }) => {
                    tx.execute_batch(
                        "ROLLBACK TO dohc_ydoc_projection; \
                     RELEASE dohc_ydoc_projection",
                    )
                    .map_err(SyncError::persist)?;
                    return Ok(crate::apply::MutationOutcome::RefusedRetainingMutation {
                        reason: projection_too_large_reason(
                            update_kind,
                            constraint,
                            actual_bytes,
                            limit_bytes,
                        ),
                    });
                }
                Err(hard) => return Err(hard),
            }
            Ok(crate::apply::MutationOutcome::Applied(applied))
        })?;
    if matches!(
        outcome,
        ApplyOutcome::Applied(ReplicationApplyOutcome::Applied { .. })
    ) {
        maybe_compact(
            store,
            &key,
            DEFAULT_COMPACTION_THRESHOLD,
            faults,
            envelope.recorded_at_ms,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update compaction failed",
        })?;
    }
    Ok(map_applied_ydoc_outcome(outcome, sharing_declined)
        .with_sharing_declined(drain.sharing_declined)
        .with_refusals(drain.refusals))
}

fn map_applied_ydoc_outcome(
    outcome: ApplyOutcome<ReplicationApplyOutcome>,
    sharing_declined: Option<crate::SharingDeclined>,
) -> ApplyOutcome<YdocApplyResult> {
    match outcome {
        ApplyOutcome::Applied(_) => ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: None,
            conflicts_opened: 0,
        })
        .with_sharing_declined(sharing_declined.into_iter().collect()),
        ApplyOutcome::Refused(refusal) => ApplyOutcome::Refused(refusal),
        ApplyOutcome::Skipped => ApplyOutcome::Skipped,
        ApplyOutcome::Crashed { committed } => ApplyOutcome::Crashed { committed },
        ApplyOutcome::WithDiagnostics {
            outcome,
            refusals,
            sharing_declined: nested,
        } => ApplyOutcome::WithDiagnostics {
            outcome: Box::new(map_applied_ydoc_outcome(*outcome, sharing_declined)),
            refusals,
            sharing_declined: nested,
        },
    }
}

fn refuse_ydoc(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    reason: &'static str,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    crate::apply_envelope_with(store, envelope, faults, move |_tx, _op| {
        Err(SyncError::InvalidInput { reason })
    })
}

fn refuse_ydoc_with_reason(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    reason: String,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    crate::apply::apply_envelope_with_mutation_outcome(store, envelope, faults, move |_tx, _op| {
        Ok(crate::apply::MutationOutcome::RefusedRetainingMutation { reason })
    })
}

fn map_collab_payload_error(error: CollabError, reason: &'static str) -> SyncError {
    match error {
        CollabError::MalformedUpdate { .. }
        | CollabError::ReplayParityViolation { .. }
        | CollabError::EmptyUpdate
        | CollabError::UpdateTooLarge { .. }
        | CollabError::ProjectionTooLarge { .. }
        | CollabError::ProjectionTooComplex { .. }
        | CollabError::MarkdownRewriteUnsupported { .. } => SyncError::InvalidInput { reason },
        CollabError::BaseStateDiverged => SyncError::CoordinateDiverged,
        hard => map_collab_hard_error(hard),
    }
}

fn validate_ydoc_identity(
    conn: &rusqlite::Connection,
    key: &DocKey,
    path: &str,
) -> Result<ConflictFileState, SyncError> {
    let current = select_snapshot_by_path_in_tx(conn, &key.workspace_id, &key.version_id, path)
        .map_err(map_domain_hard_error)?;
    // Identity pins (the oracle's fix-2): NEVER write through a path occupied
    // by a different object, and never project an object into a path it does
    // not own — a hostile op would otherwise mutate the wrong plaintext file.
    if current.binary_sha256.is_some() {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update targets a binary head",
        });
    }
    if let Some(snapshot) = current.snapshot.as_ref()
        && snapshot.object_id != key.object_id
    {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update path is occupied by another object",
        });
    }
    let other_alias: Option<String> = conn
        .query_row(
            "SELECT path FROM path_aliases \
             WHERE workspace_id = ?1 AND version_id = ?2 \
               AND object_id = ?3 AND path != ?4",
            params![key.workspace_id, key.version_id, key.object_id, path],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    if other_alias.is_some() {
        return Err(SyncError::InvalidInput {
            reason: "ydoc.update object already occupies another path",
        });
    }
    Ok(current)
}

fn validate_retryable_ydoc_identity(
    conn: &rusqlite::Connection,
    key: &DocKey,
    path: &str,
) -> Result<ConflictFileState, SyncError> {
    validate_ydoc_identity(conn, key, path).map_err(|error| match error {
        SyncError::InvalidInput { reason } => SyncError::RetryableState { reason },
        hard => hard,
    })
}

fn map_collab_hard_error(error: CollabError) -> SyncError {
    match error {
        CollabError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

fn map_domain_payload_error(error: DomainError, reason: &'static str) -> SyncError {
    match error {
        // The one HARD exception living inside `InvalidInput`: an object-alias
        // collision names corrupt state, not a caller mistake, so it must be
        // checked before the variant-wide arm below would catch it.
        hard @ DomainError::InvalidInput {
            reason: "object_id is already bound to another object",
        } => map_domain_hard_error(hard),
        DomainError::PayloadTooLarge {
            constraint,
            limit_bytes,
            observed_bytes,
        } => SyncError::ProjectionTooLarge {
            constraint,
            actual_bytes: observed_bytes,
            limit_bytes,
        },
        // The acknowledged caller-mistake union (#656). A size refusal joins
        // it for the same reason `InvalidText`/`InvalidPath` are here: only
        // `InvalidInput` is ACKNOWLEDGED — the apply path answers it with
        // `RefusedRetainingMutation` and `share_disposition` skips it. A
        // measured variant would instead abort the transaction, and the
        // relay would redeliver the same coordinate forever with every later
        // operation stuck behind it.
        DomainError::InvalidText { .. }
        | DomainError::InvalidPath { .. }
        | DomainError::InvalidInput { .. } => SyncError::InvalidInput { reason },
        // Everything else is a hard failure.
        hard => map_domain_hard_error(hard),
    }
}

fn map_domain_hard_error(error: DomainError) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_limit_reason_names_each_content_kind() {
        assert_eq!(
            projection_too_large_reason(
                dohc_engine_collab::ContentKind::Plaintext,
                "MAX_PROJECTION_BYTES",
                17_000_001,
                16_777_216,
            ),
            "plaintext projection exceeds MAX_PROJECTION_BYTES: limit 16777216 bytes, observed at least 17000001 bytes"
        );
        assert_eq!(
            projection_too_large_reason(
                dohc_engine_collab::ContentKind::Richdoc,
                "MAX_PROJECTION_BYTES",
                17_000_002,
                16_777_216,
            ),
            "richdoc projection exceeds MAX_PROJECTION_BYTES: limit 16777216 bytes, observed at least 17000002 bytes"
        );
        assert_eq!(
            projection_too_large_reason(
                dohc_engine_collab::ContentKind::Scene,
                "MAX_PROJECTION_BYTES",
                17_000_003,
                16_777_216,
            ),
            "scene projection exceeds MAX_PROJECTION_BYTES: limit 16777216 bytes, observed at least 17000003 bytes"
        );
    }
}
