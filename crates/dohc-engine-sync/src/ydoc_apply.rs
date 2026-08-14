use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    CollabError, ContentKind, DocKey, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update,
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

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct YdocUpdatePayload {
    version_id: String,
    object_id: String,
    path: String,
    content_kind: String,
    update_blob_sha256: String,
    lineage_claim_id: String,
    #[serde(default)]
    is_base_state: bool,
}

fn valid_lineage_claim_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Admit a valid base only for authenticated, exact-coordinate repair.
pub(crate) fn is_exact_repairable_ydoc_base_claim(
    payload: &serde_json::Value,
    key: &DocKey,
    lineage_claim_id: &str,
) -> bool {
    let Ok(payload) = serde_json::from_value::<YdocUpdatePayload>(payload.clone()) else {
        return false;
    };
    let (classification, normalized) = classify_engine_file_path_normalized(&payload.path);
    payload.is_base_state
        && payload.version_id == key.version_id
        && payload.object_id == key.object_id
        && payload.update_blob_sha256 == lineage_claim_id
        && payload.lineage_claim_id == lineage_claim_id
        && valid_lineage_claim_id(lineage_claim_id)
        && ContentKind::parse(&payload.content_kind).is_ok()
        && classification == PathClassification::Tracked
        && normalized.as_deref() == Some(payload.path.as_str())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YdocLineageReplacement {
    pub winner_lineage_claim_id: String,
    pub recovered_paths: Vec<String>,
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
    /// Present only when this apply changed the active immutable lineage.
    pub lineage_replacement: Option<YdocLineageReplacement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct YdocDrainResult {
    pub drained: usize,
    pub refusals: Vec<crate::ReplicationRefusal>,
    pub sharing_declined: Vec<crate::SharingDeclined>,
    pub lineage_replacements: Vec<YdocLineageReplacement>,
}

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Ok(Vec::new());
    }
    let Ok(payload) = serde_json::from_value::<YdocUpdatePayload>(envelope.payload.clone()) else {
        // A malformed coordinate can only have a durable refusal, never a
        // Y.Doc projection or recovery moment. Crash-redelivery reaches this
        // helper after that refusal was ACKed, so return an empty ledger
        // instead of wedging the pull by decoding the bad payload again.
        return Ok(Vec::new());
    };
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
    let mut changes = Vec::new();
    if let Some((path, operation)) = change {
        let operation = match operation.as_str() {
            "write" => "write",
            "delete" => "delete",
            _ => {
                return Err(SyncError::InvalidInput {
                    reason: "ydoc materialization operation is invalid",
                });
            }
        };
        changes.push(crate::MomentMaterializationChange {
            version_id: payload.version_id.clone(),
            path,
            operation,
            content_kind: "text",
        });
    }
    if let Some(recovery) = crate::ydoc_recovery::redelivered_change(store, envelope)?
        && !changes.iter().any(|change| change.path == recovery.path)
    {
        changes.push(recovery);
    }
    Ok(changes)
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

#[allow(clippy::too_many_arguments)]
fn apply_deferred_base(
    store: &mut EngineStore,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    bytes: &[u8],
    origin_id: &str,
    origin_seq: i64,
    relay_seq: i64,
    recorded_at_ms: i64,
    faults: &dyn FaultInjector,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<Option<YdocLineageReplacement>, SyncError> {
    let incoming_doc = dohc_engine_collab::Ydoc::wire();
    incoming_doc
        .apply(bytes)
        .map_err(|error| map_collab_payload_error(error, "parked Y.Doc base is invalid"))?;
    let state_vector = incoming_doc.encode_state_vector();
    let key = key.clone();
    let payload = payload.clone();
    let bytes = bytes.to_vec();
    let origin_id = origin_id.to_owned();
    let outcome = store.write_with(faults, move |tx| {
        let marker_before =
            dohc_engine_collab::read_marker_in_tx(tx, &key).map_err(map_collab_hard_error)?;
        let local_unpublished = marker_before.as_ref().is_some_and(|marker| {
            marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Unclaimed
                && (marker.head_update_seq > 0 || marker.head_snapshot_seq > 0)
        });
        let has_losing_lineage = local_unpublished
            || marker_before.as_ref().is_some_and(|marker| {
                marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
                    && marker.lineage_claim_id.as_deref() != Some(payload.lineage_claim_id.as_str())
            });
        let losing_doc = if has_losing_lineage {
            Some(dohc_engine_collab::load_doc_in_tx(tx, &key).map_err(map_collab_hard_error)?)
        } else {
            None
        };
        let losing_projection = match (losing_doc.as_ref(), marker_before.as_ref()) {
            (Some(doc), Some(marker)) => {
                Some(project_ydoc_with_store(tx, &key, doc, marker.content_kind)?.content)
            }
            (None, _) => None,
            (Some(_), None) => {
                return Err(local_corruption(
                    "parked losing Y.Doc lineage has no marker",
                ));
            }
        };
        let unpublished_claim_id = if local_unpublished {
            let doc = losing_doc
                .as_ref()
                .ok_or_else(|| local_corruption("parked local Y.Doc lineage has no state"))?;
            Some(
                dohc_engine_storage::put_binary_blob(tx, &doc.encode_full_state())
                    .map_err(SyncError::Storage)?,
            )
        } else {
            None
        };
        if local_unpublished {
            tx.execute(
                "DELETE FROM ydoc_updates \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "DELETE FROM ydoc_snapshots \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(SyncError::persist)?;
            tx.execute(
                "UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0, \
                    lineage_claim_status='unclaimed',lineage_claim_id=NULL, \
                    base_origin_id=NULL,base_origin_seq=NULL,base_relay_seq=NULL, \
                    base_relay_confirmed_absent=0 \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                params![key.workspace_id, key.version_id, key.object_id],
            )
            .map_err(SyncError::persist)?;
        }
        let claim = dohc_engine_collab::claim_base_at_relay_in_tx(
            tx,
            &key,
            dohc_engine_collab::ContentKind::parse(&payload.content_kind)
                .map_err(map_collab_hard_error)?,
            &bytes,
            &state_vector,
            &dohc_engine_collab::BaseRelayCoordinate::new(origin_id.clone(), origin_seq, relay_seq)
                .map_err(map_collab_hard_error)?,
            recorded_at_ms,
        )
        .map_err(|error| {
            map_collab_payload_error(error, "parked Y.Doc base could not be claimed")
        })?;
        let (winner, losing_claim_id) = match claim {
            dohc_engine_collab::ClaimOutcome::AlreadyWon { winner } => {
                // A winner/fresh replica cannot recover this incoming loser:
                // it cannot know whether every dependent delta has arrived.
                // The peer whose active lineage is replaced owns the one
                // complete projection and therefore creates the sibling. The
                // only local result to surface here is a decision this same
                // coordinate committed before a crash left its queue row.
                let recorded = crate::ydoc_recovery::recorded_recovery_in_tx(
                    tx,
                    &key,
                    &payload.path,
                    &crate::ydoc_recovery::RecoveryEnvelopeBinding {
                        content_kind: &payload.content_kind,
                        update_blob_sha256: &payload.update_blob_sha256,
                        lineage_claim_id: &payload.lineage_claim_id,
                        is_base_state: payload.is_base_state,
                    },
                    &origin_id,
                    origin_seq,
                    recorded_at_ms,
                )?;
                let Some(recorded) = recorded else {
                    return Ok::<Option<YdocLineageReplacement>, SyncError>(None);
                };
                let winner_lineage_claim_id = winner.lineage_claim_id.ok_or_else(|| {
                    local_corruption("parked winning Y.Doc lineage has no claim identity")
                })?;
                return Ok(Some(YdocLineageReplacement {
                    winner_lineage_claim_id,
                    recovered_paths: vec![recorded.path],
                }));
            }
            dohc_engine_collab::ClaimOutcome::Replaced {
                losing_lineage_claim_id,
                winner,
            } => (winner, Some(losing_lineage_claim_id)),
            dohc_engine_collab::ClaimOutcome::Claimed { .. }
            | dohc_engine_collab::ClaimOutcome::Resumed => {
                let winner = dohc_engine_collab::read_marker_in_tx(tx, &key)
                    .map_err(map_collab_hard_error)?
                    .ok_or_else(|| local_corruption("parked winning Y.Doc has no marker"))?;
                (winner, unpublished_claim_id)
            }
        };
        let winner_claim_id = winner.lineage_claim_id.clone().ok_or_else(|| {
            local_corruption("parked winning Y.Doc lineage has no claim identity")
        })?;
        let mut recovered_paths = Vec::new();
        if let (Some(losing_claim_id), Some(markdown)) =
            (losing_claim_id.as_deref(), losing_projection.as_deref())
        {
            let recovery = crate::ydoc_recovery::recover_lineage_in_tx(
                tx,
                &key,
                &payload.path,
                crate::ydoc_recovery::RecoveryEnvelopeBinding {
                    content_kind: &payload.content_kind,
                    update_blob_sha256: &payload.update_blob_sha256,
                    lineage_claim_id: &payload.lineage_claim_id,
                    is_base_state: payload.is_base_state,
                },
                losing_claim_id,
                markdown,
                &origin_id,
                origin_seq,
                recorded_at_ms,
                search_policy,
            )?;
            recovered_paths.push(recovery.path);
        }
        project_and_write_in_tx(
            tx,
            &key,
            &payload.path,
            &incoming_doc,
            winner.content_kind,
            &origin_id,
            origin_seq,
            recorded_at_ms,
            search_policy,
        )?;
        Ok(losing_claim_id.map(|_| YdocLineageReplacement {
            winner_lineage_claim_id: winner_claim_id,
            recovered_paths,
        }))
    })?;
    match outcome {
        TxnOutcome::Committed(replacement) => Ok(replacement),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
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
    drain_deferred_ydoc(store, key, DeferredDrainMode::All, faults)
}

/// Drain only deferred coordinates that belong to the lineage an open editor
/// is bound to. The first row for another claim is an arbitration boundary:
/// it and every later row remain queued until the session is removed and the
/// ordinary full drain can replace the lineage. This prevents settle/resync
/// from changing the durable generation underneath a still-live editor.
pub fn drain_deferred_ydoc_for_live_session(
    store: &mut EngineStore,
    key: &DocKey,
    expected_lineage_claim_id: Option<&str>,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
    let observed = dohc_engine_collab::read_marker(store, key)
        .map_err(map_collab_hard_error)?
        .and_then(|marker| marker.lineage_claim_id);
    if observed.as_deref() != expected_lineage_claim_id {
        return Err(SyncError::RetryableState {
            reason: "live Y.Doc session lineage changed before deferred drain",
        });
    }
    drain_deferred_ydoc(
        store,
        key,
        DeferredDrainMode::Live(expected_lineage_claim_id),
        faults,
    )
}

#[derive(Clone, Copy)]
enum DeferredDrainMode<'a> {
    All,
    Live(Option<&'a str>),
}

fn drain_deferred_ydoc(
    store: &mut EngineStore,
    key: &DocKey,
    mode: DeferredDrainMode<'_>,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
    let pending: Vec<(String, i64, i64, i64, String, YdocUpdatePayload)> =
        store.read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT log.origin_id,log.origin_seq,deferred.relay_seq,log.recorded_at_ms,
                        deferred.lineage_claim_id,log.payload_json \
                 FROM ydoc_deferred_updates AS deferred \
                 JOIN replication_log AS log \
                   ON log.workspace_id = deferred.workspace_id \
                  AND log.origin_id = deferred.origin_id \
                  AND log.origin_seq = deferred.origin_seq \
                 WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2 \
                   AND deferred.object_id = ?3 AND log.op_kind = 'ydoc.update' \
                 ORDER BY deferred.relay_seq,log.origin_id,log.origin_seq",
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
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                        ))
                    },
                )
                .map_err(SyncError::corrupt)?;
            let mut pending = Vec::new();
            for row in rows {
                let (
                    origin_id,
                    origin_seq,
                    relay_seq,
                    recorded_at_ms,
                    lineage_claim_id,
                    payload_json,
                ) = row.map_err(SyncError::corrupt)?;
                let payload = serde_json::from_str::<YdocUpdatePayload>(&payload_json)
                    .map_err(|_| local_corruption("parked ydoc.update payload is malformed"))?;
                if lineage_claim_id != payload.lineage_claim_id
                    || !valid_lineage_claim_id(&lineage_claim_id)
                {
                    return Err(local_corruption(
                        "parked ydoc.update lineage identity does not match its payload",
                    ));
                }
                pending.push((
                    origin_id,
                    origin_seq,
                    relay_seq,
                    recorded_at_ms,
                    lineage_claim_id,
                    payload,
                ));
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
    let mut lineage_replacements = Vec::new();
    let mut projection_refusal = None;
    for (origin_id, origin_seq, relay_seq, recorded_at_ms, lineage_claim_id, payload) in pending {
        if let DeferredDrainMode::Live(expected_claim_id) = mode
            && Some(lineage_claim_id.as_str()) != expected_claim_id
        {
            break;
        }
        let bytes = store
            .get_binary_blob(&payload.update_blob_sha256)?
            .ok_or(SyncError::BlobInvalid)?;
        if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        if payload.is_base_state {
            if lineage_claim_id != payload.update_blob_sha256 {
                return Err(local_corruption(
                    "parked Y.Doc base claim does not match its full-state digest",
                ));
            }
            if let Some(replacement) = apply_deferred_base(
                store,
                key,
                &payload,
                &bytes,
                &origin_id,
                origin_seq,
                relay_seq,
                recorded_at_ms,
                faults,
                search_policy.as_ref(),
            )? {
                lineage_replacements.push(replacement);
            }
            drained_coordinates.push((origin_id, origin_seq));
            continue;
        }
        let marker = dohc_engine_collab::read_marker(store, key)
            .map_err(map_collab_hard_error)?
            .ok_or(SyncError::RetryableState {
                reason: "parked Y.Doc delta is waiting for its base",
            })?;
        let winner_claim_id = marker.lineage_claim_id.ok_or(SyncError::RetryableState {
            reason: "parked Y.Doc delta is waiting for a verified base identity",
        })?;
        if lineage_claim_id != winner_claim_id {
            // A losing lineage's causal bytes must never enter the winner.
            drained_coordinates.push((origin_id, origin_seq));
            continue;
        }
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
            Err(SyncError::InvalidInput { .. }) => {}
            // A measured size rejection is also terminal, but unlike an
            // identity pin it must stay visible to the peer. Persist it against
            // the last coordinate whose accepted bytes made this projection
            // too large before the queue cleanup below consumes the marker.
            Err(SyncError::ProjectionTooLarge {
                constraint,
                actual_bytes,
                limit_bytes,
            }) => {
                projection_refusal = Some(deferred_ydoc_refusal(
                    key,
                    drain_origin,
                    drain_seq,
                    projection_too_large_reason(
                        persisted.marker.content_kind,
                        constraint,
                        actual_bytes,
                        limit_bytes,
                    ),
                ));
            }
            // Anything else (storage) is retryable: keep the markers so the
            // next drain retries the projection.
            Err(other) => return Err(other),
        }
    }
    // The durable markers clear LAST — after the projection committed or a
    // terminal disposition was persisted. A crash anywhere above leaves the
    // rows in place, and the retry re-runs apply (content-deduped) AND the
    // projection; deleting first opened a window where the CRDT held the edit
    // but nothing would ever project it.
    let cleared = store.write_with(faults, |tx| {
        if let Some(refusal) = projection_refusal.as_ref() {
            crate::apply::persist_refusal(tx, refusal)?;
        }
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
    if let Some(refusal) = projection_refusal {
        refusals.push(refusal);
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
        lineage_replacements,
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
    reason: impl Into<String>,
    faults: &dyn FaultInjector,
) -> Result<crate::ReplicationRefusal, SyncError> {
    let refusal = deferred_ydoc_refusal(key, origin_id, origin_seq, reason);
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

fn deferred_ydoc_refusal(
    key: &DocKey,
    origin_id: &str,
    origin_seq: i64,
    reason: impl Into<String>,
) -> crate::ReplicationRefusal {
    crate::ReplicationRefusal {
        workspace_id: key.workspace_id.clone(),
        origin_id: origin_id.to_owned(),
        origin_seq,
        op_kind: "ydoc.update".to_owned(),
        reason: crate::RefusalReason::InvalidInput {
            reason: reason.into(),
        },
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

pub(crate) fn ydoc_lineage_blocks_absent_delete_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<bool, SyncError> {
    let has_durable_state: bool = tx
        .query_row(
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
        .map_err(SyncError::corrupt)?;
    if !has_durable_state {
        return Ok(false);
    }

    // A deleted scene keeps its complete lineage for rollback and asset
    // authority. An authority tied to a non-record-only delete is durable
    // proof of retained deleted state, not an unmaterialized local draft.
    let retained_scene: bool = tx
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM ydoc_docs d
                 JOIN scene_asset_delete_authorities a
                   ON a.workspace_id=d.workspace_id
                  AND a.version_id=d.version_id
                  AND a.drawing_object_id=d.object_id
                 JOIN moments m
                   ON m.workspace_id=a.workspace_id
                  AND m.version_id=a.version_id
                  AND m.object_id=a.drawing_object_id
                  AND m.moment_id=a.drawing_delete_moment_id
                WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3
                  AND d.content_kind='scene'
                  AND m.operation='delete'
                  AND COALESCE(m.sync_record_only,0)=0
                  AND NOT EXISTS(
                      SELECT 1 FROM moments later
                       WHERE later.workspace_id=m.workspace_id
                         AND later.version_id=m.version_id
                         AND later.object_id=m.object_id
                         AND later.moment_order > m.moment_order
                         AND COALESCE(later.sync_record_only,0)=0
                  )
             )",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    Ok(!retained_scene)
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
        if marker.content_kind == ContentKind::Scene {
            // A scene has no Markdown fold, and refusing here would roll
            // back the text write that carries an external edit to a closed
            // drawing — the edit would vanish from history and a later
            // materialization could overwrite the file with the older
            // scene. The durable file head is canonical: retire the lineage
            // and let the next open seed a fresh scene from the artifact,
            // exactly like a first open.
            return retire_complete_ydoc_lineage_in_tx(tx, complete);
        }
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
        let refolded = project_ydoc_with_store(tx, key, doc, marker.content_kind)?;
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
            let lineage_claim_id = marker
                .lineage_claim_id
                .as_deref()
                .ok_or_else(|| local_corruption("exact Y.Doc lineage has no claim id"))?;
            crate::journal::journal_local_op_in_tx(
                tx,
                &key.workspace_id,
                "ydoc.update",
                &crate::ydoc_update_payload(
                    key,
                    path,
                    marker.content_kind,
                    &dohc_engine_storage::hex_sha256(&update),
                    lineage_claim_id,
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

struct AuthorizedSceneAsset {
    bytes: Vec<u8>,
    byte_length: usize,
}

fn authorize_scene_asset_with_store(
    conn: &Connection,
    key: &DocKey,
    asset: &dohc_engine_collab::SceneAsset,
) -> Result<AuthorizedSceneAsset, SyncError> {
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
    let byte_length = match head {
        Some((kind, sha256, byte_length)) => {
            if kind != "binary" || sha256.as_deref() != Some(asset.sha256.as_str()) {
                return Err(SyncError::InvalidInput {
                    reason: "scene asset authority is invalid",
                });
            }
            byte_length.ok_or(SyncError::RetryableState {
                reason: "scene asset blob is pending",
            })?
        }
        None => retired_scene_asset_byte_length(conn, key, &asset.path, &asset.sha256)?.ok_or(
            SyncError::RetryableState {
                reason: "scene asset head is pending",
            },
        )?,
    }
    .try_into()
    .map_err(|_| SyncError::InvalidInput {
        reason: "scene asset authority is invalid",
    })?;
    let bytes = get_binary_blob(conn, &asset.sha256)?.ok_or(SyncError::RetryableState {
        reason: "scene asset blob is pending",
    })?;
    if hex_sha256(&bytes) != asset.sha256 {
        return Err(SyncError::InvalidInput {
            reason: "scene asset authority is invalid",
        });
    }
    Ok(AuthorizedSceneAsset { bytes, byte_length })
}

/// Verify that a scene asset belongs to this lineage and has its exact blob.
pub fn validate_scene_asset_with_store(
    conn: &Connection,
    key: &DocKey,
    asset: &dohc_engine_collab::SceneAsset,
) -> Result<(), SyncError> {
    authorize_scene_asset_with_store(conn, key, asset).map(|_| ())
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
        return doc
            .project(content_kind)
            .map_err(|error| map_projection_error(error, "ydoc projection is invalid"));
    }
    let folded = doc.fold_scene();
    // The unhydrated portable form bounds the scene-owned JSON before any
    // binary reads. Track a lower bound for the final data URLs as each asset
    // is resolved so repeated files cannot accumulate unbounded raw blobs only
    // to be refused by the serializer afterward.
    let mut projected_bytes = folded
        .portable_json()
        .map_err(|error| map_projection_error(error, "scene projection is invalid"))?
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
        let authorized = authorize_scene_asset_with_store(conn, key, asset)?;
        let data_url_len =
            dohc_engine_collab::scene_data_url_len(&asset.mime_type, authorized.byte_length)
                .map_err(|error| map_projection_error(error, "scene projection is invalid"))?;
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
        bytes_by_id.insert(id.to_owned(), authorized.bytes);
    }
    let content = folded
        .portable_json_with_asset_bytes(&bytes_by_id)
        .map_err(|error| map_projection_error(error, "scene projection is invalid"))?;
    Ok(dohc_engine_collab::Projection {
        content,
        content_kind,
        source_state_vector_sha256: hex_sha256(&doc.encode_state_vector()),
        destructive: false,
    })
}

/// Resolve a scene asset whose generated sidecar head was retired after the
/// file disappeared from disk. The current delete and its exact producer are
/// the authority; a blob referenced elsewhere in the workspace is not.
fn retired_scene_asset_byte_length(
    conn: &Connection,
    key: &DocKey,
    path: &str,
    sha256: &str,
) -> Result<Option<i64>, SyncError> {
    conn.query_row(
        "SELECT b.byte_length FROM moments deleted \
         JOIN moments producer ON producer.workspace_id=deleted.workspace_id \
           AND producer.moment_id=deleted.before_latest_moment_id \
         JOIN binary_blobs b ON b.sha256=deleted.before_binary_sha256 \
         WHERE deleted.workspace_id=?1 AND deleted.version_id=?2 AND deleted.path=?3 \
           AND deleted.operation='delete' AND COALESCE(deleted.sync_record_only,0)=0 \
           AND deleted.before_present=2 AND deleted.before_content_kind='binary' \
           AND deleted.before_binary_sha256=?4 AND deleted.payload_before_path=?3 \
           AND deleted.payload_before_content_kind='binary' \
           AND deleted.payload_before_blob_sha256=?4 \
           AND producer.version_id=deleted.version_id \
           AND producer.object_id=deleted.object_id \
           AND producer.operation='write' AND COALESCE(producer.sync_record_only,0)=0 \
           AND producer.after_content_kind='binary' \
           AND producer.after_binary_sha256=?4 AND producer.path=?3 \
           AND producer.payload_after_path=?3 \
           AND producer.payload_after_content_kind='binary' \
           AND producer.payload_after_blob_sha256=?4 \
           AND NOT EXISTS (SELECT 1 FROM moments newer \
             WHERE newer.workspace_id=deleted.workspace_id \
               AND newer.version_id=deleted.version_id AND newer.path=deleted.path \
               AND COALESCE(newer.sync_record_only,0)=0 \
               AND newer.moment_order>deleted.moment_order) \
         ORDER BY deleted.moment_order DESC LIMIT 1",
        params![key.workspace_id, key.version_id, path, sha256],
        |row| row.get(0),
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn map_projection_error(
    error: dohc_engine_collab::CollabError,
    invalid_reason: &'static str,
) -> SyncError {
    match error {
        dohc_engine_collab::CollabError::ProjectionTooLarge { actual, max } => {
            SyncError::ProjectionTooLarge {
                constraint: "MAX_PROJECTION_BYTES",
                actual_bytes: actual,
                limit_bytes: max,
            }
        }
        _ => SyncError::InvalidInput {
            reason: invalid_reason,
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
    if !valid_lineage_claim_id(&payload.lineage_claim_id)
        || (payload.is_base_state && payload.lineage_claim_id != payload.update_blob_sha256)
    {
        return refuse_ydoc(
            store,
            envelope,
            faults,
            "ydoc.update lineage claim is invalid",
        );
    }
    let search_policy = search_policy_for_store(store);
    // Gate on the SAME floor the projection sink applies
    // (`validate_plaintext_storable_path`) rather than R10's narrow
    // share-boundary classifier, which misses reserved 8.3 aliases (`dohc~1`
    // aliases `.dohc`) and dots-and-spaces segments. The path is persisted as a
    // durable alias key, so it must already be canonical.
    let (classification, normalized) = classify_engine_file_path_normalized(&payload.path);
    if classification != PathClassification::Tracked
        || normalized.as_deref() != Some(payload.path.as_str())
        || ContentKind::parse(&payload.content_kind).is_err()
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
    if !payload.is_base_state
        && let Err(error) = dohc_engine_collab::Ydoc::validate_update(&bytes)
    {
        return match map_collab_payload_error(error, "ydoc.update bytes fail durable validation") {
            SyncError::InvalidInput { reason } => refuse_ydoc(store, envelope, faults, reason),
            hard => Err(hard),
        };
    }
    let Some(relay_seq) = envelope.relay_seq else {
        return Err(SyncError::RetryableState {
            reason: "pulled ydoc.update is missing its relay sequence",
        });
    };
    if leases.is_live(&key) {
        // FULL durable validation BEFORE admission: byte caps, abort-safe
        // prevalidation, AND the replay-parity gate — replayed on top of the
        // ALREADY-QUEUED deferred predecessors, because a later update can
        // only become invalid after they apply, and the drain will apply
        // them first. Anything the drain would reject becomes a refusal, not a
        // deferred update.
        let queued: Vec<Vec<u8>> = {
            let mut queued = Vec::new();
            let rows: Vec<(String, String)> = store.read_with(|conn| {
                let mut stmt = conn
                    .prepare(
                        "SELECT deferred.lineage_claim_id,log.payload_json
                           FROM ydoc_deferred_updates AS deferred
                           JOIN replication_log AS log
                             ON log.workspace_id = deferred.workspace_id
                            AND log.origin_id = deferred.origin_id
                            AND log.origin_seq = deferred.origin_seq
                          WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2
                            AND deferred.object_id = ?3
                          ORDER BY deferred.relay_seq,log.origin_id,log.origin_seq",
                    )
                    .map_err(SyncError::corrupt)?;
                let mapped = stmt
                    .query_map(
                        params![key.workspace_id, key.version_id, key.object_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .map_err(SyncError::corrupt)?;
                mapped
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(SyncError::corrupt)
            })?;
            for (queued_claim_id, payload_json) in rows {
                let queued_payload = serde_json::from_str::<YdocUpdatePayload>(&payload_json)
                    .map_err(|_| local_corruption("parked ydoc.update payload is malformed"))?;
                if queued_claim_id != queued_payload.lineage_claim_id {
                    return Err(local_corruption(
                        "parked ydoc.update lineage identity does not match its payload",
                    ));
                }
                if queued_claim_id != payload.lineage_claim_id {
                    continue;
                }
                let queued_bytes = store
                    .get_binary_blob(&queued_payload.update_blob_sha256)?
                    .ok_or(SyncError::BlobInvalid)?;
                queued.push(queued_bytes);
            }
            queued
        };
        let active_claim = dohc_engine_collab::read_marker(store, &key)
            .map_err(map_collab_hard_error)?
            .and_then(|marker| marker.lineage_claim_id);
        let validation = if active_claim.as_deref() == Some(payload.lineage_claim_id.as_str()) {
            dohc_engine_collab::validate_remote_update_with_pending(store, &key, &queued, &bytes)
        } else {
            // A foreign queued lineage is validated only against its own
            // relay-ordered prefix. Replaying it on the active winner even in
            // scratch state would conflate generations and can falsely admit
            // or reject its later deltas.
            let scratch = dohc_engine_collab::Ydoc::wire();
            let mut validation = Ok(());
            for queued_bytes in &queued {
                if let Err(error) =
                    dohc_engine_collab::validate_replay_parity(&scratch, queued_bytes)
                {
                    validation = Err(error);
                    break;
                }
                if let Err(error) = scratch.apply(queued_bytes) {
                    validation = Err(error);
                    break;
                }
            }
            validation.and_then(|()| dohc_engine_collab::validate_replay_parity(&scratch, &bytes))
        };
        if let Err(error) = validation {
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
                "INSERT OR IGNORE INTO ydoc_deferred_updates
                 (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,
                  lineage_claim_id,relay_seq)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    deferred_key.workspace_id,
                    deferred_key.version_id,
                    deferred_key.object_id,
                    op.origin_id,
                    op.origin_seq,
                    op.recorded_at_ms,
                    payload.lineage_claim_id,
                    relay_seq,
                ],
            )
            .map_err(SyncError::persist)?;
            Ok(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-session-live"),
                conflicts_opened: 0,
                lineage_replacement: None,
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
        // Never union two independent lineages. The relay winner is installed
        // as its own CRDT. A losing local projection is captured below before
        // any of its rows are purged and becomes an ordinary sibling file.
        let incoming_doc = dohc_engine_collab::Ydoc::wire();
        if incoming_doc.apply(&claim_bytes).is_err() {
            return refuse_ydoc(
                store,
                envelope,
                faults,
                "ydoc.update base bytes fail validation",
            );
        }
        let base_path = payload.path.clone();
        let incoming = crate::ydoc_recovery::RecoveryEnvelopeBinding {
            content_kind: &payload.content_kind,
            update_blob_sha256: &payload.update_blob_sha256,
            lineage_claim_id: &payload.lineage_claim_id,
            is_base_state: payload.is_base_state,
        };
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
            let marker_before = dohc_engine_collab::read_marker_in_tx(tx, &claim_key)
                .map_err(map_collab_hard_error)?;
            let losing_last_settled_sha: Option<String> = tx
                .query_row(
                    "SELECT last_settled_sha FROM ydoc_docs \
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![
                        claim_key.workspace_id,
                        claim_key.version_id,
                        claim_key.object_id
                    ],
                    |row| row.get(0),
                )
                .optional()
                .map_err(SyncError::corrupt)?
                .flatten();
            let local_unpublished = marker_before.as_ref().is_some_and(|marker| {
                marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Unclaimed
                    && (marker.head_update_seq > 0 || marker.head_snapshot_seq > 0)
            });
            let losing_projection = if local_unpublished
                || marker_before.as_ref().is_some_and(|marker| {
                    marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
                        && marker.lineage_claim_id.as_deref() != Some(incoming.lineage_claim_id)
                }) {
                let doc = dohc_engine_collab::load_doc_in_tx(tx, &claim_key)
                    .map_err(map_collab_hard_error)?;
                let marker = marker_before
                    .as_ref()
                    .ok_or_else(|| local_corruption("Y.Doc losing lineage has no marker"))?;
                Some(project_ydoc_with_store(tx, &claim_key, &doc, marker.content_kind)?.content)
            } else {
                None
            };
            let unpublished_claim_id = if local_unpublished {
                let doc = dohc_engine_collab::load_doc_in_tx(tx, &claim_key)
                    .map_err(map_collab_hard_error)?;
                Some(
                    dohc_engine_storage::put_binary_blob(tx, &doc.encode_full_state())
                        .map_err(SyncError::Storage)?,
                )
            } else {
                None
            };
            // A local-only cache has no relay identity and cannot participate
            // in arbitration. Preserve its projection above, then clear its
            // rows so the winning base starts a clean causal lineage.
            if local_unpublished {
                tx.execute(
                    "DELETE FROM ydoc_updates
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![
                        claim_key.workspace_id,
                        claim_key.version_id,
                        claim_key.object_id
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM ydoc_snapshots
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![
                        claim_key.workspace_id,
                        claim_key.version_id,
                        claim_key.object_id
                    ],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0,
                        lineage_claim_status='unclaimed',lineage_claim_id=NULL,
                        base_origin_id=NULL,base_origin_seq=NULL,base_relay_seq=NULL,
                        base_relay_confirmed_absent=0
                     WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
                    params![
                        claim_key.workspace_id,
                        claim_key.version_id,
                        claim_key.object_id
                    ],
                )
                .map_err(SyncError::persist)?;
            }
            let claim = dohc_engine_collab::claim_base_at_relay_in_tx(
                tx,
                &claim_key,
                kind,
                &claim_bytes,
                &sv_bytes,
                &dohc_engine_collab::BaseRelayCoordinate::new(
                    op.origin_id.clone(),
                    op.origin_seq,
                    relay_seq,
                )
                .map_err(map_collab_hard_error)?,
                op.recorded_at_ms,
            )
            .map_err(|error| {
                map_collab_payload_error(error, "ydoc.update base could not be claimed")
            })?;
            let (winner, losing_claim_id, replaced) = match claim {
                dohc_engine_collab::ClaimOutcome::AlreadyWon { winner } => {
                    // Loser-only recovery is intentional. This replica has no
                    // completeness boundary for the incoming lineage's later
                    // deltas, so synthesizing a sibling here could preserve a
                    // truncated draft. ACK this base; its deltas are routed by
                    // claim and dropped without entering the winner. The peer
                    // whose active lineage is replaced has the complete local
                    // projection and creates the ordinary recovery sibling.
                    let _ = winner;
                    return Ok(YdocApplyResult {
                        deferred: false,
                        reason: Some("ydoc-base-already-won"),
                        conflicts_opened: 0,
                        lineage_replacement: None,
                    });
                }
                dohc_engine_collab::ClaimOutcome::Replaced {
                    losing_lineage_claim_id,
                    winner,
                } => (winner, Some(losing_lineage_claim_id), true),
                dohc_engine_collab::ClaimOutcome::Claimed { .. }
                | dohc_engine_collab::ClaimOutcome::Resumed => {
                    let winner = dohc_engine_collab::read_marker_in_tx(tx, &claim_key)
                        .map_err(map_collab_hard_error)?
                        .ok_or_else(|| local_corruption("claimed Y.Doc lineage has no marker"))?;
                    (winner, unpublished_claim_id, local_unpublished)
                }
            };
            let winner_lineage_claim_id = winner
                .lineage_claim_id
                .clone()
                .ok_or_else(|| local_corruption("winning Y.Doc lineage has no claim identity"))?;
            let mut recovered_paths = Vec::new();
            if let (Some(losing_claim_id), Some(markdown)) =
                (losing_claim_id.as_deref(), losing_projection.as_deref())
            {
                let recovery = crate::ydoc_recovery::recover_lineage_in_tx(
                    tx,
                    &claim_key,
                    &base_path,
                    incoming.clone(),
                    losing_claim_id,
                    markdown,
                    &op.origin_id,
                    op.origin_seq,
                    op.recorded_at_ms,
                    search_policy.as_ref(),
                )?;
                recovered_paths.push(recovery.path);
            }
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
                    || losing_last_settled_sha.as_deref() == Some(snapshot.blob_sha256.as_str())
            });
            let head_was_recovered = current.snapshot.as_ref().is_some_and(|snapshot| {
                losing_projection.as_ref().is_some_and(|markdown| {
                    dohc_engine_storage::hex_sha256(markdown.as_bytes()) == snapshot.blob_sha256
                })
            });
            if !head_was_recovered
                && !head_is_in_the_union
                && let Some(snapshot) = current.snapshot.as_ref()
            {
                let projection = project_ydoc_with_store(tx, &claim_key, &incoming_doc, kind)?;
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
                        lineage_replacement: replaced.then_some(YdocLineageReplacement {
                            winner_lineage_claim_id,
                            recovered_paths,
                        }),
                    });
                }
            }
            // A fresh base-only replica gets its FILE, not just CRDT rows.
            project_and_write_in_tx(
                tx,
                &claim_key,
                &base_path,
                &incoming_doc,
                winner.content_kind,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            )?;
            Ok(YdocApplyResult {
                deferred: false,
                reason: None,
                conflicts_opened: 0,
                lineage_replacement: replaced.then_some(YdocLineageReplacement {
                    winner_lineage_claim_id,
                    recovered_paths,
                }),
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
            return Ok(
                merge_lineage_replacements(outcome, drain.lineage_replacements)
                    .with_sharing_declined(drain.sharing_declined)
                    .with_refusals(drain.refusals),
            );
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
                    "INSERT OR IGNORE INTO ydoc_deferred_updates
                     (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,
                      lineage_claim_id,relay_seq)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        deferred_key.workspace_id,
                        deferred_key.version_id,
                        deferred_key.object_id,
                        op.origin_id,
                        op.origin_seq,
                        op.recorded_at_ms,
                        payload.lineage_claim_id,
                        relay_seq,
                    ],
                )
                .map_err(SyncError::persist)?;
                Ok(YdocApplyResult {
                    deferred: true,
                    reason: Some("ydoc-lineage-absent"),
                    conflicts_opened: 0,
                    lineage_replacement: None,
                })
            });
        };
        if persisted.marker.lineage_claim_status != dohc_engine_collab::LineageClaimStatus::Exact {
            return Err(SyncError::RetryableState {
                reason: "ydoc.update delta is waiting for a verified base identity",
            });
        }
        if persisted.marker.lineage_claim_id.as_deref() != Some(payload.lineage_claim_id.as_str()) {
            // The relay winner is already known. This coordinate still gets
            // its normal durable ack/log record, but its causal bytes must not
            // enter a different immutable lineage.
            let outcome = crate::apply_envelope_with(store, envelope, faults, |_tx, _op| {
                Ok(YdocApplyResult {
                    deferred: false,
                    reason: Some("ydoc-lineage-lost"),
                    conflicts_opened: 0,
                    lineage_replacement: None,
                })
            })?;
            return Ok(
                merge_lineage_replacements(outcome, drain.lineage_replacements)
                    .with_sharing_declined(drain.sharing_declined)
                    .with_refusals(drain.refusals),
            );
        }
        if persisted.doc.apply(&bytes).is_err() {
            return refuse_ydoc(
                store,
                envelope,
                faults,
                "ydoc.update bytes fail durable validation",
            )
            .map(|outcome| {
                merge_lineage_replacements(outcome, drain.lineage_replacements)
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
    Ok(merge_lineage_replacements(
        map_applied_ydoc_outcome(outcome, sharing_declined),
        drain.lineage_replacements,
    )
    .with_sharing_declined(drain.sharing_declined)
    .with_refusals(drain.refusals))
}

fn collapse_lineage_replacements(
    replacements: Vec<YdocLineageReplacement>,
) -> Option<YdocLineageReplacement> {
    let mut collapsed: Option<YdocLineageReplacement> = None;
    for replacement in replacements {
        match collapsed.as_mut() {
            Some(current) => {
                current.winner_lineage_claim_id = replacement.winner_lineage_claim_id;
                current.recovered_paths.extend(replacement.recovered_paths);
            }
            None => collapsed = Some(replacement),
        }
    }
    collapsed
}

fn merge_lineage_replacements(
    outcome: ApplyOutcome<YdocApplyResult>,
    replacements: Vec<YdocLineageReplacement>,
) -> ApplyOutcome<YdocApplyResult> {
    let Some(replacement) = collapse_lineage_replacements(replacements) else {
        return outcome;
    };
    match outcome {
        ApplyOutcome::Applied(mut result) => {
            result.lineage_replacement = collapse_lineage_replacements(
                result
                    .lineage_replacement
                    .into_iter()
                    .chain([replacement])
                    .collect(),
            );
            ApplyOutcome::Applied(result)
        }
        ApplyOutcome::Skipped => ApplyOutcome::Applied(YdocApplyResult {
            deferred: false,
            reason: Some("ydoc-deferred-lineage-replaced"),
            conflicts_opened: 0,
            lineage_replacement: Some(replacement),
        }),
        ApplyOutcome::WithDiagnostics {
            outcome,
            refusals,
            sharing_declined,
        } => ApplyOutcome::WithDiagnostics {
            outcome: Box::new(merge_lineage_replacements(*outcome, vec![replacement])),
            refusals,
            sharing_declined,
        },
        hard @ (ApplyOutcome::Refused(_) | ApplyOutcome::Crashed { .. }) => hard,
    }
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
            lineage_replacement: None,
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
        CollabError::BaseRelaySequencePending => SyncError::RetryableState {
            reason: "Y.Doc base is waiting for its authenticated relay position",
        },
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
