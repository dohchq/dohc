use super::*;
use crate::events::{AUTOMATION_CLAIMED_EVENT, RECORD_FIELD_CHANGED_EVENT, RECORD_UPDATED_EVENT};
use dohc_engine_collab::{WriterDocCache, Ydoc, reader_resolver::ReaderResolver};
use dohc_engine_domain::{VersionedTextStore, WriteText};
use dohc_engine_storage::{EngineStore, hex_sha256};
use dohc_engine_sync::{AlwaysLive, NoLiveLeases, ReplicationEnvelope, apply_ydoc_envelope};
use dohc_engine_testkit::{ScratchDir, engine_db_path};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn markdown_hold_resync_emits_parked_record_facts_after_checker_failure() {
    const WS: &str = "markdown-resync-facts";
    const PATH: &str = "tasks/alpha.md";
    const RECORD: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const PEER: &str = "parked-record-peer";
    const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    let scratch = ScratchDir::new().unwrap();
    crate::root_binding::write_root_binding(scratch.path(), TOKEN).unwrap();
    let db = engine_db_path(&scratch).unwrap();
    let source = format!("---\nid: {RECORD}\nstatus: open\n---\n\n- parent\n  - child\n");
    let schema = "fields:\n  status:\n    type: text\n";
    let key = DocKey::new(WS, "main", "record").unwrap();
    let remote = Ydoc::wire();
    remote
        .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, &source)
        .unwrap();
    let mut store = EngineStore::open(&db, 1).unwrap();
    store.bind_root_token(TOKEN, &NoFaults).unwrap();
    VersionedTextStore::new(&mut store)
        .ensure_main_version(WS, "main", 1, &NoFaults)
        .unwrap();
    for (object, path, text) in [
        ("schema", "tasks/collection.yaml", schema),
        ("record", PATH, source.as_str()),
    ] {
        VersionedTextStore::new(&mut store)
            .write_text(
                &WriteText {
                    workspace_id: WS.into(),
                    version_id: "main".into(),
                    object_id: object.into(),
                    path: path.into(),
                    text: text.into(),
                    moment_id: object.into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
    }
    store
        .write_with(&NoFaults, |tx| {
            dohc_engine_domain::reconcile_collections_in_tx(tx, WS, "main")?;
            dohc_engine_domain::set_collection_adoption_state_in_tx(
                tx, WS, "main", PATH, RECORD, "adopted",
            )
        })
        .unwrap();
    let base = store.put_binary_blob(&remote.encode_full_state()).unwrap();
    let envelope = |seq: i64, sha: &str| ReplicationEnvelope {
        settlement_admission: None,
        admitted_author_snapshot: None,
        workspace_id: WS.into(),
        origin_id: PEER.into(),
        origin_seq: seq,
        relay_seq: Some(seq),
        op_kind: "ydoc.update".into(),
        payload: json!({
            "versionId":"main", "objectId":"record", "path":PATH, "contentKind":"richdoc",
            "updateBlobSha256":sha, "lineageClaimId":base, "isBaseState":seq == 0, "actorOriginId":PEER,
        }),
        recorded_at_ms: 10 + seq,
    };
    apply_ydoc_envelope(
        &mut store,
        &mut WriterDocCache::new(),
        &envelope(0, &base),
        &NoFaults,
        &NoLiveLeases,
    )
    .unwrap();
    drop(store);
    std::fs::create_dir_all(scratch.path().join("tasks")).unwrap();
    std::fs::write(scratch.path().join("tasks/collection.yaml"), schema).unwrap();
    let file = scratch.path().join(PATH);
    std::fs::write(&file, &source).unwrap();
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();

    let service = EngineService::new();
    let opened = service
        .workspace_open(
            &RequestContext::unbounded(),
            json!({
                "rootDir":scratch.path(), "workspaceId":WS, "captureMode":"none",
            }),
        )
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open = service.open(Some(&handle)).unwrap();
    // Keep background recovery behind its existing gate while the editor resyncs.
    let recovery_gate = open.capture_apply_gate.clone().lock_owned().await;
    let failed_reader = Arc::new(dohc_engine_reader::Reader::new(Some(
        crate::rpc::markdown_recovery::tests::witness_reader(&scratch, "witness-source-mismatch"),
    )));
    open.actor
        .configure_reader_resolver(Arc::new(ReaderResolver::new(failed_reader.clone())))
        .await
        .unwrap();
    let (session, initial) = service
        .ydoc_open(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"versionId":"main", "path":PATH, "contentKind":"richdoc"}),
            1,
        )
        .await
        .unwrap();
    drop(initial);
    let id = session["sessionId"].as_str().unwrap();
    assert_eq!(session["lineageClaimId"], json!(base));

    remote.frontmatter_set("status", "remote").unwrap();
    remote.richdoc_append_paragraph("Accepted parked edit");
    {
        let mut store = EngineStore::open(&db, 20).unwrap();
        let sha = store.put_binary_blob(&remote.encode_full_state()).unwrap();
        let applied = apply_ydoc_envelope(
            &mut store,
            &mut WriterDocCache::new(),
            &envelope(1, &sha),
            &NoFaults,
            &AlwaysLive,
        )
        .unwrap();
        assert!(
            matches!(applied.primary, dohc_engine_sync::ApplyDisposition::Applied(result) if result.deferred)
        );
    }
    let counts = || {
        let store = EngineStore::open_read_only(&db).unwrap();
        [
            "ydoc_updates",
            "collection_field_history",
            "moments",
            "materialization_jobs",
            "live_device_settlements",
        ]
        .map(|table| store.table_row_count(table).unwrap())
    };
    let before = counts();
    let mut events = service.events().subscribe();
    let failed = service
        .ydoc_settle(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":id}),
        )
        .await
        .unwrap_err();
    assert_eq!(failed.code, ErrorCode::Internal);
    assert_eq!(
        failed_reader.dispatch_count(),
        1,
        "the witness checker failed after the append committed"
    );
    let accepted = counts();
    assert_eq!(accepted[0], before[0] + 1);
    assert_eq!(accepted[1], before[1] + 1);
    assert_eq!(
        &accepted[2..],
        &before[2..],
        "the failed checker publishes no file save"
    );
    {
        let store = EngineStore::open_read_only(&db).unwrap();
        assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 1);
        let facts: String = store.read_with(|conn| conn.query_row(
            "SELECT record_facts_json FROM ydoc_deferred_updates WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=1",
            rusqlite::params![WS, PEER], |row| row.get(0))).unwrap();
        let facts: dohc_engine_domain::CollectionRecordApplyFacts =
            serde_json::from_str(&facts).unwrap();
        assert_eq!(facts.source, Some((PEER.into(), 1)));
        assert_eq!(facts.fields.len(), 1);
        assert_eq!(facts.fields[0].field_name, "status");
    }
    while let Ok(event) = events.try_recv() {
        assert!(
            !event.name.starts_with("record."),
            "facts remain parked: {event:?}"
        );
        assert_ne!(event.name, AUTOMATION_CLAIMED_EVENT);
    }
    assert_eq!(std::fs::read(&file).unwrap(), source.as_bytes());
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );

    let reader = Arc::new(dohc_engine_reader::Reader::new(Some(
        crate::rpc::markdown_recovery::tests::witness_reader(&scratch, "witness-unsafe"),
    )));
    open.actor
        .configure_reader_resolver(Arc::new(ReaderResolver::new(reader.clone())))
        .await
        .unwrap();
    let (state, resynced) = service
        .ydoc_resync(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":id}),
            2,
        )
        .await
        .unwrap();
    assert_eq!(state["headSha256"], json!(hex_sha256(source.as_bytes())));
    let doc = Ydoc::wire();
    doc.apply(&resynced.bytes).unwrap();
    drop(resynced);
    let projection = doc.project(ContentKind::Richdoc).unwrap().content;
    assert!(projection.contains("status: remote"));
    assert_eq!(projection.matches("Accepted parked edit").count(), 1);
    assert!(doc.has_markdown_witness());
    assert_eq!(reader.dispatch_count(), 1);
    assert_eq!(
        counts(),
        accepted,
        "resync retrieves facts without appending or indexing the edit again"
    );
    {
        let store = EngineStore::open_read_only(&db).unwrap();
        assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
        assert!(
            dohc_engine_sync::list_refusal_notices(&store, WS)
                .unwrap()
                .iter()
                .any(|notice| notice.reason == "markdown-write-held")
        );
        let owed = store
            .read_with(|conn| dohc_engine_collab::markdown_write_obligations::pending_in(conn, WS))
            .unwrap();
        let sync: Vec<_> = owed
            .iter()
            .filter(|owed| {
                owed.kind == dohc_engine_collab::markdown_write_obligations::Kind::SyncProjection
            })
            .collect();
        assert_eq!(sync.len(), 1);
        assert!(sync[0].held_checkpoint_sha256.is_some());
        assert_eq!(sync[0].operation_id, format!("{PEER}:1"));
    }
    let mut record_events = Vec::new();
    while let Ok(event) = events.try_recv() {
        assert_ne!(event.name, AUTOMATION_CLAIMED_EVENT);
        if event.name.starts_with("record.") {
            record_events.push(event);
        }
    }
    assert_eq!(
        record_events
            .iter()
            .map(|event| event.name.as_str())
            .collect::<Vec<_>>(),
        vec![RECORD_FIELD_CHANGED_EVENT, RECORD_UPDATED_EVENT]
    );
    for event in &record_events {
        assert_eq!(event.payload["workspaceId"], json!(WS));
        assert_eq!(event.payload["collectionPath"], json!("tasks"));
        assert_eq!(event.payload["recordId"], json!(RECORD));
        assert_eq!(
            event.payload["source"],
            json!({"originId":PEER, "originSeq":1})
        );
    }
    assert_eq!(record_events[0].payload["field"], json!("status"));
    assert_eq!(record_events[0].payload["previous"], json!("open"));
    assert_eq!(record_events[0].payload["next"], json!("remote"));

    let (_, retried) = service
        .ydoc_resync(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":id}),
            3,
        )
        .await
        .unwrap();
    let retried_doc = Ydoc::wire();
    retried_doc.apply(&retried.bytes).unwrap();
    drop(retried);
    assert_eq!(
        retried_doc.project(ContentKind::Richdoc).unwrap().content,
        projection
    );
    let held = service
        .ydoc_settle(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":id}),
        )
        .await
        .unwrap_err();
    assert_eq!(held.message, "markdown-write-held");
    assert_eq!(counts(), accepted);
    while let Ok(event) = events.try_recv() {
        assert!(
            !event.name.starts_with("record."),
            "no duplicate event: {event:?}"
        );
        assert_ne!(event.name, AUTOMATION_CLAIMED_EVENT);
    }
    assert_eq!(std::fs::read(&file).unwrap(), source.as_bytes());
    assert_eq!(
        std::fs::metadata(&file).unwrap().modified().unwrap(),
        modified
    );
    let store = EngineStore::open_read_only(&db).unwrap();
    assert_eq!(
        dohc_engine_collab::read_last_settled_sha(&store, &key).unwrap(),
        Some(hex_sha256(source.as_bytes()))
    );
    drop(store);
    drop(recovery_gate);
    service.workspace_close(Some(handle)).await.unwrap();
}
