use std::collections::HashSet;

use dohc_engine_files::{PathClassification, classify_engine_file_path};
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
    fork_snapshots: Option<Vec<ForkSnapshot>>,
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
struct SnapshotMetadata {
    origin: String,
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
    apply_envelope_with(store, envelope, faults, |tx, op| {
        apply_version_create(tx, op)
    })
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
    let has_fork_snapshots = op
        .payload
        .as_object()
        .is_some_and(|payload| payload.contains_key("forkSnapshots"));
    let payload: VersionCreatePayload =
        serde_json::from_value(op.payload.clone()).map_err(|_| SyncError::InvalidInput {
            reason: "version.create payload is malformed",
        })?;
    if has_fork_snapshots && payload.fork_snapshots.is_none() {
        return Err(SyncError::InvalidInput {
            reason: "version.create forkSnapshots is malformed",
        });
    }
    validate_version_payload(&payload)?;

    let existing: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM versions WHERE workspace_id=?1 AND version_id=?2)",
            params![op.workspace_id, payload.version_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)?;
    if existing {
        return Ok(());
    }
    if payload.version_id != "main" {
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

    let source = match payload.fork_version_id.as_deref() {
        Some(version_id) => tx
            .query_row(
                "SELECT version_id FROM versions WHERE workspace_id=?1 AND version_id=?2",
                params![op.workspace_id, version_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)?
            .ok_or(SyncError::InvalidInput {
                reason: "version.create source version is missing",
            })
            .map(Some)?,
        None => None,
    };

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
    let Some(source) = source else {
        return Ok(());
    };

    if let Some(snapshots) = payload.fork_snapshots {
        validate_shipped_snapshots(&snapshots)?;
        for snapshot in snapshots {
            insert_shipped_snapshot(tx, op, &payload.version_id, payload.created_at_ms, snapshot)?;
        }
        return Ok(());
    }

    tx.execute(
        "INSERT INTO snapshots \
         (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
         SELECT workspace_id,?2,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256 \
         FROM snapshots WHERE workspace_id=?1 AND version_id=?3",
        params![op.workspace_id, payload.version_id, source],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
         SELECT workspace_id,?2,path,object_id FROM path_aliases \
         WHERE workspace_id=?1 AND version_id=?3",
        params![op.workspace_id, payload.version_id, source],
    )
    .map_err(SyncError::persist)?;
    tx.execute(
        "INSERT INTO fork_base_snapshots \
         (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
         SELECT workspace_id,?2,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256 \
         FROM snapshots WHERE workspace_id=?1 AND version_id=?3",
        params![op.workspace_id, payload.version_id, source],
    )
    .map_err(SyncError::persist)?;
    Ok(())
}

fn validate_shipped_snapshots(snapshots: &[ForkSnapshot]) -> Result<(), SyncError> {
    let mut paths = HashSet::with_capacity(snapshots.len());
    for snapshot in snapshots {
        if classify_engine_file_path(&snapshot.path) != PathClassification::Tracked {
            return Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot path must be tracked",
            });
        }
        if !paths.insert(snapshot.path.as_str()) {
            return Err(SyncError::InvalidInput {
                reason: "version.create shipped snapshot paths must be unique",
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
            "INSERT INTO {table} \
             (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,content_kind,binary_sha256) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)"
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
                content_kind,
                binary_sha
            ],
        )
        .map_err(SyncError::persist)?;
    }
    tx.execute(
        "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) \
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
