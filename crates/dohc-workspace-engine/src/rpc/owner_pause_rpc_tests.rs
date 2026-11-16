use super::*;
use dohc_engine_collab::{Ydoc, owner_outbox::draft::*};
use dohc_engine_protocol::wire::Request;
use dohc_engine_storage::{EngineStore, hex_sha256};

fn request(id: u64, method: &str, handle: &WorkspaceHandle, params: Value) -> Request {
    Request {
        id,
        method: method.into(),
        workspace: Some(handle.clone()),
        deadline_ms: None,
        idempotency_key: None,
        progress: false,
        params,
    }
}

/// A collaborator's committed row reaches the owner's editor and never the
/// note. The pause keeps the owner's screen in a copy, releases the note at
/// its applied cursor, and Resume's clear frees the copy.
#[tokio::test]
async fn committed_row_shows_to_the_owner_and_the_pause_keeps_it_in_a_copy() {
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
            open_params,
            1,
        )
        .await
        .unwrap();
    let doc = Ydoc::wire();
    doc.apply(&blob.bytes).unwrap();
    drop(blob);
    let sid = opened["sessionId"].as_str().unwrap().to_owned();
    let claim = opened["lineageClaimId"].as_str().unwrap().to_owned();
    let typed = doc.richdoc_append_paragraph("Typed by the owner");
    let recorded = service
        .ydoc_record_update(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            Some("edit-1".into()),
            json!({
                "sessionId":sid,
                "updateBase64":base64::engine::general_purpose::STANDARD.encode(&typed),
                "expectedLineageClaimId":claim,
                "actorOriginId":"local-person",
                "attribution":{"actorKind":"human","onBehalfOf":"local-person"}
            }),
        )
        .await
        .unwrap();

    // Only the owner's delivery connection may say the relay took an edit.
    let draft = &recorded["ownerDraft"];
    let taken = json!({"outboxId":draft["outboxId"],"receipt":{
        "deliveryId":draft["deliveryId"],"updateDigest":draft["updateDigest"],
        "journalCursor":7,"acceptingHostEpoch":1}});
    let mut elsewhere = RequestContext::unbounded();
    for connection in [
        None,
        Some(dohc_engine_protocol::transport::ConnectionOwner::authenticated()),
    ] {
        elsewhere.connection = connection.as_ref().map(|owner| owner.handle());
        let refused = service
            .owner_ydoc_outbox_acknowledge_taken(&elsewhere, Some(handle.clone()), taken.clone())
            .await
            .unwrap_err();
        assert_eq!(refused.message, workspace_unavailable().message);
    }

    // The row reaches the editor through a resync, and the editor shows it.
    let mut events = service.events.subscribe();
    let collaborator = Ydoc::wire();
    collaborator.apply(&bytes).unwrap();
    let row = collaborator.richdoc_append_paragraph("Committed by a collaborator");
    let mut ctx = RequestContext::unbounded();
    ctx.connection = Some(connection.handle());
    ctx.capabilities = std::sync::Arc::from(vec!["blobs".to_owned()]);
    let put = |cursor: i64, row: Vec<u8>| {
        crate::rpc::owner_delivery::OwnerInput {
        params: crate::rpc::owner_delivery::OwnerUpload::parse(
            "ydoc.ownerDelivery.putCommittedRow",
            json!({"binding":binding,"cursor":cursor,"streamId":5,"byteLength":row.len(),"digest":hex_sha256(&row)}),
        )
        .unwrap(),
        bytes: row,
        reservation: service.reserve_owner_delivery().unwrap(),
    }
    };
    let put_request = request(5, "ydoc.ownerDelivery.putCommittedRow", &handle, json!({}));
    let response = service
        .owner_delivery_apply(ctx.clone(), put_request.clone(), put(5, row.clone()))
        .await
        .unwrap();
    assert_eq!(response.response.result, json!({"outcome":"added"}));
    drop(response);
    let notice = events.try_recv().unwrap();
    assert_eq!(
        notice.payload,
        json!({"sessionId":sid,"resyncRequired":true})
    );
    let response = service
        .owner_delivery_apply(ctx.clone(), put_request, put(5, row))
        .await
        .unwrap();
    assert_eq!(response.response.result, json!({"outcome":"unchanged"}));
    drop(response);
    assert!(events.try_recv().is_err());
    let (_, shown) = service
        .ydoc_resync(
            &RequestContext::unbounded(),
            Some(handle.clone()),
            json!({"sessionId":sid}),
            2,
        )
        .await
        .unwrap();
    let screen = Ydoc::wire();
    screen.apply(&shown.bytes).unwrap();
    drop(shown);
    let screen = screen.project(ContentKind::Richdoc).unwrap().content;
    assert!(screen.contains("Committed by a collaborator"));
    assert!(screen.contains("Typed by the owner"));
    let note = || std::fs::read_to_string(scratch.path().join("owner.md")).unwrap();
    assert!(!note().contains("Committed by a collaborator"));

    // The pause keeps that screen in the copy's blob and settles the note
    // from A, which holds neither.
    let paused = service
        .owner_ydoc_stop(
            &ctx,
            Some(handle.clone()),
            json!({"binding":binding,"appliedCursor":0,"rowCursor":5,"copyPath":"owner (unsaved edits).md"}),
            "pause",
        )
        .await
        .unwrap();
    let stop = &paused["stops"][0];
    assert_eq!(stop["state"], "released");
    assert_eq!(
        stop["paused"],
        json!({"appliedCursor":0,"rowCursor":5,"copyPath":"owner (unsaved edits).md","copyWritten":false,"leftOut":false})
    );
    assert!(!note().contains("Committed by a collaborator"));
    assert!(!note().contains("Typed by the owner"));
    let copy = service
        .owner_delivery_paused_copy(
            ctx.clone(),
            request(
                6,
                "ydoc.ownerDelivery.pausedCopy",
                &handle,
                json!({"mainVersionId":"main","objectId":"object"}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(copy.response.result["status"], "copy");
    let copied = String::from_utf8(copy.blob_egress.as_ref().unwrap().bytes.clone()).unwrap();
    assert!(copied.contains("Committed by a collaborator"));
    assert!(copied.contains("Typed by the owner"));
    drop(copy);

    // Stop leaves a paused note as it is; recording the file and then the
    // clear Resume runs free the copy.
    let stopped = service
        .owner_ydoc_stop(
            &ctx,
            Some(handle.clone()),
            json!({"path":"owner.md"}),
            "request",
        )
        .await
        .unwrap();
    assert_eq!(stopped["stops"][0]["paused"], stop["paused"]);
    let written = service
        .owner_ydoc_stop(
            &ctx,
            Some(handle.clone()),
            json!({"mainVersionId":"main","objectId":"object","copyPath":"owner (unsaved edits).md"}),
            "copyWritten",
        )
        .await
        .unwrap();
    assert_eq!(written["stops"][0]["paused"]["copyWritten"], true);
    service
        .owner_ydoc_stop(
            &ctx,
            Some(handle.clone()),
            json!({"path":"owner.md"}),
            "clear",
        )
        .await
        .unwrap();
    let copy = service
        .owner_delivery_paused_copy(
            ctx,
            request(
                7,
                "ydoc.ownerDelivery.pausedCopy",
                &handle,
                json!({"mainVersionId":"main","objectId":"object"}),
            ),
        )
        .await
        .unwrap();
    assert_eq!(copy.response.result, json!({"status":"empty","stop":null}));
}
