//! Replicated conflict.open/conflict.resolve application.
//!
//! Conflict content writes/deletes replicate independently as ordered moment
//! operations. This path mirrors the durable conflict object's inline text
//! sides on open and its resolution metadata on resolve. For independently
//! minted sync conflicts, current/incoming are swapped between peers, so the
//! choice and resolution are mirrored before the row is closed. Binary sides
//! remain explicitly fail-closed until their binary_blobs-backed schema exists.

use dohc_engine_domain::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictRowUpdate, ConflictStatus, DomainError, TextConflict, TextSnapshot,
    insert_text_conflict_if_absent, update_text_conflict_row,
};
use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;

use crate::{ApplyOutcome, ReplicationEnvelope, SyncError, apply_envelope_with};

/// Result details callers surface instead of silently swallowing an unmatched
/// replicated resolve.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictApplyResult {
    pub conflict_id: String,
    pub inserted: Option<bool>,
    pub matched: bool,
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
    metadata_origin: String,
    status: String,
    chosen_from: String,
    resolution: Option<String>,
    has_binary_side: bool,
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
        return Ok(ConflictApplyResult {
            conflict_id: payload.conflict_id,
            inserted: None,
            matched: false,
        });
    };
    if target.has_binary_side {
        return Err(SyncError::InvalidInput {
            reason: "binary conflict sides are not supported yet",
        });
    }
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
            return Err(SyncError::InvalidInput {
                reason: "conflicting conflict resolution",
            });
        }
        return Ok(ConflictApplyResult {
            conflict_id: target.conflict_id,
            inserted: None,
            matched: true,
        });
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
    })
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
        "SELECT conflict_id, metadata_origin, status, chosen_from, resolution, \
         (base_content_kind = 'binary' OR current_content_kind = 'binary' OR \
          incoming_content_kind = 'binary') \
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
        "SELECT conflict_id, metadata_origin, status, chosen_from, resolution, \
         (base_content_kind = 'binary' OR current_content_kind = 'binary' OR \
          incoming_content_kind = 'binary') \
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
        metadata_origin: row.get(1)?,
        status: row.get(2)?,
        chosen_from: row.get(3)?,
        resolution: row.get(4)?,
        has_binary_side: row.get(5)?,
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
    use dohc_engine_domain::{ConflictChoice, ConflictResolution, VersionedTextStore};
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
            })
        );
        assert_eq!(
            apply_conflict_envelope(&mut store, &second, &NoFaults).expect("second"),
            ApplyOutcome::Applied(ConflictApplyResult {
                conflict_id: "c1".to_owned(),
                inserted: Some(false),
                matched: true,
            })
        );
        let rows = VersionedTextStore::new(&mut store)
            .list_text_conflicts("ws", None)
            .expect("list");
        assert_eq!(rows.len(), 1);
    }

    #[test]
    fn conflict_resolve_mirror_apply_converges_on_remote_side_choice() {
        let (_scratch, mut store) = store();
        let open = envelope(
            "peer",
            0,
            "conflict.open",
            open_payload("sync-c", "sync", false),
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
    fn conflicting_second_conflict_resolve_is_rejected_without_mutation() {
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
        let error = apply_conflict_envelope(
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
        .expect_err("different terminal resolution must fail");
        assert!(matches!(error, SyncError::InvalidInput { .. }));
        let rows = VersionedTextStore::new(&mut store)
            .list_text_conflicts("ws", Some("resolved"))
            .expect("list");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].chosen_from, ConflictChoice::Current);
        assert_eq!(rows[0].resolution, Some(ConflictResolution::KeptCurrent));
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
}
