use dohc_engine_collab::limits::DEFAULT_COMPACTION_THRESHOLD;
use dohc_engine_collab::live_update_application::owner_activations::CURRENT_ACTIVATIONS;
use dohc_engine_collab::live_update_application::{
    IncomingCoordinate, ProtectedTails, ReleasedLineageBinding, ReleasedTails,
};
use dohc_engine_collab::{
    CollabError, CompactOutcome, ContentKind, DocKey, RemoteAppendProbe, RemoteUpdate,
    ReplicationApplyOutcome, WriterDocCache, apply_remote_update_in_transaction_with_projection,
    apply_remote_update_with_guard, maybe_compact,
};
use dohc_engine_domain::{
    ConflictFileState, DomainError, WriteText, enqueue_write, select_snapshot_by_path_in_tx,
    write_projected_text_in_tx,
};
use dohc_engine_storage::text;
use dohc_engine_storage::{
    EngineStore, FaultInjector, Preimage, StorageError, TxnOutcome, get_binary_blob, hex_sha256,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use std::sync::Arc;

use dohc_engine_files::{
    PathClassification, classify_engine_file_path_normalized, search_policy::SearchPolicySnapshot,
};

use crate::error::local_corruption;
use crate::file_search::{search_policy_for_store, upsert_file_search_index};
use crate::refusal_notices::RetainedUpdateRefusal;
use crate::{ApplyDisposition, ApplyOutcome, ReplicationEnvelope, SyncError};

fn projection_too_large_reason(
    content_kind: dohc_engine_collab::ContentKind,
    constraint: &'static str,
    actual_bytes: usize,
    limit_bytes: usize,
) -> String {
    let prefix = RetainedUpdateRefusal::ProjectionTooLarge(content_kind).message_prefix();
    format!(
        "{prefix}{constraint}: limit {limit_bytes} bytes, observed at least {actual_bytes} bytes"
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
    let bound: bool = conn
        .query_row(
            &format!("SELECT {}", crate::hosted::live_bound("?1", "?2", "?3")),
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
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

/// Whether this replica keeps `payload`, an update that `key`'s bound
/// session never admitted, queued, holding its document until the binding
/// goes, instead of refusing it: a hosted replica does for an ordinary
/// update of the document's current lineage, whose content here would
/// otherwise miss it. A base of that lineage carries only what the lineage
/// started from.
fn keeps_unadmitted(
    conn: &Connection,
    key: &DocKey,
    payload: &YdocUpdatePayload,
) -> Result<bool, SyncError> {
    if payload.is_base_state || !crate::hosted::is_hosted(conn, &key.workspace_id)? {
        return Ok(false);
    }
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 \
         AND object_id=?3 AND lineage_claim_id=?4)",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            payload.lineage_claim_id
        ],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
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

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct YdocLineageReplacement {
    pub winner_lineage_claim_id: String,
    pub recovered_paths: Vec<String>,
}

/// Read-only lease seam used by sync apply to avoid mutating a lineage while
/// an interactive daemon session owns it.
pub trait LeaseProbe: Send + Sync {
    fn is_live(&self, key: &DocKey) -> bool;

    /// A live session's consumed claim. Unknown bindings hold changed artifacts.
    fn bound_claim(&self, _key: &DocKey) -> Option<String> {
        None
    }
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

    fn bound_claim(&self, key: &DocKey) -> Option<String> {
        dohc_engine_collab::LeaseRegistry::bound_claim(self, key)
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
    /// The hold the drain persisted for a queued update that could destroy
    /// work a released chain's tail retains. The update stays queued,
    /// neither applied nor refused.
    pub released_hold: Option<crate::HostedHold>,
    /// The hold the document is left with because released tails protect an
    /// archived lineage its queued updates would change. Those updates stay
    /// queued, and the binding names that lineage and the state it keeps.
    pub archived_hold: Option<crate::HostedHold>,
    /// The drain stopped at a row whose decision waits for released-tail
    /// validation. Everything above is the committed prefix before it; that
    /// row and every later one stay queued. Once validation completes, the
    /// caller drains again and adds what that drain reports.
    pub waiting: Option<Box<dohc_engine_collab::live_update_application::PendingValidation>>,
    /// The head moment the drain's last projection keys: a base's own, or the
    /// final projection's, by its last projected row, once that committed. A
    /// drain of the same rows again keys the same one.
    pub(crate) projected_moment: Option<String>,
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

pub(crate) fn ydoc_conflict_coordinate_id(
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
) -> String {
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
    recovery_leases: Option<&dyn crate::LeaseProbe>,
    gate: impl FnOnce(&rusqlite::Transaction<'_>) -> Result<(), SyncError>,
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
        if let Some(leases)=recovery_leases { require_recovery_closed(tx,&key,leases)?; }
        gate(tx)?;
        // The queued row keeps the replacement its first apply derived, so a
        // drain that applied it and then waited, crashed or was cancelled
        // reports it once from the drain that removes the row.
        let replacement = (|| -> Result<Option<YdocLineageReplacement>, SyncError> {
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
        let losing_authors = if losing_projection.is_some() {
            dohc_engine_collab::author_coverage::reserved_in(tx, &key)
                .map_err(map_collab_hard_error)?.moment_json()
        } else {
            None
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
            dohc_engine_collab::author_coverage::reset_in(tx, &key, false)
                .map_err(map_collab_hard_error)?;
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
            losing_claim_id.as_deref(), losing_projection.as_deref(), losing_authors.as_deref(), last_settled_sha.as_deref(),
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
        })()?;
        park_lineage_replacement(tx, &key.workspace_id, &origin_id, origin_seq, replacement)
    })?;
    match outcome {
        TxnOutcome::Committed(replacement) => Ok(replacement),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// Keep the lineage replacement a queued base's apply derived on its queued
/// row, or, when this apply derived none because an earlier one committed,
/// answer the one that apply kept.
fn park_lineage_replacement(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    origin_id: &str,
    origin_seq: i64,
    replacement: Option<YdocLineageReplacement>,
) -> Result<Option<YdocLineageReplacement>, SyncError> {
    if let Some(replacement) = &replacement {
        tx.execute(
            "UPDATE ydoc_deferred_updates SET lineage_replacement_json=?4 \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![
                workspace_id,
                origin_id,
                origin_seq,
                serde_json::to_string(replacement).map_err(SyncError::corrupt)?
            ],
        )
        .map_err(SyncError::persist)?;
        return Ok(Some(replacement.clone()));
    }
    let parked: Option<String> = tx
        .query_row(
            "SELECT lineage_replacement_json FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![workspace_id, origin_id, origin_seq],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .flatten();
    parked
        .map(|json| {
            serde_json::from_str(&json)
                .map_err(|_| local_corruption("a parked lineage replacement is malformed"))
        })
        .transpose()
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
        drain_deferred_ydoc(store, cache, key, DeferredDrainMode::All, faults, None)?;
    complete_drain(store, drained, cleanup, faults)
}

/// What [`drain_released_holds`] did: the hold each document it examined is
/// left with, by object id, none once nothing its drain decided holds it,
/// what its drains refused, the head a drain that removed no row reports,
/// and the validation a drain waits for. What the others committed, and the
/// heads they wrote, are the drain reports their rows left.
#[derive(Default)]
pub(crate) struct ReleasedDrains {
    pub(crate) holds: std::collections::BTreeMap<String, Option<crate::HostedHold>>,
    pub(crate) refusals: Vec<crate::ReplicationRefusal>,
    pub(crate) changes: Vec<crate::MomentMaterializationChange>,
    pub(crate) waiting: Option<Box<dohc_engine_collab::live_update_application::PendingValidation>>,
}

/// Drain again each held hosted document of the scope that still has queued
/// application work, so a fresh decision admits what no longer needs
/// holding. A document whose queued updates of an archived lineage the
/// pass's inactive drain just held keeps that hold, from `archived`, and one
/// its drain frees has its archived lineages decided again. One a live
/// session holds, or whose drain stops before its held update, keeps the
/// hold its row records, marked stale, and its queued work waits.
/// Everything a drain applies is refused or materialized as any drain's is,
/// and the transaction that removes its rows writes their drain reports for
/// the pass. A drain that waits for validation stops the rest; the answer
/// carries that wait and the holds decided so far, and every drain's rows
/// stay queued for the next one to report.
pub(crate) fn drain_released_holds(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    workspace_id: &str,
    archived: &std::collections::BTreeMap<String, crate::HostedHold>,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ReleasedDrains, SyncError> {
    let keys = store.read_with(|conn| {
        conn.prepare(&format!(
            "SELECT DISTINCT u.version_id,u.object_id FROM hosted_documents d \
             JOIN hosted_replicas h ON h.workspace_id=d.workspace_id \
               AND h.scope_generation=d.scope_generation \
             JOIN ydoc_deferred_updates u ON u.workspace_id=d.workspace_id AND u.object_id=d.object_id \
             WHERE d.workspace_id=?1 AND {} AND {} ORDER BY u.object_id,u.version_id",
            crate::hosted::held_for_drain(),
            crate::hosted::OUTSTANDING_YDOC_UPDATE
        ))
        .and_then(|mut statement| {
            statement
                .query_map(
                    [workspace_id],
                    |row| {
                        Ok(DocKey {
                            workspace_id: workspace_id.to_owned(),
                            version_id: row.get(0)?,
                            object_id: row.get(1)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(SyncError::corrupt)
    })?;
    let mut result = ReleasedDrains::default();
    // A hold any version of a document leaves stands for the document.
    fn examined(
        holds: &mut std::collections::BTreeMap<String, Option<crate::HostedHold>>,
        object_id: String,
        hold: Option<crate::HostedHold>,
    ) {
        let entry = holds.entry(object_id).or_insert(None);
        if hold.is_some() {
            *entry = hold;
        }
    }
    // Each drain's rows stay queued, with what they committed, until no
    // document's drain waits: a request that never resumes, or a restart,
    // then leaves them for the next drain to report.
    let mut completed = Vec::new();
    for key in keys {
        let archived = archived.get(&key.object_id).cloned();
        if leases.is_live(&key) {
            let standing = match archived {
                Some(hold) => Some(hold),
                None => standing_released_hold(store, &key, None)?,
            };
            examined(&mut result.holds, key.object_id, standing);
            continue;
        }
        let before = drained_head(store, &key)?;
        let (mut drained, mut cleanup) =
            drain_deferred_ydoc(store, cache, &key, DeferredDrainMode::Batch, faults, None)?;
        if drained.waiting.is_some() {
            result.waiting = drained.waiting;
            return Ok(result);
        }
        let changes = drained_changes(store, &key, &drained, before.as_ref())?;
        let hold = match drained.released_hold.take().or(archived) {
            Some(hold) => Some(hold),
            None => standing_released_hold(store, &key, Some(&cleanup))?,
        };
        // A document this drain freed still holds for an archived lineage it
        // queues that released tails protect: the pass's inactive drain left
        // that lineage to the hold that stood then. The rows that drain
        // removes leave their reports as they go, so a later document's wait
        // loses none of them.
        let hold = match hold {
            Some(hold) => Some(hold),
            None => match drain_inactive_ydoc_updates(
                store,
                InactiveScope::Document(&key, &cleanup.consumed()),
                &cache.released_tails(store),
                &mut Vec::new(),
                DrainReporting::Durable,
                faults,
            ) {
                Ok(inactive) => {
                    result.refusals.extend(inactive.refusals);
                    inactive.holds.into_values().next()
                }
                Err(SyncError::ValidationPending(pending)) => {
                    result.waiting = Some(pending);
                    return Ok(result);
                }
                Err(error) => return Err(error),
            },
        };
        examined(&mut result.holds, key.object_id, hold);
        // A drain that removes no row reports only a head an earlier attempt
        // wrote, which its pending projection keeps.
        if cleanup.consumed().is_empty() {
            result.changes.extend(changes);
        } else {
            cleanup.report_durably(crate::drain_report::DrainExtras {
                conflicts_opened: drained.conflicts_opened,
                sharing_declined: std::mem::take(&mut drained.sharing_declined),
                changes,
                ..Default::default()
            });
        }
        completed.push((drained.refusals, cleanup));
    }
    for (refusals, cleanup) in completed {
        result.refusals.extend(refusals);
        result.refusals.extend(complete_deferred_ydoc_drain_cleanup(
            store, cleanup, faults,
        )?);
    }
    Ok(result)
}

/// The released hold `key`'s document is left with when a drain decided
/// nothing that holds it: the one its row records, while the queued update
/// that hold names still stands because the drain stopped before it or a
/// session keeps it, and `cleanup`, the drain's, does not remove it. Nothing
/// derived its binding again, so it claims no currency; the first drain that
/// decides that update refreshes it.
pub(crate) fn standing_released_hold(
    store: &EngineStore,
    key: &DocKey,
    cleanup: Option<&YdocDrainCleanup>,
) -> Result<Option<crate::HostedHold>, SyncError> {
    let consumed = cleanup.map_or_else(Vec::new, YdocDrainCleanup::consumed);
    Ok(store
        .read_with(|conn| {
            crate::hosted::queued_released_hold_besides(
                conn,
                &key.workspace_id,
                &key.object_id,
                &consumed,
            )
        })?
        .map(crate::HostedHold::stale))
}

/// The files a drain of `key` that did not wait changed: each side of a
/// lineage it replaced, at its recovered path, and the head it moved from
/// `before`, as [`drained_head`] read it before the drain.
pub(crate) fn drained_changes(
    store: &EngineStore,
    key: &DocKey,
    drained: &YdocDrainResult,
    before: Option<&(String, String)>,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    let mut changes = Vec::new();
    for replacement in &drained.lineage_replacements {
        for path in &replacement.recovered_paths {
            changes.push(crate::MomentMaterializationChange {
                version_id: key.version_id.clone(),
                path: path.clone(),
                operation: "write",
                content_kind: "text",
            });
        }
    }
    changes.extend(drained_head_change(
        store,
        key,
        before,
        drained.projected_moment.as_deref(),
    )?);
    Ok(changes)
}

/// `key`'s head, as its path and moment.
pub(crate) fn drained_head(
    store: &EngineStore,
    key: &DocKey,
) -> Result<Option<(String, String)>, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT path,latest_moment_id FROM snapshots \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)
    })
}

/// A write of `key`'s head once a drain moved it from `before`, or once its
/// head is `projected`, the moment the drain's own projection keys: an
/// earlier attempt of the drain may have committed it and then waited while
/// its file was written. Or while the projection that wrote it still waits
/// to be written to its file.
fn drained_head_change(
    store: &EngineStore,
    key: &DocKey,
    before: Option<&(String, String)>,
    projected: Option<&str>,
) -> Result<Option<crate::MomentMaterializationChange>, SyncError> {
    let Some((path, moment)) = drained_head(store, key)? else {
        return Ok(None);
    };
    let changed = before.is_none_or(|(_, before)| *before != moment)
        || projected == Some(moment.as_str())
        || store.read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM materialization_jobs WHERE workspace_id=?1 \
                 AND job_id='ydoc-mat_' || ?2 AND status='pending')",
                params![key.workspace_id, moment],
                |row| row.get::<_, bool>(0),
            )
            .map_err(SyncError::corrupt)
        })?;
    Ok(changed.then(|| crate::MomentMaterializationChange {
        version_id: key.version_id.clone(),
        path,
        operation: "write",
        content_kind: "text",
    }))
}

/// The drain before an envelope of `key` applies. One that waits for
/// validation answers [`SyncError::ValidationPending`]; the envelope's retry
/// drains again and reports what this one committed. In a pass, `batch`,
/// the rows it removes leave their drain reports instead, so a later op's
/// wait, an abandoned pass or a restart loses none of what they committed.
fn drain_deferred_ydoc_in_batch(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    faults: &dyn FaultInjector,
    batch: bool,
) -> Result<YdocDrainResult, SyncError> {
    let (mode, before) = if batch {
        (DeferredDrainMode::Batch, drained_head(store, key)?)
    } else {
        (DeferredDrainMode::All, None)
    };
    let (mut drained, mut cleanup) = drain_deferred_ydoc(store, cache, key, mode, faults, None)?;
    // Nothing else reports the files this drain changed: the pass reports
    // only the envelope's own, and the queued base's row keeps its
    // replacement only until the cleanup removes it.
    if batch && drained.waiting.is_none() && !cleanup.consumed().is_empty() {
        cleanup.report_durably(crate::drain_report::DrainExtras {
            conflicts_opened: std::mem::take(&mut drained.conflicts_opened),
            sharing_declined: std::mem::take(&mut drained.sharing_declined),
            changes: drained_changes(store, key, &drained, before.as_ref())?,
            ..Default::default()
        });
        drained.record_facts.clear();
    }
    let mut drained = complete_drain(store, drained, cleanup, faults)?;
    match drained.waiting.take() {
        Some(pending) => Err(SyncError::ValidationPending(pending)),
        None => Ok(drained),
    }
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
    drain_deferred_ydoc(store, cache, key, DeferredDrainMode::All, faults, None)
}

/// Run the cleanup an immediate drain owes and surface its projection refusal
/// with the drain's own refusals. A drain that waits for validation leaves
/// its committed prefix queued and answers only the wait: the next drain
/// dedupes those rows, reads their record facts back, and reports them once.
fn complete_drain(
    store: &mut EngineStore,
    mut drained: YdocDrainResult,
    cleanup: YdocDrainCleanup,
    faults: &dyn FaultInjector,
) -> Result<YdocDrainResult, SyncError> {
    if drained.waiting.is_some() {
        return Ok(YdocDrainResult {
            waiting: drained.waiting,
            ..YdocDrainResult::default()
        });
    }
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
    complete_drain_cleanup(store, cleanup, faults, None)
}

fn complete_drain_cleanup(
    store: &mut EngineStore,
    cleanup: YdocDrainCleanup,
    faults: &dyn FaultInjector,
    recovery: Option<(&DocKey, &dyn crate::LeaseProbe)>,
) -> Result<Option<crate::ReplicationRefusal>, SyncError> {
    if cleanup.coordinates.is_empty()
        && cleanup.off_head_refusals.is_empty()
        && cleanup.live_refusals.is_empty()
        && !cleanup.unadmitted
        && cleanup.projection_refusal.is_none()
        && recovery.is_none()
    {
        return Ok(None);
    }
    let cleared = store.write_with(faults, |tx| {
        if let Some((key, leases)) = recovery {
            require_recovery_closed(tx, key, leases)?;
        }
        for refusal in cleanup
            .projection_refusal
            .iter()
            .chain(&cleanup.applied_refusals)
            .chain(&cleanup.off_head_refusals)
            .chain(&cleanup.live_refusals)
        {
            crate::apply::persist_refusal(tx, refusal)?;
        }
        for refusal in &cleanup.live_refusals {
            retain_refused_ydoc_blob(tx, &refusal.workspace_id, &refusal.origin_id, refusal.origin_seq)?;
        }
        if cleanup.unadmitted {
            crate::hosted::hold_unadmitted_in_tx(tx, &cleanup.key.workspace_id, &cleanup.key.object_id)?;
        }
        let consumed = cleanup.consumed();
        let workspace_id = &cleanup.key.workspace_id;
        if let Some(extras) = &cleanup.report {
            crate::drain_report::record_in_tx(tx, workspace_id, &consumed, extras)?;
        }
        let removed = !consumed.is_empty();
        if let Some((key, lineage)) = &cleanup.projected
            && !cleanup.applied_refusals.is_empty()
        {
            crate::refusal_notices::clear_lineage_in_tx(
                tx,
                &key.workspace_id,
                &key.version_id,
                &key.object_id,
                lineage,
            )?;
        }
        for (origin_id, origin_seq) in consumed {
            tx.execute(
                "DELETE FROM ydoc_deferred_updates \
                 WHERE workspace_id = ?1 AND origin_id = ?2 AND origin_seq = ?3",
                params![workspace_id, origin_id, origin_seq],
            )
            .map_err(SyncError::persist)?;
        }
        // A pending artifact the document settled while these rows stood
        // clears once they go.
        if removed {
            crate::moment_apply::open_artifacts::clear_settled_mark_in_tx(tx, &cleanup.key)?;
        }
        // Recovery a released hold stopped did not fail.
        if let Some((key, _)) = recovery {
            let (waiting, path): (bool, Option<String>) = tx.query_row("SELECT settle_prior_update_seq IS NOT NULL,path FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id],|row|Ok((row.get(0)?,row.get(1)?))).map_err(SyncError::corrupt)?;
            if !waiting {
                crate::moment_apply::open_artifacts::clear_settled_mark_in_tx(tx,key)?;
                crate::moment_apply::open_artifacts::remember_attempt_in_tx(tx,key)?;
                let pending_artifact: bool = !cleanup.released_hold && tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM ydoc_pending_artifacts WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
                    params![key.workspace_id,key.version_id,key.object_id], |row|row.get(0),
                ).map_err(SyncError::corrupt)?;
                if pending_artifact {
                    // Its file is written, or still to be, even while
                    // unrelated rows stay queued and keep its mark.
                    let owed: bool = tx.query_row(
                        "SELECT NOT EXISTS(SELECT 1 FROM materialization_jobs WHERE workspace_id=?1 AND target_path=?2 AND status='pending') \
                         AND NOT EXISTS(SELECT 1 FROM ydoc_docs d JOIN snapshots s ON s.workspace_id=d.workspace_id \
                           AND s.version_id=d.version_id AND s.object_id=d.object_id AND s.blob_sha256=d.last_settled_sha \
                           WHERE d.workspace_id=?1 AND d.version_id=?3 AND d.object_id=?4 AND d.settled_update_seq=d.head_update_seq)",
                        params![key.workspace_id,path,key.version_id,key.object_id], |row|row.get(0),
                    ).map_err(SyncError::corrupt)?;
                    if owed {
                        crate::moment_apply::open_artifacts::record_recovery_failure_in_tx(tx,key)?;
                    }
                }
            }
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
        None,
    )?;
    complete_drain(store, drained, cleanup, faults)
}

/// The drain of `key` once its session ended unpublished, holding its
/// cleanup for [`complete_ended_session_cleanup`]. One that waits for
/// validation leaves its rows queued and owes no cleanup.
pub(crate) fn drain_ended_session_holding_cleanup(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    leases: &dyn crate::LeaseProbe,
    faults: &dyn FaultInjector,
) -> Result<(YdocDrainResult, YdocDrainCleanup), SyncError> {
    let checked = store.write_with(faults, |tx| {
        require_recovery_closed(tx, key, leases)?;
        let now_ms: i64 = tx.query_row("SELECT updated_at_ms FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",params![key.workspace_id,key.version_id,key.object_id],|row|row.get(0)).map_err(SyncError::corrupt)?;
        dohc_engine_collab::author_coverage::reconcile_in(tx,key,now_ms).map_err(map_collab_hard_error)?;
        Ok::<_,SyncError>(())
    })?;
    if matches!(checked, TxnOutcome::Crashed { .. }) {
        return Err(SyncError::FaultCrash);
    }
    drain_deferred_ydoc(
        store,
        cache,
        key,
        DeferredDrainMode::All,
        faults,
        Some(leases),
    )
}

/// The cleanup [`drain_ended_session_holding_cleanup`] held for `key`, run
/// with the recovery's own bookkeeping, and the projection refusal it
/// persisted. Recovery that waits runs none, so it remembers no attempt and
/// runs again.
pub(crate) fn complete_ended_session_cleanup(
    store: &mut EngineStore,
    key: &DocKey,
    leases: &dyn crate::LeaseProbe,
    cleanup: YdocDrainCleanup,
    faults: &dyn FaultInjector,
) -> Result<Option<crate::ReplicationRefusal>, SyncError> {
    complete_drain_cleanup(store, cleanup, faults, Some((key, leases)))
}

fn require_recovery_closed(
    conn: &Connection,
    key: &DocKey,
    leases: &dyn crate::LeaseProbe,
) -> Result<(), SyncError> {
    if leases.is_live(key) {
        return Err(SyncError::LiveDocumentBindingActive);
    }
    let draft: bool=conn.query_row("SELECT last_local_update_seq>COALESCE(settled_update_seq,0) FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id,key.version_id,key.object_id],|row|row.get(0)).map_err(SyncError::corrupt)?;
    if draft {
        return Err(SyncError::RetryableState {
            reason: "local-document-unsettled",
        });
    }
    dohc_engine_collab::live_update_application::require_restore_open(conn, key)
        .map_err(map_collab_hard_error)
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

/// One queued update a drain replays: its coordinate, relay position (none
/// on a local or legacy row that recorded none), recording time, lineage,
/// payload and the feed it recorded.
type DeferredRow = (
    String,
    i64,
    Option<i64>,
    i64,
    String,
    YdocUpdatePayload,
    DeferredFeed,
);

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
    key: DocKey,
    coordinates: Vec<(String, i64)>,
    projection_refusal: Option<crate::ReplicationRefusal>,
    /// Refusals of rows whose bytes this drain or an earlier one applied
    /// first. Each persists as its row leaves, so until then the row keeps
    /// its facts.
    applied_refusals: Vec<crate::ReplicationRefusal>,
    /// Refusals of rows of another lineage than the head's that its archive
    /// would not take. Each persists as its row leaves.
    off_head_refusals: Vec<crate::ReplicationRefusal>,
    /// Refusals of rows a device's live session never admitted. Each
    /// persists and keeps its blob as its row leaves, so until then the row
    /// keeps the facts an earlier attempt parked on it.
    live_refusals: Vec<crate::ReplicationRefusal>,
    /// The drain stopped at a row [`keeps_unadmitted`] keeps queued, which
    /// holds its document.
    unadmitted: bool,
    /// What the rows it removes owe a pass that reports durably, with the
    /// drain's own report; `None` for a caller that reports the drain itself.
    report: Option<crate::drain_report::DrainExtras>,
    /// The document and lineage the drain's final projection wrote, which
    /// clears the lineage's notices that projection settles, as it would
    /// have for refusals persisted before it.
    projected: Option<(DocKey, String)>,
    /// The drain kept a row queued for released retained work.
    released_hold: bool,
}

impl YdocDrainCleanup {
    /// Every queued row the cleanup removes: those the drain applied or
    /// classified, then those it refused.
    pub(crate) fn consumed(&self) -> Vec<(String, i64)> {
        let refused = self
            .off_head_refusals
            .iter()
            .chain(&self.live_refusals)
            .map(|refusal| (refusal.origin_id.clone(), refusal.origin_seq));
        self.coordinates.iter().cloned().chain(refused).collect()
    }

    /// Have the cleanup write what its rows owe, with `extras`, the drain's
    /// own report, and the refusals it persists, for a pass to claim.
    pub(crate) fn report_durably(&mut self, mut extras: crate::drain_report::DrainExtras) {
        extras.refusals.extend(
            self.projection_refusal
                .iter()
                .chain(&self.applied_refusals)
                .chain(&self.off_head_refusals)
                .chain(&self.live_refusals)
                .cloned(),
        );
        self.report = Some(extras);
    }
}

/// The gate a drain runs in the transaction that would apply `row` to the
/// head's `lineage`: the binding and whether the head waits for
/// dependencies when the row must stay queued, none when it applies. A row
/// that applies while earlier ones stay held for `held` changes the head
/// that hold names, so the same transaction marks its binding stale.
#[allow(clippy::too_many_arguments)]
fn drain_gate(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    lineage: &str,
    row: &DeferredRow,
    tails: &ReleasedTails,
    incoming: Incoming<'_>,
    held: Option<&crate::HostedHold>,
) -> Result<Option<(Box<ReleasedLineageBinding>, bool)>, SyncError> {
    let (origin_id, origin_seq, relay_seq, _, _, _, feed) = row;
    let decision = drain_decision(
        tx,
        key,
        lineage,
        feed,
        origin_id,
        *origin_seq,
        *relay_seq,
        tails,
        incoming,
    )?;
    if let ReleasedDecision::Held {
        binding,
        head_pending,
    } = decision
    {
        return Ok(Some((binding, head_pending)));
    }
    if let Some(crate::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation,
        ..
    }) = held
    {
        crate::hosted::hold_released_in_tx(tx, binding, *continuation, true)?;
    }
    Ok(None)
}

/// Keep `row`, which a drain's gate held with `binding`, queued: the
/// earliest such row names the document's hold. A head with no pending
/// dependencies freezes, so nothing after the row applies; one that waits
/// for dependencies lets later rows the gate admits apply. Answers whether
/// the drain stops.
fn hold_drained_row(
    store: &mut EngineStore,
    faults: &dyn FaultInjector,
    held_rows: &mut Vec<DeferredRow>,
    released_hold: &mut Option<crate::HostedHold>,
    row: DeferredRow,
    binding: Box<ReleasedLineageBinding>,
    head_pending: bool,
) -> Result<bool, SyncError> {
    let continuation = if head_pending {
        crate::ReleasedHoldContinuation::DependencyDrain
    } else {
        crate::ReleasedHoldContinuation::Frozen
    };
    // Only a stored hold names the document's hold, so only one queues what
    // arrives behind it. A row no hosted document records stays queued for
    // the next drain to decide again.
    if held_rows.is_empty() {
        let hold = crate::HostedHold::ReleasedLineageUnsettled {
            binding,
            continuation,
            binding_stale: false,
        };
        if persist_released_hold(store, &hold, faults)? {
            *released_hold = Some(hold);
        }
    }
    held_rows.push(row);
    Ok(continuation == crate::ReleasedHoldContinuation::Frozen)
}

/// Bring the rows a drain held back to the front of its queue once a row
/// applied past them: the head they were decided against changed, so each
/// is decided again, and the earliest still held names a fresh binding.
fn requeue_held(
    queue: &mut std::collections::VecDeque<DeferredRow>,
    held_rows: &mut Vec<DeferredRow>,
    released_hold: &mut Option<crate::HostedHold>,
) {
    for row in held_rows.drain(..).rev() {
        queue.push_front(row);
        *released_hold = None;
    }
}

/// `row`, an update of a lineage that is not the head's, and each later
/// update of that lineage before the queue's next base, taken out of
/// `queue`. An archive keeps its own state, so their order against the
/// head's rows does not matter; a base can move lineages, so none passes one.
fn take_lineage_rows(
    row: DeferredRow,
    queue: &mut std::collections::VecDeque<DeferredRow>,
) -> Vec<DeferredRow> {
    let base = queue
        .iter()
        .position(|later| later.5.is_base_state)
        .unwrap_or(queue.len());
    let after = queue.split_off(base);
    let (same, other): (Vec<_>, Vec<_>) = std::mem::take(queue)
        .into_iter()
        .partition(|later| later.4 == row.4);
    queue.extend(other);
    queue.extend(after);
    let mut rows = vec![row];
    rows.extend(same);
    rows
}

fn drain_deferred_ydoc(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    key: &DocKey,
    mode: DeferredDrainMode<'_>,
    faults: &dyn FaultInjector,
    recovery_leases: Option<&dyn crate::LeaseProbe>,
) -> Result<(YdocDrainResult, YdocDrainCleanup), SyncError> {
    let tails = cache.released_tails(store);
    let idle = || {
        (
            YdocDrainResult::default(),
            YdocDrainCleanup {
                key: key.clone(),
                coordinates: Vec::new(),
                projection_refusal: None,
                applied_refusals: Vec::new(),
                off_head_refusals: Vec::new(),
                live_refusals: Vec::new(),
                unadmitted: false,
                report: None,
                projected: None,
                released_hold: false,
            },
        )
    };
    let pending: Vec<DeferredRow> =
        store.read_with(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT log.origin_id,log.origin_seq,deferred.relay_seq,log.recorded_at_ms,
                        deferred.lineage_claim_id,log.payload_json,deferred.ingress_kind,
                        deferred.relay_namespace,deferred.replication_epoch,deferred.stream_identity \
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
                            row.get::<_, Option<i64>>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            DeferredFeed {
                                ingress_kind: row.get(6)?,
                                relay_namespace: row.get(7)?,
                                replication_epoch: row.get(8)?,
                                stream_identity: row.get(9)?,
                            },
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
                    feed,
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
                    feed,
                ));
            }
            Ok::<_, SyncError>(pending)
        })?;
    if pending.is_empty() {
        return Ok(idle());
    }
    let unresolved: bool = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 \
             AND object_id=?3 AND settle_prior_update_seq IS NOT NULL)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    let materialization_pending = if unresolved {
        let reconciled = store.write_with(faults, |tx| {
            if let Some(leases) = recovery_leases {
                require_recovery_closed(tx, key, leases)?;
            }
            dohc_engine_collab::author_coverage::reconcile_in(tx, key, pending[0].3)
                .map_err(map_collab_hard_error)
        })?;
        match reconciled {
            TxnOutcome::Committed(resolved) => !resolved,
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    } else {
        false
    };
    if materialization_pending {
        // Return to the caller so settlement can replay the pending job.
        // Keep every queued coordinate until its projection can commit.
        return Ok(idle());
    }
    let search_policy = search_policy_for_store(store);
    let mut applied = 0usize;
    let mut refusals = Vec::new();
    let mut sharing_declined = Vec::new();
    let mut last_payload: Option<YdocUpdatePayload> = None;
    let mut payload_recorded_at = 0_i64;
    let mut drained_coordinates: Vec<(String, i64)> = Vec::new();
    let mut last_coordinate: Option<(String, i64)> = None;
    let mut projection_coordinates = Vec::new();
    let mut projection_authors = dohc_engine_collab::author_coverage::Authors::default();
    let mut lineage_replacements = Vec::new();
    let mut conflicts_opened = 0;
    let mut record_facts = Vec::new();
    let mut projection_refusal = None;
    let mut applied_refusals = Vec::new();
    let mut off_head_refusals = Vec::new();
    let mut live_refusals = Vec::new();
    let mut unadmitted = false;
    let mut projected_lineage = None;
    let mut projected_moment = None;
    // Rows held for released retained work while the head waits for
    // dependencies, earliest first. Each stays queued, and each row applied
    // past them brings them back to be decided against the new head.
    let mut held_rows: Vec<DeferredRow> = Vec::new();
    let mut released_hold = None;
    let mut archived_hold = None;
    // Whether released tails keep an archived lineage's rows queued.
    let mut archived_held = false;
    let mut waiting = None;
    let mut queue: std::collections::VecDeque<DeferredRow> = pending.into();
    while let Some(row) = queue.pop_front() {
        let (origin_id, origin_seq, relay_seq, recorded_at_ms, lineage_claim_id, payload, _) =
            row.clone();
        if let Some(leases) = recovery_leases {
            store.read_with(|conn| require_recovery_closed(conn, key, leases))?;
        }
        if !payload.is_base_state
            && !matches!(mode, DeferredDrainMode::Live(_))
            && store.read_with(|conn| inactive_lineage_exists(conn, key, &lineage_claim_id))?
        {
            // A batch drain leaves archived lineages to its pass's inactive
            // drain. Any other takes this lineage's queued updates together.
            if matches!(mode, DeferredDrainMode::All) {
                let rows = take_lineage_rows(row, &mut queue);
                match drain_off_head_rows(
                    store,
                    key,
                    &rows,
                    &tails,
                    search_policy.as_ref(),
                    faults,
                    recovery_leases,
                    &drained_coordinates,
                ) {
                    Ok(off_head) => {
                        drained_coordinates.extend(off_head.drained);
                        refusals.extend(off_head.refused.iter().cloned());
                        off_head_refusals.extend(off_head.refused);
                        record_facts.extend(off_head.record_facts);
                        archived_held |= off_head.held;
                        archived_hold = archived_hold.or(off_head.hold);
                    }
                    Err(SyncError::ValidationPending(pending)) => {
                        waiting = Some(pending);
                        break;
                    }
                    Err(error) => return Err(error),
                }
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
            let parked = parked_refusal(store, key, &origin_id, origin_seq)?;
            // What follows it stays queued too.
            if !echo
                && parked.is_none()
                && store.read_with(|conn| keeps_unadmitted(conn, key, &payload))?
            {
                unadmitted = true;
                break;
            }
            record_facts.extend(read_parked_record_facts(
                store, key, &origin_id, origin_seq,
            )?);
            // A refused row leaves with the cleanup, as an applied one does,
            // so a drain that waits first keeps it and what it parked. One
            // whose bytes an earlier drain applied keeps the refusal that
            // apply was owed: a session that later binds neither replaces
            // nor discharges it, and the head already holds those bytes.
            match parked {
                Some(reason) => {
                    let refusal = deferred_ydoc_refusal(key, &origin_id, origin_seq, reason);
                    refusals.push(refusal.clone());
                    applied_refusals.push(refusal);
                    drained_coordinates.push((origin_id, origin_seq));
                }
                None if echo => drained_coordinates.push((origin_id, origin_seq)),
                None => {
                    let refusal =
                        deferred_ydoc_refusal(key, &origin_id, origin_seq, LIVE_UNADMITTED_UPDATE);
                    refusals.push(refusal.clone());
                    live_refusals.push(refusal);
                }
            }
            continue;
        }
        if payload.is_base_state {
            // A base claims its lineage at its relay position, so one that
            // recorded none waits, as a pulled base with none does.
            let Some(relay_seq) = relay_seq else {
                return Err(SyncError::RetryableState {
                    reason: "a queued ydoc base is missing its relay sequence",
                });
            };
            // A base can replace the lineage while reusing durable coordinates.
            // Evict before the transaction so a committed crash cannot leave an
            // ABA-valid entry behind.
            cache.remove(key);
            if lineage_claim_id != payload.update_blob_sha256 {
                return Err(local_corruption(
                    "parked Y.Doc base claim does not match its full-state digest",
                ));
            }
            let head_pending = std::cell::Cell::new(false);
            let held = held_rows.first().and(released_hold.as_ref());
            let based = apply_deferred_base(
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
                recovery_leases,
                |tx| {
                    let lineage = dohc_engine_collab::read_marker_in(tx, key)
                        .map_err(map_collab_hard_error)?
                        .and_then(|marker| marker.lineage_claim_id);
                    let Some(lineage) = lineage else {
                        return Ok(());
                    };
                    match drain_gate(tx, key, &lineage, &row, &tails, Incoming::Replacement, held)?
                    {
                        None => Ok(()),
                        Some((binding, pending)) => {
                            head_pending.set(pending);
                            Err(SyncError::ReleasedLineageUnsettled(binding))
                        }
                    }
                },
            );
            match based {
                Err(SyncError::ReleasedLineageUnsettled(binding)) => {
                    if hold_drained_row(
                        store,
                        faults,
                        &mut held_rows,
                        &mut released_hold,
                        row,
                        binding,
                        head_pending.get(),
                    )? {
                        break;
                    }
                    continue;
                }
                Ok(replacement) => lineage_replacements.extend(replacement),
                Err(SyncError::ValidationPending(pending)) => {
                    waiting = Some(pending);
                    break;
                }
                Err(error) => return Err(error),
            }
            requeue_held(&mut queue, &mut held_rows, &mut released_hold);
            // A base writes the head itself, keyed by its own coordinate.
            let moment = ydoc_apply_moment_id(key, &payload.path, &origin_id, origin_seq);
            projected_moment = Some(moment);
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
        // A lineage that lost arbitration keeps nothing of its rows; one
        // archived since the row was checked above takes them as its archive
        // does. Later rows of the head's lineage go on either way.
        if lineage_claim_id != winner_claim_id {
            let rows = take_lineage_rows(row, &mut queue);
            match drain_off_head_rows(
                store,
                key,
                &rows,
                &tails,
                search_policy.as_ref(),
                faults,
                recovery_leases,
                &drained_coordinates,
            ) {
                Ok(off_head) => {
                    drained_coordinates.extend(off_head.drained);
                    refusals.extend(off_head.refused.iter().cloned());
                    off_head_refusals.extend(off_head.refused);
                    record_facts.extend(off_head.record_facts);
                    archived_held |= off_head.held;
                    archived_hold = archived_hold.or(off_head.hold);
                }
                Err(SyncError::ValidationPending(pending)) => {
                    waiting = Some(pending);
                    break;
                }
                Err(error) => return Err(error),
            }
            continue;
        }
        let established_kind = dohc_engine_collab::read_marker(store, key)
            .map_err(map_collab_hard_error)?
            .map(|marker| marker.content_kind);
        let content_kind_refusal =
            match dohc_engine_collab::ContentKind::parse(&payload.content_kind) {
                Ok(payload_kind) if established_kind.is_some_and(|kind| kind != payload_kind) => {
                    Some(RetainedUpdateRefusal::ContentKindMismatch.message_prefix())
                }
                Ok(_) => None,
                Err(_) => Some(RetainedUpdateRefusal::InvalidContentKind.message_prefix()),
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
        let mut candidate_authors = dohc_engine_collab::author_coverage::Authors::default();
        candidate_authors
            .union_json(&projection_authors.json())
            .map_err(map_collab_hard_error)?;
        candidate_authors
            .union_json(
                &store
                    .read_with(|conn| {
                        crate::live_audit::drained_coordinate_authors(
                            conn,
                            key,
                            &payload.path,
                            &origin_id,
                            origin_seq,
                        )
                    })?
                    .json(),
            )
            .map_err(map_collab_hard_error)?;
        if !projection_coordinates.is_empty() {
            // Stop before accepting bytes whose combined projection cannot name
            // all contributors, including a missing audit's coverage marker.
            let mut covered = store.read_with(|conn| {
                dohc_engine_collab::author_coverage::reserved_in(conn, key)
                    .map_err(map_collab_hard_error)
            })?;
            covered
                .union_json(&candidate_authors.json())
                .map_err(map_collab_hard_error)?;
            if let Some(author) = dohc_engine_domain::moment_author_json(
                payload.actor_origin_id.as_deref(),
                payload.attribution.as_ref(),
            ) {
                covered.union_json(&author).map_err(map_collab_hard_error)?;
            }
            if covered.len() > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHORS
                || covered.journal_bytes()
                    > dohc_engine_collab::author_coverage::MAX_INTERVAL_AUTHOR_BYTES
            {
                break;
            }
        }
        let refusal = content_kind_refusal.or(identity_refusal);
        let remote = RemoteUpdate {
            origin_id: origin_id.clone(),
            origin_seq,
            bytes,
        };
        // What the gate decided when it kept the row out of the head.
        let gated = std::cell::Cell::new(None);
        let held = held_rows.first().and(released_hold.as_ref());
        let apply_result = apply_remote_update_with_guard(
            store,
            cache,
            key,
            &remote,
            payload.actor_origin_id.as_deref(),
            payload.attribution.as_ref(),
            faults,
            recorded_at_ms,
            |tx| {
                if recovery_leases.is_some_and(|leases| leases.is_live(key)) {
                    return Err(CollabError::LeaseHeld);
                }
                let incoming = Incoming::Update {
                    bytes: &remote.bytes,
                    path: &payload.path,
                };
                match drain_gate(tx, key, &winner_claim_id, &row, &tails, incoming, held) {
                    // The refusal its bytes are owed commits with them, so a
                    // route that takes the row after its lineage changes
                    // reports it as it was.
                    Ok(None) => {
                        if let Some(reason) = refusal {
                            tx.execute(
                                "UPDATE ydoc_deferred_updates \
                                 SET applied_refusal=COALESCE(applied_refusal,?4) \
                                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                                params![key.workspace_id, origin_id, origin_seq, reason],
                            )
                            .map_err(StorageError::persist_public)?;
                        }
                        Ok(())
                    }
                    decided => {
                        gated.set(Some(decided));
                        Err(CollabError::LeaseHeld)
                    }
                }
            },
        );
        if let Some(decided) = gated.take() {
            let decided = match decided {
                Err(SyncError::ValidationPending(pending)) => {
                    waiting = Some(pending);
                    break;
                }
                decided => decided?,
            };
            let (binding, head_pending) = decided
                .ok_or_else(|| local_corruption("a drain's gate kept out a row it admitted"))?;
            if hold_drained_row(
                store,
                faults,
                &mut held_rows,
                &mut released_hold,
                row,
                binding,
                head_pending,
            )? {
                break;
            }
            continue;
        }
        let (outcome, applied_facts) = match apply_result {
            Ok(applied) => (applied.outcome, applied.record_facts),
            Err(CollabError::LeaseHeld) if recovery_leases.is_some() => {
                return Err(SyncError::LiveDocumentBindingActive);
            }
            Err(error) => {
                match map_collab_payload_error(error, "parked ydoc.update could not be applied") {
                    SyncError::InvalidInput { reason } => {
                        refusals.push(refuse_deferred_ydoc(
                            store, key, &origin_id, origin_seq, reason, faults,
                        )?);
                        continue;
                    }
                    SyncError::RetryableState {
                        reason: "ydoc-author-capacity",
                    } => break,
                    hard => return Err(hard),
                }
            }
        };
        let replayed = match outcome {
            TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. }) => {
                applied += 1;
                requeue_held(&mut queue, &mut held_rows, &mut released_hold);
                false
            }
            TxnOutcome::Committed(ReplicationApplyOutcome::Deduped { .. }) => true,
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        };
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
        // Even a refused projection can contribute bytes to the final CRDT.
        projection_authors = candidate_authors;
        projection_coordinates.push((origin_id.clone(), origin_seq));
        // A replay keeps the refusal its first apply was owed.
        let refusal = if replayed {
            parked_refusal(store, key, &origin_id, origin_seq)?.or(refusal.map(str::to_owned))
        } else {
            refusal.map(str::to_owned)
        };
        if let Some(reason) = refusal {
            // The CRDT bytes landed even though the established path identity
            // forbids projection. Count the coordinate as drained: a live
            // client's doc has not integrated these bytes, so settle must
            // force a resync instead of materializing unseen remote content.
            // Its already-ACKed queue row becomes a refusal in the cleanup,
            // so a drain that stops first leaves it, and its facts, queued.
            let refusal = deferred_ydoc_refusal(key, &origin_id, origin_seq, reason);
            refusals.push(refusal.clone());
            applied_refusals.push(refusal);
            drained_coordinates.push((origin_id, origin_seq));
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
    // path; skipped while cross-origin dependencies are still pending. A
    // drain that waits projects nothing: its applied rows stay queued, and
    // the drain that removes them projects and reports the head once.
    let (drain_origin, drain_seq) = match &last_coordinate {
        Some((origin, seq)) => (origin.as_str(), *seq),
        None => ("deferred-drain", payload_recorded_at),
    };
    if waiting.is_none()
        && let Some(payload) = last_payload
        && let Some((projected, projected_kind)) = project_final_drained_doc(
            store,
            cache,
            key,
            &payload,
            drain_origin,
            drain_seq,
            &projection_coordinates,
            payload_recorded_at,
            search_policy.as_ref(),
            faults,
            recovery_leases,
        )?
    {
        if let Ok(TxnOutcome::Committed(_)) = &projected {
            projected_lineage = dohc_engine_collab::read_marker(store, key)
                .map_err(map_collab_hard_error)?
                .and_then(|marker| marker.lineage_claim_id)
                .map(|lineage| (key.clone(), lineage));
            let moment = ydoc_apply_moment_id(key, &payload.path, drain_origin, drain_seq);
            projected_moment = Some(moment);
        }
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
            Err(SyncError::InvalidInput { .. }) if recovery_leases.is_none() => {}
            // A measured size rejection is also terminal, but unlike an
            // identity pin it must stay visible to the peer. Persist it against
            // the last coordinate whose accepted bytes made this projection
            // too large before the queue cleanup below consumes the marker.
            Err(error @ SyncError::ProjectionTooLarge { .. }) if recovery_leases.is_some() => {
                return Err(error);
            }
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
            released_hold,
            archived_hold,
            waiting,
            projected_moment,
        },
        YdocDrainCleanup {
            key: key.clone(),
            coordinates: drained_coordinates,
            projection_refusal,
            applied_refusals,
            off_head_refusals,
            live_refusals,
            unadmitted,
            report: None,
            projected: projected_lineage,
            released_hold: !held_rows.is_empty() || archived_held,
        },
    ))
}

/// Whether a queued update of `key` already opened a conflict: a drain
/// applied it and stopped before removing its row, so the next drain still
/// owes that drain's report.
pub fn deferred_ydoc_opened_conflict(conn: &Connection, key: &DocKey) -> Result<bool, SyncError> {
    let mut statement = conn
        .prepare(
            "SELECT origin_id,origin_seq FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        )
        .map_err(SyncError::corrupt)?;
    let coordinates = statement
        .query_map(
            params![key.workspace_id, key.version_id, key.object_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(SyncError::corrupt)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(SyncError::corrupt)?;
    for (origin_id, origin_seq) in coordinates {
        let opened: Option<String> = conn
            .query_row(
                "SELECT payload_hash FROM engine_requests \
                 WHERE request_id=?1 AND kind='sync-ydoc-conflict'",
                [ydoc_conflict_coordinate_id(
                    &key.workspace_id,
                    &origin_id,
                    origin_seq,
                )],
                |row| row.get(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        if opened.is_some_and(|count| count != "0") {
            return Ok(true);
        }
    }
    Ok(false)
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
    json.as_deref().map(parse_parked_record_facts).transpose()
}

/// The refusal a drain owed this parked coordinate when it applied its bytes
/// to the head: its path or content kind was not the head's. `None` for one
/// that applied without one.
fn parked_refusal(
    store: &EngineStore,
    key: &DocKey,
    origin_id: &str,
    origin_seq: i64,
) -> Result<Option<String>, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT applied_refusal FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![key.workspace_id, origin_id, origin_seq],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)
        .map(Option::flatten)
    })
}

pub(crate) fn parse_parked_record_facts(
    json: &str,
) -> Result<dohc_engine_domain::CollectionRecordApplyFacts, SyncError> {
    serde_json::from_str(json)
        .map_err(|_| local_corruption("parked ydoc.update record facts are malformed"))
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
    projection_coordinates: &[(String, i64)],
    payload_recorded_at: i64,
    search_policy: Option<&SearchPolicySnapshot>,
    faults: &dyn FaultInjector,
    recovery_leases: Option<&dyn crate::LeaseProbe>,
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
            projection_coordinates,
            payload_recorded_at,
            search_policy,
            faults,
            recovery_leases,
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
        projection_coordinates,
        payload_recorded_at,
        search_policy,
        faults,
        recovery_leases,
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
    projection_coordinates: &[(String, i64)],
    payload_recorded_at: i64,
    search_policy: Option<&SearchPolicySnapshot>,
    faults: &dyn FaultInjector,
    recovery_leases: Option<&dyn crate::LeaseProbe>,
) -> Result<TxnOutcome<crate::BaseOrigination>, SyncError> {
    store.write_with(faults, |tx| {
        if let Some(leases) = recovery_leases {
            require_recovery_closed(tx, key, leases)?;
        }
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
        if projection_coordinates.len() > 1 {
            crate::live_audit::annotate_drained_projection_in_tx(
                tx,
                key,
                &payload.path,
                drain_origin,
                drain_seq,
                projection_coordinates,
            )?;
        }
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
pub(crate) fn ydoc_apply_moment_id(
    key: &DocKey,
    path: &str,
    origin_id: &str,
    origin_seq: i64,
) -> String {
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

/// A destructive History restore must account for canonical live state, not
/// only the file snapshot. Drafts can hold edits with no later History moment.
pub fn current_ydoc_content_matches_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    expected_sha256: &str,
) -> Result<bool, SyncError> {
    ensure_adopted_owner_binding_unchanged(tx, key, None)?;
    require_unfenced_lineage(tx, key).map_err(|error| match error {
        SyncError::InvalidInput {
            reason: "live document is stopped",
        } => SyncError::LiveDocumentBindingActive,
        other => other,
    })?;
    let complete = match ydoc_lineage_completeness_in_tx(tx, key)? {
        YdocLineageCompleteness::Complete(state) => state,
        YdocLineageCompleteness::DeferredUpdates | YdocLineageCompleteness::PendingDependencies => {
            return Ok(false);
        }
    };
    // A retained outbox can outlive its adopted binding. The descriptor only
    // sees the current binding, so also inspect the durable recovery rows.
    let (has_outbox, unsettled_outbox): (bool, bool) = tx.query_row(
        "SELECT count(*)>0, COALESCE(max(pending_bytes>0 OR state!='active' OR current_path!=?4),0) \
         FROM owner_ydoc_outboxes WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id, path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(SyncError::corrupt)?;
    if unsettled_outbox {
        return Ok(false);
    }
    let draft = dohc_engine_collab::owner_outbox::draft::descriptor_for_key_in(tx, key)
        .map_err(SyncError::corrupt)?;
    if let Some(draft) = draft.as_ref()
        && (draft.pending_bytes > 0
            || draft.binding.current_path != path
            || draft
                .state
                .as_deref()
                .is_some_and(|state| state != "active"))
    {
        return Ok(false);
    }
    let Some((marker, doc)) = complete else {
        return Ok(draft.is_none() && !has_outbox);
    };
    let settled: bool = tx
        .query_row(
            "SELECT settled_update_seq IS head_update_seq AND settle_prior_update_seq IS NULL FROM ydoc_docs \
         WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !settled || marker.path.as_deref() != Some(path) {
        return Ok(false);
    }
    let projection = project_ydoc_with_store(tx, key, &doc, marker.content_kind)?;
    Ok(dohc_engine_storage::hex_sha256(projection.content.as_bytes()) == expected_sha256)
}

pub(crate) struct CompleteYdocLineage {
    key: DocKey,
    state: Option<(dohc_engine_collab::Marker, dohc_engine_collab::Ydoc)>,
}

/// A complete lineage and its pre-mutation projection, reused by capture's fold
/// in the same writer transaction. Preparation does not change durable state.
pub struct PreparedLocalYdocLineage {
    complete: CompleteYdocLineage,
    projection: Option<dohc_engine_collab::Projection>,
    reader_delta: Option<Vec<u8>>,
}

impl PreparedLocalYdocLineage {
    pub fn accept_outside_fold(
        &mut self,
        conn: &Connection,
        fold: &dohc_engine_collab::reader_resolver::PreparedFold,
        source: &str,
    ) -> Result<(), SyncError> {
        let Some((marker, doc)) = self.complete.state.as_ref() else {
            return Ok(());
        };
        if !fold.matches(&self.complete.key, marker, doc, source) {
            return Err(SyncError::RetryableState {
                reason: "outside-fold-stale",
            });
        }
        if let Ok(candidate) = doc.native_fold_candidate(&fold.delta) {
            let projection = match project_ydoc_with_store(
                conn,
                &self.complete.key,
                &candidate,
                ContentKind::Richdoc,
            ) {
                Ok(projection) => projection,
                Err(SyncError::InvalidInput { .. } | SyncError::ProjectionTooLarge { .. }) => {
                    return Ok(());
                }
                Err(error) => return Err(error),
            };
            if projection.content == source {
                self.reader_delta = Some(fold.delta.clone());
            }
        }
        Ok(())
    }
    pub fn projection(&self) -> Option<&dohc_engine_collab::Projection> {
        self.projection.as_ref()
    }
}

pub fn prepare_local_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<PreparedLocalYdocLineage, SyncError> {
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, key)?;
    let projection = match complete.state.as_ref() {
        Some((marker, doc)) if lineage_has_content(marker) => {
            Some(project_ydoc_with_store(tx, key, doc, marker.content_kind)?)
        }
        _ => None,
    };
    Ok(PreparedLocalYdocLineage {
        complete,
        projection,
        reader_delta: None,
    })
}

/// What capture does with its prepared lineage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureLineage {
    /// Fold the captured file into the lineage as ever.
    Fold,
    /// The file holds the bytes capture last recorded, over a released
    /// chain's tail: keep the lineage as it is and write nothing.
    KeepTail,
}

/// Decide, before capture ingests `text` at `path`, what it does with the
/// prepared lineage. An adopted owner, in any relay and on any lineage of
/// the document, refuses every rewrite of it, so a file that differs from
/// the Y.Doc refuses here before any other branch. A lineage a released
/// chain left with no current activation folds only as
/// [`released_capture`](dohc_engine_collab::live_update_application::released_capture)
/// allows. Each refusal leaves the capture to roll back.
pub fn admit_capture_in_tx(
    tx: &rusqlite::Transaction<'_>,
    prepared: &PreparedLocalYdocLineage,
    path: &str,
    text: &str,
) -> Result<CaptureLineage, SyncError> {
    use dohc_engine_collab::live_update_application::{
        ApplicationError, RELEASED_CAPTURE_PROOF_BYTES, ReleasedCapture, released_capture,
    };
    let key = &prepared.complete.key;
    let Some((marker, head)) = prepared.complete.state.as_ref() else {
        return Ok(CaptureLineage::Fold);
    };
    if dohc_engine_collab::owner_outbox::has_adopted_owner_in(tx, key)
        .map_err(map_collab_hard_error)?
    {
        if prepared
            .projection
            .as_ref()
            .is_some_and(|projection| projection.content != text)
        {
            return Err(SyncError::LiveDocumentBindingActive);
        }
        return Ok(CaptureLineage::Fold);
    }
    let Some(lineage) = marker.lineage_claim_id.as_deref() else {
        return Ok(CaptureLineage::Fold);
    };
    match released_capture(
        tx,
        key,
        lineage,
        path,
        text,
        head,
        RELEASED_CAPTURE_PROOF_BYTES,
    ) {
        Ok(ReleasedCapture::Ordinary) => Ok(CaptureLineage::Fold),
        Ok(ReleasedCapture::Unchanged) => Ok(CaptureLineage::KeepTail),
        Err(ApplicationError::Storage(error)) => Err(SyncError::Storage(error)),
        Err(_) => Err(SyncError::RetryableState {
            reason: "ydoc-released-capture-unproven",
        }),
    }
}

/// What a synced row would do to the head's lineage.
pub(crate) enum Incoming<'a> {
    /// A base state, a delta of another lineage, an imported delete, rename
    /// or binary write, or a text write whose head is not the lineage's yet:
    /// never an ordinary update.
    Replacement,
    /// An imported text write that settles the head at `path`, a replacement
    /// when that moves the document off its binding.
    Write { path: &'a str },
    /// An ordinary update at `path`.
    Update { bytes: &'a [u8], path: &'a str },
}

/// Hold `op` while a released chain's tail protects the head's `lineage` and
/// the row could destroy what the tail retains: any replacement, a write that
/// moves the document, and an update that lands off the tail's binding or
/// that structural inspection does not admit. The hold carries the binding
/// and records no refusal. A row the tail admits returns the binding it was
/// admitted under. `relay_namespace` is the feed's, as the pull's trusted
/// configuration names it, and `tails` keeps the tails the actor validated.
#[allow(clippy::too_many_arguments)]
fn hold_released_lineage(
    tx: &rusqlite::Connection,
    key: &DocKey,
    lineage: &str,
    op: &ReplicationEnvelope,
    relay_seq: Option<i64>,
    relay_namespace: Option<&str>,
    tails: &ReleasedTails,
    incoming: Incoming<'_>,
) -> Result<Option<Box<ReleasedLineageBinding>>, SyncError> {
    let (coordinate, identified, unrecorded) =
        ingress_coordinate(tx, key, op, relay_seq, relay_namespace)?;
    // Retained work whose feed was never recorded holds a protected lineage
    // whatever it does, as a queued Y.Doc row with none does.
    let incoming = if unrecorded {
        Incoming::Replacement
    } else {
        incoming
    };
    let decision = released_decision(tx, key, lineage, &coordinate, tails, incoming)?;
    if matches!(decision, ReleasedDecision::Unprotected) {
        return Ok(None);
    }
    bindable(identified, coordinate.relay_seq)?;
    match decision {
        ReleasedDecision::Held { binding, .. } => Err(SyncError::ReleasedLineageUnsettled(binding)),
        ReleasedDecision::Admitted(binding) => Ok(Some(binding)),
        ReleasedDecision::Unprotected => Ok(None),
    }
}

/// The coordinate an incoming `op` names on the feed `relay_namespace`
/// names, whether the replica has a sync identity, and whether `op` is
/// retained work whose feed was never recorded, which names no namespace. A
/// relay position below 1 is none.
fn ingress_coordinate(
    tx: &rusqlite::Connection,
    key: &DocKey,
    op: &ReplicationEnvelope,
    relay_seq: Option<i64>,
    relay_namespace: Option<&str>,
) -> Result<(IncomingCoordinate, bool, bool), SyncError> {
    let identity: Option<(String, String)> = tx
        .query_row(
            "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
            [&key.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let identified = identity.is_some();
    let (replication_epoch, stream_identity) = identity.unwrap_or_default();
    let unrecorded = retained_unrecorded(tx, op)?;
    let coordinate = IncomingCoordinate {
        relay_namespace: relay_namespace.filter(|_| !unrecorded).map(str::to_owned),
        replication_epoch,
        stream_identity,
        origin_id: op.origin_id.clone(),
        origin_seq: op.origin_seq,
        relay_seq: relay_seq.filter(|seq| *seq > 0).unwrap_or_default(),
    };
    Ok((coordinate, identified, unrecorded))
}

/// Hold `op`, an update of `key`'s archived `lineage`, while released tails
/// protect that lineage, decided from the tails alone. Any update changes
/// the state the archive keeps, so none is inspected. It is neither
/// acknowledged nor queued: its document's read stops before it, as at a
/// frozen hold, with a binding of the lineage and that state. While the
/// document's hold names a queued update of the same lineage and still
/// describes it, that binding answers, so the update and the queued rows
/// hold the document alike.
fn hold_archived_lineage(
    tx: &rusqlite::Connection,
    key: &DocKey,
    lineage: &str,
    op: &ReplicationEnvelope,
    relay_seq: Option<i64>,
    relay_namespace: Option<&str>,
    tails: &ReleasedTails,
) -> Result<(), SyncError> {
    let Some(protected) = archived_protection(tx, key, lineage, tails)? else {
        return Ok(());
    };
    let standing = crate::hosted::queued_released_hold(tx, &key.workspace_id, &key.object_id)?;
    if let Some(crate::HostedHold::ReleasedLineageUnsettled { binding, .. }) = standing
        && binding.main_version_id == key.version_id
        && binding.lineage_claim_id == lineage
        && released_binding_current(tx, &binding, tails)?
    {
        return Err(SyncError::ReleasedLineageUnsettled(binding));
    }
    let (coordinate, identified, _) = ingress_coordinate(tx, key, op, relay_seq, relay_namespace)?;
    bindable(identified, coordinate.relay_seq)?;
    Err(SyncError::ReleasedLineageUnsettled(archived_binding(
        tx, key, lineage, coordinate, protected,
    )?))
}

/// What released protection decides for a synced row.
enum ReleasedDecision {
    /// No released tail protects the head's lineage.
    Unprotected,
    /// The row destroys nothing a protected tail retains.
    Admitted(Box<ReleasedLineageBinding>),
    /// The row could destroy retained work; `head_pending` says whether the
    /// head it would change waits for dependencies.
    Held {
        binding: Box<ReleasedLineageBinding>,
        head_pending: bool,
    },
}

/// Decide for the row `coordinate` names, which would change `key`'s head
/// `lineage` as `incoming` says: held when it is a replacement, a write that
/// moves the document, or an update that lands off the tail's binding or that
/// structural inspection does not admit. [`SyncError::ValidationPending`]
/// while the lineage's tails wait for validation.
fn released_decision(
    tx: &rusqlite::Connection,
    key: &DocKey,
    lineage: &str,
    coordinate: &dohc_engine_collab::live_update_application::IncomingCoordinate,
    tails: &ReleasedTails,
    incoming: Incoming<'_>,
) -> Result<ReleasedDecision, SyncError> {
    use dohc_engine_collab::live_update_application::{Protection, ProtectionKey, protection};
    let protected = protection(
        tx,
        &ProtectionKey {
            doc: key,
            lineage_claim_id: lineage,
            incoming: coordinate,
        },
        tails,
    )
    .map_err(protection_failure)?;
    let (binding, head) = match protected {
        Protection::Protected { binding, head } => (binding, head),
        Protection::Unprotected => return Ok(ReleasedDecision::Unprotected),
        Protection::Pending(pending) => return Err(SyncError::ValidationPending(pending)),
    };
    let destructive = match incoming {
        Incoming::Replacement => true,
        Incoming::Write { path } => binding.current_path.as_deref() != Some(path),
        Incoming::Update { bytes, path } => {
            let destructive = binding.moved(path)
                || dohc_engine_collab::inspect_update(&head, bytes)
                    != dohc_engine_collab::UpdateInspection::Admissible;
            // Bytes the head cannot replay are refused as anywhere else,
            // never held: the ordinary apply refuses them.
            if destructive
                && let Err(error) = dohc_engine_collab::validate_replay_parity(&head, bytes)
            {
                return match map_collab_payload_error(error, "ydoc.update fails replay parity") {
                    SyncError::InvalidInput { .. } => Ok(ReleasedDecision::Admitted(binding)),
                    hard => Err(hard),
                };
            }
            destructive
        }
    };
    Ok(if destructive {
        ReleasedDecision::Held {
            binding,
            head_pending: head.has_pending_dependencies(),
        }
    } else {
        ReleasedDecision::Admitted(binding)
    })
}

/// The feed a deferred Y.Doc update recorded when it was queued.
#[derive(Debug, Clone)]
struct DeferredFeed {
    ingress_kind: String,
    relay_namespace: Option<String>,
    replication_epoch: Option<String>,
    stream_identity: Option<String>,
}

/// [`released_decision`] for a deferred update a drain replays, under the
/// feed the row recorded, never the current configuration. A local row
/// arrived on this replica's own feed. A row whose feed was never recorded
/// is held on a protected lineage whatever it does: nothing shows the feed
/// it came from, so its binding names no namespace.
#[allow(clippy::too_many_arguments)]
fn drain_decision(
    tx: &rusqlite::Connection,
    key: &DocKey,
    lineage: &str,
    feed: &DeferredFeed,
    origin_id: &str,
    origin_seq: i64,
    relay_seq: Option<i64>,
    tails: &ReleasedTails,
    incoming: Incoming<'_>,
) -> Result<ReleasedDecision, SyncError> {
    let (coordinate, identified) =
        deferred_coordinate(tx, key, feed, origin_id, origin_seq, relay_seq)?;
    let incoming = if feed.ingress_kind == "legacy-unknown" {
        Incoming::Replacement
    } else {
        incoming
    };
    let decision = released_decision(tx, key, lineage, &coordinate, tails, incoming)?;
    if matches!(decision, ReleasedDecision::Unprotected) {
        return Ok(decision);
    }
    bindable(identified, coordinate.relay_seq)?;
    Ok(decision)
}

/// The coordinate a queued update's recorded `feed` names, and whether the
/// replica has a sync identity. A row whose feed was never recorded names
/// no namespace. A relay position below 1 is none.
fn deferred_coordinate(
    tx: &rusqlite::Connection,
    key: &DocKey,
    feed: &DeferredFeed,
    origin_id: &str,
    origin_seq: i64,
    relay_seq: Option<i64>,
) -> Result<(IncomingCoordinate, bool), SyncError> {
    let current: Option<(String, String)> = tx
        .query_row(
            "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
            [&key.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let hosted = feed.ingress_kind == "hosted";
    let identified = current.is_some();
    let (replication_epoch, stream_identity) =
        match (hosted, &feed.replication_epoch, &feed.stream_identity) {
            (true, Some(epoch), Some(stream)) => (epoch.clone(), stream.clone()),
            _ => current.unwrap_or_default(),
        };
    let coordinate = IncomingCoordinate {
        relay_namespace: feed.relay_namespace.clone().filter(|_| hosted),
        replication_epoch,
        stream_identity,
        origin_id: origin_id.to_owned(),
        origin_seq,
        relay_seq: relay_seq.filter(|seq| *seq > 0).unwrap_or_default(),
    };
    Ok((coordinate, identified))
}

/// Whether a protected lineage's hold can bind the row at `relay_seq` on a
/// replica that is `identified`: a binding names the replica's feed and a
/// relay position from 1.
fn bindable(identified: bool, relay_seq: i64) -> Result<(), SyncError> {
    if !identified {
        return Err(local_corruption(
            "a protected lineage's replica has no sync identity",
        ));
    }
    if relay_seq <= 0 {
        return Err(SyncError::RetryableState {
            reason: "a row held for a released lineage has no relay sequence",
        });
    }
    Ok(())
}

/// Persist `hold` for the document its binding names, unless its row
/// already records exactly that hold: a hold persisted again would count a
/// commit, and no pass could ever commit. Answers whether the row records
/// the hold now.
fn persist_released_hold(
    store: &mut EngineStore,
    hold: &crate::HostedHold,
    faults: &dyn FaultInjector,
) -> Result<bool, SyncError> {
    let crate::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation,
        binding_stale,
    } = hold
    else {
        return Ok(false);
    };
    let persisted = store.write_with(faults, |tx| {
        if crate::hosted::recorded_hold(tx, &binding.workspace_id, &binding.object_id)?.as_ref()
            == Some(hold)
        {
            return Ok(true);
        }
        crate::hosted::hold_released_in_tx(tx, binding, *continuation, *binding_stale)
    })?;
    match persisted {
        TxnOutcome::Committed(stored) => Ok(stored),
        TxnOutcome::Crashed { .. } => Err(SyncError::FaultCrash),
    }
}

/// Why a hosted replica defers nothing its trusted configuration names no
/// feed for: the row stays unacknowledged before the cursor.
pub(crate) const HOSTED_DEFERRAL_UNNAMED: &str = "a hosted deferral has no trusted feed";

/// Queue `op`, a `ydoc.update` of `key`'s `lineage_claim_id`, for a later
/// drain, in the transaction that acknowledges it. A hosted replica's row
/// records the feed it arrived on: the trusted `relay_namespace`, the
/// replica's epoch and stream, and its relay position from 1. Any other
/// replica's row is local. A row already queued keeps the feed it recorded;
/// one its feed cannot describe fails rather than queueing nothing.
pub(crate) fn defer_ydoc_update_in_tx(
    tx: &Connection,
    key: &DocKey,
    op: &ReplicationEnvelope,
    lineage_claim_id: &str,
    relay_seq: i64,
    relay_namespace: Option<&str>,
) -> Result<(), SyncError> {
    // Retained work whose feed was never recorded moves queues as it is.
    let feed = if retained_unrecorded(tx, op)? {
        ("legacy-unknown", None, None, None)
    } else if crate::hosted::is_hosted(tx, &key.workspace_id)? {
        let identity: Option<(String, String)> = tx
            .query_row(
                "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
                [&key.workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(SyncError::corrupt)?;
        match (
            relay_namespace.filter(|namespace| !namespace.is_empty()),
            identity,
        ) {
            (Some(namespace), Some((epoch, stream))) if relay_seq > 0 => {
                ("hosted", Some(namespace), Some(epoch), Some(stream))
            }
            _ => {
                return Err(SyncError::RetryableState {
                    reason: HOSTED_DEFERRAL_UNNAMED,
                });
            }
        }
    } else {
        ("local", None, None, None)
    };
    tx.execute(
        "INSERT INTO ydoc_deferred_updates \
         (workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id, \
          relay_seq,ingress_kind,relay_namespace,replication_epoch,stream_identity) \
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) ON CONFLICT DO NOTHING",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            op.origin_id,
            op.origin_seq,
            op.recorded_at_ms,
            lineage_claim_id,
            relay_seq,
            feed.0,
            feed.1,
            feed.2,
            feed.3
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

/// Whether `op` is retained relay work that recorded no feed: a row from
/// before feeds were recorded. New ingress never writes one.
fn retained_unrecorded(conn: &Connection, op: &ReplicationEnvelope) -> Result<bool, SyncError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM relay_deferred_ops WHERE workspace_id=?1 \
         AND origin_id=?2 AND origin_seq=?3 AND ingress_kind='legacy-unknown')",
        params![op.workspace_id, op.origin_id, op.origin_seq],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

pub(crate) fn protection_failure(
    error: dohc_engine_collab::live_update_application::ApplicationError,
) -> SyncError {
    use dohc_engine_collab::live_update_application::ApplicationError;
    match error {
        ApplicationError::Storage(error) => SyncError::Storage(error),
        ApplicationError::Collab(error) => map_collab_hard_error(error),
        ApplicationError::Cancelled => SyncError::Cancelled,
        _ => local_corruption("released lineage evidence does not read"),
    }
}

/// Whether `binding` names an archived lineage of its document rather than
/// the head's.
pub(crate) fn names_archived_lineage(
    conn: &Connection,
    binding: &ReleasedLineageBinding,
) -> Result<bool, SyncError> {
    let doc = DocKey {
        workspace_id: binding.workspace_id.clone(),
        version_id: binding.main_version_id.clone(),
        object_id: binding.object_id.clone(),
    };
    let head = dohc_engine_collab::read_marker_in(conn, &doc)
        .map_err(map_collab_hard_error)?
        .and_then(|marker| marker.lineage_claim_id);
    if head.as_deref() == Some(binding.lineage_claim_id.as_str()) {
        return Ok(false);
    }
    inactive_lineage_exists(conn, &doc, &binding.lineage_claim_id)
}

/// Whether `binding` still names what its held row would change: the
/// document's lineage, path, restore generation and head, or the archived
/// lineage it names and the state its archive keeps, the replica's feed, and
/// every protected tail with its retained work, as `conn` reads them now.
/// [`SyncError::ValidationPending`] while those tails wait for validation.
pub(crate) fn released_binding_current(
    conn: &rusqlite::Connection,
    binding: &ReleasedLineageBinding,
    tails: &ReleasedTails,
) -> Result<bool, SyncError> {
    use dohc_engine_collab::live_update_application::{Protection, ProtectionKey, protection};
    let doc = DocKey {
        workspace_id: binding.workspace_id.clone(),
        version_id: binding.main_version_id.clone(),
        object_id: binding.object_id.clone(),
    };
    let lineage = dohc_engine_collab::read_marker_in(conn, &doc)
        .map_err(map_collab_hard_error)?
        .and_then(|marker| marker.lineage_claim_id);
    let feed: Option<(String, String)> = conn
        .query_row(
            "SELECT replication_epoch,stream_identity FROM sync_identity WHERE workspace_id=?1",
            [&doc.workspace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let incoming = &binding.incoming;
    if feed
        .as_ref()
        .map(|(epoch, stream)| (epoch.as_str(), stream.as_str()))
        != Some((&incoming.replication_epoch, &incoming.stream_identity))
    {
        return Ok(false);
    }
    if lineage.as_deref() != Some(binding.lineage_claim_id.as_str()) {
        let archived = &binding.lineage_claim_id;
        if !inactive_lineage_exists(conn, &doc, archived)? {
            return Ok(false);
        }
        return Ok(match archived_protection(conn, &doc, archived, tails)? {
            Some(protected) => {
                *archived_binding(conn, &doc, archived, incoming.clone(), protected)? == *binding
            }
            None => false,
        });
    }
    let key = ProtectionKey {
        doc: &doc,
        lineage_claim_id: &binding.lineage_claim_id,
        incoming,
    };
    match protection(conn, &key, tails).map_err(protection_failure)? {
        Protection::Protected { binding: now, .. } => Ok(*now == *binding),
        Protection::Unprotected => Ok(false),
        Protection::Pending(pending) => Err(SyncError::ValidationPending(pending)),
    }
}

/// [`hold_released_lineage`] for an imported file operation on `key`'s
/// current lineage, if it has one.
pub(crate) fn hold_released_file_operation(
    tx: &rusqlite::Connection,
    key: &DocKey,
    op: &ReplicationEnvelope,
    relay_namespace: Option<&str>,
    tails: &ReleasedTails,
    incoming: Incoming<'_>,
) -> Result<Option<Box<ReleasedLineageBinding>>, SyncError> {
    let Some(lineage) = dohc_engine_collab::read_marker_in(tx, key)
        .map_err(map_collab_hard_error)?
        .and_then(|marker| marker.lineage_claim_id)
    else {
        return Ok(None);
    };
    hold_released_lineage(
        tx,
        key,
        &lineage,
        op,
        op.relay_seq,
        relay_namespace,
        tails,
        incoming,
    )
}

/// The durable file head that must remain canonical after a non-Y.Doc
/// mutation commits.
pub enum ResultingHead<'a> {
    Text { path: &'a str, text: &'a str },
    BinaryOrAbsent,
}

/// A folder move must check durable owner bindings, including owners that
/// have never queued an update. Closing a session does not end adoption;
/// releasing its activation does.
pub fn ensure_no_adopted_owner_under_path(
    conn: &Connection,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<(), SyncError> {
    let adopted: bool = conn
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {CURRENT_ACTIVATIONS}
         WHERE workspace_id=?1 AND main_version_id=?2
           AND (json_extract(binding_json,'$.currentPath')=?3
             OR substr(json_extract(binding_json,'$.currentPath'),1,length(?3)+1)=?3||'/'))"
            ),
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
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {CURRENT_ACTIVATIONS}
         WHERE workspace_id=?1 AND main_version_id=?2 AND object_id=?3
           AND (?4 IS NULL OR json_extract(binding_json,'$.currentPath') IS NOT ?4))"
            ),
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
    dohc_engine_collab::author_coverage::reset_in(tx, key, false).map_err(map_collab_hard_error)?;
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
            concat!(
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
                         AND ",
                dohc_engine_domain::exclude_capture_recovery_sql!("later"),
                "
                  )
             )"
            ),
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
    let content = if lineage_has_content(marker) {
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
            LineageFoldCause::ConflictParent,
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
/// no content, from the record's index against the written text. Also says
/// whether the fold kept unsettled text as a recovered sibling file.
#[allow(clippy::too_many_arguments)]
pub fn reconcile_local_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    object_id: &str,
    resulting: ResultingHead<'_>,
    actor_origin_id: Option<&str>,
    attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    now_ms: i64,
) -> Result<LocalHeadReconcile, SyncError> {
    let key =
        DocKey::new(workspace_id, version_id, object_id).map_err(|_| SyncError::InvalidInput {
            reason: "Y.Doc lineage coordinates are invalid",
        })?;
    let complete = ensure_ydoc_lineage_complete_in_tx(tx, &key)?;
    reconcile_local_complete_resulting_head_in_tx(
        tx,
        &complete,
        None,
        None,
        resulting,
        actor_origin_id,
        attribution,
        now_ms,
    )
}

/// [`reconcile_local_head_in_tx`] over capture's pre-mutation lineage, without
/// loading or projecting it again.
pub fn reconcile_prepared_local_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    prepared: PreparedLocalYdocLineage,
    resulting: ResultingHead<'_>,
    actor_origin_id: Option<&str>,
    attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    now_ms: i64,
) -> Result<LocalHeadReconcile, SyncError> {
    reconcile_local_complete_resulting_head_in_tx(
        tx,
        &prepared.complete,
        prepared.projection.as_ref(),
        prepared.reader_delta.as_deref(),
        resulting,
        actor_origin_id,
        attribution,
        now_ms,
    )
}

#[allow(clippy::too_many_arguments)]
fn reconcile_local_complete_resulting_head_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
    projection: Option<&dohc_engine_collab::Projection>,
    reader_delta: Option<&[u8]>,
    resulting: ResultingHead<'_>,
    actor_origin_id: Option<&str>,
    attribution: Option<&dohc_engine_domain::ChangeAttribution>,
    now_ms: i64,
) -> Result<LocalHeadReconcile, SyncError> {
    let key = &complete.key;
    match resulting {
        ResultingHead::Text { path, text } => {
            // The authors of text this write may replace. Read before the
            // supersede below drops a reserved settle attempt's share of them.
            let unsettled_authors = match complete.state.as_ref() {
                Some((marker, _)) if lineage_has_content(marker) => {
                    dohc_engine_collab::author_coverage::reserved_in(tx, key)
                        .map_err(map_collab_hard_error)?
                        .moment_json()
                }
                _ => None,
            };
            // A blocked settlement write must not refuse this head forever.
            dohc_engine_collab::author_coverage::supersede_in(tx, key, now_ms)
                .map_err(map_collab_hard_error)?;
            let folded = fold_projected_complete_ydoc_lineage_in_tx(
                tx,
                complete,
                path,
                text,
                LineageFoldAuthor {
                    actor_origin_id,
                    attribution,
                },
                now_ms,
                LineageFoldCause::LocalMutation { unsettled_authors },
                projection,
                reader_delta,
            )?;
            match folded {
                LineageFold::Folded {
                    facts,
                    recovered_sibling,
                } => Ok(LocalHeadReconcile {
                    facts: facts.map(|facts| *facts),
                    recovered_sibling,
                }),
                LineageFold::NoContent => dohc_engine_domain::index_collection_record_text_in_tx(
                    tx,
                    &key.workspace_id,
                    &key.version_id,
                    &key.object_id,
                    path,
                    text,
                    actor_origin_id,
                    attribution,
                    now_ms,
                )
                .map(|facts| LocalHeadReconcile {
                    facts,
                    recovered_sibling: false,
                })
                .map_err(map_domain_hard_error),
            }
        }
        ResultingHead::BinaryOrAbsent => {
            retire_complete_ydoc_lineage_in_tx(tx, complete).map(|()| LocalHeadReconcile {
                facts: None,
                recovered_sibling: false,
            })
        }
    }
}

/// [`reconcile_local_head_in_tx`] for a caller that reserves no later moment
/// order in the same transaction and needs only the record facts.
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
    reconcile_local_head_in_tx(
        tx,
        workspace_id,
        version_id,
        object_id,
        resulting,
        actor_origin_id,
        attribution,
        now_ms,
    )
    .map(|reconciled| reconciled.facts)
}

/// Who wrote the text a fold folds in.
#[derive(Clone, Copy, Default)]
pub(crate) struct LineageFoldAuthor<'a> {
    pub(crate) actor_origin_id: Option<&'a str>,
    pub(crate) attribution: Option<&'a dohc_engine_domain::ChangeAttribution>,
}

/// Why a fold folds. The cause decides whether the rewrite is journaled and
/// whether unsettled text the fold would discard is kept.
pub(crate) enum LineageFoldCause {
    /// A locally-originated file mutation over a closed lineage. Its rewrite
    /// is journaled, and text the lineage held but no artifact ever
    /// recorded becomes a recovered sibling file credited to these authors.
    LocalMutation { unsettled_authors: Option<String> },
    /// A reviewed conflict resolution. Both sides were shown; the chosen
    /// text is journaled and nothing else is kept.
    Resolution,
    /// A replicated conflict parent. The parent is the journaled operation,
    /// so the receiver's rewrite is not.
    ConflictParent,
}

impl LineageFoldCause {
    fn journals(&self) -> bool {
        !matches!(self, LineageFoldCause::ConflictParent)
    }
}

fn lineage_has_content(marker: &dohc_engine_collab::Marker) -> bool {
    marker.lineage_claim_status.has_claimed_base()
        || marker.head_update_seq > 0
        || marker.head_snapshot_seq > 0
}

/// Whether an artifact already holds a closed lineage's projection: the
/// lineage settled it, a moment of this file recorded exactly these bytes,
/// or the lineage is still the untouched seed of the file's own bytes.
fn projection_held_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    content: &str,
) -> Result<bool, SyncError> {
    if dohc_engine_collab::pristine_seed_lineage_source(tx, key)
        .map_err(map_collab_hard_error)?
        .is_some()
    {
        return Ok(true);
    }
    tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM ydoc_docs \
           WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND last_settled_sha=?4) \
         OR EXISTS(SELECT 1 FROM moments \
           WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND after_blob_sha256=?4)",
        params![
            key.workspace_id,
            key.version_id,
            key.object_id,
            hex_sha256(content.as_bytes()),
        ],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
}

/// What folding a file's text into its Y.Doc lineage did.
pub(crate) enum LineageFold {
    /// The lineage holds no content: the file alone carries the text.
    NoContent,
    /// The lineage holds the text now, with the record fields its append
    /// changed, if any. Boxed, since the facts dwarf the empty variant.
    /// `recovered_sibling` says the fold first kept unsettled text as a
    /// recovered sibling file, whose moment took the next global order.
    Folded {
        facts: Option<Box<dohc_engine_domain::CollectionRecordApplyFacts>>,
        recovered_sibling: bool,
    },
}

/// What reconciling a local text head with its lineage did.
pub struct LocalHeadReconcile {
    /// Collection record fields the head changed, if any.
    pub facts: Option<dohc_engine_domain::CollectionRecordApplyFacts>,
    /// The fold kept unsettled text as a recovered sibling file. Its moment
    /// took the next global order, so a caller that reserved later orders in
    /// this transaction must read the high-water mark again.
    pub recovered_sibling: bool,
}

fn pristine_empty_seed_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
) -> Result<bool, SyncError> {
    let key = &complete.key;
    let Some((marker, doc)) = &complete.state else {
        return Ok(false);
    };
    if marker.content_kind != ContentKind::Richdoc
        || marker.head_update_seq != 1
        || marker.head_snapshot_seq != 0
    {
        return Ok(false);
    }
    let pristine: Option<String> = tx
        .query_row(
            "SELECT b.sha256 FROM ydoc_docs d JOIN blobs b ON b.sha256=d.seed_source_sha256 \
         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3 \
           AND (d.settle_seq=0 OR EXISTS(SELECT 1 FROM moments m \
             WHERE m.workspace_id=?1 AND m.version_id=?2 AND m.object_id=?3 \
               AND m.moment_order=d.settle_seq AND m.after_blob_sha256=b.sha256)) \
           AND (d.last_settled_sha IS NULL OR d.last_settled_sha=b.sha256) \
           AND (SELECT COUNT(*) FROM ydoc_updates u WHERE u.workspace_id=?1 \
             AND u.version_id=?2 AND u.object_id=?3)=1 \
           AND NOT EXISTS(SELECT 1 FROM ydoc_snapshots s WHERE s.workspace_id=?1 \
             AND s.version_id=?2 AND s.object_id=?3 AND s.up_to_seq<>0)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    Ok(pristine
        .as_deref()
        .map(|sha| text::equals(tx, sha, ""))
        .transpose()
        .map_err(SyncError::corrupt)?
        .unwrap_or(false)
        && project_ydoc_with_store(tx, key, doc, ContentKind::Richdoc)?
            .content
            .is_empty())
}

fn empty_seed_never_replicated_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<bool, SyncError> {
    // The journal retains both outbound and received updates. A queued base is
    // already replication authority, even before it reaches the relay. The
    // marker and candidate rows also retain relay authority after compaction.
    // Owner and live-device bindings provide independent routes to a peer.
    tx.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM replication_log WHERE workspace_id=?1 \
           AND op_kind='ydoc.update' AND json_extract(payload_json,'$.versionId')=?2 \
           AND json_extract(payload_json,'$.objectId')=?3) \
         AND NOT EXISTS(SELECT 1 FROM ydoc_base_relay_candidates WHERE workspace_id=?1 \
           AND version_id=?2 AND object_id=?3) \
         AND NOT EXISTS(SELECT 1 FROM live_device_application_bindings WHERE workspace_id=?1 \
           AND main_version_id=?2 AND object_id=?3) \
         AND NOT EXISTS(SELECT 1 FROM ydoc_owner_bindings WHERE workspace_id=?1 \
           AND main_version_id=?2 AND object_id=?3) \
         AND EXISTS(SELECT 1 FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 \
           AND object_id=?3 AND base_origin_id IS NULL AND base_origin_seq IS NULL \
           AND base_relay_seq IS NULL)",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| row.get(0),
    )
    .map_err(SyncError::corrupt)
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
            if lineage_has_content(marker) {
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
    dohc_engine_collab::author_coverage::supersede_in(tx, &complete.key, now_ms)
        .map_err(map_collab_hard_error)?;
    fold_complete_ydoc_lineage_in_tx(
        tx,
        &complete,
        path,
        chosen_text,
        LineageFoldAuthor::default(),
        now_ms,
        LineageFoldCause::Resolution,
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
    cause: LineageFoldCause,
) -> Result<LineageFold, SyncError> {
    fold_projected_complete_ydoc_lineage_in_tx(
        tx,
        complete,
        path,
        chosen_text,
        author,
        now_ms,
        cause,
        None,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn fold_projected_complete_ydoc_lineage_in_tx(
    tx: &rusqlite::Transaction<'_>,
    complete: &CompleteYdocLineage,
    path: &str,
    chosen_text: &str,
    author: LineageFoldAuthor<'_>,
    now_ms: i64,
    cause: LineageFoldCause,
    projection: Option<&dohc_engine_collab::Projection>,
    reader_delta: Option<&[u8]>,
) -> Result<LineageFold, SyncError> {
    let LineageFoldAuthor {
        actor_origin_id,
        attribution,
    } = author;
    let key = &complete.key;
    require_resolved_local_settlement(tx, key, now_ms)?;
    ensure_adopted_owner_binding_unchanged(tx, key, Some(path))?;
    require_unfenced_lineage(tx, key)?;
    let Some((marker, doc)) = complete.state.as_ref() else {
        return Ok(LineageFold::NoContent);
    };
    if !lineage_has_content(marker) {
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
    let mut recovered_sibling = false;
    let loaded_projection;
    let projection = if let Some(projection) = projection {
        projection
    } else {
        loaded_projection = project_ydoc_with_store(tx, key, doc, marker.content_kind)?;
        &loaded_projection
    };
    // Keep this witness from before the rewrite mutates the in-memory doc.
    let pristine_empty = projection.content.is_empty() && pristine_empty_seed_in_tx(tx, complete)?;
    if projection.content != chosen_text {
        if marker.content_kind == ContentKind::Scene {
            // A scene has no Markdown fold, and refusing here would roll
            // back the text write that carries an external edit to a closed
            // drawing — the edit would vanish from history and a later
            // materialization could overwrite the file with the older
            // scene. The durable file head is canonical: retire the lineage
            // and let the next open seed a fresh scene from the artifact,
            // exactly like a first open.
            return retire_complete_ydoc_lineage_in_tx(tx, complete).map(|()| {
                LineageFold::Folded {
                    facts: None,
                    recovered_sibling: false,
                }
            });
        }
        // The rewrite below discards this projection. Text no artifact holds
        // leaves as an ordinary sibling file first, in this transaction, so
        // a rollback of the write takes the copy with it.
        if let LineageFoldCause::LocalMutation { unsettled_authors } = &cause
            && !projection.content.is_empty()
            && !projection_held_in_tx(tx, key, &projection.content)?
        {
            crate::ydoc_recovery::recover_unsettled_local_in_tx(
                tx,
                key,
                marker.lineage_claim_id.as_deref(),
                path,
                &projection.content,
                unsettled_authors.as_deref(),
                now_ms,
            )?;
            recovered_sibling = true;
        }
        let (mut update, source_bound) = match reader_delta.map_or_else(
            || doc.rewrite_content_to_markdown_for_fold(marker.content_kind, chosen_text),
            |delta| doc.apply(delta).map(|()| delta.to_vec()),
        ) {
            Err(CollabError::MarkdownNotRepresentable)
                if pristine_empty && empty_seed_never_replicated_in_tx(tx, key)? =>
            {
                retire_complete_ydoc_lineage_in_tx(tx, complete)?;
                return Ok(LineageFold::NoContent);
            }
            // Keep the body XML when the chosen file keeps its settled
            // body. The final proof below checks the retained XML.
            Err(CollabError::MarkdownNotRepresentable)
                if marker.content_kind == ContentKind::Richdoc
                    && last_settled_text_in_tx(tx, key)?.is_some_and(|settled| {
                        markdown_body(&settled) == markdown_body(chosen_text)
                    }) =>
            {
                (
                    doc.replace_frontmatter_for_fold(chosen_text)
                        .map_err(map_fold_edit_error)?,
                    true,
                )
            }
            result => (result.map_err(map_fold_edit_error)?, false),
        };
        // Check the delta before projection, which has a separate byte cap.
        if update.len() > dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES {
            return Err(SyncError::BlobTooLarge {
                constraint: "MAX_YDOC_UPDATE_BYTES (conflict resolution fold)",
                limit_bytes: dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
                observed_bytes: update.len(),
            });
        }
        let canonical = doc
            .project(marker.content_kind)
            .map_err(|error| map_projection_error(error, "ydoc projection is invalid"))?;
        // Canonical files use the ordinary rewrite and projection. Only a
        // lexical variant needs source storage, scratch replay, and validation.
        // The frontmatter-only stage already binds this witness.
        // The exact-source projection proof below still applies to both paths.
        if !source_bound
            && marker.content_kind == ContentKind::Richdoc
            && canonical.content != chosen_text
        {
            let source_update = doc
                .preserve_folded_markdown_source(chosen_text)
                .map_err(map_fold_edit_error)?;
            update = dohc_engine_collab::merge_updates(&[update, source_update])
                .map_err(map_fold_edit_error)?;
        }
        // Capture already installed the chosen snapshot here. Peers still
        // hold the lineage's previous settled source, so only that body may
        // use the settled-rule exception. New bodies must pass the strict rule.
        let refolded = if canonical.content == chosen_text {
            canonical
        } else {
            let mut projection = canonical;
            if marker.content_kind == ContentKind::Richdoc
                && let Some(source) = doc.settled_markdown_source(&projection.content, || {
                    last_settled_text_in_tx(tx, key)
                })?
            {
                projection.content = source;
            }
            projection
        };
        if refolded.content != chosen_text {
            if pristine_empty && empty_seed_never_replicated_in_tx(tx, key)? {
                retire_complete_ydoc_lineage_in_tx(tx, complete)?;
                return Ok(LineageFold::NoContent);
            }
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
        .map_err(map_fold_edit_error)?;
        // Journal only when this workspace actually replicates: a receiver
        // that never enrolled has no sync identity, and its choice needs no
        // peer. `emit_outbound` alone cannot gate this — a claimed lineage
        // exists on identity-less receivers too.
        if cause.journals()
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
    Ok(LineageFold::Folded {
        facts: record_facts.map(Box::new),
        recovered_sibling,
    })
}

fn settle_ydoc_marker_to_text(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    path: &str,
    text: &str,
    now_ms: i64,
) -> Result<(), SyncError> {
    // A verified resulting head replaces this attempt's obsolete disk write.
    // Its committed moment retains credit; advance consumes only the new interval.
    dohc_engine_collab::author_coverage::supersede_in(tx, key, now_ms)
        .map_err(map_collab_hard_error)?;
    dohc_engine_collab::author_coverage::advance_in(tx, key, false)
        .map_err(map_collab_hard_error)?;
    // The lineage at its current head projects to `text`, the head it settles
    // to here, so it covers every update up to that head.
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
    losing_authors: Option<&str>,
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
            losing_authors,
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
            losing_authors,
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
    let pending_authors = dohc_engine_collab::author_coverage::reserved_in(tx, key)
        .map_err(map_collab_hard_error)?
        .json();
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
            text::read(tx, &external.unwrap().blob_sha256).map_err(SyncError::corrupt)?
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
            (open && pending_authors != "[]").then_some(pending_authors.as_str()),
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
                "SELECT b.sha256 FROM conflicts c JOIN blobs b ON b.sha256=c.incoming_blob_sha256 \
            WHERE c.workspace_id=?1 AND c.conflict_id=?2",
                params![key.workspace_id, conflict_id],
                |row| text::from_row(tx, row, 0),
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
        (pending_authors != "[]").then_some(pending_authors.as_str()),
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
    let interval_named_or_noop = open || opened > 0;
    let retained_authors = if interval_named_or_noop {
        "[]"
    } else {
        pending_authors.as_str()
    };
    put_projection_text_blob(tx, &local, &local_sha)?;
    tx.execute(
        "INSERT INTO ydoc_inactive_lineages (workspace_id,version_id,object_id,lineage_claim_id, \
         parent_claim_id,disposition,content_kind,path,epoch_tag,full_state_blob_sha256, \
         state_vector_blob_sha256,last_surfaced_projection_sha256,open_conflict_id,recorded_at_ms,updated_at_ms,pending_authors_json) \
         VALUES (?1,?2,?3,?4,?5,'rejected-base',?6,?7,?8,?9,?10,?11,?12,?13,?13,?14)",
        params![key.workspace_id,key.version_id,key.object_id,claim,marker.lineage_parent_claim_id,
            marker.content_kind.as_str(),payload.path,marker.lineage_epoch_tag,full_sha,vector_sha,
            local_sha,open_sync_conflict_id(tx,key)?,now_ms,retained_authors],
    ).map_err(SyncError::persist)?;
    if marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Unclaimed {
        dohc_engine_collab::author_coverage::reset_in(tx, key, false)
            .map_err(map_collab_hard_error)?;
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
    pending_authors: String,
}

#[derive(Default)]
struct InactiveDeltaOutcome {
    found: bool,
    refusal: Option<String>,
    rejected: Vec<(usize, String)>,
}

/// The archived lineages an inactive drain takes up: a workspace's, or one
/// document's, with the queued rows of it a drain whose cleanup has not run
/// yet consumed.
#[derive(Clone, Copy)]
pub(crate) enum InactiveScope<'a> {
    Workspace(&'a str),
    Document(&'a DocKey, &'a [(String, i64)]),
}

impl InactiveScope<'_> {
    fn workspace_id(&self) -> &str {
        match self {
            Self::Workspace(workspace_id) => workspace_id,
            Self::Document(key, _) => &key.workspace_id,
        }
    }

    fn consumed(&self) -> &[(String, i64)] {
        match self {
            Self::Workspace(_) => &[],
            Self::Document(_, consumed) => consumed,
        }
    }

    /// What keeps a queued row `d` in the scope: a document's version and
    /// object bound from parameter `first`, and none of the rows its pending
    /// cleanup owns, which that cleanup reports and removes.
    fn condition(&self, first: usize) -> String {
        match self {
            Self::Workspace(_) => String::new(),
            Self::Document(..) => format!(
                " AND d.version_id=?{first} AND d.object_id=?{} \
                 AND NOT EXISTS(SELECT 1 FROM json_each(?{}) c \
                   WHERE json_extract(c.value,'$[0]')=d.origin_id \
                   AND json_extract(c.value,'$[1]')=d.origin_seq)",
                first + 1,
                first + 2
            ),
        }
    }

    /// `leading`, then a document's version, object and `consumed`, the
    /// JSON array of [`Self::consumed`].
    fn params<'a>(
        &'a self,
        leading: &[&'a dyn rusqlite::ToSql],
        consumed: &'a dyn rusqlite::ToSql,
    ) -> Vec<&'a dyn rusqlite::ToSql> {
        let mut params = leading.to_vec();
        if let Self::Document(key, _) = self {
            params.push(&key.version_id);
            params.push(&key.object_id);
            params.push(consumed);
        }
        params
    }
}

/// What an inactive drain did.
#[derive(Default)]
pub(crate) struct InactiveDrain {
    pub(crate) refusals: Vec<crate::ReplicationRefusal>,
    /// What the rows it removed had committed to Collection records when a
    /// drain applied them to the head before their lineage was archived.
    pub(crate) record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    /// The hold each document whose archived lineage released tails protect
    /// is left with, by object id, when a hosted document stores it.
    pub(crate) holds: std::collections::BTreeMap<String, crate::HostedHold>,
    /// The archived lineages whose queued rows it took, by object id, of each
    /// document it left with no hold: a hold that names one of them is gone.
    pub(crate) cleared: std::collections::BTreeMap<String, std::collections::BTreeSet<String>>,
}

/// Where a drain reports what its removed rows owe: in the drain reports
/// their transaction writes, for a pass, or in its answer, for a caller that
/// reports them itself.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum DrainReporting {
    Durable,
    Returned,
}

/// One admitted update is at most 20 MiB, plus a 256 KiB payload.
const ARCHIVED_BATCH_BYTES: usize = 24 * 1024 * 1024;

/// Whether a queued row `d` is of none of the lineages the JSON array `?2`
/// names as `[version, object, lineage]`.
const NOT_PASSED_OVER: &str = "NOT EXISTS(SELECT 1 FROM json_each(?2) x \
     WHERE json_extract(x.value,'$[0]')=d.version_id AND json_extract(x.value,'$[1]')=d.object_id \
     AND json_extract(x.value,'$[2]')=d.lineage_claim_id)";

/// Apply the scope's queued updates of archived lineages, in batches. A
/// lineage released tails protect, decided from the tails before anything of
/// it loads, keeps its rows queued, holds its document with its first row's
/// binding, and joins `protected`, the lineages as `[version, object,
/// lineage]` that the call, and any later one given them, passes over. One
/// no binding can name holds its document by its queued rows alone.
/// [`SyncError::ValidationPending`] while its tails wait for validation,
/// with that batch rolled back; batches before it committed, and `report`
/// decides whether what they removed survives that.
pub(crate) fn drain_inactive_ydoc_updates(
    store: &mut EngineStore,
    scope: InactiveScope<'_>,
    tails: &ReleasedTails,
    protected: &mut Vec<[String; 3]>,
    report: DrainReporting,
    faults: &dyn FaultInjector,
) -> Result<InactiveDrain, SyncError> {
    let workspace_id = scope.workspace_id();
    let consumed = serde_json::to_string(scope.consumed()).map_err(SyncError::corrupt)?;
    let excluded = serde_json::to_string(&*protected).map_err(SyncError::corrupt)?;
    let pending = store.read_with(|conn| conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates d JOIN ydoc_inactive_lineages l \
         ON l.workspace_id=d.workspace_id AND l.version_id=d.version_id AND l.object_id=d.object_id \
         AND l.lineage_claim_id=d.lineage_claim_id WHERE d.workspace_id=?1 AND {NOT_PASSED_OVER}{})", scope.condition(3)),
        scope.params(&[&workspace_id, &excluded], &consumed).as_slice(), |row| row.get::<_,bool>(0),
    )).map_err(SyncError::corrupt)?;
    if !pending {
        return Ok(InactiveDrain::default());
    }
    let search_policy = search_policy_for_store(store);
    let mut drained = InactiveDrain::default();
    loop {
        let excluded = serde_json::to_string(&*protected).map_err(SyncError::corrupt)?;
        let result = store.write_with(faults, |tx| {
        let mut statement = tx.prepare(&format!(
            "SELECT d.origin_id,d.origin_seq,d.relay_seq,r.recorded_at_ms,d.lineage_claim_id,r.payload_json, \
             d.ingress_kind,d.relay_namespace,d.replication_epoch,d.stream_identity,b.byte_length,d.record_facts_json, \
             d.applied_refusal \
             FROM ydoc_deferred_updates d JOIN ydoc_inactive_lineages l \
             ON l.workspace_id=d.workspace_id AND l.version_id=d.version_id \
             AND l.object_id=d.object_id AND l.lineage_claim_id=d.lineage_claim_id \
             JOIN replication_log r ON r.workspace_id=d.workspace_id \
             AND r.origin_id=d.origin_id AND r.origin_seq=d.origin_seq \
             LEFT JOIN binary_blobs b ON b.sha256=json_extract(r.payload_json,'$.updateBlobSha256') \
             WHERE d.workspace_id=?1{} AND {NOT_PASSED_OVER} \
             ORDER BY d.relay_seq,d.origin_id,d.origin_seq LIMIT 256",
            scope.condition(3),
        )).map_err(SyncError::corrupt)?;
        let rows = statement.query_map(scope.params(&[&workspace_id, &excluded], &consumed).as_slice(), |row| Ok((
            (row.get::<_,String>(0)?, row.get::<_,i64>(1)?, row.get::<_,Option<i64>>(2)?, row.get::<_,i64>(3)?, row.get::<_,String>(4)?, row.get::<_,String>(5)?,
             DeferredFeed { ingress_kind: row.get(6)?, relay_namespace: row.get(7)?, replication_epoch: row.get(8)?, stream_identity: row.get(9)? }),
            row.get::<_,Option<i64>>(10)?,
            row.get::<_,Option<String>>(11)?,
            row.get::<_,Option<String>>(12)?,
        ))).map_err(SyncError::corrupt)?.collect::<Result<Vec<_>,_>>().map_err(SyncError::corrupt)?;
        let mut groups = std::collections::BTreeMap::<_, Vec<DeferredRow>>::new();
        let mut parked = std::collections::BTreeMap::new();
        // The refusal each row's head apply was owed, which stands as it was
        // whatever its archive decides.
        let mut owed_refusals = std::collections::BTreeMap::new();
        let mut batch_bytes = 0;
        let mut processed = 0;
        // The one lineage of each document the batch decides. A second waits
        // for a later batch: what deciding the first wrote, its hold or its
        // archive, would leave the second asking for validation of a
        // generation only this transaction holds.
        let mut lineages = std::collections::BTreeMap::<(String, String), String>::new();
        for ((origin, seq, relay_seq, at, lineage, json, feed), byte_length, facts, owed) in rows {
            let cost = usize::try_from(byte_length.ok_or(SyncError::BlobInvalid)?).map_err(SyncError::corrupt)?.saturating_add(json.len());
            let payload: YdocUpdatePayload = serde_json::from_str(&json).map_err(SyncError::corrupt)?;
            let document = (payload.version_id.clone(), payload.object_id.clone());
            if lineages.get(&document).is_some_and(|decided| *decided != payload.lineage_claim_id) {
                continue;
            }
            if batch_bytes + cost > ARCHIVED_BATCH_BYTES {
                if processed == 0 { return Err(SyncError::BlobInvalid); }
                break;
            }
            lineages.entry(document).or_insert_with(|| payload.lineage_claim_id.clone());
            batch_bytes += cost;
            processed += 1;
            if let Some(facts) = facts {
                parked.insert((origin.clone(), seq), facts);
            }
            if let Some(owed) = owed {
                owed_refusals.insert((origin.clone(), seq), owed);
            }
            groups.entry((payload.version_id.clone(),payload.object_id.clone(),payload.lineage_claim_id.clone()))
                .or_default().push((origin,seq,relay_seq,at,lineage,payload,feed));
        }
        let mut refusals = Vec::new();
        let mut record_facts = Vec::new();
        let mut holds = std::collections::BTreeMap::new();
        let mut held = Vec::new();
        let mut freed = Vec::new();
        for ((version,object,lineage), rows) in groups {
            let key = DocKey::new(workspace_id, version.clone(), object.clone()).map_err(map_collab_hard_error)?;
            if let Some(tails) = archived_protection(tx, &key, &lineage, tails)? {
                if let Some(hold) = hold_archived_rows_in_tx(tx, &key, &lineage, &rows[0], tails, scope.consumed())? {
                    holds.insert(object.clone(), hold);
                }
                processed -= rows.len();
                held.push([version, object, lineage]);
                continue;
            }
            let reasons = apply_archived_rows_in_tx(tx, &key, &rows, search_policy.as_ref())?;
            for ((origin,seq,..), reason) in rows.iter().zip(reasons) {
                let refusal = owed_refusals
                    .remove(&(origin.clone(), *seq))
                    .or(reason)
                    .map(|reason| deferred_ydoc_refusal(&key, origin, *seq, reason));
                if let Some(refusal) = &refusal {
                    crate::apply::persist_refusal(tx, refusal)?;
                    refusals.push(refusal.clone());
                }
                match report {
                    // A later batch's archive projection can clear the
                    // refusal's notice, so its report keeps it too.
                    DrainReporting::Durable => crate::drain_report::record_in_tx(
                        tx,
                        workspace_id,
                        &[(origin.clone(), *seq)],
                        &crate::drain_report::DrainExtras {
                            refusals: refusal.into_iter().collect(),
                            ..Default::default()
                        },
                    )?,
                    DrainReporting::Returned => {
                        if let Some(facts) = parked.remove(&(origin.clone(), *seq)) {
                            record_facts.push(parse_parked_record_facts(&facts)?);
                        }
                    }
                }
                tx.execute("DELETE FROM ydoc_deferred_updates WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                    params![workspace_id,origin,seq]).map_err(SyncError::persist)?;
            }
            freed.push((object, lineage));
        }
        Ok::<_,SyncError>((processed,refusals,record_facts,holds,held,freed))
    })?;
        match result {
            TxnOutcome::Committed((processed, refusals, record_facts, holds, held, freed)) => {
                drained.refusals.extend(refusals);
                drained.record_facts.extend(record_facts);
                drained.holds.extend(holds);
                for (object, lineage) in freed {
                    drained.cleared.entry(object).or_default().insert(lineage);
                }
                if processed == 0 && held.is_empty() {
                    let holds = &drained.holds;
                    drained
                        .cleared
                        .retain(|object, _| !holds.contains_key(object));
                    return Ok(drained);
                }
                protected.extend(held);
            }
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
        }
    }
}

/// The tails that protect `key`'s archived `lineage`, decided from the tails
/// alone, before anything of the archive loads; none while nothing does.
/// [`SyncError::ValidationPending`] while they wait for validation.
fn archived_protection(
    conn: &Connection,
    key: &DocKey,
    lineage: &str,
    tails: &ReleasedTails,
) -> Result<Option<Arc<ProtectedTails>>, SyncError> {
    use dohc_engine_collab::live_update_application::{LineageProtection, lineage_protection};
    match lineage_protection(conn, key, lineage, tails).map_err(protection_failure)? {
        LineageProtection::Unprotected => Ok(None),
        LineageProtection::Protected(tails) => Ok(Some(tails)),
        LineageProtection::Pending(pending) => Err(SyncError::ValidationPending(pending)),
    }
}

/// The binding an update at `coordinate` of `key`'s archived `lineage`
/// names while `tails` protect it: that lineage, and the digest of the full
/// state its archive keeps. Never the head's.
fn archived_binding(
    conn: &Connection,
    key: &DocKey,
    lineage: &str,
    coordinate: IncomingCoordinate,
    tails: Arc<ProtectedTails>,
) -> Result<Box<ReleasedLineageBinding>, SyncError> {
    let state_digest: String = conn
        .query_row(
            "SELECT full_state_blob_sha256 FROM ydoc_inactive_lineages \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
            params![key.workspace_id, key.version_id, key.object_id, lineage],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    let key = dohc_engine_collab::live_update_application::ProtectionKey {
        doc: key,
        lineage_claim_id: lineage,
        incoming: &coordinate,
    };
    ReleasedLineageBinding::archived(conn, &key, tails, state_digest)
        .map(Box::new)
        .map_err(protection_failure)
}

/// Hold `key`'s document for `row`, the first of its queued updates of the
/// archived `lineage` that `tails` protect, and answer the hold it is left
/// with: a frozen one with `row`'s binding, unless a hold of another lineage
/// whose row is still queued stands there. One already recorded with the
/// same binding stays as it is, so nothing counts a commit again. A document
/// no hosted row stores binds nothing. Nor does a `row` with no relay
/// position: a ready document waits for its queued rows instead, and a hold
/// that stands stays as it is.
fn hold_archived_rows_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    lineage: &str,
    row: &DeferredRow,
    tails: Arc<ProtectedTails>,
    consumed: &[(String, i64)],
) -> Result<Option<crate::HostedHold>, SyncError> {
    let hosted: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM hosted_documents \
             WHERE workspace_id=?1 AND object_id=?2 AND state<>'parked')",
            params![key.workspace_id, key.object_id],
            |found| found.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !hosted {
        return Ok(None);
    }
    let (origin_id, origin_seq, relay_seq, _, _, _, feed) = row;
    let (coordinate, identified) =
        deferred_coordinate(tx, key, feed, origin_id, *origin_seq, *relay_seq)?;
    match bindable(identified, coordinate.relay_seq) {
        Err(SyncError::RetryableState { .. }) => {
            crate::hosted::hold_waiting_in_tx(tx, &key.workspace_id, &key.object_id)?;
            return Ok(None);
        }
        bound => bound?,
    }
    let binding = archived_binding(tx, key, lineage, coordinate, tails)?;
    let standing = crate::hosted::queued_released_hold_besides(
        tx,
        &key.workspace_id,
        &key.object_id,
        consumed,
    )?;
    let continuation = crate::ReleasedHoldContinuation::Frozen;
    match &standing {
        Some(crate::HostedHold::ReleasedLineageUnsettled { binding: held, .. })
            if held.lineage_claim_id != binding.lineage_claim_id =>
        {
            return Ok(None);
        }
        // Derived again just now, it claims currency even where the row
        // recorded it stale.
        Some(crate::HostedHold::ReleasedLineageUnsettled { binding: held, .. })
            if **held == *binding => {}
        _ => {
            if !crate::hosted::hold_released_in_tx(tx, &binding, continuation, false)? {
                return Ok(None);
            }
        }
    }
    Ok(Some(crate::HostedHold::ReleasedLineageUnsettled {
        binding,
        continuation,
        binding_stale: false,
    }))
}

/// Apply `rows`, queued updates of one of `key`'s archived lineages, in
/// order, to the archive that keeps it, and answer each row's refusal.
fn apply_archived_rows_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    rows: &[DeferredRow],
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<Vec<Option<String>>, SyncError> {
    let Some(last) = rows.last() else {
        return Ok(Vec::new());
    };
    let mut updates = Vec::with_capacity(rows.len());
    for (.., payload, _) in rows {
        let bytes = get_binary_blob(tx, &payload.update_blob_sha256)
            .map_err(SyncError::Storage)?
            .ok_or(SyncError::BlobInvalid)?;
        if hex_sha256(&bytes) != payload.update_blob_sha256 {
            return Err(SyncError::BlobInvalid);
        }
        updates.push(bytes);
    }
    let outcome = apply_inactive_batch_in_tx(tx, key, &last.5, &updates, last.3, search_policy)?;
    // A projection refusal names the last update it accepted.
    let last_accepted = (0..rows.len()).rev().find(|index| {
        !outcome
            .rejected
            .iter()
            .any(|(rejected, _)| rejected == index)
    });
    Ok((0..rows.len())
        .map(|index| {
            outcome
                .rejected
                .iter()
                .find(|(rejected, _)| *rejected == index)
                .map(|(_, reason)| reason.clone())
                .or_else(|| {
                    (Some(index) == last_accepted)
                        .then(|| outcome.refusal.clone())
                        .flatten()
                })
        })
        .collect())
}

/// What a drain did with queued updates of one lineage that is not the
/// head's.
#[derive(Default)]
struct OffHeadRows {
    /// Rows applied to their archive, or kept by no lineage, that the
    /// drain's cleanup removes.
    drained: Vec<(String, i64)>,
    /// Refusals of rows the archive would not take, which the drain's
    /// cleanup persists as it removes their rows.
    refused: Vec<crate::ReplicationRefusal>,
    /// What those rows committed to Collection records when a drain applied
    /// them to the head, before their lineage changed.
    record_facts: Vec<dohc_engine_domain::CollectionRecordApplyFacts>,
    /// Released tails protect the archived lineage, so the rest stay queued.
    held: bool,
    /// The hold the document is left with for them, when one stands.
    hold: Option<crate::HostedHold>,
}

/// Apply `rows`, queued updates of one of `key`'s lineages that is not the
/// head's, in order and a batch at a time, to the archive that keeps it. A
/// lineage with no archive keeps nothing of them. Released tails that
/// protect the archived lineage, decided from the tails before anything of
/// it loads, keep the rest queued and hold the document with the first
/// one's binding. [`SyncError::ValidationPending`] while those tails wait for
/// validation. `consumed` are the rows the drain already took.
#[allow(clippy::too_many_arguments)]
fn drain_off_head_rows(
    store: &mut EngineStore,
    key: &DocKey,
    rows: &[DeferredRow],
    tails: &ReleasedTails,
    search_policy: Option<&SearchPolicySnapshot>,
    faults: &dyn FaultInjector,
    recovery_leases: Option<&dyn crate::LeaseProbe>,
    consumed: &[(String, i64)],
) -> Result<OffHeadRows, SyncError> {
    enum Decided {
        Absent,
        Held(Option<crate::HostedHold>),
        Applied(Vec<Option<String>>),
    }
    let mut result = OffHeadRows::default();
    let mut next = 0;
    while next < rows.len() {
        let rest = &rows[next..];
        let decided = store.write_with(faults, |tx| {
            if let Some(leases) = recovery_leases {
                require_recovery_closed(tx, key, leases)?;
            }
            let lineage = &rest[0].4;
            if !inactive_lineage_exists(tx, key, lineage)? {
                return Ok(Decided::Absent);
            }
            if let Some(tails) = archived_protection(tx, key, lineage, tails)? {
                return hold_archived_rows_in_tx(tx, key, lineage, &rest[0], tails, consumed)
                    .map(Decided::Held);
            }
            let (mut taken, mut bytes) = (0, 0);
            for (.., payload, _) in rest {
                let length: Option<i64> = tx
                    .query_row(
                        "SELECT byte_length FROM binary_blobs WHERE sha256=?1",
                        [&payload.update_blob_sha256],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let length = usize::try_from(length.ok_or(SyncError::BlobInvalid)?)
                    .map_err(SyncError::corrupt)?;
                if taken > 0 && bytes + length > ARCHIVED_BATCH_BYTES {
                    break;
                }
                (taken, bytes) = (taken + 1, bytes + length);
            }
            apply_archived_rows_in_tx(tx, key, &rest[..taken], search_policy).map(Decided::Applied)
        })?;
        match decided {
            TxnOutcome::Crashed { .. } => return Err(SyncError::FaultCrash),
            TxnOutcome::Committed(Decided::Absent) => {
                for (origin_id, origin_seq, ..) in rest {
                    result.record_facts.extend(read_parked_record_facts(
                        store,
                        key,
                        origin_id,
                        *origin_seq,
                    )?);
                    match parked_refusal(store, key, origin_id, *origin_seq)? {
                        Some(reason) => result.refused.push(deferred_ydoc_refusal(
                            key,
                            origin_id,
                            *origin_seq,
                            reason,
                        )),
                        None => result.drained.push((origin_id.clone(), *origin_seq)),
                    }
                }
                break;
            }
            TxnOutcome::Committed(Decided::Held(hold)) => {
                (result.held, result.hold) = (true, hold);
                break;
            }
            TxnOutcome::Committed(Decided::Applied(reasons)) => {
                next += reasons.len();
                for ((origin_id, origin_seq, ..), reason) in rest.iter().zip(reasons) {
                    result.record_facts.extend(read_parked_record_facts(
                        store,
                        key,
                        origin_id,
                        *origin_seq,
                    )?);
                    // A refusal its head apply was owed stands as it was,
                    // whatever the archive decides.
                    let parked = parked_refusal(store, key, origin_id, *origin_seq)?;
                    match parked.or(reason) {
                        Some(reason) => result.refused.push(deferred_ydoc_refusal(
                            key,
                            origin_id,
                            *origin_seq,
                            reason,
                        )),
                        None => result.drained.push((origin_id.clone(), *origin_seq)),
                    }
                }
            }
        }
    }
    Ok(result)
}

/// Apply `bytes` to the archived lineage `payload` names, if it has one; its
/// refusal names the update. The caller has decided its protection.
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

/// Apply `updates` to the archived lineage `payload` names, if it has one.
/// Its caller decides first whether released tails protect that lineage.
/// Nothing inspects it against the active head, which is another lineage.
fn apply_inactive_batch_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    payload: &YdocUpdatePayload,
    updates: &[Vec<u8>],
    now_ms: i64,
    search_policy: Option<&SearchPolicySnapshot>,
) -> Result<InactiveDeltaOutcome, SyncError> {
    let archived: Option<InactiveLineage> = tx.query_row(
        "SELECT b.bytes,l.content_kind,l.last_surfaced_projection_sha256,l.path,l.full_state_blob_sha256,l.state_vector_blob_sha256,l.pending_authors_json FROM ydoc_inactive_lineages l \
         JOIN binary_blobs b ON b.sha256=l.full_state_blob_sha256 \
         WHERE l.workspace_id=?1 AND l.version_id=?2 AND l.object_id=?3 AND l.lineage_claim_id=?4",
        params![key.workspace_id,key.version_id,key.object_id,payload.lineage_claim_id],
        |row| Ok(InactiveLineage { bytes:row.get(0)?,kind:row.get(1)?,surfaced:row.get(2)?,path:row.get(3)?,full_sha:row.get(4)?,vector_sha:row.get(5)?,pending_authors:row.get(6)? }),
    ).optional().map_err(SyncError::corrupt)?;
    let Some(InactiveLineage {
        bytes: prior,
        kind,
        surfaced,
        path,
        full_sha: old_full_sha,
        vector_sha: old_vector_sha,
        pending_authors,
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
                (pending_authors != "[]").then_some(pending_authors.as_str()),
                now_ms,
                search_policy,
            )?;
            tx.execute(
                "UPDATE ydoc_inactive_lineages SET last_surfaced_projection_sha256=?5,pending_authors_json='[]' \
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
        } else if pending_authors != "[]" {
            tx.execute(
                "UPDATE ydoc_inactive_lineages SET pending_authors_json='[]' \
                 WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3 AND lineage_claim_id=?4",
                params![
                    key.workspace_id,
                    key.version_id,
                    key.object_id,
                    payload.lineage_claim_id
                ],
            )
            .map_err(SyncError::persist)?;
        }
        Ok::<_, SyncError>(())
    })();
    let refusal = match projection {
        Ok(()) => {
            if rejected.len() < updates.len() {
                crate::refusal_notices::clear_lineage_in_tx(
                    tx,
                    &key.workspace_id,
                    &key.version_id,
                    &key.object_id,
                    &payload.lineage_claim_id,
                )?;
            }
            None
        }
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
    author_json: Option<&str>,
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
            author_json: author_json.map(str::to_owned),
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
    text::insert(tx, sha256, content.len() as i64, content, true).map_err(SyncError::persist)?;
    Ok(())
}

struct AuthorizedSceneAsset {
    bytes: Vec<u8>,
    byte_length: usize,
}

pub(crate) enum SceneAssetWait {
    Head { path: String, sha256: String },
    Blob { sha256: String },
}

pub(crate) struct SceneProjectionError {
    pub error: SyncError,
    pub waiting_asset: Option<SceneAssetWait>,
}

impl From<SyncError> for SceneProjectionError {
    fn from(error: SyncError) -> Self {
        Self {
            error,
            waiting_asset: None,
        }
    }
}

impl SceneProjectionError {
    fn head_pending(asset: &dohc_engine_collab::SceneAsset) -> Self {
        Self {
            error: SyncError::RetryableState {
                reason: "scene asset head is pending",
            },
            waiting_asset: Some(SceneAssetWait::Head {
                path: asset.path.clone(),
                sha256: asset.sha256.clone(),
            }),
        }
    }

    fn blob_pending(asset: &dohc_engine_collab::SceneAsset) -> Self {
        Self {
            error: SyncError::RetryableState {
                reason: "scene asset blob is pending",
            },
            waiting_asset: Some(SceneAssetWait::Blob {
                sha256: asset.sha256.clone(),
            }),
        }
    }
}

fn authorize_scene_asset_with_store(
    conn: &Connection,
    key: &DocKey,
    asset: &dohc_engine_collab::SceneAsset,
) -> Result<AuthorizedSceneAsset, SceneProjectionError> {
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
        }
        .into());
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
                }
                .into());
            }
            byte_length.ok_or_else(|| SceneProjectionError::blob_pending(asset))?
        }
        None => retired_scene_asset_byte_length(conn, key, &asset.path, &asset.sha256)?
            .ok_or_else(|| SceneProjectionError::head_pending(asset))?,
    }
    .try_into()
    .map_err(|_| SyncError::InvalidInput {
        reason: "scene asset authority is invalid",
    })?;
    let bytes = get_binary_blob(conn, &asset.sha256)
        .map_err(SyncError::from)?
        .ok_or_else(|| SceneProjectionError::blob_pending(asset))?;
    if hex_sha256(&bytes) != asset.sha256 {
        return Err(SyncError::InvalidInput {
            reason: "scene asset authority is invalid",
        }
        .into());
    }
    Ok(AuthorizedSceneAsset { bytes, byte_length })
}

/// Verify that a scene asset belongs to this lineage and has its exact blob.
pub fn validate_scene_asset_with_store(
    conn: &Connection,
    key: &DocKey,
    asset: &dohc_engine_collab::SceneAsset,
) -> Result<(), SyncError> {
    authorize_scene_asset_with_store(conn, key, asset)
        .map(|_| ())
        .map_err(|failure| failure.error)
}

/// The text of the object's current snapshot in its version: the file the
/// last settle or capture left on disk.
fn local_snapshot_text(conn: &Connection, key: &DocKey) -> Result<Option<String>, SyncError> {
    conn.query_row(
        "SELECT b.sha256 FROM snapshots s JOIN blobs b ON b.sha256 = s.blob_sha256 \
         WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.object_id = ?3 \
           AND s.content_kind = 'text'",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| text::optional_from_row(conn, row, 0),
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
    project_ydoc_inner(conn, key, doc, content_kind, None, false)
}

pub fn project_ydoc_with_reader(
    conn: &Connection,
    key: &DocKey,
    doc: &dohc_engine_collab::Ydoc,
    content_kind: dohc_engine_collab::ContentKind,
    resolver: Option<&dohc_engine_collab::reader_resolver::ReaderResolver>,
) -> Result<dohc_engine_collab::Projection, SyncError> {
    project_ydoc_inner(conn, key, doc, content_kind, resolver, true)
}

fn project_ydoc_inner(
    conn: &Connection,
    key: &DocKey,
    doc: &dohc_engine_collab::Ydoc,
    content_kind: dohc_engine_collab::ContentKind,
    resolver: Option<&dohc_engine_collab::reader_resolver::ReaderResolver>,
    resolve_witness: bool,
) -> Result<dohc_engine_collab::Projection, SyncError> {
    if content_kind != dohc_engine_collab::ContentKind::Scene {
        let mut projection = doc
            .project(content_kind)
            .map_err(|error| map_projection_error(error, "ydoc projection is invalid"))?;
        if content_kind == dohc_engine_collab::ContentKind::Richdoc {
            let source = if resolve_witness && doc.has_reader_source() {
                dohc_engine_collab::reader_resolver::resolve(
                    conn,
                    key,
                    doc,
                    &projection.content,
                    resolver,
                )
                .map_err(map_collab_hard_error)?
            } else {
                doc.settled_markdown_source(&projection.content, || local_snapshot_text(conn, key))?
            };
            if let Some(source) = source {
                projection.content = source;
            }
        }
        return Ok(projection);
    }
    project_scene_with_store(conn, key, doc).map_err(|failure| failure.error)
}

pub(crate) fn project_scene_with_store(
    conn: &Connection,
    key: &DocKey,
    doc: &dohc_engine_collab::Ydoc,
) -> Result<dohc_engine_collab::Projection, SceneProjectionError> {
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
            }
            .into());
        }
        bytes_by_id.insert(id.to_owned(), authorized.bytes);
    }
    let content = folded
        .portable_json_with_asset_bytes(&bytes_by_id)
        .map_err(|error| map_projection_error(error, "scene projection is invalid"))?;
    Ok(dohc_engine_collab::Projection {
        content,
        content_kind: dohc_engine_collab::ContentKind::Scene,
        source_state_vector_sha256: hex_sha256(&doc.encode_state_vector()),
        destructive: false,
    })
}

macro_rules! retired_scene_asset_sql {
    ($workspace:literal, $version:literal, $path:literal, $sha256:literal) => {
        concat!(
            "SELECT b.byte_length FROM moments deleted \
         JOIN moments producer ON producer.workspace_id=deleted.workspace_id \
           AND producer.moment_id=deleted.before_latest_moment_id \
         JOIN binary_blobs b ON b.sha256=deleted.before_binary_sha256 \
         WHERE deleted.workspace_id=",
            $workspace,
            " AND deleted.version_id=",
            $version,
            " AND deleted.path=",
            $path,
            // Repeat the partial-index predicate; all scene asset refs have this prefix, so results are unchanged.
            " \
           AND deleted.path GLOB 'assets/excalidraw/*' \
           AND deleted.operation='delete' AND COALESCE(deleted.sync_record_only,0)=0 \
           AND deleted.before_present=2 AND deleted.before_content_kind='binary' \
           AND deleted.before_binary_sha256=",
            $sha256,
            " AND deleted.payload_before_path=",
            $path,
            " \
           AND deleted.payload_before_content_kind='binary' \
           AND deleted.payload_before_blob_sha256=",
            $sha256,
            " \
           AND producer.version_id=deleted.version_id \
           AND producer.object_id=deleted.object_id \
           AND producer.operation='write' AND COALESCE(producer.sync_record_only,0)=0 \
           AND producer.after_content_kind='binary' \
           AND producer.after_binary_sha256=",
            $sha256,
            " AND producer.path=",
            $path,
            " \
           AND producer.payload_after_path=",
            $path,
            " \
           AND producer.payload_after_content_kind='binary' \
           AND producer.payload_after_blob_sha256=",
            $sha256,
            " \
           AND NOT EXISTS (SELECT 1 FROM moments newer \
             WHERE newer.workspace_id=deleted.workspace_id \
               AND newer.version_id=deleted.version_id AND newer.path=deleted.path ",
            // Repeat the partial-index predicate; all scene asset refs have this prefix, so results are unchanged.
            "AND newer.path GLOB 'assets/excalidraw/*' \
               AND COALESCE(newer.sync_record_only,0)=0 \
               AND ",
            dohc_engine_domain::exclude_capture_recovery_sql!("newer"),
            " \
               AND newer.moment_order>deleted.moment_order) \
         "
        )
    };
}
pub(crate) use retired_scene_asset_sql;

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
        concat!(
            retired_scene_asset_sql!("?1", "?2", "?3", "?4"),
            " ORDER BY deleted.moment_order DESC LIMIT 1"
        ),
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
fn require_resolved_local_settlement(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
    now_ms: i64,
) -> Result<(), SyncError> {
    let unresolved: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 \
         AND object_id=?3 AND settle_prior_update_seq IS NOT NULL)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if unresolved
        && !dohc_engine_collab::author_coverage::reconcile_in(tx, key, now_ms)
            .map_err(map_collab_hard_error)?
    {
        return Err(SyncError::RetryableState {
            reason: "settlement-materialization-pending",
        });
    }
    Ok(())
}

/// Returns whether this projection created a History moment.
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
) -> Result<bool, SyncError> {
    require_resolved_local_settlement(tx, key, now_ms)?;
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
    let lineage: Option<String> = tx.query_row(
        "SELECT lineage_claim_id FROM ydoc_docs WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id], |row| row.get(0),
    ).optional().map_err(SyncError::corrupt)?.flatten();
    if let Some(lineage) = lineage {
        crate::refusal_notices::clear_lineage_in_tx(
            tx,
            &key.workspace_id,
            &key.version_id,
            &key.object_id,
            &lineage,
        )?;
    }
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
        return Ok(false);
    }
    // A deterministic per-envelope id keeps a retained drain's retry on its
    // original History row, even after another write advances the head.
    let moment_id = ydoc_apply_moment_id(key, path, origin_id, origin_seq);
    // A retained drain can replay after its coverage was consumed or audited.
    // Reuse the recorded authors; the domain still checks all write identity fields.
    let recorded_authors: Option<Option<String>> = tx
        .query_row(
            "SELECT author_json FROM moments WHERE workspace_id=?1 AND moment_id=?2 \
             AND version_id=?3 AND object_id=?4 AND path=?5 AND metadata_origin='ydoc' \
             AND operation='write' AND COALESCE(sync_record_only,0)=0",
            params![
                key.workspace_id,
                moment_id,
                key.version_id,
                key.object_id,
                path
            ],
            |row| row.get(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let replayed = recorded_authors.is_some();
    // Converged content needs no new moment/job. Refresh the settled digest:
    // capture may have reached these bytes while that digest stayed behind,
    // which would leave the next settlement in ConflictStaleTarget.
    let projected_sha = dohc_engine_storage::hex_sha256(projection.content.as_bytes());
    if let Some(snapshot) = current
        .snapshot
        .as_ref()
        .filter(|snapshot| snapshot.blob_sha256 == projected_sha)
    {
        // The original projection already consumed its interval. A retry must
        // leave edits made afterward for their own settlement.
        if !replayed {
            dohc_engine_collab::author_coverage::advance_in(tx, key, false)
                .map_err(map_collab_hard_error)?;
        }
        tx.execute(
            "UPDATE ydoc_docs SET last_settled_sha = ?4, updated_at_ms = ?5, path = ?6 \
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
        return Ok(false);
    }
    let preimage = current
        .snapshot
        .as_ref()
        .map_or(Preimage::Absent, |snapshot| {
            Preimage::Present(snapshot.blob_sha256.clone())
        });
    let authors = match recorded_authors {
        Some(authors) => authors,
        None => dohc_engine_collab::author_coverage::interval_in(tx, key, i64::MAX)
            .map_err(map_collab_hard_error)?
            .moment_json(),
    };
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
            author_json: authors,
            now_ms,
            request_id: None,
        },
    )
    .map_err(|error| map_domain_payload_error(error, "ydoc.update projection write failed"))?;
    crate::live_audit::annotate_projected_moment_in_tx(tx, key, path, origin_id, origin_seq)?;
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
    // Later envelopes may supersede this disk projection; the history moment already covers its interval.
    if !(replayed && result.deduped) {
        dohc_engine_collab::author_coverage::advance_in(tx, key, false)
            .map_err(map_collab_hard_error)?;
    }
    // The pulled projection IS the settled artifact (its job materializes
    // it): advance the marker exactly like a local settle would. Leaving the
    // old locally-settled sha behind would make the next session's settle
    // expectation trail the remote head — permanent ConflictStaleTarget.
    tx.execute(
        "UPDATE ydoc_docs SET settle_seq = ?4, last_settled_sha = ?5, updated_at_ms = ?6, \
         path = ?7 \
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
    Ok(!result.deduped)
}

pub fn apply_ydoc_envelope(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    apply_ydoc_envelope_in_batch(store, cache, envelope, faults, leases, false, None)
}

/// `relay_namespace` names the feed a pull read `envelope` from, when the
/// pull's trusted configuration names one.
pub(crate) fn apply_ydoc_envelope_in_batch(
    store: &mut EngineStore,
    cache: &mut WriterDocCache,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
    leases: &dyn LeaseProbe,
    batch_inactive: bool,
    relay_namespace: Option<&str>,
) -> Result<ApplyOutcome<YdocApplyResult>, SyncError> {
    const REDELIVERY_PROBE: &str = "ydoc-redelivery-probe";
    let tails = &cache.released_tails(store);
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
    let Some(relay_seq) = envelope.relay_seq else {
        return Err(SyncError::RetryableState {
            reason: "pulled ydoc.update is missing its relay sequence",
        });
    };
    let has_deferred_updates = store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM ydoc_deferred_updates \
             WHERE workspace_id=?1 AND version_id=?2 AND object_id=?3)",
            params![key.workspace_id, key.version_id, key.object_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(SyncError::corrupt)
    })?;
    let live_lease = !payload.is_base_state && leases.is_live(&key);
    let cheap_probe_allowed = !payload.is_base_state
        && dohc_engine_collab::read_marker(store, &key)
            .map_err(map_collab_hard_error)?
            .is_some_and(|marker| {
                marker.regime == dohc_engine_collab::Regime::Replicated
                    && marker.lineage_claim_status == dohc_engine_collab::LineageClaimStatus::Exact
                    && marker.lineage_claim_id.as_deref() == Some(payload.lineage_claim_id.as_str())
            });
    if !has_deferred_updates
        && cheap_probe_allowed
        && crate::apply::is_acknowledged_envelope(store, envelope)?
    {
        // Live admission checks blob integrity before its transactional skip.
        // Keep that check while avoiding full-document replay of a durable echo.
        if live_lease {
            let bytes: Option<Vec<u8>> = store.read_with(|conn| {
                conn.query_row(
                    "SELECT bytes FROM binary_blobs WHERE sha256=?1",
                    [&payload.update_blob_sha256],
                    |row| row.get(0),
                )
                .optional()
                .map_err(SyncError::corrupt)
            })?;
            if bytes.is_none_or(|bytes| hex_sha256(&bytes) != payload.update_blob_sha256) {
                return Err(SyncError::BlobInvalid);
            }
        }
        let probe = crate::apply::apply_envelope_with_mutation_outcome::<()>(
            store,
            envelope,
            faults,
            |_tx, _op| {
                Err(SyncError::RetryableState {
                    reason: REDELIVERY_PROBE,
                })
            },
        );
        match probe {
            Ok(outcome) => {
                // The probe closure always returns RetryableState, so Applied
                // cannot occur unless admission semantics change.
                return Ok(outcome.map(|()| unreachable!("redelivery probe applied")));
            }
            Err(SyncError::RetryableState { reason }) if reason == REDELIVERY_PROBE => {}
            Err(error) => return Err(error),
        }
    }
    // A non-acknowledged or divergent row takes the full integrity path.
    // Normal blob writes verify their claimed digest, so a changed payload
    // cannot enter the cheap exact-envelope path.
    // Missing or corrupt blobs, and all divergent envelopes, remain on the
    // full path so their coordinate stays retryable.
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
    if let Some(echo) =
        store.read_with(|conn| live_ordinary_classification(conn, &key, &payload, &bytes))?
    {
        return crate::apply::apply_envelope_with_mutation_outcome(
            store,
            envelope,
            faults,
            |tx, op| {
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
                } else if keeps_unadmitted(tx, &key, &payload)? {
                    defer_ydoc_update_in_tx(
                        tx,
                        &key,
                        op,
                        &payload.lineage_claim_id,
                        relay_seq,
                        relay_namespace,
                    )?;
                    crate::hosted::hold_unadmitted_in_tx(tx, &key.workspace_id, &key.object_id)?;
                    Ok(crate::apply::MutationOutcome::Applied(YdocApplyResult {
                        deferred: true,
                        reason: Some("ydoc-live-edit-unadmitted"),
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
    if !payload.is_base_state
        && store.read_with(|conn| inactive_lineage_exists(conn, &key, &payload.lineage_claim_id))?
    {
        // What a protected archive would take stays in the feed, unqueued.
        let mut outcome = crate::apply_envelope_with(store, envelope, faults, |tx, op| {
            hold_archived_lineage(
                tx,
                &key,
                &payload.lineage_claim_id,
                op,
                Some(relay_seq),
                relay_namespace,
                tails,
            )?;
            defer_ydoc_update_in_tx(
                tx,
                &key,
                op,
                &payload.lineage_claim_id,
                relay_seq,
                relay_namespace,
            )?;
            Ok(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-inactive-lineage"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: Vec::new(),
            })
        })?;
        if !batch_inactive && !leases.is_live(&key) {
            let drained = drain_inactive_ydoc_updates(
                store,
                InactiveScope::Document(&key, &[]),
                tails,
                &mut Vec::new(),
                DrainReporting::Returned,
                faults,
            )?;
            // The envelope's own refusal decides its disposition first; the
            // other rows the drain removed still report what they parked.
            let (own, others): (Vec<_>, Vec<_>) =
                drained.refusals.into_iter().partition(|refusal| {
                    refusal.origin_id == envelope.origin_id
                        && refusal.origin_seq == envelope.origin_seq
                });
            if let Some(refusal) = own.into_iter().next() {
                outcome.primary = ApplyDisposition::Refused(refusal);
            }
            outcome.refusals.extend(others);
            outcome = merge_drained(outcome, drained.record_facts);
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
            defer_ydoc_update_in_tx(
                tx,
                &deferred_key,
                op,
                &payload.lineage_claim_id,
                relay_seq,
                relay_namespace,
            )?;
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
            if let Some(lineage) = dohc_engine_collab::read_marker_in(tx, &claim_key)
                .map_err(map_collab_hard_error)?
                .and_then(|marker| marker.lineage_claim_id)
            {
                hold_released_lineage(
                    tx,
                    &claim_key,
                    &lineage,
                    op,
                    Some(relay_seq),
                    relay_namespace,
                    tails,
                    Incoming::Replacement,
                )?;
            }
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
            let losing_authors = if losing_projection.is_some() {
                dohc_engine_collab::author_coverage::reserved_in(tx, &claim_key)
                    .map_err(map_collab_hard_error)?
                    .moment_json()
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
                dohc_engine_collab::author_coverage::reset_in(tx, &claim_key, false)
                    .map_err(map_collab_hard_error)?;
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
                losing_authors.as_deref(),
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
    // What arrives behind queued work the drain held queues behind it, in
    // order, so nothing changes the head the hold names before its turn.
    if drain.released_hold.is_some() {
        let deferred_key = key.clone();
        let outcome = crate::apply_envelope_with(store, envelope, faults, |tx, op| {
            defer_ydoc_update_in_tx(
                tx,
                &deferred_key,
                op,
                &payload.lineage_claim_id,
                relay_seq,
                relay_namespace,
            )?;
            Ok(YdocApplyResult {
                deferred: true,
                reason: Some("ydoc-released-hold-queued"),
                conflicts_opened: 0,
                lineage_replacement: None,
                record_facts: Vec::new(),
            })
        })?;
        let mut outcome = merge_drained_first(
            merge_lineage_replacements(outcome, drain.lineage_replacements, drain.conflicts_opened),
            drain.record_facts,
        );
        outcome.sharing_declined.extend(drain.sharing_declined);
        outcome.refusals.extend(drain.refusals);
        return Ok(outcome);
    }
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
                    if inactive_lineage_exists(tx, &deferred_key, &payload.lineage_claim_id)? {
                        hold_archived_lineage(
                            tx,
                            &deferred_key,
                            &payload.lineage_claim_id,
                            op,
                            Some(relay_seq),
                            relay_namespace,
                            tails,
                        )?;
                    }
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
                    defer_ydoc_update_in_tx(
                        tx,
                        &deferred_key,
                        op,
                        &payload.lineage_claim_id,
                        relay_seq,
                        relay_namespace,
                    )?;
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
                    if let Some(lineage) = marker.lineage_claim_id.as_deref() {
                        hold_released_lineage(
                            tx,
                            &key,
                            lineage,
                            op,
                            Some(relay_seq),
                            relay_namespace,
                            tails,
                            Incoming::Replacement,
                        )?;
                    }
                    if inactive_lineage_exists(tx, &key, &payload.lineage_claim_id)? {
                        hold_archived_lineage(
                            tx,
                            &key,
                            &payload.lineage_claim_id,
                            op,
                            Some(relay_seq),
                            relay_namespace,
                            tails,
                        )?;
                    }
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
    let outcome_result = crate::apply::apply_envelope_with_mutation_outcome(
        store,
        envelope,
        faults,
        |tx, op| {
            hold_released_lineage(
                tx,
                &key,
                &payload.lineage_claim_id,
                op,
                Some(relay_seq),
                relay_namespace,
                tails,
                Incoming::Update {
                    bytes: &remote.bytes,
                    path: &update_path,
                },
            )?;
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
            let provisional_author = projected.introduced_unattributed;
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
                let projection_moment_id =
                    ydoc_apply_moment_id(&key, &update_path, &op.origin_id, op.origin_seq);
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
                    Ok(created) => {
                        if created && provisional_author {
                            // One outstanding audit request per document. The next
                            // interval advance, reset, audit or rollback removes it.
                            tx.execute(
                                "INSERT INTO engine_requests(request_id,payload_hash,result_seq,committed_at,kind) \
                                 VALUES ('sync-ydoc-provisional-author:'||json_array(?1,?2,?3),?4,?5,?6,'sync-ydoc-provisional-author') \
                                 ON CONFLICT(request_id) DO UPDATE SET payload_hash=excluded.payload_hash, \
                                 result_seq=excluded.result_seq,committed_at=excluded.committed_at \
                                 WHERE engine_requests.kind='sync-ydoc-provisional-author'",
                                params![key.workspace_id,key.version_id,key.object_id,projection_moment_id,op.origin_seq,op.recorded_at_ms],
                            ).map_err(SyncError::persist)?;
                        }
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
        },
    );
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
            shared_author: None,
            live_cursor: None,
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
            object_id: "notes/drained.md".to_owned(),
            version_id: "main".to_owned(),
            lineage_pruned: false,
            head_blob_sha256: None,
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
            object_id: "notes/primary.md".to_owned(),
            version_id: "main".to_owned(),
            lineage_pruned: false,
            head_blob_sha256: None,
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

/// The lineage's last settled text, or its seed source before any settle.
fn last_settled_text_in_tx(
    tx: &rusqlite::Transaction<'_>,
    key: &DocKey,
) -> Result<Option<String>, SyncError> {
    tx.query_row(
        "SELECT b.sha256 FROM ydoc_docs d JOIN blobs b \
         ON b.sha256=COALESCE(d.last_settled_sha, \
           CASE WHEN d.settle_seq=0 THEN d.seed_source_sha256 END) \
         WHERE d.workspace_id=?1 AND d.version_id=?2 AND d.object_id=?3",
        params![key.workspace_id, key.version_id, key.object_id],
        |row| text::optional_from_row(tx, row, 0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(SyncError::corrupt)
}

fn markdown_body(markdown: &str) -> &str {
    dohc_engine_domain::collections::markdown_frontmatter_json_with_body(markdown)
        .map_or(markdown, |(_, body)| body)
}

fn map_fold_edit_error(error: CollabError) -> SyncError {
    match error {
        CollabError::UpdateTooLarge { actual, max } => SyncError::BlobTooLarge {
            constraint: "MAX_YDOC_UPDATE_BYTES (conflict resolution fold)",
            limit_bytes: max,
            observed_bytes: actual,
        },
        CollabError::ProjectionTooLarge { actual, max } => SyncError::BlobTooLarge {
            constraint: "MAX_TEXT_BYTES (conflict resolution fold)",
            limit_bytes: max,
            observed_bytes: actual,
        },
        CollabError::MarkdownQuoteDepthExceeded | CollabError::MarkdownNotRepresentable => {
            SyncError::InvalidInput {
                reason: "ydoc-resolution-not-representable",
            }
        }
        CollabError::MarkdownRewriteUnsupported { .. } => SyncError::InvalidInput {
            reason: "the content kind does not support Markdown conflict resolution",
        },
        other => map_collab_payload_error(other, "Markdown conflict resolution fold failed"),
    }
}

fn map_collab_payload_error(error: CollabError, reason: &'static str) -> SyncError {
    match error {
        CollabError::AuthorCapacity => SyncError::RetryableState {
            reason: "ydoc-author-capacity",
        },
        CollabError::AuthorEntryTooLarge => SyncError::InvalidInput {
            reason: "Y.Doc author entry exceeds its metadata limit",
        },
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

pub(crate) fn map_collab_hard_error(error: CollabError) -> SyncError {
    match error {
        CollabError::MarkdownReaderPending(pending) => SyncError::MarkdownReaderPending(pending),
        CollabError::MarkdownReaderUnavailable => SyncError::RetryableState {
            reason: "dohc could not verify this file. Try again.",
        },
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

    #[test]
    fn remote_live_admission_preserves_human_automation_attribution() {
        let human = dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Human,
            on_behalf_of: Some("forged-person".into()),
            depth: 0,
            run: None,
        };
        assert!(valid_attribution(Some(&human)));
        let agent = dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
            ..human
        };
        assert!(valid_attribution(Some(&agent)));
        assert!(valid_attribution(None));
    }

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
    fn a_fold_source_full_state_size_failure_maps_to_blob_too_large() {
        let doc = dohc_engine_collab::Ydoc::wire();
        // Both individual edits fit. Tombstones retained under skip_gc make
        // their combined full state exceed the wire cap before source staging.
        let text = "x".repeat(8_500_000);
        doc.rewrite_content_to_markdown(ContentKind::Richdoc, &text)
            .unwrap();
        doc.rewrite_content_to_markdown_for_fold(ContentKind::Richdoc, &text)
            .unwrap();
        let error = doc
            .preserve_folded_markdown_source(&format!("{text}\n"))
            .unwrap_err();
        assert!(matches!(error, CollabError::UpdateTooLarge { .. }));
        assert!(matches!(
            map_fold_edit_error(error),
            SyncError::BlobTooLarge {
                limit_bytes: dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES,
                ..
            }
        ));
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
