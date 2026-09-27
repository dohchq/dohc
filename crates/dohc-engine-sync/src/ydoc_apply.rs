use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::{
    CollabError, CompactOutcome, ContentKind, DocKey, RemoteAppendProbe, RemoteUpdate,
    ReplicationApplyOutcome, WriterDocCache, apply_remote_update,
    apply_remote_update_in_transaction_with_projection, maybe_compact,
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
use crate::{ApplyDisposition, ApplyOutcome, ReplicationEnvelope, SyncError};

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
    actor_origin_id: Option<String>,
    #[serde(default)]
    attribution: Option<dohc_engine_domain::ChangeAttribution>,
    #[serde(default)]
    is_base_state: bool,
}

pub(crate) const LIVE_UNADMITTED_UPDATE: &str = "ordinary update has no native live admission";

// Historical audit imports never populate either native binding table.
fn live_ordinary_classification(
    conn: &Connection,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    update: &[u8],
) -> Result<Option<bool>, SyncError> {
    let bound: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)
         OR EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3)",
        params![key.workspace_id,key.version_id,key.object_id], |row| row.get(0),
    ).map_err(SyncError::corrupt)?;
    if !bound {
        return Ok(None);
    }
    if payload.content_kind != "richdoc" {
        return Ok(Some(false));
    }
    if let Some(contained) =
        dohc_engine_collab::owner_outbox::publication::contains_observed_update_in(
            conn,
            key,
            &payload.path,
            &payload.lineage_claim_id,
            update,
        )
        .unwrap_or(Some(false))
    {
        return Ok(Some(contained));
    }
    let applied: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM live_device_application_bindings b
           WHERE b.workspace_id=?1 AND b.main_version_id=?2 AND b.object_id=?3
             AND b.lineage_claim_id=?4 AND b.current_path=?5 AND (
               EXISTS(SELECT 1 FROM live_device_update_applications a
                 WHERE a.relay_database_namespace=b.relay_database_namespace AND a.workspace_id=b.workspace_id
                   AND a.main_version_id=b.main_version_id AND a.object_id=b.object_id
                   AND a.lineage_claim_id=?4 AND a.update_digest=?6 AND a.current_path=?5)
               OR EXISTS(SELECT 1 FROM live_device_bootstraps a
                 WHERE a.relay_database_namespace=b.relay_database_namespace AND a.workspace_id=b.workspace_id
                   AND a.main_version_id=b.main_version_id AND a.object_id=b.object_id
                   AND a.lineage_claim_id=?4 AND a.baseline_digest=?6)))
",
        params![key.workspace_id,key.version_id,key.object_id,payload.lineage_claim_id,payload.path,payload.update_blob_sha256],
        |row| row.get(0),
    ).map_err(SyncError::corrupt)?;
    Ok(Some(applied))
}

pub(crate) fn retain_refused_ydoc_blob(
    tx: &rusqlite::Transaction<'_>,
    workspace: &str,
    origin: &str,
    sequence: i64,
) -> Result<(), SyncError> {
    let changed = tx.execute(
        "INSERT OR IGNORE INTO replication_refused_ydoc_blobs
         SELECT workspace_id,origin_id,origin_seq,json_extract(payload_json,'$.updateBlobSha256')
         FROM replication_log WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3 AND op_kind='ydoc.update'",
        params![workspace,origin,sequence],
    ).map_err(SyncError::persist)?;
    if changed == 0 {
        let retained: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM replication_refused_ydoc_blobs WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3)",
            params![workspace,origin,sequence],|row|row.get(0),
        ).map_err(SyncError::corrupt)?;
        if !retained {
            return Err(local_corruption("refused live update coordinate is absent"));
        }
    }
    Ok(())
}

fn valid_lineage_claim_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_actor_origin_id(value: Option<&str>) -> bool {
    match value {
        Some(value) => {
            !value.is_empty() && value.len() <= dohc_engine_storage::MAX_IDENTIFIER_BYTES
        }
        None => true,
    }
}

fn valid_attribution(value: Option<&dohc_engine_domain::ChangeAttribution>) -> bool {
    value.is_none_or(|attribution| attribution.validate().is_ok())
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
        && valid_actor_origin_id(payload.actor_origin_id.as_deref())
        && valid_attribution(payload.attribution.as_ref())
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

/// Probe that reports every document live, so a pull defers instead of
/// applying. Tests use it to reach the deferred-drain path directly.
#[derive(Debug, Default, Clone, Copy)]
pub struct AlwaysLive;

impl LeaseProbe for AlwaysLive {
    fn is_live(&self, _key: &DocKey) -> bool {
        true
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
    /// What this apply did to bound collection records, in commit order: the
    /// envelope's own facts, then any parked updates it let drain. The source
    /// of the record events the pull pass reports for post-commit emission.
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct YdocDrainResult {
    pub drained: usize,
    pub conflicts_opened: i64,
    pub refusals: Vec<crate::ReplicationRefusal>,
    pub sharing_declined: Vec<crate::SharingDeclined>,
    pub lineage_replacements: Vec<YdocLineageReplacement>,
    /// Record facts every drained update committed, in drain order: a parked
    /// update fires the same events an ordinary pull does, post-commit.
    pub record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
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
            "SELECT target_path, operation FROM materialization_jobs WHERE job_id IN (?1,?2) ORDER BY job_id LIMIT 1",
            params![job_id, format!("{job_id}-local")],
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
    // Never reparse the payload here. A malformed `ydoc.update` is refused
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
    ydoc_conflict_coordinate_id(
        &envelope.workspace_id,
        &envelope.origin_id,
        envelope.origin_seq,
    )
}

fn ydoc_conflict_coordinate_id(workspace_id: &str, origin_id: &str, origin_seq: i64) -> String {
    let coordinate = format!("{workspace_id}\0{origin_id}\0{origin_seq}");
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
    record_ydoc_conflict_count(
        tx,
        &envelope.workspace_id,
        &envelope.origin_id,
        envelope.origin_seq,
        envelope.recorded_at_ms,
        conflicts_opened,
    )
}

fn record_ydoc_conflict_count(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    recorded_at_ms: i64,
    conflicts_opened: i64,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO engine_requests \
         (request_id,payload_hash,result_seq,committed_at,kind) \
         VALUES (?1,?2,?3,?4,'sync-ydoc-conflict')",
        params![
            ydoc_conflict_coordinate_id(workspace_id, origin_id, origin_seq),
            conflicts_opened.to_string(),
            origin_seq,
            recorded_at_ms,
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
        let already_preserved: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1 AND kind='sync-ydoc-conflict')",
            [ydoc_conflict_coordinate_id(&key.workspace_id, &origin_id, origin_seq)],
            |row| row.get(0),
        ).map_err(SyncError::corrupt)?;
        if already_preserved {
            return Ok(None);
        }
        let marker_before =
            dohc_engine_collab::read_marker_in(tx, &key).map_err(map_collab_hard_error)?;
        let last_settled_sha: Option<String> = tx.query_row(
            "SELECT COALESCE(last_settled_sha,seed_source_sha256) FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
        ).optional().map_err(SyncError::corrupt)?.flatten();
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
            Some(dohc_engine_collab::load_doc_in(tx, &key).map_err(map_collab_hard_error)?)
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
        if let Some(result) = preserve_incomplete_base_in_tx(
            tx, &key, &payload, &incoming_doc, relay_seq, &origin_id, origin_seq,
            recorded_at_ms, search_policy,
        )? {
            record_ydoc_conflict_count(tx, &key.workspace_id, &origin_id, origin_seq, recorded_at_ms, result.conflicts_opened)?;
            dohc_engine_storage::count_remote_change_in_tx(tx, &key.workspace_id).map_err(SyncError::Storage)?;
            return Ok(result.lineage_replacement);
        }
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
            // `seed_source_sha256` clears with the rows it described: the
            // winning base holds content the file does not, and the seed-only
            // settle skip must never survive a lineage replacement on
            // the base claim's snapshot insert alone.
            tx.execute(
                "UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0, \
                    settled_update_seq=NULL,seed_source_sha256=NULL, \
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
        // A base this drain installs is a document from elsewhere. A resumed
        // claim was installed by an earlier attempt, and one another base
        // already won installs nothing.
        if matches!(
            claim,
            dohc_engine_collab::ClaimOutcome::Claimed { .. }
                | dohc_engine_collab::ClaimOutcome::Replaced { .. }
        ) {
            dohc_engine_storage::count_remote_change_in_tx(tx, &key.workspace_id)
                .map_err(SyncError::Storage)?;
        }
        let (winner, losing_claim_id) = match claim {
            dohc_engine_collab::ClaimOutcome::AlreadyWon { winner } => {
                // The replaced peer owns the complete losing projection and
                // opens its conflict. This receiver cannot know whether every
                // dependent delta has arrived. The
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
            // The lineage already holds this base, so its state and projection
            // are unchanged; the claim only recorded the base's relay position.
            dohc_engine_collab::ClaimOutcome::Resumed => {
                clear_base_relay_candidates_in_tx(tx, &key)?;
                return Ok(None);
            }
            dohc_engine_collab::ClaimOutcome::Claimed { .. } => {
                let winner = dohc_engine_collab::read_marker_in(tx, &key)
                    .map_err(map_collab_hard_error)?
                    .ok_or_else(|| local_corruption("parked winning Y.Doc has no marker"))?;
                (winner, unpublished_claim_id)
            }
        };
        let winner_claim_id = winner.lineage_claim_id.clone().ok_or_else(|| {
            local_corruption("parked winning Y.Doc lineage has no claim identity")
        })?;
        let projection = project_ydoc_with_store(tx, &key, &incoming_doc, winner.content_kind)?;
        let (conflict, recovered_paths) = preserve_base_sides_in_tx(
            tx, &key, &payload.path,
            crate::ydoc_recovery::RecoveryEnvelopeBinding {
                content_kind: &payload.content_kind,
                update_blob_sha256: &payload.update_blob_sha256,
                lineage_claim_id: &payload.lineage_claim_id,
                is_base_state: payload.is_base_state,
            },
            losing_claim_id.as_deref(), losing_projection.as_deref(), last_settled_sha.as_deref(),
            &projection.content, &origin_id, origin_seq, recorded_at_ms, search_policy,
        )?;
        if let Some(opened) = conflict {
            record_ydoc_conflict_count(tx, &key.workspace_id, &origin_id, origin_seq, recorded_at_ms, opened)?;
            return Ok(Some(YdocLineageReplacement {
                winner_lineage_claim_id: winner_claim_id,
                recovered_paths,
            }));
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
    cache: &mut WriterDocCache,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
    let (drained, cleanup) =
        drain_deferred_ydoc(store, cache, key, DeferredDrainMode::All, faults)?;
    complete_drain(store, drained, cleanup, faults)
}

fn drain_deferred_ydoc_in_batch(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    faults: &dyn FaultInjector,
    batch_inactive: bool,
) -> Result<YdocDrainResult, SyncError> {
    let mode = if batch_inactive {
        DeferredDrainMode::Batch
    } else {
        DeferredDrainMode::All
    };
    let (drained, cleanup) = drain_deferred_ydoc(store, cache, key, mode, faults)?;
    complete_drain(store, drained, cleanup, faults)
}

fn inactive_lineage_exists(
    conn: &Connection,
    key: &DocKey,
    claim: &str,
) -> Result<bool, SyncError> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM ydoc_inactive_lineages WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
        params![key.workspace_id,key.version_id,key.object_id,claim], |row| row.get(0)).map_err(SyncError::corrupt)
}

/// [`drain_deferred_ydoc_for_key`], holding the final queue-row cleanup for
/// the caller. The drained coordinates — and the record facts persisted on
/// them — stay queued until the caller runs the returned [`YdocDrainCleanup`]
/// through [`complete_deferred_ydoc_drain_cleanup`]. A caller that fails
/// between the drain and the cleanup leaves the rows in place, exactly like a
/// crash before the cleanup transaction: the retry re-drains content-deduped
/// and reads the facts back.
///
/// The pending projection refusal, if any, travels in the cleanup rather
/// than in the result's `refusals`: it is persisted when the cleanup runs,
/// so a caller reading `refusals` here sees one fewer refusal than the
/// immediate drain would report.
pub fn drain_deferred_ydoc_for_key_holding_cleanup(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    faults: &dyn FaultInjector,
) -> Result<(YdocDrainResult, YdocDrainCleanup), SyncError> {
    drain_deferred_ydoc(store, cache, key, DeferredDrainMode::All, faults)
}

/// Run the cleanup an immediate drain owes and surface its projection refusal
/// with the drain's own refusals.
fn complete_drain(
    store: &mut EngineStore,
    mut drained: YdocDrainResult,
    cleanup: YdocDrainCleanup,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
    let projection_refusal = complete_deferred_ydoc_drain_cleanup(store, cleanup, faults)?;
    drained.refusals.extend(projection_refusal);
    Ok(drained)
}

/// The final queue-row cleanup a held-cleanup drain still owes: persist the
/// pending projection refusal, then delete the drained rows. Runs the same
/// transaction the immediate drain would have run last. Returns the persisted refusal.
pub fn complete_deferred_ydoc_drain_cleanup(
    store: &mut EngineStore,
    cleanup: YdocDrainCleanup,
    faults: &dyn FaultInjector,
) -> Result<Option<crate::ReplicationRefusal>, SyncError> {
    if cleanup.coordinates.is_empty() && cleanup.projection_refusal.is_none() {
        return Ok(None);
    }
    let cleared = store.write_with(faults, |tx| {
        if let Some(refusal) = cleanup.projection_refusal.as_ref() {
            crate::apply::persist_refusal(tx, refusal)?;
        }
        for (origin_id, origin_seq) in &cleanup.coordinates {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![cleanup.workspace_id, origin_id, origin_seq],
            )
            .map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    })?;
    if matches!(cleared, TxnOutcome::Crashed { .. }) {
        return Err(SyncError::FaultCrash);
    }
    Ok(cleanup.projection_refusal)
}

/// Drain only deferred coordinates that belong to the lineage an open editor
/// is bound to. The first row for another claim is an arbitration boundary:
/// it and every later row remain queued until the session is removed and the
/// ordinary full drain can replace the lineage. This prevents settle/resync
/// from changing the durable generation underneath a still-live editor.
/// Native live bindings classify old coordinates without replacing the lineage.
pub fn drain_deferred_ydoc_for_live_session(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
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
    let (drained, cleanup) = drain_deferred_ydoc(
        store,
        cache,
        key,
        DeferredDrainMode::Live(expected_lineage_claim_id),
        faults,
    )?;
    complete_drain(store, drained, cleanup, faults)
}

/// Whether [`drain_deferred_ydoc_for_live_session`] would drain anything into
/// an open editor bound to `lineage_claim_id`: the replicated lineage is still
/// the one the editor opened, and the first deferred coordinate in relay order
/// belongs to it. A queue that starts with another claim waits for the session
/// to end, so it answers false.
pub fn live_session_has_drainable_deferred_ydoc(
    store: &EngineStore,
    key: &DocKey,
    lineage_claim_id: &str,
) -> Result<bool, SyncError> {
    let marker = dohc_engine_collab::read_marker(store, key).map_err(map_collab_hard_error)?;
    if !marker.is_some_and(|marker| {
        marker.regime == dohc_engine_collab::Regime::Replicated
            && marker.lineage_claim_id.as_deref() == Some(lineage_claim_id)
    }) {
        return Ok(false);
    }
    let first: Option<Option<String>> = store.read_with(|conn| {
        conn.query_row(
            "SELECT deferred.lineage_claim_id \
             FROM ydoc_deferred_updates AS deferred \
             JOIN replication_log AS log \
               ON log.workspace_id = deferred.workspace_id \
              AND log.origin_id = deferred.origin_id \
              AND log.origin_seq = deferred.origin_seq \
             WHERE deferred.workspace_id = ?1 AND deferred.version_id = ?2 \
               AND deferred.object_id = ?3 AND log.op_kind = 'ydoc.update' \
             ORDER BY deferred.relay_seq,log.origin_id,log.origin_seq \
             LIMIT 1",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })?;
    Ok(first.flatten().as_deref() == Some(lineage_claim_id))
}

#[derive(Clone, Copy)]
enum DeferredDrainMode<'a> {
    All,
    Batch,
    Live(Option<&'a str>),
}

/// The queue-row cleanup a drain still owes. See
/// [`drain_deferred_ydoc_for_key_holding_cleanup`].
#[derive(Debug)]
pub struct YdocDrainCleanup {
    workspace_id: String,
    coordinates: Vec<(String, i64)>,
    projection_refusal: Option<crate::ReplicationRefusal>,
}

fn drain_deferred_ydoc(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    mode: DeferredDrainMode<'_>,
    faults: &dyn FaultInjector,
) -> Result<(YdocDrainResult, YdocDrainCleanup), SyncError> {
    let inactive_refusals = if matches!(mode, DeferredDrainMode::All) {
        drain_inactive_ydoc_updates(store, &key.workspace_id, faults)?
    } else {
        Vec::new()
    };
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
                    || !valid_actor_origin_id(payload.actor_origin_id.as_deref())
                    || !valid_attribution(payload.attribution.as_ref())
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
        return Ok((
            YdocDrainResult {
                refusals: inactive_refusals,
                ..YdocDrainResult::default()
            },
            YdocDrainCleanup {
                workspace_id: key.workspace_id.clone(),
                coordinates: Vec::new(),
                projection_refusal: None,
            },
        ));
    }
    let search_policy = search_policy_for_store(store);
    let mut applied = 0usize;
    let mut refusals = inactive_refusals;
    let mut sharing_declined = Vec::new();
    let mut last_payload: Option<YdocUpdatePayload> = None;
    let mut payload_recorded_at = 0_i64;
    let mut drained_coordinates: Vec<(String, i64)> = Vec::new();
    let mut last_coordinate: Option<(String, i64)> = None;
    let mut lineage_replacements = Vec::new();
    let mut conflicts_opened = 0;
    let mut record_facts = Vec::new();
    let mut projection_refusal = None;
    for (origin_id, origin_seq, relay_seq, recorded_at_ms, lineage_claim_id, payload) in pending {
        if !payload.is_base_state
            && !matches!(mode, DeferredDrainMode::Live(_))
            && store.read_with(|conn| inactive_lineage_exists(conn, key, &lineage_claim_id))?
        {
            if matches!(mode, DeferredDrainMode::All) {
                refusals.extend(drain_inactive_ydoc_updates(
                    store,
                    &key.workspace_id,
                    faults,
                )?);
                drained_coordinates.push((origin_id, origin_seq));
            }
            continue;
        }
        let bytes = store
            .get_binary_blob(&payload.update_blob_sha256)?
            .ok_or(SyncError::BlobInvalid)?;
        let live_classification =
            store.read_with(|conn| live_ordinary_classification(conn, key, &payload, &bytes))?;
        if let DeferredDrainMode::Live(expected_claim_id) = mode
            && Some(lineage_claim_id.as_str()) != expected_claim_id
            && live_classification.is_none()
        {
            break;
        }
        if dohc_engine_storage::hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        if let Some(echo) = live_classification {
            if echo {
                drained_coordinates.push((origin_id, origin_seq));
            } else {
                refusals.push(refuse_deferred_ydoc(
                    store,
                    key,
                    &origin_id,
                    origin_seq,
                    LIVE_UNADMITTED_UPDATE,
                    faults,
                )?);
            }
            continue;
        }
        if payload.is_base_state {
            // A base can replace the lineage while reusing durable coordinates.
            // Evict before the transaction so a committed crash cannot leave an
            // ABA-valid entry behind.
            cache.remove(key);
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
            conflicts_opened += store.read_with(|conn| {
                conn.query_row("SELECT payload_hash FROM engine_requests WHERE request_id=?1 AND kind='sync-ydoc-conflict'",
                    [ydoc_conflict_coordinate_id(&key.workspace_id, &origin_id, origin_seq)],
                    |row| row.get::<_, String>(0),
                ).optional().map_err(SyncError::corrupt)
            })?.map_or(Ok(0), |count| count.parse::<i64>().map_err(SyncError::corrupt))?;
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
            let retained = store.write_with(faults, |tx| {
                apply_inactive_delta_in_tx(
                    tx,
                    key,
                    &payload,
                    &bytes,
                    recorded_at_ms,
                    search_policy.as_ref(),
                )
            });
            let retained = match retained {
                Ok(retained) => retained,
                Err(error) => {
                    if let Some(reason) = crate::apply::refusal_reason(&error) {
                        refusals.push(refuse_deferred_ydoc(
                            store,
                            key,
                            &origin_id,
                            origin_seq,
                            reason.message(),
                            faults,
                        )?);
                        continue;
                    }
                    return Err(error);
                }
            };
            match retained {
                TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
                TxnOutcome::Committed(InactiveDeltaOutcome {
                    refusal: Some(reason),
                    ..
                }) => {
                    refusals.push(refuse_deferred_ydoc(
                        store, key, &origin_id, origin_seq, reason, faults,
                    )?);
                }
                TxnOutcome::Committed(_) => {}
            }
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
        let remote = RemoteUpdate {
            origin_id: origin_id.clone(),
            origin_seq,
            bytes,
        };
        let apply_result = apply_remote_update(
            store,
            cache,
            key,
            &remote,
            payload.actor_origin_id.as_deref(),
            payload.attribution.as_ref(),
            faults,
            recorded_at_ms,
        );
        let (outcome, applied_facts) = match apply_result {
            Ok(applied) => (applied.outcome, applied.record_facts),
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
        match applied_facts {
            // A fresh apply's facts committed with the update, and the same
            // transaction copied them onto this deferred row.
            Some(facts) => record_facts.push(facts),
            // A replay of an already-committed apply derives nothing (its
            // history rows dedupe by coordinate), but an earlier failed
            // drain may have dropped facts it never surfaced. The decision
            // persisted on the deferred row carries them to this retry; the
            // queue cleanup below consumes it, so they surface exactly once.
            None => {
                record_facts.extend(read_parked_record_facts(
                    store, key, &origin_id, origin_seq,
                )?);
            }
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
    // Drained content must reach the visible head here, not only the CRDT
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
        && let Some((projected, projected_kind)) = project_final_drained_doc(
            store,
            cache,
            key,
            &payload,
            drain_origin,
            drain_seq,
            payload_recorded_at,
            search_policy.as_ref(),
            faults,
        )?
    {
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
                        projected_kind,
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
    // The durable markers clear last — after the projection committed or a
    // terminal disposition was persisted. A crash anywhere above leaves the
    // rows in place, and the retry re-runs apply (content-deduped) and the
    // projection; deleting first opened a window where the CRDT held the edit
    // but nothing would ever project it. A held cleanup extends the same
    // contract past the drain: the caller clears the rows only after its own
    // fallible follow-up (close-time materialization) succeeded.
    //
    // The count is DRAINED COORDINATES, not newly-applied rows: a marker
    // surviving an earlier failed drain redelivers its row as a dedupe, and
    // callers (the settle's remote-updates-pending refusal) must still see
    // that remote content landed which the live client has not resynced.
    let _ = applied;
    Ok((
        YdocDrainResult {
            drained: drained_coordinates.len(),
            conflicts_opened,
            refusals,
            sharing_declined,
            lineage_replacements,
            record_facts,
        },
        YdocDrainCleanup {
            workspace_id: key.workspace_id.clone(),
            coordinates: drained_coordinates,
            projection_refusal,
        },
    ))
}

/// The record-event decision an earlier drain committed with this parked
/// coordinate's apply. `None` for a coordinate that never derived
/// facts — or one no longer parked, which cannot happen mid-drain.
fn read_parked_record_facts(
    store: &EngineStore,
    key: &DocKey,
    origin_id: &str,
    origin_seq: i64,
) -> Result<Option<dohc_engine_domain::CollectionRecordApplyFacts>, SyncError> {
    let json: Option<String> = store.read_with(|conn| {
        conn.query_row(
            "SELECT record_facts_json FROM ydoc_deferred_updates \
             WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
            params![key.workspace_id, origin_id, origin_seq],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)
        .map(Option::flatten)
    })?;
    json.as_deref()
        .map(|json| {
            serde_json::from_str(json)
                .map_err(|_| local_corruption("parked ydoc.update record facts are malformed"))
        })
        .transpose()
}

type FinalDrainProjection = Result<TxnOutcome<crate::BaseOrigination>, SyncError>;

#[allow(clippy::too_many_arguments)]
fn project_final_drained_doc(
    store: &mut EngineStore,
    cache: &WriterDocCache,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    drain_origin: &str,
    drain_seq: i64,
    payload_recorded_at: i64,
    search_policy: Option<&SearchPolicySnapshot>,
    faults: &dyn FaultInjector,
) -> Result<Option<(FinalDrainProjection, ContentKind)>, SyncError> {
    if let Some(doc) = store
        .read_with(|conn| cache.doc_for_consumer(conn, key))
        .map_err(map_collab_hard_error)?
    {
        let marker = dohc_engine_collab::read_marker(store, key)
            .map_err(map_collab_hard_error)?
            .ok_or_else(|| local_corruption("drained Y.Doc marker disappeared"))?;
        if doc.has_pending_dependencies() {
            return Ok(None);
        }
        let projected = write_final_drained_projection(
            store,
            key,
            payload,
            doc,
            marker.content_kind,
            drain_origin,
            drain_seq,
            payload_recorded_at,
            search_policy,
            faults,
        );
        return Ok(Some((projected, marker.content_kind)));
    }

    let Some(persisted) =
        dohc_engine_collab::load_persisted(store, key).map_err(map_collab_hard_error)?
    else {
        return Ok(None);
    };
    if persisted.doc.has_pending_dependencies() {
        return Ok(None);
    }
    let kind = persisted.marker.content_kind;
    let projected = write_final_drained_projection(
        store,
        key,
        payload,
        &persisted.doc,
        kind,
        drain_origin,
        drain_seq,
        payload_recorded_at,
        search_policy,
        faults,
    );
    Ok(Some((projected, kind)))
}

#[allow(clippy::too_many_arguments)]
fn write_final_drained_projection(
    store: &mut EngineStore,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    doc: &dohc_engine_collab::Ydoc,
    content_kind: ContentKind,
    drain_origin: &str,
    drain_seq: i64,
    payload_recorded_at: i64,
    search_policy: Option<&SearchPolicySnapshot>,
    faults: &dyn FaultInjector,
) -> Result<TxnOutcome<crate::BaseOrigination>, SyncError> {
    store.write_with(faults, |tx| {
        project_and_write_in_tx(
            tx,
            key,
            &payload.path,
            doc,
            content_kind,
            // The real last drained coordinate keys the moment id: a synthetic
            // pair can collide when two batches land in one millisecond.
            drain_origin,
            drain_seq,
            payload_recorded_at,
            search_policy,
        )?;
        // Origination intentionally remains a full cold reconstruction.
        crate::originate_ydoc_base_in_tx(
            tx,
            key,
            &payload.path,
            payload.actor_origin_id.as_deref(),
            payload.attribution.as_ref(),
            payload_recorded_at,
        )
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
        if refusal.reason.message() == LIVE_UNADMITTED_UPDATE {
            retain_refused_ydoc_blob(tx, &key.workspace_id, origin_id, origin_seq)?;
            tx.execute("UPDATE replication_log SET apply_disposition='refused' WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                params![key.workspace_id,origin_id,origin_seq]).map_err(SyncError::persist)?;
        }
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

/// A folder move must check durable owner bindings, including owners that
/// have never queued an update. Closing a session does not end adoption.
pub fn ensure_no_adopted_owner_under_path(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<(), SyncError> {
    let adopted: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM live_owner_adoptions
         WHERE workspace_id=?1 AND main_version_id=?2
           AND (json_extract(binding_json,'$.currentPath')=?3
             OR substr(json_extract(binding_json,'$.currentPath'),1,length(?3)+1)=?3||'/'))",
            params![workspace_id, version_id, path],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if adopted {
        return Err(SyncError::LiveDocumentBindingActive);
    }
    Ok(())
}

fn ensure_adopted_owner_binding_unchanged(
    conn: &Connection,
    key: &DocKey,
    resulting_path: Option<&str>,
) -> Result<(), SyncError> {
    let changes_binding: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM live_owner_adoptions
         WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3
           AND (?4 IS NULL OR json_extract(binding_json,'$.currentPath') IS NOT ?4))",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                resulting_path
            ],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if changes_binding {
        return Err(SyncError::LiveDocumentBindingActive);
    }
    Ok(())
}

fn require_unfenced_lineage(conn: &Connection, key: &DocKey) -> Result<(), SyncError> {
    dohc_engine_collab::live_update_application::require_restore_open(conn, key).map_err(|error| {
        match error {
            CollabError::RestoreFenced => SyncError::InvalidInput {
                reason: "live document is stopped",
            },
            other => map_collab_hard_error(other),
        }
    })
}

pub(crate) fn retire_complete_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
) -> Result<(), SyncError> {
    let key = &complete.key;
    ensure_adopted_owner_binding_unchanged(tx, key, None)?;
    require_unfenced_lineage(tx, key)?;
    for statement in [
        "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        "DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        "DELETE FROM ydoc_deferred_updates \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        "DELETE FROM ydoc_base_relay_candidates \
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

/// Drop the local bases still waiting to learn their relay position.
///
/// Called once the lineage's position is known from a pulled base, or when the
/// lineage is gone. The pull resolves pending positions before it applies a
/// page, so a local base still pending then has not reached the relay, and the
/// relay will order it after every base the page holds.
fn clear_base_relay_candidates_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<(), SyncError> {
    tx.execute(
        "DELETE FROM ydoc_base_relay_candidates          WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
    )
    .map_err(SyncError::persist)?;
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

/// Whether any object in this workspace version needs Y.Doc reconciliation.
///
/// `ydoc_updates` and `ydoc_snapshots` are foreign-key children of
/// `ydoc_docs`, while a pre-base deferred update may exist without a marker.
/// Those are exactly the two roots read by `ydoc_lineage_completeness_in_tx`.
/// A capture-only transaction creates neither, so a false result remains false
/// for every item in that transaction.
pub fn workspace_has_ydoc_state_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
) -> Result<bool, SyncError> {
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_docs \
         WHERE workspace_id=?1 AND version_id=?2) \
         OR EXISTS(SELECT 1 FROM ydoc_deferred_updates \
         WHERE workspace_id=?1 AND version_id=?2)",
        params![workspace_id, version_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
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
        dohc_engine_collab::read_marker_in(tx, key).map_err(map_collab_hard_error)?
    else {
        return Ok(YdocLineageCompleteness::Complete(None));
    };
    let doc = dohc_engine_collab::load_doc_in(tx, key).map_err(map_collab_hard_error)?;
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

/// An observed owner's durable Y.Doc contains accepted state. Pending owner
/// edits live in its separate outbox and must not enter ordinary publication.
pub(crate) fn observed_owner_projection_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
) -> Result<
    Option<(
        dohc_engine_collab::owner_outbox::draft::OwnerDraftDescriptor,
        String,
    )>,
    SyncError,
> {
    let Some(owner) = dohc_engine_collab::owner_outbox::draft::descriptor_for_key_in(tx, key)
        .map_err(|error| match error {
            dohc_engine_collab::owner_outbox::OwnerOutboxError::Storage(storage) => {
                SyncError::Storage(storage)
            }
            error @ dohc_engine_collab::owner_outbox::OwnerOutboxError::Corrupt => {
                SyncError::corrupt(error)
            }
            _ => SyncError::LiveDocumentBindingActive,
        })?
    else {
        return Ok(None);
    };
    if owner.binding.current_path != path {
        return Err(SyncError::LiveDocumentBindingActive);
    }
    require_unfenced_lineage(tx, key)?;
    complete_ydoc_projection_in_tx(tx, key)?
        .and_then(|projection| projection.content)
        .map(|projection| Some((owner, projection)))
        .ok_or(SyncError::LiveDocumentBindingActive)
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
        ResultingHead::Text { path, text } => fold_complete_ydoc_lineage_in_tx(
            tx,
            &complete,
            path,
            text,
            LineageFoldAuthor::default(),
            now_ms,
            false,
        )
        .map(|_| ()),
        ResultingHead::BinaryOrAbsent => retire_complete_ydoc_lineage_in_tx(tx, &complete),
    }
}

/// Reconcile a locally-originated file mutation with its closed Y.Doc
/// lineage. The generated CRDT update is journaled before the mutation's
/// artifact operation, so every peer applies one canonical rewrite. Returns
/// the collection record fields the mutation changed, if it wrote a bound
/// record's frontmatter: from the lineage's fold, or, when the lineage holds
/// no content, from the record's index against the written text.
#[allow(clippy::too_many_arguments)]
pub fn reconcile_local_resulting_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    resulting: ResultingHead<'_>,
    actor_origin_id: Option<&str>,
    attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    now_ms: i64,
) -> Result<Option<dohc_engine_domain::CollectionRecordApplyFacts>, SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "Y.Doc lineage coordinates are invalid",
        })?;
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, &key)?;
    match resulting {
        ResultingHead::Text { path, text } => match fold_complete_ydoc_lineage_in_tx(
            tx,
            &complete,
            path,
            text,
            LineageFoldAuthor {
                actor_origin_id,
                attribution,
            },
            now_ms,
            true,
        )? {
            LineageFold::Folded(facts) => Ok(facts),
            LineageFold::NoContent => dohc_engine_domain::index_collection_record_text_in_tx(
                tx,
                workspace_id,
                version_id,
                object_id,
                path,
                text,
                actor_origin_id,
                attribution,
                now_ms,
            )
            .map_err(map_domain_hard_error),
        },
        ResultingHead::BinaryOrAbsent => {
            retire_complete_ydoc_lineage_in_tx(tx, &complete).map(|()| None)
        }
    }
}

/// Who wrote the text a fold folds in.
#[derive(Clone, Copy, Default)]
pub(crate) struct LineageFoldAuthor<'a> {
    pub(crate) actor_origin_id: Option<&'a str>,
    pub(crate) attribution: Option<&'a dohc_engine_domain::ChangeAttribution>,
}

/// What folding a file's text into its Y.Doc lineage did.
pub(crate) enum LineageFold {
    /// The lineage holds no content: the file alone carries the text.
    NoContent,
    /// The lineage holds the text now, with the record fields its append
    /// changed, if any.
    Folded(Option<dohc_engine_domain::CollectionRecordApplyFacts>),
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
            ensure_adopted_owner_binding_unchanged(tx, &complete.key, Some(path))?;
            require_unfenced_lineage(tx, &complete.key)?;
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
                    // An adopted owner cannot accept an ordinary rewrite.
                    // Retain this moment instead of waiting for that rewrite.
                    ensure_adopted_owner_binding_unchanged(tx, &complete.key, None)?;
                    if marker.content_kind == ContentKind::Scene {
                        // The origin of an external scene edit retires its
                        // lineage instead of emitting a Markdown rewrite (a
                        // scene has no fold), so the rewrite this pending
                        // state would wait for is never coming. Converge the
                        // same way the origin did: the replicated file moment
                        // is canonical, the lineage retires, and the next
                        // open seeds a fresh scene from the artifact.
                        return retire_complete_ydoc_lineage_in_tx(tx, complete);
                    }
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
/// The invariant, stated once: an open sync conflict on a Y.Doc object
/// freezes the visible head (`project_and_write_in_tx` coalesces the
/// conflict's incoming side instead of writing) and the settle (the daemon
/// refuses with `ydoc-conflict-open`, the same shape as the refusal of
/// the clobbering settle). Resolution lifts the freeze by making the choice
/// durable here — one update that rewrites the lineage's projection to the
/// chosen bytes, journaled when the workspace replicates — in the same
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
    // either reviewed side, and the drain that lands them runs after the
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
    fold_complete_ydoc_lineage_in_tx(
        tx,
        &complete,
        path,
        chosen_text,
        LineageFoldAuthor::default(),
        now_ms,
        true,
    )
    .map(|_| ())
}

pub(crate) fn fold_complete_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
    path: &str,
    chosen_text: &str,
    author: LineageFoldAuthor<'_>,
    now_ms: i64,
    journal: bool,
) -> Result<LineageFold, SyncError> {
    let LineageFoldAuthor {
        actor_origin_id,
        attribution,
    } = author;
    let key = &complete.key;
    ensure_adopted_owner_binding_unchanged(tx, key, Some(path))?;
    require_unfenced_lineage(tx, key)?;
    let Some((marker, doc)) = complete.state.as_ref() else {
        return Ok(LineageFold::NoContent);
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
        return Ok(LineageFold::NoContent);
    }
    let mut record_facts = None;
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
            return retire_complete_ydoc_lineage_in_tx(tx, complete)
                .map(|()| LineageFold::Folded(None));
        }
        let canonical_projection = doc
            .project(marker.content_kind)
            .map_err(|error| map_projection_error(error, "ydoc projection is invalid"))?;
        let source_preserved = marker.content_kind == ContentKind::Richdoc
            && projection.content != canonical_projection.content
            && doc.markdown_source_reference().is_some_and(|reference| {
                reference.source_sha256 == hex_sha256(projection.content.as_bytes())
                    && reference.projection_sha256
                        == hex_sha256(canonical_projection.content.as_bytes())
            });
        let update = if source_preserved {
            doc.rewrite_content_to_markdown_preserving_source(marker.content_kind, chosen_text)
        } else {
            doc.rewrite_content_to_markdown(marker.content_kind, chosen_text)
        }
        .map_err(|_| SyncError::InvalidInput {
            reason: "the content kind does not support Markdown conflict resolution",
        })?;
        // VERIFY THE FOLD'S OWN OUTPUT. The markdown parser behind the
        // rewrite is asserted to be the projector's inverse, and nothing
        // makes that true: a construct it does not model round-trips through
        // the projector's escaping (a deep `>` chain returns as `&gt;`), and
        // the fold would then commit a lineage whose projection is not the
        // chosen text while stamping last_settled_sha with the chosen text's
        // hash in the same statement — the head file saying one thing, the
        // CRDT another, and the marker asserting they agree. That is the
        // silent reversal this whole PR exists to close, reintroduced by the
        // fold. Re-project and compare instead of trusting the parser: the
        // doc and the transaction are already in hand, so the check is one
        // projection, and it covers every construct the parser will ever
        // fail to model rather than the ones known today.
        // SIZE FIRST: check length before the projection below — an
        // oversized doc trips a bare, limit-less `InvalidInput` there.
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
        let outcome = dohc_engine_collab::record_update_in_tx(
            tx,
            key,
            &update,
            actor_origin_id,
            attribution,
            now_ms,
        )
        .map_err(|error| {
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
                    actor_origin_id,
                    attribution,
                    false,
                ),
                now_ms,
            )?;
        }
        record_facts = outcome.record_facts;
    }
    // The resolution's head IS the settled artifact now: align the settle
    // expectation so the next session does not refuse ConflictStaleTarget
    // over the very state the user just chose.
    settle_ydoc_marker_to_text(tx, key, path, chosen_text, now_ms)?;
    Ok(LineageFold::Folded(record_facts))
}

fn settle_ydoc_marker_to_text(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    text: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    // The lineage at its current head projects to `text`, the head it settles
    // to here, so it covers every update up to that head.
    tx.execute(
        "UPDATE ydoc_docs SET path=?4, last_settled_sha=?5, updated_at_ms=?6, \
         settled_update_seq=head_update_seq \
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

#[allow(clippy::too_many_arguments)]
fn open_base_conflict_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    snapshot: &dohc_engine_domain::TextSnapshot,
    content: &str,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
) -> Result<i64, SyncError> {
    let projected_sha = hex_sha256(content.as_bytes());
    put_projection_text_blob(tx, content, &projected_sha)?;
    let incoming_moment_id = ydoc_apply_moment_id(key, path, origin_id, origin_seq);
    let conflict_id = crate::moment_apply::sync_conflict_id(
        &key.workspace_id,
        &key.version_id,
        &key.object_id,
        None,
        Some((
            Some(snapshot.latest_moment_id.as_str()),
            Some(incoming_moment_id.as_str()),
        )),
    );
    let base_side = crate::moment_apply::ConflictSide::absent(path);
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
        path: path.to_owned(),
        object_id: Some(key.object_id.clone()),
        kind: Some(crate::moment_apply::ContentKind::Text),
        digest: Some(projected_sha),
        updated_at_ms: Some(now_ms),
        latest_moment_id: Some(incoming_moment_id.clone()),
        metadata: Some(crate::moment_apply::Metadata {
            origin: "sync".to_owned(),
            summary: None,
            correlation_id: None,
        }),
    };
    let conflicts_opened = crate::moment_apply::open_or_coalesce(
        tx,
        &key.workspace_id,
        crate::moment_apply::OpenConflict {
            version_id: &key.version_id,
            anchor: crate::moment_apply::CoalesceAnchor::SameObject {
                diverging_object_id: &key.object_id,
                incoming_branch_base: None,
            },
            conflict_id: &conflict_id,
            path: &snapshot.path,
            base: &base_side,
            current: &current_side,
            incoming: &incoming_side,
            recorded_at_ms: now_ms,
        },
    )?;
    Ok(conflicts_opened)
}

#[allow(clippy::too_many_arguments)]
fn preserve_base_sides_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    incoming: crate::ydoc_recovery::RecoveryEnvelopeBinding<'_>,
    losing_claim_id: Option<&str>,
    losing_projection: Option<&str>,
    last_settled_sha: Option<&str>,
    incoming_content: &str,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<(Option<i64>, Vec<String>), SyncError> {
    let mut recovered_paths = Vec::new();
    // Equal projections need neither a choice nor a second copy.
    if let (Some(claim), Some(local)) = (losing_claim_id, losing_projection)
        && hex_sha256(local.as_bytes()) != hex_sha256(incoming_content.as_bytes())
    {
        if let Some(opened) = conflict_replaced_lineage_in_tx(
            tx,
            key,
            path,
            local,
            last_settled_sha,
            incoming_content,
            origin_id,
            origin_seq,
            now_ms,
            search_policy,
        )? {
            return Ok((Some(opened), recovered_paths));
        }
        let recovery = crate::ydoc_recovery::recover_lineage_in_tx(
            tx,
            key,
            path,
            incoming,
            claim,
            local,
            origin_id,
            origin_seq,
            now_ms,
            search_policy,
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
        params![key.workspace_id, key.version_id, key.object_id, path],
    )
    .map_err(SyncError::persist)?;

    let current = validate_retryable_ydoc_identity(tx, key, path)?;
    let head_settled_by_this_lineage: Option<String> = tx.query_row(
        "SELECT last_settled_sha FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
    ).optional().map_err(SyncError::corrupt)?.flatten();
    if let Some(snapshot) = current.snapshot.as_ref() {
        let head_is_preserved = head_settled_by_this_lineage.as_deref()
            == Some(snapshot.blob_sha256.as_str())
            || last_settled_sha == Some(snapshot.blob_sha256.as_str())
            || losing_projection
                .is_some_and(|local| hex_sha256(local.as_bytes()) == snapshot.blob_sha256);
        if !head_is_preserved
            && snapshot.blob_sha256 != hex_sha256(incoming_content.as_bytes())
            && open_sync_conflict_id(tx, key)?.is_none()
        {
            let opened = open_base_conflict_in_tx(
                tx,
                key,
                path,
                snapshot,
                incoming_content,
                origin_id,
                origin_seq,
                now_ms,
            )?;
            return Ok((Some(opened), recovered_paths));
        }
    }
    Ok((None, recovered_paths))
}

#[allow(clippy::too_many_arguments)]
fn preserve_incomplete_base_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    incoming_doc: &dohc_engine_collab::Ydoc,
    relay_seq: i64,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<Option<YdocApplyResult>, SyncError> {
    let Some(marker) =
        dohc_engine_collab::read_marker_in(tx, key).map_err(map_collab_hard_error)?
    else {
        return Ok(None);
    };
    if marker.lineage_claim_id.as_deref() == Some(payload.lineage_claim_id.as_str())
        || (marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
            && !marker.base_relay_confirmed_absent
            && marker.base_relay_seq.is_none_or(|local| local <= relay_seq))
    {
        return Ok(None);
    }
    let doc = dohc_engine_collab::load_doc_in(tx, key).map_err(map_collab_hard_error)?;
    if !doc.has_pending_dependencies() {
        return Ok(None);
    }
    // Merge the durable updates as wire data: a full-state encode alone omits
    // unresolved insertions and deletions.
    let local = project_ydoc_with_store(tx, key, &doc, marker.content_kind)?.content;
    let kind = dohc_engine_collab::ContentKind::parse(&payload.content_kind)
        .map_err(map_collab_hard_error)?;
    let incoming = project_ydoc_with_store(tx, key, incoming_doc, kind)?.content;
    let current = validate_retryable_ydoc_identity(tx, key, &payload.path)?;
    let snapshot = current.snapshot.as_ref();
    let open = open_sync_conflict_id(tx, key)?.is_some();
    let external = snapshot.filter(|snapshot| {
        snapshot.blob_sha256 != hex_sha256(local.as_bytes())
            && snapshot.blob_sha256 != hex_sha256(incoming.as_bytes())
    });
    let mut recovered_paths = Vec::new();
    if open || external.is_some() {
        let preserved = if open {
            local.clone()
        } else {
            tx.query_row(
                "SELECT text FROM blobs WHERE sha256=?1",
                [&external.unwrap().blob_sha256],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?
        };
        let recovery = crate::ydoc_recovery::recover_lineage_in_tx(
            tx,
            key,
            &payload.path,
            crate::ydoc_recovery::RecoveryEnvelopeBinding {
                content_kind: &payload.content_kind,
                update_blob_sha256: &payload.update_blob_sha256,
                lineage_claim_id: &payload.lineage_claim_id,
                is_base_state: true,
            },
            &payload.lineage_claim_id,
            &preserved,
            origin_id,
            origin_seq,
            now_ms,
            search_policy,
        )?;
        recovered_paths.push(recovery.path);
    }
    if let Some(conflict_id) = open_sync_conflict_id(tx, key)? {
        let prior: Option<String> = tx
            .query_row(
                "SELECT b.text FROM conflicts c JOIN blobs b ON b.sha256=c.incoming_blob_sha256 \
            WHERE c.workspace_id=?1 AND c.conflict_id=?2",
                params![key.workspace_id, conflict_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if let Some(prior) = prior.filter(|prior| prior != &incoming && prior != &local) {
            let recovery = crate::ydoc_recovery::create_recovery_in_tx(
                tx,
                key,
                &payload.path,
                marker
                    .lineage_claim_id
                    .as_deref()
                    .unwrap_or(&payload.lineage_claim_id),
                &prior,
                0,
                now_ms,
                search_policy,
            )?;
            recovered_paths.push(recovery.path);
        }
    }
    // The winning lineage owns incoming; the losing projection stays visible.
    let opened = conflict_replaced_lineage_in_tx(
        tx,
        key,
        &payload.path,
        &local,
        snapshot.map(|snapshot| snapshot.blob_sha256.as_str()),
        &incoming,
        origin_id,
        origin_seq,
        now_ms,
        search_policy,
    )?
    .unwrap_or(0);
    let mut updates = vec![doc.encode_full_state()];
    let mut stmt = tx.prepare(
        "SELECT b.bytes FROM ydoc_updates u JOIN binary_blobs b ON b.sha256=u.update_blob_sha256 \
         WHERE u.workspace_id=?1 AND u.version_id=?2 AND u.object_id=?3 ORDER BY u.seq",
    ).map_err(SyncError::corrupt)?;
    updates.extend(
        stmt.query_map(
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get::<_, Vec<u8>>(0),
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?,
    );
    let retained = dohc_engine_collab::merge_updates(&updates).map_err(map_collab_hard_error)?;
    let full_sha =
        dohc_engine_storage::put_binary_blob(tx, &retained).map_err(SyncError::Storage)?;
    let vector_sha = dohc_engine_storage::put_binary_blob(tx, &doc.encode_state_vector())
        .map_err(SyncError::Storage)?;
    let unpublished_claim = dohc_engine_storage::put_binary_blob(tx, &doc.encode_full_state())
        .map_err(SyncError::Storage)?;
    let claim = marker
        .lineage_claim_id
        .as_deref()
        .unwrap_or(&unpublished_claim);
    let local_sha = hex_sha256(local.as_bytes());
    put_projection_text_blob(tx, &local, &local_sha)?;
    tx.execute(
        "INSERT INTO ydoc_inactive_lineages (workspace_id,version_id,object_id,lineage_claim_id, \
         parent_claim_id,disposition,content_kind,path,epoch_tag,full_state_blob_sha256, \
         state_vector_blob_sha256,last_surfaced_projection_sha256,open_conflict_id,recorded_at_ms,updated_at_ms) \
         VALUES (?1,?2,?3,?4,?5,'rejected-base',?6,?7,?8,?9,?10,?11,?12,?13,?13)",
        params![key.workspace_id,key.version_id,key.object_id,claim,marker.lineage_parent_claim_id,
            marker.content_kind.as_str(),payload.path,marker.lineage_epoch_tag,full_sha,vector_sha,
            local_sha,open_sync_conflict_id(tx,key)?,now_ms],
    ).map_err(SyncError::persist)?;
    if marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Unclaimed {
        tx.execute(
            "DELETE FROM ydoc_updates WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(SyncError::persist)?;
        tx.execute(
            "DELETE FROM ydoc_snapshots WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
        )
        .map_err(SyncError::persist)?;
        tx.execute("UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0,settled_update_seq=NULL,seed_source_sha256=NULL \
            WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id,key.version_id,key.object_id]).map_err(SyncError::persist)?;
    }
    let incoming_bytes: Vec<u8> = tx
        .query_row(
            "SELECT bytes FROM binary_blobs WHERE sha256=?1",
            [&payload.update_blob_sha256],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    dohc_engine_collab::claim_base_at_relay_in_tx(
        tx,
        key,
        kind,
        &incoming_bytes,
        &incoming_doc.encode_state_vector(),
        &dohc_engine_collab::BaseRelayCoordinate::new(origin_id, origin_seq, relay_seq)
            .map_err(map_collab_hard_error)?,
        now_ms,
    )
    .map_err(map_collab_hard_error)?;
    if open {
        project_and_write_in_tx(
            tx,
            key,
            &payload.path,
            incoming_doc,
            kind,
            origin_id,
            origin_seq,
            now_ms,
            search_policy,
        )?;
    }
    Ok(Some(YdocApplyResult {
        deferred: false,
        reason: Some("ydoc-base-conflict"),
        conflicts_opened: opened,
        lineage_replacement: Some(YdocLineageReplacement {
            winner_lineage_claim_id: payload.lineage_claim_id.clone(),
            recovered_paths,
        }),
        record_facts: Vec::new(),
    }))
}

struct InactiveLineage {
    bytes: Vec<u8>,
    kind: String,
    surfaced: Option<String>,
    path: Option<String>,
    full_sha: String,
    vector_sha: String,
}

#[derive(Default)]
struct InactiveDeltaOutcome {
    found: bool,
    refusal: Option<String>,
    rejected: Vec<(usize, String)>,
}

pub(crate) fn drain_inactive_ydoc_updates(
    store: &mut EngineStore,
    workspace_id: &str,
    faults: &dyn FaultInjector,
) -> Result<Vec<crate::ReplicationRefusal>, SyncError> {
    let pending = store.read_with(|conn| conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates d JOIN ydoc_inactive_lineages l \
         ON l.workspace_id=d.workspace_id AND l.version_id=d.version_id AND l.object_id=d.object_id \
         AND l.lineage_claim_id=d.lineage_claim_id WHERE d.workspace_id=?1)",
        [workspace_id], |row| row.get::<_,bool>(0),
    )).map_err(SyncError::corrupt)?;
    if !pending {
        return Ok(Vec::new());
    }
    let search_policy = search_policy_for_store(store);
    let mut all_refusals = Vec::new();
    loop {
        let result = store.write_with(faults, |tx| {
        let mut statement = tx.prepare(
            "SELECT r.origin_id,r.origin_seq,r.recorded_at_ms,r.payload_json,b.byte_length \
             FROM ydoc_deferred_updates d JOIN ydoc_inactive_lineages l \
             ON l.workspace_id=d.workspace_id AND l.version_id=d.version_id \
             AND l.object_id=d.object_id AND l.lineage_claim_id=d.lineage_claim_id \
             JOIN replication_log r ON r.workspace_id=d.workspace_id \
             AND r.origin_id=d.origin_id AND r.origin_seq=d.origin_seq \
             LEFT JOIN binary_blobs b ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') \
             WHERE d.workspace_id=?1 ORDER BY d.relay_seq,d.origin_id,d.origin_seq LIMIT 256",
        ).map_err(SyncError::corrupt)?;
        let rows = statement.query_map([workspace_id], |row| Ok((
            row.get::<_,String>(0)?, row.get::<_,i64>(1)?, row.get::<_,i64>(2)?, row.get::<_,String>(3)?, row.get::<_,Option<i64>>(4)?,
        ))).map_err(SyncError::corrupt)?.collect::<Result<Vec<_>,_>>().map_err(SyncError::corrupt)?;
        let mut groups = std::collections::BTreeMap::<_, Vec<_>>::new();
        let mut batch_bytes = 0;
        let mut processed = 0;
        for (origin, seq, at, json, byte_length) in rows {
            let cost = usize::try_from(byte_length.ok_or(SyncError::BlobInvalid)?).map_err(SyncError::corrupt)?.saturating_add(json.len());
            // One admitted update is at most 20 MiB, plus a 256 KiB payload.
            if batch_bytes + cost > 24 * 1024 * 1024 {
                if processed == 0 { return Err(SyncError::BlobInvalid); }
                break;
            }
            batch_bytes += cost;
            processed += 1;
            let payload: YdocUpdatePayload = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
            let bytes = get_binary_blob(tx, &payload.update_blob_sha256).map_err(SyncError::Storage)?.ok_or(SyncError::BlobInvalid)?;
            if hex_sha256(&bytes) != payload.update_blob_sha256 { return Err(SyncError::BlobInvalid); }
            groups.entry((payload.version_id.clone(),payload.object_id.clone(),payload.lineage_claim_id.clone()))
                .or_default().push((origin,seq,at,payload,bytes));
        }
        let mut refusals = Vec::new();
        for ((version,object,_), rows) in groups {
            let key = DocKey::new(workspace_id, version, object).map_err(map_collab_hard_error)?;
            let last = rows.last().unwrap();
            let updates = rows.iter().map(|row| row.4.clone()).collect::<Vec<_>>();
            let outcome = apply_inactive_batch_in_tx(tx, &key, &last.3, &updates, last.2, search_policy.as_ref())?;
            let last_accepted = (0..rows.len()).rev().find(|index| !outcome.rejected.iter().any(|(rejected,_)| rejected == index));
            for (index, (origin,seq,_,_,_)) in rows.iter().enumerate() {
                let reason = outcome.rejected.iter().find(|(rejected,_)| *rejected == index).map(|(_,reason)| reason)
                    .or_else(|| (Some(index) == last_accepted).then_some(outcome.refusal.as_ref()).flatten());
                if let Some(reason) = reason {
                    let refusal = deferred_ydoc_refusal(&key, origin, *seq, reason.clone());
                    crate::apply::persist_refusal(tx, &refusal)?;
                    refusals.push(refusal);
                }
                tx.execute("DELETE FROM ydoc_deferred_updates WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                    params![workspace_id,origin,seq]).map_err(SyncError::persist)?;
            }
        }
        Ok::<_,SyncError>((processed,refusals))
    })?;
        match result {
            TxnOutcome::Committed((processed, refusals)) => {
                all_refusals.extend(refusals);
                if processed == 0 {
                    return Ok(all_refusals);
                }
            }
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
}

fn apply_inactive_delta_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    bytes: &[u8],
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<InactiveDeltaOutcome, SyncError> {
    let mut outcome =
        apply_inactive_batch_in_tx(tx, key, payload, &[bytes.to_vec()], now_ms, search_policy)?;
    if let Some((_, reason)) = outcome.rejected.pop() {
        outcome.refusal = Some(reason);
    }
    Ok(outcome)
}

fn apply_inactive_batch_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    updates: &[Vec<u8>],
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<InactiveDeltaOutcome, SyncError> {
    let archived: Option<InactiveLineage> = tx.query_row(
        "SELECT b.bytes,l.content_kind,l.last_surfaced_projection_sha256,l.path,l.full_state_blob_sha256,l.state_vector_blob_sha256 FROM ydoc_inactive_lineages l \
         JOIN binary_blobs b ON b.sha256=l.full_state_blob_sha256 \
         WHERE l.workspace_id=?1 AND l.version_id=?2 AND l.object_id=?3 AND l.lineage_claim_id=?4",
        params![key.workspace_id,key.version_id,key.object_id,payload.lineage_claim_id],
        |row| Ok(InactiveLineage { bytes:row.get(0)?,kind:row.get(1)?,surfaced:row.get(2)?,path:row.get(3)?,full_sha:row.get(4)?,vector_sha:row.get(5)? }),
    ).optional().map_err(SyncError::corrupt)?;
    let Some(InactiveLineage {
        bytes: prior,
        kind,
        surfaced,
        path,
        full_sha: old_full_sha,
        vector_sha: old_vector_sha,
    }) = archived
    else {
        return Ok(InactiveDeltaOutcome::default());
    };
    let path = path.as_deref().unwrap_or(&payload.path);
    let kind = ContentKind::parse(&kind).map_err(map_collab_hard_error)?;
    let dohc_engine_collab::ReplayBatch { doc, outcomes } =
        dohc_engine_collab::apply_replay_validated_batch(&prior, updates)
            .map_err(map_collab_hard_error)?;
    let mut retained = vec![prior];
    let mut rejected = Vec::new();
    for (index, (bytes, result)) in updates.iter().zip(outcomes).enumerate() {
        if let Err(error) = result {
            let error =
                map_collab_payload_error(error, "inactive Y.Doc update fails replay validation");
            if let Some(reason) = crate::apply::refusal_reason(&error) {
                rejected.push((index, reason.message().to_owned()));
                continue;
            }
            return Err(error);
        }
        retained.push(bytes.clone());
    }
    let merged = dohc_engine_collab::merge_updates(&retained).map_err(map_collab_hard_error)?;
    let full_sha = dohc_engine_storage::put_binary_blob(tx, &merged).map_err(SyncError::Storage)?;
    let vector_sha = dohc_engine_storage::put_binary_blob(tx, &doc.encode_state_vector())
        .map_err(SyncError::Storage)?;
    // Keep the archive's original vector rooted: a conflict.resolve journal
    // entry can still name it after the compacted vector advances.
    tx.execute(
        "UPDATE ydoc_inactive_lineages SET full_state_blob_sha256=?5,state_vector_blob_sha256=?6, \
        last_surfaced_state_vector_blob_sha256=COALESCE(last_surfaced_state_vector_blob_sha256,state_vector_blob_sha256), \
        last_surfaced_projection_sha256=?7,updated_at_ms=?8 \
        WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            payload.lineage_claim_id,
            full_sha,
            vector_sha,
            surfaced,
            now_ms
        ],
    )
    .map_err(SyncError::persist)?;
    for sha in [&old_full_sha, &old_vector_sha] {
        if sha != &full_sha && sha != &vector_sha {
            delete_replaced_inactive_blob(tx, key, &payload.lineage_claim_id, sha)?;
        }
    }
    if doc.has_pending_dependencies() {
        return Ok(InactiveDeltaOutcome {
            found: true,
            refusal: None,
            rejected,
        });
    }
    tx.execute_batch("SAVEPOINT dohc_inactive_projection")
        .map_err(SyncError::persist)?;
    let projection = (|| {
        let content = project_ydoc_with_store(tx, key, &doc, kind)?.content;
        let sha = hex_sha256(content.as_bytes());
        if surfaced.as_deref() != Some(sha.as_str()) {
            crate::ydoc_recovery::recover_inactive_projection_in_tx(
                tx,
                key,
                path,
                &payload.lineage_claim_id,
                &content,
                surfaced.as_deref().unwrap_or(""),
                &full_sha,
                now_ms,
                search_policy,
            )?;
            tx.execute(
                "UPDATE ydoc_inactive_lineages SET last_surfaced_projection_sha256=?5 \
                WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
                params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    payload.lineage_claim_id,
                    sha
                ],
            )
            .map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    })();
    let refusal = match projection {
        Ok(()) => None,
        Err(SyncError::ProjectionTooLarge {
            constraint,
            actual_bytes,
            limit_bytes,
        }) => Some(projection_too_large_reason(
            kind,
            constraint,
            actual_bytes,
            limit_bytes,
        )),
        Err(SyncError::InvalidInput { reason } | SyncError::RetryableState { reason }) => {
            Some(reason.to_owned())
        }
        Err(error) => return Err(error),
    };
    if refusal.is_some() {
        tx.execute_batch("ROLLBACK TO dohc_inactive_projection")
            .map_err(SyncError::persist)?;
    }
    tx.execute_batch("RELEASE dohc_inactive_projection")
        .map_err(SyncError::persist)?;
    Ok(InactiveDeltaOutcome {
        found: true,
        refusal,
        rejected,
    })
}

fn delete_replaced_inactive_blob(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    claim: &str,
    sha: &str,
) -> Result<(), SyncError> {
    match tx.execute(
        "DELETE FROM binary_blobs WHERE sha256=?1 AND NOT EXISTS \
        (SELECT 1 FROM replication_log WHERE op_kind='ydoc.update' AND workspace_id=?2 \
         AND json_extract(payload_json,'$.versionId')=?3 AND json_extract(payload_json,'$.objectId')=?4 \
         AND json_extract(payload_json,'$.lineageClaimId')=?5 AND json_extract(payload_json,'$.updateBlobSha256')=?1)",
        params![sha,key.workspace_id,key.version_id,key.object_id,claim],
    ) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(error, message))
            if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_FOREIGNKEY
                || (error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_TRIGGER
                    && message.as_deref() == Some("FOREIGN KEY constraint failed")) =>
        {
            Ok(())
        }
        Err(error) => Err(SyncError::persist(error)),
    }
}

#[allow(clippy::too_many_arguments)]
fn conflict_replaced_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    local_content: &str,
    last_settled_sha: Option<&str>,
    incoming_content: &str,
    origin_id: &str,
    origin_seq: i64,
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<Option<i64>, SyncError> {
    if open_sync_conflict_id(tx, key)?.is_some() {
        return Ok(None);
    }
    let current = validate_retryable_ydoc_identity(tx, key, path)?;
    let local_sha = hex_sha256(local_content.as_bytes());
    if current.snapshot.as_ref().is_some_and(|snapshot| {
        snapshot.blob_sha256 != local_sha && Some(snapshot.blob_sha256.as_str()) != last_settled_sha
    }) {
        // The external head, local draft and incoming lineage need three copies.
        return Ok(None);
    }
    if let Some(snapshot) = current
        .snapshot
        .as_ref()
        .filter(|snapshot| snapshot.blob_sha256 == local_sha)
    {
        return open_base_conflict_in_tx(
            tx,
            key,
            path,
            snapshot,
            incoming_content,
            origin_id,
            origin_seq,
            now_ms,
        )
        .map(Some);
    }
    let preimage = current
        .snapshot
        .as_ref()
        .map_or(Preimage::Absent, |snapshot| {
            Preimage::Present(snapshot.blob_sha256.clone())
        });
    let result = write_projected_text_in_tx(
        tx,
        &WriteText {
            workspace_id: key.workspace_id.clone(),
            version_id: key.version_id.clone(),
            object_id: key.object_id.clone(),
            path: path.to_owned(),
            text: local_content.to_owned(),
            moment_id: format!(
                "{}-local",
                ydoc_apply_moment_id(key, path, origin_id, origin_seq)
            ),
            metadata_origin: "ydoc".to_owned(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms,
            request_id: None,
        },
    )
    .map_err(map_domain_hard_error)?;
    enqueue_write(tx, &result, preimage, "ydoc").map_err(map_domain_hard_error)?;
    upsert_file_search_index(
        tx,
        &key.workspace_id,
        &key.version_id,
        &key.object_id,
        path,
        Some(local_content),
        search_policy,
    )?;
    open_base_conflict_in_tx(
        tx,
        key,
        path,
        &result.snapshot,
        incoming_content,
        origin_id,
        origin_seq,
        now_ms,
    )
    .map(Some)
}

/// Store projected content for the conflict UI to hydrate from `blobs`.
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

/// The text of the object's current snapshot in its version: the file the
/// last settle or capture left on disk.
fn local_snapshot_text(conn: &Connection, key: &DocKey) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3 \
           AND s.content_kind = 'text'",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(SyncError::corrupt)
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
        let mut projection = doc
            .project(content_kind)
            .map_err(|error| map_projection_error(error, "ydoc projection is invalid"))?;
        if content_kind == dohc_engine_collab::ContentKind::Richdoc
            && let Some(source) =
                doc.settled_markdown_source(&projection.content, || local_snapshot_text(conn, key))?
        {
            projection.content = source;
        }
        return Ok(projection);
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
/// the same admission transaction, so `versionedText.read`, search, and the
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
    if content_kind == dohc_engine_collab::ContentKind::Richdoc {
        dohc_engine_domain::synchronize_collection_frontmatter_index_in_tx(
            tx,
            &key.workspace_id,
            &key.version_id,
            &key.object_id,
            &doc.frontmatter_json(),
        )
        .map_err(map_domain_hard_error)?;
    }
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
            "UPDATE ydoc_docs SET last_settled_sha = ?4, updated_at_ms = ?5, path = ?6, \
             settled_update_seq = head_update_seq \
             WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
            params![
                key.workspace_id,
                key.version_id,
                key.object_id,
                snapshot.blob_sha256,
                now_ms,
                path,
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
    // old locally-settled sha behind would make the next session's settle
    // expectation trail the remote head — permanent ConflictStaleTarget.
    tx.execute(
        "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6, \
         path = ?7, settled_update_seq = head_update_seq \
         WHERE workspace_id = ?1 AND version_id = ?2 AND object_id = ?3",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            result.moment.moment_order,
            projected_sha,
            now_ms,
            path,
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

pub fn apply_ydoc_envelope(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    apply_ydoc_envelope_in_batch(store, cache, envelope, faults, leases, false)
}

pub(crate) fn apply_ydoc_envelope_in_batch(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
    batch_inactive: bool,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    if envelope.op_kind != "ydoc.update" {
        return Err(SyncError::UnsupportedOperation);
    }
    let payload: YdocUpdatePayload = match Deserialize::deserialize(&envelope.payload) {
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
    if !valid_actor_origin_id(payload.actor_origin_id.as_deref()) {
        return refuse_ydoc(
            store,
            envelope,
            faults,
            "ydoc.update actor origin is invalid",
        );
    }
    if !valid_attribution(payload.attribution.as_ref()) {
        return refuse_ydoc(
            store,
            envelope,
            faults,
            "ydoc.update attribution is invalid",
        );
    }
    let search_policy = search_policy_for_store(store);
    // Gate on the same floor the projection sink applies
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
        payload.version_id.clone(),
        payload.object_id.clone(),
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
    if payload.is_base_state {
        // Claim/arbitration can replace a lineage with ABA-equal coordinates.
        // Invalidate before any transaction so a committed crash stays safe.
        cache.remove(&key);
    }
    // The blob is validated before any ack path — including the live-lease
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
    if let Some(echo) =
        store.read_with(|conn| live_ordinary_classification(conn, &key, &payload, &bytes))?
    {
        return crate::apply::apply_envelope_with_mutation_outcome(
            store,
            envelope,
            faults,
            |tx, _| {
                if live_ordinary_classification(tx, &key, &payload, &bytes)? != Some(echo) {
                    return Err(SyncError::RetryableState {
                        reason: "native live binding changed",
                    });
                }
                if echo {
                    Ok(crate::apply::MutationOutcome::Applied(YdocApplyResult {
                        deferred: false,
                        reason: Some("native-live-content-echo"),
                        conflicts_opened: 0,
                        lineage_replacement: None,
                        record_facts: Vec::new(),
                    }))
                } else {
                    Ok(crate::apply::MutationOutcome::RefusedRetainingMutation {
                        reason: LIVE_UNADMITTED_UPDATE.into(),
                    })
                }
            },
        );
    }
    if !payload.is_base_state && store.read_with(|conn| conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_inactive_lineages WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4)",
        params![key.workspace_id,key.version_id,key.object_id,payload.lineage_claim_id], |row| row.get::<_,bool>(0),
    )).map_err(SyncError::corrupt)? {
        let mut outcome = crate::apply_envelope_with(store, envelope, faults, |tx, op| {
            tx.execute(
                "INSERT OR IGNORE INTO ydoc_deferred_updates \
                 (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id,relay_seq) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![key.workspace_id,key.version_id,key.object_id,op.origin_id,op.origin_seq,op.recorded_at_ms,payload.lineage_claim_id,relay_seq],
            ).map_err(SyncError::persist)?;
            Ok(YdocApplyResult { deferred: true, reason: Some("ydoc-inactive-lineage"), conflicts_opened: 0, lineage_replacement: None, record_facts: Vec::new() })
        })?;
        if !batch_inactive && !leases.is_live(&key) {
            let refusals = drain_inactive_ydoc_updates(store, &key.workspace_id, faults)?;
            if let Some(refusal) = refusals.iter().find(|refusal| refusal.origin_id == envelope.origin_id && refusal.origin_seq == envelope.origin_seq) {
                outcome.primary = ApplyDisposition::Refused(refusal.clone());
            }
            outcome.refusals.extend(refusals);
        }
        return Ok(outcome);
    }
    if leases.is_live(&key) {
        // Full durable validation before admission: byte caps, abort-safe
        // prevalidation, and the replay-parity gate — replayed on top of the
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
                if queued_claim_id != queued_payload.lineage_claim_id
                    || !valid_actor_origin_id(queued_payload.actor_origin_id.as_deref())
                {
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
            dohc_engine_collab::validate_remote_update(store, cache, &key, &queued, &bytes)
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
        // the close/open drains only do for replicated markers. A live lease
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
            // Record which coordinate is pending in the same transaction as
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
                record_facts: Vec::new(),
            })
        });
    }
    // Base bootstrap: a fresh replica's first op for a replicated doc is the
    // base full-state — apply_remote_update requires an existing marker, so
    // without this branch the pull wedges on NoMarker before the ack. The
    // claim is idempotent (an existing claimed base resumes), so a crash
    // between claim and ack replays safely; the coordinate then acks below.
    if payload.is_base_state {
        // The claim runs inside the admission transaction: a standalone claim
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
        // any of its rows are purged and is preserved for conflict review.
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
        let base_payload = &payload;
        let outcome = crate::apply_envelope_with(store, envelope, faults, move |tx, op| {
            let coordinate = dohc_engine_collab::BaseRelayCoordinate::new(
                op.origin_id.clone(),
                op.origin_seq,
                relay_seq,
            )
            .map_err(map_collab_hard_error)?;
            // Another device seeded the same head, or the relay redelivered
            // this base. The lineage already holds it, so the base adds only
            // its relay position, and the file keeps every edit made since.
            // This runs before the path check: the object may have moved
            // since the other device sent the base.
            if dohc_engine_collab::read_marker_in(tx, &claim_key)
                .map_err(map_collab_hard_error)?
                .is_some_and(|marker| {
                    marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
                        && marker.lineage_claim_id.as_deref() == Some(incoming.lineage_claim_id)
                })
            {
                let resumed = dohc_engine_collab::claim_base_at_relay_in_tx(
                    tx,
                    &claim_key,
                    kind,
                    &claim_bytes,
                    &sv_bytes,
                    &coordinate,
                    op.recorded_at_ms,
                )
                .map_err(|error| {
                    map_collab_payload_error(error, "ydoc.update base could not be claimed")
                })?;
                if !matches!(resumed, dohc_engine_collab::ClaimOutcome::Resumed) {
                    return Err(local_corruption(
                        "a Y.Doc base matching the active claim did not resume",
                    ));
                }
                clear_base_relay_candidates_in_tx(tx, &claim_key)?;
                return Ok(YdocApplyResult {
                    deferred: false,
                    reason: Some("ydoc-base-resumed"),
                    conflicts_opened: 0,
                    lineage_replacement: None,
                    record_facts: Vec::new(),
                });
            }
            // Cross-origin file edits can temporarily occupy this path before
            // the base arrives. Retrying after the later delete/rename is
            // convergence-safe; refusing and ACKing would lose the base
            // forever on this receiver.
            validate_retryable_ydoc_identity(tx, &claim_key, &base_path)?;
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
            let marker_before = dohc_engine_collab::read_marker_in(tx, &claim_key)
                .map_err(map_collab_hard_error)?;
            let losing_last_settled_sha: Option<String> = tx
                .query_row(
                    "SELECT COALESCE(last_settled_sha,seed_source_sha256) FROM ydoc_docs \
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
            if let Some(result) = preserve_incomplete_base_in_tx(
                tx,
                &claim_key,
                base_payload,
                &incoming_doc,
                relay_seq,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            )? {
                record_ydoc_conflicts_opened(tx, op, result.conflicts_opened)?;
                return Ok(result);
            }
            let losing_projection = if local_unpublished
                || marker_before.as_ref().is_some_and(|marker| {
                    marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
                        && marker.lineage_claim_id.as_deref() != Some(incoming.lineage_claim_id)
                }) {
                let doc = dohc_engine_collab::load_doc_in(tx, &claim_key)
                    .map_err(map_collab_hard_error)?;
                let marker = marker_before
                    .as_ref()
                    .ok_or_else(|| local_corruption("Y.Doc losing lineage has no marker"))?;
                Some(project_ydoc_with_store(tx, &claim_key, &doc, marker.content_kind)?.content)
            } else {
                None
            };
            let unpublished_claim_id = if local_unpublished {
                let doc = dohc_engine_collab::load_doc_in(tx, &claim_key)
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
                // `seed_source_sha256` clears with the rows it described:
                // the winning base holds content the file does not, and the
                // seed-only settle skip must never survive a lineage
                // replacement on the base claim's snapshot insert alone.
                tx.execute(
                    "UPDATE ydoc_docs SET head_update_seq=0,head_snapshot_seq=0,
                        settled_update_seq=NULL,seed_source_sha256=NULL,
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
                &coordinate,
                op.recorded_at_ms,
            )
            .map_err(|error| {
                map_collab_payload_error(error, "ydoc.update base could not be claimed")
            })?;
            let (winner, losing_claim_id, replaced) = match claim {
                dohc_engine_collab::ClaimOutcome::AlreadyWon { winner } => {
                    // Only the replaced peer has its complete local projection.
                    // It opens the conflict; the winner must not invent a side
                    // from an incomplete incoming base.
                    let _ = winner;
                    return Ok(YdocApplyResult {
                        deferred: false,
                        reason: Some("ydoc-base-already-won"),
                        conflicts_opened: 0,
                        lineage_replacement: None,
                        record_facts: Vec::new(),
                    });
                }
                dohc_engine_collab::ClaimOutcome::Replaced {
                    losing_lineage_claim_id,
                    winner,
                } => (winner, Some(losing_lineage_claim_id), true),
                // The matching active claim resumed above, in this transaction.
                dohc_engine_collab::ClaimOutcome::Resumed => {
                    return Err(local_corruption(
                        "a Y.Doc base matching the active claim was not resumed first",
                    ));
                }
                dohc_engine_collab::ClaimOutcome::Claimed { .. } => {
                    let winner = dohc_engine_collab::read_marker_in(tx, &claim_key)
                        .map_err(map_collab_hard_error)?
                        .ok_or_else(|| local_corruption("claimed Y.Doc lineage has no marker"))?;
                    (winner, unpublished_claim_id, local_unpublished)
                }
            };
            let winner_lineage_claim_id = winner
                .lineage_claim_id
                .clone()
                .ok_or_else(|| local_corruption("winning Y.Doc lineage has no claim identity"))?;
            let projection = project_ydoc_with_store(tx, &claim_key, &incoming_doc, kind)?;
            let (conflict, recovered_paths) = preserve_base_sides_in_tx(
                tx,
                &claim_key,
                &base_path,
                incoming.clone(),
                losing_claim_id.as_deref(),
                losing_projection.as_deref(),
                losing_last_settled_sha.as_deref(),
                &projection.content,
                &op.origin_id,
                op.origin_seq,
                op.recorded_at_ms,
                search_policy.as_ref(),
            )?;
            if let Some(conflicts_opened) = conflict {
                record_ydoc_conflicts_opened(tx, op, conflicts_opened)?;
                return Ok(YdocApplyResult {
                    deferred: false,
                    reason: Some("ydoc-base-conflict"),
                    conflicts_opened,
                    lineage_replacement: replaced.then_some(YdocLineageReplacement {
                        winner_lineage_claim_id,
                        recovered_paths,
                    }),
                    record_facts: Vec::new(),
                });
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
                record_facts: Vec::new(),
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
        if matches!(
            outcome.primary,
            ApplyDisposition::Applied(_) | ApplyDisposition::Skipped
        ) && dohc_engine_collab::read_marker(store, &key)
            .map_err(map_collab_hard_error)?
            .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
        {
            let drain = drain_deferred_ydoc_in_batch(store, cache, &key, faults, batch_inactive)?;
            let mut outcome = merge_drained(
                merge_lineage_replacements(
                    outcome,
                    drain.lineage_replacements,
                    drain.conflicts_opened,
                ),
                drain.record_facts,
            );
            outcome.sharing_declined.extend(drain.sharing_declined);
            outcome.refusals.extend(drain.refusals);
            return Ok(outcome);
        }
        return Ok(outcome);
    }
    // The lease is not live: any coordinates parked by an earlier live
    // phase drain first, so the projection below reconstructs the complete
    // applied lineage (a partial projection would materialize a file missing
    // parked content).
    let drain = if dohc_engine_collab::read_marker(store, &key)
        .map_err(map_collab_hard_error)?
        .is_some_and(|marker| marker.regime == dohc_engine_collab::Regime::Replicated)
    {
        drain_deferred_ydoc_in_batch(store, cache, &key, faults, batch_inactive)?
    } else {
        YdocDrainResult::default()
    };
    // Only the marker is read before admission. Candidate integration and its
    // projection doc are produced by the replay gate inside the transaction,
    // so neither a cold doc nor the writer cache is mutated before commit.
    {
        let Some(marker) =
            dohc_engine_collab::read_marker(store, &key).map_err(map_collab_hard_error)?
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
            return crate::apply::apply_envelope_with_mutation_outcome(
                store,
                envelope,
                faults,
                move |tx, op| {
                    let inactive = apply_inactive_delta_in_tx(
                        tx,
                        &deferred_key,
                        &payload,
                        &bytes,
                        op.recorded_at_ms,
                        search_policy.as_ref(),
                    )?;
                    if let Some(reason) = inactive.refusal {
                        return Ok(crate::apply::MutationOutcome::RefusedRetainingMutation {
                            reason,
                        });
                    }
                    if inactive.found {
                        return Ok(crate::apply::MutationOutcome::Applied(YdocApplyResult {
                            deferred: false,
                            reason: Some("ydoc-inactive-lineage"),
                            conflicts_opened: 0,
                            lineage_replacement: None,
                            record_facts: Vec::new(),
                        }));
                    }
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
                    Ok(crate::apply::MutationOutcome::Applied(YdocApplyResult {
                        deferred: true,
                        reason: Some("ydoc-lineage-absent"),
                        conflicts_opened: 0,
                        lineage_replacement: None,
                        record_facts: Vec::new(),
                    }))
                },
            );
        };
        if marker.lineage_claim_status != dohc_engine_collab::LineageClaimStatus::Exact {
            return Err(SyncError::RetryableState {
                reason: "ydoc.update delta is waiting for a verified base identity",
            });
        }
        if marker.lineage_claim_id.as_deref() != Some(payload.lineage_claim_id.as_str()) {
            // The relay winner is already known. This coordinate still gets
            // its normal durable ack/log record, but its causal bytes must not
            // enter a different immutable lineage.
            let outcome = crate::apply::apply_envelope_with_mutation_outcome(
                store,
                envelope,
                faults,
                |tx, op| {
                    let inactive = apply_inactive_delta_in_tx(
                        tx,
                        &key,
                        &payload,
                        &bytes,
                        op.recorded_at_ms,
                        search_policy.as_ref(),
                    )?;
                    if let Some(reason) = inactive.refusal {
                        return Ok(crate::apply::MutationOutcome::RefusedRetainingMutation {
                            reason,
                        });
                    }
                    Ok(crate::apply::MutationOutcome::Applied(YdocApplyResult {
                        deferred: false,
                        reason: Some("ydoc-lineage-lost"),
                        conflicts_opened: 0,
                        lineage_replacement: None,
                        record_facts: Vec::new(),
                    }))
                },
            )?;
            // The drain above ran before this apply, so its facts lead.
            let mut outcome = merge_drained_first(
                merge_lineage_replacements(
                    outcome,
                    drain.lineage_replacements,
                    drain.conflicts_opened,
                ),
                drain.record_facts,
            );
            outcome.sharing_declined.extend(drain.sharing_declined);
            outcome.refusals.extend(drain.refusals);
            return Ok(outcome);
        }
    }
    let update_path = payload.path.clone();
    let remote = RemoteUpdate {
        origin_id: envelope.origin_id.clone(),
        origin_seq: envelope.origin_seq,
        bytes,
    };
    let mut sharing_declined = None;
    let mut record_facts = None;
    let mut cache_probe = RemoteAppendProbe::default();
    let gate_cache: &WriterDocCache = cache;
    let outcome_result =
        crate::apply::apply_envelope_with_mutation_outcome(store, envelope, faults, |tx, op| {
            let projected = apply_remote_update_in_transaction_with_projection(
                tx,
                gate_cache,
                &mut cache_probe,
                &key,
                &remote,
                payload.actor_origin_id.as_deref(),
                payload.attribution.as_ref(),
                op.recorded_at_ms,
            )
            .map_err(|error| map_collab_payload_error(error, "ydoc.update could not be applied"))?;
            let applied = projected.outcome;
            let update_kind = projected.content_kind;
            record_facts = projected.record_facts;
            // An out-of-order cross-origin update parks durably with missing
            // dependencies; a projection taken now would omit the pending remote
            // content and materialize an incomplete view. Skip — the envelope
            // that completes the dependency projects the full doc.
            let mutation = if projected.doc.has_pending_dependencies() {
                crate::apply::MutationOutcome::Applied(applied)
            } else {
                tx.execute_batch("SAVEPOINT dohc_ydoc_projection")
                    .map_err(SyncError::persist)?;
                match project_and_write_in_tx(
                    tx,
                    &key,
                    &update_path,
                    &projected.doc,
                    update_kind,
                    &op.origin_id,
                    op.origin_seq,
                    op.recorded_at_ms,
                    search_policy.as_ref(),
                ) {
                    Ok(()) => {
                        if let crate::BaseOrigination::Declined(declined) =
                            crate::originate_ydoc_base_in_tx(
                                tx,
                                &key,
                                &update_path,
                                payload.actor_origin_id.as_deref(),
                                payload.attribution.as_ref(),
                                op.recorded_at_ms,
                            )?
                        {
                            sharing_declined = Some(declined);
                        }
                        tx.execute_batch("RELEASE dohc_ydoc_projection")
                            .map_err(SyncError::persist)?;
                        crate::apply::MutationOutcome::Applied(applied)
                    }
                    Err(SyncError::InvalidInput { reason }) => {
                        tx.execute_batch(
                            "ROLLBACK TO dohc_ydoc_projection; \
                         RELEASE dohc_ydoc_projection",
                        )
                        .map_err(SyncError::persist)?;
                        crate::apply::MutationOutcome::RefusedRetainingMutation {
                            reason: reason.to_owned(),
                        }
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
                        crate::apply::MutationOutcome::RefusedRetainingMutation {
                            reason: projection_too_large_reason(
                                update_kind,
                                constraint,
                                actual_bytes,
                                limit_bytes,
                            ),
                        }
                    }
                    Err(hard) => return Err(hard),
                }
            };
            cache_probe.capture_commit(tx, &key);
            Ok(mutation)
        });
    let outcome = match outcome_result {
        Ok(outcome) => outcome,
        Err(error) => {
            cache.finish_remote_gate_error(&key, &cache_probe);
            return Err(error);
        }
    };
    match &outcome.primary {
        ApplyDisposition::Applied(_) | ApplyDisposition::Refused(_) => {
            cache.finish_remote_append(&key, &remote.bytes, cache_probe);
        }
        ApplyDisposition::Crashed { committed: true } => cache.remove(&key),
        ApplyDisposition::Crashed { committed: false } => {
            cache.finish_remote_gate_error(&key, &cache_probe);
        }
        ApplyDisposition::Skipped => {}
    }
    if matches!(
        outcome.primary,
        ApplyDisposition::Applied(ReplicationApplyOutcome::Applied { .. })
    ) {
        let compacted = maybe_compact(
            store,
            &key,
            DEFAULT_COMPACTION_THRESHOLD,
            faults,
            envelope.recorded_at_ms,
        )
        .map_err(|_| SyncError::InvalidInput {
            reason: "ydoc.update compaction failed",
        })?;
        match compacted {
            TxnOutcome::Committed(CompactOutcome::Compacted {
                up_to_seq,
                snapshot_sha,
                ..
            }) => cache.note_compacted(store, &key, up_to_seq, &snapshot_sha),
            TxnOutcome::Committed(CompactOutcome::Skipped { .. }) => {}
            TxnOutcome::Crashed { .. } => cache.remove(&key),
        }
    }
    // This path drained before the primary apply, so the drained facts
    // committed first and lead the emission order.
    let mut outcome = merge_drained_first(
        merge_lineage_replacements(
            map_applied_ydoc_outcome(outcome, sharing_declined, record_facts),
            drain.lineage_replacements,
            drain.conflicts_opened,
        ),
        drain.record_facts,
    );
    outcome.sharing_declined.extend(drain.sharing_declined);
    outcome.refusals.extend(drain.refusals);
    Ok(outcome)
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

/// Appends the facts a deferred drain committed to the envelope's own, in
/// commit order, so the pull pass emits every record event this apply
/// caused. A skipped primary still carries the drain's facts: those rows
/// are committed whatever the primary did. Use this where the drain ran
/// after the primary apply.
fn merge_drained(
    outcome: ApplyOutcome<YdocApplyResult>,
    drained: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
) -> ApplyOutcome<YdocApplyResult> {
    merge_drained_ordered(outcome, drained, false)
}

/// The same merge where the drain ran before the primary apply: the drained
/// facts committed first, so they lead.
fn merge_drained_first(
    outcome: ApplyOutcome<YdocApplyResult>,
    drained: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
) -> ApplyOutcome<YdocApplyResult> {
    merge_drained_ordered(outcome, drained, true)
}

fn merge_drained_ordered(
    mut outcome: ApplyOutcome<YdocApplyResult>,
    drained: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    drained_first: bool,
) -> ApplyOutcome<YdocApplyResult> {
    if drained.is_empty() {
        return outcome;
    }
    outcome.primary = match outcome.primary {
        ApplyDisposition::Applied(mut result) => {
            if drained_first {
                let own = std::mem::take(&mut result.record_facts);
                result.record_facts = drained;
                result.record_facts.extend(own);
            } else {
                result.record_facts.extend(drained);
            }
            ApplyDisposition::Applied(result)
        }
        ApplyDisposition::Skipped => ApplyDisposition::Applied(YdocApplyResult {
            deferred: false,
            reason: Some("ydoc-deferred-drained"),
            conflicts_opened: 0,
            lineage_replacement: None,
            record_facts: drained,
        }),
        // The primary refusal precedes diagnostics from other drained work.
        ApplyDisposition::Refused(refusal) => {
            outcome.refusals.insert(0, refusal);
            ApplyDisposition::Applied(YdocApplyResult {
                deferred: false,
                reason: Some("ydoc-deferred-drained"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: drained,
            })
        }
        // A crash ends the pull pass before post-commit emission; retry recovers the facts.
        crashed @ ApplyDisposition::Crashed { .. } => crashed,
    };
    outcome
}

#[cfg(test)]
mod merge_drained_tests {
    use super::*;

    fn facts(record_id: &str) -> dohc_engine_domain::CollectionRecordApplyFacts {
        dohc_engine_domain::CollectionRecordApplyFacts {
            collection_path: "tasks".to_owned(),
            record_id: record_id.to_owned(),
            created: false,
            author_origin_id: None,
            attribution: None,
            source: None,
            recorded_at_ms: 0,
            fields: Vec::new(),
        }
    }

    fn applied(record_id: &str) -> ApplyOutcome<YdocApplyResult> {
        ApplyOutcome::new(ApplyDisposition::Applied(YdocApplyResult {
            deferred: false,
            reason: None,
            conflicts_opened: 0,
            lineage_replacement: None,
            record_facts: vec![facts(record_id)],
        }))
    }

    fn ids(outcome: ApplyOutcome<YdocApplyResult>) -> Vec<String> {
        match outcome {
            ApplyOutcome {
                primary: ApplyDisposition::Applied(result),
                ..
            } => result
                .record_facts
                .into_iter()
                .map(|facts| facts.record_id)
                .collect(),
            other => panic!("expected an applied outcome: {other:?}"),
        }
    }

    #[test]
    fn drained_facts_keep_commit_order_on_both_paths() {
        // Drain after the primary: the primary's facts committed first.
        let outcome = merge_drained(applied("rec_primary"), vec![facts("rec_parked")]);
        assert!(outcome.refusals.is_empty());
        assert!(outcome.sharing_declined.is_empty());
        assert_eq!(ids(outcome), vec!["rec_primary", "rec_parked"]);
        // Drain before the primary: the parked update's facts committed first.
        let outcome = merge_drained_first(applied("rec_primary"), vec![facts("rec_parked")]);
        assert!(outcome.refusals.is_empty());
        assert!(outcome.sharing_declined.is_empty());
        assert_eq!(ids(outcome), vec!["rec_parked", "rec_primary"]);
        // A skipped primary still carries the drain's facts.
        let outcome = merge_drained(
            ApplyOutcome::new(ApplyDisposition::Skipped),
            vec![facts("rec_parked")],
        );
        assert!(outcome.refusals.is_empty());
        assert!(outcome.sharing_declined.is_empty());
        assert_eq!(ids(outcome), vec!["rec_parked"]);
        // A refused primary carries them too, with the refusal as a
        // diagnostic the pass still reports.
        let refusal = crate::ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 1,
            op_kind: "ydoc.update".to_owned(),
            reason: crate::RefusalReason::InvalidInput {
                reason: "bad update".to_owned(),
            },
        };
        let merged = merge_drained(
            ApplyOutcome::new(ApplyDisposition::Refused(refusal.clone())),
            vec![facts("rec_parked")],
        );
        assert_eq!(merged.refusals, vec![refusal]);
        assert_eq!(ids(merged), vec!["rec_parked"]);
    }

    #[test]
    fn primary_changes_keep_diagnostics_in_reporting_order() {
        let refusal = crate::ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 1,
            op_kind: "ydoc.update".to_owned(),
            reason: crate::RefusalReason::InvalidInput {
                reason: "bad primary".to_owned(),
            },
        };
        let older = crate::ReplicationRefusal {
            origin_seq: 2,
            ..refusal.clone()
        };
        let declined = crate::SharingDeclined {
            path: "notes/drained.md".to_owned(),
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limit_bytes: 20,
            observed_bytes: 21,
        };
        let outcome = ApplyOutcome {
            primary: ApplyDisposition::Refused(refusal.clone()),
            refusals: vec![older.clone(), refusal.clone()],
            sharing_declined: vec![declined.clone()],
        };
        let merged = merge_drained_first(outcome, vec![facts("committed")]);
        // Keep duplicates here: relay accumulation owns coordinate deduplication.
        assert_eq!(
            merged.refusals,
            [refusal.clone(), older.clone(), refusal.clone()]
        );
        assert_eq!(merged.sharing_declined, std::slice::from_ref(&declined));
        assert_eq!(ids(merged), ["committed"]);

        let own_decline = crate::SharingDeclined {
            path: "notes/primary.md".to_owned(),
            ..declined.clone()
        };
        let mapped = map_applied_ydoc_outcome(
            ApplyOutcome {
                primary: ApplyDisposition::Applied(ReplicationApplyOutcome::Deduped { seq: 1 }),
                refusals: vec![older],
                sharing_declined: vec![declined.clone()],
            },
            Some(own_decline.clone()),
            Some(facts("primary")),
        );
        assert_eq!(mapped.sharing_declined, [own_decline, declined.clone()]);
        assert_eq!(mapped.refusals.len(), 1);
        assert_eq!(mapped.refusals[0].origin_seq, 2);
        assert_eq!(ids(mapped), ["primary"]);

        for primary in [
            ApplyDisposition::Skipped,
            ApplyDisposition::Crashed { committed: true },
        ] {
            let outcome = ApplyOutcome {
                primary,
                refusals: vec![refusal.clone()],
                sharing_declined: vec![declined.clone()],
            };
            let expected = outcome
                .clone()
                .map(|_: ReplicationApplyOutcome| unreachable!());
            let mapped = map_applied_ydoc_outcome(
                outcome,
                Some(declined.clone()),
                Some(facts("not-applied")),
            );
            assert_eq!(mapped, expected);
        }
    }
}

fn merge_lineage_replacements(
    mut outcome: ApplyOutcome<YdocApplyResult>,
    replacements: Vec<YdocLineageReplacement>,
    conflicts_opened: i64,
) -> ApplyOutcome<YdocApplyResult> {
    let replacement = collapse_lineage_replacements(replacements);
    if replacement.is_none() && conflicts_opened == 0 {
        return outcome;
    }
    outcome.primary = match outcome.primary {
        ApplyDisposition::Applied(mut result) => {
            result.conflicts_opened += conflicts_opened;
            result.lineage_replacement = collapse_lineage_replacements(
                result
                    .lineage_replacement
                    .into_iter()
                    .chain(replacement)
                    .collect(),
            );
            ApplyDisposition::Applied(result)
        }
        ApplyDisposition::Skipped => ApplyDisposition::Applied(YdocApplyResult {
            deferred: false,
            reason: Some("ydoc-deferred-lineage-replaced"),
            conflicts_opened,
            lineage_replacement: replacement,
            record_facts: Vec::new(),
        }),
        hard @ (ApplyDisposition::Refused(_) | ApplyDisposition::Crashed { .. }) => hard,
    };
    outcome
}

fn map_applied_ydoc_outcome(
    outcome: ApplyOutcome<ReplicationApplyOutcome>,
    sharing_declined: Option<crate::SharingDeclined>,
    record_facts: Option<dohc_engine_domain::CollectionRecordApplyFacts>,
) -> ApplyOutcome<YdocApplyResult> {
    let mut outcome = outcome.map(|_| YdocApplyResult {
        deferred: false,
        reason: None,
        conflicts_opened: 0,
        lineage_replacement: None,
        record_facts: record_facts.into_iter().collect(),
    });
    if matches!(outcome.primary, ApplyDisposition::Applied(_))
        && let Some(declined) = sharing_declined
    {
        outcome.sharing_declined.insert(0, declined);
    }
    outcome
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
    // Identity pins (the oracle's fix-2): never write through a path occupied
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
        CollabError::OwnerOutboxFrozen => SyncError::LiveDocumentBindingActive,
        CollabError::RestoreFenced => SyncError::RetryableState {
            reason: "live document is stopped",
        },
        CollabError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

fn map_domain_payload_error(error: DomainError, reason: &'static str) -> SyncError {
    match error {
        // The one hard exception living inside `InvalidInput`: an object-alias
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
        // The acknowledged caller-mistake union. A size refusal joins
        // it for the same reason `InvalidText`/`InvalidPath` are here: only
        // `InvalidInput` is acknowledged — the apply path answers it with
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

pub(crate) fn map_domain_hard_error(error: DomainError) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard => SyncError::Storage(StorageError::corrupt_public(hard)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A receiver that holds no local snapshot or blob for the document.
    fn receiver_database() -> Connection {
        let connection = Connection::open_in_memory().expect("open empty receiver database");
        connection
            .execute_batch(
                "CREATE TABLE snapshots (workspace_id TEXT, version_id TEXT, object_id TEXT, \
                 blob_sha256 TEXT, content_kind TEXT); \
                 CREATE TABLE blobs (sha256 TEXT, text TEXT);",
            )
            .expect("create empty snapshot tables");
        connection
    }

    #[test]
    fn preserved_markdown_source_crosses_the_ydoc_update_without_a_local_blob() {
        // The settle keeps the blank lines under frontmatter, so the lexical
        // variant the projector changes sits between two body blocks.
        const ORIGINAL: &str =
            "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n\n\n**bold** _italic_ `code`";
        const RECORD_ID: &str = "01j00000000000000000000000";

        let sender = dohc_engine_collab::Ydoc::wire();
        let seed = sender
            .rewrite_content_to_markdown(ContentKind::Richdoc, ORIGINAL)
            .expect("seed sender");
        let adopted = format!("---\nid: {RECORD_ID}\n---\n\n{ORIGINAL}");
        let adoption = sender
            .frontmatter_set_preserving_markdown_source("id", RECORD_ID, &adopted)
            .expect("adopt sender");
        assert_ne!(
            sender
                .project(ContentKind::Richdoc)
                .expect("canonical sender projection")
                .content,
            adopted,
            "the regression requires lexical bytes the canonical projector changes"
        );

        let receiver = dohc_engine_collab::Ydoc::wire();
        receiver.apply(&seed).expect("apply seed on receiver");
        receiver
            .apply(&adoption)
            .expect("apply adoption on receiver");
        let connection = receiver_database();
        let key = DocKey::new("workspace", "main", "record").expect("receiver key");
        let projection =
            project_ydoc_with_store(&connection, &key, &receiver, ContentKind::Richdoc)
                .expect("project receiver without source blob");

        assert_eq!(projection.content, adopted);
    }

    #[test]
    fn stale_preserved_markdown_source_settles_from_the_current_projection() {
        const ORIGINAL: &str =
            "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n**bold** _italic_ `code`";
        const RECORD_ID: &str = "01j00000000000000000000000";

        let remote = dohc_engine_collab::Ydoc::wire();
        remote
            .rewrite_content_to_markdown(ContentKind::Richdoc, ORIGINAL)
            .expect("seed remote");
        let injected_source = format!("---\nid: {RECORD_ID}\n---\n\n{ORIGINAL}");
        remote
            .frontmatter_set_preserving_markdown_source("id", RECORD_ID, &injected_source)
            .expect("plant source metadata");
        remote
            .frontmatter_set("status", "current canonical value")
            .unwrap();

        let receiver = dohc_engine_collab::Ydoc::wire();
        receiver
            .apply(&remote.encode_full_state())
            .expect("apply remote state with stale source metadata");
        let canonical = receiver
            .project(ContentKind::Richdoc)
            .expect("current canonical projection");
        let reference = receiver
            .markdown_source_reference()
            .expect("remote source reference");
        assert_ne!(
            reference.projection_sha256,
            hex_sha256(canonical.content.as_bytes()),
            "the regression requires a projection witness stale against the document it rides in"
        );

        let connection = receiver_database();
        let key = DocKey::new("workspace", "main", "record").expect("receiver key");
        let settled = project_ydoc_with_store(&connection, &key, &receiver, ContentKind::Richdoc)
            .expect("settle receiver");

        assert_eq!(settled.content, canonical.content);
        assert_ne!(settled.content, injected_source);
    }

    #[test]
    fn planted_markdown_source_with_a_fresh_witness_settles_from_the_projection() {
        const ORIGINAL: &str =
            "\n\n| Key | Value |\n| --- | --- |\n| generated |  |\n\n**bold** _italic_ `code`";
        const RECORD_ID: &str = "01j00000000000000000000000";
        const PLANTED: &str = "---\nid: 01j00000000000000000000000\n---\n\n# bytes the canonical document never represented\n";

        let remote = dohc_engine_collab::Ydoc::wire();
        remote
            .rewrite_content_to_markdown(ContentKind::Richdoc, ORIGINAL)
            .expect("seed remote");
        // The reserved metadata rides the replicated doc, so a client-authored
        // update can write it directly: planted source bytes, their matching
        // digest, and the current canonical projection's digest. Both digest
        // checks pass; only equivalence is missing.
        remote
            .frontmatter_set_preserving_markdown_source("id", RECORD_ID, PLANTED)
            .expect("plant source metadata");

        let receiver = dohc_engine_collab::Ydoc::wire();
        receiver
            .apply(&remote.encode_full_state())
            .expect("apply remote state with planted source metadata");
        let canonical = receiver
            .project(ContentKind::Richdoc)
            .expect("current canonical projection");
        let reference = receiver
            .markdown_source_reference()
            .expect("planted source reference");
        assert_eq!(
            reference.projection_sha256,
            hex_sha256(canonical.content.as_bytes()),
            "the attack requires a projection witness fresh against the current canonical state"
        );
        assert_eq!(
            reference.source_sha256,
            hex_sha256(PLANTED.as_bytes()),
            "the attack requires a source digest matching the planted bytes"
        );

        let connection = receiver_database();
        let key = DocKey::new("workspace", "main", "record").expect("receiver key");
        let settled = project_ydoc_with_store(&connection, &key, &receiver, ContentKind::Richdoc)
            .expect("settle receiver");

        assert_eq!(settled.content, canonical.content);
        assert_ne!(settled.content, PLANTED);
    }

    #[test]
    fn preserved_markdown_source_cannot_exceed_the_text_store_cap() {
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, "body")
            .expect("seed document");
        let oversized = " ".repeat(dohc_engine_domain::MAX_TEXT_BYTES + 1);

        assert!(matches!(
            doc.frontmatter_set_preserving_markdown_source("id", "record", &oversized),
            Err(CollabError::ProjectionTooLarge { actual, max })
                if actual == dohc_engine_domain::MAX_TEXT_BYTES + 1
                    && max == dohc_engine_domain::MAX_TEXT_BYTES
        ));
    }

    #[test]
    fn workspace_ydoc_state_probe_covers_marker_and_prebase_deferred_roots() {
        let mut conn = rusqlite::Connection::open_in_memory().expect("open in-memory database");
        conn.execute_batch(
            "CREATE TABLE ydoc_docs (workspace_id TEXT NOT NULL, version_id TEXT NOT NULL); \
             CREATE TABLE ydoc_deferred_updates (workspace_id TEXT NOT NULL, version_id TEXT NOT NULL);",
        )
        .expect("create Y.Doc root tables");
        let tx = conn.transaction().expect("begin probe transaction");

        assert!(
            !workspace_has_ydoc_state_in_tx(&tx, "ws", "main").expect("empty probe"),
            "a fresh workspace version has no reconciliation work"
        );
        tx.execute(
            "INSERT INTO ydoc_docs (workspace_id, version_id) VALUES ('other', 'main')",
            [],
        )
        .expect("seed unrelated marker");
        assert!(!workspace_has_ydoc_state_in_tx(&tx, "ws", "main").expect("scoped probe"));

        tx.execute(
            "INSERT INTO ydoc_docs (workspace_id, version_id) VALUES ('ws', 'main')",
            [],
        )
        .expect("seed marker");
        assert!(workspace_has_ydoc_state_in_tx(&tx, "ws", "main").expect("marker probe"));
        tx.execute(
            "DELETE FROM ydoc_docs WHERE workspace_id='ws' AND version_id='main'",
            [],
        )
        .expect("remove marker");

        tx.execute(
            "INSERT INTO ydoc_deferred_updates (workspace_id, version_id) VALUES ('ws', 'main')",
            [],
        )
        .expect("seed pre-base deferred update");
        assert!(
            workspace_has_ydoc_state_in_tx(&tx, "ws", "main").expect("deferred probe"),
            "a deferred update is reconciliation work even without a marker"
        );
    }

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
