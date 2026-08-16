use dohc_engine_collab::{
    ContentKind, DocKey, Regime, RemoteUpdate, ReplicationApplyOutcome, apply_remote_update,
    encode_scene_asset_records, ensure_marker, import_portable_scene, scene_asset_ref,
};
use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBinary, CaptureRetire, CaptureSecret, CaptureSecretRetire,
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, CreateNamedVersion,
    DeleteTextFile, MergeTextFileFromVersion, RenameTextFile, ResolveConflictKind,
    ResolveTextConflict, RollbackTextFileMutation, SecretDelete, SecretDiskIntent, SecretWrite,
    TextConflict, TextSnapshot, VersionedTextStore, WriteBinary, WriteText,
    rollback_compensating_moment_id,
};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, NoFaults, RuntimeError, SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, FaultPoint, StorageError, TxnOutcome, hex_sha256};
use dohc_engine_sync::{
    ApplyOutcome, MAX_PAYLOAD_JSON_BYTES, ReplicationEnvelope, apply_moment_envelope_detailed,
    apply_replication_envelope, apply_secret_envelope, apply_version_envelope,
};
use dohc_engine_testkit::{ScratchDir, ScriptedFaults};
use rusqlite::params;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

struct NoRecorder;

const ONE_PIXEL_PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0,
    0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1,
    39, 24, 227, 102, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
const ONE_PIXEL_PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

fn portable_image_scene() -> String {
    format!(
        r#"{{
  "type": "excalidraw",
  "version": 2,
  "source": "https://excalidraw.com",
  "elements": [
    {{
      "fileId": "image-file",
      "id": "image-element",
      "index": "a0",
      "isDeleted": false,
      "type": "image",
      "version": 1,
      "versionNonce": 1
    }}
  ],
  "appState": {{}},
  "files": {{
    "image-file": {{
      "created": 4,
      "dataURL": "data:image/png;base64,{ONE_PIXEL_PNG_BASE64}",
      "id": "image-file",
      "mimeType": "image/png"
    }}
  }}
}}"#
    )
}

impl SelfWriteRecorder for NoRecorder {
    fn record(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
    fn retract(&self, _workspace_id: &str, _path: &str, _sha256: &str) {}
}

#[derive(Debug)]
struct LoggedOp {
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

impl LoggedOp {
    fn envelope(&self, workspace_id: &str) -> ReplicationEnvelope {
        ReplicationEnvelope {
            workspace_id: workspace_id.to_owned(),
            origin_id: self.origin_id.clone(),
            origin_seq: self.origin_seq,
            relay_seq: None,
            op_kind: self.op_kind.clone(),
            payload: self.payload.clone(),
            recorded_at_ms: self.recorded_at_ms,
        }
    }
}

fn initialize_workspace(db: &Path, workspace_id: &str, relay_enabled: bool) {
    let mut store = EngineStore::open(db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("ensure main version");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO sync_identity \
                 (workspace_id, origin_id, replication_epoch, stream_identity, created_at_ms) \
                 VALUES (?1, 'origin-local', 'epoch-local', 'stream-local', 1)",
                [workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            if relay_enabled {
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                     VALUES (?1, 'origin-local', 0)",
                    [workspace_id],
                )
                .map_err(StorageError::persist_public)?;
            }
            Ok::<_, StorageError>(())
        })
        .expect("seed sync state");
}

fn apply_remote_scene_asset_authority(
    store: &mut EngineStore,
    workspace_id: &str,
    drawing_object_id: &str,
    asset_path: &str,
    asset_sha256: &str,
    now_ms: i64,
) {
    let key = DocKey::new(workspace_id, "main", drawing_object_id).expect("scene doc key");
    ensure_marker(
        store,
        &key,
        ContentKind::Scene,
        Regime::Replicated,
        &NoFaults,
        now_ms,
    )
    .expect("ensure replicated scene marker");
    let mut records = BTreeMap::new();
    records.insert(
        "image-file".to_owned(),
        serde_json::json!({
            "created": 4,
            "id": "image-file",
            "mimeType": "image/png",
            "ref": asset_path,
            "sha256": asset_sha256
        })
        .to_string(),
    );
    let scene = import_portable_scene(
        &serde_json::json!({
            "type": "excalidraw",
            "elements": [{
                "id": "image-element",
                "type": "image",
                "version": 1,
                "versionNonce": 1,
                "isDeleted": false,
                "index": "a0",
                "fileId": "image-file"
            }],
            "files": {
                "image-file": {
                    "id": "image-file",
                    "mimeType": "image/png",
                    "created": 4,
                    "dataURL": format!("data:image/png;base64,{ONE_PIXEL_PNG_BASE64}")
                }
            }
        })
        .to_string(),
    )
    .expect("import live image scene");
    let asset_update = encode_scene_asset_records(&records).expect("encode scene asset authority");
    let update = dohc_engine_collab::merge_updates(&[scene.initial_update, asset_update])
        .expect("merge scene authority update");
    assert!(matches!(
        apply_remote_update(
            store,
            &key,
            &RemoteUpdate {
                origin_id: "origin-scene-source".to_owned(),
                origin_seq: 1,
                bytes: update,
            },
            &NoFaults,
            now_ms,
        )
        .expect("apply remote scene asset authority"),
        TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. })
    ));
}

fn apply_remote_scene_image_tombstone(
    store: &mut EngineStore,
    workspace_id: &str,
    drawing_object_id: &str,
    now_ms: i64,
) {
    let key = DocKey::new(workspace_id, "main", drawing_object_id).expect("scene doc key");
    let scene = import_portable_scene(
        &serde_json::json!({
            "type": "excalidraw",
            "elements": [{
                "id": "image-element",
                "type": "image",
                "version": 2,
                "versionNonce": 2,
                "isDeleted": true,
                "index": "a0",
                "fileId": "image-file"
            }]
        })
        .to_string(),
    )
    .expect("import image tombstone");
    assert!(matches!(
        apply_remote_update(
            store,
            &key,
            &RemoteUpdate {
                origin_id: "origin-scene-source".to_owned(),
                origin_seq: 2,
                bytes: scene.initial_update,
            },
            &NoFaults,
            now_ms,
        )
        .expect("apply remote image tombstone"),
        TxnOutcome::Committed(ReplicationApplyOutcome::Applied { .. })
    ));
}

fn local_ops(db: &Path) -> Vec<LoggedOp> {
    let store = EngineStore::open(db, 500).expect("open store");
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT origin_id, origin_seq, op_kind, payload_json, recorded_at_ms \
                 FROM replication_log WHERE imported = 0 ORDER BY origin_seq",
            )?;
            statement
                .query_map([], |row| {
                    let payload_json: String = row.get(3)?;
                    Ok(LoggedOp {
                        origin_id: row.get(0)?,
                        origin_seq: row.get(1)?,
                        op_kind: row.get(2)?,
                        payload: serde_json::from_str(&payload_json).expect("payload JSON"),
                        recorded_at_ms: row.get(4)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("read local ops")
}

fn replication_journal_count(db: &Path) -> i64 {
    EngineStore::open(db, 501)
        .expect("open store")
        .read_with(|conn| {
            conn.query_row("SELECT COUNT(*) FROM replication_journal", [], |row| {
                row.get(0)
            })
        })
        .expect("count diagnostic journal")
}

fn write_input(workspace_id: &str, moment_id: &str, text: &str, now_ms: i64) -> WriteText {
    WriteText {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        object_id: "object-plan".to_owned(),
        path: "notes/plan.md".to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: Some("Updated plan".to_owned()),
        metadata_correlation_id: Some("correlation-plan".to_owned()),
        author_json: None,
        now_ms,
        request_id: None,
    }
}

fn write_path_input(
    workspace_id: &str,
    version_id: &str,
    path: &str,
    object_id: &str,
    moment_id: &str,
    text: &str,
    now_ms: i64,
) -> WriteText {
    WriteText {
        workspace_id: workspace_id.to_owned(),
        version_id: version_id.to_owned(),
        object_id: object_id.to_owned(),
        path: path.to_owned(),
        text: text.to_owned(),
        moment_id: moment_id.to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms,
        request_id: None,
    }
}

fn secret_key() -> SecretDataKey {
    SecretDataKey::from_bytes(&[0x11; 32]).expect("secret key")
}

/// `snapshots` carries a `metadata_origin` column that the replication
/// boundary is allowed to rewrite (see dohc-engine-collab's
/// `captured_head_sha`); comparisons against that table drop the column by
/// name so the assertion still catches a genuine content mismatch.
fn snapshot_origin_column_index(statement: &rusqlite::Statement<'_>, table: &str) -> Option<usize> {
    (table == "snapshots")
        .then(|| {
            statement
                .column_names()
                .into_iter()
                .position(|name| name == "metadata_origin")
        })
        .flatten()
}

fn row_values(row: &rusqlite::Row<'_>, skip: Option<usize>) -> rusqlite::Result<Vec<String>> {
    (0..row.as_ref().column_count())
        .filter(|index| Some(*index) != skip)
        .map(|index| row.get_ref(index).map(|value| format!("{value:?}")))
        .collect()
}

fn workspace_table_rows(
    store: &EngineStore,
    workspace_id: &str,
    table: &str,
    order_by: &str,
) -> Vec<Vec<String>> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(&format!(
                "SELECT * FROM {table} WHERE workspace_id=?1 ORDER BY {order_by}"
            ))?;
            let skip = snapshot_origin_column_index(&statement, table);
            statement
                .query_map([workspace_id], |row| row_values(row, skip))?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("read workspace table")
}

fn version_rows(store: &EngineStore, workspace_id: &str, table: &str) -> Vec<Vec<String>> {
    workspace_table_rows(store, workspace_id, table, "version_id,path,object_id")
}

fn one_version_rows(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
    table: &str,
) -> Vec<Vec<String>> {
    store
        .read_with(|conn| {
            let mut statement = conn.prepare(&format!(
                "SELECT * FROM {table} WHERE workspace_id=?1 AND version_id=?2 ORDER BY path"
            ))?;
            let skip = snapshot_origin_column_index(&statement, table);
            statement
                .query_map(params![workspace_id, version_id], |row| {
                    row_values(row, skip)
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("read version table")
}

fn secret_rows(store: &EngineStore, workspace_id: &str, table: &str) -> Vec<Vec<String>> {
    workspace_table_rows(store, workspace_id, table, "version_id,path")
}

fn secret_file_content_rows(
    store: &EngineStore,
    workspace_id: &str,
    version_id: &str,
) -> Vec<Vec<String>> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT workspace_id,version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length,updated_at_ms \
                 FROM secret_files WHERE workspace_id=?1 AND version_id=?2 ORDER BY path",
            )?
            .query_map(params![workspace_id, version_id], |row| {
                (0..row.as_ref().column_count())
                    .map(|index| row.get_ref(index).map(|value| format!("{value:?}")))
                    .collect::<Result<Vec<_>, _>>()
            })?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("read secret file content rows")
}

fn copy_op_blobs(source: &EngineStore, peer: &mut EngineStore, op: &LoggedOp) {
    let mut shas = if op.op_kind == "moment.append" {
        vec![(
            op.payload["payloadAfterBlobSha256"]
                .as_str()
                .expect("moment blob sha"),
            op.payload["payloadAfterContentKind"].as_str() == Some("binary"),
        )]
    } else if op.op_kind == "version.create" {
        op.payload["forkSnapshots"]
            .as_array()
            .expect("version snapshot rows")
            .iter()
            .map(|row| {
                (
                    row["blobSha256"].as_str().expect("snapshot blob sha"),
                    row["contentKind"].as_str() == Some("binary"),
                )
            })
            .collect()
    } else if op.op_kind == "secret.file.put" {
        vec![(
            op.payload["ciphertextSha256"]
                .as_str()
                .expect("ciphertext sha"),
            true,
        )]
    } else if op.op_kind == "secret.version.fork" {
        op.payload["rows"]
            .as_array()
            .expect("secret fork rows")
            .iter()
            .map(|row| {
                (
                    row["ciphertextSha256"]
                        .as_str()
                        .expect("fork ciphertext sha"),
                    true,
                )
            })
            .collect()
    } else {
        Vec::new()
    };
    if op.op_kind == "conflict.resolve" {
        for side in ["current", "incoming", "result"] {
            let head = &op.payload["transition"][side];
            if head["present"].as_bool() == Some(true) {
                shas.push((
                    head["blobSha256"].as_str().expect("conflict head blob sha"),
                    head["contentKind"].as_str() == Some("binary"),
                ));
            }
        }
        if let Some(successor) = op.payload["lineageTransition"]["successor"].as_object() {
            shas.push((
                successor["updateBlobSha256"]
                    .as_str()
                    .expect("successor update sha"),
                true,
            ));
            shas.push((
                successor["stateVectorBlobSha256"]
                    .as_str()
                    .expect("successor state-vector sha"),
                true,
            ));
        }
    }
    shas.sort_unstable();
    shas.dedup();
    for (sha, binary) in shas {
        if binary {
            let bytes = source
                .get_binary_blob(sha)
                .expect("read source binary blob")
                .expect("source binary blob exists");
            peer.put_binary_blob(&bytes).expect("copy binary blob");
            continue;
        }
        let text = source
            .read_with(|conn| {
                conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [sha], |row| {
                    row.get::<_, String>(0)
                })
            })
            .expect("read source text blob");
        peer.write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![sha, text.len() as i64, text],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("copy text blob");
    }
}

fn apply_logged_op(peer: &mut EngineStore, workspace_id: &str, op: &LoggedOp) {
    let envelope = op.envelope(workspace_id);
    match op.op_kind.as_str() {
        "moment.append" => {
            let outcome = apply_moment_envelope_detailed(
                peer,
                &envelope,
                &NoFaults,
                &dohc_engine_sync::NoLiveLeases,
            )
            .unwrap_or_else(|error| panic!("apply moment envelope {error:?}: {:?}", op.payload));
            let ApplyOutcome::Applied(result) = outcome else {
                panic!("originated moment outcome {outcome:?}: {:?}", op.payload);
            };
            assert_eq!(result.conflicts_opened, 0, "{:?}", op.payload);
        }
        "conflict.resolve" => {
            assert!(matches!(
                apply_replication_envelope(
                    peer,
                    &envelope,
                    &NoFaults,
                    &dohc_engine_sync::NoLiveLeases,
                )
                .expect("apply conflict.resolve envelope"),
                ApplyOutcome::Applied(_)
            ));
        }
        "version.create" => {
            assert!(matches!(
                apply_version_envelope(peer, &envelope, &NoFaults).expect("apply version envelope"),
                ApplyOutcome::Applied(())
            ));
        }
        kind if kind.starts_with("secret.") => {
            assert!(matches!(
                apply_secret_envelope(peer, &envelope, &NoFaults).expect("apply secret envelope"),
                ApplyOutcome::Applied(())
            ));
        }
        other => panic!("unexpected op kind {other}"),
    }
}

fn capped_identifier(prefix: &str, byte: char) -> String {
    format!("{prefix}{}", byte.to_string().repeat(512 - prefix.len()))
}

fn large_metadata_write(
    workspace_id: &str,
    index: usize,
    metadata: &str,
    now_ms: i64,
) -> WriteText {
    WriteText {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        object_id: capped_identifier(&format!("object-{index}-"), 'o'),
        path: format!("notes/chunk-{index}.md"),
        text: format!("content {index}\n"),
        moment_id: capped_identifier(&format!("moment-{index}-"), 'm'),
        metadata_origin: "api".to_owned(),
        metadata_summary: Some(metadata.to_owned()),
        metadata_correlation_id: Some(metadata.to_owned()),
        author_json: None,
        now_ms,
        request_id: None,
    }
}

#[tokio::test]
async fn named_fork_splits_an_oversized_snapshot_payload_into_bounded_ops() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-named-fork-chunks";
    initialize_workspace(&source_db, workspace_id, true);
    let metadata = "\0".repeat(16 * 1024);
    let text = "chunked fork\n";
    let blob_sha = hex_sha256(text.as_bytes());
    let mut measured_rows = Vec::new();
    EngineStore::open(&source_db, 2)
        .expect("open source store")
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                params![blob_sha, text.len() as i64, text],
            )
            .map_err(StorageError::persist_public)?;
            for index in 0..2 {
                let object_id = capped_identifier(&format!("object-{index}-"), 'o');
                let path = format!("notes/chunk-{index}.md");
                let moment_id = capped_identifier(&format!("moment-{index}-"), 'm');
                tx.execute(
                    "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) VALUES (?1,?2,?3)",
                    params![workspace_id, object_id, 10 + index as i64],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id) VALUES (?1,'main',?2,?3)",
                    params![workspace_id, path, object_id],
                )
                .map_err(StorageError::persist_public)?;
                tx.execute(
                    "INSERT INTO snapshots \
                     (workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,latest_moment_id,metadata_origin,metadata_summary,metadata_correlation_id,content_kind,binary_sha256) \
                     VALUES (?1,'main',?2,?3,?4,?5,?6,'api',?7,?7,'text',NULL)",
                    params![workspace_id, object_id, path, blob_sha, 20 + index as i64, moment_id, metadata],
                )
                .map_err(StorageError::persist_public)?;
                measured_rows.push(serde_json::json!({
                    "objectId": object_id,
                    "objectCreatedAtMs": 10 + index as i64,
                    "path": path,
                    "contentKind": "text",
                    "blobSha256": blob_sha,
                    "updatedAtMs": 20 + index as i64,
                    "latestMomentId": moment_id,
                    "metadata": {
                        "origin": "api",
                        "summary": metadata,
                        "correlationId": metadata,
                    },
                }));
            }
            Ok::<_, StorageError>(())
        })
        .expect("seed source snapshots");
    let single_payload_size = serde_json::to_vec(&serde_json::json!({
        "versionId": "version-chunked",
        "name": "Chunked",
        "kind": "named",
        "forkVersionId": "main",
        "forkMomentId": null,
        "createdAtMs": 100,
        "forkSnapshots": measured_rows,
    }))
    .expect("measure single payload")
    .len();
    assert!(single_payload_size > MAX_PAYLOAD_JSON_BYTES);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 3).expect("open actor").actor;
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "version-chunked".to_owned(),
                name: "Chunked".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 100,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("chunked named fork commits");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    let version_ops = ops
        .iter()
        .filter(|op| op.op_kind == "version.create")
        .collect::<Vec<_>>();
    assert!(version_ops.len() > 1);
    assert!(version_ops.iter().all(|op| {
        assert!(op.payload.get("chunkIndex").is_none());
        assert!(op.payload.get("totalRows").is_none());
        serde_json::to_vec(&op.payload)
            .expect("serialize drained payload")
            .len()
            <= MAX_PAYLOAD_JSON_BYTES
    }));

    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 4).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 5).expect("open peer store");
    for op in version_ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    for table in ["snapshots", "fork_base_snapshots"] {
        assert_eq!(
            one_version_rows(&peer_store, workspace_id, "version-chunked", table),
            one_version_rows(&source_store, workspace_id, "version-chunked", table),
            "{table} differs"
        );
    }
}

#[tokio::test]
async fn moment_append_sheds_oversized_before_metadata_without_truncating_the_write() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-moment-before-metadata";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    let metadata = "\0".repeat(16 * 1024);

    for (moment_id, text, now_ms) in [
        ("moment-metadata-before", "before\n", 10),
        ("moment-metadata-after", "after\n", 20),
    ] {
        actor
            .versioned_text_write_indexed(
                WriteText {
                    object_id: "object-metadata".to_owned(),
                    path: "notes/metadata.md".to_owned(),
                    metadata_summary: Some(metadata.clone()),
                    metadata_correlation_id: Some(metadata.clone()),
                    ..write_input(workspace_id, moment_id, text, now_ms)
                },
                source.path().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("write moment with worst-case metadata");
    }
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    let op = ops
        .iter()
        .find(|op| op.payload["momentId"] == "moment-metadata-after")
        .expect("second moment op");
    assert!(
        serde_json::to_vec(&op.payload)
            .expect("encode payload")
            .len()
            <= MAX_PAYLOAD_JSON_BYTES
    );
    assert_eq!(op.payload["beforeMetadata"], serde_json::Value::Null);
    assert_eq!(op.payload["metadata"]["summary"], metadata);
    assert_eq!(op.payload["metadata"]["correlationId"], metadata);

    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 3).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 4).expect("open peer store");
    let before_op = ops
        .iter()
        .find(|op| op.payload["momentId"] == "moment-metadata-before")
        .expect("first moment op");
    copy_op_blobs(&source_store, &mut peer_store, before_op);
    copy_op_blobs(&source_store, &mut peer_store, op);
    peer_store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO replication_peers (workspace_id,origin_id,acked_seq) VALUES (?1,?2,?3)",
                params![workspace_id, op.origin_id, op.origin_seq - 1],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("prime peer sequence");
    apply_moment_envelope_detailed(
        &mut peer_store,
        &op.envelope(workspace_id),
        &NoFaults,
        &dohc_engine_sync::NoLiveLeases,
    )
    .expect("apply trimmed moment envelope");
}

#[tokio::test]
async fn secret_fork_splits_an_oversized_row_payload_into_bounded_ops() {
    const SECRET_ROWS: usize = 400;
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-secret-fork-chunks";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    for index in 0..SECRET_ROWS {
        actor
            .write_secret_file(
                SecretWrite {
                    workspace_id: workspace_id.to_owned(),
                    version_id: "main".to_owned(),
                    path: format!("secrets/{index:04}-{}.env", "p".repeat(460)),
                    text: format!("TOKEN={index}"),
                    moment_id: capped_identifier(&format!("secret-{index}-"), 'm'),
                    metadata_origin: "api".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 10 + index as i64,
                    disk_intent: SecretDiskIntent::AlreadyOnDisk,
                },
                secret_key(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("write source secret");
    }
    let measured_rows = local_ops(&source_db)
        .into_iter()
        .filter(|op| op.op_kind == "secret.file.put")
        .enumerate()
        .map(|(index, op)| {
            serde_json::json!({
                "path": op.payload["path"],
                "ivBase64": op.payload["ivBase64"],
                "authTagBase64": op.payload["authTagBase64"],
                "ciphertextSha256": op.payload["ciphertextSha256"],
                "byteLength": op.payload["byteLength"],
                "updatedAtMs": 10 + index as i64,
            })
        })
        .collect::<Vec<_>>();
    let single_payload_size = serde_json::to_vec(&serde_json::json!({
        "toVersionId": "version-secret-chunked",
        "fromVersionId": "main",
        "rows": measured_rows,
    }))
    .expect("measure single secret payload")
    .len();
    assert!(single_payload_size > MAX_PAYLOAD_JSON_BYTES);

    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "version-secret-chunked".to_owned(),
                name: "Secret chunks".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 1_000,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("chunked secret fork commits");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    let fork_ops = ops
        .iter()
        .filter(|op| op.op_kind == "secret.version.fork")
        .collect::<Vec<_>>();
    assert!(fork_ops.len() > 1);
    assert!(fork_ops.iter().enumerate().all(|(chunk_index, op)| {
        assert_eq!(op.payload["chunkIndex"], chunk_index);
        assert_eq!(op.payload["totalRows"], SECRET_ROWS);
        serde_json::to_vec(&op.payload)
            .expect("serialize drained payload")
            .len()
            <= MAX_PAYLOAD_JSON_BYTES
    }));

    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 4).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 5).expect("open peer store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    assert!(
        secret_file_content_rows(&peer_store, workspace_id, "version-secret-chunked")
            == secret_file_content_rows(&source_store, workspace_id, "version-secret-chunked"),
        "secret_files content differs"
    );
    assert!(
        one_version_rows(
            &peer_store,
            workspace_id,
            "version-secret-chunked",
            "secret_fork_bases",
        ) == one_version_rows(
            &source_store,
            workspace_id,
            "version-secret-chunked",
            "secret_fork_bases",
        ),
        "secret_fork_bases differ"
    );
    let latest_moment_ids = peer_store
        .read_with(|conn| {
            conn.prepare(
                "SELECT latest_moment_id FROM secret_files \
                 WHERE workspace_id=?1 AND version_id='version-secret-chunked'",
            )?
            .query_map([workspace_id], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()
        })
        .expect("read synthesized secret moments");
    assert_eq!(
        latest_moment_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        latest_moment_ids.len()
    );
}

#[tokio::test]
async fn lagging_peer_applies_prior_ops_then_a_chunked_fork_in_sequence() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-lagging-peer-chunked-fork";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    let metadata = "\0".repeat(16 * 1024);
    for index in 0..3 {
        actor
            .versioned_text_write_indexed(
                large_metadata_write(workspace_id, index, &metadata, 10 + index as i64),
                source.path().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("write prior moment");
    }
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "version-lagging".to_owned(),
                name: "Lagging".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 100,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("chunked lagging-peer fork commits");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert!(ops.iter().take(3).all(|op| op.op_kind == "moment.append"));
    assert!(
        ops.iter()
            .filter(|op| op.op_kind == "version.create")
            .count()
            > 1
    );
    assert_eq!(
        ops.iter().map(|op| op.origin_seq).collect::<Vec<_>>(),
        (0..ops.len() as i64).collect::<Vec<_>>()
    );

    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 4).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 5).expect("open peer store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    for table in ["versions", "fork_base_snapshots", "snapshots"] {
        let order = if table == "versions" {
            "version_id"
        } else {
            "version_id,path,object_id"
        };
        assert_eq!(
            workspace_table_rows(&peer_store, workspace_id, table, order),
            workspace_table_rows(&source_store, workspace_id, table, order),
            "{table} differs"
        );
    }
}

async fn drive_every_mutation_kind(actor: &ActorHandle, workspace_id: &str, root_dir: &Path) {
    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-write-one", "first\n", 10),
            root_dir.to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write first moment");
    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-write-two", "second\n", 20),
            root_dir.to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write second moment");
    actor
        .versioned_text_rename(
            RenameTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                from_path: "notes/plan.md".to_owned(),
                to_path: "notes/renamed.md".to_owned(),
                moment_id: "moment-rename".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
            },
            root_dir.to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rename text moment");
    actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: "notes/renamed.md".to_owned(),
                moment_id: "moment-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 40,
            },
            root_dir.to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete text moment");
    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "object-binary".to_owned(),
                path: "assets/data.bin".to_owned(),
                bytes: vec![0, 1, 2, 0xff],
                moment_id: "moment-binary".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 50,
                request_id: None,
            },
            root_dir.to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write binary moment");
    actor
        .capture_ingest(
            CaptureIngest {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: "notes/captured.md".to_owned(),
                text: "captured\n".to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 60,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture text moment");
    actor
        .capture_ingest_binary(
            CaptureIngestBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: "assets/captured.bin".to_owned(),
                bytes: vec![9, 8, 7],
                metadata_origin: "local-file".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 70,
                request_id: None,
                claim_foreign_head: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture binary moment");
    actor
        .capture_retire(
            CaptureRetire {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: "notes/captured.md".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 80,
                request_id: None,
                only_if_text_head: false,
                only_if_capture_origin: false,
                allow_ydoc_origin: true,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retire captured text moment");
    actor
        .versioned_text_write_indexed(
            write_path_input(
                workspace_id,
                "main",
                "notes/merge-delete.md",
                "object-merge-delete",
                "moment-merge-delete-base",
                "delete through merge\n",
                85,
            ),
            root_dir.to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("seed merge delete path");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=secret".to_owned(),
                moment_id: "secret-moment-put".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: Some("Updated .env".to_owned()),
                metadata_correlation_id: None,
                now_ms: 90,
                disk_intent: SecretDiskIntent::Materialize,
            },
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write secret");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "version-plan".to_owned(),
                name: "Plan".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 100,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create named version");
    actor
        .delete_secret_file(
            SecretDelete {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                moment_id: "secret-moment-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 110,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete secret");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "version-empty".to_owned(),
                name: "Empty secrets".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 120,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create empty-secret version");
    actor
        .versioned_text_write(
            write_path_input(
                workspace_id,
                "version-plan",
                "notes/merged.md",
                "object-merged-source",
                "moment-merge-source-write",
                "merged from source\n",
                130,
            ),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write merge source");
    actor
        .versioned_text_merge(
            MergeTextFileFromVersion {
                workspace_id: workspace_id.to_owned(),
                target_version_id: "main".to_owned(),
                source_version_id: "version-plan".to_owned(),
                path: "notes/merged.md".to_owned(),
                object_id: "object-merged-target".to_owned(),
                moment_id: "moment-merge-write".to_owned(),
                request_id: None,
                conflict_id: "conflict-merge-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 140,
            },
            root_dir.to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("merge source write");
    actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "version-plan".to_owned(),
                path: "notes/merge-delete.md".to_owned(),
                moment_id: "moment-merge-source-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 150,
            },
            root_dir.to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete merge source path");
    actor
        .versioned_text_merge(
            MergeTextFileFromVersion {
                workspace_id: workspace_id.to_owned(),
                target_version_id: "main".to_owned(),
                source_version_id: "version-plan".to_owned(),
                path: "notes/merge-delete.md".to_owned(),
                object_id: "object-merge-delete-target".to_owned(),
                moment_id: "moment-merge-delete".to_owned(),
                request_id: None,
                conflict_id: "conflict-merge-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 160,
            },
            root_dir.to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("merge source delete");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: workspace_id.to_owned(),
                version_id: "version-plan".to_owned(),
                path: ".apply-put.env".to_owned(),
                text: "APPLY=sealed".to_owned(),
                moment_id: "secret-apply-source-put".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 165,
                disk_intent: SecretDiskIntent::Materialize,
            },
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write apply put source");
    actor
        .apply_secret_file(
            workspace_id.to_owned(),
            ".apply-put.env".to_owned(),
            "version-plan".to_owned(),
            "main".to_owned(),
            "secret-apply-put".to_owned(),
            "api".to_owned(),
            None,
            None,
            170,
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("apply secret put");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=target".to_owned(),
                moment_id: "secret-apply-delete-target".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 175,
                disk_intent: SecretDiskIntent::Materialize,
            },
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write apply delete target");
    actor
        .delete_secret_file(
            SecretDelete {
                workspace_id: workspace_id.to_owned(),
                version_id: "version-plan".to_owned(),
                path: ".env".to_owned(),
                moment_id: "secret-apply-delete-source".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 177,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete apply source");
    actor
        .apply_secret_file(
            workspace_id.to_owned(),
            ".env".to_owned(),
            "version-plan".to_owned(),
            "main".to_owned(),
            "secret-apply-delete".to_owned(),
            "api".to_owned(),
            None,
            None,
            180,
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("apply secret delete");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".restore.env".to_owned(),
                text: "RESTORE=sealed".to_owned(),
                moment_id: "secret-restore-source".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 190,
                disk_intent: SecretDiskIntent::Materialize,
            },
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write restore source");
    actor
        .delete_secret_file(
            SecretDelete {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".restore.env".to_owned(),
                moment_id: "secret-restore-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 200,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete restore source");
    actor
        .restore_secret_file(
            workspace_id.to_owned(),
            ".restore.env".to_owned(),
            "secret-restore-delete".to_owned(),
            "secret-restore-put".to_owned(),
            "restore".to_owned(),
            None,
            None,
            210,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("restore secret put");
    actor
        .capture_secret(
            CaptureSecret {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".capture.env".to_owned(),
                text: "CAPTURE=sealed".to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_correlation_id: None,
                now_ms: 220,
                claim_foreign_head: true,
            },
            secret_key(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture secret put");
    actor
        .capture_secret_retire(
            CaptureSecretRetire {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".capture.env".to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_correlation_id: None,
                now_ms: 230,
                only_if_own_origin: true,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("capture secret retire");
    actor
        .fork_secret_version(
            workspace_id.to_owned(),
            "version-plan".to_owned(),
            "version-empty".to_owned(),
            240,
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("standalone secret fork");
}

#[tokio::test]
async fn conflict_resolution_moment_replays_to_the_resolved_text_on_a_clean_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-resolve-outbound";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-current", "current\n", 10),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write current text");
    let current =
        VersionedTextStore::new(&mut EngineStore::open(&source_db, 3).expect("open read"))
            .read_text(workspace_id, "main", "notes/plan.md")
            .expect("read current")
            .expect("current exists");
    let incoming_text = "incoming\n";
    let incoming = TextSnapshot {
        workspace_id: workspace_id.to_owned(),
        version_id: "source-version".to_owned(),
        object_id: "incoming-object".to_owned(),
        path: "notes/plan.md".to_owned(),
        text: incoming_text.to_owned(),
        blob_sha256: hex_sha256(incoming_text.as_bytes()),
        updated_at_ms: 20,
        latest_moment_id: "incoming-moment".to_owned(),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
    };
    actor
        .conflict_open(
            Box::new(TextConflict {
                conflict_id: "conflict-resolve-outbound".to_owned(),
                workspace_id: workspace_id.to_owned(),
                path: "notes/plan.md".to_owned(),
                target_version_id: "main".to_owned(),
                source_version_id: "source-version".to_owned(),
                created_at_ms: 20,
                updated_at_ms: 20,
                status: ConflictStatus::Open,
                chosen_from: ConflictChoice::Current,
                resolution: None,
                metadata: ConflictMetadata::origin("api"),
                base: ConflictFileState::text("notes/plan.md", None),
                current: ConflictFileState::text("notes/plan.md", Some(current)),
                incoming: ConflictFileState::text("notes/plan.md", Some(incoming)),
            }),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("open conflict");
    actor
        .conflict_resolve_indexed(
            ResolveTextConflict {
                workspace_id: workspace_id.to_owned(),
                conflict_id: "conflict-resolve-outbound".to_owned(),
                resolution: ResolveConflictKind::ApplyIncoming,
                object_id: "resolved-object".to_owned(),
                write_moment_id: "moment-resolved".to_owned(),
                delete_moment_id: "moment-resolved-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("resolve conflict");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        ["moment.append", "conflict.resolve", "moment.append"]
    );
    assert_eq!(ops[1].payload["effects"][0]["momentId"], "moment-resolved");
    assert_eq!(ops[2].payload["conflictId"], "conflict-resolve-outbound");
    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 4).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 5).expect("open peer store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    let peer_text = VersionedTextStore::new(&mut peer_store)
        .read_text(workspace_id, "main", "notes/plan.md")
        .expect("read peer")
        .expect("peer text exists");
    assert_eq!(peer_text.text, incoming_text);
}

#[tokio::test]
async fn conflict_resolution_delete_replays_to_an_absent_head_on_a_clean_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-resolve-delete-outbound";
    let path = "notes/delete.md";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    actor
        .versioned_text_write_indexed(
            write_path_input(
                workspace_id,
                "main",
                path,
                "object-delete-current",
                "moment-delete-current",
                "delete me\n",
                10,
            ),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write current text");
    let current =
        VersionedTextStore::new(&mut EngineStore::open(&source_db, 3).expect("open current store"))
            .read_text(workspace_id, "main", path)
            .expect("read current")
            .expect("current exists");
    actor
        .conflict_open(
            Box::new(TextConflict {
                conflict_id: "conflict-resolve-delete-outbound".to_owned(),
                workspace_id: workspace_id.to_owned(),
                path: path.to_owned(),
                target_version_id: "main".to_owned(),
                source_version_id: "source-version".to_owned(),
                created_at_ms: 20,
                updated_at_ms: 20,
                status: ConflictStatus::Open,
                chosen_from: ConflictChoice::Current,
                resolution: None,
                metadata: ConflictMetadata::origin("api"),
                base: ConflictFileState::text(path, None),
                current: ConflictFileState::text(path, Some(current)),
                incoming: ConflictFileState::text(path, None),
            }),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("open delete conflict");
    actor
        .conflict_resolve_indexed(
            ResolveTextConflict {
                workspace_id: workspace_id.to_owned(),
                conflict_id: "conflict-resolve-delete-outbound".to_owned(),
                resolution: ResolveConflictKind::ApplyIncoming,
                object_id: "resolved-delete-object".to_owned(),
                write_moment_id: "moment-resolved-delete-write".to_owned(),
                delete_moment_id: "moment-resolved-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("resolve delete conflict");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        ["moment.append", "conflict.resolve", "moment.append"]
    );
    assert_eq!(
        ops[1].payload["effects"][0]["momentId"],
        "moment-resolved-delete"
    );
    assert_eq!(ops[2].payload["momentId"], "moment-resolved-delete");
    assert_eq!(ops[2].payload["operation"], "delete");
    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 4).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 5).expect("open peer store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    assert!(
        VersionedTextStore::new(&mut peer_store)
            .read_text(workspace_id, "main", path)
            .expect("read peer")
            .is_none()
    );
}

#[tokio::test]
async fn conflict_resolution_binary_write_replays_to_the_incoming_bytes_on_a_clean_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-resolve-binary-outbound";
    let path = "assets/logo.bin";
    let incoming_bytes = b"\x89BIN\x00incoming";
    initialize_workspace(&source_db, workspace_id, true);
    let incoming_sha = EngineStore::open(&source_db, 2)
        .expect("open blob store")
        .put_binary_blob(incoming_bytes)
        .expect("store incoming blob");
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 3).expect("open actor").actor;
    actor
        .versioned_text_write_indexed(
            write_path_input(
                workspace_id,
                "main",
                path,
                "object-binary-current",
                "moment-binary-current",
                "replace me\n",
                10,
            ),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write current text");
    let current =
        VersionedTextStore::new(&mut EngineStore::open(&source_db, 4).expect("open current store"))
            .read_text(workspace_id, "main", path)
            .expect("read current")
            .expect("current exists");
    actor
        .conflict_open(
            Box::new(TextConflict {
                conflict_id: "conflict-resolve-binary-outbound".to_owned(),
                workspace_id: workspace_id.to_owned(),
                path: path.to_owned(),
                target_version_id: "main".to_owned(),
                source_version_id: "source-version".to_owned(),
                created_at_ms: 20,
                updated_at_ms: 20,
                status: ConflictStatus::Open,
                chosen_from: ConflictChoice::Current,
                resolution: None,
                metadata: ConflictMetadata::origin("api"),
                base: ConflictFileState::text(path, None),
                current: ConflictFileState::text(path, Some(current)),
                incoming: ConflictFileState::binary_head(
                    path,
                    incoming_sha.clone(),
                    incoming_bytes.len() as i64,
                    "incoming-binary-object",
                    "incoming-binary-moment",
                    20,
                ),
            }),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("open binary conflict");
    actor
        .conflict_resolve_indexed(
            ResolveTextConflict {
                workspace_id: workspace_id.to_owned(),
                conflict_id: "conflict-resolve-binary-outbound".to_owned(),
                resolution: ResolveConflictKind::ApplyIncoming,
                object_id: "resolved-binary-object".to_owned(),
                write_moment_id: "moment-resolved-binary".to_owned(),
                delete_moment_id: "moment-resolved-binary-delete".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 30,
                request_id: None,
                conflict_answer_budget_bytes: usize::MAX,
            },
            dohc_engine_collab::LeaseRegistry::new(),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("resolve binary conflict");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        ["moment.append", "conflict.resolve", "moment.append"]
    );
    assert_eq!(
        ops[1].payload["effects"][0]["momentId"],
        "moment-resolved-binary"
    );
    assert_eq!(ops[2].payload["momentId"], "moment-resolved-binary");
    assert_eq!(ops[2].payload["payloadAfterContentKind"], "binary");
    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 5).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 6).expect("open peer store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    let peer_binary = VersionedTextStore::new(&mut peer_store)
        .read_binary(workspace_id, "main", path)
        .expect("read peer")
        .expect("peer binary exists");
    assert_eq!(peer_binary.sha256, incoming_sha);
    assert_eq!(peer_binary.bytes, incoming_bytes);
}

#[tokio::test]
async fn rollback_compensation_replays_to_the_restored_text_on_a_clean_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-rollback-outbound";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    for (moment_id, text, now_ms) in [
        ("moment-before-rollback", "before rollback\n", 10),
        ("moment-rolled-back", "rolled back\n", 20),
    ] {
        actor
            .versioned_text_write_indexed(
                write_input(workspace_id, moment_id, text, now_ms),
                source.path().to_path_buf(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .expect("write rollback fixture");
    }
    let rollback = RollbackTextFileMutation {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        path: "notes/plan.md".to_owned(),
        mutation_moment_id: "moment-rolled-back".to_owned(),
        request_id: Some("rollback-outbound-stable".to_owned()),
        legacy_before_text: None,
        metadata_origin: "api".to_owned(),
        author_json: None,
    };
    let first = actor
        .versioned_text_rollback(
            rollback.clone(),
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rollback latest write");
    assert!(!first.deduped);
    let replay = actor
        .versioned_text_rollback(
            rollback,
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("replay rollback");
    assert!(replay.deduped);
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        ["moment.append", "moment.append", "moment.append"]
    );
    assert_eq!(
        ops.iter()
            .filter(|op| {
                op.op_kind == "moment.append"
                    && op.payload["momentId"]
                        .as_str()
                        .is_some_and(|moment_id| moment_id.starts_with("rollback-"))
            })
            .count(),
        1
    );
    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    let source_store = EngineStore::open(&source_db, 3).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 4).expect("open peer store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    let peer_text = VersionedTextStore::new(&mut peer_store)
        .read_text(workspace_id, "main", "notes/plan.md")
        .expect("read peer")
        .expect("peer text exists");
    assert_eq!(peer_text.text, "before rollback\n");
}

#[tokio::test]
async fn relay_enabled_mutations_emit_payloads_that_apply_to_a_clean_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-outbound-enabled";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    drive_every_mutation_kind(&actor, workspace_id, source.path()).await;
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(
        ops.iter().map(|op| op.op_kind.as_str()).collect::<Vec<_>>(),
        [
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "secret.file.put",
            "version.create",
            "secret.version.fork",
            "secret.file.delete",
            "version.create",
            "secret.version.fork",
            "moment.append",
            "moment.append",
            "moment.append",
            "moment.append",
            "secret.file.put",
            "secret.file.put",
            "secret.file.put",
            "secret.file.delete",
            "secret.file.delete",
            "secret.file.put",
            "secret.file.delete",
            "secret.file.put",
            "secret.file.put",
            "secret.file.delete",
            "secret.version.fork",
        ]
    );
    assert!(ops.iter().all(|op| op.origin_id == "origin-local"));
    assert_eq!(
        ops.iter().map(|op| op.origin_seq).collect::<Vec<_>>(),
        (0..30).collect::<Vec<_>>()
    );

    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    let mut peer_store = EngineStore::open(&peer_db, 100).expect("open peer store");
    VersionedTextStore::new(&mut peer_store)
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("peer main version");

    let source_store = EngineStore::open(&source_db, 101).expect("open source store");
    for op in &ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }

    assert_eq!(
        version_rows(&peer_store, workspace_id, "fork_base_snapshots"),
        version_rows(&source_store, workspace_id, "fork_base_snapshots"),
        "fork_base_snapshots differ",
    );
    assert_eq!(
        secret_rows(&peer_store, workspace_id, "secret_fork_bases"),
        secret_rows(&source_store, workspace_id, "secret_fork_bases"),
        "secret_fork_bases differ",
    );

    let snapshot_heads = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT version_id,path,content_kind,COALESCE(binary_sha256,blob_sha256) \
                     FROM snapshots WHERE workspace_id=?1 ORDER BY version_id,path",
                )?
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .expect("snapshot heads")
    };
    let secret_heads = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT version_id,path,iv_base64,auth_tag_base64,ciphertext_base64,byte_length \
                     FROM secret_files WHERE workspace_id=?1 ORDER BY version_id,path",
                )?
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .expect("secret heads")
    };
    let versions = |store: &EngineStore| {
        store
            .read_with(|conn| {
                conn.prepare(
                    "SELECT version_id,kind,name FROM versions WHERE workspace_id=?1 ORDER BY version_id",
                )?
                .query_map([workspace_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .expect("versions")
    };

    let origin_snapshots = snapshot_heads(&source_store);
    let peer_snapshots = snapshot_heads(&peer_store);
    assert_eq!(peer_snapshots, origin_snapshots);
    assert!(peer_snapshots.iter().any(|(version, path, kind, _)| {
        version == "main" && path == "notes/merged.md" && kind == "text"
    }));
    assert!(!peer_snapshots.iter().any(|(version, path, _, _)| {
        version == "main"
            && matches!(
                path.as_str(),
                "notes/plan.md"
                    | "notes/renamed.md"
                    | "notes/captured.md"
                    | "notes/merge-delete.md"
            )
    }));

    let origin_secrets = secret_heads(&source_store);
    let peer_secrets = secret_heads(&peer_store);
    assert_eq!(peer_secrets, origin_secrets);
    let secret_paths = peer_secrets
        .iter()
        .map(|(version, path, ..)| (version.as_str(), path.as_str()))
        .collect::<Vec<_>>();
    assert!(secret_paths.contains(&("main", ".apply-put.env")));
    assert!(secret_paths.contains(&("main", ".restore.env")));
    assert!(!secret_paths.contains(&("main", ".env")));
    assert!(!secret_paths.contains(&("main", ".capture.env")));
    assert!(secret_paths.contains(&("version-empty", ".apply-put.env")));
    assert!(!secret_paths.contains(&("version-plan", ".env")));

    assert_eq!(versions(&peer_store), versions(&source_store));
    let expected_ciphertext_paths = [
        ("main", ".apply-put.env"),
        ("main", ".restore.env"),
        ("main", ".capture.env"),
    ];
    for (version_id, path) in expected_ciphertext_paths {
        let payload = ops
            .iter()
            .find(|op| {
                op.op_kind == "secret.file.put"
                    && op.payload["versionId"].as_str() == Some(version_id)
                    && op.payload["path"].as_str() == Some(path)
            })
            .expect("secret put envelope");
        let ciphertext_sha = payload.payload["ciphertextSha256"]
            .as_str()
            .expect("ciphertextSha256");
        assert_eq!(ciphertext_sha.len(), 64);
        assert!(
            peer_store
                .get_binary_blob(ciphertext_sha)
                .expect("peer ciphertext blob")
                .is_some()
        );
    }
}

#[tokio::test]
async fn scene_rollback_waits_for_asset_delete_then_converges_on_a_third_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-scene-delete-replicates";
    let drawing_text = portable_image_scene();
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;
    let drawing = actor
        .versioned_text_write(
            WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "drawing-object".to_owned(),
                path: "drawings/board.excalidraw".to_owned(),
                text: drawing_text.clone(),
                moment_id: "drawing-write".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write drawing");
    supervisor.close(&source_db).expect("close before marker");
    let key = DocKey::new(workspace_id, "main", &drawing.object.object_id).expect("doc key");
    let mut source_store = EngineStore::open(&source_db, 3).expect("open source store");
    ensure_marker(
        &mut source_store,
        &key,
        ContentKind::Scene,
        Regime::LocalOnly,
        &NoFaults,
        3,
    )
    .expect("ensure scene marker");
    drop(source_store);

    let actor = supervisor.open(&source_db, 4).expect("reopen actor").actor;
    let bytes = ONE_PIXEL_PNG.to_vec();
    let sha256 = hex_sha256(&bytes);
    let asset_path = scene_asset_ref(
        workspace_id,
        "main",
        &drawing.object.object_id,
        &sha256,
        "image/png",
    )
    .expect("asset ref");
    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "drawing-asset-object".to_owned(),
                path: asset_path.clone(),
                bytes: bytes.clone(),
                moment_id: "drawing-asset-write".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Imported drawing asset".to_owned()),
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write asset");
    actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: "drawings/board.excalidraw".to_owned(),
                moment_id: "drawing-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
            },
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete drawing");
    supervisor.close(&source_db).expect("close source actor");

    let ops = local_ops(&source_db);
    assert_eq!(ops.len(), 4);
    assert_eq!(
        ops[2].payload["path"], "drawings/board.excalidraw",
        "the drawing delete must reach a peer before its asset delete"
    );
    assert_eq!(
        ops[3].payload["path"], asset_path,
        "the asset delete must follow the authority-bearing drawing delete"
    );
    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    EngineStore::open(&peer_db, 6)
        .expect("open peer identity store")
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_identity SET origin_id = 'origin-peer', \
                 replication_epoch = 'epoch-peer', stream_identity = 'stream-peer' \
                 WHERE workspace_id = ?1",
                [workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                 VALUES (?1, 'origin-peer', 0)",
                [workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("enable peer relay identity");
    let source_store = EngineStore::open(&source_db, 6).expect("source store");
    let mut peer_store = EngineStore::open(&peer_db, 7).expect("peer store");
    for op in &ops[..2] {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    apply_remote_scene_asset_authority(
        &mut peer_store,
        workspace_id,
        "drawing-object",
        &asset_path,
        &sha256,
        7,
    );
    copy_op_blobs(&source_store, &mut peer_store, &ops[2]);
    apply_logged_op(&mut peer_store, workspace_id, &ops[2]);
    let remaining: i64 = peer_store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM snapshots WHERE workspace_id = ?1",
                [workspace_id],
                |row| row.get(0),
            )
        })
        .expect("count peer snapshots");
    assert_eq!(remaining, 1, "the asset delete has not arrived yet");
    drop(peer_store);

    let peer_store = EngineStore::open(&peer_db, 8).expect("reopen peer lineage");
    let frozen_items: i64 = peer_store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM scene_asset_delete_authority_items \
                 WHERE workspace_id=?1 AND drawing_delete_moment_id='drawing-delete'",
                [workspace_id],
                |row| row.get(0),
            )
        })
        .expect("count frozen delete authority");
    assert_eq!(frozen_items, 1);
    drop(peer_store);

    let peer_supervisor = WorkspaceSupervisor::new();
    let peer_actor = peer_supervisor
        .open(&peer_db, 8)
        .expect("open peer actor")
        .actor;
    let peer_ops_before_rollback = local_ops(&peer_db).len();
    let rollback_input = RollbackTextFileMutation {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        path: "drawings/board.excalidraw".to_owned(),
        mutation_moment_id: "drawing-delete".to_owned(),
        request_id: Some("peer-local-drawing-rollback".to_owned()),
        legacy_before_text: None,
        metadata_origin: "restore".to_owned(),
        author_json: None,
    };
    let pending = peer_actor
        .versioned_text_rollback(
            rollback_input.clone(),
            peer.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect_err("rollback must wait for the replicated asset delete");
    assert!(matches!(pending, RuntimeError::SceneAssetDeletePending));
    assert_eq!(
        local_ops(&peer_db).len(),
        peer_ops_before_rollback,
        "a retryable refusal must not originate compensation"
    );
    peer_supervisor
        .close(&peer_db)
        .expect("close peer after retryable rollback refusal");
    let mut peer_store = EngineStore::open(&peer_db, 9).expect("open peer for asset delete");
    copy_op_blobs(&source_store, &mut peer_store, &ops[3]);
    apply_logged_op(&mut peer_store, workspace_id, &ops[3]);
    drop(peer_store);

    let third = ScratchDir::new().expect("third peer scratch");
    let third_db = third.engine_db_path().expect("third peer db");
    initialize_workspace(&third_db, workspace_id, false);
    let mut third_store = EngineStore::open(&third_db, 9).expect("open third peer");
    for op in &ops[..2] {
        copy_op_blobs(&source_store, &mut third_store, op);
        apply_logged_op(&mut third_store, workspace_id, op);
    }
    apply_remote_scene_asset_authority(
        &mut third_store,
        workspace_id,
        "drawing-object",
        &asset_path,
        &sha256,
        9,
    );
    for op in &ops[2..] {
        copy_op_blobs(&source_store, &mut third_store, op);
        apply_logged_op(&mut third_store, workspace_id, op);
    }
    drop(third_store);

    let peer_supervisor = WorkspaceSupervisor::new();
    let peer_actor = peer_supervisor
        .open(&peer_db, 10)
        .expect("reopen peer after asset delete")
        .actor;
    let rollback = peer_actor
        .versioned_text_rollback(
            rollback_input,
            peer.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retry rollback after the asset delete arrives");
    assert!(rollback.materialized);
    peer_supervisor
        .close(&peer_db)
        .expect("close peer after rollback");

    let peer_restore_ops = local_ops(&peer_db)
        .into_iter()
        .skip(peer_ops_before_rollback)
        .collect::<Vec<_>>();
    assert_eq!(
        peer_restore_ops.len(),
        2,
        "peer rollback must originate the drawing and owned-asset restores"
    );
    assert!(peer_restore_ops.iter().any(|op| {
        op.op_kind == "moment.append"
            && op.payload["path"] == "drawings/board.excalidraw"
            && op.payload["operation"] == "write"
            && op.payload["payloadAfterContentKind"] == "text"
            && op.payload["metadata"]["origin"] == "restore"
    }));
    assert!(peer_restore_ops.iter().any(|op| {
        op.op_kind == "moment.append"
            && op.payload["path"] == asset_path
            && op.payload["operation"] == "write"
            && op.payload["payloadAfterContentKind"] == "binary"
            && op.payload["metadata"]["origin"] == "local-file"
            && op.payload["metadata"]["correlationId"]
                == rollback_compensating_moment_id(workspace_id, "main", "drawing-delete")
    }));

    let peer_store = EngineStore::open(&peer_db, 11).expect("open restored peer for blobs");
    let mut third_store = EngineStore::open(&third_db, 11).expect("reopen third peer");
    for op in &peer_restore_ops {
        copy_op_blobs(&peer_store, &mut third_store, op);
        apply_logged_op(&mut third_store, workspace_id, op);
    }
    let third_conflicts: i64 = third_store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM conflicts WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
        })
        .expect("count third-peer conflicts");
    assert_eq!(third_conflicts, 0);
    let third_drawing = VersionedTextStore::new(&mut third_store)
        .read_text(workspace_id, "main", "drawings/board.excalidraw")
        .expect("read third-peer drawing")
        .expect("third-peer drawing restored");
    assert_eq!(third_drawing.text, drawing_text);
    let third_asset = VersionedTextStore::new(&mut third_store)
        .read_binary(workspace_id, "main", &asset_path)
        .expect("read third-peer asset")
        .expect("third-peer asset restored");
    assert_eq!(third_asset.bytes, bytes);
    drop(third_store);
    drop(peer_store);

    assert_eq!(
        std::fs::read(peer.path().join(&asset_path)).expect("restored peer image bytes"),
        bytes
    );
    let mut peer_store = EngineStore::open(&peer_db, 11).expect("inspect restored peer");
    let retained_authority: i64 = peer_store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM scene_asset_delete_authorities WHERE workspace_id=?1",
                [workspace_id],
                |row| row.get(0),
            )
        })
        .expect("count consumed scene asset authority");
    assert_eq!(retained_authority, 0);
    let restored_drawing = VersionedTextStore::new(&mut peer_store)
        .read_text(workspace_id, "main", "drawings/board.excalidraw")
        .expect("read restored peer drawing")
        .expect("restored peer drawing head");
    assert_eq!(restored_drawing.text, drawing_text);
    let restored_json: serde_json::Value =
        serde_json::from_str(&restored_drawing.text).expect("parse restored portable scene");
    assert_eq!(
        restored_json["elements"][0]["fileId"],
        serde_json::json!("image-file")
    );
    assert_eq!(
        restored_json["files"]["image-file"]["dataURL"],
        serde_json::json!(format!("data:image/png;base64,{ONE_PIXEL_PNG_BASE64}"))
    );
    let restored_asset = VersionedTextStore::new(&mut peer_store)
        .read_binary(workspace_id, "main", &asset_path)
        .expect("read restored peer asset")
        .expect("restored peer asset head");
    assert_eq!(restored_asset.bytes, ONE_PIXEL_PNG);
}

async fn assert_peer_local_scene_delete_retires_a_synced_asset(tombstoned: bool) {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-live-synced-scene-delete";
    let drawing_path = "drawings/live-board.excalidraw";
    let drawing_text = portable_image_scene();
    initialize_workspace(&source_db, workspace_id, true);
    let source_supervisor = WorkspaceSupervisor::new();
    let source_actor = source_supervisor
        .open(&source_db, 2)
        .expect("open source actor")
        .actor;
    let drawing = source_actor
        .versioned_text_write(
            WriteText {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "live-drawing-object".to_owned(),
                path: drawing_path.to_owned(),
                text: drawing_text.clone(),
                moment_id: "live-drawing-write".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write source drawing");
    let asset_bytes = ONE_PIXEL_PNG.to_vec();
    let asset_path = scene_asset_ref(
        workspace_id,
        "main",
        &drawing.object.object_id,
        &hex_sha256(&asset_bytes),
        "image/png",
    )
    .expect("owned asset path");
    source_actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "live-drawing-asset-object".to_owned(),
                path: asset_path.clone(),
                bytes: asset_bytes.clone(),
                moment_id: "live-drawing-asset-write".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Imported drawing asset".to_owned()),
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3,
                request_id: None,
            },
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write source drawing asset");
    let forged_bytes = b"forged provider-neighbor".to_vec();
    let forged_path = scene_asset_ref(
        workspace_id,
        "main",
        &drawing.object.object_id,
        &hex_sha256(&forged_bytes),
        "image/png",
    )
    .expect("forged canonical neighbor path");
    source_actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "forged-provider-neighbor-object".to_owned(),
                path: forged_path.clone(),
                bytes: forged_bytes.clone(),
                moment_id: "forged-provider-neighbor-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write forged provider neighbor");
    let adjacent_path = "assets/user-photo.png";
    let adjacent_bytes = b"adjacent user-owned image".to_vec();
    source_actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "adjacent-user-asset-object".to_owned(),
                path: adjacent_path.to_owned(),
                bytes: adjacent_bytes.clone(),
                moment_id: "adjacent-user-asset-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
                request_id: None,
            },
            source.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write adjacent user asset");
    source_supervisor
        .close(&source_db)
        .expect("close source actor");

    let source_ops = local_ops(&source_db);
    assert_eq!(source_ops.len(), 4);
    assert!(
        source_ops
            .iter()
            .all(|op| op.payload["operation"] == "write")
    );
    let peer = ScratchDir::new().expect("peer scratch");
    let peer_db = peer.engine_db_path().expect("peer db");
    initialize_workspace(&peer_db, workspace_id, false);
    EngineStore::open(&peer_db, 6)
        .expect("open peer identity store")
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE sync_identity SET origin_id = 'origin-live-peer', \
                 replication_epoch = 'epoch-live-peer', \
                 stream_identity = 'stream-live-peer' WHERE workspace_id = ?1",
                [workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO sync_relay_push_state (workspace_id, origin_id, pushed_seq) \
                 VALUES (?1, 'origin-live-peer', 0)",
                [workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("enable peer relay identity");
    let source_store = EngineStore::open(&source_db, 6).expect("open source store");
    let mut peer_store = EngineStore::open(&peer_db, 7).expect("open peer store");
    for op in &source_ops {
        copy_op_blobs(&source_store, &mut peer_store, op);
        apply_logged_op(&mut peer_store, workspace_id, op);
    }
    apply_remote_scene_asset_authority(
        &mut peer_store,
        workspace_id,
        "live-drawing-object",
        &asset_path,
        &hex_sha256(&asset_bytes),
        7,
    );
    if tombstoned {
        apply_remote_scene_image_tombstone(&mut peer_store, workspace_id, "live-drawing-object", 8);
    }
    let replicated_heads: Vec<(String, String)> = peer_store
        .read_with(|conn| {
            let mut statement = conn.prepare(
                "SELECT path,metadata_origin FROM snapshots WHERE workspace_id = ?1 \
                 AND version_id = 'main' ORDER BY path",
            )?;
            statement
                .query_map([workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .expect("read replicated heads");
    assert_eq!(replicated_heads.len(), 4);
    assert!(replicated_heads.iter().all(|(_, origin)| origin == "sync"));
    let provider_origin: String = peer_store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin FROM moments WHERE workspace_id = ?1 AND path = ?2 \
                 AND operation = 'write'",
                params![workspace_id, asset_path],
                |row| row.get(0),
            )
        })
        .expect("read replicated provider origin");
    assert_eq!(provider_origin, "local-file");
    let forged_origin: String = peer_store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin FROM moments WHERE workspace_id = ?1 AND path = ?2 \
                 AND operation = 'write'",
                params![workspace_id, forged_path],
                |row| row.get(0),
            )
        })
        .expect("read forged producer origin");
    assert_eq!(forged_origin, "api");
    drop(peer_store);

    for (path, bytes) in [
        (drawing_path, drawing_text.as_bytes()),
        (asset_path.as_str(), asset_bytes.as_slice()),
        (forged_path.as_str(), forged_bytes.as_slice()),
        (adjacent_path, adjacent_bytes.as_slice()),
    ] {
        let absolute = peer.path().join(path);
        std::fs::create_dir_all(absolute.parent().expect("materialized parent"))
            .expect("create materialized parent");
        std::fs::write(absolute, bytes).expect("materialize replicated head");
    }

    let peer_supervisor = WorkspaceSupervisor::new();
    let peer_actor = peer_supervisor
        .open(&peer_db, 8)
        .expect("open peer actor")
        .actor;
    let before_delete_ops = local_ops(&peer_db).len();
    peer_actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: drawing_path.to_owned(),
                moment_id: "peer-live-drawing-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 9,
            },
            peer.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("delete live replicated drawing on peer");
    assert!(!peer.path().join(&asset_path).exists());
    assert_eq!(
        std::fs::read(peer.path().join(&forged_path)).expect("forged neighbor survives delete"),
        forged_bytes
    );
    assert_eq!(
        std::fs::read(peer.path().join(adjacent_path)).expect("adjacent asset survives delete"),
        adjacent_bytes
    );
    let delete_ops = local_ops(&peer_db)
        .into_iter()
        .skip(before_delete_ops)
        .collect::<Vec<_>>();
    assert_eq!(delete_ops.len(), 2);
    assert!(delete_ops.iter().any(|op| {
        op.payload["path"] == drawing_path
            && op.payload["operation"] == "delete"
            && op.payload["payloadBeforeContentKind"] == "text"
    }));
    assert!(delete_ops.iter().any(|op| {
        op.payload["path"] == asset_path
            && op.payload["operation"] == "delete"
            && op.payload["payloadBeforeContentKind"] == "binary"
            && op.payload["metadata"]["origin"] == "local-file"
            && op.payload["metadata"]["correlationId"] == "peer-live-drawing-delete"
    }));
    let mut deleted_store = EngineStore::open(&peer_db, 9).expect("inspect deleted peer");
    assert!(
        VersionedTextStore::new(&mut deleted_store)
            .read_binary(workspace_id, "main", &asset_path)
            .expect("read deleted owned asset")
            .is_none()
    );
    assert!(
        VersionedTextStore::new(&mut deleted_store)
            .read_binary(workspace_id, "main", &forged_path)
            .expect("read surviving forged neighbor")
            .is_some()
    );
    assert!(
        VersionedTextStore::new(&mut deleted_store)
            .read_binary(workspace_id, "main", adjacent_path)
            .expect("read surviving adjacent asset")
            .is_some()
    );
    drop(deleted_store);

    if tombstoned {
        peer_supervisor.close(&peer_db).expect("close peer actor");
        return;
    }

    let before_rollback_ops = local_ops(&peer_db).len();
    let rollback = peer_actor
        .versioned_text_rollback(
            RollbackTextFileMutation {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: drawing_path.to_owned(),
                mutation_moment_id: "peer-live-drawing-delete".to_owned(),
                request_id: Some("rollback-peer-live-drawing-delete".to_owned()),
                legacy_before_text: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            peer.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("rollback peer-local drawing delete");
    assert!(rollback.materialized);
    peer_supervisor.close(&peer_db).expect("close peer actor");

    let restore_ops = local_ops(&peer_db)
        .into_iter()
        .skip(before_rollback_ops)
        .collect::<Vec<_>>();
    assert_eq!(restore_ops.len(), 2);
    assert!(restore_ops.iter().any(|op| {
        op.payload["path"] == drawing_path
            && op.payload["operation"] == "write"
            && op.payload["payloadAfterContentKind"] == "text"
            && op.payload["metadata"]["origin"] == "restore"
    }));
    assert!(restore_ops.iter().any(|op| {
        op.payload["path"] == asset_path
            && op.payload["operation"] == "write"
            && op.payload["payloadAfterContentKind"] == "binary"
            && op.payload["metadata"]["origin"] == "local-file"
    }));
    assert_eq!(
        std::fs::read(peer.path().join(&asset_path)).expect("restored exact image bytes"),
        asset_bytes
    );
    assert_eq!(
        std::fs::read(peer.path().join(&forged_path)).expect("forged neighbor remains"),
        forged_bytes
    );
    assert_eq!(
        std::fs::read(peer.path().join(adjacent_path)).expect("adjacent asset remains"),
        adjacent_bytes
    );
    let mut peer_store = EngineStore::open(&peer_db, 10).expect("inspect restored peer");
    let restored_drawing = VersionedTextStore::new(&mut peer_store)
        .read_text(workspace_id, "main", drawing_path)
        .expect("read restored drawing")
        .expect("restored drawing head");
    assert_eq!(restored_drawing.text, drawing_text);
    let restored_json: serde_json::Value =
        serde_json::from_str(&restored_drawing.text).expect("parse restored drawing");
    assert_eq!(
        restored_json["files"]["image-file"]["dataURL"],
        serde_json::json!(format!("data:image/png;base64,{ONE_PIXEL_PNG_BASE64}"))
    );
    assert_eq!(
        VersionedTextStore::new(&mut peer_store)
            .read_binary(workspace_id, "main", &asset_path)
            .expect("read restored image")
            .expect("restored image head")
            .bytes,
        ONE_PIXEL_PNG
    );
    assert!(
        VersionedTextStore::new(&mut peer_store)
            .read_binary(workspace_id, "main", &forged_path)
            .expect("read forged neighbor")
            .is_some()
    );
    assert!(
        VersionedTextStore::new(&mut peer_store)
            .read_binary(workspace_id, "main", adjacent_path)
            .expect("read adjacent asset")
            .is_some()
    );
}

#[tokio::test]
async fn peer_local_scene_delete_retires_a_live_synced_asset_and_rollback_restores_it() {
    assert_peer_local_scene_delete_retires_a_synced_asset(false).await;
}

#[tokio::test]
async fn peer_local_scene_delete_retires_a_tombstoned_synced_asset() {
    assert_peer_local_scene_delete_retires_a_synced_asset(true).await;
}

#[tokio::test]
async fn rollback_cancels_a_pending_scene_asset_delete_before_restart_replay() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let workspace_id = "ws-scene-delete-rollback";
    initialize_workspace(&db, workspace_id, false);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 2).expect("open actor").actor;
    let drawing = actor
        .versioned_text_write(
            write_path_input(
                workspace_id,
                "main",
                "drawings/rollback.excalidraw",
                "rollback-drawing-object",
                "rollback-drawing-write",
                r#"{"type":"excalidraw","elements":[],"appState":{},"files":{}}"#,
                2,
            ),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write drawing");
    supervisor.close(&db).expect("close before marker");
    let key = DocKey::new(workspace_id, "main", &drawing.object.object_id).expect("doc key");
    let mut store = EngineStore::open(&db, 3).expect("open marker store");
    ensure_marker(
        &mut store,
        &key,
        ContentKind::Scene,
        Regime::LocalOnly,
        &NoFaults,
        3,
    )
    .expect("scene marker");
    drop(store);
    let actor = supervisor.open(&db, 4).expect("reopen actor").actor;
    let bytes = ONE_PIXEL_PNG.to_vec();
    let asset_path = scene_asset_ref(
        workspace_id,
        "main",
        &drawing.object.object_id,
        &hex_sha256(&bytes),
        "image/png",
    )
    .expect("asset ref");
    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "rollback-asset-object".to_owned(),
                path: asset_path.clone(),
                bytes: bytes.clone(),
                moment_id: "rollback-asset-write".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Imported drawing asset".to_owned()),
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 4,
                request_id: None,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write asset");
    let unrelated_path = "assets/unrelated-lifecycle.bin";
    let unrelated_bytes = b"unrelated binary authority".to_vec();
    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "unrelated-binary-object".to_owned(),
                path: unrelated_path.to_owned(),
                bytes: unrelated_bytes.clone(),
                moment_id: "unrelated-binary-write".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
                request_id: None,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write unrelated binary");
    let aborted = actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: "drawings/rollback.excalidraw".to_owned(),
                moment_id: "aborted-drawing-delete".to_owned(),
                request_id: None,
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 5,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::StorageBeforePersist),
            CancellationToken::new(),
        )
        .await;
    assert!(matches!(aborted, Err(RuntimeError::OperationCrashed)));
    assert!(
        actor
            .versioned_text_read(
                workspace_id.to_owned(),
                "main".to_owned(),
                "drawings/rollback.excalidraw".to_owned(),
                CancellationToken::new(),
            )
            .await
            .expect("read drawing after rollback")
            .is_some()
    );
    assert_eq!(
        std::fs::read(scratch.path().join(&asset_path)).expect("asset survives rollback"),
        bytes
    );
    let drawing_delete_input = DeleteTextFile {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        path: "drawings/rollback.excalidraw".to_owned(),
        moment_id: "rollback-drawing-delete".to_owned(),
        request_id: Some("rollback-drawing-delete-request".to_owned()),
        metadata_origin: "api".to_owned(),
        metadata_summary: None,
        metadata_correlation_id: None,
        author_json: None,
        now_ms: 6,
    };
    let drawing_delete = actor
        .versioned_text_delete(
            drawing_delete_input.clone(),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("delete committed");
    assert_eq!(
        std::fs::read(scratch.path().join(&asset_path)).expect("asset pending"),
        bytes
    );
    actor
        .versioned_text_delete(
            DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: unrelated_path.to_owned(),
                moment_id: "foreign-binary-delete".to_owned(),
                request_id: None,
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Deleted drawing asset".to_owned()),
                metadata_correlation_id: Some(drawing_delete.moment.moment_id.clone()),
                author_json: None,
                now_ms: 7,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("commit foreign correlated binary delete");
    let mut inspection = EngineStore::open(&db, 7).expect("open summary drift store");
    inspection
        .write_with(&NoFaults, |tx| {
            let changed = tx
                .execute(
                    "UPDATE moments SET metadata_summary = 'Drawing asset delete copy changed' \
                 WHERE workspace_id = ?1 AND version_id = 'main' AND path = ?2 \
                   AND metadata_correlation_id = ?3",
                    params![workspace_id, asset_path, drawing_delete.moment.moment_id],
                )
                .map_err(StorageError::persist_public)?;
            assert_eq!(changed, 1, "one owned asset delete changed copy");
            Ok::<_, StorageError>(())
        })
        .expect("change owned delete provenance copy");
    drop(inspection);
    let retried_delete = actor
        .versioned_text_delete(
            drawing_delete_input,
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retry committed drawing delete");
    assert!(retried_delete.deduped);
    assert!(
        !scratch.path().join(&asset_path).exists(),
        "retry must materialize its exact owned delete despite changed copy"
    );
    assert_eq!(
        std::fs::read(scratch.path().join(unrelated_path))
            .expect("foreign correlated delete remains pending"),
        unrelated_bytes
    );
    assert_eq!(
        EngineStore::open(&db, 7)
            .expect("inspect foreign delete job")
            .load_materialization_job(&dohc_engine_domain::binary_delete_job_id(
                "foreign-binary-delete"
            ))
            .expect("load foreign delete job")
            .expect("foreign delete job exists")
            .status,
        dohc_engine_storage::JobStatus::Pending,
        "drawing retry must not run a metadata-shaped foreign delete"
    );
    let rollback = RollbackTextFileMutation {
        workspace_id: workspace_id.to_owned(),
        version_id: "main".to_owned(),
        path: "drawings/rollback.excalidraw".to_owned(),
        mutation_moment_id: drawing_delete.moment.moment_id,
        request_id: Some("rollback-scene-delete".to_owned()),
        legacy_before_text: None,
        metadata_origin: "restore".to_owned(),
        author_json: None,
    };
    let rollback_moment_id = rollback_compensating_moment_id(
        &rollback.workspace_id,
        &rollback.version_id,
        &rollback.mutation_moment_id,
    );
    let committed = actor
        .versioned_text_rollback(
            rollback.clone(),
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("commit drawing delete rollback");
    assert!(!committed.materialized);
    let original_restore_job_id: String = EngineStore::open(&db, 7)
        .expect("inspect original restore job")
        .read_with(|conn| {
            conn.query_row(
                "SELECT j.job_id FROM moments m JOIN materialization_jobs j \
                 ON j.workspace_id = m.workspace_id AND j.job_id = m.moment_id \
                 WHERE m.workspace_id = ?1 AND m.version_id = ?2 \
                 AND m.metadata_correlation_id = ?3 \
                 AND m.metadata_summary = 'Restored drawing asset'",
                params![workspace_id, "main", rollback_moment_id],
                |row| row.get(0),
            )
        })
        .expect("original restore job exists");
    let mut inspection = EngineStore::open(&db, 7).expect("open restore summary drift store");
    inspection
        .write_with(&NoFaults, |tx| {
            let changed = tx
                .execute(
                    "UPDATE moments SET metadata_summary = 'Drawing asset restore copy changed' \
                 WHERE workspace_id = ?1 AND moment_id = ?2",
                    params![workspace_id, original_restore_job_id],
                )
                .map_err(StorageError::persist_public)?;
            assert_eq!(changed, 1, "one owned asset restore changed copy");
            Ok::<_, StorageError>(())
        })
        .expect("change owned restore provenance copy");
    drop(inspection);
    assert_eq!(
        EngineStore::open(&db, 7)
            .expect("inspect pending original restore job")
            .load_materialization_job(&original_restore_job_id)
            .expect("load original restore job")
            .expect("original restore job exists")
            .status,
        dohc_engine_storage::JobStatus::Pending
    );
    let later_rollback_moment_id =
        rollback_compensating_moment_id(workspace_id, "main", "later-drawing-delete");
    actor
        .versioned_text_write(
            write_path_input(
                workspace_id,
                "main",
                "drawings/rollback.excalidraw",
                "ignored-existing-drawing-object",
                &later_rollback_moment_id,
                r#"{"type":"excalidraw","elements":[],"appState":{"theme":"dark"},"files":{}}"#,
                8,
            ),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("advance drawing head after committed rollback");
    let later_path = "assets/later-rollback.png";
    actor
        .versioned_binary_write(
            WriteBinary {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                object_id: "later-rollback-asset-object".to_owned(),
                path: later_path.to_owned(),
                bytes: ONE_PIXEL_PNG.to_vec(),
                moment_id: "moment-scene-asset-rollback-later".to_owned(),
                metadata_origin: "ydoc".to_owned(),
                metadata_summary: Some("Restored drawing asset".to_owned()),
                metadata_correlation_id: Some(rollback_moment_id),
                author_json: None,
                now_ms: 9,
                request_id: None,
            },
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            ScriptedFaults::crash_at(FaultPoint::MaterializeAfterJobCommit),
            CancellationToken::new(),
        )
        .await
        .expect("commit a later rollback-shaped asset job");
    assert!(!scratch.path().join(later_path).exists());
    let retried = actor
        .versioned_text_rollback(
            rollback,
            scratch.path().to_path_buf(),
            Arc::new(NoRecorder),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("retry committed drawing delete rollback");
    assert!(retried.deduped);
    assert!(retried.materialized);
    assert_eq!(
        EngineStore::open(&db, 9)
            .expect("inspect completed original restore job")
            .load_materialization_job(&original_restore_job_id)
            .expect("load original restore job")
            .expect("original restore job exists")
            .status,
        dohc_engine_storage::JobStatus::Complete,
        "retry must finish the restore job owned by the original rollback"
    );
    assert_eq!(
        EngineStore::open(&db, 9)
            .expect("inspect later job")
            .load_materialization_job("moment-scene-asset-rollback-later")
            .expect("load later job")
            .expect("later job exists")
            .status,
        dohc_engine_storage::JobStatus::Pending,
        "retry must not run a different rollback's asset job"
    );
    assert!(!scratch.path().join(later_path).exists());
    let mut inspection = EngineStore::open(&db, 9).expect("inspect unrelated binary head");
    assert!(
        VersionedTextStore::new(&mut inspection)
            .read_binary(workspace_id, "main", unrelated_path)
            .expect("read unrelated binary head after drawing rollback")
            .is_none(),
        "drawing rollback must not resurrect a metadata-shaped foreign delete"
    );
    drop(inspection);
    supervisor.close(&db).expect("close before replay");
    let restarted = WorkspaceSupervisor::new();
    let actor = restarted.open(&db, 10).expect("restart actor").actor;
    actor
        .materialize_replay_pending(scratch.path().to_path_buf(), workspace_id.to_owned(), 10)
        .await
        .expect("replay pending");
    assert_eq!(
        std::fs::read(scratch.path().join(&asset_path)).expect("asset preserved"),
        bytes
    );
    restarted.close(&db).expect("close restarted actor");
    let mut store = EngineStore::open(&db, 11).expect("open restored store");
    let restored = VersionedTextStore::new(&mut store)
        .read_binary(workspace_id, "main", &asset_path)
        .expect("read restored asset")
        .expect("restored asset head");
    assert_eq!(restored.bytes, bytes);
    let provenance_count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM moments WHERE workspace_id = ?1 AND path = ?2 \
                 AND metadata_origin = 'ydoc' AND metadata_correlation_id IS NOT NULL",
                params![workspace_id, asset_path],
                |row| row.get(0),
            )
        })
        .expect("read asset provenance");
    assert_eq!(provenance_count, 2);
}

#[tokio::test]
async fn never_synced_mutations_keep_only_the_diagnostic_journal() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let workspace_id = "ws-outbound-disabled";
    initialize_workspace(&db, workspace_id, false);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 2).expect("open actor").actor;
    drive_every_mutation_kind(&actor, workspace_id, scratch.path()).await;
    supervisor.close(&db).expect("close actor");

    assert!(local_ops(&db).is_empty());
    assert_eq!(replication_journal_count(&db), 30);
}

// #646 PR3-1 — a share view's FILE writes. The share lane is the only one it
// has, so `journal_moment_outbound_in_tx` reads
// `workspace_journals_file_moments_in_tx` and every sibling journal keeps the
// owner-lane answer.

/// A share view that has pulled once: a share cursor, and no owner-lane
/// position of any kind. `enrolled` writes the identity the way
/// `share.view.enroll` does at comment or edit; without it this is a `view`
/// share view.
fn initialize_share_view(db: &Path, workspace_id: &str, enrolled: bool) {
    let mut store = EngineStore::open(db, 1).expect("open store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version(workspace_id, "main", 1, &NoFaults)
        .expect("ensure main version");
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO share_view_cursors (workspace_id,share_id,cursor) \
                 VALUES (?1,'share-1','3')",
                [workspace_id],
            )
            .map_err(StorageError::persist_public)?;
            Ok::<_, StorageError>(())
        })
        .expect("seed share cursor");
    if enrolled {
        match dohc_engine_sync::enroll_share_view_identity(
            &mut store,
            workspace_id,
            "origin-share-view",
            "epoch-share",
            "stream-share",
            1,
            &NoFaults,
        )
        .expect("enrol share view")
        {
            TxnOutcome::Committed(_) => {}
            TxnOutcome::Crashed { .. } => panic!("enrolment crashed"),
        }
    }
}

/// The PR3 proposal lane's precondition: an enrolled share view journals the
/// file it writes, so the share has something to push back.
///
/// It must journal the moment and NOTHING ELSE. Nothing drains a
/// `ydoc.update` from a share view — the share push scope serves only what
/// the share covers — so a `ydoc.update` here would sit in the recipient's
/// database forever. That is why the owner-lane predicate was left alone and
/// a narrower one was added.
#[tokio::test]
async fn an_enrolled_share_view_journals_a_file_write_and_no_ydoc_update() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let workspace_id = "ws-share-view-enrolled";
    initialize_share_view(&db, workspace_id, true);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 2).expect("open actor").actor;
    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-share-view", "recipient edit\n", 10),
            scratch.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("share view file write commits");
    supervisor.close(&db).expect("close actor");

    let ops = local_ops(&db);
    assert!(
        ops.iter().any(|op| op.op_kind == "moment.append"
            && op.origin_id == "origin-share-view"
            && op.payload["momentId"] == "moment-share-view"),
        "MUTATION: an enrolled share view must journal its file writes: {ops:?}",
    );
    // Deliberately NOT asserting the absence of a `ydoc.update` here. This
    // write opens no live session and claims no lineage, so none could be
    // journaled whatever the Y.Doc gate reads — the assertion would pass with
    // the gate widened and prove nothing. The lane boundary is pinned where it
    // can actually fail: `only_the_file_moment_journal_reads_the_share_lane`
    // (both predicates, behaviourally) and
    // `the_ydoc_journal_reads_the_owner_lane_predicate` (the call site), both
    // in `crates/dohc-engine-sync/src/tests.rs`.
    assert!(
        ops.iter().all(|op| op.op_kind != "version.create"),
        "MUTATION: a share view creates no versions, so none may journal: {ops:?}",
    );
}

/// The safety property behind the identity conjunct.
///
/// `journal_local_payload_json_in_tx` REFUSES without a sync identity, and
/// that refusal rolls the user's edit back with it. So a predicate that
/// answered true for a share view WITHOUT an identity would not journal the
/// write — it would destroy it. A `view` share view is exactly that state.
#[tokio::test]
async fn a_view_share_view_journals_nothing_and_its_write_still_commits() {
    let scratch = ScratchDir::new().expect("scratch");
    let db = scratch.engine_db_path().expect("db");
    let workspace_id = "ws-share-view-unenrolled";
    initialize_share_view(&db, workspace_id, false);

    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&db, 2).expect("open actor").actor;
    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-local-only", "local only\n", 10),
            scratch.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("MUTATION: a view share view's write must still commit");
    supervisor.close(&db).expect("close actor");

    assert!(
        local_ops(&db).is_empty(),
        "MUTATION: a share view with no identity must journal nothing",
    );
}
