use super::share_proposal::{
    journal_local_moment, local_moment_payload, proposal_fixture, proposal_grant,
};
use super::*;
use dohc_engine_storage::hex_sha256;

// ---------------------------------------------------------------------------
// The recipient writes a Collection's own files directly (ADR 0013).
// ---------------------------------------------------------------------------

const SHARE: &str = "share-direct";

fn edit_grant() -> ShareGrant {
    proposal_grant(crate::ShareAccess::Edit)
}

fn push(
    client: &RelaySyncClient<PagedShareRelay>,
    engine: &mut EngineStore,
) -> DirectWritePushOutcome {
    client
        .push_direct_writes(engine, "ws", SHARE, &edit_grant(), &NoFaults, 0)
        .expect("direct push")
}

fn propose(
    client: &RelaySyncClient<PagedShareRelay>,
    engine: &mut EngineStore,
    submit_id: &str,
) -> ShareProposalSubmitOutcome {
    client
        .submit_share_proposal(engine, "ws", SHARE, &edit_grant(), submit_id, &NoFaults, 0)
        .expect("proposal submit")
}

fn written_paths(client: &RelaySyncClient<PagedShareRelay>) -> Vec<Vec<String>> {
    client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .iter()
        .map(|write| {
            write
                .changes
                .iter()
                .filter_map(|change| change.after_path.clone())
                .collect()
        })
        .collect()
}

fn proposed_paths(client: &RelaySyncClient<PagedShareRelay>) -> Vec<String> {
    client
        .transport()
        .proposal_submits
        .lock()
        .expect("submits")
        .iter()
        .flat_map(|submit| submit.ops.iter())
        .filter_map(|op| op.after_path.clone())
        .collect()
}

fn edit_moment(
    moment: &str,
    object: &str,
    path: &str,
    before: &str,
    after: &str,
) -> serde_json::Value {
    local_moment_payload(moment, object, "write", Some((path, before)), path, after)
}

fn create_moment(moment: &str, object: &str, path: &str, text: &str) -> serde_json::Value {
    local_moment_payload(moment, object, "write", None, path, text)
}

/// A schema this replica holds on main, as a pulled file would be.
fn hold_schema(engine: &mut EngineStore, folder: &str) {
    VersionedTextStore::new(engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: format!("pulled-{folder}"),
                path: format!("{folder}/collection.yaml"),
                text: "fields: {}\n".to_owned(),
                moment_id: format!("pulled-moment-{folder}"),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_500,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("pulled schema");
}

fn save_status_file(engine: &mut EngineStore, moment: &str, text: &str, before: Option<&str>) {
    let path = "shared/docs/packing/automations.yaml";
    let object_id = VersionedTextStore::new(engine)
        .read_text("ws", "main", path)
        .expect("current status file")
        .map(|snapshot| snapshot.object_id)
        .unwrap_or_else(|| "status-file".to_owned());
    VersionedTextStore::new(engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: object_id.clone(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: moment.to_owned(),
                metadata_origin: "local-file".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("save status file");
    let payload = local_moment_payload(
        moment,
        &object_id,
        "write",
        before.map(|text| (path, text)),
        path,
        text,
    );
    journal_local_moment(engine, &payload, 2_000);
}

fn delivery_status(engine: &EngineStore) -> DirectWriteStatus {
    read_direct_write_status(
        engine,
        "ws",
        SHARE,
        "shared/docs/packing/automations.yaml",
        &edit_grant(),
    )
    .expect("status")
}

#[test]
fn record_creation_is_durable_offline_and_retries_the_same_submission_after_restart() {
    let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n";
    let path = "shared/docs/packing/One.md";
    let (_scratch, db, mut engine) = proposal_fixture(&[text]);
    hold_schema(&mut engine, "shared/docs/packing");
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "record-one".to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: "create-one".to_owned(),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("record draft");
    journal_local_moment(
        &mut engine,
        &create_moment("create-one", "record-one", path, text),
        2_000,
    );
    let statuses = |store: &EngineStore| {
        read_record_creation_statuses(store, "ws", SHARE, &[path.to_owned()], &edit_grant())
            .unwrap()
    };
    assert_eq!(statuses(&engine)[path].state, DirectWriteState::Pending);
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .unwrap()
        .push_back(Err(RelayError::Partitioned));
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::Partitioned)
    );
    drop(engine);
    let mut engine = EngineStore::open(&db, 0).expect("restart");
    assert_eq!(statuses(&engine)[path].state, DirectWriteState::Pending);
    assert!(
        !statuses(&engine)[path].can_discard,
        "resolve the same submission before offering discard"
    );
    push(&client, &mut engine);
    let writes = client.transport().collection_writes.lock().unwrap();
    assert_eq!(writes.len(), 2);
    assert_eq!(writes[0], writes[1]);
    drop(writes);
    assert_eq!(statuses(&engine)[path].state, DirectWriteState::Accepted);
    assert!(
        !statuses(&engine)[path].can_discard,
        "an accepted record is deleted normally"
    );
    assert!(push(&client, &mut engine).writes.is_empty());
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", path)
            .unwrap()
            .unwrap()
            .text,
        text
    );
    let repaired = "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n";
    let sha = hex_sha256(repaired.as_bytes());
    let owner = RelaySyncClient::new(PagedShareRelay::new([], [(0, ShareViewResponse {
        ops: vec![ShareReplicationEnvelope {
            origin_id: "owner-adoption".to_owned(), origin_seq: 0, op_kind: "moment.append".to_owned(), recorded_at_ms: 3_000,
            payload: json!({ "versionId": "main", "operation": "write", "path": path,
                "payloadAfterPath": path, "payloadAfterBlobSha256": sha, "payloadAfterContentKind": "text" }),
        }], next_cursor: 1, has_more: false,
    })]).with_view_blobs([(sha.clone(), repaired.as_bytes().to_vec())]));
    assert_eq!(
        owner
            .pull_share_view(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults)
            .unwrap()
            .applied,
        1
    );
    assert_eq!(
        VersionedTextStore::new(&mut engine)
            .read_text("ws", "main", path)
            .unwrap()
            .unwrap()
            .text,
        repaired
    );
    assert!(
        statuses(&engine).is_empty(),
        "owner adoption ends creation status when it assigns a different record ID"
    );
}

#[test]
fn a_discarded_record_draft_is_not_sent_when_the_open_plan_retries() {
    let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n";
    let path = "shared/docs/packing/One.md";
    let (_scratch, db, mut engine) = proposal_fixture(&[text]);
    hold_schema(&mut engine, "shared/docs/packing");
    journal_local_moment(
        &mut engine,
        &create_moment("create", "record", path, text),
        2_000,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .unwrap()
        .push_back(Err(RelayError::Partitioned));
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::Partitioned)
    );
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "discard",
            "record",
            "delete",
            Some((path, text)),
            path,
            text,
        ),
        2_001,
    );
    drop(engine);
    let mut engine = EngineStore::open(&db, 0).unwrap();
    assert_eq!(
        push(&client, &mut engine).writes[0].result,
        DirectWriteResult::Refused {
            reason: "local-record-draft-discarded".to_owned()
        }
    );
    assert_eq!(
        client.transport().collection_writes.lock().unwrap().len(),
        1
    );
    assert!(push(&client, &mut engine).writes.is_empty());
}

#[test]
fn record_creation_needs_a_document_collection_and_cannot_edit_an_existing_record() {
    let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\n";
    let (_scratch, _db, mut engine) = proposal_fixture(&[text, "edit"]);
    hold_schema(&mut engine, "shared/docs/packing");
    for (index, path) in ["shared/docs/packing/One.md", "shared/docs/plain/One.md"]
        .iter()
        .enumerate()
    {
        journal_local_moment(
            &mut engine,
            &create_moment(
                &format!("create-{index}"),
                &format!("record-{index}"),
                path,
                text,
            ),
            2_000,
        );
    }
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec!["shared/docs/packing/One.md".to_owned()]]
    );
    journal_local_moment(
        &mut engine,
        &edit_moment(
            "edit-one",
            "record-0",
            "shared/docs/packing/One.md",
            text,
            "edit",
        ),
        3_000,
    );
    assert!(push(&client, &mut engine).writes.is_empty());
    propose(&client, &mut engine, "proposal");
    let paths = proposed_paths(&client);
    assert!(paths.contains(&"shared/docs/packing/One.md".to_owned()));
    assert!(paths.contains(&"shared/docs/plain/One.md".to_owned()));
}

#[test]
fn direct_status_accepts_real_share_pull_heads_on_both_replicas() {
    let path = "shared/docs/packing/automations.yaml";
    let text = "version: 1\nautomations: []\n";
    let sha = hex_sha256(text.as_bytes());
    for _host in ["desktop", "server"] {
        let (_scratch, _db, mut engine) = proposal_fixture(&[]);
        let client = RelaySyncClient::new(
            PagedShareRelay::new([], [(0, ShareViewResponse {
                ops: vec![ShareReplicationEnvelope {
                    origin_id: "owner".to_owned(), origin_seq: 0,
                    op_kind: "moment.append".to_owned(), recorded_at_ms: 2_000,
                    payload: json!({ "versionId": "main", "operation": "write", "path": path,
                        "payloadAfterPath": path, "payloadAfterBlobSha256": sha, "payloadAfterContentKind": "text" }),
                }], next_cursor: 1, has_more: false,
            })]).with_view_blobs([(sha.clone(), text.as_bytes().to_vec())]),
        );
        let pulled = client
            .pull_share_view(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults)
            .expect("real share pull");
        assert_eq!(pulled.applied, 1);
        client
            .commit_share_view_cursor(&mut engine, "ws", &pulled.pending_cursor, &NoFaults)
            .expect("commit initial share pull");
        assert_eq!(delivery_status(&engine).state, DirectWriteState::Accepted);
        assert_eq!(delivery_status(&engine).content_hash, Some(sha.clone()));
        save_status_file(
            &mut engine,
            "local-save",
            "version: 1\nautomations: []\n# local\n",
            Some(text),
        );
        assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
        let owner_text = "version: 1\nautomations: []\n# later owner version\n";
        let owner_sha = hex_sha256(owner_text.as_bytes());
        let owner = RelaySyncClient::new(
            PagedShareRelay::new([], [(1, ShareViewResponse {
                ops: vec![ShareReplicationEnvelope {
                    origin_id: "owner".to_owned(), origin_seq: 1,
                    op_kind: "moment.append".to_owned(), recorded_at_ms: 3_000,
                    payload: json!({ "versionId": "main", "operation": "write", "path": path,
                        "payloadAfterPath": path, "payloadAfterBlobSha256": owner_sha, "payloadAfterContentKind": "text" }),
                }], next_cursor: 2, has_more: false,
            })]).with_view_blobs([(owner_sha, owner_text.as_bytes().to_vec())]),
        );
        let view_grant = proposal_grant(crate::ShareAccess::View);
        owner
            .pull_share_view(&mut engine, "ws", SHARE, &view_grant, &NoFaults)
            .expect("later owner pull");
        let history = VersionedTextStore::new(&mut engine);
        assert_eq!(
            history.read_text("ws", "main", path).unwrap().unwrap().text,
            owner_text
        );
        assert_eq!(
            history
                .get_moment("ws", "local-save")
                .unwrap()
                .unwrap()
                .after_text
                .as_deref(),
            Some("version: 1\nautomations: []\n# local\n")
        );
    }
}

#[test]
fn direct_status_survives_restart_and_an_old_push_cannot_clear_a_newer_save() {
    let (_scratch, db, mut engine) = proposal_fixture(&["rules", "new rules"]);
    hold_schema(&mut engine, "shared/docs/packing");
    save_status_file(&mut engine, "save-1", "rules", None);
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .unwrap()
        .push_back(Err(RelayError::Partitioned));
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::Partitioned),
    );
    drop(engine);
    let mut engine = EngineStore::open(&db, 0).expect("reopen pending");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    // Identical bytes are still a newer local moment.
    save_status_file(&mut engine, "save-2", "rules", Some("rules"));
    push(&client, &mut engine);
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    push(&client, &mut engine);
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Accepted);
    assert_eq!(
        delivery_status(&engine).content_hash,
        Some(hex_sha256(b"rules"))
    );
    drop(engine);
    let mut engine = EngineStore::open(&db, 0).expect("reopen accepted");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Accepted);
    save_status_file(&mut engine, "save-3", "new rules", Some("rules"));
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
}

#[test]
fn direct_status_checks_the_current_moment_and_accepts_an_imported_head() {
    let (_scratch, _db, mut engine) = proposal_fixture(&["rules"]);
    hold_schema(&mut engine, "shared/docs/packing");
    save_status_file(&mut engine, "save-1", "rules", None);
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    push(&client, &mut engine);
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Accepted);
    save_status_file(&mut engine, "remote-head", "rules", Some("rules"));
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE replication_log SET imported=1 WHERE workspace_id='ws' \
                    AND json_extract(payload_json,'$.momentId')='remote-head'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("imported journal proof");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Accepted);
    // An unjournaled head with equal bytes cannot borrow the old receipt.
    save_status_file(&mut engine, "unknown-head", "rules", Some("rules"));
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "DELETE FROM replication_log WHERE workspace_id='ws' \
                    AND json_extract(payload_json,'$.momentId')='unknown-head'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("unknown journal proof");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
}

#[test]
fn direct_status_reports_undelivered_decisions_durably() {
    for answer in [
        ShareCollectionWriteResponse::Stale {
            path: "shared/docs/packing/automations.yaml".to_owned(),
            current_blob_sha256: Some(hex_sha256(b"owner rules")),
        },
        ShareCollectionWriteResponse::Refused {
            reason: "catalog-refused".to_owned(),
        },
    ] {
        let (_scratch, db, mut engine) = proposal_fixture(&["rules", "new rules"]);
        hold_schema(&mut engine, "shared/docs/packing");
        save_status_file(&mut engine, "save-1", "rules", None);
        let relay = PagedShareRelay::new([], []);
        relay
            .collection_write_answers
            .lock()
            .unwrap()
            .push_back(Ok(answer));
        let client = RelaySyncClient::new(relay);
        push(&client, &mut engine);
        drop(engine);
        let mut engine = EngineStore::open(&db, 0).expect("reopen refused");
        let status = delivery_status(&engine);
        assert_eq!(status.state, DirectWriteState::Refused);
        assert_eq!(status.reason.as_deref(), Some("direct-write-not-delivered"));
        save_status_file(&mut engine, "save-2", "new rules", Some("rules"));
        assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    }
}

#[test]
fn direct_status_keeps_undelivered_state_while_a_plan_is_open() {
    let (_scratch, _db, mut engine) = proposal_fixture(&["rules", "v1", "v2"]);
    hold_schema(&mut engine, "shared/docs/packing");
    save_status_file(&mut engine, "save-1", "rules", None);
    journal_local_moment(
        &mut engine,
        &edit_moment(
            "save-2",
            "other-schema",
            "shared/docs/other/collection.yaml",
            "v1",
            "v2",
        ),
        2_001,
    );
    let relay = PagedShareRelay::new([], []);
    relay.collection_write_answers.lock().unwrap().extend([
        Ok(ShareCollectionWriteResponse::Stale {
            path: "shared/docs/packing/automations.yaml".to_owned(),
            current_blob_sha256: None,
        }),
        Err(RelayError::ServerInternal),
    ]);
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0,),
        Err(RelayError::ServerInternal)
    );
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Refused);
}

#[test]
fn direct_status_tracks_a_rename_into_automations_left_on_proposals() {
    let path = "shared/docs/packing/automations.yaml";
    let from = "shared/docs/packing/other.yaml";
    let (_scratch, db, mut engine) = proposal_fixture(&["rules"]);
    hold_schema(&mut engine, "shared/docs/packing");
    save_status_file(&mut engine, "save-1", "rules", None);
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    push(&client, &mut engine);
    for (source, target, moment) in [(path, from, "move-away"), (from, path, "rename-in")] {
        VersionedTextStore::new(&mut engine)
            .rename_text_file(
                &RenameTextFile {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    from_path: source.to_owned(),
                    to_path: target.to_owned(),
                    moment_id: moment.to_owned(),
                    request_id: None,
                    metadata_origin: "local-file".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2_200,
                },
                &NoFaults,
            )
            .expect("rename");
    }
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "rename-in",
            "status-file",
            "rename",
            Some((from, "rules")),
            path,
            "rules",
        ),
        2_200,
    );
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    push(&client, &mut engine);
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Refused);
    drop(engine);
    let engine = EngineStore::open(&db, 0).expect("reopen proposal status");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Refused);
}
#[test]
fn direct_status_unknown_files_and_missing_identity_remain_pending_and_scope_is_fenced() {
    let (_scratch, _db, mut engine) = proposal_fixture(&["rules"]);
    assert_eq!(
        delivery_status(&engine),
        DirectWriteStatus {
            content_hash: None,
            state: DirectWriteState::Accepted,
            reason: None,
            original_record_id: None,
            can_discard: false,
        }
    );
    save_status_file(&mut engine, "save-1", "rules", None);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute("DELETE FROM sync_identity WHERE workspace_id='ws'", [])
                .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("remove identity");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    engine
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "UPDATE snapshots SET metadata_origin='sync' WHERE workspace_id='ws'",
                [],
            )
            .map_err(SyncError::persist)?;
            Ok::<_, SyncError>(())
        })
        .expect("unjournaled local sync origin");
    assert_eq!(delivery_status(&engine).state, DirectWriteState::Pending);
    for path in [
        "private/automations.yaml",
        "shared/docs/../private",
        "shared/docs/.env",
    ] {
        assert!(matches!(
            read_direct_write_status(&engine, "ws", SHARE, path, &edit_grant(),),
            Err(SyncError::ShareBoundaryViolation)
        ));
    }
}

#[test]
fn direct_push_takes_dataset_automations_but_leaves_dataset_schema_rules_and_records_on_proposals()
{
    let (_scratch, _db, mut engine) = proposal_fixture(&["old", "new", "rules"]);
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "dataset".to_owned(),
                path: "shared/docs/data/dataset.json".to_owned(),
                text: "old".to_owned(),
                moment_id: "dataset-seed".to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("dataset manifest");
    journal_local_moment(
        &mut engine,
        &create_moment(
            "auto",
            "dataset-auto",
            "shared/docs/data/automations.yaml",
            "rules",
        ),
        1_001,
    );
    for (index, name) in ["dataset.json", "rules.yaml", "record.md"]
        .iter()
        .enumerate()
    {
        journal_local_moment(
            &mut engine,
            &edit_moment(
                &format!("edit-{index}"),
                &format!("object-{index}"),
                &format!("shared/docs/data/{name}"),
                "old",
                "new",
            ),
            1_002 + index as i64,
        );
    }
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec!["shared/docs/data/automations.yaml".to_owned()]]
    );
    assert_eq!(propose(&client, &mut engine, "proposal").submitted, 3);
}

#[test]
fn direct_push_writes_a_schema_edit_and_send_changes_never_offers_it() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "v3"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    let outcome = push(&client, &mut engine);
    assert_eq!(
        outcome.writes,
        vec![DirectWriteReport {
            recovered_draft_path: None,
            paths: vec![schema.to_owned()],
            result: DirectWriteResult::Written,
        }],
    );
    let writes = client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .clone();
    assert_eq!(writes.len(), 1);
    assert_eq!(
        writes[0].changes[0].based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"v1").as_str()),
        "the write states the content the recipient read",
    );
    assert!(writes[0].submit_id.starts_with("direct-"));

    assert_eq!(
        propose(&client, &mut engine, "submit-1").submitted,
        0,
        "a written file is not offered again"
    );

    // A later edit is offered, based on what the direct lane wrote.
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-schema", schema, "v2", "v3"),
        1_002,
    );
    let before_push = push(&client, &mut engine);
    assert_eq!(
        before_push.writes.len(),
        1,
        "the direct lane takes the later edit too"
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-3", "object-schema", schema, "v3", "v1"),
        1_003,
    );
    assert_eq!(propose(&client, &mut engine, "submit-2").submitted, 1);
    let submits = client
        .transport()
        .proposal_submits
        .lock()
        .expect("submits")
        .clone();
    assert_eq!(
        submits[0].ops[0].based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"v3").as_str()),
        "the proposal builds on the last content the direct lane wrote",
    );
}

#[test]
fn direct_push_leaves_every_other_change_on_proposals() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "note", "moved"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &create_moment("m-2", "object-note", "shared/docs/packing/a.md", "note"),
        1_002,
    );
    // A moved schema and an automations file in a folder that is no
    // Collection stay on proposals.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-3",
            "object-moved",
            "write",
            Some(("shared/docs/old/collection.yaml", "v1")),
            "shared/docs/new/collection.yaml",
            "moved",
        ),
        1_003,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-4",
            "object-auto",
            "shared/docs/plain/automations.yaml",
            "note",
        ),
        1_004,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(written_paths(&client), vec![vec![schema.to_owned()]]);

    propose(&client, &mut engine, "submit-1");
    let mut proposed = proposed_paths(&client);
    proposed.sort();
    assert_eq!(
        proposed,
        vec![
            "shared/docs/new/collection.yaml",
            "shared/docs/packing/a.md",
            "shared/docs/plain/automations.yaml",
        ],
    );
}

#[test]
fn direct_push_writes_automations_beside_a_collection() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["rules"]);
    hold_schema(&mut engine, "shared/docs/packing");
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-1",
            "object-auto",
            "shared/docs/packing/automations.yaml",
            "rules",
        ),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec!["shared/docs/packing/automations.yaml".to_owned()]],
    );
}

#[test]
fn direct_push_sends_a_new_collection_as_one_batch_schema_first() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["a", "b", "rules", "schema", "image"]);
    let folder = "shared/docs/ideas";
    journal_local_moment(
        &mut engine,
        &create_moment("m-1", "object-a", &format!("{folder}/a.md"), "a"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &create_moment("m-2", "object-b", &format!("{folder}/B.MD"), "b"),
        1_002,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-3",
            "object-rules",
            &format!("{folder}/automations.yaml"),
            "rules",
        ),
        1_003,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-4",
            "object-schema",
            &format!("{folder}/collection.yaml"),
            "schema",
        ),
        1_004,
    );
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-5",
            "object-image",
            &format!("{folder}/notes.txt"),
            "image",
        ),
        1_005,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec![
            format!("{folder}/collection.yaml"),
            format!("{folder}/automations.yaml"),
            format!("{folder}/a.md"),
            format!("{folder}/B.MD"),
        ]],
    );
    let calls = client
        .transport()
        .proposal_calls
        .lock()
        .expect("calls")
        .clone();
    assert_eq!(
        calls.last().map(String::as_str),
        Some("write"),
        "content travels before the write"
    );

    propose(&client, &mut engine, "submit-1");
    assert_eq!(proposed_paths(&client), vec![format!("{folder}/notes.txt")]);
}

#[test]
fn stale_new_collection_does_not_copy_each_record_into_recovery_files() {
    let first = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\n---\nFirst draft\n";
    let second = "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\nSecond draft\n";
    let schema = "fields:\n  Title:\n    type: text\n";
    let (_scratch, _path, mut engine) = proposal_fixture(&[first, second, schema]);
    let folder = "shared/docs/ideas";
    for (index, (name, text)) in [
        ("a.md", first),
        ("b.md", second),
        ("collection.yaml", schema),
    ]
    .into_iter()
    .enumerate()
    {
        journal_local_moment(
            &mut engine,
            &create_moment(
                &format!("new-{index}"),
                &format!("object-{index}"),
                &format!("{folder}/{name}"),
                text,
            ),
            1_001 + index as i64,
        );
    }
    let relay = PagedShareRelay::new([], []);
    relay.collection_write_answers.lock().unwrap().push_back(Ok(
        ShareCollectionWriteResponse::Stale {
            path: folder.to_owned(),
            current_blob_sha256: None,
        },
    ));
    let client = RelaySyncClient::new(relay);
    let outcome = push(&client, &mut engine);
    assert_eq!(outcome.writes.len(), 1);
    assert_eq!(outcome.writes[0].paths.len(), 3);
    assert_eq!(outcome.writes[0].recovered_draft_path, None);
    engine
        .read_with(|conn| {
            let copies: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM snapshots WHERE workspace_id='ws' AND path LIKE '%/Record draft %.txt'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(copies, 0, "a refused Collection stays available as a proposal");
            Ok::<(), SyncError>(())
        })
        .unwrap();
}

#[test]
fn a_stale_or_refused_write_is_not_sent_again_and_stays_available_to_send_changes() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let first = "shared/docs/one/collection.yaml";
    let second = "shared/docs/two/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-one", first, "v1", "v2"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-two", second, "v1", "v2"),
        1_002,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .extend([
            Ok(ShareCollectionWriteResponse::Stale {
                path: first.to_owned(),
                current_blob_sha256: Some("f".repeat(64)),
            }),
            Ok(ShareCollectionWriteResponse::Refused {
                reason: "not a valid collection.yaml".to_owned(),
            }),
        ]);
    let client = RelaySyncClient::new(relay);

    let outcome = push(&client, &mut engine);
    assert_eq!(
        outcome
            .writes
            .iter()
            .map(|write| write.result.clone())
            .collect::<Vec<_>>(),
        vec![
            DirectWriteResult::Stale {
                path: first.to_owned(),
                current_blob_sha256: Some("f".repeat(64)),
            },
            DirectWriteResult::Refused {
                reason: "not a valid collection.yaml".to_owned(),
            },
        ],
    );
    assert!(
        push(&client, &mut engine).writes.is_empty(),
        "a decided write is not sent again"
    );
    assert_eq!(written_paths(&client).len(), 2);

    propose(&client, &mut engine, "submit-1");
    let mut proposed = proposed_paths(&client);
    proposed.sort();
    assert_eq!(proposed, vec![first, second]);
}

#[test]
fn a_write_whose_answer_was_lost_is_sent_again_as_the_same_request_after_another_edit() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "v3"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Err(RelayError::HttpStatus(429)));
    let client = RelaySyncClient::new(relay);

    // The relay may have taken the write; its answer never arrived.
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::HttpStatus(429)),
    );
    // Another edit before the next push does not change the write in flight.
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-schema", schema, "v2", "v3"),
        1_002,
    );
    assert_eq!(push(&client, &mut engine).writes.len(), 1);
    let writes = client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .clone();
    assert_eq!(writes.len(), 2);
    assert_eq!(
        writes[0], writes[1],
        "a retry sends the request it recorded, under its submit id"
    );
    // The later edit goes in the next push, based on what was written.
    assert_eq!(push(&client, &mut engine).writes.len(), 1);
    let writes = client
        .transport()
        .collection_writes
        .lock()
        .expect("writes")
        .clone();
    assert_eq!(writes.len(), 3);
    assert_eq!(
        writes[2].changes[0].based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"v2").as_str()),
    );
    assert_ne!(writes[2].submit_id, writes[0].submit_id);
}

#[test]
fn a_later_write_that_fails_keeps_an_earlier_one_delivered_and_holds_send_changes() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let first = "shared/docs/one/collection.yaml";
    let second = "shared/docs/two/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-one", first, "v1", "v2"),
        1_001,
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-two", second, "v1", "v2"),
        1_002,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .extend([
            Ok(ShareCollectionWriteResponse::Written {
                paths: vec![first.to_owned()],
            }),
            Err(RelayError::ServerInternal),
        ]);
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::ServerInternal),
    );
    // The first write is delivered, and the second is still open: Send
    // changes offers neither, and stops before the open one.
    let outcome = propose(&client, &mut engine, "submit-1");
    assert_eq!(outcome.submitted, 0);
    assert!(outcome.more_pending);

    // The next push sends only the open write, and reports both.
    let pushed = push(&client, &mut engine);
    assert_eq!(
        pushed
            .writes
            .iter()
            .map(|write| write.paths.clone())
            .collect::<Vec<_>>(),
        vec![vec![first.to_owned()], vec![second.to_owned()]],
    );
    assert_eq!(
        written_paths(&client),
        vec![
            vec![first.to_owned()],
            vec![second.to_owned()],
            vec![second.to_owned()],
        ]
    );
    assert_eq!(propose(&client, &mut engine, "submit-2").submitted, 0);
}

#[test]
fn a_relay_that_does_not_take_direct_writes_leaves_the_change_to_send_changes() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let relay = PagedShareRelay::new([], []);
    relay
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Err(RelayError::ShareUnavailable));
    let client = RelaySyncClient::new(relay);

    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::ShareUnavailable),
    );
    // No write is left open, so Send changes offers the change.
    assert_eq!(propose(&client, &mut engine, "submit-1").submitted, 1);
    assert_eq!(proposed_paths(&client), vec![schema.to_owned()]);
}

#[test]
fn an_upload_the_grant_can_no_longer_make_leaves_the_change_to_send_changes() {
    for (error, dropped) in [
        (RelayError::ShareReadOnly, true),
        (RelayError::Forbidden, true),
        (RelayError::Partitioned, false),
    ] {
        let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
        let schema = "shared/docs/packing/collection.yaml";
        journal_local_moment(
            &mut engine,
            &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
            1_001,
        );
        let relay = PagedShareRelay::new([], []);
        relay
            .blob_upload_errors
            .lock()
            .expect("upload errors")
            .push_back(error.clone());
        let client = RelaySyncClient::new(relay);

        assert_eq!(
            client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
            Err(error.clone()),
        );
        assert!(written_paths(&client).is_empty(), "{error:?}");
        // A lasting no drops the plan, so Send changes offers the change. A
        // failure that may pass keeps it, and Send changes waits.
        let proposed = propose(&client, &mut engine, "submit-1").submitted;
        assert_eq!(proposed, usize::from(dropped), "{error:?}");
    }
}

#[test]
fn a_refused_edit_after_a_delivered_create_keeps_the_create_delivered() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["rules", "rules two"]);
    hold_schema(&mut engine, "shared/docs/packing");
    let path = "shared/docs/packing/automations.yaml";
    journal_local_moment(
        &mut engine,
        &create_moment("m-1", "object-auto", path, "rules"),
        1_001,
    );
    let relay = PagedShareRelay::new([], []);
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        push(&client, &mut engine).writes[0].result,
        DirectWriteResult::Written
    );

    journal_local_moment(
        &mut engine,
        &edit_moment("m-2", "object-auto", path, "rules", "rules two"),
        1_002,
    );
    client
        .transport()
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Ok(ShareCollectionWriteResponse::Refused {
            reason: "changes an automation with a personal step".to_owned(),
        }));
    assert!(matches!(
        push(&client, &mut engine).writes[0].result,
        DirectWriteResult::Refused { .. }
    ));

    // Deleting the file leaves a delete for Send changes, based on the
    // content the direct lane delivered.
    journal_local_moment(
        &mut engine,
        &local_moment_payload(
            "m-3",
            "object-auto",
            "delete",
            Some((path, "rules two")),
            path,
            "rules two",
        ),
        1_003,
    );
    assert_eq!(propose(&client, &mut engine, "submit-1").submitted, 1);
    let submits = client
        .transport()
        .proposal_submits
        .lock()
        .expect("submits")
        .clone();
    let op = &submits[0].ops[0];
    assert_eq!(op.operation, "delete");
    assert_eq!(op.based_on_path.as_deref(), Some(path));
    assert_eq!(
        op.based_on_blob_sha256.as_deref(),
        Some(dohc_engine_storage::hex_sha256(b"rules").as_str()),
    );
}

#[test]
fn a_new_collection_batch_stops_at_its_byte_bound_and_at_a_second_spelling() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["schema", "a", "b", "c"]);
    let folder = "shared/docs/ideas";
    let big = |moment: &str, object: &str, name: &str, text: &str| {
        let mut payload = create_moment(moment, object, &format!("{folder}/{name}"), text);
        payload["payloadAfterByteLength"] = json!(3 * 1024 * 1024);
        payload
    };
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-1",
            "object-schema",
            &format!("{folder}/collection.yaml"),
            "schema",
        ),
        1_001,
    );
    journal_local_moment(&mut engine, &big("m-2", "object-a", "a.md", "a"), 1_002);
    journal_local_moment(&mut engine, &big("m-3", "object-b", "b.md", "b"), 1_003);
    journal_local_moment(
        &mut engine,
        &create_moment("m-4", "object-c", &format!("{folder}/A.MD"), "c"),
        1_004,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec![
            format!("{folder}/collection.yaml"),
            format!("{folder}/a.md")
        ]],
        "b.md does not fit the batch, and A.MD is a.md on some disks",
    );
    propose(&client, &mut engine, "submit-1");
    let mut proposed = proposed_paths(&client);
    proposed.sort();
    assert_eq!(
        proposed,
        vec![format!("{folder}/A.MD"), format!("{folder}/b.md")]
    );
}

#[test]
fn a_scan_of_nothing_but_new_collections_still_moves_on() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["schema"]);
    let count = crate::MAX_SHARE_PROPOSAL_OPS + 1;
    for index in 0..count {
        journal_local_moment(
            &mut engine,
            &create_moment(
                &format!("m-{index}"),
                &format!("object-{index}"),
                &format!("shared/docs/c{index}/collection.yaml"),
                "schema",
            ),
            1_001,
        );
    }
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    let first = push(&client, &mut engine);
    assert_eq!(first.writes.len(), crate::MAX_SHARE_PROPOSAL_OPS);
    assert!(first.more_pending);
    let second = push(&client, &mut engine);
    assert_eq!(second.writes.len(), 1);
    assert!(!second.more_pending);
    assert_eq!(written_paths(&client).len(), count);
}

#[test]
fn an_open_write_does_not_stop_send_changes_below_what_was_delivered() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2", "v3", "note"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    assert_eq!(push(&client, &mut engine).writes.len(), 1);

    // A plain file, then another schema edit whose write stays open.
    journal_local_moment(
        &mut engine,
        &create_moment("m-2", "object-note", "shared/docs/packing/a.md", "note"),
        1_002,
    );
    journal_local_moment(
        &mut engine,
        &edit_moment("m-3", "object-schema", schema, "v2", "v3"),
        1_003,
    );
    client
        .transport()
        .collection_write_answers
        .lock()
        .expect("answers")
        .push_back(Err(RelayError::ServerInternal));
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::ServerInternal),
    );
    // Send changes reads past the delivered edit and offers the plain file,
    // then stops at the open edit.
    let outcome = propose(&client, &mut engine, "submit-1");
    assert_eq!(outcome.submitted, 1);
    assert!(outcome.more_pending);
    assert_eq!(
        proposed_paths(&client),
        vec!["shared/docs/packing/a.md".to_owned()]
    );
}

#[test]
fn only_a_failure_that_may_pass_keeps_the_plan() {
    for (error, kept) in [
        (RelayError::ShareUnavailable, false),
        (RelayError::ShareReadOnly, false),
        (RelayError::Forbidden, false),
        (RelayError::BadRequest, false),
        (RelayError::PayloadTooLarge, false),
        (RelayError::Conflict, false),
        (RelayError::Partitioned, true),
        (RelayError::ServerInternal, true),
        (RelayError::HttpStatus(429), true),
        (RelayError::HttpStatus(503), true),
        (RelayError::BlobReferenceMissing, true),
    ] {
        let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
        let schema = "shared/docs/packing/collection.yaml";
        journal_local_moment(
            &mut engine,
            &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
            1_001,
        );
        let relay = PagedShareRelay::new([], []);
        relay
            .collection_write_answers
            .lock()
            .expect("answers")
            .push_back(Err(error.clone()));
        let client = RelaySyncClient::new(relay);
        assert_eq!(
            client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
            Err(error.clone()),
        );
        let outcome = propose(&client, &mut engine, "submit-1");
        assert_eq!(outcome.submitted, usize::from(!kept), "{error:?}");
    }
}

#[test]
fn a_new_collection_the_scan_bound_cuts_is_sent_whole_by_the_next_push() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["schema", "record"]);
    let folder = "shared/docs/ideas";
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-schema",
            "object-schema",
            &format!("{folder}/collection.yaml"),
            "schema",
        ),
        1_001,
    );
    // Enough other files that the scan holds its bound before the record.
    for index in 1..crate::MAX_SHARE_PROPOSAL_OPS {
        journal_local_moment(
            &mut engine,
            &create_moment(
                &format!("m-bulk-{index}"),
                &format!("object-bulk-{index}"),
                &format!("shared/docs/bulk/{index}.txt"),
                "record",
            ),
            1_001,
        );
    }
    journal_local_moment(
        &mut engine,
        &create_moment(
            "m-record",
            "object-record",
            &format!("{folder}/a.md"),
            "record",
        ),
        1_002,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    let first = push(&client, &mut engine);
    assert!(
        first.writes.is_empty(),
        "a Collection the bound cut is not sent in part"
    );
    assert!(first.more_pending);
    let second = push(&client, &mut engine);
    assert_eq!(
        written_paths(&client),
        vec![vec![
            format!("{folder}/collection.yaml"),
            format!("{folder}/a.md")
        ]],
    );
    assert!(!second.more_pending);
}

#[test]
fn direct_push_starts_after_what_send_changes_already_sent() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    let schema = "shared/docs/packing/collection.yaml";
    journal_local_moment(
        &mut engine,
        &edit_moment("m-1", "object-schema", schema, "v1", "v2"),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));

    assert_eq!(propose(&client, &mut engine, "submit-1").submitted, 1);
    assert!(
        push(&client, &mut engine).writes.is_empty(),
        "a proposed change is not also written"
    );
}

#[test]
fn direct_push_writes_nothing_below_edit_or_on_another_version() {
    let (_scratch, _path, mut engine) = proposal_fixture(&["v1", "v2"]);
    journal_local_moment(
        &mut engine,
        &edit_moment(
            "m-1",
            "object-schema",
            "shared/docs/packing/collection.yaml",
            "v1",
            "v2",
        ),
        1_001,
    );
    let client = RelaySyncClient::new(PagedShareRelay::new([], []));
    let mut version = edit_grant();
    version.version_id = Some("draft".to_owned());
    for granted in [
        proposal_grant(crate::ShareAccess::View),
        proposal_grant(crate::ShareAccess::Comment),
        version,
    ] {
        let outcome = client
            .push_direct_writes(&mut engine, "ws", SHARE, &granted, &NoFaults, 0)
            .expect("push");
        assert!(outcome.writes.is_empty());
    }
    assert!(
        client
            .transport()
            .proposal_calls
            .lock()
            .expect("calls")
            .is_empty()
    );
}

#[test]
fn record_name_race_releases_winner_and_keeps_local_content_after_restart() {
    let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nTitle: My packing list\n---\nKeep my typed content.\n";
    let latest = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nTitle: My packing list\n---\nKeep my typed content, including the later edit.\n";
    let path = "shared/docs/packing/One.md";
    let (_scratch, db, mut engine) = proposal_fixture(&[text, latest]);
    hold_schema(&mut engine, "shared/docs/packing");
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "record-one".to_owned(),
                path: path.to_owned(),
                text: text.to_owned(),
                moment_id: "create-one".to_owned(),
                metadata_origin: "user".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2_000,
                request_id: None,
            },
            &NoFaults,
        )
        .expect("record draft");
    journal_local_moment(
        &mut engine,
        &create_moment("create-one", "record-one", path, text),
        2_000,
    );
    let statuses = |store: &EngineStore| {
        read_record_creation_statuses(store, "ws", SHARE, &[path.to_owned()], &edit_grant())
            .unwrap()
    };

    let relay = PagedShareRelay::new([], []);
    relay.collection_write_answers.lock().unwrap().extend([
        Err(RelayError::HttpStatus(429)),
        Ok(ShareCollectionWriteResponse::Stale {
            path: path.to_owned(),
            current_blob_sha256: None,
        }),
    ]);
    let client = RelaySyncClient::new(relay);
    assert_eq!(
        client.push_direct_writes(&mut engine, "ws", SHARE, &edit_grant(), &NoFaults, 0),
        Err(RelayError::HttpStatus(429)),
    );
    let submitted = client.transport().collection_writes.lock().unwrap()[0].clone();
    let identity = hex_sha256(format!("ws\0{}\0{path}", submitted.submit_id).as_bytes());
    let occupied_path = format!("shared/docs/packing/Record draft {}-1.txt", &identity[..12]);
    for (object_id, moment_id, file_path, content) in [
        (
            "occupied-draft",
            "occupied-draft-moment",
            occupied_path.as_str(),
            "Keep this existing file.",
        ),
        ("record-one", "edit-one", path, latest),
    ] {
        VersionedTextStore::new(&mut engine)
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "ws".to_owned(),
                    version_id: "main".to_owned(),
                    object_id: object_id.to_owned(),
                    path: file_path.to_owned(),
                    text: content.to_owned(),
                    moment_id: moment_id.to_owned(),
                    metadata_origin: "local-file".to_owned(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2_001,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }
    journal_local_moment(
        &mut engine,
        &edit_moment("edit-one", "record-one", path, text, latest),
        2_001,
    );
    let outcome = push(&client, &mut engine);
    let recovered_path = format!("shared/docs/packing/Record draft {}-2.txt", &identity[..12]);
    assert_eq!(
        outcome.writes[0].recovered_draft_path.as_deref(),
        Some(recovered_path.as_str())
    );
    let other = "---\nid: rec_bbbbbbbbbbbbbbbbbbbbbbbbbb\n---\n";
    VersionedTextStore::new(&mut engine)
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".to_owned(),
                version_id: "main".to_owned(),
                object_id: "record-one".to_owned(),
                path: path.to_owned(),
                text: other.to_owned(),
                moment_id: "moment-share-other".to_owned(),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 3_000,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    drop(engine);
    let engine = EngineStore::open(&db, 0).unwrap();
    assert!(
        statuses(&engine).is_empty(),
        "the winner is an ordinary shared record"
    );
    engine
        .read_with(|conn| {
            let kept: Vec<(String, String)> = conn.prepare(
                "SELECT s.path,b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id='ws' AND s.path LIKE 'shared/docs/packing/Record draft %.txt'"
            ).unwrap().query_map([], |row| Ok((row.get(0)?,row.get(1)?))).unwrap().map(Result::unwrap).collect();
            assert_eq!(kept.len(), 2);
            assert!(kept.iter().any(|(path, text)| path == &occupied_path && text == "Keep this existing file."));
            let recovered_path = format!("shared/docs/packing/Record draft {}-2.txt", &identity[..12]);
            assert!(kept.iter().any(|(path, text)| path == &recovered_path && text == latest));
            let outbound_copies: i64 = conn.query_row(
                "SELECT COUNT(*) FROM replication_log WHERE workspace_id='ws' AND json_extract(payload_json,'$.payloadAfterPath')=?1",
                [&recovered_path], |row| row.get(0),
            ).unwrap();
            assert_eq!(outbound_copies, 0, "the recovery copy stays on this computer");
            let winner: String = conn.query_row("SELECT b.text FROM snapshots s JOIN blobs b ON b.sha256=s.blob_sha256 WHERE s.workspace_id='ws' AND s.path=?1",[path],|row|row.get(0)).unwrap();
            assert_eq!(winner, other, "the draft never enters the winner's record");
            Ok::<(), SyncError>(())
        })
        .unwrap();
}

fn imported_creation_fixture() -> (ScratchDir, std::path::PathBuf, EngineStore) {
    let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nTitle: Ready\n---\n";
    let (scratch, db, mut engine) = proposal_fixture(&[text]);
    seed_text_head(
        &mut engine,
        "object-tasks",
        "shared/docs/tasks/collection.yaml",
        "fields:\n  Title:\n    type: text\n",
    );
    engine
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            for (id, kinds) in [
                (
                    "record-added",
                    vec![dohc_engine_domain::AutomationChangeKind::Added],
                ),
                (
                    "starts-matching",
                    vec![
                        dohc_engine_domain::AutomationChangeKind::Added,
                        dohc_engine_domain::AutomationChangeKind::Changed,
                    ],
                ),
            ] {
                dohc_engine_domain::subscribe_automation_in_tx(
                    tx,
                    "ws",
                    &dohc_engine_domain::AutomationSubscription {
                        automation_id: format!("collection:object-tasks#{id}"),
                        prefix: "shared/docs/tasks".to_owned(),
                        kinds,
                        fields: None,
                    },
                    1_500,
                )?;
            }
            Ok::<_, dohc_engine_domain::DomainError>(())
        })
        .expect("owner watches both creation triggers");
    (scratch, db, engine)
}

fn reconcile_imported_creation(
    engine: &mut EngineStore,
) -> Vec<dohc_engine_domain::AutomationClaim> {
    let outcome = engine
        .write_with(&NoFaults, |tx| {
            let reconciliation = dohc_engine_domain::reconcile_collections_in_tx(tx, "ws", "main")?;
            dohc_engine_domain::claim_record_lifecycle_in_tx(
                tx,
                "ws",
                "main",
                &reconciliation.lifecycle,
                2_100,
            )
        })
        .expect("reconcile imported creation");
    let TxnOutcome::Committed(claims) = outcome else {
        panic!("reconcile crashed");
    };
    claims
}

#[test]
fn imported_recipient_creation_claims_both_creation_triggers_with_its_actual_author() {
    for author in [
        json!({"kind":"named", "userId":"user-recipient", "grantId":"grant-recipient", "grantGeneration":2}),
        json!({"kind":"link", "principalId":"link-recipient", "grantId":"grant-recipient", "grantGeneration":2}),
    ] {
        let (_scratch, db, mut engine) = imported_creation_fixture();
        let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nTitle: Ready\n---\n";
        let mut payload = create_moment(
            "moment-recipient-created",
            "object-record",
            "shared/docs/tasks/Ready.md",
            text,
        );
        payload["authors"] = json!([author.clone()]);
        let creation = envelope(
            "relay:collection-file:grant-recipient",
            0,
            "moment.append",
            payload,
        );
        let imported = apply_replication_envelope(
            &mut engine,
            &mut dohc_engine_collab::WriterDocCache::new(),
            &creation,
            &NoFaults,
            &NoLiveLeases,
        )
        .expect("import recipient creation");
        assert!(
            matches!(imported.primary, ApplyDisposition::Applied(_)),
            "{imported:?}"
        );
        let claims = reconcile_imported_creation(&mut engine);
        assert_eq!(
            claims
                .iter()
                .map(|claim| claim.automation_id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "collection:object-tasks#record-added",
                "collection:object-tasks#starts-matching"
            ]
        );
        let expected_person = (author["kind"] == "named").then_some("user-recipient");
        for claim in &claims {
            assert_eq!(
                claim.change.kind,
                dohc_engine_domain::AutomationChangeKind::Added
            );
            assert_eq!(
                claim.record_id.as_deref(),
                Some("rec_aaaaaaaaaaaaaaaaaaaaaaaaaa")
            );
            assert_eq!(claim.change.on_behalf_of.as_deref(), expected_person);
            assert_eq!(
                serde_json::to_value(
                    claim
                        .change
                        .shared_author
                        .as_ref()
                        .expect("actual relay author")
                )
                .unwrap(),
                author
            );
            assert_eq!(claim.depth, 0);
        }
        assert!(
            reconcile_imported_creation(&mut engine).is_empty(),
            "reconcile does not claim a creation twice"
        );
        drop(engine);
        let mut engine = EngineStore::open(&db, 0).expect("restart owner");
        for expected in &claims {
            let (claimed, fields) = dohc_engine_domain::claim_next_pending_automation(
                &mut engine,
                "ws",
                &expected.automation_id,
                2_200,
                &NoFaults,
            )
            .unwrap()
            .expect("durable creation claim");
            assert_eq!(claimed.change, expected.change);
            let title = fields
                .fields
                .iter()
                .find(|field| field.field_name == "Title")
                .expect("creation carries its matching value");
            assert_eq!(title.previous, None);
            assert_eq!(
                title.next.as_ref(),
                Some(&dohc_engine_domain::AutomationFactValue::Whole {
                    value: json!("Ready")
                })
            );
        }
    }
}

#[test]
fn an_ordinary_imported_creation_does_not_claim_either_creation_trigger() {
    let (_scratch, _db, mut engine) = imported_creation_fixture();
    let text = "---\nid: rec_aaaaaaaaaaaaaaaaaaaaaaaaaa\nTitle: Ready\n---\n";
    let mut payload = create_moment(
        "moment-peer-created",
        "object-record",
        "shared/docs/tasks/Ready.md",
        text,
    );
    payload["authors"] = json!([{"kind":"human", "humanId":"user-recipient"}]);
    let creation = envelope("another-device", 0, "moment.append", payload);
    let imported = apply_replication_envelope(
        &mut engine,
        &mut dohc_engine_collab::WriterDocCache::new(),
        &creation,
        &NoFaults,
        &NoLiveLeases,
    )
    .expect("import peer creation");
    assert!(
        matches!(imported.primary, ApplyDisposition::Applied(_)),
        "{imported:?}"
    );
    assert!(
        reconcile_imported_creation(&mut engine).is_empty(),
        "ordinary synced creations keep the origin-device rule"
    );
}
