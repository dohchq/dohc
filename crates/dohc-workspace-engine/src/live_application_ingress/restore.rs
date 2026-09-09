use super::*;
use crate::rpc::live_application::Host;
use crate::rpc::live_application::restore::{RestoreInput, RestoreOperation};
use dohc_engine_collab::live_update_application::{
    NativeRestoreApplication, NativeRestoreFenceReceipt, NativeRestorePoint,
    NativeRestorePreparation, NativeRestoreResume,
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RestoreConfig {
    pub max_bytes: usize,
    pub max_events: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    stream_id: u64,
    byte_length: usize,
    digest: String,
    max_output_bytes: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Header {
    fence: NativeRestoreFenceReceipt,
    point: NativeRestorePoint,
    candidate_digest: Option<String>,
    native_source_manifest_digest: Option<String>,
    admitted: Option<AdmittedLiveUpdateMetadata>,
    settlement_id: Option<String>,
}

pub(super) struct Upload {
    request: Request,
    host: Arc<Host>,
    config: RestoreConfig,
    stream: Stream,
    bytes: Vec<u8>,
    deadline: Instant,
    permit: Arc<Reservation>,
    max_output_bytes: usize,
}

impl Upload {
    pub(super) fn stream_id(&self) -> u64 {
        self.stream.id
    }
    pub(super) fn deadline(&self) -> Instant {
        self.deadline
    }
    pub(super) fn start(&mut self, start: &BlobStart) -> Result<(), WireError> {
        if start.stream_id != self.stream.id {
            return Err(invalid("invalid-native-restore-stream"));
        }
        if Instant::now() >= self.deadline {
            return Err(invalid("restore-upload-expired"));
        }
        self.stream.start(start)
    }
}

pub(super) fn is_method(method: &str) -> bool {
    matches!(
        method,
        "liveApplication.prepareRestore"
            | "liveApplication.applyRestore"
            | "liveApplication.settleRestore"
            | "liveApplication.resumeRestore"
    )
}

impl LiveApplicationIngress {
    fn restore_reservation(&self, config: &RestoreConfig) -> Option<u32> {
        // Typed decode can retain geometrically grown String vectors: an empty JSON
        // string needs three wire bytes including its separator. Four further byte
        // spans cover upload, decoded strings, and serde's escaped-string scratch.
        let parse_factor = (2 * size_of::<String>()).div_ceil(3) + 4;
        // This also covers the smaller processing peak: two input copies, proof
        // buffers, audit JSON, receipt JSON and framed output (at most 12 byte spans).
        // Event headers need their own allowance: preparation loads repeated bindings
        // before the final serialized proposal cap. Four copies cover audit/replay.
        let metadata = config
            .max_events
            .checked_mul(MAX_HEADER_BYTES)?
            .checked_mul(4)?;
        config
            .max_bytes
            .checked_mul(parse_factor.max(12))?
            .checked_add(metadata)?
            .checked_add(self.config.application_working_reserve_bytes)?
            .checked_add(MAX_CHUNK_BYTES * 2)
            .filter(|bytes| {
                config.max_bytes >= 5
                    && config.max_events > 0
                    && config.max_events < MAX_WIRE_INTEGER as usize
                    && *bytes <= self.config.aggregate_bytes
            })
            .and_then(|bytes| u32::try_from(bytes).ok())
    }
    pub(crate) fn validate_restore_budget(&self, config: &RestoreConfig) -> Result<(), WireError> {
        self.restore_reservation(config)
            .ok_or_else(|| invalid("invalid-native-restore-budget"))
            .map(|_| ())
    }
}

pub(super) fn begin(
    ingress: &mut LiveApplicationIngress,
    mut request: Request,
    connection: &ConnectionHandle,
) -> Result<(), WireError> {
    if request.idempotency_key.is_some()
        || ingress.uploads.contains_key(&request.id)
        || ingress.restores.contains_key(&request.id)
    {
        return Err(invalid("invalid-native-restore-request"));
    }
    let config = ingress.service.restore_config(connection)?;
    let host = ingress
        .service
        .restore_host(connection, request.workspace.as_ref())?;
    let params: Params = serde_json::from_value(std::mem::take(&mut request.params))
        .map_err(|_| invalid("invalid-native-restore-upload"))?;
    if params.byte_length < 5
        || params.byte_length > config.max_bytes
        || params.max_output_bytes < 5
        || ingress
            .last_stream_id
            .is_some_and(|last| params.stream_id <= last)
    {
        return Err(invalid("invalid-native-restore-bounds"));
    }
    let stream = Stream::new(params.stream_id, params.byte_length, params.digest)?;
    let permit = Arc::new(Reservation {
        _upload: ingress
            .upload_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| overloaded())?,
        _bytes: ingress
            .budget
            .clone()
            .try_acquire_many_owned(
                ingress
                    .restore_reservation(&config)
                    .ok_or_else(overloaded)?,
            )
            .map_err(|_| overloaded())?,
    });
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(params.byte_length)
        .map_err(|_| overloaded())?;
    let duration = request
        .deadline_ms
        .map(|ms| Duration::from_millis(u64::from(ms)))
        .unwrap_or(ingress.config.upload_deadline)
        .min(ingress.config.upload_deadline);
    let deadline = Instant::now()
        .checked_add(duration)
        .ok_or_else(|| invalid("invalid-native-restore-deadline"))?;
    ingress.last_stream_id = Some(params.stream_id);
    ingress.restores.insert(
        request.id,
        Upload {
            request,
            host,
            config,
            stream,
            bytes,
            deadline,
            permit,
            max_output_bytes: params.max_output_bytes,
        },
    );
    Ok(())
}

fn field<'a>(bytes: &mut &'a [u8]) -> Result<&'a [u8], WireError> {
    let prefix = bytes
        .get(..4)
        .ok_or_else(|| invalid("truncated-native-restore"))?;
    let length = u32::from_le_bytes(prefix.try_into().expect("four bytes")) as usize;
    let end = 4usize
        .checked_add(length)
        .ok_or_else(|| invalid("invalid-native-restore-length"))?;
    let value = bytes
        .get(4..end)
        .ok_or_else(|| invalid("truncated-native-restore"))?;
    *bytes = &bytes[end..];
    Ok(value)
}

fn decode(
    mut bytes: &[u8],
    method: &str,
    config: &RestoreConfig,
) -> Result<RestoreOperation, WireError> {
    let header: Header = serde_json::from_slice(field(&mut bytes)?)
        .map_err(|_| invalid("invalid-native-restore-header"))?;
    if !bytes.is_empty() {
        return Err(invalid("native-restore-trailing-bytes"));
    }
    let preparation = NativeRestorePreparation {
        fence: header.fence,
        point: header.point,
    };
    preparation
        .validate_budget(config.max_bytes, config.max_events)
        .map_err(|_| invalid("invalid-native-restore-preparation"))?;
    if method == "liveApplication.prepareRestore" {
        if header.candidate_digest.is_some()
            || header.native_source_manifest_digest.is_some()
            || header.admitted.is_some()
            || header.settlement_id.is_some()
        {
            return Err(invalid("unexpected-native-restore-admission"));
        }
        return Ok(RestoreOperation::Prepare(preparation));
    }
    let input = NativeRestoreApplication {
        preparation,
        candidate_digest: header
            .candidate_digest
            .ok_or_else(|| invalid("missing-native-restore-candidate"))?,
        native_source_manifest_digest: header
            .native_source_manifest_digest
            .ok_or_else(|| invalid("missing-native-restore-manifest"))?,
        admitted: header
            .admitted
            .ok_or_else(|| invalid("missing-native-restore-admission"))?,
    };
    input
        .validate_budget(config.max_bytes, config.max_events)
        .map_err(|_| invalid("invalid-native-restore-admission"))?;
    if method == "liveApplication.resumeRestore" {
        let resume = NativeRestoreResume {
            application: input,
            settlement_id: header
                .settlement_id
                .ok_or_else(|| invalid("missing-native-restore-settlement"))?,
        };
        resume
            .validate_budget(config.max_bytes, config.max_events)
            .map_err(|_| invalid("invalid-native-restore-resume"))?;
        return Ok(RestoreOperation::Resume(resume));
    }
    if header.settlement_id.is_some() {
        return Err(invalid("unexpected-native-restore-settlement"));
    }
    match method {
        "liveApplication.applyRestore" => Ok(RestoreOperation::Apply(input)),
        "liveApplication.settleRestore" => Ok(RestoreOperation::Settle(input)),
        _ => Err(invalid("invalid-native-restore-method")),
    }
}

pub(super) fn chunk(
    ingress: &mut LiveApplicationIngress,
    stream_id: u64,
    fin: bool,
    bytes: &[u8],
) -> Result<Option<(Request, LiveApplicationInput)>, WireError> {
    let id = ingress
        .restores
        .iter()
        .find(|(_, upload)| upload.stream.id == stream_id)
        .map(|(id, _)| *id)
        .ok_or_else(|| invalid("unknown-native-restore-stream"))?;
    let upload = ingress.restores.get_mut(&id).expect("located upload");
    if Instant::now() >= upload.deadline {
        return Err(invalid("restore-upload-expired"));
    }
    upload.stream.chunk(bytes, fin)?;
    upload.bytes.extend_from_slice(bytes);
    if !fin {
        return Ok(None);
    }
    let mut upload = ingress.restores.remove(&id).expect("finished upload");
    let operation = decode(&upload.bytes, &upload.request.method, &upload.config)?;
    upload.request.deadline_ms = Some(
        u32::try_from(
            upload
                .deadline
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .unwrap_or(u32::MAX),
    );
    Ok(Some((
        upload.request,
        LiveApplicationInput::Restore(Box::new(RestoreInput {
            host: upload.host,
            operation,
            config: upload.config,
            max_output_bytes: upload.max_output_bytes,
            reservation: upload.permit,
        })),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lock;
    use dohc_engine_collab::{ContentKind, Ydoc};
    use dohc_engine_protocol::transport::{ConnectionOwner, EngineService as _, RequestContext};
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_storage::{EngineStore, NoFaults, hex_sha256};
    use dohc_engine_testkit::ScratchDir;
    use serde_json::{Value, json};

    struct Fixture {
        _scratch: ScratchDir,
        service: Arc<EngineService>,
        owner: ConnectionOwner,
        ingress: LiveApplicationIngress,
        workspace: WorkspaceHandle,
        binding: Value,
        point: Value,
        id: u64,
        doc: Ydoc,
        registration: Value,
        terminal: Value,
        sequence: u64,
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
                "restore":{"maxBytes":1_000_000,"maxEvents":100}
            })).unwrap();
            let (service, owner, ingress) =
                EngineService::configured_live_host(config).await.unwrap();
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
            let projection = doc.project(ContentKind::Richdoc).unwrap().content;
            let binding = json!({"workspaceId":"workspace","mainVersionId":"main","objectId":"object","lineageClaimId":hex_sha256(&bytes),"currentPath":"notes/a.md","selectorPaths":["notes/a.md"],"restoreFenceGeneration":0});
            let point = json!({"journalCursor":0,"receiptDigest":hex_sha256(&bytes),"markdownDigest":hex_sha256(markdown.as_bytes()),"projectionDigest":hex_sha256(projection.as_bytes())});
            let mut f = Self {
                _scratch: scratch,
                service,
                owner,
                ingress,
                workspace,
                binding,
                point,
                id: 1,
                doc,
                registration: Value::Null,
                terminal: Value::Null,
                sequence: 0,
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
            let (request, input) = self.ingress.chunk(stream, true, bytes).unwrap().unwrap();
            self.service
                .call_with_input(self.context(), request, Some(input))
                .await
                .unwrap()
        }
        async fn restore(
            &mut self,
            method: &str,
            header: &Value,
        ) -> dohc_engine_protocol::transport::ServiceResponse {
            let bytes = framed(header);
            let stream = self.id + 10;
            let request = self.request(
                method,
                json!({"streamId":stream,"byteLength":bytes.len(),"digest":hex_sha256(&bytes),"maxOutputBytes":1_000_000}),
            );
            self.upload(request, stream, &bytes).await
        }
        async fn try_restore(
            &mut self,
            method: &str,
            header: &Value,
            max_output_bytes: usize,
        ) -> Result<dohc_engine_protocol::transport::ServiceResponse, WireError> {
            let bytes = framed(header);
            let stream = self.id + 10;
            let request = self.request(method, json!({"streamId":stream,"byteLength":bytes.len(),"digest":hex_sha256(&bytes),"maxOutputBytes":max_output_bytes}));
            let id = request.id;
            self.ingress.begin(request, &self.owner.handle())?;
            self.ingress.start(BlobStart {
                request_id: id,
                stream_id: stream,
                total_bytes: Some(bytes.len() as u64),
                sha256: Some(hex_sha256(&bytes)),
            })?;
            let (request, input) = self.ingress.chunk(stream, true, &bytes)?.unwrap();
            self.service
                .call_with_input(self.context(), request, Some(input))
                .await
        }
        async fn fence(&mut self) -> Value {
            let response = self.control("liveApplication.fenceRestore",json!({"operation":{
                "operationId":"restore","relayDatabaseNamespace":"namespace","oldBinding":self.binding,
                "hostId":"host","newFence":1,"origin":{"kind":"bootstrap","id":"bootstrap"},"terminal":self.terminal,"appliedSequence":self.sequence
            }})).await;
            response.response.result["receipt"].clone()
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
            let (request, input) = self.ingress.chunk(stream + 1, true, &[]).unwrap().unwrap();
            let response = self
                .service
                .call_with_input(self.context(), request, Some(input))
                .await
                .unwrap();
            self.sequence = response.response.result["ack"]["localYDocSequence"]
                .as_u64()
                .unwrap();
            self.terminal = receipt;
            self.id += 2;
        }
        async fn prepare_admitted(&mut self) -> Value {
            let fence = self.fence().await;
            let mut header = json!({"fence":fence,"point":self.point});
            let prepared = self
                .restore("liveApplication.prepareRestore", &header)
                .await;
            let mut bytes = prepared.blob_egress.as_ref().unwrap().bytes.as_slice();
            let receipt: Value = serde_json::from_slice(field(&mut bytes).unwrap()).unwrap();
            header["candidateDigest"] = receipt["candidateDigest"].clone();
            header["nativeSourceManifestDigest"] = receipt["nativeSourceManifestDigest"].clone();
            let mut binding = self.binding.clone();
            binding["restoreFenceGeneration"] = json!(1);
            header["admitted"] = json!({"accepted":{"receipt":{"deliveryId":"restore-admission","updateDigest":receipt["candidateDigest"],"journalCursor":self.sequence+1,"acceptingHostEpoch":1},"binding":binding,"authority":{"principalKind":"owner","principalId":"owner","grantId":null,"grantGeneration":null},"receivedAtMs":3},"firstSeen":receipt["replacementRanges"]});
            header
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
                        params: Value::Null,
                    },
                )
                .await
                .unwrap();
        }
    }
    fn framed(header: &Value) -> Vec<u8> {
        let json = serde_json::to_vec(header).unwrap();
        let mut bytes = (json.len() as u32).to_le_bytes().to_vec();
        bytes.extend(json);
        bytes
    }

    #[tokio::test]
    async fn restore_output_obeys_the_callers_reserved_bound_and_releases_capacity() {
        let mut f = Fixture::new().await;
        let fence = f.fence().await;
        let header = json!({"fence":fence,"point":f.point});
        let capacity = f.ingress.budget.available_permits();
        let error = f
            .try_restore("liveApplication.prepareRestore", &header, 5)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::LimitExceeded);
        assert_eq!(f.ingress.budget.available_permits(), capacity);
        let output = f.restore("liveApplication.prepareRestore", &header).await;
        assert_eq!(output.response.result["status"], "prepared");
        drop(output);
        f.close().await;
    }

    #[tokio::test]
    async fn restore_resume_requires_durable_materialization_and_preserves_historical_retries() {
        let mut f = Fixture::new().await;
        let mut header = f.prepare_admitted().await;
        drop(f.restore("liveApplication.applyRestore", &header).await);
        header["settlementId"] = json!("missing");
        assert!(
            f.try_restore("liveApplication.resumeRestore", &header, 1_000_000)
                .await
                .is_err()
        );
        header.as_object_mut().unwrap().remove("settlementId");
        let settled = f.restore("liveApplication.settleRestore", &header).await;
        let settlement: Value =
            serde_json::from_slice(&settled.blob_egress.as_ref().unwrap().bytes).unwrap();
        header["settlementId"] = settlement["settlementId"].clone();
        drop(settled);
        let path = f._scratch.path().join("notes/a.md");
        let saved = std::fs::read(&path).unwrap();
        std::fs::write(&path, b"external edit").unwrap();
        assert!(
            f.try_restore("liveApplication.resumeRestore", &header, 1_000_000)
                .await
                .is_err()
        );
        std::fs::write(&path, &saved).unwrap();
        let resumed = f.restore("liveApplication.resumeRestore", &header).await;
        assert_eq!(resumed.response.result["status"], "resumed");
        let receipt = resumed.blob_egress.as_ref().unwrap().bytes.clone();
        drop(resumed);
        let binding = header["admitted"]["accepted"]["binding"].clone();
        let registered = f
            .control("liveApplication.register", json!({"binding":binding}))
            .await;
        let registration_id = registered.response.result["registrationId"]
            .as_u64()
            .unwrap();
        drop(registered);
        drop(f.fence().await);
        assert!(
            f.service
                .live_application_registration(
                    &f.owner.handle(),
                    Some(&f.workspace),
                    registration_id
                )
                .is_ok()
        );
        std::fs::write(&path, b"later edit").unwrap();
        let retry = f.restore("liveApplication.resumeRestore", &header).await;
        assert_eq!(retry.blob_egress.as_ref().unwrap().bytes, receipt);
        drop(retry);
        f.close().await;
    }

    #[tokio::test]
    async fn configured_restore_rpc_prepares_applies_settles_and_replays_real_artifact() {
        let mut f = Fixture::new().await;
        let fence = f.fence().await;
        let mut header = json!({"fence":fence,"point":f.point});
        let capacity = f.ingress.budget.available_permits();
        let prepared = f.restore("liveApplication.prepareRestore", &header).await;
        assert_eq!(prepared.response.result["status"], "prepared");
        assert!(prepared.output_guard.as_ref().unwrap().is_current());
        assert!(f.ingress.budget.available_permits() < capacity);
        let mut bytes = prepared.blob_egress.as_ref().unwrap().bytes.as_slice();
        let receipt: Value = serde_json::from_slice(field(&mut bytes).unwrap()).unwrap();
        assert_eq!(
            hex_sha256(field(&mut bytes).unwrap()),
            receipt["candidateDigest"]
        );
        assert_eq!(
            hex_sha256(field(&mut bytes).unwrap()),
            receipt["frozenStateDigest"]
        );
        assert_eq!(
            hex_sha256(field(&mut bytes).unwrap()),
            receipt["pointStateDigest"]
        );
        assert!(bytes.is_empty());
        drop(prepared);
        assert_eq!(f.ingress.budget.available_permits(), capacity);
        header["candidateDigest"] = receipt["candidateDigest"].clone();
        header["nativeSourceManifestDigest"] = receipt["nativeSourceManifestDigest"].clone();
        let mut binding = f.binding.clone();
        binding["restoreFenceGeneration"] = json!(1);
        header["admitted"] = json!({"accepted":{"receipt":{"deliveryId":"restore-admission","updateDigest":receipt["candidateDigest"],"journalCursor":1,"acceptingHostEpoch":1},"binding":binding,"authority":{"principalKind":"owner","principalId":"owner","grantId":null,"grantGeneration":null},"receivedAtMs":2},"firstSeen":receipt["replacementRanges"]});
        let mut applied_receipt = None;
        for _ in 0..2 {
            let applied = f.restore("liveApplication.applyRestore", &header).await;
            let receipt: Value =
                serde_json::from_slice(&applied.blob_egress.as_ref().unwrap().bytes).unwrap();
            if let Some(saved) = &applied_receipt {
                assert_eq!(&receipt, saved);
            }
            applied_receipt = Some(receipt);
            drop(applied);
            assert_eq!(f.ingress.budget.available_permits(), capacity);
        }
        for _ in 0..2 {
            let settled = f.restore("liveApplication.settleRestore", &header).await;
            let result: Value =
                serde_json::from_slice(&settled.blob_egress.as_ref().unwrap().bytes).unwrap();
            assert_eq!(result["materialized"], true);
            let artifact = std::fs::read(f._scratch.path().join("notes/a.md")).unwrap();
            assert_eq!(hex_sha256(&artifact), result["markdownDigest"]);
            drop(settled);
            assert_eq!(f.ingress.budget.available_permits(), capacity);
        }
        let raw =
            rusqlite::Connection::open(f._scratch.path().join(".dohc/engine/engine.db")).unwrap();
        let count: i64 = raw
            .query_row(
                "SELECT COUNT(*) FROM live_device_update_applications",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(raw);
        f.close().await;
    }

    #[tokio::test]
    async fn configured_restore_notices_survive_lost_reply_and_history_survives_reconciliation() {
        let mut f = Fixture::new().await;
        let mut raw =
            rusqlite::Connection::open(f._scratch.path().join(".dohc/engine/engine.db")).unwrap();
        let tx = raw.transaction().unwrap();
        dohc_engine_domain::write_projected_text_in_tx(
            &tx,
            dohc_engine_domain::ProjectedWriteText {
                workspace_id: "workspace",
                version_id: "main",
                object_id: "schema",
                path: std::borrow::Cow::Borrowed("notes/.collection.json"),
                text: std::borrow::Cow::Borrowed("{\"fields\":[],\"views\":[]}"),
                moment_id: "schema",
                metadata_origin: "test",
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: 2,
                request_id: None,
            },
        )
        .unwrap();
        tx.execute("INSERT INTO collections VALUES ('workspace','main','notes','notes/.collection.json','valid','[]')",[]).unwrap();
        tx.execute("INSERT INTO collection_records (workspace_id,version_id,record_id,collection_path,file_path,object_id,adoption_state) VALUES ('workspace','main','rec_00000000000000000000000000','notes','notes/a.md','object','adopted')",[]).unwrap();
        tx.commit().unwrap();
        drop(raw);
        f.edit("---\nid: rec_00000000000000000000000000\nstatus: later\n---\n# Later\n")
            .await;
        let header = f.prepare_admitted().await;
        let mut events = f.service.events().subscribe();
        let applied = f.restore("liveApplication.applyRestore", &header).await;
        drop(applied); // The caller lost its reply; commit notices still precede output disposal.
        let mut notices = Vec::new();
        while let Ok(notice) = events.try_recv() {
            notices.push(notice);
        }
        assert!(notices.iter().any(
            |event| event.name == "record.field.changed" && event.payload["field"] == "status"
        ));
        let replay = f.restore("liveApplication.applyRestore", &header).await;
        drop(replay);
        assert!(
            events.try_recv().is_err(),
            "replay invents no new field history or commit facts"
        );
        // A removed schema leaves a stale index until the real reconciliation pass.
        let raw =
            rusqlite::Connection::open(f._scratch.path().join(".dohc/engine/engine.db")).unwrap();
        raw.execute("DELETE FROM snapshots WHERE object_id='schema'", [])
            .unwrap();
        assert_eq!(
            raw.query_row("SELECT COUNT(*) FROM collections", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(raw);
        let settled = f.restore("liveApplication.settleRestore", &header).await;
        let result: Value =
            serde_json::from_slice(&settled.blob_egress.as_ref().unwrap().bytes).unwrap();
        assert_eq!(result["collectionReconcileRequired"], true);
        let raw =
            rusqlite::Connection::open(f._scratch.path().join(".dohc/engine/engine.db")).unwrap();
        assert_eq!(
            raw.query_row("SELECT COUNT(*) FROM collections", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(raw.query_row("SELECT COUNT(*) FROM collection_field_history WHERE field_name='status' AND previous_value_json='\"later\"' AND next_value_json IS NULL",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert!(
            events.try_recv().is_ok(),
            "settlement emits its existing moment repaint notice"
        );
        drop(raw);
        drop(settled);
        f.close().await;
    }

    #[tokio::test]
    async fn configured_restore_refuses_wrong_connection_bounds_and_releases_cancelled_upload() {
        let mut f = Fixture::new().await;
        let fence = f.fence().await;
        let bytes = framed(&json!({"fence":fence,"point":f.point}));
        let request = f.request(
            "liveApplication.prepareRestore",
            json!({"streamId":50,"byteLength":bytes.len(),"digest":hex_sha256(&bytes),"maxOutputBytes":1_000_000}),
        );
        let capacity = f.ingress.budget.available_permits();
        let foreign = ConnectionOwner::authenticated();
        assert!(f.ingress.begin(request.clone(), &foreign.handle()).is_err());
        assert_eq!(f.ingress.budget.available_permits(), capacity);
        f.ingress.begin(request.clone(), &f.owner.handle()).unwrap();
        assert!(f.ingress.budget.available_permits() < capacity);
        assert!(
            f.ingress
                .start(BlobStart {
                    request_id: request.id,
                    stream_id: 51,
                    total_bytes: Some(bytes.len() as u64),
                    sha256: Some(hex_sha256(&bytes)),
                })
                .is_err()
        );
        assert!(f.ingress.cancel(request.id));
        assert_eq!(f.ingress.budget.available_permits(), capacity);
        assert!(
            f.ingress.begin(request, &f.owner.handle()).is_err(),
            "stream ids are never reused after cancellation"
        );
        for max_bytes in [0, usize::MAX, 512 * 1024 * 1024] {
            assert!(
                f.ingress
                    .validate_restore_budget(&RestoreConfig {
                        max_bytes,
                        max_events: 100
                    })
                    .is_err()
            );
        }
        f.close().await;
    }
}
