//! The upload for `liveApplication.checkFirstOpenCandidate`: one stream with
//! the candidate's bytes, then the source's.

use super::*;
use crate::rpc::live_application::Host;
use crate::rpc::live_application::first_open_check::{
    CONTRACT_VERSION, FirstOpenCandidateBinding, FirstOpenCheckInput, METHOD,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    contract_version: u32,
    binding: FirstOpenCandidateBinding,
    stream_id: u64,
    byte_length: usize,
    digest: String,
}

pub(super) struct Upload {
    request: Request,
    admission: Result<Admitted, WireError>,
    binding: FirstOpenCandidateBinding,
    stream: Stream,
    bytes: Vec<u8>,
    deadline: Instant,
}

struct Admitted {
    host: Arc<Host>,
    permit: Arc<CheckReservation>,
}

/// The first-open slot with the shared upload slot and bytes, released
/// together when the check exits.
struct CheckReservation {
    _check: OwnedSemaphorePermit,
    _shared: Reservation,
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
            return Err(invalid("invalid-first-open-check-stream"));
        }
        if Instant::now() >= self.deadline {
            return Err(invalid("first-open-check-upload-expired"));
        }
        self.stream.start(start)
    }
}

pub(super) fn is_method(method: &str) -> bool {
    method == METHOD
}

impl LiveApplicationIngress {
    /// Admission accounting, not a heap limit: the upload, the decoded
    /// candidate, its projection, settlement's staged reconstructions of the
    /// source, and the bounded encoding, with the working reserve. Memory
    /// follows the document's blocks, not its encoding: a note of one-letter
    /// paragraphs took about 100 times its candidate and source.
    fn first_open_check_reservation(&self, binding: &FirstOpenCandidateBinding) -> Option<usize> {
        binding
            .candidate_byte_length
            .checked_add(binding.source_byte_length)?
            .checked_mul(124)?
            .checked_add(binding.max_full_state_bytes)?
            .checked_add(MAX_CHUNK_BYTES * 2)?
            .checked_add(self.config.application_working_reserve_bytes)
    }

    /// The bytes a check must leave free for one foreground reservation: a
    /// maximal live edit, the configured restore, an applied sync read or a
    /// settlement, whichever needs most. An owner adoption, which may take
    /// the whole budget, is not protected.
    fn foreground_allowance(&self, connection: &ConnectionHandle) -> Option<usize> {
        let restore = match self.service.restore_config(connection) {
            Ok(config) => self.restore_reservation(&config)? as usize,
            Err(_) => 0,
        };
        let sync = self
            .service
            .sync_admission(connection)
            .map_or(0, |(_, admission)| admission.bytes() as usize);
        let settlement = self
            .service
            .configured_settlement_admission_bytes()
            .unwrap_or(0) as usize;
        Some(
            self.config
                .minimum_aggregate_bytes()?
                .max(restore)
                .max(sync)
                .max(settlement),
        )
    }

    /// The check's reservation and the foreground allowance, when an idle
    /// host could ever admit it beside a free upload slot and that allowance.
    /// The refusal names the sizes, so an operator can see what to raise.
    fn first_open_check_fits(
        &self,
        binding: &FirstOpenCandidateBinding,
        connection: &ConnectionHandle,
    ) -> Result<(u32, usize), WireError> {
        let reservation = self.first_open_check_reservation(binding);
        let allowance = self.foreground_allowance(connection);
        let fits = || {
            let (reservation, allowance) = (reservation?, allowance?);
            (self.config.max_uploads >= 2
                && reservation.checked_add(allowance)? <= self.config.aggregate_bytes)
                .then_some((u32::try_from(reservation).ok()?, allowance))
        };
        fits().ok_or_else(|| {
            let bytes = |bytes: Option<usize>| {
                bytes.map_or("more than the aggregate".into(), |b| format!("{b} bytes"))
            };
            WireError::new(
                ErrorCode::LimitExceeded,
                format!(
                    "first-open-check-exceeds-host-capacity: reservation {}, foreground \
                     allowance {}, aggregate {} bytes, {} upload slots",
                    bytes(reservation),
                    bytes(allowance),
                    self.config.aggregate_bytes,
                    self.config.max_uploads
                ),
            )
        })
    }
}

pub(super) fn begin(
    ingress: &mut LiveApplicationIngress,
    mut request: Request,
    connection: &ConnectionHandle,
) -> Result<(), WireError> {
    if request.idempotency_key.is_some() || ingress.has_request(request.id) {
        return Err(invalid("invalid-first-open-check-request"));
    }
    let params: Params = serde_json::from_value(std::mem::take(&mut request.params))
        .map_err(|_| invalid("invalid-first-open-check-upload"))?;
    if params.contract_version != CONTRACT_VERSION
        || params.byte_length != params.binding.bundle_byte_length()?
        || ingress
            .last_stream_id
            .is_some_and(|last| params.stream_id <= last)
    {
        return Err(invalid("invalid-first-open-check-bounds"));
    }
    let stream = Stream::new(params.stream_id, params.byte_length, params.digest)?;
    if ingress.pending() >= ingress.config.max_uploads {
        return Err(overloaded());
    }
    let mut bytes = Vec::new();
    let admission = (|| {
        // Refused once the upload drains, so a workspace detached while its
        // check was on the way ends only that request, not the connection.
        let host = ingress
            .service
            .first_open_check_host(connection, request.workspace.as_ref())?;
        // A check this host could not admit even idle is its configuration,
        // not contention, so asking again cannot help.
        let (reservation, allowance) =
            ingress.first_open_check_fits(&params.binding, connection)?;
        let permit = Arc::new(CheckReservation {
            _check: ingress
                .first_open_slot
                .clone()
                .try_acquire_owned()
                .map_err(|_| overloaded())?,
            _shared: Reservation {
                _upload: ingress
                    .upload_slots
                    .clone()
                    .try_acquire_owned()
                    .map_err(|_| overloaded())?,
                _bytes: ingress
                    .budget
                    .clone()
                    .try_acquire_many_owned(reservation)
                    .map_err(|_| overloaded())?,
            },
        });
        // Foreground work keeps a shared slot and its bytes.
        if ingress.upload_slots.available_permits() < 1
            || ingress.budget.available_permits() < allowance
        {
            return Err(overloaded());
        }
        bytes
            .try_reserve_exact(params.byte_length)
            .map_err(|_| overloaded())?;
        Ok(Admitted { host, permit })
    })();
    if admission.is_err() {
        bytes = Vec::new();
    }
    let duration = request
        .deadline_ms
        .map(|ms| Duration::from_millis(u64::from(ms)))
        .unwrap_or(ingress.config.upload_deadline)
        .min(ingress.config.upload_deadline);
    let deadline = Instant::now()
        .checked_add(duration)
        .ok_or_else(|| invalid("invalid-first-open-check-deadline"))?;
    ingress.last_stream_id = Some(params.stream_id);
    ingress.first_open_checks.insert(
        request.id,
        Upload {
            request,
            admission,
            binding: params.binding,
            stream,
            bytes,
            deadline,
        },
    );
    Ok(())
}

pub(super) fn chunk(
    ingress: &mut LiveApplicationIngress,
    stream_id: u64,
    fin: bool,
    bytes: &[u8],
) -> Result<Option<UploadCompletion>, WireError> {
    let id = ingress
        .first_open_checks
        .iter()
        .find(|(_, upload)| upload.stream.id == stream_id)
        .map(|(id, _)| *id)
        .ok_or_else(|| invalid("unknown-first-open-check-stream"))?;
    let upload = ingress
        .first_open_checks
        .get_mut(&id)
        .expect("located upload");
    if Instant::now() >= upload.deadline {
        return Err(invalid("first-open-check-upload-expired"));
    }
    upload.stream.chunk(bytes, fin)?;
    if upload.admission.is_ok() {
        upload.bytes.extend_from_slice(bytes);
    }
    if !fin {
        return Ok(None);
    }
    let mut upload = ingress
        .first_open_checks
        .remove(&id)
        .expect("finished upload");
    let admitted = match upload.admission {
        Ok(admitted) => admitted,
        Err(error) => return Ok(Some(UploadCompletion::Refused(upload.request.id, error))),
    };
    // Execution gets what is left of the request's one deadline.
    upload.request.deadline_ms = Some(
        u32::try_from(
            upload
                .deadline
                .saturating_duration_since(Instant::now())
                .as_millis(),
        )
        .unwrap_or(u32::MAX),
    );
    Ok(Some(UploadCompletion::Admitted(
        upload.request,
        LiveApplicationInput::FirstOpenCheck(Box::new(FirstOpenCheckInput {
            host: admitted.host,
            binding: upload.binding,
            bundle: upload.bytes,
            reservation: admitted.permit,
        })),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::live_application::first_open_check::tests::{
        Fixture, binding, candidate, inventory, live_state,
    };
    use dohc_engine_collab::live_update_application::first_open_candidate_too_deep_to_project;
    use dohc_engine_protocol::transport::{ConnectionOwner, EngineService as _, RequestContext};
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_storage::hex_sha256;
    use serde_json::{Value, json};

    const MARKDOWN: &str = "Title\n=====\n\nBody & <b>more</b>\n";

    fn request(id: u64, workspace: &WorkspaceHandle, params: Value) -> Request {
        Request {
            id,
            method: METHOD.into(),
            workspace: Some(workspace.clone()),
            deadline_ms: Some(30_000),
            idempotency_key: None,
            progress: false,
            params,
        }
    }

    /// Params and bundle for `source` checked against `candidate`.
    fn upload(stream: u64, candidate: &[u8], source: &[u8], cap: usize) -> (Value, Vec<u8>) {
        let bundle = [candidate, source].concat();
        let params = json!({
            "contractVersion": 1, "binding": binding(candidate, source, cap),
            "streamId": stream, "byteLength": bundle.len(), "digest": hex_sha256(&bundle),
        });
        (params, bundle)
    }

    fn send(
        ingress: &mut LiveApplicationIngress,
        id: u64,
        stream: u64,
        bundle: &[u8],
    ) -> Result<Option<UploadCompletion>, WireError> {
        ingress.start(BlobStart {
            request_id: id,
            stream_id: stream,
            total_bytes: Some(bundle.len() as u64),
            sha256: Some(hex_sha256(bundle)),
        })?;
        ingress.chunk(stream, true, bundle)
    }

    async fn check(
        f: &mut Fixture,
        id: u64,
        params: Value,
        bundle: &[u8],
    ) -> Result<Value, WireError> {
        let stream = params["streamId"].as_u64().unwrap();
        f.ingress
            .begin(request(id, &f.ordinary, params), &f.owner.handle())?;
        let Some(UploadCompletion::Admitted(request, input)) =
            send(&mut f.ingress, id, stream, bundle)?
        else {
            panic!("unexpected refusal")
        };
        let response = f
            .service
            .call_with_input(f.context(), request, Some(input))
            .await?;
        assert!(response.blob_egress.is_none());
        assert!(response.output_guard.as_ref().unwrap().is_current());
        Ok(response.response.result)
    }

    #[tokio::test]
    async fn the_engine_answers_for_the_exact_candidate_and_stores_nothing() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let capacity = (
            f.ingress.budget.available_permits(),
            f.ingress.upload_slots.available_permits(),
        );
        let before = (inventory(f.ordinary_root.path()), live_state(&f.service));
        let (params, bundle) = upload(1, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        let checked = check(&mut f, 1, params.clone(), &bundle).await.unwrap();
        assert_eq!(checked["status"], "checked");
        assert_eq!(checked["contractVersion"], 1);
        assert_eq!(checked["binding"], params["binding"]);
        assert_eq!(
            checked["settledSourceSha256"],
            hex_sha256(MARKDOWN.as_bytes())
        );
        assert_eq!(checked["settledSourceByteLength"], MARKDOWN.len());
        let full = checked["fullStateByteLength"].as_u64().unwrap() as usize;
        let (params, bundle) = upload(2, &bytes, b"Title\n=====\n\nOther\n", MAX_YDOC_UPDATE_BYTES);
        let refused = check(&mut f, 2, params.clone(), &bundle).await.unwrap();
        assert_eq!(
            refused,
            json!({"status":"refused","contractVersion":1,"binding":params["binding"],"cause":"settlement-mismatch"})
        );
        let (params, bundle) = upload(3, &bytes, MARKDOWN.as_bytes(), full - 1);
        let too_large = check(&mut f, 3, params.clone(), &bundle).await.unwrap();
        assert_eq!(
            too_large,
            json!({"status":"too-large","contractVersion":1,"binding":params["binding"],"bound":"full-state-encoding","limit":full - 1})
        );
        let (params, bundle) = upload(4, &[0, 0], b"", 2);
        assert_eq!(
            check(&mut f, 4, params, &bundle).await.unwrap()["status"],
            "checked"
        );
        let deep = first_open_candidate_too_deep_to_project();
        let (params, bundle) = upload(5, &deep, b"deep\n", MAX_YDOC_UPDATE_BYTES);
        let unprojectable = check(&mut f, 5, params.clone(), &bundle).await.unwrap();
        assert_eq!(
            unprojectable,
            json!({"status":"refused","contractVersion":1,"binding":params["binding"],"cause":"projection-failed"})
        );
        assert_eq!(
            (inventory(f.ordinary_root.path()), live_state(&f.service)),
            before
        );
        assert_eq!(
            (
                f.ingress.budget.available_permits(),
                f.ingress.upload_slots.available_permits()
            ),
            capacity
        );
        f.close().await;
    }

    /// Uploads a check and returns why it was refused, which it learns only
    /// once its upload drains.
    fn drained_refusal(
        ingress: &mut LiveApplicationIngress,
        request: Request,
        bundle: &[u8],
        connection: &ConnectionHandle,
    ) -> ErrorCode {
        let (id, stream) = (request.id, request.params["streamId"].as_u64().unwrap());
        ingress.begin(request, connection).unwrap();
        assert!(ingress.first_open_checks[&id].bytes.is_empty());
        let Some(UploadCompletion::Refused(refused, error)) =
            send(ingress, id, stream, bundle).unwrap()
        else {
            panic!("a check ran without standing")
        };
        assert_eq!(refused, id);
        error.code
    }

    #[tokio::test]
    async fn only_the_configured_connection_on_an_ordinary_workspace_may_upload() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let other = ConnectionOwner::authenticated();
        let foreign = WorkspaceHandle("ws-ffffffffffffffff".into());
        let capacity = f.ingress.budget.available_permits();
        for (id, (workspace, connection)) in (1..).zip([
            (Some(f.private.clone()), f.owner.handle()),
            (Some(foreign), f.owner.handle()),
            (Some(f.ordinary.clone()), other.handle()),
            (None, f.owner.handle()),
        ]) {
            let (params, bundle) = upload(id, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
            let mut request = request(id, &f.ordinary, params);
            request.workspace = workspace;
            assert_eq!(
                drained_refusal(&mut f.ingress, request, &bundle, &connection),
                ErrorCode::WorkspaceUnavailable
            );
        }
        // An engine without the configured host has no such authority.
        let mut unconfigured = LiveApplicationIngress::new(
            Arc::new(EngineService::new()),
            crate::live_application_ingress::tests::config(),
        )
        .unwrap();
        let (params, bundle) = upload(10, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        assert_eq!(
            drained_refusal(
                &mut unconfigured,
                request(10, &f.ordinary, params),
                &bundle,
                &f.owner.handle()
            ),
            ErrorCode::Forbidden
        );
        assert_eq!(f.ingress.pending(), 0);
        assert_eq!(f.ingress.budget.available_permits(), capacity);
        f.owner.retire();
        let (params, bundle) = upload(11, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        assert_eq!(
            drained_refusal(
                &mut f.ingress,
                request(11, &f.ordinary, params),
                &bundle,
                &f.owner.handle()
            ),
            ErrorCode::WorkspaceUnavailable
        );
        f.close().await;
    }

    #[tokio::test]
    async fn a_desktop_live_host_has_no_first_open_authority() {
        let scratch = dohc_engine_testkit::ScratchDir::new().unwrap();
        let config = serde_json::from_value(json!({
            "ingress":{"aggregateBytes":512*1024*1024,"applicationWorkingReserveBytes":32*1024*1024,"maxUploads":2,"uploadDeadlineMs":30_000},
            "maxRegistrations":4,"maxAdoptionBytes":1_000_000,"maxAdoptionEvents":100,
            "maxApplicationsPerSettlement":100,
            "ownerOutbox":{"maxPendingBytes":1_000_000,"maxPendingAgeMs":100_000},
            "restore":{"maxBytes":1_000_000,"maxEvents":100}
        }))
        .unwrap();
        let (service, owner, mut ingress) = EngineService::ordinary_live_host(config).unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let opened = service
            .call(ctx, Request {
                id: 0, method: "workspace.open".into(), workspace: None, deadline_ms: None,
                idempotency_key: None, progress: false,
                params: json!({"rootDir":scratch.path(),"workspaceId":"workspace","captureMode":"none"}),
            })
            .await
            .unwrap();
        let workspace: WorkspaceHandle =
            serde_json::from_value(opened.response.result["workspace"].clone()).unwrap();
        let bytes = candidate(MARKDOWN);
        let (params, bundle) = upload(1, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        assert_eq!(
            drained_refusal(
                &mut ingress,
                request(1, &workspace, params),
                &bundle,
                &owner.handle()
            ),
            ErrorCode::Forbidden
        );
        service
            .call(
                RequestContext::unbounded(),
                Request {
                    id: 2,
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

    #[tokio::test]
    async fn standing_is_checked_again_before_the_check_runs() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let admitted = |f: &mut Fixture, id: u64| {
            let (params, bundle) = upload(id, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
            f.ingress
                .begin(request(id, &f.ordinary, params), &f.owner.handle())
                .unwrap();
            let Some(UploadCompletion::Admitted(request, input)) =
                send(&mut f.ingress, id, id, &bundle).unwrap()
            else {
                panic!("unexpected refusal")
            };
            (request, input)
        };
        let capacity = f.ingress.budget.available_permits();
        let other = ConnectionOwner::authenticated();
        let mut stranger = f.context();
        stranger.connection = Some(other.handle());
        // Dispatch refuses another connection before the handler runs.
        let (request, input) = admitted(&mut f, 1);
        assert!(
            f.service
                .call_with_input(stranger.clone(), request, Some(input))
                .await
                .is_err()
        );
        // The handler checks again on its own: another connection, another
        // workspace, and a workspace detached after its upload finished.
        async fn handler(
            f: &Fixture,
            ctx: RequestContext,
            request: Request,
            input: LiveApplicationInput,
        ) -> ErrorCode {
            let LiveApplicationInput::FirstOpenCheck(input) = input else {
                panic!("expected a first-open check")
            };
            f.service
                .live_application_check_first_open(ctx, request, *input)
                .await
                .unwrap_err()
                .code
        }
        let (request, input) = admitted(&mut f, 2);
        assert_eq!(
            handler(&f, stranger, request, input).await,
            ErrorCode::WorkspaceUnavailable
        );
        let (mut request, input) = admitted(&mut f, 3);
        request.workspace = Some(f.private.clone());
        assert_eq!(
            handler(&f, f.context(), request, input).await,
            ErrorCode::WorkspaceUnavailable
        );
        // A finished answer is withheld once its workspace detaches.
        let (request, input) = admitted(&mut f, 4);
        let answered = f
            .service
            .call_with_input(f.context(), request, Some(input))
            .await
            .unwrap();
        let guard = answered.output_guard.clone().unwrap();
        assert!(guard.is_current());
        let (request, input) = admitted(&mut f, 5);
        f.detach(&f.ordinary).await.unwrap();
        assert!(!guard.is_current());
        assert_eq!(
            handler(&f, f.context(), request, input).await,
            ErrorCode::WorkspaceUnavailable
        );
        assert_eq!(f.ingress.budget.available_permits(), capacity);
        f.close().await;
    }

    /// A cancel that reaches the engine after the check answered, while the
    /// answer waits for the writer, does not withhold it: the relay frees its
    /// slot on the answer instead of waiting out the deadline. Retirement
    /// still withholds it.
    #[tokio::test]
    async fn a_cancel_after_the_answer_still_lets_the_answer_out() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let (params, bundle) = upload(1, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        f.ingress
            .begin(request(1, &f.ordinary, params), &f.owner.handle())
            .unwrap();
        let Some(UploadCompletion::Admitted(request, input)) =
            send(&mut f.ingress, 1, 1, &bundle).unwrap()
        else {
            panic!("unexpected refusal")
        };
        let mut ctx = f.context();
        ctx.deadline = Some(Instant::now() + Duration::from_secs(30));
        let cancel = ctx.cancel.clone();
        let answered = f
            .service
            .call_with_input(ctx, request, Some(input))
            .await
            .unwrap();
        let guard = answered.output_guard.unwrap();
        // The daemon files the guard's cancel signal for the request; a cancel
        // envelope fires it with the request's own. The frame is still held.
        let filed = guard.cancel_signal();
        cancel.cancel();
        filed.cancel();
        // The writer takes its signals and writes the frame.
        assert!(!guard.cancel_signal().is_cancelled());
        assert!(!guard.retirement_signal().is_cancelled());
        let mut written = false;
        assert!(guard.with_current(true, &mut || written = true));
        assert!(written);
        // The host was not retired: the next check runs.
        let (params, bundle) = upload(2, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        assert_eq!(
            check(&mut f, 2, params, &bundle).await.unwrap()["status"],
            "checked"
        );
        f.owner.retire();
        assert!(guard.retirement_signal().is_cancelled());
        assert!(!guard.with_current(true, &mut || ()));
        assert!(!guard.with_current(false, &mut || ()));
        f.close().await;
    }

    #[tokio::test]
    async fn malformed_metadata_and_streams_are_refused_before_any_check() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let source = MARKDOWN.as_bytes();
        let (good, bundle) = upload(10, &bytes, source, MAX_YDOC_UPDATE_BYTES);
        let large = dohc_engine_collab::limits::MAX_PUBLIC_MARKDOWN_BYTES + 1;
        let edits: Vec<Vec<(&str, Value)>> = vec![
            vec![("extra", json!(true))],
            vec![("binding.activationId", json!("a"))],
            vec![("contractVersion", json!(2))],
            vec![("byteLength", json!(bundle.len() + 1))],
            vec![("digest", json!("A".repeat(64)))],
            vec![("binding.sourceSha256", json!("nope"))],
            vec![("binding.objectId", json!(""))],
            vec![("binding.path", json!("a\u{0}b"))],
            vec![("binding.candidateByteLength", json!(1))],
            vec![
                ("binding.sourceByteLength", json!(large)),
                ("byteLength", json!(bytes.len() + large)),
            ],
            vec![(
                "binding.maxFullStateBytes",
                json!(MAX_YDOC_UPDATE_BYTES + 1),
            )],
            vec![("binding.maxFullStateBytes", json!(1))],
        ];
        for edit in edits {
            let mut params = good.clone();
            for (path, value) in edit {
                let mut field = &mut params;
                for key in path.split('.') {
                    field = &mut field[key];
                }
                *field = value;
            }
            let refused = f
                .ingress
                .begin(request(1, &f.ordinary, params), &f.owner.handle())
                .unwrap_err();
            assert_eq!(refused.code, ErrorCode::InvalidParams, "{refused:?}");
        }
        let mut keyed = request(1, &f.ordinary, good.clone());
        keyed.idempotency_key = Some("key".into());
        assert!(f.ingress.begin(keyed, &f.owner.handle()).is_err());
        assert_eq!(f.ingress.pending(), 0);
        // Truncated and corrupted streams end the upload.
        f.ingress
            .begin(request(1, &f.ordinary, good.clone()), &f.owner.handle())
            .unwrap();
        f.ingress
            .start(BlobStart {
                request_id: 1,
                stream_id: 10,
                total_bytes: Some(bundle.len() as u64),
                sha256: Some(hex_sha256(&bundle)),
            })
            .unwrap();
        let truncated = f.ingress.chunk(10, true, &bundle[..bundle.len() - 1]);
        assert_eq!(truncated.err().unwrap().message, "live-stream-length");
        assert!(f.ingress.cancel(1));
        let (params, bundle) = upload(11, &bytes, source, MAX_YDOC_UPDATE_BYTES);
        f.ingress
            .begin(request(2, &f.ordinary, params), &f.owner.handle())
            .unwrap();
        let mut corrupt = bundle.clone();
        corrupt[0] ^= 1;
        f.ingress
            .start(BlobStart {
                request_id: 2,
                stream_id: 11,
                total_bytes: Some(bundle.len() as u64),
                sha256: Some(hex_sha256(&bundle)),
            })
            .unwrap();
        assert_eq!(
            f.ingress.chunk(11, true, &corrupt).err().unwrap().message,
            "live-stream-digest"
        );
        assert!(f.ingress.cancel(2));
        // A stream identifier is never reused.
        let (params, _) = upload(11, &bytes, source, MAX_YDOC_UPDATE_BYTES);
        assert!(
            f.ingress
                .begin(request(3, &f.ordinary, params), &f.owner.handle())
                .is_err()
        );
        f.close().await;
    }

    #[tokio::test]
    async fn digests_that_disagree_with_the_bytes_are_failures_not_verdicts() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        for (index, field) in ["candidateSha256", "sourceSha256"].into_iter().enumerate() {
            let stream = 20 + index as u64;
            let (mut params, bundle) =
                upload(stream, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
            params["binding"][field] = json!(hex_sha256(b"other"));
            let refused = check(&mut f, stream, params, &bundle).await.unwrap_err();
            assert_eq!(refused.code, ErrorCode::BlobInvalid);
        }
        // Bytes that are not UTF-8 are not a Markdown file.
        let source = [b'B', 0xff, b'\n'];
        let (params, bundle) = upload(30, &bytes, &source, MAX_YDOC_UPDATE_BYTES);
        assert_eq!(
            check(&mut f, 30, params, &bundle).await.unwrap_err().code,
            ErrorCode::BlobInvalid
        );
        f.close().await;
    }

    /// A check is admitted only when it leaves a shared upload slot and the
    /// bytes of the largest foreground reservation: a maximal live edit, the
    /// configured restore, an applied sync read or a settlement. A check an
    /// idle host could never admit reserves nothing and, once its upload
    /// drains, is refused for good as `LimitExceeded`; one that only waits on
    /// held capacity is `Overloaded`, and the host stays configured either way.
    #[tokio::test]
    async fn a_maximal_check_leaves_room_for_the_largest_foreground_reservation() {
        let gib = 1024 * 1024 * 1024;
        let ingress = json!({"aggregateBytes": gib, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
            "maxUploads": 2, "uploadDeadlineMs": 30_000});
        // A maximal live edit sets the allowance, then each larger section in turn.
        for extra in [
            json!({}),
            json!({"restore": {"maxBytes": 1_000_000, "maxEvents": 180}}),
            json!({"ingress": ingress, "sync": {"policy": {"maxClientVectorBytes": 131_072,
                "maxHostVectorBytes": 131_072, "maxOutputBytes": 4_194_304, "maxReadBytes": 300 * 1024 * 1024},
                "workingReserveBytes": 8_388_608}}),
            json!({"ingress": ingress, "settlement": {"maxApplicationsPerSettlement": 80_000}}),
        ] {
            let f = Fixture::with(extra.clone()).await;
            let owner = f.owner.handle();
            let base = f.ingress.config.clone();
            let edit = base.minimum_aggregate_bytes().unwrap();
            let foreground = [
                f.service
                    .restore_config(&owner)
                    .ok()
                    .map(|config| f.ingress.restore_reservation(&config).unwrap() as usize),
                f.service
                    .sync_admission(&owner)
                    .ok()
                    .map(|(_, admission)| admission.bytes() as usize),
                f.service
                    .configured_settlement_admission_bytes()
                    .map(|bytes| bytes as usize),
            ];
            let allowance = foreground.into_iter().flatten().fold(edit, usize::max);
            assert_eq!(
                allowance > edit,
                !extra.as_object().unwrap().is_empty(),
                "{extra}"
            );
            let mut largest = binding(&[0, 0], b"", MAX_YDOC_UPDATE_BYTES);
            largest.candidate_byte_length = MAX_YDOC_UPDATE_BYTES;
            largest.source_byte_length = dohc_engine_collab::limits::MAX_PUBLIC_MARKDOWN_BYTES;
            let check = f.ingress.first_open_check_reservation(&largest).unwrap();
            let params = json!({
                "contractVersion": 1, "binding": largest, "streamId": 1,
                "byteLength": largest.bundle_byte_length().unwrap(), "digest": "0".repeat(64),
            });
            for (aggregate_bytes, max_uploads, admitted) in [
                (edit, 2, false),
                (check + allowance - 1, 2, false),
                (check + allowance, 2, true),
                (check + allowance, 1, false),
            ] {
                let config = LiveApplicationIngressConfig {
                    aggregate_bytes,
                    max_uploads,
                    ..base.clone()
                };
                let mut ingress = LiveApplicationIngress::new(f.service.clone(), config).unwrap();
                let case = (aggregate_bytes, max_uploads);
                ingress
                    .begin(request(1, &f.ordinary, params.clone()), &owner)
                    .unwrap();
                match &ingress.first_open_checks[&1].admission {
                    Ok(_) => {
                        assert!(admitted, "{case:?} admitted a check");
                        assert!(ingress.upload_slots.available_permits() >= 1);
                        assert!(ingress.budget.available_permits() >= allowance);
                        // The same check, while one byte of the allowance is held, waits on contention.
                        assert!(ingress.cancel(1));
                        let held = ingress.budget.clone().try_acquire_owned().unwrap();
                        let mut params = params.clone();
                        params["streamId"] = json!(2);
                        ingress
                            .begin(request(2, &f.ordinary, params), &owner)
                            .unwrap();
                        let refused = ingress.first_open_checks[&2]
                            .admission
                            .as_ref()
                            .err()
                            .unwrap();
                        assert_eq!(refused.code, ErrorCode::Overloaded);
                        drop(held);
                    }
                    Err(error) => {
                        assert!(!admitted, "{case:?} refused a check");
                        assert_eq!(error.code, ErrorCode::LimitExceeded);
                        // A foreground reservation this host cannot hold has no allowance.
                        let shown = match ingress.foreground_allowance(&owner) {
                            Some(bytes) => {
                                assert_eq!(bytes, allowance);
                                format!("{bytes} bytes")
                            }
                            None => "more than the aggregate".to_owned(),
                        };
                        assert_eq!(
                            error.message,
                            format!(
                                "first-open-check-exceeds-host-capacity: reservation {check} \
                                 bytes, foreground allowance {shown}, aggregate \
                                 {aggregate_bytes} bytes, {max_uploads} upload slots"
                            )
                        );
                        assert!(ingress.first_open_checks[&1].bytes.is_empty());
                        assert_eq!(ingress.budget.available_permits(), aggregate_bytes);
                        assert_eq!(ingress.upload_slots.available_permits(), max_uploads);
                        assert_eq!(ingress.first_open_slot.available_permits(), 1);
                    }
                }
            }
            f.close().await;
        }
    }

    /// The most one check took above its daemon's idle commit, over two
    /// debug sessions and one release session of five fresh daemons each on
    /// Windows (`tests/first_open_check_memory.rs`), with its candidate,
    /// source and encoding cap: the relay's seeds under seed client id 1 and
    /// the engine's seeds of notes at the projection node limit, the bare
    /// note decoded and then refused, and the float32 fixture. The relay's
    /// seed of one-letter paragraphs needs the most per byte. The charge
    /// covers each by a quarter before the working reserve.
    #[test]
    fn the_charge_covers_each_measured_check_by_a_quarter() {
        let measured = [
            (2_954_714, 262_142, 2_954_714, 320_782_336), // paragraphs/relay
            (2_692_333, 262_141, 2_692_333, 188_862_464), // paragraphs-bare/relay
            (2_692_357, 262_141, 2_692_357, 139_194_368), // paragraphs-bare/decoded
            (3_042_094, 349_522, 3_042_094, 320_978_944), // paragraphs-spaced/relay
            (3_326_063, 262_140, 3_326_063, 344_121_344), // star-bullets/relay
            (3_326_063, 262_140, 3_326_063, 344_010_752), // tight-list/relay
            (2_954_713, 349_460, 2_954_713, 179_658_752), // hard-breaks/relay
            (4_789_715, 262_142, 4_789_715, 322_592_768), // paragraphs/engine
            (4_789_714, 262_141, 4_789_714, 197_251_072), // paragraphs-bare/engine
            (4_877_095, 349_522, 4_877_095, 323_248_128), // paragraphs-spaced/engine
            (5_161_050, 262_140, 5_161_050, 345_853_952), // star-bullets/engine
            (5_161_050, 262_140, 5_161_050, 346_222_592), // tight-list/engine
            (7_081, 5_421, 8_281, 1_372_160),             // float32-integers
        ];
        let ingress = LiveApplicationIngress::new(
            Arc::new(EngineService::new()),
            crate::live_application_ingress::tests::config(),
        )
        .unwrap();
        for (candidate, source, cap, peak) in measured {
            let mut measured = binding(&[0, 0], b"", cap);
            measured.candidate_byte_length = candidate;
            measured.source_byte_length = source;
            let charge = ingress.first_open_check_reservation(&measured).unwrap()
                - ingress.config.application_working_reserve_bytes;
            assert!(charge >= peak + peak / 4, "{charge} for {peak}");
        }
    }

    #[tokio::test]
    async fn full_capacity_drains_the_upload_then_answers_overloaded() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let admission = f.ingress.settlement_admission(4).unwrap();
        let held = [admission.reserve().unwrap(), admission.reserve().unwrap()];
        let remaining = f.ingress.budget.available_permits();
        let (params, bundle) = upload(1, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        f.ingress
            .begin(request(1, &f.ordinary, params), &f.owner.handle())
            .unwrap();
        assert!(
            f.ingress
                .first_open_checks
                .get(&1)
                .unwrap()
                .bytes
                .is_empty()
        );
        let Some(UploadCompletion::Refused(id, error)) =
            send(&mut f.ingress, 1, 1, &bundle).unwrap()
        else {
            panic!("a check ran without capacity")
        };
        assert_eq!((id, error.code), (1, ErrorCode::Overloaded));
        assert_eq!(f.ingress.budget.available_permits(), remaining);
        drop(held);
        // Pending uploads stay within the configured slots.
        for id in [2, 3] {
            let (params, _) = upload(id, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
            f.ingress
                .begin(request(id, &f.ordinary, params), &f.owner.handle())
                .unwrap();
        }
        let (params, _) = upload(4, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
        let refused = f
            .ingress
            .begin(request(4, &f.ordinary, params), &f.owner.handle())
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::Overloaded);
        // An expired upload gives its slot back.
        f.ingress.first_open_checks.get_mut(&2).unwrap().deadline = Instant::now();
        assert_eq!(f.ingress.expire(), vec![2]);
        assert!(f.ingress.cancel(3));
        assert_eq!(f.ingress.upload_slots.available_permits(), 2);
        f.close().await;
    }

    #[tokio::test]
    async fn cancellation_and_deadlines_stop_the_check_and_return_capacity() {
        let mut f = Fixture::new().await;
        let bytes = candidate(MARKDOWN);
        let capacity = f.ingress.budget.available_permits();
        let before = (inventory(f.ordinary_root.path()), live_state(&f.service));
        for (id, cancelled) in [(1, true), (2, false)] {
            let (params, bundle) = upload(id, &bytes, MARKDOWN.as_bytes(), MAX_YDOC_UPDATE_BYTES);
            f.ingress
                .begin(request(id, &f.ordinary, params), &f.owner.handle())
                .unwrap();
            let Some(UploadCompletion::Admitted(request, input)) =
                send(&mut f.ingress, id, id, &bundle).unwrap()
            else {
                panic!("unexpected refusal")
            };
            let mut ctx = f.context();
            if cancelled {
                ctx.cancel.cancel();
            } else {
                ctx.deadline = Some(Instant::now() - Duration::from_secs(1));
            }
            let refused = f
                .service
                .call_with_input(ctx, request, Some(input))
                .await
                .unwrap_err();
            let expected = if cancelled {
                ErrorCode::Cancelled
            } else {
                ErrorCode::DeadlineExceeded
            };
            assert_eq!(refused.code, expected);
            assert_eq!(f.ingress.budget.available_permits(), capacity);
        }
        assert_eq!(
            (inventory(f.ordinary_root.path()), live_state(&f.service)),
            before
        );
        f.close().await;
    }
}
