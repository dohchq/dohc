use dohc_engine_crypto::SecretDataKey;
use dohc_engine_domain::{
    CaptureIngest, CaptureIngestBinary, CaptureRetire, CaptureSecret, CaptureSecretRetire,
    CreateNamedVersion, DeleteTextFile, MergeTextFileFromVersion, RenameTextFile, SecretDelete,
    SecretDiskIntent, SecretWrite, VersionedTextStore, WriteBinary, WriteText,
};
use dohc_engine_runtime::{CancellationToken, NoFaults, SelfWriteRecorder, WorkspaceSupervisor};
use dohc_engine_storage::{EngineStore, StorageError};
use dohc_engine_sync::{
    ApplyOutcome, ReplicationEnvelope, apply_moment_envelope_detailed, apply_secret_envelope,
    apply_version_envelope,
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

#[tokio::test]
async fn relay_enabled_mutations_emit_payloads_that_apply_to_a_clean_peer() {
    let source = ScratchDir::new().expect("source scratch");
    let source_db = source.engine_db_path().expect("source db");
    let workspace_id = "ws-outbound-enabled";
    initialize_workspace(&source_db, workspace_id, true);
    let supervisor = WorkspaceSupervisor::new();
    let actor = supervisor.open(&source_db, 2).expect("open actor").actor;

    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-write-one", "first\n", 10),
            source.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write first moment");
    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-write-two", "second\n", 20),
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
            source.path().to_path_buf(),
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
        if op.op_kind == "moment.append" {
            let sha = op.payload["payloadAfterBlobSha256"]
                .as_str()
                .expect("moment blob sha");
            if op.payload["payloadAfterContentKind"].as_str() == Some("binary") {
                let bytes = source_store
                    .get_binary_blob(sha)
                    .expect("read binary moment blob")
                    .expect("binary moment blob exists");
                peer_store
                    .put_binary_blob(&bytes)
                    .expect("copy binary moment blob");
            } else {
                let text = source_store
                    .read_with(|conn| {
                        conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [sha], |row| {
                            row.get::<_, String>(0)
                        })
                    })
                    .expect("read source text blob");
                peer_store
                    .write_with(&NoFaults, |tx| {
                        tx.execute(
                            "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                            params![sha, text.len() as i64, text],
                        )
                        .map_err(StorageError::persist_public)?;
                        Ok::<_, StorageError>(())
                    })
                    .expect("copy text blob");
            }
            let outcome = apply_moment_envelope_detailed(
                &mut peer_store,
                &op.envelope(workspace_id),
                &NoFaults,
            )
            .expect("apply originated moment");
            let ApplyOutcome::Applied(result) = outcome else {
                panic!("originated moment was refused: {:?}", op.payload);
            };
            assert_eq!(result.conflicts_opened, 0, "{:?}", op.payload);
        } else if op.op_kind == "version.create" {
            for snapshot in op.payload["forkSnapshots"]
                .as_array()
                .expect("version snapshot rows")
            {
                let sha = snapshot["blobSha256"].as_str().expect("snapshot blob sha");
                if snapshot["contentKind"].as_str() == Some("binary") {
                    let bytes = source_store
                        .get_binary_blob(sha)
                        .expect("read version binary blob")
                        .expect("version binary blob exists");
                    peer_store
                        .put_binary_blob(&bytes)
                        .expect("copy version binary blob");
                } else {
                    let text = source_store
                        .read_with(|conn| {
                            conn.query_row("SELECT text FROM blobs WHERE sha256=?1", [sha], |row| {
                                row.get::<_, String>(0)
                            })
                        })
                        .expect("read version text blob");
                    peer_store
                        .write_with(&NoFaults, |tx| {
                            tx.execute(
                                "INSERT OR IGNORE INTO blobs (sha256, byte_length, text) VALUES (?1, ?2, ?3)",
                                params![sha, text.len() as i64, text],
                            )
                            .map_err(StorageError::persist_public)?;
                            Ok::<_, StorageError>(())
                        })
                        .expect("copy version text blob");
                }
            }
            apply_version_envelope(&mut peer_store, &op.envelope(workspace_id), &NoFaults)
                .expect("apply originated version");
        } else if op.op_kind.starts_with("secret.") {
            let shas = if op.op_kind == "secret.file.put" {
                vec![
                    op.payload["ciphertextSha256"]
                        .as_str()
                        .expect("ciphertext sha"),
                ]
            } else if op.op_kind == "secret.version.fork" {
                op.payload["rows"]
                    .as_array()
                    .expect("secret fork rows")
                    .iter()
                    .map(|row| {
                        row["ciphertextSha256"]
                            .as_str()
                            .expect("fork ciphertext sha")
                    })
                    .collect()
            } else {
                Vec::new()
            };
            for sha in shas {
                let bytes = source_store
                    .get_binary_blob(sha)
                    .expect("read ciphertext blob")
                    .expect("ciphertext blob exists");
                peer_store
                    .put_binary_blob(&bytes)
                    .expect("copy ciphertext blob");
            }
            apply_secret_envelope(&mut peer_store, &op.envelope(workspace_id), &NoFaults)
                .expect("apply originated secret");
        }
    }

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

    actor
        .versioned_text_write_indexed(
            write_input(workspace_id, "moment-local-only", "local\n", 10),
            scratch.path().to_path_buf(),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write local-only moment");
    actor
        .create_named_version(
            CreateNamedVersion {
                workspace_id: workspace_id.to_owned(),
                new_version_id: "version-local-only".to_owned(),
                name: "Local only".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 20,
                request_id: None,
            },
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("create local-only version");
    actor
        .write_secret_file(
            SecretWrite {
                workspace_id: workspace_id.to_owned(),
                version_id: "main".to_owned(),
                path: ".env".to_owned(),
                text: "TOKEN=local".to_owned(),
                moment_id: "secret-local-only".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                now_ms: 30,
                disk_intent: SecretDiskIntent::Materialize,
            },
            SecretDataKey::from_bytes(&[0x22; 32]).expect("secret key"),
            Arc::new(NoFaults),
            CancellationToken::new(),
        )
        .await
        .expect("write local-only secret");
    supervisor.close(&db).expect("close actor");

    assert!(local_ops(&db).is_empty());
    assert_eq!(replication_journal_count(&db), 4);
}
