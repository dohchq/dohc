use dohc_engine_collab::{ContentKind as YdocContentKind, DocKey, LeaseRegistry, Regime, Ydoc};
use dohc_engine_domain::{
    CreateNamedVersion, ListMomentsQuery, MomentOp, RollbackTextFileMutation, VersionedTextStore,
    WriteText,
};
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256, put_binary_blob};
use dohc_engine_testkit::{ScratchDir, engine_db_path};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::{
    ApplyDisposition, ApplyOutcome, NoLiveLeases, RefusalReason, ReplicationEnvelope,
    ReplicationRefusal, SyncError, apply_replication_envelope, apply_ydoc_envelope,
    read_replication_acked_seq,
};

fn test_store() -> (ScratchDir, EngineStore) {
    let scratch = ScratchDir::new().expect("scratch");
    let path = engine_db_path(&scratch).expect("db path");
    let mut store = EngineStore::open(&path, 1_000).expect("store");
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 1_000, &NoFaults)
        .expect("main version");
    (scratch, store)
}

fn apply_moment_envelope(
    store: &mut EngineStore,
    envelope: &ReplicationEnvelope,
    faults: &dyn dohc_engine_storage::FaultInjector,
) -> Result<ApplyOutcome<i64>, SyncError> {
    crate::apply_moment_envelope(store, envelope, faults, &NoLiveLeases)
}

fn envelope(origin: &str, seq: i64, workspace_id: &str, payload: Value) -> ReplicationEnvelope {
    ReplicationEnvelope {
        workspace_id: workspace_id.to_owned(),
        origin_id: origin.to_owned(),
        origin_seq: seq,
        op_kind: "moment.append".to_owned(),
        payload,
        recorded_at_ms: 2_000 + seq,
        relay_seq: None,
    }
}

fn text_sha(text: &str) -> String {
    hex_sha256(text.as_bytes())
}

#[test]
fn observed_owner_imports_old_settlements_without_rewinding_accepted_state_or_pending_draft() {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::owner_outbox::{
        OwnerOutboxLimits,
        accepted::{OwnerAcceptedFrameInput, apply_frame_in_tx},
        draft::{
            ObservedOwnerBinding, append_draft_in_tx, install_observed_binding_in_tx, open_draft_in,
        },
    };
    let (scratch, mut store) = test_store();
    let fixture: Value = serde_json::from_str(include_str!(
        "../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let original: Vec<u8> = serde_json::from_value(fixture["bytes"].clone()).unwrap();
    let initial_text = fixture["markdown"].as_str().unwrap();
    let initial_moment = format!("moment-ydoc-{}", "a".repeat(64));
    seed_text_moment(
        &mut store,
        "object",
        "owner.md",
        initial_text,
        &initial_moment,
        None,
        true,
    );
    let key = DocKey::new("ws", "main", "object").unwrap();
    dohc_engine_collab::claim_base(
        &mut store,
        &key,
        YdocContentKind::Richdoc,
        &original,
        &NoFaults,
        2,
    )
    .unwrap();
    store
        .read_with(|conn| conn.execute("UPDATE ydoc_docs SET path='owner.md'", []))
        .unwrap();
    let doc = store
        .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
        .unwrap();
    let checkpoint = doc.encode_full_state();
    let mut observed = ObservedOwnerBinding {
        binding: LiveObjectBinding {
            workspace_id: "ws".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: hex_sha256(&original),
            current_path: "owner.md".into(),
            selector_paths: vec!["owner.md".into()],
            restore_fence_generation: 0,
        },
        relay_database_namespace: "relay".into(),
        revision: 1,
        accepted_cursor: 0,
        native_head_sequence: store
            .read_with(|conn| dohc_engine_collab::read_marker_in(conn, &key))
            .unwrap()
            .unwrap()
            .head_update_seq,
        checkpoint_digest: hex_sha256(&checkpoint),
        limits: OwnerOutboxLimits {
            max_pending_bytes: 1_000_000,
            max_pending_age_ms: 60_000,
        },
    };
    store
        .write_with(&NoFaults, |tx| {
            install_observed_binding_in_tx(tx, "ws", &observed, &checkpoint)
        })
        .unwrap();
    let mut texts = Vec::new();
    for (index, text) in ["first accepted edit", "second accepted edit"]
        .iter()
        .enumerate()
    {
        let update = doc.richdoc_append_paragraph(text);
        let result = store
            .write_with(&NoFaults, |tx| {
                apply_frame_in_tx(
                    tx,
                    "ws",
                    &OwnerAcceptedFrameInput {
                        binding: observed.binding.clone(),
                        relay_database_namespace: "relay".into(),
                        expected_revision: observed.revision,
                        expected_native_head_sequence: observed.native_head_sequence,
                        previous_accepted_cursor: observed.accepted_cursor,
                        journal_cursor: index as i64 + 1,
                        update_bytes: update.clone(),
                    },
                    index as i64 + 3,
                )
            })
            .unwrap();
        let dohc_engine_storage::TxnOutcome::Committed(result) = result else {
            panic!("frame must commit")
        };
        observed.revision = result.revision;
        observed.native_head_sequence = result.native_head_sequence;
        observed.accepted_cursor = result.accepted_cursor;
        texts.push(doc.project(YdocContentKind::Richdoc).unwrap().content);
    }
    let accepted_bytes = doc.encode_full_state();
    let pending_update = doc.richdoc_append_paragraph("private pending owner edit");
    store
        .write_with(&NoFaults, |tx| {
            append_draft_in_tx(
                tx,
                "ws",
                &observed.binding,
                observed.revision,
                "pending".into(),
                pending_update.clone(),
                5,
            )
        })
        .unwrap();
    let pending_bytes = doc.encode_full_state();
    hydrate_texts(&mut store, &[&texts[0], &texts[1]]);
    let old_id = format!("moment-ydoc-{}", "b".repeat(64));
    let latest_id = format!("moment-ydoc-{}", "c".repeat(64));
    let retain_audit = |store: &EngineStore, id: &str, text: &str, cursor: i64| {
        // The audit parser is covered separately. Seed its committed output
        // to isolate ordinary moment admission against native owner state.
        let binding = serde_json::to_string(&observed.binding).unwrap();
        let record = format!(
            "{{\"momentId\":{},\"relayDatabaseNamespace\":\"relay\",\"binding\":{},\"terminalCursor\":{cursor}}}",
            serde_json::to_string(id).unwrap(),
            binding
        );
        store.read_with(|conn| conn.execute("INSERT INTO live_audit_settlements(settlement_id,workspace_id,record_digest,record_json,markdown_digest) VALUES (?1,'ws',?2,?3,?4)", params![id, hex_sha256(record.as_bytes()), record, text_sha(text)])).unwrap();
    };
    retain_audit(&store, &old_id, &texts[0], 1);
    retain_audit(&store, &latest_id, &texts[1], 2);
    let old = envelope(
        "host",
        0,
        "ws",
        present_text_payload(
            &old_id,
            "object",
            "write",
            "owner.md",
            "owner.md",
            initial_text,
            &initial_moment,
            &texts[0],
        ),
    );
    let latest = envelope(
        "host",
        1,
        "ws",
        present_text_payload(
            &latest_id, "object", "write", "owner.md", "owner.md", &texts[0], &old_id, &texts[1],
        ),
    );
    let before = snapshot(&store, "object");
    let old_result =
        crate::apply_moment_envelope_detailed(&mut store, &old, &NoFaults, &NoLiveLeases).unwrap();
    assert!(
        matches!(old_result.primary, ApplyDisposition::Applied(ref result) if result.materialization_changes.is_empty() && result.conflicts_opened == 0)
    );
    assert_eq!(snapshot(&store, "object"), before);
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT sync_record_only FROM moments WHERE moment_id=?1",
                [&old_id],
                |row| row.get::<_, i64>(0)
            ))
            .unwrap(),
        1
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &latest, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT blob_sha256 FROM snapshots WHERE object_id='object'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        text_sha(&texts[1])
    );
    assert_eq!(
        store
            .read_with(|conn| dohc_engine_collab::load_doc_in(conn, &key))
            .unwrap()
            .encode_full_state(),
        accepted_bytes
    );
    assert_eq!(
        store
            .read_with(|conn| open_draft_in(conn, &observed.binding, observed.revision))
            .unwrap()
            .doc
            .encode_full_state(),
        pending_bytes
    );
    assert_eq!(store.table_row_count("conflicts").unwrap(), 0);
    assert_eq!(read_replication_acked_seq(&store, "ws", "host").unwrap(), 1);
    assert_eq!(
        apply_moment_envelope(&mut store, &old, &NoFaults).unwrap(),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    let renamed = envelope(
        "renamed",
        0,
        "ws",
        present_text_payload(
            &format!("moment-ydoc-{}", "d".repeat(64)),
            "object",
            "rename",
            "owner.md",
            "moved.md",
            &texts[1],
            &latest_id,
            &texts[1],
        ),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &renamed, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        store
            .read_with(|conn| open_draft_in(conn, &observed.binding, observed.revision))
            .unwrap()
            .doc
            .encode_full_state(),
        pending_bytes
    );

    let future = Ydoc::wire();
    future.apply(&accepted_bytes).unwrap();
    let future_update = future.richdoc_append_paragraph("accepted after ordinary pull");
    let future_text = future.project(YdocContentKind::Richdoc).unwrap().content;
    hydrate_texts(&mut store, &[&future_text]);
    let future_id = format!("moment-ydoc-{}", "e".repeat(64));
    retain_audit(&store, &future_id, &future_text, 3);
    let future_moment = envelope(
        "host",
        2,
        "ws",
        present_text_payload(
            &future_id,
            "object",
            "write",
            "owner.md",
            "owner.md",
            &texts[1],
            &latest_id,
            &future_text,
        ),
    );
    crate::adopt_join_identity(&mut store, "ws", "local", "epoch", "stream", 6, &NoFaults).unwrap();
    hydrate_texts(&mut store, &["unrelated ordinary file"]);
    let unrelated = envelope(
        "host",
        3,
        "ws",
        absent_text_payload(
            "unrelated",
            "unrelated",
            "other.md",
            "unrelated ordinary file",
        ),
    );
    let client = crate::RelaySyncClient::new(crate::tests::FakeRelay::default());
    *client.transport().pull.lock().unwrap() = Some(crate::PullResponse {
        ops: vec![future_moment.clone(), unrelated],
        next_cursor: 2,
        has_more: false,
    });
    let mut cache = dohc_engine_collab::WriterDocCache::default();
    let pulled = client
        .pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 7)
        .unwrap();
    let crate::SyncPassOutcome::Complete {
        pending_cursor: Some(waiting_cursor),
        changed_paths,
        has_more,
        ..
    } = pulled
    else {
        panic!("pull must complete");
    };
    assert!(!has_more);
    assert_eq!(changed_paths.len(), 1);
    assert_eq!(changed_paths[0].path, "other.md");
    assert_eq!(read_replication_acked_seq(&store, "ws", "host").unwrap(), 3);
    let mut collision = future_moment.clone();
    collision.origin_id = "collision".into();
    collision.origin_seq = 0;
    assert!(matches!(
        apply_moment_envelope(&mut store, &collision, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    let waiting =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert!(waiting.report_id.is_none());
    assert!(!waiting.has_more);
    assert!(waiting.changes.is_empty());
    // Advancing ordinary sync and reopening must preserve the waiting row.
    crate::commit_relay_cursor(&mut store, "ws", &waiting_cursor, &NoFaults, 7).unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 8).unwrap();
    assert_eq!(read_replication_acked_seq(&store, "ws", "host").unwrap(), 3);
    assert_eq!(
        crate::read_relay_cursor(&store, "ws")
            .unwrap()
            .unwrap()
            .cursor,
        2
    );
    let result = store
        .write_with(&NoFaults, |tx| {
            apply_frame_in_tx(
                tx,
                "ws",
                &OwnerAcceptedFrameInput {
                    binding: observed.binding.clone(),
                    relay_database_namespace: "relay".into(),
                    expected_revision: observed.revision,
                    expected_native_head_sequence: observed.native_head_sequence,
                    previous_accepted_cursor: observed.accepted_cursor,
                    journal_cursor: 3,
                    update_bytes: future_update.clone(),
                },
                6,
            )
        })
        .unwrap();
    let dohc_engine_storage::TxnOutcome::Committed(result) = result else {
        panic!("frame must commit")
    };
    let leased = crate::moment_apply::pending::drain_and_claim(
        &mut store,
        "ws",
        &NoFaults,
        &crate::AlwaysLive,
    )
    .unwrap();
    assert!(leased.changes.is_empty());
    assert!(leased.report_id.is_none());
    assert!(!leased.has_more);
    *client.transport().pull.lock().unwrap() = Some(crate::PullResponse {
        ops: vec![],
        next_cursor: 2,
        has_more: false,
    });
    let caught_up = client
        .pull_chat_workspace(&mut store, &mut cache, "ws", &NoFaults, &NoLiveLeases, 8)
        .unwrap();
    let crate::SyncPassOutcome::Complete {
        pending_cursor: Some(mut applied_cursor),
        changed_paths: settled_changes,
        has_more,
        ..
    } = caught_up
    else {
        panic!("empty pull must publish");
    };
    assert!(!has_more);
    assert_eq!(settled_changes.len(), 1);
    assert_eq!(settled_changes[0].path, "owner.md");
    assert!(applied_cursor.settlement_report_id.is_some());
    assert_eq!(
        store
            .read_with(|conn| conn.query_row(
                "SELECT blob_sha256 FROM snapshots WHERE object_id='object'",
                [],
                |row| row.get::<_, String>(0)
            ))
            .unwrap(),
        text_sha(&future_text)
    );
    future.apply(&pending_update).unwrap();
    assert_eq!(
        store
            .read_with(|conn| open_draft_in(conn, &observed.binding, result.revision))
            .unwrap()
            .doc
            .encode_full_state(),
        future.encode_full_state()
    );
    // Crash after apply, before materialization/cursor commit: the next empty
    // pull reclaims the same disk decision. A stale cursor cannot delete it.
    drop(store);
    let mut store = EngineStore::open(&engine_db_path(&scratch).unwrap(), 9).unwrap();
    let replay =
        crate::moment_apply::pending::drain_and_claim(&mut store, "ws", &NoFaults, &NoLiveLeases)
            .unwrap();
    assert_eq!(replay.changes, settled_changes);
    assert_ne!(replay.report_id, applied_cursor.settlement_report_id);
    crate::commit_relay_cursor(&mut store, "ws", &applied_cursor, &NoFaults, 10).unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        1
    );
    applied_cursor.settlement_report_id = replay.report_id;
    crate::commit_relay_cursor(&mut store, "ws", &applied_cursor, &NoFaults, 11).unwrap();
    assert_eq!(
        store.table_row_count("owner_pending_settlements").unwrap(),
        0
    );
    assert_eq!(
        store
            .table_row_count("owner_pending_settlement_blobs")
            .unwrap(),
        0
    );
}

#[test]
fn public_create_author_survives_replay_and_payload_export() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["---\nanswer: Lisbon\n---\n"]);
    let mut payload = absent_text_payload(
        "accepted-create",
        "response-object",
        "poll/response.md",
        "---\nanswer: Lisbon\n---\n",
    );
    let author = json!({"kind":"public", "principalId":"public-holder", "grantId":"grant"});
    payload["author"] = author.clone();
    let op = envelope("relay:collection-create:grant", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("accept"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    apply_moment_envelope(&mut store, &op, &NoFaults).expect("idempotent replay");
    store
        .write_with(&NoFaults, |tx| {
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM moments WHERE moment_id='accepted-create'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1);
            let (exported, _) =
                crate::outbound::moment_append_payload_in_tx(tx, "ws", "accepted-create").unwrap();
            assert_eq!(exported["author"], author);
            Ok::<_, SyncError>(())
        })
        .unwrap();
}

#[test]
fn public_author_is_refused_from_an_ordinary_origin() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["answer"]);
    let mut payload = absent_text_payload(
        "forged-public",
        "forged-object",
        "poll/response.md",
        "answer",
    );
    payload["author"] = json!({"kind":"public", "principalId":"holder", "grantId":"grant"});
    let result = apply_moment_envelope(
        &mut store,
        &envelope("device-origin", 0, "ws", payload),
        &NoFaults,
    )
    .expect("refusal is recorded");
    assert!(
        matches!(result.primary, ApplyDisposition::Refused(ref refusal) if matches!(refusal.reason, RefusalReason::InvalidInput { ref reason } if reason == "public moment author requires a relay collection origin"))
    );
}

fn hydrate_texts(store: &mut EngineStore, texts: &[&str]) {
    store
        .read_with(|tx| {
            for text in texts {
                tx.execute(
                    "INSERT OR IGNORE INTO blobs (sha256,byte_length,text) VALUES (?1,?2,?3)",
                    params![text_sha(text), text.len() as i64, text],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("hydrate text blobs");
}

fn seed_text_moment(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    text: &str,
    moment_id: &str,
    before: Option<(&str, &str)>,
    materialize_head: bool,
) {
    hydrate_texts(store, &[text]);
    if let Some((_, before_text)) = before {
        hydrate_texts(store, &[before_text]);
    }
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )?;
            let order: i64 = tx.query_row(
                "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            let (before_present, before_sha, before_id) = before.map_or(
                (1_i64, None, None),
                |(before_id, before_text)| {
                    (
                        2_i64,
                        Some(text_sha(before_text)),
                        Some(before_id.to_owned()),
                    )
                },
            );
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,?5,'write',?6,?7,?8,?9,
                           'api',NULL,NULL,'text',NULL,'text',NULL)",
                params![
                    order,
                    moment_id,
                    object_id,
                    path,
                    100 + order,
                    text_sha(text),
                    before_present,
                    before_sha,
                    before_id
                ],
            )?;
            if materialize_head {
                tx.execute(
                    "INSERT INTO snapshots (
                       workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                       latest_moment_id,metadata_origin,content_kind,binary_sha256
                     ) VALUES ('ws','main',?1,?2,?3,?4,?5,'api','text',NULL)
                     ON CONFLICT(workspace_id,version_id,object_id) DO UPDATE SET
                       path=excluded.path,blob_sha256=excluded.blob_sha256,
                       updated_at_ms=excluded.updated_at_ms,
                       latest_moment_id=excluded.latest_moment_id,
                       metadata_origin=excluded.metadata_origin,content_kind='text',
                       binary_sha256=NULL",
                    params![object_id, path, text_sha(text), 100 + order, moment_id],
                )?;
                tx.execute(
                    "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                     VALUES ('ws','main',?1,?2)
                     ON CONFLICT(workspace_id,version_id,path) DO UPDATE SET object_id=excluded.object_id",
                    params![path, object_id],
                )?;
            }
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed text moment");
}

fn seed_text_lineage(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    base_text: &str,
    base_id: &str,
    head_text: &str,
    head_id: &str,
) {
    seed_text_moment(store, object_id, path, base_text, base_id, None, false);
    seed_text_moment(
        store,
        object_id,
        path,
        head_text,
        head_id,
        Some((base_id, base_text)),
        true,
    );
}

fn seed_binary_head(
    store: &mut EngineStore,
    object_id: &str,
    path: &str,
    bytes: &[u8],
    moment_id: &str,
) -> String {
    let actual = hex_sha256(bytes);
    let stored = store
        .read_with(|tx| {
            let stored = put_binary_blob(tx, bytes)?;
            tx.execute(
                "INSERT OR IGNORE INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws',?1,1)",
                [object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            let order: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(moment_order),-1)+1 FROM moments WHERE workspace_id='ws'",
                    [],
                    |row| row.get(0),
                )
                .map_err(dohc_engine_storage::StorageError::corrupt_public)?;
            tx.execute(
                "INSERT INTO moments (
                   workspace_id,moment_order,moment_id,version_id,object_id,path,recorded_at_ms,
                   operation,after_blob_sha256,before_present,before_blob_sha256,
                   before_latest_moment_id,metadata_origin,author_json,sync_record_only,
                   after_content_kind,after_binary_sha256,before_content_kind,before_binary_sha256
                 ) VALUES ('ws',?1,?2,'main',?3,?4,100,'write',NULL,1,NULL,NULL,
                           'api',NULL,NULL,'binary',?5,'text',NULL)",
                params![order, moment_id, object_id, path, stored],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO snapshots (
                   workspace_id,version_id,object_id,path,blob_sha256,updated_at_ms,
                   latest_moment_id,metadata_origin,content_kind,binary_sha256
                 ) VALUES ('ws','main',?1,?2,NULL,100,?3,'api','binary',?4)",
                params![object_id, path, moment_id, stored],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            tx.execute(
                "INSERT INTO path_aliases (workspace_id,version_id,path,object_id)
                 VALUES ('ws','main',?1,?2)",
                params![path, object_id],
            )
            .map_err(dohc_engine_storage::StorageError::persist_public)?;
            Ok::<_, dohc_engine_storage::StorageError>(stored)
        })
        .expect("seed binary head");
    assert_eq!(stored, actual);
    actual
}

fn absent_text_payload(moment_id: &str, object_id: &str, path: &str, text: &str) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": text_sha(text),
        "payloadAfterPath": path,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    })
}

#[test]
fn replicated_moment_snapshot_origin_is_sync() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["peer capture"]);
    let mut payload = absent_text_payload(
        "peer-capture-moment",
        "peer-capture-object",
        "notes/peer.md",
        "peer capture",
    );
    payload["metadata"]["origin"] = json!("local-file");

    apply_moment_envelope(&mut store, &envelope("peer", 0, "ws", payload), &NoFaults)
        .expect("replicated moment");

    let origin: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='peer-capture-object'",
                [],
                |row| row.get(0),
            )
        })
        .expect("snapshot origin");
    assert_eq!(origin, "sync");
}

#[test]
fn moment_after_equivalent_ydoc_projection_fast_forwards() {
    let (_peer_scratch, mut peer) = test_store();
    let local_settle_id = format!("moment-ydoc-{}", "a".repeat(64));

    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "settled text");
    let base_sha = peer
        .put_binary_blob(&doc.encode_full_state())
        .expect("Y.Doc base blob");
    let base = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "ydoc-origin".to_owned(),
        origin_seq: 0,
        op_kind: "ydoc.update".to_owned(),
        payload: json!({
            "versionId": "main",
            "objectId": "ydoc-settle-object",
            "path": "notes/settled.md",
            "contentKind": "plaintext",
            "updateBlobSha256": base_sha.clone(),
            "lineageClaimId": base_sha.clone(),
            "isBaseState": true
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    apply_ydoc_envelope(
        &mut peer,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &base,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("peer Y.Doc projection");
    let peer_head: String = peer
        .read_with(|conn| {
            conn.query_row(
                "SELECT latest_moment_id FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='ydoc-settle-object'",
                [],
                |row| row.get(0),
            )
        })
        .expect("peer projected head");
    assert!(peer_head.starts_with("moment-ydoc-apply-"));
    assert_ne!(peer_head, local_settle_id);

    let rewrite = [
        doc.plaintext_delete(0, "settled text".len() as u32),
        doc.plaintext_insert(0, "next edit"),
    ];
    for (index, update) in rewrite.into_iter().enumerate() {
        let update_sha = peer.put_binary_blob(&update).expect("Y.Doc rewrite blob");
        let delta = ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "ydoc-origin".to_owned(),
            origin_seq: index as i64 + 1,
            op_kind: "ydoc.update".to_owned(),
            payload: json!({
                "versionId": "main",
                "objectId": "ydoc-settle-object",
                "path": "notes/settled.md",
                "contentKind": "plaintext",
                "updateBlobSha256": update_sha,
                "lineageClaimId": base_sha.clone(),
                "isBaseState": false
            }),
            recorded_at_ms: 1_600 + index as i64,
            relay_seq: Some(index as i64 + 1),
        };
        apply_ydoc_envelope(
            &mut peer,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delta,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("peer Y.Doc rewrite");
    }

    hydrate_texts(&mut peer, &["next edit"]);
    let next = envelope(
        "moment-origin",
        0,
        "ws",
        present_text_payload(
            "moment-after-settle",
            "ydoc-settle-object",
            "write",
            "notes/settled.md",
            "notes/settled.md",
            "settled text",
            &local_settle_id,
            "next edit",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut peer, &next, &NoFaults).expect("next moment"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    let (latest_moment_id, conflicts): (String, i64) = peer
        .read_with(|conn| {
            let latest = conn.query_row(
                "SELECT latest_moment_id FROM snapshots \
                 WHERE workspace_id='ws' AND version_id='main' \
                   AND object_id='ydoc-settle-object'",
                [],
                |row| row.get(0),
            )?;
            let conflicts = conn.query_row(
                "SELECT COUNT(*) FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )?;
            Ok::<_, rusqlite::Error>((latest, conflicts))
        })
        .expect("peer result");
    assert_eq!(latest_moment_id, "moment-after-settle");
    assert_eq!(conflicts, 0);
}

#[allow(clippy::too_many_arguments)]
fn present_text_payload(
    moment_id: &str,
    object_id: &str,
    operation: &str,
    path: &str,
    after_path: &str,
    before_text: &str,
    before_head: &str,
    after_text: &str,
) -> Value {
    json!({
        "momentId": moment_id,
        "versionId": "main",
        "objectId": object_id,
        "objectCreatedAtMs": 1,
        "path": path,
        "recordedAtMs": 2_000,
        "operation": operation,
        "payloadBeforeBlobSha256": text_sha(before_text),
        "payloadBeforePath": path,
        "payloadAfterBlobSha256": text_sha(after_text),
        "payloadAfterPath": after_path,
        "metadata": {"origin": "sync", "summary": "peer"},
        "beforePresent": "present",
        "beforeObjectId": object_id,
        "beforeVersionId": "main",
        "beforePath": path,
        "beforeBlobSha256": text_sha(before_text),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": before_head,
        "beforeMetadata": {"origin": "api"}
    })
}

fn stopped_binary_moment() -> (
    ScratchDir,
    EngineStore,
    ReplicationEnvelope,
    dohc_engine_collab::owner_outbox::OwnerOutboxAppendResult,
    Vec<u8>,
) {
    use dohc_engine_collab::live_object_binding::LiveObjectBinding;
    use dohc_engine_collab::live_update_application::{
        NativeRestoreFence, NativeRestoreFenceReceipt, RestoreDeliveryOrigin,
    };
    use dohc_engine_collab::owner_outbox::{self, OwnerOutboxAppendInput, OwnerOutboxLimits};
    let (scratch, mut store) = test_store();
    crate::adopt_join_identity(
        &mut store,
        "ws",
        "local-peer",
        "epoch",
        "stream",
        1_000,
        &NoFaults,
    )
    .expect("joined workspace identity");
    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "object".into(),
                path: "shared.md".into(),
                text: "current".into(),
                moment_id: "current-moment".into(),
                metadata_origin: "api".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 100,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("real current moment");
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: "lineage".into(),
        current_path: "shared.md".into(),
        selector_paths: vec!["shared.md".into()],
        restore_fence_generation: 0,
    };
    let bytes = vec![0xff, 0x00, 0xfe, 0x01];
    let outbox = owner_outbox::append(
        &mut store,
        "ws",
        OwnerOutboxAppendInput {
            binding: LiveObjectBinding {
                object_id: "other".into(),
                current_path: "other.md".into(),
                selector_paths: vec!["other.md".into()],
                ..binding.clone()
            },
            base_update: b"different base".to_vec(),
            append_key: "other-update".into(),
            update: bytes.clone(),
            limits: OwnerOutboxLimits {
                max_pending_bytes: 10_000,
                max_pending_age_ms: 10_000,
            },
            created_at_ms: 1_000,
        },
    )
    .expect("independent outbox owns the shared digest");
    let operation = NativeRestoreFence {
        operation_id: "restore".into(),
        relay_database_namespace: "relay".into(),
        old_binding: binding,
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let receipt = NativeRestoreFenceReceipt {
        operation: operation.clone(),
        local_head_sequence: 0,
        recorded_at_ms: 1_001,
    };
    store.read_with(|conn| conn.execute(
        "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','object','relay','restore',?1,?2)",
        params![serde_json::to_string(&operation).unwrap(), serde_json::to_string(&receipt).unwrap()],
    )).expect("seed the durable stopped-lineage guard");
    let mut payload = present_text_payload(
        "refused-moment",
        "object",
        "write",
        "shared.md",
        "shared.md",
        "current",
        "current-moment",
        "unused",
    );
    payload["payloadAfterBlobSha256"] = json!(hex_sha256(&bytes));
    payload["payloadAfterContentKind"] = json!("binary");
    payload["payloadAfterByteLength"] = json!(bytes.len());
    payload["author"] =
        json!({"kind":"agent","agentId":"original-agent","onBehalfOf":"original-owner"});
    (
        scratch,
        store,
        envelope("original-peer", 0, "ws", payload),
        outbox,
        bytes,
    )
}

#[test]
fn stopped_moment_retains_shared_blobs_after_outbox_ack_report_and_restart() {
    use dohc_engine_collab::owner_outbox::{self, OwnerDeliveryReceipt};
    let (_scratch, mut store, op, outbox, bytes) = stopped_binary_moment();
    let db = store.database_path().to_owned();
    let before = snapshot(&store, "object");
    let result = apply_moment_envelope(&mut store, &op, &NoFaults).unwrap();
    assert!(
        matches!(result.primary, ApplyDisposition::Refused(ReplicationRefusal {
        reason: RefusalReason::InvalidInput { ref reason }, ..
    }) if reason == "live document is stopped")
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        0
    );
    assert_eq!(snapshot(&store, "object"), before);
    let ack = owner_outbox::acknowledge(
        &mut store,
        "ws",
        &outbox.outbox_id,
        &[OwnerDeliveryReceipt {
            delivery_id: outbox.delivery_id,
            update_digest: outbox.update_digest,
            journal_cursor: 1,
            accepting_host_epoch: 1,
        }],
    )
    .expect("unrelated outbox can release its ownership");
    assert_eq!(ack.pending_bytes, 0);
    assert_eq!(
        store.get_binary_blob(&hex_sha256(&bytes)).unwrap(),
        Some(bytes.clone())
    );
    let (refusals, report) =
        crate::apply::claim_pending_refusals(&mut store, "ws", &NoFaults).unwrap();
    assert_eq!(refusals.len(), 1);
    crate::commit_relay_cursor(
        &mut store,
        "ws",
        &crate::RelayCursor {
            cursor: 1,
            replication_epoch: "epoch".into(),
            stream_identity: "stream".into(),
            refusal_report_id: report,
            settlement_report_id: None,
        },
        &NoFaults,
        3_000,
    )
    .expect("report commit");
    drop(store);
    let mut store = EngineStore::open(&db, 4_000).unwrap();
    store.read_with(|conn| {
        let saved: (String, String, i64, i64, i64) = conn.query_row(
            "SELECT payload_json,apply_disposition,recorded_at_ms,imported,origin_seq FROM replication_log WHERE workspace_id='ws' AND origin_id='original-peer' AND origin_seq=0",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        )?;
        assert_eq!(serde_json::from_str::<Value>(&saved.0).unwrap(), op.payload);
        assert_eq!((saved.1, saved.2, saved.3, saved.4), ("refused".into(), op.recorded_at_ms, 1, 0));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replication_pending_refusals", [], |r| r.get::<_,i64>(0))?, 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM replication_refused_moment_blobs", [], |r| r.get::<_,i64>(0))?, 3);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM moments WHERE moment_id='refused-moment'", [], |r| r.get::<_,i64>(0))?, 0);
        assert!(conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [hex_sha256(&bytes)]).is_err());
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
    assert_eq!(
        store.get_binary_blob(&hex_sha256(&bytes)).unwrap(),
        Some(bytes)
    );
    assert_eq!(snapshot(&store, "object"), before);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Skipped
    ));
    assert_eq!(snapshot(&store, "object"), before);
}

#[test]
fn stopped_moment_retention_failure_does_not_ack_or_commit_refusal() {
    let (_scratch, mut store, op, _outbox, _bytes) = stopped_binary_moment();
    let before = snapshot(&store, "object");
    store.read_with(|conn| conn.execute_batch(
        "CREATE TEMP TRIGGER reject_retention BEFORE INSERT ON replication_refused_moment_blobs WHEN NEW.role='payload-after' BEGIN SELECT RAISE(ABORT,'retention unavailable'); END;"
    )).unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(_))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        -1
    );
    assert_eq!(snapshot(&store, "object"), before);
    store
        .read_with(|conn| {
            for table in [
                "replication_refused_moment_blobs",
                "replication_pending_refusals",
                "replication_log",
            ] {
                assert_eq!(
                    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r
                        .get::<_, i64>(0))?,
                    0
                );
            }
            conn.execute_batch("DROP TRIGGER reject_retention")?;
            Ok::<_, rusqlite::Error>(())
        })
        .unwrap();
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults)
            .unwrap()
            .primary,
        ApplyDisposition::Refused(_)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "original-peer").unwrap(),
        0
    );
}

fn snapshot(store: &EngineStore, object_id: &str) -> Option<(String, String, String, String)> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT path,COALESCE(content_kind,'text'),
                        COALESCE(blob_sha256,binary_sha256),latest_moment_id
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' AND object_id=?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
        })
        .expect("snapshot")
}

fn aliases(store: &EngineStore, object_id: &str) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path FROM path_aliases WHERE workspace_id='ws' AND version_id='main' \
                 AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| row.get(0))?
            .collect()
        })
        .expect("aliases")
}

fn indexed(store: &EngineStore, object_id: &str) -> Vec<(String, String)> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT path,text FROM engine_search_files_fts \
                 WHERE workspace_id='ws' AND version_id='main' AND object_id=?1 ORDER BY path",
            )?
            .query_map([object_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect()
        })
        .expect("search rows")
}

fn conflict_ids(store: &EngineStore) -> Vec<String> {
    store
        .read_with(|conn| {
            conn.prepare(
                "SELECT conflict_id FROM conflicts WHERE workspace_id='ws' ORDER BY conflict_id",
            )?
            .query_map([], |row| row.get(0))?
            .collect()
        })
        .expect("conflict ids")
}

#[test]
fn moment_delete_retires_the_receiver_ydoc_lineage() {
    let (_scratch, mut peer) = test_store();
    let local_settle_id = format!("moment-ydoc-{}", "b".repeat(64));
    let doc = Ydoc::wire();
    doc.plaintext_insert(0, "gone");
    let base_sha = peer
        .put_binary_blob(&doc.encode_full_state())
        .expect("Y.Doc base blob");
    apply_ydoc_envelope(
        &mut peer,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &ReplicationEnvelope {
            workspace_id: "ws".to_owned(),
            origin_id: "ydoc-origin".to_owned(),
            origin_seq: 0,
            op_kind: "ydoc.update".to_owned(),
            payload: json!({
                "versionId": "main",
                "objectId": "ydoc-delete-object",
                "path": "notes/deleted.md",
                "contentKind": "plaintext",
                "updateBlobSha256": base_sha.clone(),
                "lineageClaimId": base_sha,
                "isBaseState": true
            }),
            recorded_at_ms: 1_500,
            relay_seq: Some(0),
        },
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("project Y.Doc base");

    let delete = envelope(
        "moment-origin",
        0,
        "ws",
        present_text_payload(
            "moment-delete-ydoc",
            "ydoc-delete-object",
            "delete",
            "notes/deleted.md",
            "notes/deleted.md",
            "gone",
            &local_settle_id,
            "gone",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut peer, &delete, &NoFaults).expect("apply delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    let (snapshots, markers): (i64, i64) = peer
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='ydoc-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='ydoc-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect deleted object");
    assert_eq!(
        (snapshots, markers),
        (0, 0),
        "the inbound delete must remove the snapshot and canonical lineage together"
    );
}

#[test]
fn moment_delete_with_unsettled_lineage_stays_unacked() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','unsettled-delete-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed unsettled object");
    let key = DocKey::new("ws", "main", "unsettled-delete-object").expect("Y.Doc key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "only durable draft");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("notes/unsettled.md"),
                content_kind: YdocContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed unsettled lineage");
    hydrate_texts(&mut store, &["remote head", ""]);
    let delete = envelope(
        "unsettled-delete-peer",
        0,
        "ws",
        present_text_payload(
            "moment-delete-unsettled",
            "unsettled-delete-object",
            "delete",
            "notes/unsettled.md",
            "notes/unsettled.md",
            "remote head",
            "remote-head",
            "",
        ),
    );

    let outcome = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &delete,
        &NoFaults,
        &NoLiveLeases,
    );
    assert!(
        matches!(
            outcome,
            Err(SyncError::RetryableState {
                reason: "ydoc-lineage-unsettled"
            })
        ),
        "unexpected delete outcome: {outcome:?}"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "unsettled-delete-peer").expect("ack"),
        -1
    );
    let (moments, log, updates, snapshots, deferred, docs): (i64, i64, i64, i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                         AND moment_id='moment-delete-unsettled'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws' \
                         AND origin_id='unsettled-delete-peer'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_snapshots WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_deferred_updates WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                         AND version_id='main' AND object_id='unsettled-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect retryable delete");
    assert_eq!((moments, log), (0, 0));
    assert_eq!(
        (updates, snapshots, deferred, docs),
        (1, 0, 0, 1),
        "the only durable draft must remain byte-for-byte reachable"
    );
}

#[test]
fn moment_delete_with_orphan_scene_lineage_stays_unacked() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','orphan-scene-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed orphan scene object");
    let key = DocKey::new("ws", "main", "orphan-scene-object").expect("scene key");
    let imported = dohc_engine_collab::import_portable_scene(
        &json!({
            "type": "excalidraw",
            "version": 2,
            "source": "https://excalidraw.com",
            "elements": [],
            "appState": {},
            "files": {}
        })
        .to_string(),
    )
    .expect("import scene");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &imported.initial_update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("drawings/orphan.excalidraw"),
                content_kind: YdocContentKind::Scene,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed orphan scene lineage");
    hydrate_texts(&mut store, &["remote scene", ""]);
    let delete = envelope(
        "orphan-scene-delete-peer",
        0,
        "ws",
        present_text_payload(
            "moment-delete-orphan-scene",
            "orphan-scene-object",
            "delete",
            "drawings/orphan.excalidraw",
            "drawings/orphan.excalidraw",
            "remote scene",
            "remote-scene-head",
            "",
        ),
    );

    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delete,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc-lineage-unsettled"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "orphan-scene-delete-peer").expect("ack"),
        -1
    );
    let (snapshots, authorities): (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='orphan-scene-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM scene_asset_delete_authorities WHERE workspace_id='ws' \
                     AND version_id='main' AND drawing_object_id='orphan-scene-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("inspect orphan scene");
    assert_eq!((snapshots, authorities), (0, 0));
    assert!(
        dohc_engine_collab::read_marker(&store, &key)
            .expect("read orphan scene marker")
            .is_some(),
        "the unacknowledged delete must preserve the orphan scene"
    );
}

#[test]
fn moment_delete_from_absent_sender_head_preserves_unsettled_lineage() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO file_objects (workspace_id,object_id,created_at_ms) \
                 VALUES ('ws','absent-delete-object',1)",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("seed unsettled object");
    let key = DocKey::new("ws", "main", "absent-delete-object").expect("Y.Doc key");
    let doc = Ydoc::wire();
    let update = doc.plaintext_insert(0, "only durable draft");
    dohc_engine_collab::record_local_update(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &key,
        &update,
        dohc_engine_collab::LocalAppend {
            marker: Some(dohc_engine_collab::MarkerCreation {
                path: Some("notes/absent.md"),
                content_kind: YdocContentKind::Plaintext,
                regime: Regime::LocalOnly,
            }),
            ..Default::default()
        },
        &NoFaults,
        1_500,
        |_tx, _outcome, _update_sha| Ok(()),
    )
    .expect("seed unsettled lineage");
    hydrate_texts(&mut store, &[""]);
    let mut payload = absent_text_payload(
        "moment-delete-absent",
        "absent-delete-object",
        "notes/absent.md",
        "",
    );
    payload["operation"] = json!("delete");
    let delete = envelope("absent-delete-peer", 0, "ws", payload);

    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &delete,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "ydoc-lineage-unsettled"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "absent-delete-peer").expect("ack"),
        -1
    );
    let (moments, updates, docs): (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                     AND moment_id='moment-delete-absent'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='absent-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                     AND version_id='main' AND object_id='absent-delete-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("preserved unsettled lineage");
    assert_eq!((moments, updates, docs), (0, 1, 1));
}

#[test]
fn malformed_moment_append_is_refused_and_acked_before_the_origin_continues() {
    let (_scratch, mut store) = test_store();
    let malformed = envelope("malformed-moment-peer", 0, "ws", json!({}));

    assert_eq!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &malformed,
            &NoFaults,
            &crate::NoLiveLeases
        )
        .expect("malformed per-operation payload is a disposition"),
        ApplyOutcome::new(ApplyDisposition::Refused(ReplicationRefusal {
            workspace_id: "ws".to_owned(),
            origin_id: "malformed-moment-peer".to_owned(),
            origin_seq: 0,
            op_kind: "moment.append".to_owned(),
            reason: RefusalReason::InvalidInput {
                reason: "moment.append payload is malformed".to_owned(),
            },
        })),
        "parsing before apply_envelope_with returns a hard error and leaves seq 0 unacked"
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "malformed-moment-peer").expect("refusal ack"),
        0
    );

    let next = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "malformed-moment-peer".to_owned(),
        origin_seq: 1,
        op_kind: "chat.channel.create".to_owned(),
        payload: json!({
            "channelId": "after-malformed-moment",
            "name": "Still moving",
            "slug": "still-moving",
            "kind": "channel",
            "createdAtMs": 2_001
        }),
        recorded_at_ms: 2_001,
        relay_seq: Some(1),
    };
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &next,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    let channel_rows: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM chat_channels
                 WHERE workspace_id='ws' AND channel_id='after-malformed-moment'",
                [],
                |row| row.get(0),
            )
        })
        .expect("next operation mutation");
    assert_eq!(channel_rows, 1);
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "malformed-moment-peer").expect("next ack"),
        1
    );
}

#[test]
fn moment_append_head_fast_forward_write_delete_and_rename_updates_alias_snapshot_and_search() {
    let (_scratch, mut write_store) = test_store();
    hydrate_texts(&mut write_store, &["written"]);
    let write = envelope(
        "write-peer",
        0,
        "ws",
        absent_text_payload("remote-write", "object-write", "write.md", "written"),
    );
    assert_eq!(
        apply_moment_envelope(&mut write_store, &write, &NoFaults).expect("write"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&write_store, "object-write"),
        Some((
            "write.md".to_owned(),
            "text".to_owned(),
            text_sha("written"),
            "remote-write".to_owned()
        ))
    );
    assert_eq!(aliases(&write_store, "object-write"), ["write.md"]);
    assert_eq!(
        indexed(&write_store, "object-write"),
        [("write.md".to_owned(), "written".to_owned())]
    );

    let (_scratch, mut delete_store) = test_store();
    seed_text_moment(
        &mut delete_store,
        "object-delete",
        "delete.md",
        "gone",
        "local-delete-head",
        None,
        true,
    );
    delete_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-delete','delete.md','gone')",
                [],
            )
        })
        .expect("seed search");
    let delete = envelope(
        "delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "object-delete",
            "delete",
            "delete.md",
            "delete.md",
            "gone",
            "local-delete-head",
            "gone",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut delete_store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&delete_store, "object-delete"), None);
    assert!(aliases(&delete_store, "object-delete").is_empty());
    assert!(indexed(&delete_store, "object-delete").is_empty());

    let (_scratch, mut rename_store) = test_store();
    seed_text_moment(
        &mut rename_store,
        "object-rename",
        "old.md",
        "same",
        "local-rename-head",
        None,
        true,
    );
    rename_store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','object-rename','old.md','same')",
                [],
            )
        })
        .expect("seed search");
    let rename = envelope(
        "rename-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "object-rename",
            "rename",
            "peer-old.md",
            "new.md",
            "same",
            "local-rename-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut rename_store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        aliases(&rename_store, "object-rename"),
        ["new.md"],
        "deleting the payloadBeforePath alias instead of the matched local head path leaves old.md behind beside the new live alias."
    );
    assert_eq!(
        snapshot(&rename_store, "object-rename").unwrap().0,
        "new.md"
    );
    assert_eq!(
        indexed(&rename_store, "object-rename"),
        [("new.md".to_owned(), "same".to_owned())]
    );
}

#[test]
fn moment_append_live_lease_blocks_all_mutations_and_write_waits_for_ydoc_rewrite() {
    for (operation, after_path, after_text) in [
        ("write", "head.md", "changed"),
        ("rename", "renamed.md", "before"),
        ("delete", "head.md", "before"),
    ] {
        let (_scratch, mut store) = test_store();
        let object_id = format!("live-{operation}-object");
        let origin_id = format!("live-{operation}-peer");
        let moment_id = format!("live-{operation}-moment");
        seed_text_moment(
            &mut store,
            &object_id,
            "head.md",
            "before",
            "local-head",
            None,
            true,
        );
        hydrate_texts(&mut store, &[after_text]);
        let key = DocKey::new("ws", "main", &object_id).expect("Y.Doc key");
        let doc = Ydoc::wire();
        let update = doc.plaintext_insert(0, "before");
        dohc_engine_collab::record_local_update(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &key,
            &update,
            dohc_engine_collab::LocalAppend {
                marker: Some(dohc_engine_collab::MarkerCreation {
                    path: Some("head.md"),
                    content_kind: YdocContentKind::Plaintext,
                    regime: Regime::LocalOnly,
                }),
                ..Default::default()
            },
            &NoFaults,
            1_500,
            |_tx, _outcome, _update_sha| Ok(()),
        )
        .expect("seed live lineage");
        let op = envelope(
            &origin_id,
            0,
            "ws",
            present_text_payload(
                &moment_id,
                &object_id,
                operation,
                "head.md",
                after_path,
                "before",
                "local-head",
                after_text,
            ),
        );
        let before = (
            snapshot(&store, &object_id),
            aliases(&store, &object_id),
            indexed(&store, &object_id),
            store
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                })
                .expect("state before live apply"),
        );
        let leases = LeaseRegistry::new();
        let held = leases.acquire(&key).expect("hold document live");

        assert!(matches!(
            apply_replication_envelope(
                &mut store,
                &mut dohc_engine_collab::WriterDocCache::new(),
                &op,
                &NoFaults,
                &leases
            ),
            Err(SyncError::RetryableState {
                reason: "ydoc-session-live"
            })
        ));
        assert_eq!(
            read_replication_acked_seq(&store, "ws", &origin_id).expect("live ack"),
            -1,
            "{operation} must remain unacknowledged while its document is live"
        );
        let after_live = (
            snapshot(&store, &object_id),
            aliases(&store, &object_id),
            indexed(&store, &object_id),
            store
                .read_with(|conn| {
                    Ok::<_, rusqlite::Error>((
                        conn.query_row(
                            "SELECT COUNT(*) FROM moments WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws'",
                            [],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_updates WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM ydoc_docs WHERE workspace_id='ws' \
                             AND version_id='main' AND object_id=?1",
                            [&object_id],
                            |row| row.get::<_, i64>(0),
                        )?,
                    ))
                })
                .expect("state after live apply"),
        );
        assert_eq!(after_live, before, "live {operation} mutated durable state");

        drop(held);
        let closed = apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &leases,
        );
        if operation == "write" {
            assert!(matches!(
                closed,
                Err(SyncError::RetryableState {
                    reason: "ydoc-resulting-head-pending"
                })
            ));
            assert_eq!(
                read_replication_acked_seq(&store, "ws", &origin_id).expect("write ack"),
                -1,
                "the write must wait unacknowledged for its canonical Y.Doc rewrite"
            );
            assert_eq!(
                snapshot(&store, &object_id).unwrap().3,
                "local-head",
                "the premature write must roll back"
            );
            continue;
        }
        assert!(matches!(
            closed,
            Ok(ApplyOutcome {
                primary: ApplyDisposition::Applied(_),
                refusals: ref outcome_refusals,
                sharing_declined: ref outcome_sharing_declined,
            }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
        ));
        match operation {
            "delete" => assert_eq!(snapshot(&store, &object_id), None),
            "rename" => assert_eq!(snapshot(&store, &object_id).unwrap().0, "renamed.md"),
            _ => unreachable!(),
        }
    }
}

#[test]
fn moment_append_content_fast_forward_converges_text_at_the_same_path() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "converged",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-before", "converged"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-head",
            "object",
            "write",
            "same.md",
            "same.md",
            "remote-before",
            "remote-before-head",
            "converged",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("converge"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "remote-head");
    assert!(conflict_ids(&store).is_empty());
}

#[test]
fn moment_append_content_fast_forward_converges_binary_at_the_same_path() {
    let (_scratch, mut store) = test_store();
    let bytes = b"\0same binary\xff";
    let sha = seed_binary_head(&mut store, "binary-object", "same.bin", bytes, "local-bin");
    let payload = json!({
        "momentId": "remote-bin",
        "versionId": "main",
        "objectId": "binary-object",
        "path": "same.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": sha,
        "payloadBeforePath": "same.bin",
        "payloadBeforeContentKind": "binary",
        "payloadBeforeByteLength": bytes.len(),
        "payloadAfterBlobSha256": sha,
        "payloadAfterPath": "same.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": bytes.len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "present",
        "beforeObjectId": "binary-object",
        "beforeVersionId": "main",
        "beforePath": "same.bin",
        "beforeBlobSha256": sha,
        "beforeContentKind": "binary",
        "beforeByteLength": bytes.len(),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": "remote-before-bin",
        "beforeMetadata": {"origin": "api"}
    });
    let op = envelope("peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("binary converge"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    let head = snapshot(&store, "binary-object").unwrap();
    assert_eq!(head.0, "same.bin");
    assert_eq!(head.1, "binary");
    assert_eq!(head.2, sha);
    assert_eq!(head.3, "remote-bin");
    assert!(indexed(&store, "binary-object").is_empty());
}

#[test]
fn moment_append_same_bytes_at_a_different_path_conflicts_instead_of_converging() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "local.md",
        "same bytes",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-before", "same bytes"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-head",
            "object",
            "rename",
            "remote-old.md",
            "remote.md",
            "remote-before",
            "remote-before-head",
            "same bytes",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("diverge"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(snapshot(&store, "object").unwrap().0, "local.md");
    assert_eq!(conflict_ids(&store).len(), 1);
}

#[test]
fn moment_append_content_convergent_adoption_localizes_rollback_but_keeps_wire_payload() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "same.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["remote-old", "agreed"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-adopted",
            "object",
            "write",
            "same.md",
            "same.md",
            "remote-old",
            "remote-old-head",
            "agreed",
        ),
    );
    let wire = op.payload_json().expect("wire json");
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("adopt"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    store
        .read_with(|conn| {
            let before: (String, String, Option<i64>) = conn.query_row(
                "SELECT before_blob_sha256,before_latest_moment_id,sync_record_only \
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(before.0, text_sha("agreed"));
            assert_eq!(before.1, "local-head");
            assert_eq!(before.2, None);
            let journal: String = conn.query_row(
                "SELECT payload_json FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='peer' AND origin_seq=0",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(journal, wire);
            Ok::<_, rusqlite::Error>(())
        })
        .expect("adopted row");
}

#[test]
fn moment_append_both_sides_deleted_is_record_only_and_touches_no_search_state() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["deleted"]);
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO engine_search_files_fts \
                 (workspace_id,version_id,object_id,path,text) \
                 VALUES ('ws','main','deleted-object','deleted.md','stale sentinel')",
                [],
            )
        })
        .expect("search sentinel");
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-delete",
            "deleted-object",
            "delete",
            "deleted.md",
            "deleted.md",
            "deleted",
            "remote-before",
            "deleted",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("both deleted"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(snapshot(&store, "deleted-object"), None);
    assert_eq!(
        indexed(&store, "deleted-object"),
        [("deleted.md".to_owned(), "stale sentinel".to_owned())]
    );
    let record_only: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sync_record_only FROM moments \
                 WHERE workspace_id='ws' AND moment_id='remote-delete'",
                [],
                |row| row.get(0),
            )
        })
        .expect("record-only marker");
    assert_eq!(record_only, 1);
    assert!(conflict_ids(&store).is_empty());
}

#[test]
fn moment_append_divergence_opens_one_duplicate_envelope_skips_and_next_head_coalesces() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(
        &mut store,
        &["base", "payload-before", "remote-one", "remote-two"],
    );
    let mut first_payload = present_text_payload(
        "remote-root",
        "object",
        "write",
        "doc.md",
        "doc.md",
        "base",
        "base-moment",
        "remote-one",
    );
    first_payload["payloadBeforeBlobSha256"] = json!(text_sha("payload-before"));
    first_payload["payloadBeforePath"] = json!("payload-before.md");
    let first = envelope("peer", 0, "ws", first_payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    store
        .read_with(|conn| {
            let base: (i64, String, Option<String>, String, Option<String>) = conn.query_row(
                "SELECT base_exists,base_path,base_object_id,base_blob_sha256,
                        base_latest_moment_id
                 FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(
                base,
                (
                    1,
                    "doc.md".to_owned(),
                    Some("object".to_owned()),
                    text_sha("base"),
                    Some("base-moment".to_owned())
                )
            );
            Ok::<_, rusqlite::Error>(())
        })
        .expect("wire before conflict base");
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("duplicate envelope"),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    let second = envelope(
        "peer",
        1,
        "ws",
        present_text_payload(
            "remote-next",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "remote-one",
            "remote-root",
            "remote-two",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &second, &NoFaults).expect("coalesce"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(conflict_ids(&store).len(), 1);
    let incoming: String = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT incoming_latest_moment_id FROM conflicts WHERE workspace_id='ws'",
                [],
                |row| row.get(0),
            )
        })
        .expect("incoming head");
    assert_eq!(incoming, "remote-next");
}

#[test]
fn moment_append_deterministic_conflict_id_is_identical_when_branch_roots_are_swapped() {
    let (_a, mut left) = test_store();
    let (_b, mut right) = test_store();
    seed_text_lineage(
        &mut left,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "left",
        "left-root",
    );
    seed_text_lineage(
        &mut right,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "right",
        "right-root",
    );
    hydrate_texts(&mut left, &["base", "right"]);
    hydrate_texts(&mut right, &["base", "left"]);
    let right_into_left = envelope(
        "right-peer",
        0,
        "ws",
        present_text_payload(
            "right-root",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "right",
        ),
    );
    let left_into_right = envelope(
        "left-peer",
        0,
        "ws",
        present_text_payload(
            "left-root",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "left",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut left, &right_into_left, &NoFaults).expect("left"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(
        apply_moment_envelope(&mut right, &left_into_right, &NoFaults).expect("right"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(conflict_ids(&left), conflict_ids(&right));
    assert_eq!(conflict_ids(&left).len(), 1);
}

#[test]
fn moment_append_occupancy_divergence_returns_two_distinct_conflicts() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "mover",
        "source.md",
        "base",
        "base-moment",
        "local mover",
        "local-root",
    );
    seed_text_moment(
        &mut store,
        "occupant",
        "destination.md",
        "occupied",
        "occupant-head",
        None,
        true,
    );
    hydrate_texts(&mut store, &["base", "incoming mover"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-move",
            "mover",
            "rename",
            "source.md",
            "destination.md",
            "base",
            "base-moment",
            "incoming mover",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("occupancy"),
        ApplyOutcome::new(ApplyDisposition::Applied(2))
    );
    let ids = conflict_ids(&store);
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    assert_eq!(snapshot(&store, "mover").unwrap().0, "source.md");
    assert_eq!(snapshot(&store, "occupant").unwrap().0, "destination.md");
}

#[test]
fn moment_append_record_only_divergence_is_not_a_head_and_cannot_be_rolled_back() {
    let (_scratch, mut store) = test_store();
    seed_text_lineage(
        &mut store,
        "object",
        "doc.md",
        "base",
        "base-moment",
        "local",
        "local-root",
    );
    hydrate_texts(&mut store, &["base", "remote"]);
    let op = envelope(
        "peer",
        0,
        "ws",
        present_text_payload(
            "remote-record-only",
            "object",
            "write",
            "doc.md",
            "doc.md",
            "base",
            "base-moment",
            "remote",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("diverge"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
    assert_eq!(snapshot(&store, "object").unwrap().3, "local-root");
    let record_only: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT sync_record_only FROM moments \
                 WHERE workspace_id='ws' AND moment_id='remote-record-only'",
                [],
                |row| row.get(0),
            )
        })
        .expect("record-only marker");
    assert_eq!(record_only, 1);
    let error = VersionedTextStore::new(&mut store)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                path: "doc.md".to_owned(),
                mutation_moment_id: "remote-record-only".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect_err("record-only rollback");
    assert_eq!(error.code(), "invalid-input");
}

#[test]
fn moment_append_after_a_shipped_fork_head_rolls_back_after_reopen() {
    let (scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["shipped", "remote edit"]);
    let shipped_sha = text_sha("shipped");
    let version = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "version-peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "feature",
            "name": "Feature",
            "kind": "named",
            "forkVersionId": "main",
            "forkMomentId": "fork-point",
            "createdAtMs": 1_500,
            "forkSnapshots": [{
                "objectId": "shipped-object",
                "objectCreatedAtMs": 1_100,
                "path": "shipped.md",
                "blobSha256": shipped_sha,
                "updatedAtMs": 1_200,
                "latestMomentId": "shipped-head",
                "metadata": {
                    "origin": "sync",
                    "summary": "shipped summary",
                    "correlationId": "shipped correlation"
                }
            }]
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &version,
        &NoFaults,
        &crate::NoLiveLeases,
    )
    .expect("materialize shipped fork");

    let mut payload = present_text_payload(
        "remote-after-shipped",
        "shipped-object",
        "write",
        "shipped.md",
        "shipped.md",
        "shipped",
        "shipped-head",
        "remote edit",
    );
    payload["versionId"] = json!("feature");
    payload["beforeVersionId"] = json!("feature");
    payload["beforeUpdatedAtMs"] = json!(1_200);
    payload["beforeMetadata"] = json!({
        "origin": "sync",
        "summary": "shipped summary",
        "correlationId": "shipped correlation"
    });
    let append = envelope("moment-peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &append, &NoFaults).expect("append after shipped head"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    type StoredPreimage = (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let stored_preimage: StoredPreimage = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT before_object_id, before_version_id, before_path,
                        before_updated_at_ms, before_metadata_origin,
                        before_metadata_summary, before_metadata_correlation_id
                   FROM moments
                  WHERE workspace_id = 'ws' AND moment_id = 'remote-after-shipped'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
        })
        .expect("stored rollback preimage");
    assert_eq!(
        stored_preimage,
        (
            Some("shipped-object".to_owned()),
            Some("feature".to_owned()),
            Some("shipped.md".to_owned()),
            Some(1_200),
            Some("sync".to_owned()),
            Some("shipped summary".to_owned()),
            Some("shipped correlation".to_owned()),
        ),
        "omit any identity/metadata binding from insert_moment and the durable preimage tuple no longer matches the shipped snapshot.",
    );

    let database_path = engine_db_path(&scratch).expect("database path");
    drop(store);
    let mut reopened = EngineStore::open(&database_path, 3_000).expect("reopen");
    VersionedTextStore::new(&mut reopened)
        .rollback_text_file_mutation(
            &RollbackTextFileMutation {
                workspace_id: "ws".to_owned(),
                version_id: "feature".to_owned(),
                path: "shipped.md".to_owned(),
                mutation_moment_id: "remote-after-shipped".to_owned(),
                request_id: None,
                metadata_origin: "restore".to_owned(),
                author_json: None,
            },
            &NoFaults,
        )
        .expect("rollback after reopen");
    let versioned = VersionedTextStore::new(&mut reopened);
    let restored = versioned
        .read_text("ws", "feature", "shipped.md")
        .expect("read restored head")
        .expect("restored head");
    assert_eq!(restored.text, "shipped");
    assert!(restored.latest_moment_id.starts_with("rollback-"));
    let compensation = versioned
        .get_moment("ws", &restored.latest_moment_id)
        .expect("read compensating moment")
        .expect("compensating moment");
    assert_eq!(compensation.operation, MomentOp::Write);
    assert_eq!(
        compensation.before_latest_moment_id.as_deref(),
        Some("remote-after-shipped")
    );
    assert_eq!(restored.updated_at_ms, 1_200);
    assert_eq!(restored.metadata_origin, "restore");
    assert_eq!(restored.metadata_summary, None);
    assert_eq!(restored.metadata_correlation_id, None);
}

#[test]
fn moment_append_first_delivery_refuses_and_acks_plaintext_id_collision_but_redelivery_skips() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["first"]);
    let first = envelope(
        "first-peer",
        0,
        "ws",
        absent_text_payload("shared-moment", "object", "doc.md", "first"),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("first"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &first, &NoFaults).expect("redelivery"),
        ApplyOutcome::new(ApplyDisposition::Skipped)
    );
    let duplicate_id = envelope(
        "second-peer",
        0,
        "ws",
        absent_text_payload(
            "shared-moment",
            "other-object",
            "other.md",
            "missing blob is never hydrated",
        ),
    );
    assert!(
        matches!(
            apply_moment_envelope(&mut store, &duplicate_id, &NoFaults),
            Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { ref reason },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "replicated plaintext moment id collides with existing history")
        ),
        "treating a same-table ID hit as idempotence lets this unrelated first-delivery coordinate claim another moment; true replay was already skipped above before entering the moment applier."
    );
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "second-peer").expect("ack"),
        0
    );
    let journal_count: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND op_kind='moment.append'",
                [],
                |row| row.get(0),
            )
        })
        .expect("journal count");
    assert_eq!(journal_count, 2);
}

#[test]
fn redelivered_moment_uses_the_durable_apply_time_materialization_decision() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["incoming"]);
    VersionedTextStore::new(&mut store)
        .create_named_version(
            &CreateNamedVersion {
                workspace_id: "ws".to_owned(),
                new_version_id: "feature".to_owned(),
                name: "Feature".to_owned(),
                from_version_id: "main".to_owned(),
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("feature version");
    let incoming = envelope(
        "materialization-peer",
        0,
        "ws",
        absent_text_payload(
            "materialization-moment",
            "materialization-object",
            "active-at-apply.md",
            "incoming",
        ),
    );
    let first = apply_replication_envelope(
        &mut store,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &incoming,
        &NoFaults,
        &crate::NoLiveLeases,
    )
    .expect("apply active moment");
    assert_eq!(
        first,
        ApplyOutcome::new(ApplyDisposition::Applied(crate::RoutedApply {
            conflict: None,
            conflicts_opened: 0,
            materialization_changes: vec![crate::MomentMaterializationChange {
                version_id: "main".to_owned(),
                path: "active-at-apply.md".to_owned(),
                operation: "write",
                content_kind: "text",
            }],
            record_facts: Vec::new(),
        }))
    );
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO active_versions (workspace_id,version_id) VALUES ('ws','feature') \
                 ON CONFLICT(workspace_id) DO UPDATE SET version_id=excluded.version_id",
                [],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .expect("switch active version after apply");
    assert_eq!(
        crate::moment_apply::redelivered_materialization_changes(&store, &incoming)
            .expect("read durable decision"),
        [crate::MomentMaterializationChange {
            version_id: "main".to_owned(),
            path: "active-at-apply.md".to_owned(),
            operation: "write",
            content_kind: "text",
        }],
        "re-deriving from the live active version loses the apply-time disk change"
    );
}

#[test]
fn moment_append_refuses_and_acks_id_collision_with_secret_history() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["incoming"]);
    store
        .read_with(|tx| {
            tx.execute(
                "INSERT INTO secret_moments \
                 (workspace_id,moment_order,moment_id,version_id,path,recorded_at_ms, \
                  operation,metadata_origin,after_present) \
                 VALUES ('ws',1,'protected-id','main','app.env',100,'delete','api',0)",
                [],
            )
        })
        .expect("seed protected collision");
    let op = envelope(
        "plaintext-collision-peer",
        0,
        "ws",
        absent_text_payload("protected-id", "plaintext-object", "doc.md", "incoming"),
    );

    assert!(
        matches!(
            apply_moment_envelope(&mut store, &op, &NoFaults),
            Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                reason: RefusalReason::InvalidInput { ref reason },
                ..
            }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "replicated plaintext moment id collides with existing history")
        ),
        "removing the secret_moments arm lets two unrelated histories claim the same workspace-wide moment identity."
    );
    let rows: (i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' AND moment_id='protected-id'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM secret_moments \
                     WHERE workspace_id='ws' AND moment_id='protected-id'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("collision state");
    assert_eq!(rows, (0, 1));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "plaintext-collision-peer").expect("ack"),
        0
    );
}

#[test]
fn moment_append_accepts_only_oracle_metadata_origins_and_acks_refusals() {
    let (_scratch, mut accepted_store) = test_store();
    hydrate_texts(&mut accepted_store, &["accepted"]);
    for (index, origin) in ["api", "local-file", "restore", "sync", "unknown"]
        .into_iter()
        .enumerate()
    {
        let mut payload = absent_text_payload(
            &format!("accepted-{index}"),
            &format!("accepted-object-{index}"),
            &format!("accepted-{index}.md"),
            "accepted",
        );
        payload["metadata"]["origin"] = json!(origin);
        let op = envelope(&format!("accepted-peer-{index}"), 0, "ws", payload);
        assert_eq!(
            apply_moment_envelope(&mut accepted_store, &op, &NoFaults)
                .expect("oracle origin must apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0)),
            "{origin}"
        );
    }

    for (field, reserved) in [
        ("metadata", "capture"),
        ("metadata", "ydoc"),
        ("beforeMetadata", "capture"),
        ("beforeMetadata", "ydoc"),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["before", "after"]);
        let mut payload = present_text_payload(
            "reserved-origin",
            "reserved-object",
            "write",
            "reserved.md",
            "reserved.md",
            "before",
            "remote-before",
            "after",
        );
        payload[field]["origin"] = json!(reserved);
        let peer = format!("{field}-{reserved}-peer");
        let op = envelope(&peer, 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome { primary: ApplyDisposition::Refused(ReplicationRefusal {
                    reason: RefusalReason::InvalidInput { ref reason },
                    ..
                }), refusals: ref outcome_refusals, sharing_declined: ref outcome_sharing_declined, }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty() && (reason == "moment.append payload is invalid")
            ),
            "an empty-only check accepts capture/ydoc ownership markers and can make the local capture reconciler claim replicated content."
        );
        let persisted: (i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments \
                         WHERE workspace_id='ws' AND moment_id='reserved-origin'",
                        [],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots \
                         WHERE workspace_id='ws' AND object_id='reserved-object'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("reserved origin state");
        assert_eq!(persisted, (0, 0), "{field}={reserved}");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", &peer).expect("ack"),
            0,
            "{field}={reserved}"
        );
    }
}

#[test]
fn moment_append_requires_version_create_ordering_and_never_acks_a_missing_target() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let mut payload = absent_text_payload("moment", "object", "doc.md", "content");
    payload["versionId"] = json!("missing");
    let op = envelope("peer", 0, "ws", payload);
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Err(SyncError::RetryableState {
            reason: "moment.append target version is missing"
        })
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
    let journaled: i64 = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM replication_log \
                 WHERE workspace_id='ws' AND origin_id='peer'",
                [],
                |row| row.get(0),
            )
        })
        .expect("missing-version journal count");
    assert_eq!(
        journaled, 0,
        "journaling the retryable failure permanently consumes the missing-version coordinate"
    );

    let version = ReplicationEnvelope {
        workspace_id: "ws".to_owned(),
        origin_id: "version-peer".to_owned(),
        origin_seq: 0,
        op_kind: "version.create".to_owned(),
        payload: json!({
            "versionId": "missing",
            "name": "Missing",
            "kind": "named",
            "forkVersionId": null,
            "forkMomentId": null,
            "createdAtMs": 1_500,
            "forkSnapshots": []
        }),
        recorded_at_ms: 1_500,
        relay_seq: Some(0),
    };
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &version,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert!(matches!(
        apply_replication_envelope(
            &mut store,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &op,
            &NoFaults,
            &crate::NoLiveLeases
        ),
        Ok(ApplyOutcome {
            primary: ApplyDisposition::Applied(_),
            refusals: ref outcome_refusals,
            sharing_declined: ref outcome_sharing_declined,
        }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("retry ack"),
        0
    );
}

#[test]
fn moment_append_refuses_non_tracked_or_noncanonical_paths_without_rows_and_acks() {
    let mut secret_after = absent_text_payload(
        "secret-after",
        "secret-after-object",
        "docs/safe.md",
        "content",
    );
    secret_after["payloadAfterPath"] = json!("app/.env");

    let mut noncanonical_path = absent_text_payload(
        "noncanonical-path",
        "noncanonical-path-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_path["path"] = json!("a//b.md");

    let mut noncanonical_after = absent_text_payload(
        "noncanonical-after",
        "noncanonical-after-object",
        "docs/safe.md",
        "content",
    );
    noncanonical_after["payloadAfterPath"] = json!("a//b.md");

    let mut secret_before = absent_text_payload(
        "secret-before",
        "secret-before-object",
        "docs/new.md",
        "content",
    );
    secret_before["payloadBeforePath"] = json!("app/.env");
    secret_before["payloadBeforeBlobSha256"] = json!(text_sha("content"));

    let mut secret_before_snapshot = present_text_payload(
        "secret-before-snapshot",
        "secret-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    secret_before_snapshot["beforePath"] = json!("app/.env");

    let mut noncanonical_before_snapshot = present_text_payload(
        "noncanonical-before-snapshot",
        "noncanonical-before-snapshot-object",
        "write",
        "docs/safe.md",
        "docs/safe.md",
        "content",
        "remote-base",
        "content",
    );
    noncanonical_before_snapshot["beforePath"] = json!("a//b.md");

    for (case, payload, object_id) in [
        (
            "secret payloadAfterPath",
            secret_after,
            "secret-after-object",
        ),
        (
            "noncanonical path",
            noncanonical_path,
            "noncanonical-path-object",
        ),
        (
            "noncanonical payloadAfterPath",
            noncanonical_after,
            "noncanonical-after-object",
        ),
        (
            "secret payloadBeforePath",
            secret_before,
            "secret-before-object",
        ),
        (
            "secret beforePath",
            secret_before_snapshot,
            "secret-before-snapshot-object",
        ),
        (
            "noncanonical beforePath",
            noncanonical_before_snapshot,
            "noncanonical-before-snapshot-object",
        ),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let op = envelope("peer", 0, "ws", payload);
        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{case} must be refused"
        );
        let persisted: (i64, i64, i64) = store
            .read_with(|conn| {
                Ok::<_, rusqlite::Error>((
                    conn.query_row(
                        "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id=?1",
                        [object_id],
                        |row| row.get(0),
                    )?,
                ))
            })
            .expect("rejected path leaves no rows");
        assert_eq!(persisted, (0, 0, 0), "{case} persisted poisoned rows");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
            0,
            "{case} did not advance the peer ack"
        );
    }

    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["content"]);
    let canonical = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "canonical",
            "canonical-object",
            "docs/canonical.md",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical, &NoFaults).expect("canonical tracked path"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        snapshot(&store, "canonical-object").unwrap().0,
        "docs/canonical.md"
    );
    assert_eq!(
        aliases(&store, "canonical-object"),
        ["docs/canonical.md".to_owned()]
    );

    let canonical_before = envelope(
        "canonical-before-peer",
        0,
        "ws",
        present_text_payload(
            "canonical-before",
            "canonical-before-object",
            "write",
            "docs/canonical-before.md",
            "docs/canonical-after.md",
            "content",
            "remote-base",
            "content",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &canonical_before, &NoFaults)
            .expect("canonical tracked beforePath"),
        ApplyOutcome::new(ApplyDisposition::Applied(1))
    );
}

#[test]
fn moment_append_persists_full_wire_payload_provenance() {
    let (_scratch, mut store) = test_store();
    seed_text_moment(
        &mut store,
        "object",
        "docs/new.md",
        "agreed",
        "local-head",
        None,
        true,
    );
    let remote_before = b"\0remote binary preimage\xff";
    let remote_before_sha = store
        .read_with(|conn| put_binary_blob(conn, remote_before))
        .expect("remote before blob");
    let after_sha = text_sha("agreed");
    let payload = json!({
        "momentId": "remote-adopted",
        "versionId": "main",
        "objectId": "object",
        "objectCreatedAtMs": 1,
        "path": "remote/old.bin",
        "recordedAtMs": 2_000,
        "operation": "rename",
        "payloadBeforeBlobSha256": remote_before_sha,
        "payloadBeforePath": "remote/old.bin",
        "payloadBeforeContentKind": "binary",
        "payloadBeforeByteLength": remote_before.len(),
        "payloadAfterBlobSha256": after_sha,
        "payloadAfterPath": "docs/new.md",
        "payloadAfterContentKind": "text",
        "payloadAfterByteLength": "agreed".len(),
        "metadata": {
            "origin": "sync",
            "summary": "adopted from peer",
            "correlationId": "correlation-remote-adopted"
        },
        "beforePresent": "present",
        "beforeObjectId": "object",
        "beforeVersionId": "main",
        "beforePath": "remote/old.bin",
        "beforeBlobSha256": remote_before_sha,
        "beforeContentKind": "binary",
        "beforeByteLength": remote_before.len(),
        "beforeUpdatedAtMs": 100,
        "beforeLatestMomentId": "remote-before",
        "beforeMetadata": {"origin": "api"}
    });
    let op = envelope("peer", 0, "ws", payload);
    assert_eq!(
        apply_moment_envelope(&mut store, &op, &NoFaults).expect("content-convergent adoption"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );

    let provenance = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT payload_before_path,payload_before_content_kind,
                        payload_before_blob_sha256,payload_after_path,
                        payload_after_content_kind,payload_after_blob_sha256
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
        })
        .expect("payload provenance");
    assert_eq!(
        provenance,
        (
            Some("remote/old.bin".to_owned()),
            Some("binary".to_owned()),
            Some(remote_before_sha),
            Some("docs/new.md".to_owned()),
            Some("text".to_owned()),
            Some(after_sha),
        )
    );

    let metadata = store
        .read_with(|conn| {
            let moment = conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM moments WHERE workspace_id='ws' AND moment_id='remote-adopted'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            let snapshot = conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM snapshots WHERE workspace_id='ws' AND object_id='object'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?;
            Ok::<_, rusqlite::Error>((moment, snapshot))
        })
        .expect("replicated metadata");
    let expected = (
        "sync".to_owned(),
        Some("adopted from peer".to_owned()),
        Some("correlation-remote-adopted".to_owned()),
    );
    assert_eq!(
        metadata,
        (expected.clone(), expected),
        "dropping either optional field from the moment or snapshot insert makes one side of this round trip differ."
    );

    let versioned = VersionedTextStore::new(&mut store);
    let page = versioned
        .list_moments(&ListMomentsQuery {
            workspace_id: "ws".to_owned(),
            version_id: Some("main".to_owned()),
            object_id: Some("object".to_owned()),
            limit: 10,
            before_moment_order: None,
        })
        .expect("moment read model");
    let moment = page.moments.first().expect("imported moment");
    assert_eq!(
        moment.metadata_summary.as_deref(),
        Some("adopted from peer")
    );
    assert_eq!(
        moment.metadata_correlation_id.as_deref(),
        Some("correlation-remote-adopted")
    );
    let snapshot = versioned
        .read_text("ws", "main", "docs/new.md")
        .expect("snapshot read model")
        .expect("imported snapshot");
    assert_eq!(
        snapshot.metadata_summary.as_deref(),
        Some("adopted from peer")
    );
    assert_eq!(
        snapshot.metadata_correlation_id.as_deref(),
        Some("correlation-remote-adopted")
    );
    let listed = versioned
        .list_snapshot_metadata("ws", "main", None, 10)
        .expect("snapshot list read model");
    assert_eq!(
        listed[0].metadata_summary.as_deref(),
        Some("adopted from peer")
    );
    assert_eq!(
        listed[0].metadata_correlation_id.as_deref(),
        Some("correlation-remote-adopted")
    );
}

#[test]
fn local_overwrite_clears_imported_snapshot_metadata() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["imported", "local"]);
    let mut payload = absent_text_payload(
        "imported-head",
        "metadata-object",
        "metadata.md",
        "imported",
    );
    payload["metadata"] = json!({
        "origin": "sync",
        "summary": "peer summary",
        "correlationId": "peer correlation"
    });
    apply_moment_envelope(
        &mut store,
        &envelope("metadata-peer", 0, "ws", payload),
        &NoFaults,
    )
    .expect("import metadata");

    VersionedTextStore::new(&mut store)
        .write_text(
            &WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "metadata-object".to_owned(),
                path: "metadata.md".to_owned(),
                text: "local".to_owned(),
                moment_id: "local-head".to_owned(),
                metadata_origin: "api".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("local overwrite");

    let metadata = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT metadata_origin,metadata_summary,metadata_correlation_id \
                 FROM snapshots WHERE workspace_id='ws' AND version_id='main' \
                 AND object_id='metadata-object'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
        })
        .expect("local snapshot metadata");
    assert_eq!(
        metadata,
        ("api".to_owned(), None, None),
        "omitting either optional metadata assignment from the local upsert leaves the imported value attached to the newer local head."
    );
}

#[test]
fn moment_append_search_index_respects_files_and_visibility_policy() {
    let (scratch, mut store) = test_store();
    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "[[rule]]\npath = \"private/**\"\nsearchable = false\n",
    )
    .expect("files policy");
    std::fs::write(
        scratch.path().join(".dohc/visibility.toml"),
        "[[rule]]\npath = \"hidden/**\"\nvisibility = \"hidden\"\n",
    )
    .expect("visibility policy");
    hydrate_texts(
        &mut store,
        &["private needle", "hidden needle", "public needle"],
    );

    for (origin, moment_id, object_id, path, text) in [
        (
            "private-peer",
            "private-moment",
            "private-object",
            "private/doc.md",
            "private needle",
        ),
        (
            "hidden-peer",
            "hidden-moment",
            "hidden-object",
            "hidden/doc.md",
            "hidden needle",
        ),
        (
            "public-peer",
            "public-moment",
            "public-object",
            "public/doc.md",
            "public needle",
        ),
    ] {
        let op = envelope(
            origin,
            0,
            "ws",
            absent_text_payload(moment_id, object_id, path, text),
        );
        assert_eq!(
            apply_moment_envelope(&mut store, &op, &NoFaults).expect("policy-aware apply"),
            ApplyOutcome::new(ApplyDisposition::Applied(0))
        );
    }

    assert!(
        indexed(&store, "private-object").is_empty(),
        "removing or inverting either policy predicate indexes one of the excluded rows; skipping the healthy insert loses the public row."
    );
    assert!(indexed(&store, "hidden-object").is_empty());
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );

    std::fs::write(
        scratch.path().join(".dohc/files.toml"),
        "rule = \"not-an-array\"\n",
    )
    .expect("degraded files policy");
    hydrate_texts(&mut store, &["updated needle"]);
    let degraded = envelope(
        "public-peer",
        1,
        "ws",
        present_text_payload(
            "public-degraded-moment",
            "public-object",
            "write",
            "public/doc.md",
            "public/doc.md",
            "public needle",
            "public-moment",
            "updated needle",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &degraded, &NoFaults).expect("degraded-policy apply"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    // A degraded policy freezes FILE indexing: the prior row remains until a
    // healthy policy can safely decide whether to replace or remove it.
    assert_eq!(
        indexed(&store, "public-object"),
        [("public/doc.md".to_owned(), "public needle".to_owned())]
    );
}

#[test]
fn moment_append_refuses_each_incomplete_payload_before_tuple_without_rows_and_acks() {
    for (case, before_path, before_sha) in [
        ("path only", Some("doc.md"), None),
        ("digest only", None, Some(text_sha("before"))),
    ] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["before", "after"]);
        let mut payload = absent_text_payload("tuple-moment", "tuple-object", "doc.md", "after");
        payload["payloadBeforePath"] = before_path.map_or(Value::Null, |path| json!(path));
        payload["payloadBeforeBlobSha256"] = before_sha.map_or(Value::Null, |sha| json!(sha));
        let op = envelope("tuple-peer", 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "{case} must be refused"
        );
        let rows: i64 = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' \
                     AND object_id='tuple-object'",
                    [],
                    |row| row.get(0),
                )
            })
            .expect("moment count");
        assert_eq!(rows, 0, "{case} mutated moment history");
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "tuple-peer").expect("ack"),
            0,
            "{case} did not advance the peer ack"
        );
    }
}

#[test]
fn replicated_delete_after_path_divergent_rename_removes_the_live_alias() {
    let (_scratch, mut store) = test_store();
    hydrate_texts(&mut store, &["same"]);
    seed_text_moment(
        &mut store,
        "rename-delete-object",
        "old.md",
        "same",
        "local-head",
        None,
        true,
    );
    let rename = envelope(
        "rename-delete-peer",
        0,
        "ws",
        present_text_payload(
            "remote-rename",
            "rename-delete-object",
            "rename",
            "old.md",
            "new.md",
            "same",
            "local-head",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &rename, &NoFaults).expect("rename"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert_eq!(
        aliases(&store, "rename-delete-object"),
        ["new.md".to_owned()]
    );

    let delete = envelope(
        "rename-delete-peer",
        1,
        "ws",
        present_text_payload(
            "remote-delete",
            "rename-delete-object",
            "delete",
            "old.md",
            "old.md",
            "same",
            "remote-rename",
            "same",
        ),
    );
    assert_eq!(
        apply_moment_envelope(&mut store, &delete, &NoFaults).expect("delete"),
        ApplyOutcome::new(ApplyDisposition::Applied(0))
    );
    assert!(
        aliases(&store, "rename-delete-object").is_empty(),
        "deleting by the remote payload path leaves `new.md` behind."
    );
    assert_eq!(snapshot(&store, "rename-delete-object"), None);
}

#[test]
fn moment_append_refuses_overlong_moment_and_object_ids_with_ack() {
    for (case, field) in [("moment id", "momentId"), ("object id", "objectId")] {
        let (_scratch, mut store) = test_store();
        hydrate_texts(&mut store, &["content"]);
        let mut payload =
            absent_text_payload("bounded-moment", "bounded-object", "doc.md", "content");
        payload[field] = json!("x".repeat(crate::model::MAX_IDENTIFIER_BYTES + 1));
        let op = envelope("bounded-peer", 0, "ws", payload);

        assert!(
            matches!(
                apply_moment_envelope(&mut store, &op, &NoFaults),
                Ok(ApplyOutcome {
                    primary: ApplyDisposition::Refused(ReplicationRefusal {
                        reason: RefusalReason::InvalidInput { .. },
                        ..
                    }),
                    refusals: ref outcome_refusals,
                    sharing_declined: ref outcome_sharing_declined,
                }) if outcome_refusals.is_empty() && outcome_sharing_declined.is_empty()
            ),
            "overlong {case} must be refused"
        );
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "bounded-peer").expect("ack"),
            0,
            "overlong {case} must not wedge the origin"
        );
    }
}

#[test]
fn moment_append_rejects_a_poisoned_binary_blob_as_storage_corruption_before_mutation() {
    let (_scratch, mut store) = test_store();
    let claimed = hex_sha256(b"honest binary");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES (?1,?2,?3)",
                params![claimed, b"poisoned".len() as i64, b"poisoned".as_slice()],
            )
        })
        .expect("poison binary blob");
    let payload = json!({
        "momentId": "binary-moment",
        "versionId": "main",
        "objectId": "binary-object",
        "objectCreatedAtMs": 1,
        "path": "assets/file.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": claimed,
        "payloadAfterPath": "assets/file.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": b"honest binary".len(),
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("poisoned binary blob must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::BlobIntegrity { .. })
        ),
        "local blob corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments WHERE workspace_id='ws' AND moment_id='binary-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases WHERE workspace_id='ws' AND object_id='binary-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed binary apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_require_blob_text_rejects_a_poisoned_address_before_ack() {
    let (_scratch, mut store) = test_store();
    let claimed = text_sha("honest");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,'poisoned')",
                params![claimed, "poisoned".len() as i64],
            )
        })
        .expect("poison blob");
    let op = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload("moment", "object", "doc.md", "honest"),
    );
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::BlobInvalid)
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_a_corrupt_text_blob_length_before_mutation_and_ack() {
    let (_scratch, mut store) = test_store();
    let claimed = text_sha("honest");
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO blobs (sha256,byte_length,text) VALUES (?1,?2,'honest')",
                params![claimed, "honest".len() as i64 + 1],
            )
        })
        .expect("poison blob length");
    let op = envelope(
        "peer",
        0,
        "ws",
        absent_text_payload(
            "corrupt-length-moment",
            "corrupt-length-object",
            "doc.md",
            "honest",
        ),
    );
    let error = apply_moment_envelope(&mut store, &op, &NoFaults)
        .expect_err("corrupt text blob length must fail closed");
    assert!(
        matches!(
            error,
            SyncError::Storage(dohc_engine_storage::StorageError::StateCorrupt { .. })
        ),
        "local length corruption must remain a hard storage error, got {error:?}"
    );
    let persisted: (i64, i64, i64) = store
        .read_with(|conn| {
            Ok::<_, rusqlite::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM moments \
                     WHERE workspace_id='ws' AND moment_id='corrupt-length-moment'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM snapshots \
                     WHERE workspace_id='ws' AND object_id='corrupt-length-object'",
                    [],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM path_aliases \
                     WHERE workspace_id='ws' AND object_id='corrupt-length-object'",
                    [],
                    |row| row.get(0),
                )?,
            ))
        })
        .expect("failed text apply leaves no rows");
    assert_eq!(persisted, (0, 0, 0));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}

#[test]
fn moment_append_rejects_an_empty_binary_digest_as_storage_corruption_even_if_hydrated() {
    let (_scratch, mut store) = test_store();
    store
        .read_with(|conn| {
            conn.execute(
                "INSERT INTO binary_blobs (sha256,byte_length,bytes) VALUES ('',0,X'')",
                [],
            )
        })
        .expect("empty-key binary row");
    let payload = json!({
        "momentId": "bad-binary",
        "versionId": "main",
        "objectId": "binary-object",
        "path": "bad.bin",
        "recordedAtMs": 2_000,
        "operation": "write",
        "payloadBeforeBlobSha256": null,
        "payloadBeforePath": null,
        "payloadAfterBlobSha256": "",
        "payloadAfterPath": "bad.bin",
        "payloadAfterContentKind": "binary",
        "payloadAfterByteLength": 0,
        "metadata": {"origin": "sync"},
        "beforePresent": "absent"
    });
    let op = envelope("peer", 0, "ws", payload);
    assert!(matches!(
        apply_moment_envelope(&mut store, &op, &NoFaults),
        Err(SyncError::Storage(
            dohc_engine_storage::StorageError::BlobIntegrity { .. }
        ))
    ));
    assert_eq!(
        read_replication_acked_seq(&store, "ws", "peer").expect("ack"),
        -1
    );
}
