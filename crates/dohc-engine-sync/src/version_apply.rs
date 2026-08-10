use std::collections::HashSet;

use dohc_engine_files::{PathClassification, classify_engine_file_path_normalized};
use dohc_engine_storage::{EngineStore, FaultInjector};
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Deserialize;

use crate::{ApplyOutcome, ReplicationEnvelope, SyncError, apply_envelope_with};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionCreatePayload {
    version_id: String,
    name: String,
    kind: String,
    fork_version_id: Option<String>,
    fork_moment_id: Option<String>,
    created_at_ms: i64,
    fork_snapshots: Vec<ForkSnapshot>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForkSnapshot {
    object_id: String,
    object_created_at_ms: Option<i64>,
    path: String,
    content_kind: Option<String>,
    blob_sha256: String,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata: SnapshotMetadata,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMetadata {
    origin: String,
    summary: Option<String>,
    correlation_id: Option<String>,
}

pub fn apply_workspace_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    if envelope.op_kind != "workspace.init" {
        return Err(SyncError::UnsupportedOperation);
    }
    apply_envelope_with(store, envelope, faults, apply_workspace_init)
}

pub fn apply_version_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn FaultInjector,
) -> Result<ApplyOutcome<()>, SyncError> {
    if envelope.op_kind != "version.create" {
        return Err(SyncError::UnsupportedOperation);
    }
    apply_envelope_with(store, envelope, faults, apply_version_create)
}

fn apply_workspace_init(tx: &Transaction<'_>, op: &ReplicationEnvelope) -> Result<(), SyncError> {
    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versioned_workspaces w \
             JOIN versions v ON v.workspace_id=w.workspace_id \
               AND v.version_id=w.main_version_id \
             WHERE w.workspace_id=?1)",
            [&op.workspace_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if existing {
        return Ok(());
    }
    tx.execute(
        "INSERT OR IGNORE INTO versioned_workspaces (workspace_id,main_version_id) \
         VALUES (?1,'main')",
        [&op.workspace_id],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT INTO versions \
         (workspace_id,version_id,kind,name,created_at_ms,fork_version_id,fork_moment_id) \
         VALUES (?1,'main','main','Main',?2,NULL,NULL)",
        params![op.workspace_id, op.recorded_at_ms],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn apply_version_create(tx: &Transaction<'_>, op: &ReplicationEnvelope) -> Result<(), SyncError> {
    let has_valid_fork_snapshots = op
        .payload
        .as_object()
        .and_then(|payload| payload.get("forkSnapshots"))
        .is_some_and(serde_json::Value::is_array);
    if !has_valid_fork_snapshots {
        return Err(SyncError::InvalidInput {
            reason: "version.create forkSnapshots is malformed",
        });
    }
    let payload: VersionCreatePayload =
        serde_json::from_value(op.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "version.create payload is malformed",
        })?;
    validate_version_payload(&payload)?;

    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versions WHERE workspace_id=?1 AND version_id=?2)",
            params![op.workspace_id, payload.version_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if !existing && payload.version_id != "main" {
        let collision: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM versions WHERE version_id=?1)",
                [&payload.version_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)?;
        if collision {
            return Err(SyncError::InvalidInput {
                reason: "version id belongs to another workspace",
            });
        }
    }

    if let Some(version_id) = payload.fork_version_id.as_deref() {
        tx.query_row(
            "SELECT version_id FROM versions WHERE workspace_id=?1 AND version_id=?2",
            params![op.workspace_id, version_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(SyncError::corrupt)?
        .ok_or(SyncError::RetryableState {
            reason: "version.create source version is missing",
        })?;
    }

    if !existing {
        tx.execute(
            "INSERT INTO versions \
             (workspace_id,version_id,kind,name,created_at_ms,fork_version_id,fork_moment_id) \
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                op.workspace_id,
                payload.version_id,
                payload.kind,
                payload.name,
                payload.created_at_ms,
                payload.fork_version_id,
                payload.fork_moment_id
            ],
        )
        .map_err(SyncError::persist)?;
    }
    validate_shipped_snapshots(&payload.fork_snapshots)?;
    for snapshot in payload.fork_snapshots {
        insert_shipped_snapshot(tx, op, &payload.version_id, payload.created_at_ms, snapshot)?;
    }
    Ok(())
}

/// Gate shipped fork snapshots through the SAME floor the local plaintext
/// write path uses (`validate_plaintext_storable_path`): tracked classification
/// only — secret-classified paths never enter the ordinary blob/snapshot/alias
/// surface — and the wire path must already BE its own canonical form, because
/// these rows are persisted verbatim as durable keys.
fn validate_shipped_snapshots(snapshots: &[ForkSnapshot]) -> Result<(), SyncError> {
    let mut paths = HashSet::with_capacity(snapshots.len());
    for snapshot in snapshots {
        let (classification, normalized) = classify_engine_file_path_normalized(&snapshot.path);
        if classification != PathClassification::Tracked {
            return Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot path must be tracked",
            });
        }
        if normalized.as_deref() != Some(snapshot.path.as_str()) {
            return Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot path must be canonical",
            });
        }
        if !paths.insert(snapshot.path.as_str()) {
            return Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot paths must be unique",
            });
        }
        if !matches!(
            snapshot.content_kind.as_deref(),
            None | Some("text" | "binary")
        ) {
            return Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot content kind is invalid",
            });
        }
    }
    Ok(())
}

fn validate_version_payload(payload: &VersionCreatePayload) -> Result<(), SyncError> {
    crate::model::bounded(
        &payload.version_id,
        "version.create version id must be non-empty and bounded",
    )?;
    if !matches!(payload.kind.as_str(), "main" | "named") {
        return Err(SyncError::InvalidInput {
            reason: "version.create kind is invalid",
        });
    }
    if let Some(version_id) = payload.fork_version_id.as_deref() {
        crate::model::bounded(
            version_id,
            "version.create source version id must be non-empty and bounded",
        )?;
    }
    Ok(())
}

fn insert_shipped_snapshot(
    tx: &Transaction<'_>,
    op: &ReplicationEnvelope,
    version_id: &str,
    version_created_at_ms: i64,
    snapshot: ForkSnapshot,
) -> Result<(), SyncError> {
    crate::model::bounded(
        &snapshot.object_id,
        "version.create object id must be non-empty and bounded",
    )?;
    let is_binary = snapshot.content_kind.as_deref().unwrap_or("text") == "binary";
    let blob_exists: bool = if is_binary {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM binary_blobs WHERE sha256=?1)",
            [&snapshot.blob_sha256],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?
    } else {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM blobs WHERE sha256=?1)",
            [&snapshot.blob_sha256],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?
    };
    if !blob_exists {
        return Err(SyncError::BlobInvalid);
    }
    tx.execute(
        "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
         VALUES (?1,?2,?3)",
        params![
            op.workspace_id,
            snapshot.object_id,
            snapshot
                .object_created_at_ms
                .unwrap_or(version_created_at_ms)
        ],
    )
    .map_err(SyncError::persist)?;
    let (content_kind, text_sha, binary_sha) = if is_binary {
        ("binary", None, Some(snapshot.blob_sha256.as_str()))
    } else {
        ("text", Some(snapshot.blob_sha256.as_str()), None)
    };
    for table in ["snapshots", "fork_base_snapshots"] {
        let sql = format!(
            "INSERT OR IGNORE INTO {table} \
             (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,metadata_summary,metadata_correlation_id,content_kind,binary_sha256) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)"
        );
        tx.execute(
            &sql,
            params![
                op.workspace_id,
                version_id,
                snapshot.object_id,
                snapshot.path,
                text_sha,
                snapshot.updated_at_ms,
                snapshot.latest_moment_id,
                snapshot.metadata.origin,
                snapshot.metadata.summary,
                snapshot.metadata.correlation_id,
                content_kind,
                binary_sha
            ],
        )
        .map_err(SyncError::persist)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO path_aliases (workspace_id,version_id,path,object_id) \
         VALUES (?1,?2,?3,?4)",
        params![
            op.workspace_id,
            version_id,
            snapshot.path,
            snapshot.object_id
        ],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}
