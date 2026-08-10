use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBinary, CaptureRetire, CaptureSecret, CaptureSecretRetire,
    ConflictChoice, ConflictFileState, ConflictMetadata, ConflictStatus, CreateNamedVersion,
    DeleteTextFile, MergeTextFileFromVersion, RenameTextFile, ResolveConflictKind,
    ResolveTextConflict, RollbackTextFileMutation, SecretDelete, SecretDiskIntent, SecretWrite,
    TextConflict, TextSnapshot, VersionedTextStore, WriteBinary, WriteText,
};
use dohc_engine_runtime::{
    ActorHandle, CancellationToken, NoFaults, SelfWriteRecorder, WorkspaceSupervisor,
};
use dohc_engine_storage::{EngineStore, StorageError, hex_sha256};
use dohc_engine_sync::{
    ApplyOutcome, MAX_PAYLOAD_JSON_BYTES, ReplicationEnvelope, apply_moment_envelope_detailed,
    apply_secret_envelope, apply_version_envelope,
};
use dohc_engine_testkit::ScratchDir;
use rusqlite::params;
use std::path::Path;
use std::sync::Arc;

struct NoRecorder;

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
    let shas = if op.op_kind == "moment.append" {
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
            let outcome = apply_moment_envelope_detailed(peer, &envelope, &NoFaults)
                .unwrap_or_else(|error| {
                    panic!("apply moment envelope {error:?}: {:?}", op.payload)
                });
            let ApplyOutcome::Applied(result) = outcome else {
                panic!("originated moment outcome {outcome:?}: {:?}", op.payload);
            };
            assert_eq!(result.conflicts_opened, 0, "{:?}", op.payload);
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
    apply_moment_envelope_detailed(&mut peer_store, &op.envelope(workspace_id), &NoFaults)
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
        ["moment.append", "moment.append"]
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
        ["moment.append", "moment.append"]
    );
    assert_eq!(ops[1].payload["momentId"], "moment-resolved-delete");
    assert_eq!(ops[1].payload["operation"], "delete");
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
                incoming: ConflictFileState::binary(path, incoming_sha.clone()),
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
        ["moment.append", "moment.append"]
    );
    assert_eq!(ops[1].payload["momentId"], "moment-resolved-binary");
    assert_eq!(ops[1].payload["payloadAfterContentKind"], "binary");
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
