//! Replicated conflict.open/conflict.resolve application.
//!
//! Conflict content writes/deletes normally replicate as ordered moment
//! operations. A keep-current resolution has no origin-side content moment,
//! however, so a mirrored sync resolve applies its recorded resolved text in
//! this same transaction before closing the row. For independently minted sync
//! conflicts, current/incoming are swapped between peers. Unsupported mirrored
//! resolution semantics are acknowledged but left open for later reconciliation.

use dohc_engine_domain::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictRowUpdate, ConflictStatus, DeleteTextFile, DomainError, TextConflict, TextSnapshot,
    WriteBinaryFile, WriteText, delete_text_in_tx, enqueue_delete, enqueue_write,
    file_states_equal, insert_text_conflict_if_absent, live_state_matches_conflict_current,
    load_text_conflict_in_tx, update_text_conflict_row, validate_delete_input,
    validate_write_input, write_binary_file_in_tx, write_text_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultInjector, Preimage};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

use crate::error::local_corruption;
use crate::{ApplyOutcome, ReplicationEnvelope, SyncError, apply_envelope_with};

/// Result details callers surface instead of silently swallowing an unmatched
/// replicated resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictApplyResult {
    pub conflict_id: String,
    pub inserted: Option<bool>,
    pub matched: bool,
    pub pending_resolve: Option<PendingResolve>,
}

impl ConflictApplyResult {
    /// Backward-compatible boolean view of the structured pending surface.
    pub fn deferred(&self) -> bool {
        self.pending_resolve.is_some()
    }
}

/// A replicated resolution that was acknowledged but deliberately not
/// applied. It remains available for a later human/review layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingResolve {
    pub remote_conflict_id: String,
    pub local_conflict_id: Option<String>,
    pub path: Option<String>,
    pub reason: PendingResolveReason,
}

/// The fail-closed reasons surfaced by mirrored conflict application.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PendingResolveReason {
    PathChange,
    Merged,
    StaleHead,
    /// The incoming binary side's bytes are not hydrated yet (no sha, or the
    /// blob is absent). A pure pre-check state — nothing was attempted.
    BinaryUnhydrated,
    /// The incoming binary side was present but the write helper rejected it
    /// (object-id collision, missing version, non-normalized path, …). Distinct
    /// from `BinaryUnhydrated`: the apply was attempted and rolled back.
    BinaryApplyFailed,
    /// A mirrored text write/delete was rejected by validation (reserved or
    /// ignored path, over the byte cap, …). The apply was rolled back and the
    /// row deferred so the ack still advances rather than Err-stalling the peer.
    TextApplyRejected,
    /// A peer `conflict.resolve` matched no local conflict (neither by id nor by
    /// swapped heads). The envelope is journaled + acked so the cursor advances,
    /// but the unmatched remote decision is surfaced rather than silently lost.
    UnmatchedTarget,
}

pub fn apply_conflict_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<ConflictApplyResult>, SyncError> {
    if !matches!(
        envelope.op_kind.as_str(),
        "conflict.open" | "conflict.resolve"
    ) {
        return Err(SyncError::UnsupportedOperation);
    }
    apply_envelope_with(store, envelope, faults, |tx, op| {
        let result = match op.op_kind.as_str() {
            "conflict.open" => apply_open(tx, op),
            "conflict.resolve" => apply_resolve(tx, op),
            _ => Err(SyncError::UnsupportedOperation),
        }?;
        if let Some(pending) = result.pending_resolve.as_ref() {
            persist_pending_resolve(tx, op, pending)?;
        }
        Ok(result)
    })
}

pub(crate) fn read_replayed_pending_resolve(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Option<PendingResolve>, SyncError> {
    if envelope.op_kind != "conflict.resolve" {
        return Ok(None);
    }
    store.read_with(|conn| {
        conn.query_row(
            "SELECT remote_conflict_id, local_conflict_id, path, reason \
             FROM replication_pending_resolves \
             WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
            params![
                envelope.workspace_id,
                envelope.origin_id,
                envelope.origin_seq
            ],
            |row| {
                let reason: String = row.get(3)?;
                Ok(PendingResolve {
                    remote_conflict_id: row.get(0)?,
                    local_conflict_id: row.get(1)?,
                    path: row.get(2)?,
                    reason: pending_resolve_reason(&reason)?,
                })
            },
        )
        .optional()
        .map_err(SyncError::corrupt)
    })
}

pub(crate) fn redelivered_conflicts_opened(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<i64, SyncError> {
    if envelope.op_kind != "conflict.open" {
        return Ok(0);
    }
    let payload: OpenPayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "conflict.open payload is malformed",
        })?;
    store.read_with(|conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM conflicts \
             WHERE workspace_id=?1 AND conflict_id=?2)",
            params![envelope.workspace_id, payload.id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })
}

pub(crate) fn persist_pending_resolve(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    pending: &PendingResolve,
) -> Result<(), SyncError> {
    tx.execute(
        "INSERT INTO replication_pending_resolves \
         (workspace_id,origin_id,origin_seq,remote_conflict_id,local_conflict_id,path,reason) \
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![
            envelope.workspace_id,
            envelope.origin_id,
            envelope.origin_seq,
            pending.remote_conflict_id,
            pending.local_conflict_id,
            pending.path,
            pending_resolve_reason_str(pending.reason)
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

const fn pending_resolve_reason_str(reason: PendingResolveReason) -> &'static str {
    match reason {
        PendingResolveReason::PathChange => "path-change",
        PendingResolveReason::Merged => "merged",
        PendingResolveReason::StaleHead => "stale-head",
        PendingResolveReason::BinaryUnhydrated => "binary-unhydrated",
        PendingResolveReason::BinaryApplyFailed => "binary-apply-failed",
        PendingResolveReason::TextApplyRejected => "text-apply-rejected",
        PendingResolveReason::UnmatchedTarget => "unmatched-target",
    }
}

fn pending_resolve_reason(value: &str) -> rusqlite::Result<PendingResolveReason> {
    match value {
        "path-change" => Ok(PendingResolveReason::PathChange),
        "merged" => Ok(PendingResolveReason::Merged),
        "stale-head" => Ok(PendingResolveReason::StaleHead),
        "binary-unhydrated" => Ok(PendingResolveReason::BinaryUnhydrated),
        "binary-apply-failed" => Ok(PendingResolveReason::BinaryApplyFailed),
        "text-apply-rejected" => Ok(PendingResolveReason::TextApplyRejected),
        "unmatched-target" => Ok(PendingResolveReason::UnmatchedTarget),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MetadataPayload {
    origin: String,
    summary: Option<String>,
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SidePayload {
    exists: bool,
    path: String,
    object_id: Option<String>,
    content_kind: Option<String>,
    sha256: Option<String>,
    text: Option<String>,
    updated_at_ms: Option<i64>,
    latest_moment_id: Option<String>,
    metadata: Option<MetadataPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPayload {
    id: String,
    workspace_id: String,
    path: String,
    target_version_id: String,
    source_version_id: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    base: SidePayload,
    current: SidePayload,
    incoming: SidePayload,
    status: String,
    chosen_from: String,
    metadata: MetadataPayload,
    resolution: Option<String>,
}

fn apply_open(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<ConflictApplyResult, SyncError> {
    let payload: OpenPayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "conflict.open payload is malformed",
        })?;
    if payload.workspace_id != envelope.workspace_id {
        return Err(SyncError::InvalidInput {
            reason: "conflict.open workspace does not match its envelope",
        });
    }
    if payload.status != "open" || payload.resolution.is_some() {
        return Err(SyncError::InvalidInput {
            reason: "conflict.open must describe an unresolved conflict",
        });
    }
    let conflict = TextConflict {
        conflict_id: payload.id,
        workspace_id: payload.workspace_id,
        path: payload.path,
        target_version_id: payload.target_version_id.clone(),
        source_version_id: payload.source_version_id.clone(),
        created_at_ms: payload.created_at_ms,
        updated_at_ms: payload.updated_at_ms,
        status: ConflictStatus::Open,
        chosen_from: parse_choice(&payload.chosen_from)?,
        resolution: None,
        metadata: metadata(payload.metadata),
        base: side(
            payload.base,
            &envelope.workspace_id,
            &payload.source_version_id,
        )?,
        current: side(
            payload.current,
            &envelope.workspace_id,
            &payload.target_version_id,
        )?,
        incoming: side(
            payload.incoming,
            &envelope.workspace_id,
            &payload.source_version_id,
        )?,
    };
    let inserted = insert_text_conflict_if_absent(tx, &conflict).map_err(map_domain)?;
    Ok(ConflictApplyResult {
        conflict_id: conflict.conflict_id,
        inserted: Some(inserted),
        matched: true,
        pending_resolve: None,
    })
}

fn side(
    payload: SidePayload,
    workspace_id: &str,
    version_id: &str,
) -> Result<ConflictFileState, SyncError> {
    let content_kind = match payload.content_kind.as_deref().unwrap_or("text") {
        "text" => ConflictContentKind::Text,
        "binary" => ConflictContentKind::Binary,
        _ => {
            return Err(SyncError::InvalidInput {
                reason: "conflict side content kind is invalid",
            });
        }
    };
    let side_metadata = payload.metadata;
    let snapshot = if payload.exists {
        let object_id = required(payload.object_id, "conflict side object id is missing")?;
        let updated_at_ms = required(payload.updated_at_ms, "conflict side timestamp is missing")?;
        let latest_moment_id = required(
            payload.latest_moment_id,
            "conflict side latest moment is missing",
        )?;
        let metadata_origin = side_metadata
            .as_ref()
            .map(|value| value.origin.clone())
            .unwrap_or_else(|| "unknown".to_owned());
        let text = match content_kind {
            ConflictContentKind::Text => {
                required(payload.text, "conflict text side content is missing")?
            }
            ConflictContentKind::Binary => payload.text.unwrap_or_default(),
        };
        let blob_sha256 = match content_kind {
            ConflictContentKind::Text => {
                let actual = dohc_engine_storage::hex_sha256(text.as_bytes());
                if payload
                    .sha256
                    .as_deref()
                    .is_some_and(|claimed| claimed != actual)
                {
                    return Err(SyncError::InvalidInput {
                        reason: "conflict text side hash does not match its content",
                    });
                }
                actual
            }
            ConflictContentKind::Binary => {
                required(payload.sha256, "binary conflict side hash is missing")?
            }
        };
        Some(TextSnapshot {
            workspace_id: workspace_id.to_owned(),
            version_id: version_id.to_owned(),
            object_id,
            path: payload.path.clone(),
            text,
            blob_sha256,
            updated_at_ms,
            latest_moment_id,
            metadata_origin,
            metadata_summary: side_metadata
                .as_ref()
                .and_then(|value| value.summary.clone()),
            metadata_correlation_id: side_metadata
                .as_ref()
                .and_then(|value| value.correlation_id.clone()),
        })
    } else {
        None
    };
    Ok(ConflictFileState {
        path: payload.path,
        snapshot,
        // Binary mirror-apply payloads are not wired through this replication
        // path yet (R10-CONFLICT-COMPLETE's job); a binary side built here
        // always fails closed downstream in `insert_text_conflict_if_absent`
        // for lacking a blob reference, same as before BINCONFLICT.
        binary_sha256: None,
        binary_byte_length: None,
        binary_object_id: None,
        binary_latest_moment_id: None,
        content_kind,
        metadata_summary: side_metadata
            .as_ref()
            .and_then(|value| value.summary.clone()),
        metadata_correlation_id: side_metadata.and_then(|value| value.correlation_id),
    })
}

fn required<T>(value: Option<T>, reason: &'static str) -> Result<T, SyncError> {
    value.ok_or(SyncError::InvalidInput { reason })
}

fn metadata(payload: MetadataPayload) -> ConflictMetadata {
    ConflictMetadata {
        origin: payload.origin,
        summary: payload.summary,
        correlation_id: payload.correlation_id,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolvePayload {
    conflict_id: String,
    status: String,
    chosen_from: String,
    resolution: String,
    updated_at_ms: i64,
    target_version_id: Option<String>,
    path: Option<String>,
    current_latest_moment_id: Option<String>,
    incoming_latest_moment_id: Option<String>,
}

struct ResolveTarget {
    conflict_id: String,
    path: String,
    metadata_origin: String,
    status: String,
    chosen_from: String,
    resolution: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MirroredOutcome {
    Applied,
    Deferred(PendingResolveReason),
}

fn apply_resolve(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
) -> Result<ConflictApplyResult, SyncError> {
    let payload: ResolvePayload =
        serde_json::from_value(envelope.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "conflict.resolve payload is malformed",
        })?;
    if payload.status != "resolved" {
        return Err(SyncError::InvalidInput {
            reason: "conflict.resolve status is invalid",
        });
    }
    let target = resolve_target(tx, &envelope.workspace_id, &payload)?;
    let Some(target) = target else {
        // No local conflict matched this resolve by id or by swapped heads. The
        // envelope still journals + acks (idempotency and ordering must hold),
        // but the unmatched remote decision is surfaced with `localConflictId:
        // null` + the payload path, mirroring the oracle, so a reconciliation
        // layer can show it instead of it vanishing silently.
        //
        // The generic conflict wrapper persists this structured result beside
        // the imported coordinate in the same transaction, so a relay retry
        // can surface the exact decision even though applying this resolve
        // created no local conflict state.
        return Ok(ConflictApplyResult {
            conflict_id: payload.conflict_id.clone(),
            inserted: None,
            matched: false,
            pending_resolve: Some(PendingResolve {
                remote_conflict_id: payload.conflict_id,
                local_conflict_id: None,
                path: payload.path,
                reason: PendingResolveReason::UnmatchedTarget,
            }),
        });
    };
    let mut choice = parse_choice(&payload.chosen_from)?;
    let mut resolution = parse_resolution(&payload.resolution)?;
    if target.metadata_origin == "sync" {
        choice = mirror_choice(choice);
        resolution = mirror_resolution(resolution);
    }
    if target.status == "resolved" {
        if target.chosen_from != choice_str(choice)
            || target.resolution.as_deref() != Some(resolution_str(resolution))
        {
            return Ok(ConflictApplyResult {
                conflict_id: target.conflict_id.clone(),
                inserted: None,
                matched: false,
                pending_resolve: Some(pending_resolve(
                    &payload,
                    &target,
                    PendingResolveReason::StaleHead,
                )),
            });
        }
        return Ok(ConflictApplyResult {
            conflict_id: target.conflict_id,
            inserted: None,
            matched: true,
            pending_resolve: None,
        });
    }
    // A NON-sync ("verbatim replicated merge") conflict closes its row here and
    // never applies content in this path — content changes replicate as their
    // own ordered moment operations. A binary side of such a row is hydrated by
    // construction (BINCONFLICT's persist gate requires an existing
    // `binary_blobs` row before the side can be stored), so it must close like
    // any other verbatim resolve (mirroring the oracle's `else if (local)`
    // arm), NOT falsely defer `BinaryUnhydrated`. Only the sync-mirror path
    // below applies recorded content in-transaction.
    if target.metadata_origin == "sync" {
        match apply_mirrored_content(tx, envelope, &target.conflict_id, resolution)? {
            MirroredOutcome::Applied => {}
            MirroredOutcome::Deferred(reason) => {
                return Ok(ConflictApplyResult {
                    conflict_id: target.conflict_id.clone(),
                    inserted: None,
                    matched: false,
                    pending_resolve: Some(pending_resolve(&payload, &target, reason)),
                });
            }
        }
    }
    let changed = update_text_conflict_row(
        tx,
        &envelope.workspace_id,
        &target.conflict_id,
        &ConflictRowUpdate {
            status: ConflictStatus::Resolved,
            chosen_from: choice,
            resolution: Some(resolution),
            updated_at_ms: payload.updated_at_ms,
        },
    )
    .map_err(map_domain)?;
    Ok(ConflictApplyResult {
        conflict_id: target.conflict_id,
        inserted: None,
        matched: changed,
        pending_resolve: None,
    })
}

fn pending_resolve(
    payload: &ResolvePayload,
    target: &ResolveTarget,
    reason: PendingResolveReason,
) -> PendingResolve {
    PendingResolve {
        remote_conflict_id: payload.conflict_id.clone(),
        local_conflict_id: Some(target.conflict_id.clone()),
        path: Some(target.path.clone()),
        reason,
    }
}

fn apply_mirrored_content(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflict_id: &str,
    resolution: ConflictResolution,
) -> Result<MirroredOutcome, SyncError> {
    if resolution == ConflictResolution::KeptCurrent {
        return Ok(MirroredOutcome::Applied);
    }
    let conflict = load_text_conflict_in_tx(tx, &envelope.workspace_id, conflict_id)
        .map_err(map_domain)?
        .ok_or_else(|| local_corruption("replicated conflict target disappeared"))?;
    // Divergent-move refusal, mirroring the oracle: it refuses a divergent path
    // ONLY for an EXISTING incoming side (`incoming.exists && incoming.path !=
    // conflict.path`). An ABSENT incoming (a delete) has no meaningful path to
    // diverge, so it must fall through to the delete rather than defer
    // `PathChange`; the delete still passes the live/stale-head gate below.
    if resolution == ConflictResolution::AppliedIncoming
        && incoming_side_exists(&conflict.incoming)
        && conflict.incoming.path != conflict.path
    {
        return Ok(MirroredOutcome::Deferred(PendingResolveReason::PathChange));
    }
    let live = select_snapshot_by_path(
        tx,
        &envelope.workspace_id,
        &conflict.target_version_id,
        &conflict.path,
    )?;
    if !live_state_matches_conflict_current(&live, &conflict.current) {
        return Ok(MirroredOutcome::Deferred(PendingResolveReason::StaleHead));
    }
    if live.content_kind == ConflictContentKind::Binary && live.binary_byte_length.is_none() {
        return Ok(MirroredOutcome::Deferred(
            PendingResolveReason::BinaryUnhydrated,
        ));
    }
    match resolution {
        ConflictResolution::KeptCurrent => Ok(MirroredOutcome::Applied),
        ConflictResolution::AppliedIncoming => {
            if conflict_file_states_equal(&conflict.current, &conflict.incoming) {
                return Ok(MirroredOutcome::Applied);
            }
            // Mirror the oracle (`applyMirroredIncomingState`): existence is
            // checked BEFORE content kind. An absent incoming side (text OR
            // binary) is a delete, never a content write — so a binary deletion
            // deletes the current file rather than deferring `BinaryUnhydrated`.
            if !incoming_side_exists(&conflict.incoming) {
                return apply_mirrored_delete(tx, envelope, &conflict, &live);
            }
            if conflict.incoming.content_kind == ConflictContentKind::Binary {
                return apply_mirrored_binary_write(tx, envelope, &conflict, &live);
            }
            match &conflict.incoming.snapshot {
                Some(incoming) => {
                    apply_mirrored_text_write(tx, envelope, &conflict, &live, &incoming.text)
                }
                // An existing text side always carries a snapshot; a missing one
                // is nothing to apply rather than invented content.
                None => Ok(MirroredOutcome::Applied),
            }
        }
        ConflictResolution::AppliedMerged => {
            Ok(MirroredOutcome::Deferred(PendingResolveReason::Merged))
        }
    }
}

fn select_snapshot_by_path(
    tx: &Transaction<'_>,
    workspace_id: &str,
    version_id: &str,
    path: &str,
) -> Result<ConflictFileState, SyncError> {
    type HeadRow = (
        String,
        String,
        Option<String>,
        Option<String>,
        i64,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
        Option<i64>,
        Option<i64>,
    );
    let row: Option<HeadRow> = tx
        .query_row(
            "SELECT s.object_id, s.path, b.text, s.blob_sha256, s.updated_at_ms, \
             s.latest_moment_id, s.metadata_origin, s.metadata_summary, \
             s.metadata_correlation_id, COALESCE(s.content_kind, 'text'), \
              s.binary_sha256, bb.byte_length, LENGTH(bb.bytes) FROM snapshots s \
             LEFT JOIN blobs b ON b.sha256 = s.blob_sha256 \
             LEFT JOIN binary_blobs bb ON bb.sha256 = s.binary_sha256 \
             WHERE s.workspace_id = ?1 AND s.version_id = ?2 AND s.path = ?3",
            params![workspace_id, version_id, path],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                ))
            },
        )
        .optional()
        .map_err(SyncError::corrupt)?;
    let Some((
        object_id,
        snapshot_path,
        text,
        blob_sha256,
        updated_at_ms,
        latest_moment_id,
        metadata_origin,
        metadata_summary,
        metadata_correlation_id,
        content_kind,
        binary_sha256,
        binary_byte_length,
        binary_actual_length,
    )) = row
    else {
        return Ok(ConflictFileState::text(path.to_owned(), None));
    };
    match content_kind.as_str() {
        "text" => {
            let text = text.ok_or_else(|| local_corruption("text snapshot is missing its blob"))?;
            let blob_sha256 =
                blob_sha256.ok_or_else(|| local_corruption("text snapshot is missing its hash"))?;
            Ok(ConflictFileState::text(
                snapshot_path.clone(),
                Some(TextSnapshot {
                    workspace_id: workspace_id.to_owned(),
                    version_id: version_id.to_owned(),
                    object_id,
                    path: snapshot_path,
                    text,
                    blob_sha256,
                    updated_at_ms,
                    latest_moment_id,
                    metadata_origin,
                    metadata_summary,
                    metadata_correlation_id,
                }),
            ))
        }
        "binary" => {
            let binary_sha256 = binary_sha256
                .ok_or_else(|| local_corruption("binary snapshot is missing its blob"))?;
            if binary_byte_length.is_some_and(|byte_length| byte_length < 0)
                || binary_actual_length.is_some() && binary_actual_length != binary_byte_length
            {
                return Err(local_corruption(
                    "binary snapshot has an invalid byte length",
                ));
            }
            // A missing binary_blobs row is local hydration state, not a
            // malformed replicated payload. Preserve the snapshot's hash +
            // identity for the exact-head gate and keep the byte length unknown;
            // apply_mirrored_content then defers until the local blob is hydrated.
            Ok(ConflictFileState {
                path: snapshot_path,
                snapshot: None,
                binary_sha256: Some(binary_sha256),
                binary_byte_length,
                binary_object_id: Some(object_id),
                binary_latest_moment_id: Some(latest_moment_id),
                content_kind: ConflictContentKind::Binary,
                metadata_summary: None,
                metadata_correlation_id: None,
            })
        }
        _ => Err(local_corruption("snapshot has an unknown content kind")),
    }
}

fn conflict_file_states_equal(left: &ConflictFileState, right: &ConflictFileState) -> bool {
    if left.path != right.path || left.content_kind != right.content_kind {
        return false;
    }
    match left.content_kind {
        ConflictContentKind::Text => file_states_equal(&left.snapshot, &right.snapshot),
        ConflictContentKind::Binary => left.binary_sha256 == right.binary_sha256,
    }
}

fn apply_mirrored_binary_write(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflict: &TextConflict,
    live: &ConflictFileState,
) -> Result<MirroredOutcome, SyncError> {
    let Some(sha256) = conflict.incoming.binary_sha256.as_deref() else {
        return Ok(MirroredOutcome::Deferred(
            PendingResolveReason::BinaryUnhydrated,
        ));
    };
    // Verify integrity BEFORE closing the conflict, mirroring `is_apply_rejection`
    // for the text path. A presence-only probe would let a PRESENT-but-CORRUPT
    // blob close the row and enqueue a doomed materialization job over an
    // already-advanced ack. `get_binary_blob` re-hashes and length-checks the
    // bytes, so the taxonomy is exact:
    //   - genuinely ABSENT (`Ok(None)`) → DEFER `BinaryUnhydrated` (ack advances);
    //   - PRESENT-but-CORRUPT (`Err(BlobIntegrity)`) or any storage/read error →
    //     propagate as `Err` so the envelope rolls back and retries, never
    //     silently deferred+acked over a genuine fault.
    // This is the sole in-transaction byte load (the write helper's own check is
    // a cheap `SELECT 1` presence probe, no byte read), so integrity is restored
    // without a second full-blob read here.
    match dohc_engine_storage::get_binary_blob(tx, sha256) {
        Ok(Some(_)) => {}
        Ok(None) => {
            return Ok(MirroredOutcome::Deferred(
                PendingResolveReason::BinaryUnhydrated,
            ));
        }
        Err(err) => return Err(SyncError::Storage(err)),
    }
    let preimage = state_preimage(live);
    let input = WriteBinaryFile {
        workspace_id: envelope.workspace_id.clone(),
        version_id: conflict.target_version_id.clone(),
        object_id: mirrored_id(envelope, "object"),
        path: conflict.path.clone(),
        binary_sha256: sha256.to_owned(),
        moment_id: mirrored_id(envelope, "binary-materialize"),
        metadata_origin: "sync".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        materialize: Some(preimage),
        now_ms: envelope.recorded_at_ms,
    };
    // A genuine helper failure (object-id collision, missing version, a
    // non-normalized path, …) is distinct from the unhydrated pre-check: roll
    // back the partial write and surface `BinaryApplyFailed`, not
    // `BinaryUnhydrated`.
    apply_within_savepoint(
        tx,
        "mirrored_binary_write",
        PendingResolveReason::BinaryApplyFailed,
        |tx| write_binary_file_in_tx(tx, &input),
    )
}

/// Apply an incoming text side inside its own savepoint. A validation-class
/// rejection (reserved/ignored path, over the byte cap, …) rolls back and
/// DEFERS `TextApplyRejected` so the ack still advances; a genuine
/// storage/corruption failure rolls back and propagates as `Err`.
fn apply_mirrored_text_write(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflict: &TextConflict,
    live: &ConflictFileState,
    text: &str,
) -> Result<MirroredOutcome, SyncError> {
    let input = WriteText {
        workspace_id: envelope.workspace_id.clone(),
        version_id: conflict.target_version_id.clone(),
        object_id: mirrored_id(envelope, "object"),
        path: conflict.path.clone(),
        text: text.to_owned(),
        moment_id: mirrored_id(envelope, "incoming"),
        metadata_origin: "sync".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: envelope.recorded_at_ms,
        request_id: None,
    };
    let preimage = state_preimage(live);
    apply_within_savepoint(
        tx,
        "mirrored_text_apply",
        PendingResolveReason::TextApplyRejected,
        |tx| {
            validate_write_input(&input)?;
            let result = write_text_in_tx(tx, &input)?;
            enqueue_write(tx, &result, preimage, "sync-resolve")
        },
    )
}

fn state_preimage(state: &ConflictFileState) -> Preimage {
    match state.content_kind {
        ConflictContentKind::Text => state
            .snapshot
            .as_ref()
            .map_or(Preimage::Absent, |snapshot| {
                Preimage::Present(snapshot.blob_sha256.clone())
            }),
        ConflictContentKind::Binary => state
            .binary_sha256
            .as_ref()
            .map_or(Preimage::Absent, |sha| Preimage::Present(sha.clone())),
    }
}

/// Apply an incoming delete (an absent incoming side) inside its own savepoint,
/// with the same defer-vs-`Err` contract as the text write.
fn apply_mirrored_delete(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflict: &TextConflict,
    live: &ConflictFileState,
) -> Result<MirroredOutcome, SyncError> {
    // Nothing to remove only if the LIVE head is genuinely absent. A binary
    // current head has `snapshot == None` (its bytes live in `binary_sha256`),
    // so checking `snapshot.is_none()` alone would mark the delete applied while
    // the binary snapshot/path-alias/file stayed live. `delete_text_in_tx`
    // removes the object at the path regardless of kind, so a present binary
    // head is deleted here just like a text head.
    if !incoming_side_exists(live) {
        return Ok(MirroredOutcome::Applied);
    }
    let input = DeleteTextFile {
        workspace_id: envelope.workspace_id.clone(),
        version_id: conflict.target_version_id.clone(),
        path: conflict.path.clone(),
        moment_id: mirrored_id(envelope, "delete"),
        request_id: None,
        metadata_origin: "sync".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: envelope.recorded_at_ms,
    };
    apply_within_savepoint(
        tx,
        "mirrored_text_apply",
        PendingResolveReason::TextApplyRejected,
        |tx| {
            validate_delete_input(&input)?;
            let result = delete_text_in_tx(tx, &input)?;
            enqueue_delete(tx, &result, "sync-resolve")
        },
    )
}

/// Run a mirrored content apply inside a named savepoint. On success the
/// savepoint is released; on a validation-class `DomainError` it rolls back and
/// returns `Deferred(reject_reason)` so the envelope journal + ack still
/// advance; a storage/corruption error rolls back and propagates as `Err` so a
/// genuine fault is never silently swallowed.
fn apply_within_savepoint(
    tx: &Transaction<'_>,
    savepoint: &str,
    reject_reason: PendingResolveReason,
    apply: impl FnOnce(&Transaction<'_>) -> Result<(), DomainError>,
) -> Result<MirroredOutcome, SyncError> {
    tx.execute_batch(&format!("SAVEPOINT {savepoint}"))
        .map_err(SyncError::persist)?;
    match apply(tx) {
        Ok(()) => {
            tx.execute_batch(&format!("RELEASE {savepoint}"))
                .map_err(SyncError::persist)?;
            Ok(MirroredOutcome::Applied)
        }
        Err(err) => {
            tx.execute_batch(&format!("ROLLBACK TO {savepoint}; RELEASE {savepoint}"))
                .map_err(SyncError::persist)?;
            if is_apply_rejection(&err) {
                Ok(MirroredOutcome::Deferred(reject_reason))
            } else {
                Err(map_domain(err))
            }
        }
    }
}

/// A validation-class rejection (bad path/size/input, missing version,
/// duplicate moment, …) that must DEFER, versus a genuine storage/corruption
/// failure that must `Err`-fail-closed.
fn is_apply_rejection(err: &DomainError) -> bool {
    !matches!(
        err,
        DomainError::Storage(_) | DomainError::StateCorrupt { .. } | DomainError::Crypto(_)
    )
}

/// Whether a conflict side carries content (a text snapshot or a hydrated
/// binary sha). An absent side is a deletion.
fn incoming_side_exists(side: &ConflictFileState) -> bool {
    side.snapshot.is_some() || side.binary_sha256.is_some()
}

fn mirrored_id(envelope: &ReplicationEnvelope, kind: &str) -> String {
    let seed = format!(
        "{}:{}:{}:{kind}",
        envelope.workspace_id, envelope.origin_id, envelope.origin_seq
    );
    format!(
        "sync-conflict-{kind}-{}",
        dohc_engine_storage::hex_sha256(seed.as_bytes())
    )
}

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    if envelope.op_kind != "conflict.resolve" {
        return Ok(Vec::new());
    }
    let candidates = ["incoming", "delete", "binary-materialize"]
        .into_iter()
        .map(|kind| {
            let moment_id = mirrored_id(envelope, kind);
            let job_id = if kind == "binary-materialize" {
                moment_id.clone()
            } else {
                format!("sync-resolve-mat_{moment_id}")
            };
            (moment_id, job_id)
        });
    let mut changes = Vec::new();
    for (moment_id, job_id) in candidates {
        let change = store.read_with(|conn| {
            conn.query_row(
                "SELECT j.target_path, j.operation, \
                        COALESCE(m.after_content_kind, 'text') \
                 FROM materialization_jobs j \
                 LEFT JOIN moments m ON m.workspace_id=?1 AND m.moment_id=?2 \
                 WHERE j.job_id=?3",
                params![envelope.workspace_id, moment_id, job_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(SyncError::corrupt)
        })?;
        let Some((path, operation, content_kind)) = change else {
            continue;
        };
        let operation = match operation.as_str() {
            "write" => "write",
            "delete" => "delete",
            _ => {
                return Err(SyncError::InvalidInput {
                    reason: "conflict materialization operation is invalid",
                });
            }
        };
        let content_kind = match content_kind.as_str() {
            "text" => "text",
            "binary" => "binary",
            _ => {
                return Err(SyncError::InvalidInput {
                    reason: "conflict materialization content kind is invalid",
                });
            }
        };
        changes.push(crate::MomentMaterializationChange {
            path,
            operation,
            content_kind,
        });
    }
    Ok(changes)
}

fn resolve_target(
    tx: &Transaction<'_>,
    workspace_id: &str,
    payload: &ResolvePayload,
) -> Result<Option<ResolveTarget>, SyncError> {
    if let Some(target) = query_target_by_id(tx, workspace_id, &payload.conflict_id)? {
        return Ok(Some(target));
    }
    let (Some(version), Some(current), Some(incoming)) = (
        payload.target_version_id.as_deref(),
        payload.current_latest_moment_id.as_deref(),
        payload.incoming_latest_moment_id.as_deref(),
    ) else {
        return Ok(None);
    };
    let _ = payload.path.as_deref();
    tx.query_row(
        "SELECT conflict_id, path, metadata_origin, status, chosen_from, resolution \
         FROM conflicts WHERE workspace_id = ?1 AND status = 'open' \
           AND target_version_id = ?2 AND current_latest_moment_id IS ?3 \
           AND incoming_latest_moment_id IS ?4 \
         ORDER BY created_at_ms, conflict_id LIMIT 1",
        params![workspace_id, version, incoming, current],
        map_resolve_target,
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn query_target_by_id(
    tx: &Transaction<'_>,
    workspace_id: &str,
    conflict_id: &str,
) -> Result<Option<ResolveTarget>, SyncError> {
    tx.query_row(
        "SELECT conflict_id, path, metadata_origin, status, chosen_from, resolution \
         FROM conflicts WHERE workspace_id = ?1 AND conflict_id = ?2",
        params![workspace_id, conflict_id],
        map_resolve_target,
    )
    .optional()
    .map_err(SyncError::corrupt)
}

fn map_resolve_target(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResolveTarget> {
    Ok(ResolveTarget {
        conflict_id: row.get(0)?,
        path: row.get(1)?,
        metadata_origin: row.get(2)?,
        status: row.get(3)?,
        chosen_from: row.get(4)?,
        resolution: row.get(5)?,
    })
}

fn parse_choice(value: &str) -> Result<ConflictChoice, SyncError> {
    match value {
        "current" => Ok(ConflictChoice::Current),
        "incoming" => Ok(ConflictChoice::Incoming),
        "merged" => Ok(ConflictChoice::Merged),
        _ => Err(SyncError::InvalidInput {
            reason: "conflict choice is invalid",
        }),
    }
}

fn choice_str(choice: ConflictChoice) -> &'static str {
    match choice {
        ConflictChoice::Current => "current",
        ConflictChoice::Incoming => "incoming",
        ConflictChoice::Merged => "merged",
    }
}

fn resolution_str(resolution: ConflictResolution) -> &'static str {
    match resolution {
        ConflictResolution::KeptCurrent => "kept-current",
        ConflictResolution::AppliedIncoming => "applied-incoming",
        ConflictResolution::AppliedMerged => "applied-merged",
    }
}

fn parse_resolution(value: &str) -> Result<ConflictResolution, SyncError> {
    match value {
        "kept-current" => Ok(ConflictResolution::KeptCurrent),
        "applied-incoming" => Ok(ConflictResolution::AppliedIncoming),
        "applied-merged" => Ok(ConflictResolution::AppliedMerged),
        _ => Err(SyncError::InvalidInput {
            reason: "conflict resolution is invalid",
        }),
    }
}

fn mirror_choice(choice: ConflictChoice) -> ConflictChoice {
    match choice {
        ConflictChoice::Current => ConflictChoice::Incoming,
        ConflictChoice::Incoming => ConflictChoice::Current,
        ConflictChoice::Merged => ConflictChoice::Merged,
    }
}

fn mirror_resolution(resolution: ConflictResolution) -> ConflictResolution {
    match resolution {
        ConflictResolution::KeptCurrent => ConflictResolution::AppliedIncoming,
        ConflictResolution::AppliedIncoming => ConflictResolution::KeptCurrent,
        ConflictResolution::AppliedMerged => ConflictResolution::AppliedMerged,
    }
}

fn map_domain(error: DomainError) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard @ (DomainError::StateCorrupt { .. } | DomainError::Crypto(_)) => {
            SyncError::Storage(dohc_engine_storage::StorageError::corrupt_public(hard))
        }
        _ => SyncError::InvalidInput {
            reason: "replicated conflict operation is invalid",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::{ConflictChoice, ConflictResolution, VersionedTextStore, WriteText};
    use dohc_engine_storage::NoFaults;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;

    fn store() -> (ScratchDir, EngineStore) {
        let scratch = ScratchDir::new().expect("scratch");
        let path = scratch.engine_db_path().expect("db path");
        let mut store = EngineStore::open(&path, 1_000).expect("open");
        VersionedTextStore::new(&mut store)
            .ensure_main_version("ws", "main", 1_000, &NoFaults)
            .expect("workspace");
        (scratch, store)
    }

    #[test]
    fn conflict_domain_corruption_maps_to_a_hard_sync_error() {
        assert!(matches!(
            map_domain(DomainError::StateCorrupt {
                reason: "corrupt conflict test"
            }),
            SyncError::Storage(dohc_engine_storage::StorageError::StateCorrupt { .. })
        ));
    }

    fn envelope(
        origin: &str,
        seq: i64,
        kind: &str,
        payload: serde_json::Value,
    ) -> ReplicationEnvelope {
        ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: origin.to_owned(),
            origin_seq: seq,
            op_kind: kind.to_owned(),
            payload,
            recorded_at_ms: 2_000 + seq,
        }
    }

    fn open_payload(id: &str, metadata_origin: &str, binary: bool) -> serde_json::Value {
        let side = |path: &str, kind: &str| {
            json!({
                "exists": false,
                "path": path,
                "contentKind": kind
            })
        };
        json!({
            "id": id,
            "workspaceId": "ws",
            "path": "doc.md",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": 2_000,
            "updatedAtMs": 2_000,
            "base": side("doc.md", if binary { "binary" } else { "text" }),
            "current": side("doc.md", "text"),
            "incoming": side("doc.md", "text"),
            "status": "open",
            "chosenFrom": "current",
            "metadata": { "origin": metadata_origin }
        })
    }

    fn mirrored_open_payload(id: &str, current: &str, incoming: &str) -> serde_json::Value {
        let side = |text: &str, object_id: &str, moment_id: &str, updated_at_ms: i64| {
            json!({
                "exists": true,
                "path": "doc.md",
                "objectId": object_id,
                "contentKind": "text",
                "text": text,
                "updatedAtMs": updated_at_ms,
                "latestMomentId": moment_id,
                "metadata": { "origin": "sync" }
            })
        };
        json!({
            "id": id,
            "workspaceId": "ws",
            "path": "doc.md",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": 2_000,
            "updatedAtMs": 2_000,
            "base": { "exists": false, "path": "doc.md", "contentKind": "text" },
            "current": side(current, "current-object", "current-moment", 1_500),
            "incoming": side(incoming, "incoming-object", "incoming-moment", 1_900),
            "status": "open",
            "chosenFrom": "current",
            "metadata": { "origin": "sync" }
        })
    }

    fn seed_current(store: &mut EngineStore, text: &str) {
        VersionedTextStore::new(store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "current-object".to_owned(),
                    path: "doc.md".to_owned(),
                    text: text.to_owned(),
                    moment_id: "current-moment".to_owned(),
                    metadata_origin: "sync".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1_500,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("seed current text");
    }

    fn stage_binary_head(store: &mut EngineStore, conflict_id: &str, bytes: &[u8]) -> String {
        let sha = dohc_engine_storage::hex_sha256(bytes);
        seed_current(store, "receiver current");
        apply_conflict_envelope(
            store,
            &envelope(
                "binary-peer",
                0,
                "conflict.open",
                mirrored_open_payload(conflict_id, "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open conflict for binary head");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(tx, &sha, bytes)
                    .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET incoming_content_kind = 'binary', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = ?2",
                    params![sha, conflict_id],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("hydrate binary side");
        apply_conflict_envelope(
            store,
            &envelope(
                "binary-peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": conflict_id,
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("apply binary head");
        sha
    }

    fn read_text(store: &mut EngineStore) -> String {
        VersionedTextStore::new(store)
            .read_text("ws", "main", "doc.md")
            .expect("read text")
            .expect("snapshot")
            .text
    }

    fn moment_count(store: &EngineStore) -> i64 {
        store
            .read_with(|conn| conn.query_row("SELECT COUNT(*) FROM moments", [], |row| row.get(0)))
            .expect("moment count")
    }

    fn materialization_job_count(store: &EngineStore) -> i64 {
        store
            .read_with(|conn| {
                conn.query_row("SELECT COUNT(*) FROM materialization_jobs", [], |row| {
                    row.get(0)
                })
            })
            .expect("materialization job count")
    }

    fn replication_counts(store: &EngineStore) -> (i64, i64, i64) {
        store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM replication_peers", [], |row| {
                        row.get(0)
                    })?,
                ))
            })
            .expect("counts")
    }

    fn assert_open_conflict(store: &EngineStore, conflict_id: &str) {
        store
            .read_with(|conn| {
                let (status, resolution): (String, Option<String>) = conn.query_row(
                    "SELECT status, resolution FROM conflicts \
                     WHERE workspace_id = 'ws' AND conflict_id = ?1",
                    params![conflict_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(status, "open");
                assert_eq!(resolution, None);
                Ok::<_, rusqlite::Error>(())
            })
            .expect("open conflict row");
    }

    fn assert_resolved_conflict(store: &EngineStore, conflict_id: &str) {
        store
            .read_with(|conn| {
                let (status, resolution): (String, Option<String>) = conn.query_row(
                    "SELECT status, resolution FROM conflicts \
                     WHERE workspace_id = 'ws' AND conflict_id = ?1",
                    params![conflict_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(status, "resolved");
                assert_eq!(resolution.as_deref(), Some("applied-incoming"));
                Ok::<_, rusqlite::Error>(())
            })
            .expect("resolved conflict row");
    }

    fn assert_binary_file_staged(store: &EngineStore, sha256: &str) {
        store
            .read_with(|conn| {
                let object_id: String = conn.query_row(
                    "SELECT object_id FROM path_aliases \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |row| row.get(0),
                )?;
                let object_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM file_objects \
                     WHERE workspace_id = 'ws' AND object_id = ?1",
                    [&object_id],
                    |row| row.get(0),
                )?;
                let (job_sha, status, operation): (String, String, String) = conn.query_row(
                    "SELECT content_sha256, status, operation FROM materialization_jobs \
                     WHERE target_path = 'doc.md' ORDER BY target_generation DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
                let (snapshot_kind, snapshot_sha): (String, Option<String>) = conn.query_row(
                    "SELECT content_kind, binary_sha256 FROM snapshots \
                      WHERE workspace_id = 'ws' AND version_id = 'main' AND object_id = ?1",
                    [&object_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(object_count, 1);
                assert_eq!(job_sha, sha256);
                assert_eq!(status, "pending");
                assert_eq!(operation, "write");
                assert_eq!(snapshot_kind, "binary");
                assert_eq!(snapshot_sha.as_deref(), Some(sha256));
                Ok::<_, rusqlite::Error>(())
            })
            .expect("binary file object and materialization intent");
    }

    fn assert_replication_advanced(
        store: &EngineStore,
        origin_id: &str,
        origin_seq: i64,
        expected_log_count: i64,
    ) {
        assert_eq!(replication_counts(store), (1, expected_log_count, 1));
        store
            .read_with(|conn| {
                let (op_kind, imported): (String, i64) = conn.query_row(
                    "SELECT op_kind, imported FROM replication_log \
                     WHERE workspace_id = 'ws' AND origin_id = ?1 AND origin_seq = ?2",
                    params![origin_id, origin_seq],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(op_kind, "conflict.resolve");
                assert_ne!(imported, 0);
                let acked_seq: i64 = conn.query_row(
                    "SELECT acked_seq FROM replication_peers \
                     WHERE workspace_id = 'ws' AND origin_id = ?1",
                    params![origin_id],
                    |row| row.get(0),
                )?;
                assert_eq!(acked_seq, origin_seq);
                Ok::<_, rusqlite::Error>(())
            })
            .expect("replication advancement");
    }

    #[test]
    fn conflict_open_is_idempotent_across_distinct_replication_coordinates() {
        let (_scratch, mut store) = store();
        let first = envelope(
            "peer-a",
            0,
            "conflict.open",
            open_payload("c1", "merge", false),
        );
        let second = envelope(
            "peer-b",
            0,
            "conflict.open",
            open_payload("c1", "merge", false),
        );
        assert_eq!(
            apply_conflict_envelope(&mut store, &first, &NoFaults).expect("first"),
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "c1".to_owned(),
                inserted: Some(true),
                matched: true,
                pending_resolve: None,
            })
        );
        assert_eq!(
            apply_conflict_envelope(&mut store, &second, &NoFaults).expect("second"),
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "c1".to_owned(),
                inserted: Some(false),
                matched: true,
                pending_resolve: None,
            })
        );
        let rows = VersionedTextStore::new(&mut store)
            .list_text_conflicts("ws", None)
            .expect("list");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn mirrored_keep_current_resolve_applies_incoming_content_on_receiver() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        let open = envelope(
            "peer",
            0,
            "conflict.open",
            mirrored_open_payload("sync-c", "receiver current", "origin current"),
        );
        apply_conflict_envelope(&mut store, &open, &NoFaults).expect("open");
        let resolve = envelope(
            "peer",
            1,
            "conflict.resolve",
            json!({
                "conflictId": "sync-c",
                "status": "resolved",
                "chosenFrom": "current",
                "resolution": "kept-current",
                "updatedAtMs": 3_000,
                "targetVersionId": "main"
            }),
        );
        let outcome = apply_conflict_envelope(&mut store, &resolve, &NoFaults).expect("resolve");
        assert!(matches!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult { matched: true, .. })
        ));
        let rows = VersionedTextStore::new(&mut store)
            .list_text_conflicts("ws", Some("resolved"))
            .expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chosen_from, ConflictChoice::Incoming);
        assert_eq!(
            rows[0].resolution,
            Some(ConflictResolution::AppliedIncoming)
        );
        assert_eq!(read_text(&mut store), "origin current");
    }

    #[test]
    fn corrupt_local_conflict_side_is_hard_and_unacked() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "corrupt-side-peer",
                0,
                "conflict.open",
                mirrored_open_payload("corrupt-side", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET incoming_blob_sha256=NULL \
                     WHERE workspace_id='ws' AND conflict_id='corrupt-side'",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("corrupt local conflict side");

        let resolve = envelope(
            "corrupt-side-peer",
            1,
            "conflict.resolve",
            json!({
                "conflictId": "corrupt-side",
                "status": "resolved",
                "chosenFrom": "current",
                "resolution": "kept-current",
                "updatedAtMs": 3_000,
                "targetVersionId": "main"
            }),
        );
        assert!(matches!(
            apply_conflict_envelope(&mut store, &resolve, &NoFaults),
            Err(SyncError::Storage(
                dohc_engine_storage::StorageError::StateCorrupt { .. }
            ))
        ));
        assert_eq!(
            crate::read_replication_acked_seq(&store, "ws", "corrupt-side-peer").expect("ack"),
            0,
            "MUTATION: local conflict corruption must not retire the resolve"
        );
        assert_open_conflict(&store, "corrupt-side");
        assert_eq!(
            replication_counts(&store),
            (1, 1, 1),
            "the hard failure must not journal the resolve"
        );
    }

    #[test]
    fn mirrored_path_change_resolve_is_acked_and_deferred() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        let mut open_payload =
            mirrored_open_payload("path-change-c", "receiver current", "origin current");
        open_payload["incoming"]["path"] = json!("renamed.md");
        apply_conflict_envelope(
            &mut store,
            &envelope("peer", 0, "conflict.open", open_payload),
            &NoFaults,
        )
        .expect("open");
        let before_moments = moment_count(&store);

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "path-change-c",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("deferred resolve");

        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "path-change-c".to_owned(),
                inserted: None,
                matched: false,
                pending_resolve: Some(PendingResolve {
                    remote_conflict_id: "path-change-c".to_owned(),
                    local_conflict_id: Some("path-change-c".to_owned()),
                    path: Some("doc.md".to_owned()),
                    reason: PendingResolveReason::PathChange,
                }),
            })
        );
        assert_eq!(read_text(&mut store), "receiver current");
        assert_eq!(moment_count(&store), before_moments);
        assert_open_conflict(&store, "path-change-c");
        assert_replication_advanced(&store, "peer", 1, 2);
    }

    #[test]
    fn mirrored_merged_resolve_without_resolved_text_is_acked_and_deferred() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("merged-c", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open");
        let before_moments = moment_count(&store);
        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "merged-c",
                    "status": "resolved",
                    "chosenFrom": "merged",
                    "resolution": "applied-merged",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("deferred resolve");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "merged-c".to_owned(),
                inserted: None,
                matched: false,
                pending_resolve: Some(PendingResolve {
                    remote_conflict_id: "merged-c".to_owned(),
                    local_conflict_id: Some("merged-c".to_owned()),
                    path: Some("doc.md".to_owned()),
                    reason: PendingResolveReason::Merged,
                }),
            })
        );
        assert_eq!(read_text(&mut store), "receiver current");
        assert_eq!(moment_count(&store), before_moments);
        assert_open_conflict(&store, "merged-c");
        assert_replication_advanced(&store, "peer", 1, 2);
    }

    #[test]
    fn mirrored_stale_head_resolve_is_acked_and_deferred() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("stale-c", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open");
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "ignored".to_owned(),
                    path: "doc.md".to_owned(),
                    text: "newer live head".to_owned(),
                    moment_id: "newer-moment".to_owned(),
                    metadata_origin: "local".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2_500,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("advance live head");
        let before_moments = moment_count(&store);

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "stale-c",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("deferred resolve");

        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "stale-c".to_owned(),
                inserted: None,
                matched: false,
                pending_resolve: Some(PendingResolve {
                    remote_conflict_id: "stale-c".to_owned(),
                    local_conflict_id: Some("stale-c".to_owned()),
                    path: Some("doc.md".to_owned()),
                    reason: PendingResolveReason::StaleHead,
                }),
            })
        );
        assert_eq!(read_text(&mut store), "newer live head");
        assert_eq!(moment_count(&store), before_moments);
        assert_open_conflict(&store, "stale-c");
        assert_replication_advanced(&store, "peer", 1, 2);
    }

    #[test]
    fn repeated_identical_mirrored_resolve_does_not_double_write_or_clobber() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer-open",
                0,
                "conflict.open",
                mirrored_open_payload("repeat-c", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open");
        let payload = json!({
            "conflictId": "repeat-c",
            "status": "resolved",
            "chosenFrom": "current",
            "resolution": "kept-current",
            "updatedAtMs": 3_000,
            "targetVersionId": "main"
        });
        apply_conflict_envelope(
            &mut store,
            &envelope("peer-a", 0, "conflict.resolve", payload.clone()),
            &NoFaults,
        )
        .expect("first resolve");
        let after_first = moment_count(&store);
        apply_conflict_envelope(
            &mut store,
            &envelope("peer-b", 0, "conflict.resolve", payload),
            &NoFaults,
        )
        .expect("identical resolve");
        assert_eq!(moment_count(&store), after_first);
        assert_eq!(read_text(&mut store), "origin current");
    }

    #[test]
    fn conflict_open_refuses_terminal_status_or_resolution_and_acks() {
        for (case, status, resolution) in [
            ("resolved-status", "resolved", None),
            ("premature-resolution", "open", Some("kept-current")),
        ] {
            let (_scratch, mut store) = store();
            let mut payload = open_payload(case, "merge", false);
            payload["status"] = json!(status);
            if let Some(resolution) = resolution {
                payload["resolution"] = json!(resolution);
            }
            let outcome = apply_conflict_envelope(
                &mut store,
                &envelope("peer", 0, "conflict.open", payload),
                &NoFaults,
            )
            .expect("terminal conflict.open must be refused");
            assert!(
                matches!(outcome, ApplyOutcome::Refused(_)),
                "{case}: {outcome:?}"
            );
            assert_eq!(replication_counts(&store), (0, 1, 1), "{case}");
        }
    }

    #[test]
    fn conflict_open_requires_text_for_an_existing_text_side() {
        let (_scratch, mut store) = store();
        let mut payload = open_payload("missing-text", "merge", false);
        payload["current"] = json!({
            "exists": true,
            "path": "doc.md",
            "objectId": "object-1",
            "contentKind": "text",
            "updatedAtMs": 2_000,
            "latestMomentId": "moment-1",
            "metadata": { "origin": "sync" }
        });
        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope("peer", 0, "conflict.open", payload),
            &NoFaults,
        )
        .expect("missing text must be refused");
        assert!(matches!(outcome, ApplyOutcome::Refused(_)));
        assert_eq!(replication_counts(&store), (0, 1, 1));
    }

    #[test]
    fn identical_conflict_resolve_at_distinct_coordinates_is_idempotent() {
        let (_scratch, mut store) = store();
        let open = envelope(
            "peer-open",
            0,
            "conflict.open",
            open_payload("idempotent-resolve", "merge", false),
        );
        apply_conflict_envelope(&mut store, &open, &NoFaults).expect("open");
        let payload = json!({
            "conflictId": "idempotent-resolve",
            "status": "resolved",
            "chosenFrom": "current",
            "resolution": "kept-current",
            "updatedAtMs": 3_000,
            "targetVersionId": "main"
        });
        let first = apply_conflict_envelope(
            &mut store,
            &envelope("peer-a", 0, "conflict.resolve", payload.clone()),
            &NoFaults,
        )
        .expect("first resolve");
        let second = apply_conflict_envelope(
            &mut store,
            &envelope("peer-b", 0, "conflict.resolve", payload),
            &NoFaults,
        )
        .expect("idempotent resolve");
        assert!(matches!(
            first,
            ApplyOutcome::Applied(ConflictApplyResult { matched: true, .. })
        ));
        assert!(matches!(
            second,
            ApplyOutcome::Applied(ConflictApplyResult { matched: true, .. })
        ));
        let rows = VersionedTextStore::new(&mut store)
            .list_text_conflicts("ws", Some("resolved"))
            .expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chosen_from, ConflictChoice::Current);
        assert_eq!(rows[0].resolution, Some(ConflictResolution::KeptCurrent));
    }

    #[test]
    fn conflicting_second_conflict_resolve_is_acked_and_deferred_without_clobber() {
        let (_scratch, mut store) = store();
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer-open",
                0,
                "conflict.open",
                open_payload("divergent-resolve", "merge", false),
            ),
            &NoFaults,
        )
        .expect("open");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer-a",
                0,
                "conflict.resolve",
                json!({
                    "conflictId": "divergent-resolve",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000
                }),
            ),
            &NoFaults,
        )
        .expect("first resolve");
        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer-b",
                0,
                "conflict.resolve",
                json!({
                    "conflictId": "divergent-resolve",
                    "status": "resolved",
                    "chosenFrom": "incoming",
                    "resolution": "applied-incoming",
                    "updatedAtMs": 4_000
                }),
            ),
            &NoFaults,
        )
        .expect("different terminal resolution is deferred");
        let ApplyOutcome::Applied(result) = outcome else {
            panic!("replicated resolution must be applied to the ack ledger");
        };
        assert!(!result.matched);
        assert!(result.deferred());
        assert_eq!(
            result
                .pending_resolve
                .as_ref()
                .map(|pending| pending.reason),
            Some(PendingResolveReason::StaleHead)
        );
        let rows = VersionedTextStore::new(&mut store)
            .list_text_conflicts("ws", Some("resolved"))
            .expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chosen_from, ConflictChoice::Current);
        assert_eq!(rows[0].resolution, Some(ConflictResolution::KeptCurrent));
        assert_eq!(replication_counts(&store), (1, 3, 3));
    }

    #[test]
    fn conflict_open_with_binary_side_is_refused_and_acked() {
        let (_scratch, mut store) = store();
        let binary = envelope(
            "peer",
            0,
            "conflict.open",
            open_payload("binary-c", "sync", true),
        );
        let outcome = apply_conflict_envelope(&mut store, &binary, &NoFaults)
            .expect("binary side must be refused");
        assert!(matches!(outcome, ApplyOutcome::Refused(_)));
        assert_eq!(replication_counts(&store), (0, 1, 1));
    }

    /// An invalid binary open that REUSES an already-open conflict id must not
    /// slip through the duplicate-id shortcut: it is refused without applying
    /// the binary side, then recorded and acked.
    #[test]
    fn duplicate_conflict_open_with_binary_side_is_refused_and_acked() {
        let (_scratch, mut store) = store();
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                open_payload("dup-c", "sync", false),
            ),
            &NoFaults,
        )
        .expect("valid text open applies");
        assert_eq!(replication_counts(&store), (1, 1, 1));

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.open",
                open_payload("dup-c", "sync", true),
            ),
            &NoFaults,
        )
        .expect("invalid binary side on a duplicate id must be refused");
        assert!(matches!(outcome, ApplyOutcome::Refused(_)));
        assert_eq!(
            replication_counts(&store),
            (1, 2, 1),
            "the refused duplicate must not mutate the conflict"
        );
    }

    #[test]
    fn mirrored_hydrated_binary_side_resolve_is_applied_and_acked() {
        let (_scratch, mut store) = store();
        let binary_bytes = b"\x00resolved binary\xff";
        let binary_sha = dohc_engine_storage::hex_sha256(binary_bytes);
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("binary-resolve", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open text conflict");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(
                    tx,
                    &binary_sha,
                    binary_bytes,
                )
                .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET incoming_content_kind = 'binary', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'binary-resolve'",
                    [&binary_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("hydrate and mark binary side");
        let before_moments = moment_count(&store);
        let resolve = envelope(
            "peer",
            1,
            "conflict.resolve",
            json!({
                "conflictId": "binary-resolve",
                "status": "resolved",
                "chosenFrom": "current",
                "resolution": "kept-current",
                "updatedAtMs": 3_000,
                "targetVersionId": "main"
            }),
        );
        let outcome = apply_conflict_envelope(&mut store, &resolve, &NoFaults)
            .expect("hydrated binary resolve applies");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "binary-resolve".to_owned(),
                inserted: None,
                matched: true,
                pending_resolve: None,
            })
        );
        assert_eq!(moment_count(&store), before_moments + 1);
        assert_binary_file_staged(&store, &binary_sha);
        assert_resolved_conflict(&store, "binary-resolve");
        assert_replication_advanced(&store, "peer", 1, 2);
        let jobs_after_apply = materialization_job_count(&store);
        assert_eq!(
            apply_conflict_envelope(&mut store, &resolve, &NoFaults)
                .expect("same-coordinate replay is idempotent"),
            ApplyOutcome::Skipped
        );
        assert_eq!(materialization_job_count(&store), jobs_after_apply);
    }

    #[test]
    fn mirrored_resolve_matches_binary_live_head_and_text_preimage_uses_binary_sha() {
        let (_scratch, mut store) = store();
        let binary_sha = stage_binary_head(&mut store, "first-binary", b"\x00binary live\xff");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "text-peer",
                0,
                "conflict.open",
                mirrored_open_payload("text-over-binary", "placeholder", "replacement text"),
            ),
            &NoFaults,
        )
        .expect("open text-over-binary conflict");
        // Record the current side as the EXACT live binary head — its bytes AND
        // its identity (object + latest moment) — so the strict exact-head gate
        // recognizes it. A shortcut that omitted the identity would now (rightly)
        // be refused as stale.
        let (live_object_id, live_latest_moment): (String, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT object_id, latest_moment_id FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .expect("live binary head identity");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET current_content_kind = 'binary', \
                     current_blob_sha256 = NULL, current_binary_sha256 = ?1, \
                     current_object_id = ?2, current_latest_moment_id = ?3 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'text-over-binary'",
                    params![binary_sha, live_object_id, live_latest_moment],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("record binary current side");

        let resolve = envelope(
            "text-peer",
            1,
            "conflict.resolve",
            json!({
                "conflictId": "text-over-binary",
                "status": "resolved",
                "chosenFrom": "current",
                "resolution": "kept-current",
                "updatedAtMs": 4_000,
                "targetVersionId": "main"
            }),
        );
        let outcome = apply_conflict_envelope(&mut store, &resolve, &NoFaults)
            .expect("matching binary head permits text apply");
        assert!(matches!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                matched: true,
                pending_resolve: None,
                ..
            })
        ));
        assert_eq!(read_text(&mut store), "replacement text");
        let (preimage_present, preimage_sha, status): (i64, Option<String>, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT preimage_present, preimage_sha256, status \
                     FROM materialization_jobs WHERE target_path = 'doc.md' \
                     ORDER BY target_generation DESC LIMIT 1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
            })
            .expect("text materialization preimage");
        assert_eq!(preimage_present, 1);
        assert_eq!(preimage_sha.as_deref(), Some(binary_sha.as_str()));
        assert_eq!(status, "pending");
        assert_eq!(
            redelivered_materialization_changes(&store, &resolve)
                .expect("mirrored materialization change"),
            [crate::MomentMaterializationChange {
                path: "doc.md".to_owned(),
                operation: "write",
                content_kind: "text",
            }],
            "MUTATION: omitting conflict.resolve durable-intent lookup loses the changed path"
        );
        assert_eq!(
            apply_conflict_envelope(&mut store, &resolve, &NoFaults).expect("resolve redelivery"),
            ApplyOutcome::Skipped
        );
        assert_eq!(
            redelivered_materialization_changes(&store, &resolve)
                .expect("redelivered mirrored materialization change"),
            [crate::MomentMaterializationChange {
                path: "doc.md".to_owned(),
                operation: "write",
                content_kind: "text",
            }]
        );
    }

    #[test]
    fn mirrored_resolve_defers_when_recorded_binary_head_is_stale() {
        let (_scratch, mut store) = store();
        let live_sha = stage_binary_head(&mut store, "first-binary", b"\x00binary live\xff");
        let stale_bytes = b"\x00stale binary\xff";
        let stale_sha = dohc_engine_storage::hex_sha256(stale_bytes);
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "stale-peer",
                0,
                "conflict.open",
                mirrored_open_payload("stale-binary", "placeholder", "replacement text"),
            ),
            &NoFaults,
        )
        .expect("open stale binary conflict");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(
                    tx,
                    &stale_sha,
                    stale_bytes,
                )
                .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET current_content_kind = 'binary', \
                     current_blob_sha256 = NULL, current_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'stale-binary'",
                    [&stale_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("record stale binary current side");

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "stale-peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "stale-binary",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 4_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("stale binary head is deferred");
        assert!(matches!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                matched: false,
                pending_resolve: Some(PendingResolve {
                    reason: PendingResolveReason::StaleHead,
                    ..
                }),
                ..
            })
        ));
        let live: (String, Option<String>) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT content_kind, binary_sha256 FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("live binary head");
        assert_eq!(live.0, "binary");
        assert_eq!(live.1.as_deref(), Some(live_sha.as_str()));
        assert_open_conflict(&store, "stale-binary");
    }

    /// M2 regression: a recorded binary current side with the SAME bytes as the
    /// live head but a DIFFERENT identity (object + latest moment) — i.e. the
    /// head was rewritten/recreated with identical content after the conflict
    /// opened — must NOT pass the exact-head gate. A bytes-only comparison would
    /// wrongly match and let the mirrored resolve clobber the NEWER head.
    #[test]
    fn mirrored_resolve_defers_when_recorded_binary_head_has_same_bytes_but_stale_identity() {
        let (_scratch, mut store) = store();
        let live_sha = stage_binary_head(&mut store, "first-binary", b"\x00binary live\xff");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "recreate-peer",
                0,
                "conflict.open",
                mirrored_open_payload("same-bytes-recreated", "placeholder", "replacement text"),
            ),
            &NoFaults,
        )
        .expect("open same-bytes-recreated conflict");
        // Same bytes as the live head, but a stale object/latest-moment identity.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET current_content_kind = 'binary', \
                     current_blob_sha256 = NULL, current_binary_sha256 = ?1, \
                     current_object_id = 'stale-object', \
                     current_latest_moment_id = 'stale-moment' \
                     WHERE workspace_id = 'ws' AND conflict_id = 'same-bytes-recreated'",
                    [&live_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("record same-bytes stale-identity current side");
        let before_moments = moment_count(&store);

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "recreate-peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "same-bytes-recreated",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 4_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("same-bytes stale identity is deferred");
        assert!(matches!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                matched: false,
                pending_resolve: Some(PendingResolve {
                    reason: PendingResolveReason::StaleHead,
                    ..
                }),
                ..
            })
        ));
        // The newer binary head is untouched and no text clobbered it.
        let live: (String, Option<String>) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT content_kind, binary_sha256 FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
            })
            .expect("live binary head");
        assert_eq!(live.0, "binary");
        assert_eq!(live.1.as_deref(), Some(live_sha.as_str()));
        assert_eq!(moment_count(&store), before_moments, "no clobbering write");
        assert_open_conflict(&store, "same-bytes-recreated");
    }

    /// M1 regression: a mirrored DELETE (absent incoming) over a BINARY current
    /// head must actually remove the head — snapshot, path alias, and file
    /// (materialization) — and resolve the row + advance the ack. The old no-op
    /// guard treated `current.snapshot.is_none()` as "nothing to remove", so a
    /// binary head (whose `snapshot` is always `None`) survived a delete that was
    /// nonetheless marked applied/resolved/acked.
    #[test]
    fn mirrored_delete_over_binary_head_actually_removes_it() {
        let (_scratch, mut store) = store();
        let live_sha = stage_binary_head(&mut store, "first-binary", b"\x00binary live\xff");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "delete-peer",
                0,
                "conflict.open",
                mirrored_open_payload("delete-binary", "placeholder", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open delete-binary conflict");
        let (live_object_id, live_latest_moment): (String, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT object_id, latest_moment_id FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .expect("live binary head identity");
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET \
                     current_content_kind = 'binary', current_blob_sha256 = NULL, \
                     current_binary_sha256 = ?1, current_object_id = ?2, \
                     current_latest_moment_id = ?3, \
                     incoming_exists = 0, incoming_content_kind = 'text', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = NULL, \
                     incoming_object_id = NULL, incoming_latest_moment_id = NULL \
                     WHERE workspace_id = 'ws' AND conflict_id = 'delete-binary'",
                    params![live_sha, live_object_id, live_latest_moment],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("record binary current + absent incoming");

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "delete-peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "delete-binary",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 4_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("mirrored delete of binary head applies");
        assert!(matches!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                matched: true,
                pending_resolve: None,
                ..
            })
        ));
        let (snap_count, alias_count): (i64, i64) = store
            .read_with(|conn| {
                let s: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| r.get(0),
                )?;
                let a: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| r.get(0),
                )?;
                Ok::<_, rusqlite::Error>((s, a))
            })
            .expect("counts");
        assert_eq!(snap_count, 0, "the binary snapshot must be removed");
        assert_eq!(alias_count, 0, "the path alias must be removed");
        let delete_job: (String, i64, Option<String>) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT status, preimage_present, preimage_sha256 \
                     FROM materialization_jobs WHERE target_path = 'doc.md' \
                     ORDER BY target_generation DESC LIMIT 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
            })
            .expect("delete materialization job");
        assert_eq!(delete_job.1, 1, "delete preimage present");
        assert_eq!(delete_job.2.as_deref(), Some(live_sha.as_str()));
        assert_resolved_conflict(&store, "delete-binary");
        let (imported, acked_seq): (i64, i64) = store
            .read_with(|conn| {
                let imported: i64 = conn.query_row(
                    "SELECT imported FROM replication_log \
                     WHERE workspace_id = 'ws' AND origin_id = 'delete-peer' AND origin_seq = 1",
                    [],
                    |r| r.get(0),
                )?;
                let acked_seq: i64 = conn.query_row(
                    "SELECT acked_seq FROM replication_peers \
                     WHERE workspace_id = 'ws' AND origin_id = 'delete-peer'",
                    [],
                    |r| r.get(0),
                )?;
                Ok::<_, rusqlite::Error>((imported, acked_seq))
            })
            .expect("delete-peer replication cursor");
        assert_ne!(imported, 0, "the delete resolve was imported");
        assert_eq!(
            acked_seq, 1,
            "the delete-peer ack advanced past the resolve"
        );
    }

    /// An absent local binary blob is hydration state, not a malformed remote
    /// resolve. Ack and defer it while preserving the head/conflict for retry.
    #[test]
    fn mirrored_resolve_over_unhydrated_local_binary_head_defers_and_acks() {
        let (_scratch, mut store) = store();
        let live_sha = stage_binary_head(&mut store, "first-binary", b"\x00binary live\xff");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "delete-peer",
                0,
                "conflict.open",
                mirrored_open_payload("delete-binary", "placeholder", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open delete-binary conflict");
        let (live_object_id, live_latest_moment): (String, String) = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT object_id, latest_moment_id FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .expect("live binary head identity");
        // Current = the live binary head (with its identity); incoming = ABSENT
        // (a delete).
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET \
                     current_content_kind = 'binary', current_blob_sha256 = NULL, \
                     current_binary_sha256 = ?1, current_object_id = ?2, \
                     current_latest_moment_id = ?3, \
                     incoming_exists = 0, incoming_content_kind = 'text', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = NULL, \
                     incoming_object_id = NULL, incoming_latest_moment_id = NULL \
                     WHERE workspace_id = 'ws' AND conflict_id = 'delete-binary'",
                    params![live_sha, live_object_id, live_latest_moment],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("record binary current + absent incoming");
        store
            .read_with(|conn| {
                conn.execute_batch("PRAGMA foreign_keys = OFF")?;
                conn.execute("DELETE FROM binary_blobs WHERE sha256 = ?1", [&live_sha])?;
                conn.execute_batch("PRAGMA foreign_keys = ON")?;
                Ok::<_, rusqlite::Error>(())
            })
            .expect("simulate a local binary head whose bytes are not hydrated");

        let resolved = apply_conflict_envelope(
            &mut store,
            &envelope(
                "delete-peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "delete-binary",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 4_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        );
        assert!(
            resolved.is_ok(),
            "missing local binary bytes are retryable local state: {resolved:?}"
        );
        let outcome = resolved.expect("asserted successful resolve");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "delete-binary".to_owned(),
                inserted: None,
                matched: false,
                pending_resolve: Some(PendingResolve {
                    remote_conflict_id: "delete-binary".to_owned(),
                    local_conflict_id: Some("delete-binary".to_owned()),
                    path: Some("doc.md".to_owned()),
                    reason: PendingResolveReason::BinaryUnhydrated,
                }),
            })
        );
        // Deferral preserves the local head and conflict until hydration.
        let (snap_count, alias_count): (i64, i64) = store
            .read_with(|conn| {
                let s: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| r.get(0),
                )?;
                let a: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND path = 'doc.md'",
                    [],
                    |r| r.get(0),
                )?;
                Ok::<_, rusqlite::Error>((s, a))
            })
            .expect("counts");
        assert_eq!(snap_count, 1, "the unhydrated binary snapshot stays live");
        assert_eq!(alias_count, 1, "the path alias stays live");
        assert_eq!(
            materialization_job_count(&store),
            1,
            "only the original binary job remains"
        );
        assert_open_conflict(&store, "delete-binary");
        // The resolve envelope was imported and acked even though application
        // waits for the local blob to hydrate.
        let (imported, acked_seq): (i64, i64) = store
            .read_with(|conn| {
                let imported: i64 = conn.query_row(
                    "SELECT imported FROM replication_log \
                     WHERE workspace_id = 'ws' AND origin_id = 'delete-peer' AND origin_seq = 1",
                    [],
                    |r| r.get(0),
                )?;
                let acked_seq: i64 = conn.query_row(
                    "SELECT acked_seq FROM replication_peers \
                     WHERE workspace_id = 'ws' AND origin_id = 'delete-peer'",
                    [],
                    |r| r.get(0),
                )?;
                Ok::<_, rusqlite::Error>((imported, acked_seq))
            })
            .expect("delete-peer replication cursor");
        assert_ne!(imported, 0, "the delete resolve was imported");
        assert_eq!(
            acked_seq, 1,
            "the delete-peer ack advanced past the resolve"
        );
    }

    #[test]
    fn mirrored_unhydrated_binary_side_resolve_is_surfaced_and_acked() {
        let (_scratch, mut store) = store();
        let binary_bytes = b"binary bytes not retained";
        let binary_sha = dohc_engine_storage::hex_sha256(binary_bytes);
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("binary-unhydrated", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open text conflict");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(
                    tx,
                    &binary_sha,
                    binary_bytes,
                )
                .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET incoming_content_kind = 'binary', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'binary-unhydrated'",
                    [&binary_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("prepare binary side");
        store
            .read_with(|conn| {
                conn.execute_batch("PRAGMA foreign_keys = OFF")?;
                conn.execute("DELETE FROM binary_blobs WHERE sha256 = ?1", [&binary_sha])?;
                conn.execute_batch("PRAGMA foreign_keys = ON")?;
                Ok::<_, rusqlite::Error>(())
            })
            .expect("simulate a bundle whose bytes are not hydrated yet");
        let before_moments = moment_count(&store);

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "binary-unhydrated",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("unhydrated binary resolve is acknowledged and surfaced");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "binary-unhydrated".to_owned(),
                inserted: None,
                matched: false,
                pending_resolve: Some(PendingResolve {
                    remote_conflict_id: "binary-unhydrated".to_owned(),
                    local_conflict_id: Some("binary-unhydrated".to_owned()),
                    path: Some("doc.md".to_owned()),
                    reason: PendingResolveReason::BinaryUnhydrated,
                }),
            })
        );
        assert_eq!(read_text(&mut store), "receiver current");
        assert_eq!(moment_count(&store), before_moments);
        assert_eq!(materialization_job_count(&store), 0);
        assert_open_conflict(&store, "binary-unhydrated");
        assert_replication_advanced(&store, "peer", 1, 2);
    }

    /// BINCONFLICT review probe: a binary side that EXISTS and carries a sha
    /// through the replicated open path must still be rejected before log/ack
    /// (BINCONFLICT adds local persist capability only, not replicated binary
    /// ingestion).
    #[test]
    fn replicated_open_with_existing_binary_side_is_refused_and_acked() {
        let (_scratch, mut store) = store();
        let payload = json!({
            "id": "bin-exists",
            "workspaceId": "ws",
            "path": "asset.bin",
            "targetVersionId": "main",
            "sourceVersionId": "peer",
            "createdAtMs": 2_000,
            "updatedAtMs": 2_000,
            "base": { "exists": false, "path": "asset.bin", "contentKind": "text" },
            "current": { "exists": false, "path": "asset.bin", "contentKind": "text" },
            "incoming": {
                "exists": true,
                "path": "asset.bin",
                "objectId": "obj-1",
                "contentKind": "binary",
                "sha256": dohc_engine_storage::hex_sha256(b"payload"),
                "text": "",
                "updatedAtMs": 1_900,
                "latestMomentId": "m-1",
                "metadata": { "origin": "sync" }
            },
            "status": "open",
            "chosenFrom": "current",
            "metadata": { "origin": "sync" }
        });
        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope("peer", 0, "conflict.open", payload),
            &NoFaults,
        )
        .expect("existing binary side must be refused");
        assert!(matches!(outcome, ApplyOutcome::Refused(_)));
        let counts: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |r| r.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM replication_log", [], |r| r.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |r| r.get(0))?,
                ))
            })
            .expect("counts");
        assert_eq!(counts, (0, 1, 0), "only the refusal envelope may persist");
    }

    /// M3 (rev2 PROBE A, INVERTED). An incoming binary DELETE (exists=0,
    /// content_kind=binary, no sha) must DELETE the current file — mirroring the
    /// oracle's existence-before-kind ordering — not defer `BinaryUnhydrated`.
    #[test]
    fn incoming_binary_delete_deletes_like_the_oracle() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("bin-delete", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open text conflict");
        // Mark the incoming side as an ABSENT binary (a binary deletion).
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET incoming_exists = 0, \
                     incoming_content_kind = 'binary', incoming_blob_sha256 = NULL, \
                     incoming_binary_sha256 = NULL \
                     WHERE workspace_id = 'ws' AND conflict_id = 'bin-delete'",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("mark incoming as binary delete");

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "bin-delete",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("resolve applies");
        assert!(
            matches!(
                outcome,
                ApplyOutcome::Applied(ConflictApplyResult {
                    matched: true,
                    pending_resolve: None,
                    ..
                })
            ),
            "the binary delete resolves, not defers: {outcome:?}"
        );
        assert_resolved_conflict(&store, "bin-delete");
        assert_replication_advanced(&store, "peer", 1, 2);
        // The oracle DELETES here (read -> None); Rust now matches.
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "doc.md")
                .expect("read"),
            None,
            "the current file must be deleted, not left in place"
        );
    }

    /// A binary job's moment generation must not be re-issued to the next text
    /// write. The binary head now consumes the same moment sequence as text.
    #[test]
    fn binary_generation_is_not_reused_by_next_text_write() {
        let (_scratch, mut store) = store();
        let binary_bytes = b"\x00binary head\xff";
        let binary_sha = dohc_engine_storage::hex_sha256(binary_bytes);
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("gen-reuse", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open text conflict");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(
                    tx,
                    &binary_sha,
                    binary_bytes,
                )
                .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET incoming_content_kind = 'binary', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'gen-reuse'",
                    [&binary_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("hydrate binary side");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "gen-reuse",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("binary apply");
        let binary_gen: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT target_generation FROM materialization_jobs \
                     WHERE target_path = 'doc.md' ORDER BY target_generation DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("binary job generation");
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: "other-object".to_owned(),
                    path: "other.md".to_owned(),
                    text: "hello".to_owned(),
                    moment_id: "other-moment".to_owned(),
                    metadata_origin: "user".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 4_000,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("later text write");
        let next_moment_order: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT moment_order FROM moments WHERE moment_id = 'other-moment'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("later moment order");
        // The binary job's generation must be strictly below the next moment order,
        // preserving the materializer's strict-`>` newest-wins supersede gate.
        assert_ne!(
            binary_gen, next_moment_order,
            "generation collision: binary job gen must not equal the next moment order"
        );
    }

    /// Fix 1 (integrity-at-resolve). A PRESENT-but-CORRUPT incoming binary blob
    /// must PROPAGATE as `Err` (rolling back the envelope) rather than closing
    /// the conflict + enqueuing a doomed materialization job over an advanced
    /// ack. Only genuinely ABSENT bytes may defer.
    #[test]
    fn mirrored_corrupt_binary_side_resolve_errs_and_does_not_close() {
        let (_scratch, mut store) = store();
        let binary_bytes = b"\x00resolved binary\xff";
        let binary_sha = dohc_engine_storage::hex_sha256(binary_bytes);
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("binary-corrupt", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open text conflict");
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(
                    tx,
                    &binary_sha,
                    binary_bytes,
                )
                .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET incoming_content_kind = 'binary', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'binary-corrupt'",
                    [&binary_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("hydrate and mark binary side");
        // Bit-rot the canonical blob row out-of-band: the stored bytes no longer
        // hash to their key, so the integrity-verifying read must fail closed.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE binary_blobs SET bytes = ?2 WHERE sha256 = ?1",
                    rusqlite::params![binary_sha, b"rot".as_slice()],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("corrupt the canonical blob row");
        let before_moments = moment_count(&store);

        let error = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "binary-corrupt",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect_err("a corrupt binary blob must fail closed, not close the conflict");
        assert!(
            matches!(
                error,
                SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { .. })
            ),
            "corruption must surface as a storage integrity error, got {error:?}"
        );
        // The envelope rolled back: nothing applied, logged, acked, or staged.
        assert_eq!(moment_count(&store), before_moments);
        assert_eq!(materialization_job_count(&store), 0);
        assert_open_conflict(&store, "binary-corrupt");
        assert_eq!(
            replication_counts(&store),
            (1, 1, 1),
            "the failed resolve must not journal or ack over a storage fault"
        );
    }

    /// Fix 2 (delete-before-path-change). An ABSENT incoming side (a delete)
    /// whose recorded side path DIVERGES from the conflict path must DELETE the
    /// current file, not defer `PathChange`. The oracle refuses divergent paths
    /// only for an EXISTING incoming side.
    #[test]
    fn incoming_delete_with_divergent_path_deletes_not_defers() {
        let (_scratch, mut store) = store();
        seed_current(&mut store, "receiver current");
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                mirrored_open_payload("divergent-delete", "receiver current", "origin current"),
            ),
            &NoFaults,
        )
        .expect("open text conflict");
        // Mark the incoming side as an ABSENT binary at a DIVERGENT recorded path.
        store
            .write_with(&NoFaults, |tx| {
                tx.execute(
                    "UPDATE conflicts SET incoming_exists = 0, incoming_path = 'renamed.md', \
                     incoming_content_kind = 'binary', incoming_blob_sha256 = NULL, \
                     incoming_binary_sha256 = NULL \
                     WHERE workspace_id = 'ws' AND conflict_id = 'divergent-delete'",
                    [],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("mark incoming as divergent-path delete");

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "divergent-delete",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "targetVersionId": "main"
                }),
            ),
            &NoFaults,
        )
        .expect("resolve applies");
        assert!(
            matches!(
                outcome,
                ApplyOutcome::Applied(ConflictApplyResult {
                    matched: true,
                    pending_resolve: None,
                    ..
                })
            ),
            "the divergent-path delete resolves, not defers PathChange: {outcome:?}"
        );
        assert_resolved_conflict(&store, "divergent-delete");
        assert_replication_advanced(&store, "peer", 1, 2);
        assert_eq!(
            VersionedTextStore::new(&mut store)
                .read_text("ws", "main", "doc.md")
                .expect("read"),
            None,
            "the current file must be deleted, not left in place"
        );
    }

    /// Fix 3 (non-sync hydrated binary). A NON-sync ("verbatim replicated
    /// merge") conflict carrying a hydrated binary side must CLOSE its row like
    /// any other verbatim resolve — content replicates via its own moments — and
    /// must NOT falsely defer `BinaryUnhydrated`.
    #[test]
    fn non_sync_hydrated_binary_conflict_resolve_closes_the_row() {
        let (_scratch, mut store) = store();
        let binary_bytes = b"\x00verbatim binary\xff";
        let binary_sha = dohc_engine_storage::hex_sha256(binary_bytes);
        apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.open",
                open_payload("nonsync-bin", "merge", false),
            ),
            &NoFaults,
        )
        .expect("open non-sync text conflict");
        // Hydrate a binary side and mark it on the (non-sync) row.
        store
            .write_with(&NoFaults, |tx| {
                dohc_engine_domain::conflicts::hydrate_binary_conflict_blob(
                    tx,
                    &binary_sha,
                    binary_bytes,
                )
                .map_err(map_domain)?;
                tx.execute(
                    "UPDATE conflicts SET incoming_exists = 1, \
                     incoming_content_kind = 'binary', incoming_object_id = 'incoming-object', \
                     incoming_blob_sha256 = NULL, incoming_binary_sha256 = ?1 \
                     WHERE workspace_id = 'ws' AND conflict_id = 'nonsync-bin'",
                    [&binary_sha],
                )
                .map_err(SyncError::persist)?;
                Ok::<_, SyncError>(())
            })
            .expect("hydrate and mark non-sync binary side");

        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.resolve",
                json!({
                    "conflictId": "nonsync-bin",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000
                }),
            ),
            &NoFaults,
        )
        .expect("non-sync binary resolve closes the row");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "nonsync-bin".to_owned(),
                inserted: None,
                matched: true,
                pending_resolve: None,
            }),
            "a hydrated non-sync binary conflict must close, not defer BinaryUnhydrated"
        );
        store
            .read_with(|conn| {
                let (status, resolution): (String, Option<String>) = conn.query_row(
                    "SELECT status, resolution FROM conflicts \
                     WHERE workspace_id = 'ws' AND conflict_id = 'nonsync-bin'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                assert_eq!(status, "resolved");
                assert_eq!(resolution.as_deref(), Some("kept-current"));
                Ok::<_, rusqlite::Error>(())
            })
            .expect("closed non-sync binary conflict");
    }

    /// Fix 4 (unmatched target). A peer `conflict.resolve` that matches NO local
    /// conflict must journal + ack (the cursor advances) but be SURFACED as a
    /// `PendingResolve` with `local_conflict_id: None` and the payload path,
    /// never silently dropped.
    #[test]
    fn unmatched_conflict_resolve_is_surfaced_and_acked() {
        let (_scratch, mut store) = store();
        let outcome = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                0,
                "conflict.resolve",
                json!({
                    "conflictId": "ghost",
                    "status": "resolved",
                    "chosenFrom": "current",
                    "resolution": "kept-current",
                    "updatedAtMs": 3_000,
                    "path": "ghost.md"
                }),
            ),
            &NoFaults,
        )
        .expect("unmatched resolve is acknowledged and surfaced");
        assert_eq!(
            outcome,
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "ghost".to_owned(),
                inserted: None,
                matched: false,
                pending_resolve: Some(PendingResolve {
                    remote_conflict_id: "ghost".to_owned(),
                    local_conflict_id: None,
                    path: Some("ghost.md".to_owned()),
                    reason: PendingResolveReason::UnmatchedTarget,
                }),
            })
        );
        // No conflict row exists, but the peer cursor still advanced.
        store
            .read_with(|conn| {
                let acked_seq: i64 = conn.query_row(
                    "SELECT acked_seq FROM replication_peers \
                     WHERE workspace_id = 'ws' AND origin_id = 'peer'",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(acked_seq, 0);
                let conflicts: i64 =
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))?;
                assert_eq!(conflicts, 0);
                Ok::<_, rusqlite::Error>(())
            })
            .expect("cursor advanced without a conflict row");
    }
}
