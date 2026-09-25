//! Blocking HTTP implementation of the dependency-free relay transport seam.

#![forbid(unsafe_code)]

use std::net::IpAddr;
use std::time::Duration;

use dohc_engine_sync::{
    BlobDownloadBatchRequest, BlobDownloadBatchResponse, BlobDownloadResponse, BlobHaveRequest,
    BlobHaveResponse, BlobUploadRequest, ClaimRequest, ClaimResponse, EpochRequest, EpochResponse,
    KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse, KeyEnvelopeRequest,
    KeyEnvelopeResponse, LogCoordinateRequest, LogCoordinateResponse, MAX_BLOB_DOWNLOAD_BATCH,
    MAX_INGEST_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES, MAX_PULL_OPS, ObservedBytes, ProbeRequest,
    ProbeResponse, PullRequest, PullResponse, PushRequest, PushResponse, RelayError,
    RelayTransport, ReplicationEnvelope, ShareBlobRequest, ShareBlobUploadRequest,
    ShareCollectionWriteRequest, ShareCollectionWriteResponse, ShareLogPushRequest,
    ShareProposalChange, ShareProposalSubmitRequest, ShareProposalSubmitResponse,
    ShareReplicationEnvelope, ShareViewRequest, ShareViewResponse, SharedChannelRequest,
    SharedChannelResponse,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use ureq::http::{Response, Uri};
use ureq::{Agent, Body};

const MAX_LOG_ROW_RESPONSE_OVERHEAD_BYTES: usize = 16 * 1024;
const MAX_LOG_PAGE_RESPONSE_OVERHEAD_BYTES: usize = 64 * 1024;
const MAX_JSON_RESPONSE_BYTES: u64 = (MAX_PULL_OPS
    * (MAX_PAYLOAD_JSON_BYTES + MAX_LOG_ROW_RESPONSE_OVERHEAD_BYTES)
    + MAX_LOG_PAGE_RESPONSE_OVERHEAD_BYTES) as u64;
const MAX_ERROR_RESPONSE_BYTES: u64 = 64 * 1024;
const MAX_KEY_ENVELOPE_ACK_BYTES: u64 = 64 * 1024;
const CANCELLABLE_BODY_READ_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// A canceled synchronous ureq read may live until its transport timeout;
/// match the runtime's download concurrency so those readers stay bounded.
const MAX_CANCELLABLE_BODY_READ_WORKERS: usize = 4;
/// The largest blob body a response may carry: the loosest ingest ceiling plus
/// the one byte that lets ingest observe an overage and refuse it by name.
const MAX_BLOB_BODY_BYTES: usize = MAX_INGEST_BLOB_BYTES + 1;
/// `ureq` refuses a body once a read reaches its limit, so the limit sits one
/// byte past the largest body this transport accepts.
const BLOB_BODY_READ_LIMIT_BYTES: usize = MAX_BLOB_BODY_BYTES + 1;

/// A blob body that overruns the read limit broke the ingest ceiling, so the
/// caller gets the ceiling by name. The transport stops reading at its bound
/// and never learns the full size, so it reports the floor it proved.
fn blob_body_overflow() -> RelayError {
    RelayError::BlobTooLarge {
        constraint: "MAX_INGEST_BLOB_BYTES",
        limit_bytes: MAX_INGEST_BLOB_BYTES,
        observed: ObservedBytes::AtLeast(BLOB_BODY_READ_LIMIT_BYTES),
    }
}

fn cancelled_relay_request() -> RelayError {
    RelayError::Local("relay-io-cancelled".to_owned())
}

fn map_body_read_error(error: std::io::Error, overflow: &RelayError) -> RelayError {
    // `ureq` wraps body-reader errors in `io::Error`; converting back recovers
    // the typed limit variant used by the caller.
    match ureq::Error::from(error) {
        ureq::Error::BodyExceedsLimit(_) => overflow.clone(),
        _ => RelayError::InvalidResponse,
    }
}

static CANCELLABLE_BODY_READ_WORKERS: std::sync::LazyLock<(
    std::sync::Mutex<usize>,
    std::sync::Condvar,
)> = std::sync::LazyLock::new(|| (std::sync::Mutex::new(0), std::sync::Condvar::new()));

struct BodyReadWorkerPermit;

impl Drop for BodyReadWorkerPermit {
    fn drop(&mut self) {
        let (active, available) = &*CANCELLABLE_BODY_READ_WORKERS;
        let mut active = active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = active.saturating_sub(1);
        available.notify_one();
    }
}

fn acquire_body_read_worker<C>(cancelled: &C) -> Result<BodyReadWorkerPermit, RelayError>
where
    C: Fn() -> bool + ?Sized,
{
    let (active, available) = &*CANCELLABLE_BODY_READ_WORKERS;
    let mut active = active.lock().map_err(|_| RelayError::InvalidResponse)?;
    loop {
        if cancelled() {
            return Err(cancelled_relay_request());
        }
        if *active < MAX_CANCELLABLE_BODY_READ_WORKERS {
            *active += 1;
            return Ok(BodyReadWorkerPermit);
        }
        (active, _) = available
            .wait_timeout(active, CANCELLABLE_BODY_READ_POLL_INTERVAL)
            .map_err(|_| RelayError::InvalidResponse)?;
    }
}

enum BodyReadWorkerMessage {
    Progress,
    Finished(Result<Vec<u8>, RelayError>),
}

pub struct HttpRelayTransport {
    base_url: String,
    token: String,
    agent: Agent,
}

impl std::fmt::Debug for HttpRelayTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpRelayTransport")
            .field("base_url", &self.base_url)
            .field("token", &"[redacted]")
            .finish_non_exhaustive()
    }
}

impl HttpRelayTransport {
    pub fn new(base_url: impl Into<String>, token: impl Into<String>) -> Result<Self, RelayError> {
        Self::build(base_url, token, false)
    }

    /// Explicit debug-profile opt-in for authenticated loopback HTTP.
    ///
    /// `debug_assertions` is a build-profile setting, not a security boundary.
    /// Callers exposing this through runtime configuration must independently
    /// restrict it to local development and test workflows.
    #[cfg(debug_assertions)]
    pub fn new_insecure_loopback_for_tests(
        base_url: impl Into<String>,
        token: impl Into<String>,
    ) -> Result<Self, RelayError> {
        Self::build(base_url, token, true)
    }

    fn build(
        base_url: impl Into<String>,
        token: impl Into<String>,
        allow_insecure_loopback: bool,
    ) -> Result<Self, RelayError> {
        let base_url = base_url.into().trim_end_matches('/').to_owned();
        let token = token.into();
        if token.is_empty() || !base_url_is_allowed(&base_url, allow_insecure_loopback) {
            return Err(RelayError::InvalidResponse);
        }
        Ok(Self {
            base_url,
            token,
            agent: configured_agent(Duration::from_secs(30), allow_insecure_loopback, None),
        })
    }

    /// Download blobs while cooperatively observing request cancellation.
    pub fn download_blobs_cancellable<C>(
        &self,
        req: BlobDownloadBatchRequest,
        cancelled: C,
    ) -> Result<BlobDownloadBatchResponse, RelayError>
    where
        C: Fn() -> bool,
    {
        if req.blobs.is_empty() || req.blobs.len() > MAX_BLOB_DOWNLOAD_BATCH {
            return Err(RelayError::InvalidResponse);
        }
        if cancelled() {
            return Err(cancelled_relay_request());
        }

        let mut results = Vec::with_capacity(req.blobs.len());
        for blob in req.blobs {
            if cancelled() {
                return Err(cancelled_relay_request());
            }
            let result = (|| {
                if blob.limit_bytes > MAX_INGEST_BLOB_BYTES {
                    return Err(RelayError::InvalidResponse);
                }
                let read_limit_bytes = blob
                    .limit_bytes
                    .checked_add(1)
                    .ok_or(RelayError::InvalidResponse)?;
                let url = self.workspace_url(
                    &req.workspace_id,
                    &format!("/blobs/{}", encode_segment(&blob.sha256)),
                    &req.replication_epoch,
                    &req.stream_identity,
                    &[],
                );
                if cancelled() {
                    return Err(cancelled_relay_request());
                }
                let request = self
                    .agent
                    .get(&url)
                    .header("authorization", &self.authorization());
                // A cancelled synchronous ureq read can remain blocked until
                // its transport timeout, so header and body reads share the
                // same bounded worker budget.
                let permit = acquire_body_read_worker(&cancelled)?;
                let (response_tx, response_rx) = std::sync::mpsc::channel();
                let worker = std::thread::Builder::new()
                    .name("dohc-relay-header-read".to_owned())
                    .spawn(move || {
                        let _permit = permit;
                        let _ = response_tx.send(request.call());
                    })
                    .map_err(|_| RelayError::InvalidResponse)?;
                let response = loop {
                    match response_rx.recv_timeout(CANCELLABLE_BODY_READ_POLL_INTERVAL) {
                        Ok(response) => {
                            worker.join().map_err(|_| RelayError::InvalidResponse)?;
                            break response;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            worker.join().map_err(|_| RelayError::InvalidResponse)?;
                            return Err(RelayError::InvalidResponse);
                        }
                    }
                    if cancelled() {
                        return Err(cancelled_relay_request());
                    }
                };
                if cancelled() {
                    return Err(cancelled_relay_request());
                }
                let (bytes, _) = self.bytes_cancellable(
                    response,
                    RequestContext::Blob,
                    read_limit_bytes,
                    RelayError::BlobTooLarge {
                        constraint: "MAX_INGEST_BLOB_BYTES",
                        limit_bytes: blob.limit_bytes,
                        observed: ObservedBytes::AtLeast(read_limit_bytes),
                    },
                    &cancelled,
                )?;
                Ok(BlobDownloadResponse { bytes })
            })();
            if cancelled() {
                return Err(cancelled_relay_request());
            }
            results.push(result);
        }
        Ok(BlobDownloadBatchResponse { results })
    }

    fn authorization(&self) -> String {
        format!("Bearer {}", self.token)
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    fn workspace_path(&self, workspace_id: &str, suffix: &str) -> String {
        format!("/sync/{}{}", encode_segment(workspace_id), suffix)
    }

    fn workspace_url(
        &self,
        workspace_id: &str,
        suffix: &str,
        replication_epoch: &str,
        stream_identity: &str,
        extra_query: &[(&str, String)],
    ) -> String {
        let mut query = vec![
            (
                "replicationEpoch",
                encode_query_component(replication_epoch),
            ),
            ("streamIdentity", encode_query_component(stream_identity)),
        ];
        query.extend(
            extra_query
                .iter()
                .map(|(key, value)| (*key, encode_query_component(value))),
        );
        let encoded = query
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect::<Vec<_>>()
            .join("&");
        self.url(&format!(
            "{}?{}",
            self.workspace_path(workspace_id, suffix),
            encoded
        ))
    }

    fn share_url(&self, share_id: &str, suffix: &str, query: &[(&str, String)]) -> String {
        let mut path = format!("/sync/shares/{}{}", encode_segment(share_id), suffix);
        if !query.is_empty() {
            path.push('?');
            path.push_str(
                &query
                    .iter()
                    .map(|(key, value)| format!("{key}={}", encode_query_component(value)))
                    .collect::<Vec<_>>()
                    .join("&"),
            );
        }
        self.url(&path)
    }

    fn json<T: DeserializeOwned>(
        &self,
        response: Result<Response<Body>, ureq::Error>,
        context: RequestContext,
    ) -> Result<T, RelayError> {
        let mut response = response.map_err(map_transport_error)?;
        if !response.status().is_success() {
            return Err(map_http_error(&mut response, context));
        }
        response
            .body_mut()
            .with_config()
            .limit(MAX_JSON_RESPONSE_BYTES)
            .read_json()
            .map_err(|_| RelayError::InvalidResponse)
    }

    fn bytes(
        &self,
        response: Result<Response<Body>, ureq::Error>,
        context: RequestContext,
        read_limit_bytes: usize,
        overflow: RelayError,
    ) -> Result<(Vec<u8>, Option<String>), RelayError> {
        self.bytes_with_cancellation(response, context, read_limit_bytes, overflow, None)
    }

    fn bytes_cancellable<C>(
        &self,
        response: Result<Response<Body>, ureq::Error>,
        context: RequestContext,
        read_limit_bytes: usize,
        overflow: RelayError,
        cancelled: &C,
    ) -> Result<(Vec<u8>, Option<String>), RelayError>
    where
        C: Fn() -> bool,
    {
        self.bytes_with_cancellation(
            response,
            context,
            read_limit_bytes,
            overflow,
            Some(cancelled),
        )
    }

    fn bytes_with_cancellation(
        &self,
        response: Result<Response<Body>, ureq::Error>,
        context: RequestContext,
        read_limit_bytes: usize,
        overflow: RelayError,
        cancelled: Option<&dyn Fn() -> bool>,
    ) -> Result<(Vec<u8>, Option<String>), RelayError> {
        let mut response = response.map_err(map_transport_error)?;
        if cancelled.is_some_and(|cancelled| cancelled()) {
            return Err(cancelled_relay_request());
        }
        if !response.status().is_success() {
            let error = map_http_error(&mut response, context);
            return if cancelled.is_some_and(|cancelled| cancelled()) {
                Err(cancelled_relay_request())
            } else {
                Err(error)
            };
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_etag);
        let mut reader = response
            .into_body()
            .into_with_config()
            .limit(read_limit_bytes as u64)
            .reader();
        let Some(cancelled) = cancelled else {
            let mut bytes = Vec::new();
            let mut chunk = [0_u8; 64 * 1024];
            loop {
                let read = std::io::Read::read(&mut reader, &mut chunk)
                    .map_err(|error| map_body_read_error(error, &overflow))?;
                if read == 0 {
                    return Ok((bytes, etag));
                }
                bytes.extend_from_slice(&chunk[..read]);
            }
        };

        let permit = acquire_body_read_worker(cancelled)?;
        let (message_tx, message_rx) = std::sync::mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("dohc-relay-body-read".to_owned())
            .spawn(move || {
                let _permit = permit;
                let mut bytes = Vec::new();
                let mut chunk = [0_u8; 64 * 1024];
                loop {
                    let read = std::io::Read::read(&mut reader, &mut chunk)
                        .map_err(|error| map_body_read_error(error, &overflow));
                    match read {
                        Ok(0) => {
                            let _ = message_tx.send(BodyReadWorkerMessage::Finished(Ok(bytes)));
                            return;
                        }
                        Ok(read) => {
                            bytes.extend_from_slice(&chunk[..read]);
                            if message_tx.send(BodyReadWorkerMessage::Progress).is_err() {
                                return;
                            }
                        }
                        Err(error) => {
                            let _ = message_tx.send(BodyReadWorkerMessage::Finished(Err(error)));
                            return;
                        }
                    }
                }
            })
            .map_err(|_| RelayError::InvalidResponse)?;

        loop {
            match message_rx.recv_timeout(CANCELLABLE_BODY_READ_POLL_INTERVAL) {
                Ok(BodyReadWorkerMessage::Progress) => {}
                Ok(BodyReadWorkerMessage::Finished(result)) => {
                    worker.join().map_err(|_| RelayError::InvalidResponse)?;
                    return if cancelled() {
                        Err(cancelled_relay_request())
                    } else {
                        result.map(|bytes| (bytes, etag))
                    };
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    worker.join().map_err(|_| RelayError::InvalidResponse)?;
                    return Err(RelayError::InvalidResponse);
                }
            }
            if cancelled() {
                return Err(cancelled_relay_request());
            }
        }
    }
}

fn configured_agent(
    timeout: Duration,
    allow_insecure_loopback: bool,
    tls_config: Option<ureq::tls::TlsConfig>,
) -> Agent {
    let builder = Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .https_only(!allow_insecure_loopback)
        .max_redirects(0);
    let builder = if let Some(tls_config) = tls_config {
        builder.tls_config(tls_config)
    } else {
        builder
    };
    builder.build().into()
}

impl RelayTransport for HttpRelayTransport {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        validate_outbound_payloads(req.ops.iter().map(|op| &op.payload))?;
        let body = WirePushRequest {
            replication_epoch: &req.replication_epoch,
            stream_identity: &req.stream_identity,
            origin_id: &req.origin_id,
            ops: req.ops.iter().map(WireLogInput::from).collect(),
        };
        let url = self.workspace_url(
            &req.workspace_id,
            "/log",
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let wire: WirePushResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Workspace,
        )?;
        Ok(PushResponse {
            accepted: wire.accepted,
            inserted: wire.inserted,
            skipped: wire.skipped,
            current_max_origin_seq: wire.current_max_origin_seq,
        })
    }

    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError> {
        let url = self.workspace_url(
            &req.workspace_id,
            "/log",
            &req.replication_epoch,
            &req.stream_identity,
            &[
                ("since", req.cursor.to_string()),
                ("limit", req.limit.to_string()),
            ],
        );
        let wire: WireLogPage = self.json(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Workspace,
        )?;
        let mut ops = Vec::with_capacity(wire.ops.len());
        for mut row in wire.ops {
            let workspace_id = row.workspace_id.take().ok_or(RelayError::InvalidResponse)?;
            if workspace_id != req.workspace_id {
                return Err(RelayError::InvalidResponse);
            }
            let envelope = row.into_workspace_envelope(workspace_id);
            if envelope.relay_seq.is_none_or(|relay_seq| {
                !(0..=dohc_engine_sync::MAX_WIRE_INTEGER).contains(&relay_seq)
            }) {
                return Err(RelayError::InvalidResponse);
            }
            ops.push(envelope);
        }
        Ok(PullResponse {
            ops,
            next_cursor: wire.next_cursor,
            has_more: wire.has_more,
        })
    }

    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        if req.origin_seq < 0 || req.origin_seq > dohc_engine_sync::MAX_WIRE_INTEGER {
            return Err(RelayError::InvalidResponse);
        }
        let suffix = format!("/log/{}/{}", encode_segment(&req.origin_id), req.origin_seq);
        let url = self.workspace_url(
            &req.workspace_id,
            &suffix,
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let wire: WireLogCoordinateResponse = self.json(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Workspace,
        )?;
        let (mut op, below_epoch_floor) = match wire {
            WireLogCoordinateResponse::Absent => return Ok(LogCoordinateResponse::Absent),
            WireLogCoordinateResponse::Present { op } => (op, false),
            WireLogCoordinateResponse::PresentBelowEpochFloor { op } => (op, true),
        };
        let workspace_id = op.workspace_id.take().ok_or(RelayError::InvalidResponse)?;
        if workspace_id != req.workspace_id
            || op.origin_id != req.origin_id
            || op.origin_seq != req.origin_seq
        {
            return Err(RelayError::InvalidResponse);
        }
        let envelope = op.into_workspace_envelope(workspace_id);
        if envelope
            .relay_seq
            .is_none_or(|relay_seq| !(0..=dohc_engine_sync::MAX_WIRE_INTEGER).contains(&relay_seq))
        {
            return Err(RelayError::InvalidResponse);
        }
        Ok(if below_epoch_floor {
            LogCoordinateResponse::PresentBelowEpochFloor(envelope)
        } else {
            LogCoordinateResponse::Present(envelope)
        })
    }

    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        let page = self.pull(PullRequest {
            workspace_id: req.workspace_id,
            replication_epoch: req.replication_epoch,
            stream_identity: req.stream_identity,
            cursor: 0,
            limit: 1,
        })?;
        Ok(ProbeResponse {
            has_content: !page.ops.is_empty(),
        })
    }

    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        let body = WireClaimRequest {
            workspace_id: &req.workspace_id,
            replication_epoch: &req.replication_epoch,
            stream_identity: &req.stream_identity,
        };
        let _: WireOk = self.json(
            self.agent
                .post(&self.url("/sync/workspaces"))
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Workspace,
        )?;
        Ok(ClaimResponse)
    }

    fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError> {
        let body = WireEpochRequest {
            replication_epoch: &req.replication_epoch,
            stream_identity: &req.stream_identity,
        };
        let url = self.workspace_url(
            &req.workspace_id,
            "/epoch",
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let wire: WireEpochResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Workspace,
        )?;
        Ok(EpochResponse {
            rotated: wire.rotated,
            replication_epoch: wire.replication_epoch,
            stream_identity: wire.stream_identity,
        })
    }

    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError> {
        let body = WireBlobHaveRequest {
            replication_epoch: &req.replication_epoch,
            stream_identity: &req.stream_identity,
            sha256s: &req.sha256s,
        };
        let url = self.workspace_url(
            &req.workspace_id,
            "/blobs/have",
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let wire: WireBlobHaveResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Workspace,
        )?;
        Ok(BlobHaveResponse {
            missing: wire.missing,
        })
    }

    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError> {
        let url = self.workspace_url(
            &req.workspace_id,
            &format!("/blobs/{}", encode_segment(&req.sha256)),
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let _: WireOk = self.json(
            self.agent
                .put(&url)
                .header("authorization", &self.authorization())
                .send(req.bytes.as_slice()),
            RequestContext::Blob,
        )?;
        Ok(())
    }

    fn download_blobs(
        &self,
        req: BlobDownloadBatchRequest,
    ) -> Result<BlobDownloadBatchResponse, RelayError> {
        self.download_blobs_cancellable(req, || false)
    }

    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        let url = self.workspace_url(
            &req.workspace_id,
            "/keys",
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let mut request = self
            .agent
            .put(&url)
            .header("authorization", &self.authorization())
            .header("content-type", "application/json");
        if let Some(if_match) = &req.if_match {
            request = request.header("if-match", &format!("\"{if_match}\""));
        }
        let response = request.send(req.envelope_json.as_bytes());
        let mut response = response.map_err(map_transport_error)?;
        if !response.status().is_success() {
            return Err(map_http_error(&mut response, RequestContext::Key));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_etag)
            .ok_or(RelayError::InvalidResponse)?;
        let _: Vec<u8> = response
            .body_mut()
            .with_config()
            .limit(MAX_KEY_ENVELOPE_ACK_BYTES)
            .read_to_vec()
            .map_err(|_| RelayError::InvalidResponse)?;
        Ok(KeyEnvelopeResponse { etag })
    }

    fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        let url = self.workspace_url(
            &req.workspace_id,
            "/keys",
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let (bytes, etag) = self.bytes(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Key,
            16 * 1024,
            RelayError::InvalidResponse,
        )?;
        Ok(KeyEnvelopeDownloadResponse {
            envelope_json: String::from_utf8(bytes).map_err(|_| RelayError::InvalidResponse)?,
            etag: etag.ok_or(RelayError::InvalidResponse)?,
        })
    }

    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
        let page = self.read_share_log(
            &req.share_id,
            req.cursor,
            MAX_PULL_OPS,
            &[("channelWireId", req.channel_wire_id)],
        )?;
        Ok(SharedChannelResponse {
            ops: page.ops,
            next_cursor: page.next_cursor,
            has_more: page.has_more,
            push: None,
        })
    }

    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        validate_outbound_payloads(req.ops.iter().map(|op| &op.payload))?;
        let body = WireSharePushRequest {
            origin_id: &req.origin_id,
            ops: req.ops.iter().map(WireShareLogInput::from).collect(),
        };
        let url = self.share_url(&req.share_id, "/log", &[]);
        let wire: WirePushResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Share,
        )?;
        Ok(PushResponse {
            accepted: wire.accepted,
            inserted: wire.inserted,
            skipped: wire.skipped,
            current_max_origin_seq: wire.current_max_origin_seq,
        })
    }

    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError> {
        let page =
            self.read_share_log(&req.share_id, req.cursor, req.limit.min(MAX_PULL_OPS), &[])?;
        Ok(ShareViewResponse {
            ops: page.ops,
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        })
    }

    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        let url = self.share_url(
            &req.share_id,
            &format!("/blobs/{}", encode_segment(&req.sha256)),
            &[],
        );
        let (bytes, _) = self.bytes(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Share,
            BLOB_BODY_READ_LIMIT_BYTES,
            blob_body_overflow(),
        )?;
        Ok(BlobDownloadResponse { bytes })
    }

    fn share_blob_upload(&self, req: ShareBlobUploadRequest) -> Result<(), RelayError> {
        let url = self.share_url(
            &req.share_id,
            &format!("/blobs/{}", encode_segment(&req.sha256)),
            &[],
        );
        let _: WireOk = self.json(
            self.agent
                .put(&url)
                .header("authorization", &self.authorization())
                .send(req.bytes.as_slice()),
            RequestContext::Share,
        )?;
        Ok(())
    }

    fn share_proposal_submit(
        &self,
        req: ShareProposalSubmitRequest,
    ) -> Result<ShareProposalSubmitResponse, RelayError> {
        let body = WireShareProposalSubmitRequest {
            submit_id: &req.submit_id,
            ops: &req.ops,
        };
        let url = self.share_url(&req.share_id, "/proposals", &[]);
        let wire: WireShareProposalSubmitResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Share,
        )?;
        Ok(ShareProposalSubmitResponse {
            proposal_id: wire.proposal_id,
            ops: wire.ops,
        })
    }

    fn share_collection_write(
        &self,
        req: ShareCollectionWriteRequest,
    ) -> Result<ShareCollectionWriteResponse, RelayError> {
        let body = WireShareCollectionWriteRequest {
            submit_id: &req.submit_id,
            changes: &req.changes,
        };
        let url = self.share_url(&req.share_id, "/collection-writes", &[]);
        let mut response = self
            .agent
            .post(&url)
            .header("authorization", &self.authorization())
            .send_json(body)
            .map_err(map_transport_error)?;
        if response.status().is_success() {
            let wire: WireShareCollectionWriteResponse = response
                .body_mut()
                .with_config()
                .limit(MAX_JSON_RESPONSE_BYTES)
                .read_json()
                .map_err(|_| RelayError::InvalidResponse)?;
            return Ok(ShareCollectionWriteResponse::Written { paths: wire.paths });
        }
        collection_write_answer(&mut response)
    }
}

/// A direct write the relay did not take. A stale base and a refusal are
/// answers the recipient shows, so they come back as outcomes; every other
/// status is an error, mapped the way every other route maps it.
fn collection_write_answer(
    response: &mut Response<Body>,
) -> Result<ShareCollectionWriteResponse, RelayError> {
    let status = response.status().as_u16();
    if status == 401 {
        return Err(RelayError::Unauthorized);
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_ERROR_RESPONSE_BYTES)
        .read_json::<WireCollectionWriteError>()
        .ok();
    match body {
        Some(WireCollectionWriteError {
            code: Some(code),
            error,
            path,
            current_blob_sha256,
        }) => match code.as_str() {
            "stale" if status == 409 => Ok(ShareCollectionWriteResponse::Stale {
                path: path.ok_or(RelayError::InvalidResponse)?,
                current_blob_sha256,
            }),
            "share_op_rejected" if status == 403 => Ok(ShareCollectionWriteResponse::Refused {
                reason: error.unwrap_or_default(),
            }),
            other => Err(map_server_code(other, RequestContext::Share)),
        },
        _ => Err(match status {
            403 => RelayError::Forbidden,
            404 => unavailable(RequestContext::Share),
            409 => RelayError::Conflict,
            413 => RelayError::PayloadTooLarge,
            500..=599 => RelayError::ServerInternal,
            other => RelayError::HttpStatus(other),
        }),
    }
}

impl HttpRelayTransport {
    fn read_share_log(
        &self,
        share_id: &str,
        cursor: i64,
        limit: usize,
        extra_query: &[(&str, String)],
    ) -> Result<ShareViewResponse, RelayError> {
        let mut query = vec![("since", cursor.to_string()), ("limit", limit.to_string())];
        query.extend_from_slice(extra_query);
        let url = self.share_url(share_id, "/log", &query);
        let wire: WireLogPage = self.json(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Share,
        )?;
        Ok(ShareViewResponse {
            ops: wire
                .ops
                .into_iter()
                .map(WireLogRow::into_share_envelope)
                .collect(),
            next_cursor: wire.next_cursor,
            has_more: wire.has_more,
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum RequestContext {
    Workspace,
    Blob,
    Key,
    Share,
}

#[derive(Deserialize)]
struct ErrorBody {
    code: Option<String>,
}

fn base_url_is_allowed(base_url: &str, allow_insecure_loopback: bool) -> bool {
    if base_url.contains('#') {
        return false;
    }
    let Ok(uri) = base_url.parse::<Uri>() else {
        return false;
    };
    let Some(host) = uri.host() else {
        return false;
    };
    if uri.query().is_some() {
        return false;
    }
    match uri.scheme_str() {
        Some("https") => true,
        Some("http") if allow_insecure_loopback => {
            let host = host.trim_matches(['[', ']']);
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<IpAddr>()
                    .is_ok_and(|address| address.is_loopback())
        }
        _ => false,
    }
}

fn validate_outbound_payloads<'a>(
    payloads: impl IntoIterator<Item = &'a serde_json::Value>,
) -> Result<(), RelayError> {
    for payload in payloads {
        let encoded = serde_json::to_vec(payload).map_err(|_| RelayError::InvalidResponse)?;
        if encoded.len() > MAX_PAYLOAD_JSON_BYTES {
            return Err(RelayError::PayloadTooLarge);
        }
    }
    Ok(())
}

fn map_transport_error(error: ureq::Error) -> RelayError {
    match error {
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::ConnectionFailed
        | ureq::Error::Other(_) => RelayError::Partitioned,
        ureq::Error::StatusCode(status) => RelayError::HttpStatus(status),
        ureq::Error::BadUri(_)
        | ureq::Error::Http(_)
        | ureq::Error::HostNotFound
        | ureq::Error::RedirectFailed
        | ureq::Error::InvalidProxyUrl
        | ureq::Error::TooManyRedirects
        | ureq::Error::Tls(_)
        | ureq::Error::Pem(_)
        | ureq::Error::Rustls(_)
        | ureq::Error::RequireHttpsOnly(_)
        | ureq::Error::ConnectProxyFailed(_)
        | ureq::Error::TlsRequired => RelayError::BadRequest,
        ureq::Error::Protocol(_)
        | ureq::Error::BodyExceedsLimit(_)
        | ureq::Error::LargeResponseHeader(_, _)
        | ureq::Error::Json(_)
        | ureq::Error::BodyStalled => RelayError::InvalidResponse,
        _ => RelayError::InvalidResponse,
    }
}

fn map_http_error(response: &mut Response<Body>, context: RequestContext) -> RelayError {
    let status = response.status().as_u16();
    if status == 401 {
        return RelayError::Unauthorized;
    }
    let code = response
        .body_mut()
        .with_config()
        .limit(MAX_ERROR_RESPONSE_BYTES)
        .read_json::<ErrorBody>()
        .ok()
        .and_then(|body| body.code);
    if let Some(code) = code {
        return map_server_code(&code, context);
    }
    match status {
        300..=399 => RelayError::BadRequest,
        403 => RelayError::Forbidden,
        404 => unavailable(context),
        409 => RelayError::Conflict,
        413 => RelayError::PayloadTooLarge,
        500..=599 => RelayError::ServerInternal,
        other => RelayError::HttpStatus(other),
    }
}

macro_rules! define_server_error_codes {
    ($( $code:literal => $mapper:expr ),+ $(,)?) => {
        #[cfg(test)]
        const MAPPED_SERVER_CODES: &[&str] = &[$($code),+];

        fn map_server_code(code: &str, context: RequestContext) -> RelayError {
            match code {
                $($code => ($mapper)(context),)+
                unknown => RelayError::UnknownServerCode(unknown.to_owned()),
            }
        }
    };
}

define_server_error_codes! {
    "ambiguous_selector" => |_| RelayError::AmbiguousSelector,
    "authorship_mismatch" => |_| RelayError::AuthorshipMismatch,
    "bad_request" => |_| RelayError::BadRequest,
    "blob_missing" => |_| RelayError::BlobReferenceMissing,
    "blob_not_found" => |_| RelayError::BlobMissing,
    "collection_write_rate_limited" => |_| RelayError::HttpStatus(429),
    "conflict" => |_| RelayError::Conflict,
    "dependents_changed" => |_| RelayError::Conflict,
    "discussion_limit_reached" => |_| RelayError::QuotaExceeded,
    "discussion_rate_limited" => |_| RelayError::DiscussionRateLimited,
    "empty_selector" => |_| RelayError::BadRequest,
    "epoch_superseded" => |_| RelayError::EpochSuperseded,
    "identity_not_recognized" => |_| RelayError::IdentityNotRecognized,
    "identity_required" => |_| RelayError::IdentityRequired,
    "internal_error" => |_| RelayError::ServerInternal,
    "invalid_access" => |_| RelayError::BadRequest,
    "invalid_channel" => |_| RelayError::InvalidChannel,
    "invalid_path" => |_| RelayError::BadRequest,
    "invalid_version" => |_| RelayError::BadRequest,
    "key_envelope_not_found" => |_| RelayError::KeyEnvelopeMissing,
    "link_discussion_blocked" => |_| RelayError::Forbidden,
    "link_discussion_paused" => |_| RelayError::Forbidden,
    "link_read_rate_limited" => |_| RelayError::LinkReadRateLimited,
    "method_not_allowed" => |_| RelayError::MethodNotAllowed,
    "not_found" => unavailable,
    "notice_list_full" => |_| RelayError::Conflict,
    "notice_rate_limited" => |_| RelayError::HttpStatus(429),
    "notice_refused" => |_| RelayError::Forbidden,
    "payload_too_large" => |_| RelayError::PayloadTooLarge,
    "presence_capacity" => |_| RelayError::PresenceCapacity,
    "quota_exceeded" => |_| RelayError::QuotaExceeded,
    "secret_path" => |_| RelayError::BadRequest,
    "self_share" => |_| RelayError::SelfShare,
    "share_op_rejected" => |_| RelayError::ShareOperationRejected,
    "share_read_only" => |_| RelayError::ShareReadOnly,
    "stale" => |_| RelayError::Conflict,
    "stream_identity_mismatch" => |_| RelayError::StreamIdentityMismatch,
    "too_many_paths" => |_| RelayError::BadRequest,
    "unknown_chat_op" => |_| RelayError::UnknownChatOperation,
}

fn unavailable(context: RequestContext) -> RelayError {
    match context {
        RequestContext::Share => RelayError::ShareUnavailable,
        RequestContext::Blob | RequestContext::Key | RequestContext::Workspace => {
            RelayError::WorkspaceUnavailable
        }
    }
}

fn parse_etag(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
        .unwrap_or(trimmed);
    if unquoted.len() == 64
        && unquoted
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Some(unquoted.to_owned())
    } else {
        None
    }
}

fn encode_segment(value: &str) -> String {
    encode(value)
}

fn encode_query_component(value: &str) -> String {
    encode(value)
}

fn encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireClaimRequest<'a> {
    workspace_id: &'a str,
    replication_epoch: &'a str,
    stream_identity: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireEpochRequest<'a> {
    replication_epoch: &'a str,
    stream_identity: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireEpochResponse {
    rotated: bool,
    replication_epoch: String,
    stream_identity: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WirePushRequest<'a> {
    replication_epoch: &'a str,
    stream_identity: &'a str,
    origin_id: &'a str,
    ops: Vec<WireLogInput<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireLogInput<'a> {
    origin_seq: i64,
    op_kind: &'a str,
    payload: &'a serde_json::Value,
    recorded_at_ms: i64,
}

impl<'a> From<&'a ReplicationEnvelope> for WireLogInput<'a> {
    fn from(value: &'a ReplicationEnvelope) -> Self {
        Self {
            origin_seq: value.origin_seq,
            op_kind: &value.op_kind,
            payload: &value.payload,
            recorded_at_ms: value.recorded_at_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireSharePushRequest<'a> {
    origin_id: &'a str,
    ops: Vec<WireShareLogInput<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireShareLogInput<'a> {
    origin_seq: i64,
    op_kind: &'a str,
    payload: &'a serde_json::Value,
    recorded_at_ms: i64,
}

impl<'a> From<&'a ShareReplicationEnvelope> for WireShareLogInput<'a> {
    fn from(value: &'a ShareReplicationEnvelope) -> Self {
        Self {
            origin_seq: value.origin_seq,
            op_kind: &value.op_kind,
            payload: &value.payload,
            recorded_at_ms: value.recorded_at_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireShareProposalSubmitRequest<'a> {
    submit_id: &'a str,
    /// Serialized straight from the contract type: the relay's field names are
    /// its camelCase names, so a mirror here would only be a copy that drifts.
    ops: &'a [ShareProposalChange],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireShareProposalSubmitResponse {
    proposal_id: String,
    ops: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireShareCollectionWriteRequest<'a> {
    submit_id: &'a str,
    changes: &'a [ShareProposalChange],
}

/// The receipt also names the submit id, the commit time, and whether this
/// answer is a replay; the recipient needs only the paths.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireShareCollectionWriteResponse {
    paths: Vec<String>,
}

/// A refused direct write: the relay's code and message, and for a stale
/// base the path and the granter's current content.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireCollectionWriteError {
    code: Option<String>,
    error: Option<String>,
    path: Option<String>,
    current_blob_sha256: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WirePushResponse {
    accepted: usize,
    inserted: usize,
    skipped: usize,
    current_max_origin_seq: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireLogPage {
    ops: Vec<WireLogRow>,
    next_cursor: i64,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum WireLogCoordinateResponse {
    Present { op: WireLogRow },
    PresentBelowEpochFloor { op: WireLogRow },
    Absent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireLogRow {
    #[serde(rename = "relaySeq", default)]
    relay_seq: Option<i64>,
    workspace_id: Option<String>,
    origin_id: String,
    origin_seq: i64,
    op_kind: String,
    payload: serde_json::Value,
    recorded_at_ms: i64,
}

impl WireLogRow {
    fn into_workspace_envelope(self, workspace_id: String) -> ReplicationEnvelope {
        ReplicationEnvelope {
            workspace_id,
            origin_id: self.origin_id,
            origin_seq: self.origin_seq,
            relay_seq: self.relay_seq,
            op_kind: self.op_kind,
            payload: self.payload,
            recorded_at_ms: self.recorded_at_ms,
        }
    }

    fn into_share_envelope(self) -> ShareReplicationEnvelope {
        ShareReplicationEnvelope {
            origin_id: self.origin_id,
            origin_seq: self.origin_seq,
            op_kind: self.op_kind,
            payload: self.payload,
            recorded_at_ms: self.recorded_at_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WireBlobHaveRequest<'a> {
    replication_epoch: &'a str,
    stream_identity: &'a str,
    sha256s: &'a [String],
}

#[derive(Deserialize)]
struct WireBlobHaveResponse {
    missing: Vec<String>,
}

#[derive(Deserialize)]
struct WireOk {
    #[serde(rename = "ok")]
    _ok: bool,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::thread;

    use base64::Engine as _;
    use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
    use rustls::{ServerConfig, ServerConnection, StreamOwned};

    use super::*;

    #[derive(Deserialize)]
    struct RelayErrorFixture {
        code: String,
        status: u16,
    }

    /// The relay reads a proposed change's base pair as a stated fact — both
    /// halves or neither (`filterProposedChangeForShare`). An absent field and
    /// a null field must therefore not look the same on the wire, so every
    /// optional field is serialized rather than skipped.
    #[test]
    fn a_proposed_change_sends_every_absent_field_as_an_explicit_null() {
        let change = ShareProposalChange {
            based_on_path: None,
            based_on_blob_sha256: None,
            operation: "delete".to_owned(),
            after_path: None,
            after_blob_sha256: None,
            after_content_kind: None,
            after_byte_length: None,
            recorded_at_ms: 7,
        };
        let wire = serde_json::to_value(&change).expect("serialize");
        let record = wire.as_object().expect("a change is a JSON object");
        for field in [
            "basedOnPath",
            "basedOnBlobSha256",
            "afterPath",
            "afterBlobSha256",
            "afterContentKind",
            "afterByteLength",
        ] {
            assert_eq!(
                record.get(field),
                Some(&serde_json::Value::Null),
                "{field} must be sent as an explicit null, never skipped",
            );
        }
        assert_eq!(
            record.get("operation").and_then(serde_json::Value::as_str),
            Some("delete"),
        );
        assert_eq!(
            record
                .get("recordedAtMs")
                .and_then(serde_json::Value::as_i64),
            Some(7),
        );
        // The exact field set. `ShareProposalChange` derives `Serialize`, so a
        // field added to the struct reaches the granter's relay without anyone
        // deciding it should. This is what makes that a test failure instead.
        assert_eq!(
            record.keys().map(String::as_str).collect::<BTreeSet<_>>(),
            BTreeSet::from([
                "basedOnPath",
                "basedOnBlobSha256",
                "operation",
                "afterPath",
                "afterBlobSha256",
                "afterContentKind",
                "afterByteLength",
                "recordedAtMs",
            ]),
            "a new field on ShareProposalChange must not silently join the wire",
        );
    }

    #[test]
    fn dependents_changed_maps_to_conflict_for_share_requests() {
        assert_eq!(
            map_server_code("dependents_changed", RequestContext::Share),
            RelayError::Conflict
        );
    }

    #[test]
    fn mapped_server_codes_and_relay_fixture_are_bidirectional() {
        let fixture: Vec<RelayErrorFixture> = serde_json::from_str(include_str!(
            "../../../services/sync-relay/relay-error-codes.json"
        ))
        .expect("relay error-code fixture");
        let fixture_codes = fixture
            .iter()
            .map(|entry| entry.code.as_str())
            .collect::<BTreeSet<_>>();
        let mapped_codes = MAPPED_SERVER_CODES.iter().copied().collect::<BTreeSet<_>>();

        assert_eq!(
            fixture_codes.len(),
            fixture.len(),
            "fixture codes must be unique"
        );
        assert!(
            fixture
                .iter()
                .all(|entry| (400..=599).contains(&entry.status)),
            "fixture statuses must be HTTP errors"
        );
        assert_eq!(
            mapped_codes, fixture_codes,
            "the Rust code map and relay fixture must contain the same codes"
        );
    }

    const TEST_CERT_DER_BASE64: &str = "MIIDJTCCAg2gAwIBAgIUEHQ492IM8Ral38aCrsQtLAty8wAwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDcyNjIyMzQyNloXDTI2MDcyODIyMzQyNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAlas3XDBWs7j98PENiunFPUWT5X7I+PKLO7A+HFd3JMBwtYVtWBvxmBsLcZ+2Rx4eVJXtAjR4xxBHekNs3z44Ao9didAx485uOPPO8Ksj+cWNgZ4bAYrJrqF7sWEvhP7dilFLKT/vi0BnG/zrac8CEaHl5LzxpBZDOvsQ0mDY0RWXysq6QV37woJIY6wxJ0zJP93T5fl/a3sHE29WkSPgNIEBz85jVkbmmQBWXPEH4sQ0Ey7dOC2q+qZPOrfkgQrbXMHnPxO6LKrwVwRGnFgjIxqnjaOnBEsxyhVzgxe9oXoAIgooibIx7lZUFg72D+Wo9cRs2wTL3ZLJji8z0HD1JQIDAQABo28wbTAdBgNVHQ4EFgQU91mseAS1pHPttIK0/FAofXtrkIkwHwYDVR0jBBgwFoAU91mseAS1pHPttIK0/FAofXtrkIkwDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwDQYJKoZIhvcNAQELBQADggEBAAgv1+SbYGUsfw7FpwATOjt4lLSZYItTel9FtszmWsCnD2l9NaFaOeGLjHN/A/maczv3QGEIDu5ZD9jkNkabsPQeOsV2aR/266AW4OjbCCQ8GujSZxZzdoaUhjTumwI9sIkni6Z7FJuCL0ch8ljGh9YxIvtgmX05E9k1md9wsXOT56pCvQ8jmcdkxROpoGZOkJqyqmJ5P/rEf+bHsnjR9PGv2YqvS/984MaYBKmgZ4BhRd8QksAum7KHSczJ/pZL/YEg8AQowEf6vXgS7reXDjOQfc+Er+Lh9im01E56Fqp78RlnEo5ifGw/sn8vM0FescNxLs9pqZRX6haaYjT5S7o=";
    const TEST_KEY_DER_BASE64: &str = "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCVqzdcMFazuP3w8Q2K6cU9RZPlfsj48os7sD4cV3ckwHC1hW1YG/GYGwtxn7ZHHh5Ule0CNHjHEEd6Q2zfPjgCj12J0DHjzm44887wqyP5xY2BnhsBismuoXuxYS+E/t2KUUspP++LQGcb/OtpzwIRoeXkvPGkFkM6+xDSYNjRFZfKyrpBXfvCgkhjrDEnTMk/3dPl+X9rewcTb1aRI+A0gQHPzmNWRuaZAFZc8QfixDQTLt04Lar6pk86t+SBCttcwec/E7osqvBXBEacWCMjGqeNo6cESzHKFXODF72hegAiCiiJsjHuVlQWDvYP5aj1xGzbBMvdksmOLzPQcPUlAgMBAAECggEAAv3QL/QGL5zRdCWyEkyedOoombKUiSetfiZrv2MSJ9zLnYOXgWZuYdtpUz6Qq2nTMl6cXtBpeS6x0KRIKOTt93ZVG/v0Abkh1w3GEGWWfpei8ewukjPR2L80ITUvkkMKO4lpBqyKX0HZlCO65ggz4uIina7j54mYYDWEPkHR45ZSj5UAxhvTGoY+AdECQy7J96+czeKf2qsciBOtfwQDeivO+BHLFCKWYcgmMb+Dq91eXL4vdWZr29duWpr/7WXLmPfo9/4B6dkZbKxPxDg4PBUOSUsi4B0L2lXOBQY++To0FUdfFB9EiBBNHD9RrAqXHpNvLD77CFd4xsVzCUPScQKBgQDPuDZT2JYchrrdvBue8JS21JrMw2IHzQ5zIhMTWhFcGSNF/YhuLrVSsSFdYrmOFJ1aE5d7NQ1p7G19Pe/OcSoEkxeqMZaMjki1UAxqMoAmdC/lgYSkPsxZYjSw1VqpvHGlbyyg/FNbQC9U2mrYP+oo6lCxrYTwprDpApsbUfSELQKBgQC4dNnxwIL/loKoEXe8SuC7apTqvSfJwvAlBC3QH/hURHgIBpQ4R+ZzpT2+WPY3YY92ZxCSWJfySHaoHj/Dls1Q5wmQdrw5bn/sJ7dNGFSf7fdUoiHoydl0mdHgjhC5ZN76jFqiuAtboOA8MvpCo9xRApuhIVA7qDbPPadTMyx32QKBgQCZKbfFc3qcZiv7u+yR8ct2VKYgPiFWpzj0ZDe0mUEbq916ikvDEuXYp4t2lIlF3qV3+eJEkwXlCNRi+PyOOJtG7D8S26Wq1m9+YhwFYl9j+2Al1q67fSKo9eTsTyWe6rjRx3wc6HF+Y4GDC9qkwdwjd0MxAEV6PS9NYQKFzpSBsQKBgBWpIy7QfJGnCxDRfE4QPPPFQFeQfuuiiLDQHNEj7/V1VOMcYqt5RgaukOGZcNBwFHjDAZ8t6Cn7eHOlmbdOLi4h822Tg+b6ousIfu3+vXFKcJDvuSutCGw44/yKskwTHFwvvzT8h9jqu2pWUi0hMO4ScFQrpVBcIJOVmeCbUc2BAoGBALy89w8VTTKbHZ9EMHthbOF1DLxu939/li1J+q9vHh7Ie7T37CKZ+XZFS2od54g451QSDeaYHCihcC7YR2y/EfefPRRRjio157ULeZ2avB4Gd7tvVntYPv9+HG5pxLXkbgZL7b077vSL4kFi9m32V8Vo5SRsI8J722Npyq7q2spR";

    /// Answers one request on loopback with a canned status and JSON body,
    /// and hands back the request it read.
    fn answer_once(status: u16, body: &'static str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let base = format!(
            "http://{}",
            listener.local_addr().expect("loopback address")
        );
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = stream.read(&mut buffer).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);
                let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
                if head.contains("transfer-encoding: chunked") {
                    if request.ends_with(b"0\r\n\r\n") {
                        break;
                    }
                    continue;
                }
                let length = head
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:"))
                    .and_then(|value| value.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= end + 4 + length {
                    break;
                }
            }
            write!(
                stream,
                "HTTP/1.1 {status} Answer\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .expect("write answer");
            String::from_utf8_lossy(&request).into_owned()
        });
        (base, handle)
    }

    /// A stale base and a refusal come back as answers the recipient shows;
    /// every other refusal is an error, mapped as every route maps it.
    #[test]
    fn a_direct_write_reads_a_stale_base_and_a_refusal_as_answers() {
        let request = || ShareCollectionWriteRequest {
            share_id: "share-1".to_owned(),
            submit_id: "direct-1".to_owned(),
            changes: vec![ShareProposalChange {
                based_on_path: Some("trip/packing/collection.yaml".to_owned()),
                based_on_blob_sha256: Some("a".repeat(64)),
                operation: "write".to_owned(),
                after_path: Some("trip/packing/collection.yaml".to_owned()),
                after_blob_sha256: Some("b".repeat(64)),
                after_content_kind: Some("text".to_owned()),
                after_byte_length: Some(12),
                recorded_at_ms: 7,
            }],
        };
        let cases: [(
            u16,
            &'static str,
            Result<ShareCollectionWriteResponse, RelayError>,
        ); 5] = [
            (
                200,
                r#"{"ok":true,"submitId":"direct-1","paths":["trip/packing/collection.yaml"],"committedAtMs":9,"created":true}"#,
                Ok(ShareCollectionWriteResponse::Written {
                    paths: vec!["trip/packing/collection.yaml".to_owned()],
                }),
            ),
            (
                409,
                r#"{"ok":false,"error":"the file changed since you read it","code":"stale","path":"trip/packing/collection.yaml","currentBlobSha256":null}"#,
                Ok(ShareCollectionWriteResponse::Stale {
                    path: "trip/packing/collection.yaml".to_owned(),
                    current_blob_sha256: None,
                }),
            ),
            (
                403,
                r#"{"ok":false,"error":"trip/packing/collection.yaml is not a valid collection.yaml","code":"share_op_rejected"}"#,
                Ok(ShareCollectionWriteResponse::Refused {
                    reason: "trip/packing/collection.yaml is not a valid collection.yaml"
                        .to_owned(),
                }),
            ),
            (
                429,
                r#"{"ok":false,"error":"too many direct writes","code":"collection_write_rate_limited"}"#,
                Err(RelayError::HttpStatus(429)),
            ),
            (
                403,
                r#"{"ok":false,"error":"this share does not accept appends","code":"share_read_only"}"#,
                Err(RelayError::ShareReadOnly),
            ),
        ];
        for (status, body, expected) in cases {
            let (base, server) = answer_once(status, body);
            let transport = HttpRelayTransport::new_insecure_loopback_for_tests(base, "token")
                .expect("loopback transport");
            assert_eq!(
                transport.share_collection_write(request()),
                expected,
                "{status} {body}"
            );
            let sent = server.join().expect("server");
            assert!(
                sent.starts_with("POST /sync/shares/share-1/collection-writes "),
                "{sent}"
            );
            let body: serde_json::Value =
                serde_json::from_str(&sent[sent.find('{').expect("a JSON body")..])
                    .expect("the body is JSON");
            assert_eq!(body["submitId"], "direct-1", "{sent}");
            assert_eq!(body["changes"].as_array().map(Vec::len), Some(1), "{sent}");
        }
    }

    #[test]
    fn response_budget_covers_a_full_maximal_relay_page() {
        let required = MAX_PULL_OPS
            * (MAX_PAYLOAD_JSON_BYTES + MAX_LOG_ROW_RESPONSE_OVERHEAD_BYTES)
            + MAX_LOG_PAGE_RESPONSE_OVERHEAD_BYTES;
        assert!(
            usize::try_from(MAX_JSON_RESPONSE_BYTES).is_ok_and(|budget| budget >= required),
            "a legal 500-row page must fit the configured response budget"
        );
    }

    #[test]
    fn plaintext_bearer_transport_requires_the_debug_loopback_opt_in() {
        assert!(
            HttpRelayTransport::new("http://127.0.0.1:1", "token").is_err(),
            "accepting `http://` in the normal constructor makes the first two assertions expose a bearer token over plaintext."
        );
        assert!(HttpRelayTransport::new("http://localhost:1", "token").is_err());
        assert!(HttpRelayTransport::new("http://example.com", "token").is_err());
        assert!(HttpRelayTransport::new("https://example.com", "token").is_ok());

        #[cfg(debug_assertions)]
        {
            assert!(
                HttpRelayTransport::new_insecure_loopback_for_tests("http://127.0.0.1:1", "token")
                    .is_ok()
            );
            assert!(
                HttpRelayTransport::new_insecure_loopback_for_tests(
                    "http://localhost.evil.example:1",
                    "token"
                )
                .is_err()
            );
            assert!(
                HttpRelayTransport::new_insecure_loopback_for_tests(
                    "http://example.com:1",
                    "token"
                )
                .is_err()
            );
        }
    }

    #[test]
    fn relay_base_url_rejects_query_and_fragment_components() {
        assert!(HttpRelayTransport::new("https://relay.example?tenant=a", "token").is_err());
        assert!(HttpRelayTransport::new("https://relay.example/#fragment", "token").is_err());
        assert!(
            HttpRelayTransport::new("https://relay.example/base", "token").is_ok(),
            "ordinary path prefixes remain supported"
        );
    }

    #[test]
    fn production_https_agent_refuses_every_redirect_and_requires_https() {
        let transport =
            HttpRelayTransport::new("https://relay.example", "token").expect("https transport");
        assert!(
            transport.agent.config().https_only(),
            "disabling https_only permits an https base to downgrade on redirect"
        );
        assert_eq!(
            transport.agent.config().max_redirects(),
            0,
            "restoring ureq's redirect default reaches unvalidated destinations"
        );
    }

    #[test]
    fn https_base_redirect_to_http_is_refused() {
        let cert = base64::engine::general_purpose::STANDARD
            .decode(TEST_CERT_DER_BASE64)
            .expect("test certificate");
        let key = base64::engine::general_purpose::STANDARD
            .decode(TEST_KEY_DER_BASE64)
            .expect("test key");
        let server = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .expect("TLS server config");
        let listener = TcpListener::bind("127.0.0.1:0").expect("TLS listener");
        let port = listener.local_addr().expect("TLS address").port();
        let server = Arc::new(server);
        let thread = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("TLS accept");
            let connection = ServerConnection::new(server).expect("TLS connection");
            let mut stream = StreamOwned::new(connection, stream);
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("TLS request");
            stream
                .write_all(
                    b"HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/\r\n\
                      content-length: 0\r\nconnection: close\r\n\r\n",
                )
                .expect("TLS redirect");
            stream.flush().expect("TLS flush");
        });
        let tls_config = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::Rustls)
            .disable_verification(true)
            .build();
        let transport = HttpRelayTransport {
            base_url: format!("https://localhost:{port}"),
            token: "token".to_owned(),
            agent: configured_agent(Duration::from_secs(5), false, Some(tls_config)),
        };

        let error = transport
            .probe(ProbeRequest {
                workspace_id: "ws".to_owned(),
                replication_epoch: "epoch".to_owned(),
                stream_identity: "stream".to_owned(),
            })
            .expect_err("HTTPS downgrade redirect");
        assert_eq!(
            error,
            RelayError::BadRequest,
            "restoring redirects follows the HTTPS-to-HTTP downgrade"
        );
        thread.join().expect("TLS server thread");
    }

    #[test]
    fn cancelling_a_stalled_tls_blob_header_wait_settles_before_header_release() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::mpsc;
        use std::time::Duration;

        let cert = base64::engine::general_purpose::STANDARD
            .decode(TEST_CERT_DER_BASE64)
            .expect("test certificate");
        let key = base64::engine::general_purpose::STANDARD
            .decode(TEST_KEY_DER_BASE64)
            .expect("test key");
        let server = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .expect("TLS server config");
        let listener = TcpListener::bind("127.0.0.1:0").expect("TLS listener");
        let port = listener.local_addr().expect("TLS address").port();
        let server = Arc::new(server);
        let (request_received_tx, request_received_rx) = mpsc::channel();
        let (release_headers_tx, release_headers_rx) = mpsc::channel();
        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("TLS accept");
            let connection = ServerConnection::new(server).expect("TLS connection");
            let mut stream = StreamOwned::new(connection, stream);
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("TLS request");
            request_received_tx
                .send(())
                .expect("request received signal");
            release_headers_rx.recv().expect("release stalled headers");
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-length: 8\r\nconnection: close\r\n\r\npartdone",
            );
            let _ = stream.flush();
        });
        let tls_config = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::Rustls)
            .disable_verification(true)
            .build();
        let transport = HttpRelayTransport {
            base_url: format!("https://localhost:{port}"),
            token: "token".to_owned(),
            agent: configured_agent(Duration::from_secs(5), false, Some(tls_config)),
        };
        let (outcome_tx, outcome_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let request_cancelled = Arc::clone(&cancelled);
        let request_thread = thread::spawn(move || {
            let outcome = transport.download_blobs_cancellable(
                BlobDownloadBatchRequest {
                    workspace_id: "workspace".to_owned(),
                    replication_epoch: "epoch".to_owned(),
                    stream_identity: "stream".to_owned(),
                    blobs: vec![dohc_engine_sync::BlobDownloadSpec {
                        sha256: "blob".to_owned(),
                        limit_bytes: 8,
                    }],
                },
                || request_cancelled.load(Ordering::SeqCst),
            );
            outcome_tx.send(outcome).expect("blob request outcome");
        });

        request_received_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("TLS server receives blob request before cancellation");
        cancelled.store(true, Ordering::SeqCst);
        let outcome_before_release = outcome_rx.recv_timeout(Duration::from_secs(1));

        release_headers_tx.send(()).expect("release TLS server");
        request_thread.join().expect("blob request thread");
        server_thread.join().expect("TLS server thread");

        let outcome = outcome_before_release
            .expect("cancellation must settle while response headers are still stalled");
        assert!(
            matches!(&outcome, Err(RelayError::Local(reason)) if reason == "relay-io-cancelled"),
            "a cancelled header wait must not produce a relay response: {outcome:?}"
        );
    }

    #[test]
    fn cancelling_a_stalled_tls_blob_body_settles_before_body_release() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        use std::sync::mpsc;
        use std::time::Duration;

        let cert = base64::engine::general_purpose::STANDARD
            .decode(TEST_CERT_DER_BASE64)
            .expect("test certificate");
        let key = base64::engine::general_purpose::STANDARD
            .decode(TEST_KEY_DER_BASE64)
            .expect("test key");
        let server = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![CertificateDer::from(cert)],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)),
            )
            .expect("TLS server config");
        let listener = TcpListener::bind("127.0.0.1:0").expect("TLS listener");
        let port = listener.local_addr().expect("TLS address").port();
        let server = Arc::new(server);
        let (release_body_tx, release_body_rx) = mpsc::channel();
        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("TLS accept");
            let connection = ServerConnection::new(server).expect("TLS connection");
            let mut stream = StreamOwned::new(connection, stream);
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("TLS request");
            stream
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 8\r\nconnection: close\r\n\r\npart")
                .expect("partial TLS blob response");
            stream.flush().expect("partial TLS blob flush");
            release_body_rx.recv().expect("release stalled body");
            let _ = stream.write_all(b"done");
            let _ = stream.flush();
        });
        let tls_config = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::Rustls)
            .disable_verification(true)
            .build();
        let transport = HttpRelayTransport {
            base_url: format!("https://localhost:{port}"),
            token: "token".to_owned(),
            agent: configured_agent(Duration::from_secs(5), false, Some(tls_config)),
        };
        let (mid_body_tx, mid_body_rx) = mpsc::channel();
        let (outcome_tx, outcome_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let request_cancelled = Arc::clone(&cancelled);
        let checks = Arc::new(AtomicUsize::new(0));
        let request_checks = Arc::clone(&checks);
        const MID_BODY_CHECK_THRESHOLD: usize = 7;
        let request_thread = thread::spawn(move || {
            let outcome = transport.download_blobs_cancellable(
                BlobDownloadBatchRequest {
                    workspace_id: "workspace".to_owned(),
                    replication_epoch: "epoch".to_owned(),
                    stream_identity: "stream".to_owned(),
                    blobs: vec![dohc_engine_sync::BlobDownloadSpec {
                        sha256: "blob".to_owned(),
                        limit_bytes: 8,
                    }],
                },
                || {
                    let cancelled = request_cancelled.load(Ordering::SeqCst);
                    let check_count = request_checks.fetch_add(1, Ordering::SeqCst) + 1;
                    if check_count >= MID_BODY_CHECK_THRESHOLD {
                        mid_body_tx.send(()).expect("mid-body signal");
                    }
                    cancelled
                },
            );
            outcome_tx.send(outcome).expect("blob request outcome");
        });

        mid_body_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("client checks cancellation after reading partial body");
        cancelled.store(true, Ordering::SeqCst);
        let outcome_before_release = outcome_rx.recv_timeout(Duration::from_secs(1));

        release_body_tx.send(()).expect("release TLS server");
        request_thread.join().expect("blob request thread");
        server_thread.join().expect("TLS server thread");

        let outcome = outcome_before_release
            .expect("cancellation must settle while the next body chunk is still stalled");
        assert!(
            matches!(&outcome, Err(RelayError::Local(reason)) if reason == "relay-io-cancelled"),
            "a cancelled body must not expose the bytes read before cancellation: {outcome:?}"
        );
        assert!(checks.load(Ordering::SeqCst) >= 7);
    }

    #[test]
    fn loopback_opt_in_disables_https_only_but_still_refuses_redirects() {
        let transport =
            HttpRelayTransport::new_insecure_loopback_for_tests("http://127.0.0.1:1", "token")
                .expect("loopback transport");
        assert!(!transport.agent.config().https_only());
        assert_eq!(transport.agent.config().max_redirects(), 0);
    }

    #[test]
    fn permanent_transport_failures_are_not_classified_as_partitions() {
        for error in [
            ureq::Error::BadUri("bad".to_owned()),
            ureq::Error::HostNotFound,
            ureq::Error::InvalidProxyUrl,
            ureq::Error::Tls("certificate"),
            ureq::Error::ConnectProxyFailed("proxy".to_owned()),
        ] {
            assert_eq!(map_transport_error(error), RelayError::BadRequest);
        }
    }
}
