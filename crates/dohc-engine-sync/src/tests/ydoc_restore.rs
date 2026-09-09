use super::*;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    ApplicationHostCoordinate, ApplicationOwner, LiveApplicationBootstrap, NativeRestoreFence,
    RestoreDeliveryOrigin, bootstrap_committed,
};
use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
use dohc_engine_storage::hex_sha256;

#[test]
fn stopped_remote_update_retains_bytes_and_advances_with_classified_refusal() {
    let (_scratch, path, mut store) = open_store();
    VersionedTextStore::new(&mut store)
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
        "../../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
    ))
    .unwrap();
    let vector = vectors
        .iter()
        .find(|v| v["registrationAccepted"] == true)
        .unwrap();
    let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
    let markdown = vector["markdown"].as_str().unwrap();
    let coordinate = ApplicationHostCoordinate {
        host_id: "host".into(),
        host_epoch: 1,
        instance_id: "instance".into(),
        connection_id: "connection".into(),
    };
    let binding = LiveObjectBinding {
        workspace_id: "ws".into(),
        main_version_id: "main".into(),
        object_id: "object".into(),
        lineage_claim_id: hex_sha256(&bytes),
        current_path: "note.md".into(),
        selector_paths: vec!["note.md".into()],
        restore_fence_generation: 0,
    };
    let mut owner = ApplicationOwner::new("ws".into()).unwrap();
    let handle = owner
        .register(
            &mut store,
            "relay".into(),
            coordinate.clone(),
            binding.clone(),
        )
        .unwrap();
    let mut cache = WriterDocCache::new();
    bootstrap_committed::<Box<dyn std::error::Error>>(
        &mut store,
        &mut cache,
        &handle,
        LiveApplicationBootstrap {
            bootstrap_id: "bootstrap".into(),
            bootstrap_moment_id: "bootstrap-moment".into(),
            baseline_moment_relay_sequence: 0,
            baseline_registered_at_ms: 100,
            baseline_digest: binding.lineage_claim_id.clone(),
            baseline_byte_length: bytes.len() as i64,
            projected_markdown_digest: hex_sha256(markdown.as_bytes()),
            projected_markdown_byte_length: markdown.len() as i64,
        },
        bytes.clone(),
        &NoFaults,
        |_, _, _, _| Ok(()),
    )
    .unwrap();
    let operation = NativeRestoreFence {
        operation_id: "restore".into(),
        relay_database_namespace: "relay".into(),
        old_binding: binding.clone(),
        host_id: "host".into(),
        new_fence: 1,
        origin: RestoreDeliveryOrigin::Bootstrap {
            id: "bootstrap".into(),
        },
        terminal: None,
        applied_sequence: 0,
    };
    let receipt = owner
        .fence_restore(
            &mut store,
            operation.clone(),
            coordinate.clone(),
            200,
            &NoFaults,
        )
        .unwrap();
    let peer = Ydoc::wire();
    peer.apply(&bytes).unwrap();
    peer.rewrite_content_to_markdown(ContentKind::Richdoc, "pending remote edit")
        .unwrap();
    let pending = peer.encode_full_state();
    let pending_sha = store.put_binary_blob(&pending).unwrap();
    let update = envelope(
        "stopped-peer",
        0,
        "ydoc.update",
        json!({
            "versionId":"main", "objectId":"object", "path":"note.md", "contentKind":"richdoc",
            "updateBlobSha256":pending_sha, "lineageClaimId":binding.lineage_claim_id, "isBaseState":false
        }),
    );
    #[cfg(feature = "fault-injection")]
    {
        let faults = ScriptedFaults::crash_at(FaultPoint::SyncBeforeApplyCommit);
        assert!(matches!(
            apply_ydoc_envelope(
                &mut store,
                &mut cache,
                &update,
                faults.as_ref(),
                &NoLiveLeases
            )
            .unwrap()
            .primary,
            ApplyDisposition::Crashed { committed: false }
        ));
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "stopped-peer").unwrap(),
            -1
        );
        assert_eq!(
            store
                .table_row_count("replication_refused_ydoc_blobs")
                .unwrap(),
            0
        );
    }
    for attempt in 0..2 {
        let result =
            apply_ydoc_envelope(&mut store, &mut cache, &update, &NoFaults, &NoLiveLeases).unwrap();
        if attempt == 0 {
            assert!(
                matches!(result.primary, ApplyDisposition::Refused(ref refusal)
                if refusal.reason.message() == crate::ydoc_apply::LIVE_UNADMITTED_UPDATE)
            );
        } else {
            assert!(matches!(result.primary, ApplyDisposition::Skipped));
        }
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "stopped-peer").unwrap(),
            0
        );
        assert_eq!(
            store
                .read_with(|conn| dohc_engine_storage::get_binary_blob(conn, &pending_sha))
                .unwrap(),
            Some(pending.clone())
        );
        let canonical = dohc_engine_collab::load_persisted(
            &store,
            &DocKey::new("ws", "main", "object").unwrap(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            canonical.doc.project(ContentKind::Richdoc).unwrap().content,
            markdown
        );
        assert_eq!(
            owner
                .fence_restore(
                    &mut store,
                    operation.clone(),
                    coordinate.clone(),
                    201,
                    &NoFaults
                )
                .unwrap(),
            receipt
        );
    }
    store.read_with(|conn| {
        let retained: String = conn.query_row("SELECT update_sha256 FROM replication_refused_ydoc_blobs WHERE workspace_id='ws' AND origin_id='stopped-peer' AND origin_seq=0", [], |r| r.get(0))?;
        assert_eq!(retained, pending_sha);
        assert!(conn.execute("DELETE FROM binary_blobs WHERE sha256=?1", [&pending_sha]).is_err());
        Ok::<_,rusqlite::Error>(())
    }).unwrap();
    let echo = envelope(
        "base-echo",
        0,
        "ydoc.update",
        json!({
            "versionId":"main","objectId":"object","path":"note.md","contentKind":"richdoc",
            "updateBlobSha256":binding.lineage_claim_id,"lineageClaimId":binding.lineage_claim_id,"isBaseState":true
        }),
    );
    let before = store.table_row_count("ydoc_updates").unwrap();
    assert!(
        matches!(apply_ydoc_envelope(&mut store,&mut cache,&echo,&NoFaults,&NoLiveLeases).unwrap().primary,
        ApplyDisposition::Applied(ref result) if result.reason == Some("native-live-content-echo"))
    );
    assert_eq!(store.table_row_count("ydoc_updates").unwrap(), before);
    assert!(
        crate::ydoc_apply::redelivered_materialization_changes(&store, &echo)
            .unwrap()
            .is_empty()
    );
    // A page admitted under an earlier ordinary lease can still be queued
    // when the native live binding becomes known.
    let mut queued = envelope("queued-peer", 0, "ydoc.update", update.payload.clone());
    queued.payload["lineageClaimId"] = json!("f".repeat(64));
    crate::apply_envelope_with(&mut store,&queued,&NoFaults,|tx,op| {
        tx.execute("INSERT INTO ydoc_deferred_updates(workspace_id,version_id,object_id,origin_id,origin_seq,recorded_at_ms,lineage_claim_id,relay_seq)
          VALUES ('ws','main','object',?1,?2,?3,?4,?5)",params![op.origin_id,op.origin_seq,op.recorded_at_ms,op.payload["lineageClaimId"].as_str().unwrap(),op.relay_seq]).map_err(SyncError::persist)?;
        Ok(())
    }).unwrap();
    let drained = drain_deferred_ydoc_for_live_session(
        &mut store,
        &mut cache,
        &DocKey::new("ws", "main", "object").unwrap(),
        Some(&binding.lineage_claim_id),
        &NoFaults,
    )
    .unwrap();
    assert_eq!(drained.refusals.len(), 1);
    assert_eq!(
        drained.refusals[0].reason.message(),
        crate::ydoc_apply::LIVE_UNADMITTED_UPDATE
    );
    assert_eq!(store.table_row_count("ydoc_deferred_updates").unwrap(), 0);
    assert_eq!(store.table_row_count("ydoc_updates").unwrap(), before);
    drop(store);
    let mut store = EngineStore::open(&path, 3000).unwrap();
    assert_eq!(
        store
            .table_row_count("replication_refused_ydoc_blobs")
            .unwrap(),
        2
    );
    assert_eq!(store.get_binary_blob(&pending_sha).unwrap(), Some(pending));
    let mut conflicting = update.clone();
    conflicting.payload["path"] = json!("different.md");
    assert!(matches!(
        apply_ydoc_envelope(
            &mut store,
            &mut cache,
            &conflicting,
            &NoFaults,
            &NoLiveLeases
        ),
        Err(SyncError::CoordinateDiverged)
    ));
}
