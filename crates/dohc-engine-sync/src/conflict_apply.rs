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
    load_text_conflict_in_tx, select_text_snapshot_by_path_in_tx, update_text_conflict_row,
    validate_delete_input, validate_write_input, write_binary_file_in_tx, write_text_in_tx,
};
use dohc_engine_storage::{EngineStore, FaultInjector, Preimage};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};

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
        match op.op_kind.as_str() {
            "conflict.open" => apply_open(tx, op),
            "conflict.resolve" => apply_resolve(tx, op),
            _ => Err(SyncError::UnsupportedOperation),
        }
    })
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
        // This surfacing is deliberately BEST-EFFORT / informational and is not
        // durably persisted: unlike the four defer reasons — each backed by an
        // Open `conflicts` row that survives a crash — an unmatched resolve has
        // NO local state to reconcile (the conflict does not exist on this
        // node), so there is nothing actionable to rebuild. A commit-to-response
        // crash + replay returns `Skipped` and drops only the diagnostic
        // surfacing of a peer's decision about a conflict we never held — never
        // any convergence-relevant or actionable state. Durable persistence
        // (a pending-resolve table) would need a migration and is unwarranted
        // for a purely informational no-op.
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
        .ok_or(SyncError::InvalidInput {
            reason: "replicated conflict target disappeared",
        })?;
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
    let live = match conflict.current.content_kind {
        ConflictContentKind::Text => ConflictFileState::text(
            conflict.path.clone(),
            select_text_snapshot_by_path_in_tx(
                tx,
                &envelope.workspace_id,
                &conflict.target_version_id,
                &conflict.path,
            )
            .map_err(map_domain)?,
        ),
        // The current Rust version-domain tables do not expose a binary
        // snapshot head. Refuse to guess that state is still live.
        ConflictContentKind::Binary => {
            return Ok(MirroredOutcome::Deferred(PendingResolveReason::StaleHead));
        }
    };
    if !live_state_matches_conflict_current(&live, &conflict.current) {
        return Ok(MirroredOutcome::Deferred(PendingResolveReason::StaleHead));
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
                return apply_mirrored_delete(tx, envelope, &conflict);
            }
            if conflict.incoming.content_kind == ConflictContentKind::Binary {
                return apply_mirrored_binary_write(tx, envelope, &conflict);
            }
            match &conflict.incoming.snapshot {
                Some(incoming) => {
                    apply_mirrored_text_write(tx, envelope, &conflict, &incoming.text)
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
    let preimage = conflict
        .current
        .snapshot
        .as_ref()
        .map_or(Preimage::Absent, |snapshot| {
            Preimage::Present(snapshot.blob_sha256.clone())
        });
    let input = WriteBinaryFile {
        workspace_id: envelope.workspace_id.clone(),
        version_id: conflict.target_version_id.clone(),
        object_id: mirrored_id(envelope, "object"),
        path: conflict.path.clone(),
        binary_sha256: sha256.to_owned(),
        job_id: mirrored_id(envelope, "binary-materialize"),
        preimage,
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
        author_json: None,
        now_ms: envelope.recorded_at_ms,
        request_id: None,
    };
    let preimage = conflict
        .current
        .snapshot
        .as_ref()
        .map_or(Preimage::Absent, |snapshot| {
            Preimage::Present(snapshot.blob_sha256.clone())
        });
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

/// Apply an incoming delete (an absent incoming side) inside its own savepoint,
/// with the same defer-vs-`Err` contract as the text write.
fn apply_mirrored_delete(
    tx: &Transaction<'_>,
    envelope: &ReplicationEnvelope,
    conflict: &TextConflict,
) -> Result<MirroredOutcome, SyncError> {
    // Nothing to remove if the receiver already has no live text head.
    if conflict.current.snapshot.is_none() {
        return Ok(MirroredOutcome::Applied);
    }
    let input = DeleteTextFile {
        workspace_id: envelope.workspace_id.clone(),
        version_id: conflict.target_version_id.clone(),
        path: conflict.path.clone(),
        moment_id: mirrored_id(envelope, "delete"),
        metadata_origin: "sync".to_owned(),
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
                    author_json: None,
                    now_ms: 1_500,
                    request_id: None,
                },
                &NoFaults,
            )
            .expect("seed current text");
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
                let snapshot_count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id = 'ws' AND version_id = 'main' AND object_id = ?1",
                    [&object_id],
                    |row| row.get(0),
                )?;
                assert_eq!(object_count, 1);
                assert_eq!(job_sha, sha256);
                assert_eq!(status, "pending");
                assert_eq!(operation, "write");
                assert_eq!(snapshot_count, 0, "the superseded text head must be gone");
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
    fn conflict_open_rejects_terminal_status_or_resolution_before_log_and_ack() {
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
            let error = apply_conflict_envelope(
                &mut store,
                &envelope("peer", 0, "conflict.open", payload),
                &NoFaults,
            )
            .expect_err("terminal conflict.open must fail");
            assert!(matches!(error, SyncError::InvalidInput { .. }), "{case}");
            assert_eq!(replication_counts(&store), (0, 0, 0), "{case}");
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
        let error = apply_conflict_envelope(
            &mut store,
            &envelope("peer", 0, "conflict.open", payload),
            &NoFaults,
        )
        .expect_err("missing text must fail");
        assert!(matches!(error, SyncError::InvalidInput { .. }));
        assert_eq!(replication_counts(&store), (0, 0, 0));
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
    fn conflict_open_with_binary_side_is_rejected_before_log_or_ack() {
        let (_scratch, mut store) = store();
        let binary = envelope(
            "peer",
            0,
            "conflict.open",
            open_payload("binary-c", "sync", true),
        );
        let error = apply_conflict_envelope(&mut store, &binary, &NoFaults)
            .expect_err("binary side must fail closed");
        assert!(matches!(error, SyncError::InvalidInput { .. }));
        assert_eq!(replication_counts(&store), (0, 0, 0));
    }

    /// An invalid binary open that REUSES an already-open conflict id must not
    /// slip through the duplicate-id shortcut: it is rejected fail-closed
    /// before log/ack, not absorbed as an idempotent duplicate.
    #[test]
    fn duplicate_conflict_open_with_binary_side_is_rejected_before_log_or_ack() {
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

        let error = apply_conflict_envelope(
            &mut store,
            &envelope(
                "peer",
                1,
                "conflict.open",
                open_payload("dup-c", "sync", true),
            ),
            &NoFaults,
        )
        .expect_err("invalid binary side on a duplicate id must fail closed");
        assert!(matches!(error, SyncError::InvalidInput { .. }));
        assert_eq!(
            replication_counts(&store),
            (1, 1, 1),
            "the rejected duplicate must not be logged or acked"
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
        assert_eq!(moment_count(&store), before_moments);
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
    fn replicated_open_with_existing_binary_side_rejected_before_ack() {
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
        let error = apply_conflict_envelope(
            &mut store,
            &envelope("peer", 0, "conflict.open", payload),
            &NoFaults,
        )
        .expect_err("existing binary side must fail closed");
        assert!(matches!(error, SyncError::InvalidInput { .. }));
        let counts: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |r| r.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM replication_log", [], |r| r.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM binary_blobs", [], |r| r.get(0))?,
                ))
            })
            .expect("counts");
        assert_eq!(counts, (0, 0, 0), "nothing may persist, log, or hydrate");
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

    /// M2 (rev2 PROBE B, INVERTED — `#[ignore]d`). A binary job's generation
    /// must NOT be re-issued to the next same-path text write. This is BLOCKED
    /// on an out-of-owned-path change (a real binary moment, or a
    /// `store::next_moment_order` that counts jobs), so the assertion documents
    /// the target invariant and stays ignored until that fix lands. Run with
    /// `--ignored` to reproduce the collision.
    #[test]
    #[ignore = "M2: generation collision fix needs a moments-schema or store::next_moment_order change (outside this shard's owned paths); documents the target invariant"]
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
        // TARGET INVARIANT (currently violated → this test is #[ignore]d): the
        // binary job's generation must be strictly below the next moment order,
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
