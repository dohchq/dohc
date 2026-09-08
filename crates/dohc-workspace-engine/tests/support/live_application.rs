use dohc_engine_collab::live_object_binding::LiveObjectBinding;
use dohc_engine_collab::live_update_application::ApplicationHostCoordinate;
use dohc_engine_collab::{ContentKind, DocKey, Regime, Ydoc, durable};
use dohc_engine_protocol::transport::{ConnectionOwner, EngineService as _, RequestContext};
use dohc_engine_protocol::wire::Request;
use dohc_engine_storage::{
    EngineStore, NoFaults, StorageError, hex_sha256, put_binary_blob_with_sha,
};
use dohc_engine_testkit::ScratchDir;
use dohc_workspace_engine::live_application_ingress::LiveApplicationIngressConfig;
use dohc_workspace_engine::{EngineService, LiveApplicationHostConfig};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
pub async fn fixture() -> (
    ScratchDir,
    Arc<EngineService>,
    ConnectionOwner,
    String,
    u64,
    LiveObjectBinding,
) {
    let scratch = ScratchDir::new().unwrap();
    let db = scratch.path().join(".dohc/engine/engine.db");
    std::fs::create_dir_all(db.parent().unwrap()).unwrap();
    let mut store = EngineStore::open(&db, 0).unwrap();
    let root_token =
        dohc_workspace_engine::root_binding::write_new_root_binding(scratch.path()).unwrap();
    store.bind_root_token(&root_token, &NoFaults).unwrap();
    dohc_engine_domain::VersionedTextStore::new(&mut store)
        .ensure_main_version("workspace", "main", 0, &NoFaults)
        .unwrap();
    let baseline = Ydoc::wire().encode_full_state();
    let binding = LiveObjectBinding {
        workspace_id: "workspace".into(),
        main_version_id: "main".into(),
        object_id: "one".into(),
        lineage_claim_id: hex_sha256(&baseline),
        current_path: "one.md".into(),
        selector_paths: vec!["one.md".into()],
        restore_fence_generation: 0,
    };
    store.write_with(&NoFaults, |tx| {
            tx.execute("INSERT INTO file_objects(workspace_id,object_id,created_at_ms) VALUES ('workspace','one',0)", []).unwrap();
            put_binary_blob_with_sha(tx, &baseline, &binding.lineage_claim_id).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
    durable::ensure_marker(
        &mut store,
        &DocKey::new("workspace", "main", "one").unwrap(),
        ContentKind::Plaintext,
        Regime::Replicated,
        &NoFaults,
        0,
    )
    .unwrap();
    store.write_with(&NoFaults, |tx| {
            tx.execute("UPDATE ydoc_docs SET lineage_claim_status='exact',lineage_claim_id=?1,path='one.md'", [&binding.lineage_claim_id]).unwrap();
            Ok::<_, StorageError>(())
        }).unwrap();
    drop(store);
    let service = Arc::new(EngineService::new());
    let response = service.call(RequestContext::unbounded(), Request { id: 1, method: "workspace.open".into(), workspace: None, deadline_ms: None, idempotency_key: None, params: json!({ "rootDir": scratch.path(), "workspaceId": "workspace", "captureMode": "none" }) }).await.unwrap();
    let workspace = response.response.result["workspace"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = ConnectionOwner::authenticated();
    service
        .provision_live_application(
            owner.handle(),
            LiveApplicationHostConfig {
                workspace: dohc_engine_protocol::wire::WorkspaceHandle(workspace.clone()),
                namespace: "relay-history".into(),
                coordinate: ApplicationHostCoordinate {
                    host_id: "host".into(),
                    host_epoch: 1,
                    instance_id: "instance".into(),
                    connection_id: "connection".into(),
                },
                max_registrations: 4,
            },
        )
        .await
        .unwrap();
    let mut ctx = RequestContext::unbounded();
    ctx.connection = Some(owner.handle());
    let registration = service
        .call(
            ctx,
            Request {
                id: 2,
                method: "liveApplication.register".into(),
                workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
                    workspace.clone(),
                )),
                deadline_ms: None,
                idempotency_key: None,
                params: json!({ "binding": binding }),
            },
        )
        .await
        .unwrap();
    let id = registration.response.result["registrationId"]
        .as_u64()
        .unwrap();
    (scratch, service, owner, workspace, id, binding)
}

pub fn config() -> LiveApplicationIngressConfig {
    LiveApplicationIngressConfig {
        aggregate_bytes: 512 * 1024 * 1024,
        application_working_reserve_bytes: 32 * 1024 * 1024,
        max_uploads: 2,
        upload_deadline: Duration::from_secs(30),
    }
}

pub fn request(
    workspace: &str,
    registration: u64,
    binding: &LiveObjectBinding,
    bytes: &[u8],
    ranges: &[u8],
) -> Request {
    Request {
        id: 3,
        method: "liveApplication.apply".into(),
        workspace: Some(dohc_engine_protocol::wire::WorkspaceHandle(
            workspace.into(),
        )),
        deadline_ms: Some(30_000),
        idempotency_key: None,
        params: json!({
            "accepted": { "receipt": { "deliveryId": "delivery", "updateDigest": hex_sha256(bytes), "journalCursor": 1, "acceptingHostEpoch": 1 }, "binding": binding, "authority": { "principalKind": "owner", "principalId": "owner", "grantId": null, "grantGeneration": null }, "receivedAtMs": 0 },
            "registrationId": registration, "rangeCount": ranges.len()/16, "rangeStreamId": 2, "rangeDigest": hex_sha256(ranges), "updateStreamId": 1, "updateByteLength": bytes.len(),
        }),
    }
}
