use super::*;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    ApplicationHostCoordinate, ApplicationOwner, LiveApplicationBootstrap, bootstrap_committed,
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
    store
        .write_with(&NoFaults, |tx| {
            tx.execute(
                "INSERT INTO live_restore_fences(workspace_id,main_version_id,object_id,relay_database_namespace,operation_id,input_json,receipt_json) VALUES ('ws','main','object','relay','restore',?1,'{}')",
                [json!({"oldBinding":binding,"newFence":1}).to_string()],
            )
            .map_err(SyncError::persist)
        })
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

fn pruned_marker_matches(store: &mut EngineStore, setup: &str) -> bool {
    let key = DocKey::new("ws", "main", "note").unwrap();
    let outcome = store
        .write_with(&NoFaults, |tx| {
            tx.execute_batch(setup).map_err(SyncError::persist)?;
            let unheld_digest = "0".repeat(64);
            crate::current_ydoc_content_matches_in_tx(tx, &key, "note.md", &unheld_digest)
        })
        .unwrap();
    outcome == TxnOutcome::Committed(true)
}

#[test]
fn restore_guard_treats_a_pruned_local_only_marker_as_no_live_state() {
    let (_scratch, _path, mut store) = open_store();
    let mut files = VersionedTextStore::new(&mut store);
    files
        .ensure_main_version("ws", "main", 0, &NoFaults)
        .unwrap();
    files
        .write_text(
            &dohc_engine_domain::WriteText {
                workspace_id: "ws".into(),
                version_id: "main".into(),
                object_id: "note".into(),
                moment_id: "moment".into(),
                path: "note.md".into(),
                text: "# Plan\n".into(),
                metadata_origin: "local-file".into(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 1,
                request_id: None,
            },
            &NoFaults,
        )
        .unwrap();
    assert!(pruned_marker_matches(
        &mut store,
        "INSERT INTO ydoc_docs(workspace_id,version_id,object_id,content_kind,regime,lineage_claim_status,updated_at_ms,path) \
         VALUES ('ws','main','note','richdoc','local-only','unclaimed',1,'note.md')",
    ));
    assert!(!pruned_marker_matches(
        &mut store,
        "UPDATE ydoc_docs SET settle_prior_update_seq=-1"
    ));
    assert!(pruned_marker_matches(
        &mut store,
        "UPDATE ydoc_docs SET settle_prior_update_seq=NULL"
    ));
    let base = store.put_binary_blob(b"base").unwrap();
    assert!(!pruned_marker_matches(
        &mut store,
        &format!(
            "INSERT INTO owner_ydoc_outboxes(outbox_id,workspace_id,main_version_id,object_id,lineage_claim_id,current_path,selector_paths_json,restore_fence_generation,base_update_digest,base_blob_digest,base_byte_length,state,pending_bytes,next_sequence,created_at_ms) \
             VALUES ('outbox','ws','main','note','{base}','note.md','[\"note.md\"]',0,'{base}','{base}',4,'active',0,1,1)"
        ),
    ));
}
