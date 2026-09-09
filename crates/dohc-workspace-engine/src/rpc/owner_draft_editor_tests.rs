use super::*;
use dohc_engine_collab::{Ydoc, owner_outbox::draft::*};
use dohc_engine_protocol::wire::Request;
use dohc_engine_storage::{EngineStore, hex_sha256};

#[tokio::test]
async fn observed_editor_reopens_pending_work_without_publishing_it() {
    let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
    let config = serde_json::from_value(json!({
        "ingress":{"aggregateBytes":1_000_000_000,"applicationWorkingReserveBytes":1_000_000,"maxUploads":2,"uploadDeadlineMs":30_000},
        "maxRegistrations":2,"maxAdoptionBytes":1_000_000,"maxAdoptionEvents":100,
        "maxApplicationsPerSettlement":100,
        "ownerOutbox":{"maxPendingBytes":1_000_000,"maxPendingAgeMs":100_000},
        "sync":{"policy":{"maxClientVectorBytes":100_000,"maxHostVectorBytes":100_000,"maxOutputBytes":1_000_000,"maxReadBytes":4_000_000},"workingReserveBytes":4_000_000}
    })).unwrap();
    let (service, connection, _ingress) = EngineService::ordinary_live_host(config).unwrap();
    let params = json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":"workspace","captureMode":"none"});
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params.clone())
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    service.workspace_close(Some(handle)).await.unwrap();
    let db = scratch.path().join(".dohc/engine/engine.db");
    let source: Value = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
    ))
    .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(source["bytes"].clone()).unwrap();
    let text = source["markdown"].as_str().unwrap();
    let key = DocKey::new("workspace", "main", "object").unwrap();
    let binding = dohc_engine_collab::LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: hex_sha256(&bytes),
        current_path: "owner.md".into(),
        selector_paths: vec!["owner.md".into()],
        restore_fence_generation: 0,
    };
    let before;
    {
        let mut store = EngineStore::open(&db, 0).unwrap();
        let mut versions = dohc_engine_domain::VersionedTextStore::new(&mut store);
        versions
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        versions
            .write_text(
                &dohc_engine_domain::WriteText {
                    workspace_id: "workspace".into(),
                    version_id: "main".into(),
                    object_id: "object".into(),
                    path: "owner.md".into(),
                    text: text.into(),
                    moment_id: "original".into(),
                    metadata_origin: "test".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1,
                    request_id: None,
                },
                &NoFaults,
            )
            .unwrap();
        dohc_engine_collab::claim_base(
            &mut store,
            &key,
            ContentKind::Richdoc,
            &bytes,
            &NoFaults,
            2,
        )
        .unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        let checkpoint = doc.encode_full_state();
        store
            .write_with(&NoFaults, |tx| {
                tx.execute("UPDATE ydoc_docs SET path='owner.md'", [])
                    .unwrap();
                install_observed_binding_in_tx(
                    tx,
                    "workspace",
                    &ObservedOwnerBinding {
                        binding: binding.clone(),
                        relay_database_namespace: "relay".into(),
                        revision: 1,
                        accepted_cursor: 0,
                        native_head_sequence: 0,
                        checkpoint_digest: hex_sha256(&checkpoint),
                        limits: dohc_engine_collab::OwnerOutboxLimits {
                            max_pending_bytes: 1_000_000,
                            max_pending_age_ms: 100_000,
                        },
                    },
                    &checkpoint,
                )
            })
            .unwrap();
        before = store.table_row_count("moments").unwrap();
    }
    std::fs::write(scratch.path().join("owner.md"), text).unwrap();
    let opened = service
        .workspace_open(&RequestContext::unbounded(), params)
        .await
        .unwrap();
    let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
    let open_params = json!({"versionId":"main","path":"owner.md","contentKind":"richdoc"});
    let (opened, blob) = service
        .ydoc_open(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            open_params.clone(),
            1,
        )
        .await
        .unwrap();
    assert_eq!(opened["ownerDraft"]["pendingBytes"], 0);
    let doc = Ydoc::wire();
    doc.apply(&blob.bytes).unwrap();
    drop(blob);
    let update = doc.richdoc_append_paragraph("durable pending edit");
    let sid = opened["sessionId"].as_str().unwrap();
    let record = json!({"sessionId":sid,"updateBase64":base64::engine::general_purpose::STANDARD.encode(&update)});
    let result = service
        .ydoc_record_update(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            Some("edit-1".into()),
            record.clone(),
        )
        .await
        .unwrap();
    assert!(result.get("seq").is_none());
    assert_eq!(result["ownerDraft"]["sequence"], 1);
    assert_eq!(
        result,
        service
            .ydoc_record_update(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                Some("edit-1".into()),
                record
            )
            .await
            .unwrap()
    );
    let error = service
        .ydoc_settle(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":sid}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, "owner-outbox-frozen");
    // Exercise the authenticated owner RPC while this real native editor stays open.
    let mut events = service.events.subscribe();
    let remote = Ydoc::wire();
    remote.apply(&bytes).unwrap();
    let update = remote.richdoc_append_paragraph("accepted peer edit");
    doc.apply(&update).unwrap();
    let mut ctx = RequestContext::unbounded();
    ctx.connection = Some(connection.handle());
    let input = crate::rpc::owner_delivery::OwnerInput {
        params: crate::rpc::owner_delivery::OwnerUpload::Accepted(
            crate::rpc::owner_delivery::OwnerUploadParams {
                binding: binding.clone(),
                relay_database_namespace: "relay".into(),
                expected_revision: 1,
                expected_native_head_sequence: 0,
                previous_accepted_cursor: 0,
                journal_cursor: 1,
                stream_id: 4,
                byte_length: update.len(),
                digest: hex_sha256(&update),
                host_vector_byte_length: None,
            },
        ),
        bytes: update,
        reservation: service.reserve_owner_delivery().unwrap(),
    };
    let response = service
        .owner_delivery_apply(
            ctx,
            Request {
                id: 4,
                method: "ydoc.ownerDelivery.applyAcceptedFrame".into(),
                workspace: Some(handle.clone()),
                deadline_ms: None,
                idempotency_key: None,
                params: json!({}),
            },
            input,
        )
        .await
        .unwrap();
    assert_eq!(response.response.result["acceptedCursor"], 1);
    let notice = events.try_recv().unwrap();
    assert_eq!(notice.name, "ydoc.remoteUpdate");
    assert_eq!(
        notice.payload,
        json!({"sessionId":sid,"resyncRequired":true})
    );
    assert!(events.try_recv().is_err());
    drop(response);
    let (_, resync) = service
        .ydoc_resync(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":sid}),
            2,
        )
        .await
        .unwrap();
    let resumed = Ydoc::wire();
    resumed.apply(&resync.bytes).unwrap();
    drop(resync);
    assert_eq!(
        resumed.project(ContentKind::Richdoc).unwrap().content,
        doc.project(ContentKind::Richdoc).unwrap().content
    );
    service
        .ydoc_close(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":sid,"settle":false}),
        )
        .await
        .unwrap();
    let (_, reopen) = service
        .ydoc_open(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            open_params,
            3,
        )
        .await
        .unwrap();
    let reopened_doc = Ydoc::wire();
    reopened_doc.apply(&reopen.bytes).unwrap();
    drop(reopen);
    assert_eq!(
        reopened_doc.project(ContentKind::Richdoc).unwrap().content,
        doc.project(ContentKind::Richdoc).unwrap().content
    );
    service.workspace_close(Some(handle)).await.unwrap();
    let store = EngineStore::open(&db, 40).unwrap();
    assert_eq!(store.table_row_count("moments").unwrap(), before);
    assert_eq!(store.table_row_count("replication_log").unwrap(), 0);
    assert_eq!(
        std::fs::read_to_string(scratch.path().join("owner.md")).unwrap(),
        text
    );
    assert_eq!(
        dohc_engine_collab::read_marker(&store, &key)
            .unwrap()
            .unwrap()
            .head_update_seq,
        1
    );
}
