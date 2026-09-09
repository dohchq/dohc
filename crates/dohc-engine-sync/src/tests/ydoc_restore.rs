use super::*;
use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::{
    ApplicationHostCoordinate, ApplicationOwner, LiveApplicationBootstrap, NativeRestoreFence,
    RestoreDeliveryOrigin, bootstrap_committed,
};
use dohc_engine_collab::{ContentKind, DocKey, WriterDocCache, Ydoc};
use dohc_engine_storage::hex_sha256;

#[test]
fn stopped_remote_update_retains_bytes_without_reporting_storage_corruption() {
    let (_scratch, _path, mut store) = open_store();
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
    let before_ack = read_replication_acked_seq(&store, "ws", "stopped-peer").unwrap();
    for _ in 0..2 {
        let error = apply_ydoc_envelope(&mut store, &mut cache, &update, &NoFaults, &NoLiveLeases)
            .unwrap_err();
        assert!(
            matches!(
                error,
                SyncError::RetryableState {
                    reason: "live document is stopped"
                }
            ),
            "{error:?}"
        );
        assert_eq!(
            read_replication_acked_seq(&store, "ws", "stopped-peer").unwrap(),
            before_ack
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
}
