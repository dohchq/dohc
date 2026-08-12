//! Replicated conflict opening and strict conflict-resolution application.

use dohc_engine_domain::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictStatus,
    DomainError, TextConflict, TextSnapshot, insert_text_conflict_if_absent,
};
use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::{Transaction, params};
use serde::Deserialize;

use crate::{ApplyOutcome, LeaseProbe, ReplicationEnvelope, SyncError, apply_envelope_with};

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
    leases: &dyn LeaseProbe,
) -> Result<ApplyOutcome<ConflictApplyResult>, SyncError> {
    if !matches!(
        envelope.op_kind.as_str(),
        "conflict.open" | "conflict.resolve"
    ) {
        return Err(SyncError::UnsupportedOperation);
    }
    if envelope.op_kind == "conflict.resolve"
        && envelope
            .payload
            .get("formatVersion")
            .and_then(serde_json::Value::as_u64)
            != Some(1)
    {
        return Err(SyncError::InvalidInput {
            reason: "conflict.resolve formatVersion 1 is required",
        });
    }
    if envelope.op_kind == "conflict.resolve" {
        // Validate before the generic apply wrapper. An invalid parent cannot
        // be ACKed because its later tagged children cannot be authenticated.
        crate::conflict_resolve_v1::validate_conflict_resolve_v1(
            &envelope.payload,
            crate::conflict_resolve_v1::ConflictResolveEnvelopeContext {
                workspace_id: &envelope.workspace_id,
                recorded_at_ms: envelope.recorded_at_ms,
            },
        )?;
    }
    let search_policy = crate::file_search::search_policy_for_store(store);
    apply_envelope_with(store, envelope, faults, |tx, op| {
        match op.op_kind.as_str() {
            "conflict.open" => apply_open(tx, op),
            "conflict.resolve" => {
                crate::conflict_resolve_v1::apply_imported_conflict_resolve_v1_in_tx(
                    tx,
                    op,
                    search_policy.as_ref(),
                    leases,
                )
            }
            _ => Err(SyncError::UnsupportedOperation),
        }
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

pub(crate) fn redelivered_materialization_changes(
    store: &EngineStore,
    envelope: &ReplicationEnvelope,
) -> Result<Vec<crate::MomentMaterializationChange>, SyncError> {
    if envelope.op_kind != "conflict.resolve" {
        return Ok(Vec::new());
    }
    crate::moment_apply::stored_materialization_changes(store, envelope)
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
        binary_sha256: None,
        binary_byte_length: None,
        binary_object_id: None,
        binary_latest_moment_id: None,
        binary_updated_at_ms: None,
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

fn map_domain(error: DomainError) -> SyncError {
    match error {
        DomainError::Storage(storage) => SyncError::Storage(storage),
        hard @ (DomainError::StateCorrupt { .. } | DomainError::Crypto(_)) => {
            SyncError::Storage(dohc_engine_storage::StorageError::corrupt_public(hard))
        }
        DomainError::ConflictMetadataTooLarge { .. } => SyncError::InvalidInput {
            reason: "replicated conflict metadata exceeds the conflicts.list row budget",
        },
        _ => SyncError::InvalidInput {
            reason: "replicated conflict operation is invalid",
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_domain::VersionedTextStore;
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

    fn envelope(kind: &str, payload: serde_json::Value) -> ReplicationEnvelope {
        ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "peer".to_owned(),
            origin_seq: 0,
            op_kind: kind.to_owned(),
            payload,
            recorded_at_ms: 2_000,
        }
    }

    fn open_payload(id: &str) -> serde_json::Value {
        let side = |text: &str, object_id: &str, moment_id: &str| {
            json!({
                "exists": true,
                "path": "doc.md",
                "objectId": object_id,
                "contentKind": "text",
                "text": text,
                "updatedAtMs": 1_900,
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
            "current": side("current", "current-object", "current-moment"),
            "incoming": side("incoming", "incoming-object", "incoming-moment"),
            "status": "open",
            "chosenFrom": "current",
            "metadata": { "origin": "sync" }
        })
    }

    #[test]
    fn conflict_open_inserts_once_and_replays() {
        let (_scratch, mut store) = store();
        let envelope = envelope("conflict.open", open_payload("conflict-open"));
        let first = apply_conflict_envelope(&mut store, &envelope, &NoFaults, &crate::NoLiveLeases)
            .expect("first open");
        assert!(matches!(
            first,
            ApplyOutcome::Applied(ConflictApplyResult {
                inserted: Some(true),
                matched: true,
                ..
            })
        ));
        let replay =
            apply_conflict_envelope(&mut store, &envelope, &NoFaults, &crate::NoLiveLeases)
                .expect("replay open");
        assert!(matches!(replay, ApplyOutcome::Skipped));
    }

    #[test]
    fn unversioned_conflict_resolve_is_refused_before_import_mutation() {
        let (_scratch, mut store) = store();
        let envelope = envelope(
            "conflict.resolve",
            json!({
                "conflictId": "legacy-resolve",
                "status": "resolved",
                "chosenFrom": "current",
                "resolution": "kept-current",
                "updatedAtMs": 2_000,
                "targetVersionId": "main"
            }),
        );

        let error = apply_conflict_envelope(&mut store, &envelope, &NoFaults, &crate::NoLiveLeases)
            .expect_err("strict conflict.resolve v1 is the sole accepted contract");
        assert!(matches!(
            error,
            SyncError::InvalidInput {
                reason: "conflict.resolve formatVersion 1 is required"
            }
        ));
        let fingerprint = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM replication_peers", [], |row| {
                        row.get(0)
                    })?,
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))?,
                ))
            })
            .expect("read mutation fingerprint");
        assert_eq!(fingerprint, (0, 0, 0));
    }

    #[test]
    fn malformed_v1_conflict_resolve_is_refused_before_import_mutation() {
        let (_scratch, mut store) = store();
        let envelope = envelope("conflict.resolve", json!({ "formatVersion": 1 }));

        apply_conflict_envelope(&mut store, &envelope, &NoFaults, &crate::NoLiveLeases)
            .expect_err("malformed strict v1 must fail before imported bookkeeping");
        let fingerprint = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row("SELECT COUNT(*) FROM replication_log", [], |row| row.get(0))?,
                    conn.query_row("SELECT COUNT(*) FROM replication_peers", [], |row| {
                        row.get(0)
                    })?,
                    conn.query_row("SELECT COUNT(*) FROM conflicts", [], |row| row.get(0))?,
                ))
            })
            .expect("read mutation fingerprint");
        assert_eq!(fingerprint, (0, 0, 0));
    }
}
