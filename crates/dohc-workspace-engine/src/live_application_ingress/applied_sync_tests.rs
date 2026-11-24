use super::*;
use crate::lock;
use dohc_engine_collab::{ContentKind, Ydoc};
use dohc_engine_protocol::transport::{ConnectionOwner, EngineService as _, RequestContext};
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
use dohc_engine_testkit::ScratchDir;
use serde_json::{Value, json};

#[tokio::test]
async fn applied_sync_rpc_streams_one_atomic_cut_and_guarded_next_update() {
    let mut f = Fixture::new().await;
    let vector = [0u8];
    let request=f.request("liveApplication.syncOpen",json!({"registrationId":f.registration,"streamId":100,"byteLength":1,"digest":hex_sha256(&vector)}));
    let opened = f.upload(request, 100, &vector).await;
    assert_eq!(opened.response.result["status"], "sync");
    let bytes = &opened.blob_egress.as_ref().unwrap().bytes;
    let vector_length = opened.response.result["hostVectorByteLength"]
        .as_u64()
        .unwrap() as usize;
    let peer = Ydoc::wire();
    peer.apply(&bytes[vector_length..]).unwrap();
    assert_eq!(peer.canonical_content(), f.doc.canonical_content());
    assert_eq!(opened.response.result["observedLocalYDocHeadSequence"], 0);
    let position = opened.response.result["position"].clone();
    let empty = f
        .control(
            "liveApplication.appliedRead",
            json!({"registrationId":f.registration,"after":position}),
        )
        .await;
    assert_eq!(empty.response.result["status"], "empty");
    assert!(empty.blob_egress.is_none());
    drop(empty);
    f.id = 150;
    f.edit("applied after sync cut").await;
    let update = f
        .control(
            "liveApplication.appliedRead",
            json!({"registrationId":f.registration,"after":position}),
        )
        .await;
    assert_eq!(update.response.result["status"], "update");
    assert_eq!(update.response.result["position"]["eventCount"], 1);
    assert_eq!(
        update.response.result["ack"]["journalCursor"],
        f.terminal["journalCursor"]
    );
    peer.apply(&update.blob_egress.as_ref().unwrap().bytes)
        .unwrap();
    assert_eq!(peer.canonical_content(), f.doc.canonical_content());
    let blocked = f.request(
        "liveApplication.appliedRead",
        json!({"registrationId":f.registration,"after":position}),
    );
    assert!(f.service.call(f.context(), blocked).await.is_err());
    drop(update);
    let replay = f
        .control(
            "liveApplication.appliedRead",
            json!({"registrationId":f.registration,"after":position}),
        )
        .await;
    assert_eq!(replay.response.result["position"]["eventCount"], 1);
    drop(replay);
    drop(opened);
    f.close().await;
}

struct Fixture {
    _scratch: ScratchDir,
    service: Arc<EngineService>,
    owner: ConnectionOwner,
    ingress: LiveApplicationIngress,
    workspace: WorkspaceHandle,
    binding: Value,
    id: u64,
    doc: Ydoc,
    registration: Value,
    terminal: Value,
}
impl Fixture {
    async fn new() -> Self {
        let scratch = ScratchDir::new().unwrap();
        let db = scratch.path().join(".dohc/engine/engine.db");
        std::fs::create_dir_all(db.parent().unwrap()).unwrap();
        let mut store = EngineStore::open(&db, 0).unwrap();
        let root_token = crate::root_binding::write_new_root_binding(scratch.path()).unwrap();
        store.bind_root_token(&root_token, &NoFaults).unwrap();
        dohc_engine_domain::VersionedTextStore::new(&mut store)
            .ensure_main_version("workspace", "main", 0, &NoFaults)
            .unwrap();
        drop(store);
        let config = serde_json::from_value(json!({
            "version":1,"relayNamespace":"namespace",
            "host":{"hostId":"host","hostEpoch":1,"instanceId":"instance","connectionId":"connection"},
            "workspaces":[{"root":scratch.path(),"workspaceId":"workspace","maxRegistrations":4}],
            "ingress":{"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":32*1024*1024,"maxUploads":2,"uploadDeadlineMs":30_000},
            "sync":{"policy":{"maxClientVectorBytes":1024,"maxHostVectorBytes":4096,"maxOutputBytes":1_000_000,"maxReadBytes":10_000_000},"workingReserveBytes":16*1024*1024}
        })).unwrap();
        let (service, owner, ingress) = EngineService::configured_live_host(config).await.unwrap();
        let workspace = lock(&service.handles).keys().next().unwrap().clone();
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/live-bootstrap-fixtures/live-bootstrap.json"
        ))
        .unwrap();
        let vector = vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["name"] == "rich-unicode")
            .unwrap();
        let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        let markdown = vector["markdown"].as_str().unwrap();
        let doc = Ydoc::wire();
        doc.apply(&bytes).unwrap();
        let binding = json!({"workspaceId":"workspace","mainVersionId":"main","objectId":"object","lineageClaimId":hex_sha256(&bytes),"currentPath":"notes/a.md","selectorPaths":["notes/a.md"],"restoreFenceGeneration":0});
        let mut f = Self {
            _scratch: scratch,
            service,
            owner,
            ingress,
            workspace,
            binding,
            id: 1,
            doc,
            registration: Value::Null,
            terminal: Value::Null,
        };
        let register = f
            .control("liveApplication.register", json!({"binding":f.binding}))
            .await;
        let registration = register.response.result["registrationId"].clone();
        f.registration = registration.clone();
        let params = json!({"registrationId":registration,"baselineStreamId":2,"baseline":{
            "bootstrapId":"bootstrap","bootstrapMomentId":"baseline","baselineMomentRelaySequence":1,"baselineRegisteredAtMs":1,
            "baselineDigest":hex_sha256(&bytes),"baselineByteLength":bytes.len(),"projectedMarkdownDigest":hex_sha256(markdown.as_bytes()),"projectedMarkdownByteLength":markdown.len()
        }});
        let request = f.request("liveApplication.bootstrap", params);
        let response = f.upload(request, 2, &bytes).await;
        assert_eq!(response.response.result["status"], "bootstrapped");
        drop(response);
        f
    }
    fn context(&self) -> RequestContext {
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(self.owner.handle());
        ctx
    }
    fn request(&mut self, method: &str, params: Value) -> Request {
        self.id += 1;
        Request {
            id: self.id,
            method: method.into(),
            workspace: Some(self.workspace.clone()),
            deadline_ms: Some(30_000),
            idempotency_key: None,
            progress: false,
            params,
        }
    }
    async fn control(
        &mut self,
        method: &str,
        params: Value,
    ) -> dohc_engine_protocol::transport::ServiceResponse {
        let request = self.request(method, params);
        self.service.call(self.context(), request).await.unwrap()
    }
    async fn upload(
        &mut self,
        request: Request,
        stream: u64,
        bytes: &[u8],
    ) -> dohc_engine_protocol::transport::ServiceResponse {
        let id = request.id;
        self.ingress.begin(request, &self.owner.handle()).unwrap();
        self.ingress
            .start(BlobStart {
                request_id: id,
                stream_id: stream,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some(hex_sha256(bytes)),
            })
            .unwrap();
        let super::UploadCompletion::Admitted(request, input) =
            self.ingress.chunk(stream, true, bytes).unwrap().unwrap()
        else {
            panic!("unexpected refusal")
        };
        self.service
            .call_with_input(self.context(), request, Some(input))
            .await
            .unwrap()
    }
    async fn edit(&mut self, markdown: &str) {
        let bytes = self
            .doc
            .rewrite_content_to_markdown_preserving_source(ContentKind::Richdoc, markdown)
            .unwrap();
        let stream = self.id + 10;
        let receipt = json!({"deliveryId":"edit","updateDigest":hex_sha256(&bytes),"journalCursor":1,"acceptingHostEpoch":1});
        let request=self.request("liveApplication.apply",json!({"registrationId":self.registration,
            "accepted":{"receipt":receipt,"binding":self.binding,"authority":{"principalKind":"owner","principalId":"owner","grantId":null,"grantGeneration":null},"receivedAtMs":2},
            "rangeCount":0,"rangeStreamId":stream+1,"rangeDigest":hex_sha256(&[]),"updateStreamId":stream,"updateByteLength":bytes.len()
        }));
        let id = request.id;
        self.ingress.begin(request, &self.owner.handle()).unwrap();
        self.ingress
            .start(BlobStart {
                request_id: id,
                stream_id: stream,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some(hex_sha256(&bytes)),
            })
            .unwrap();
        assert!(self.ingress.chunk(stream, true, &bytes).unwrap().is_none());
        self.ingress
            .start(BlobStart {
                request_id: id,
                stream_id: stream + 1,
                total_bytes: Some(0),
                sha256: Some(hex_sha256(&[])),
            })
            .unwrap();
        let super::UploadCompletion::Admitted(request, input) =
            self.ingress.chunk(stream + 1, true, &[]).unwrap().unwrap()
        else {
            panic!("unexpected refusal")
        };
        drop(
            self.service
                .call_with_input(self.context(), request, Some(input))
                .await
                .unwrap(),
        );
        self.terminal = receipt;
        self.id += 2;
    }
    async fn close(self) {
        let Self {
            mut service,
            ingress,
            workspace,
            ..
        } = self;
        drop(ingress);
        Arc::get_mut(&mut service)
            .unwrap()
            .configured_live_host
            .take();
        service
            .call(
                RequestContext::unbounded(),
                Request {
                    id: 1000,
                    method: "workspace.close".into(),
                    workspace: Some(workspace),
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: Value::Null,
                },
            )
            .await
            .unwrap();
    }
}
