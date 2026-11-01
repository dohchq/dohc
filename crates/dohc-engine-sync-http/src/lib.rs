//! Blocking HTTP implementation of the dependency-free relay transport seam.

#![forbid(unsafe_code)]

#[cfg(unix)]
mod unix_socket;

use std::net::IpAddr;
use std::time::Duration;

use dohc_engine_sync::{
    BlobDownloadBatchRequest, BlobDownloadBatchResponse, BlobDownloadResponse, BlobHaveRequest,
    BlobHaveResponse, BlobUploadRequest, ClaimRequest, ClaimResponse, EpochRequest, EpochResponse,
    HostedPullRequest, HostedPullResponse, HostedScope, HostedScopeDocument,
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
/// Every engine request to the relay names the relay API version this build
/// speaks. Keep both equal to `packages/workspace-contracts/src/relayValues.ts`.
const RELAY_API_VERSION_HEADER: &str = "x-dohc-api-version";
const RELAY_API_VERSION: &str = "1";
const CANCELLABLE_BODY_READ_POLL_INTERVAL: Duration = Duration::from_millis(25);
/// A canceled synchronous read may live until its transport timeout. Each
/// limit matches the runtime's concurrency for that kind of read and is
/// shared by every workspace in the process, so those readers stay bounded.
const MAX_CANCELLABLE_BODY_READ_WORKERS: usize = 4;
const MAX_CANCELLABLE_COORDINATE_READ_WORKERS: usize = 8;
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

type ReadWorkerBudget = (std::sync::Mutex<usize>, std::sync::Condvar);

static CANCELLABLE_BODY_READ_WORKERS: std::sync::LazyLock<ReadWorkerBudget> =
    std::sync::LazyLock::new(|| (std::sync::Mutex::new(0), std::sync::Condvar::new()));
static CANCELLABLE_COORDINATE_READ_WORKERS: std::sync::LazyLock<ReadWorkerBudget> =
    std::sync::LazyLock::new(|| (std::sync::Mutex::new(0), std::sync::Condvar::new()));

struct ReadWorkerPermit {
    workers: &'static ReadWorkerBudget,
}

impl Drop for ReadWorkerPermit {
    fn drop(&mut self) {
        let (active, available) = self.workers;
        let mut active = active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = active.saturating_sub(1);
        available.notify_one();
    }
}

fn acquire_body_read_worker<C>(cancelled: &C) -> Result<ReadWorkerPermit, RelayError>
where
    C: Fn() -> bool + ?Sized,
{
    acquire_read_worker(
        &CANCELLABLE_BODY_READ_WORKERS,
        MAX_CANCELLABLE_BODY_READ_WORKERS,
        cancelled,
    )
}

fn acquire_read_worker<C>(
    workers: &'static ReadWorkerBudget,
    limit: usize,
    cancelled: &C,
) -> Result<ReadWorkerPermit, RelayError>
where
    C: Fn() -> bool + ?Sized,
{
    let (active, available) = workers;
    let mut active = active.lock().map_err(|_| RelayError::InvalidResponse)?;
    loop {
        if cancelled() {
            return Err(cancelled_relay_request());
        }
        if *active < limit {
            *active += 1;
            return Ok(ReadWorkerPermit { workers });
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
    /// Serves a hosted replica through the session host's scoped feed.
    hosted: bool,
}

impl std::fmt::Debug for HttpRelayTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpRelayTransport")
            .field("base_url", &self.base_url)
            .field("token", &"[redacted]")
            .field("hosted", &self.hosted)
            .finish_non_exhaustive()
    }
}

impl HttpRelayTransport {
    /// Local replica feed, with no TCP connector, proxy, TLS, or redirects.
    pub fn new_unix_socket(
        socket_path: &std::path::Path,
        token: impl Into<String>,
    ) -> Result<Self, RelayError> {
        let token = token.into();
        if !socket_path.is_absolute() || token.is_empty() {
            return Err(RelayError::InvalidResponse);
        }
        #[cfg(unix)]
        {
            let config = Agent::config_builder()
                .timeout_global(Some(Duration::from_secs(30)))
                .http_status_as_error(false)
                .https_only(false)
                .max_redirects(0)
                .proxy(None)
                .middleware(name_relay_api_version)
                .build();
            Ok(Self {
                base_url: "http://127.0.0.1".into(),
                token,
                hosted: false,
                agent: Agent::with_parts(
                    config,
                    unix_socket::UnixConnector(socket_path.into()),
                    unix_socket::UnixResolver,
                ),
            })
        }
        #[cfg(not(unix))]
        {
            Err(RelayError::Local("relay-unix-socket-unavailable".into()))
        }
    }

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

    /// Explicit debug-profile opt-in for HTTPS to an IP-literal loopback relay
    /// whose certificate chains to `ca_pem`, one test CA certificate.
    ///
    /// The agent trusts only that CA, not the WebPKI roots, and still verifies
    /// signatures and the address, requires HTTPS, and refuses redirects.
    /// `debug_assertions` is not a security boundary: callers must select this
    /// only on an explicit runtime test opt-in.
    #[cfg(debug_assertions)]
    pub fn new_with_test_ca_for_tests(
        base_url: impl Into<String>,
        token: impl Into<String>,
        ca_pem: &[u8],
    ) -> Result<Self, RelayError> {
        let mut transport = Self::build(base_url, token, false)?;
        if !names_ip_loopback(&transport.base_url) {
            return Err(RelayError::InvalidResponse);
        }
        let mut items = ureq::tls::parse_pem(ca_pem);
        let (Some(Ok(ureq::tls::PemItem::Certificate(ca))), None) = (items.next(), items.next())
        else {
            return Err(RelayError::InvalidResponse);
        };
        let tls_config = ureq::tls::TlsConfig::builder()
            .provider(ureq::tls::TlsProvider::Rustls)
            .root_certs(ureq::tls::RootCerts::new_with_certs(&[ca]))
            .build();
        transport.agent = configured_agent(Duration::from_secs(30), false, Some(tls_config));
        Ok(transport)
    }

    fn build(
        base_url: impl Into<String>,
        token: impl Into<String>,
        allow_insecure_loopback: bool,
    ) -> Result<Self, RelayError> {
        let base_url = base_url.into().trim_end_matches('/').to_owned();
        let token = token.into();
        if token.is_empty() {
            return Err(RelayError::InvalidResponse);
        }
        if !base_url_is_allowed(&base_url, allow_insecure_loopback) {
            // An https address refused for its query or fragment is malformed,
            // not a scheme the engine refuses.
            let https = base_url
                .get(..8)
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("https://"));
            return Err(if https {
                RelayError::InvalidResponse
            } else {
                RelayError::HttpsRequired
            });
        }
        Ok(Self {
            base_url,
            token,
            agent: configured_agent(Duration::from_secs(30), allow_insecure_loopback, None),
            hosted: false,
        })
    }

    /// This transport for a hosted replica. Its log, blob and coordinate
    /// requests go to the session host's scoped feed, under `/hosted/`.
    #[must_use]
    pub fn hosted(mut self) -> Self {
        self.hosted = true;
        self
    }

    /// The route prefix of the feed this transport's replica reads and writes.
    fn feed(&self) -> &'static str {
        if self.hosted { "/hosted" } else { "" }
    }

    /// Look up a coordinate while cooperatively observing request cancellation.
    pub fn lookup_log_coordinate_cancellable<C>(
        &self,
        req: LogCoordinateRequest,
        cancelled: C,
    ) -> Result<LogCoordinateResponse, RelayError>
    where
        C: Fn() -> bool,
    {
        self.lookup_log_coordinate_with_cancellation(req, Some(&cancelled))
    }

    fn lookup_log_coordinate_with_cancellation(
        &self,
        req: LogCoordinateRequest,
        cancelled: Option<&dyn Fn() -> bool>,
    ) -> Result<LogCoordinateResponse, RelayError> {
        if req.origin_seq < 0 || req.origin_seq > dohc_engine_sync::MAX_WIRE_INTEGER {
            return Err(RelayError::InvalidResponse);
        }
        let suffix = format!(
            "{}/log/{}/{}",
            self.feed(),
            encode_segment(&req.origin_id),
            req.origin_seq
        );
        let url = self.workspace_url(
            &req.workspace_id,
            &suffix,
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        )?;
        let request = self
            .agent
            .get(&url)
            .header("authorization", &self.authorization());
        let wire: WireLogCoordinateResponse = match cancelled {
            Some(cancelled) => {
                self.json_cancellable(move || request.call(), RequestContext::Workspace, cancelled)?
            }
            None => self.json(request.call(), RequestContext::Workspace)?,
        };
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
                    &format!("{}/blobs/{}", self.feed(), encode_segment(&blob.sha256)),
                    &req.replication_epoch,
                    &req.stream_identity,
                    &[],
                )?;
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

    /// The URL of a relay route. A hosted transport reaches only the session
    /// host's scoped feed, `/sync/:ws/hosted/`, and no other transport does.
    fn url(&self, path: &str) -> Result<String, RelayError> {
        let hosted_route = path
            .strip_prefix("/sync/")
            .and_then(|route| route.split_once('/'))
            .is_some_and(|(workspace, route)| {
                workspace != "shares" && route.starts_with("hosted/")
            });
        if hosted_route != self.hosted {
            return Err(if self.hosted {
                dohc_engine_sync::hosted_feed_only()
            } else {
                dohc_engine_sync::no_hosted_feed()
            });
        }
        Ok(format!("{}{}", self.base_url, path))
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
    ) -> Result<String, RelayError> {
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

    fn share_url(
        &self,
        share_id: &str,
        suffix: &str,
        query: &[(&str, String)],
    ) -> Result<String, RelayError> {
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
        decode_json_response(response, context)
    }

    fn json_cancellable<T, C, F>(
        &self,
        request: F,
        context: RequestContext,
        cancelled: &C,
    ) -> Result<T, RelayError>
    where
        T: DeserializeOwned + Send + 'static,
        C: Fn() -> bool + ?Sized,
        F: FnOnce() -> Result<Response<Body>, ureq::Error> + Send + 'static,
    {
        let permit = acquire_read_worker(
            &CANCELLABLE_COORDINATE_READ_WORKERS,
            MAX_CANCELLABLE_COORDINATE_READ_WORKERS,
            cancelled,
        )?;
        let (response_tx, response_rx) = std::sync::mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("dohc-relay-json-read".to_owned())
            .spawn(move || {
                let _permit = permit;
                let _ = response_tx.send(decode_json_response(request(), context));
            })
            .map_err(|_| RelayError::InvalidResponse)?;
        loop {
            if cancelled() {
                return Err(cancelled_relay_request());
            }
            match response_rx.recv_timeout(CANCELLABLE_BODY_READ_POLL_INTERVAL) {
                Ok(result) => {
                    worker.join().map_err(|_| RelayError::InvalidResponse)?;
                    return if cancelled() {
                        Err(cancelled_relay_request())
                    } else {
                        result
                    };
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    worker.join().map_err(|_| RelayError::InvalidResponse)?;
                    return Err(RelayError::InvalidResponse);
                }
            }
        }
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
        let response = response.map_err(map_transport_error)?;
        if cancelled.is_some_and(|cancelled| cancelled()) {
            return Err(cancelled_relay_request());
        }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            if status == 401 {
                return Err(RelayError::Unauthorized);
            }
            let body = read_response_body(
                response,
                MAX_ERROR_RESPONSE_BYTES,
                RelayError::InvalidResponse,
                cancelled,
            );
            if cancelled.is_some_and(|cancelled| cancelled()) {
                return Err(cancelled_relay_request());
            }
            let code = match body {
                Ok(bytes) => serde_json::from_slice::<ErrorBody>(&bytes)
                    .ok()
                    .and_then(|body| body.code),
                Err(error) if error == cancelled_relay_request() => return Err(error),
                Err(_) => None,
            };
            return Err(classify_http_error(status, code.as_deref(), context));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_etag);
        read_response_body(response, read_limit_bytes as u64, overflow, cancelled)
            .map(|bytes| (bytes, etag))
    }
}

fn read_response_body(
    response: Response<Body>,
    read_limit_bytes: u64,
    overflow: RelayError,
    cancelled: Option<&dyn Fn() -> bool>,
) -> Result<Vec<u8>, RelayError> {
    let mut reader = response
        .into_body()
        .into_with_config()
        .limit(read_limit_bytes)
        .reader();
    let Some(cancelled) = cancelled else {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            let read = std::io::Read::read(&mut reader, &mut chunk)
                .map_err(|error| map_body_read_error(error, &overflow))?;
            if read == 0 {
                return Ok(bytes);
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
            Ok(BodyReadWorkerMessage::Progress) => {
                #[cfg(test)]
                tests::signal_body_read_progress();
            }
            Ok(BodyReadWorkerMessage::Finished(result)) => {
                worker.join().map_err(|_| RelayError::InvalidResponse)?;
                return if cancelled() {
                    Err(cancelled_relay_request())
                } else {
                    result
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

fn decode_json_response<T: DeserializeOwned>(
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

fn configured_agent(
    timeout: Duration,
    allow_insecure_loopback: bool,
    tls_config: Option<ureq::tls::TlsConfig>,
) -> Agent {
    let builder = Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .https_only(!allow_insecure_loopback)
        .max_redirects(0)
        .middleware(name_relay_api_version);
    let builder = if let Some(tls_config) = tls_config {
        builder.tls_config(tls_config)
    } else {
        builder
    };
    builder.build().into()
}

fn name_relay_api_version(
    mut request: ureq::http::Request<ureq::SendBody>,
    next: ureq::middleware::MiddlewareNext,
) -> Result<Response<Body>, ureq::Error> {
    request.headers_mut().insert(
        RELAY_API_VERSION_HEADER,
        ureq::http::HeaderValue::from_static(RELAY_API_VERSION),
    );
    next.handle(request)
}

impl RelayTransport for HttpRelayTransport {
    fn publishes_native_settlements(&self) -> bool {
        // main.ts mounts this credential prefix for the native service replica.
        // The relay derives settlement authors from admitted live updates.
        self.token.starts_with("dohc-service-v1.")
    }

    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        self.push_log("/log", req)
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
        )?;
        let wire: WireLogPage = self.json(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Workspace,
        )?;
        Ok(PullResponse {
            ops: workspace_envelopes(wire.ops, &req.workspace_id)?,
            next_cursor: wire.next_cursor,
            has_more: wire.has_more,
        })
    }

    fn pull_hosted(&self, req: HostedPullRequest) -> Result<HostedPullResponse, RelayError> {
        // The feed serves the scope it holds to a request without `scope`.
        let mut query = vec![
            ("since", req.cursor.to_string()),
            ("limit", req.limit.to_string()),
        ];
        query.extend(req.scope_token.iter().map(|token| ("scope", token.clone())));
        query.extend(
            req.object_id
                .iter()
                .map(|object_id| ("object", object_id.clone())),
        );
        let url = self.workspace_url(
            &req.workspace_id,
            "/hosted/log",
            &req.replication_epoch,
            &req.stream_identity,
            &query,
        )?;
        let wire: WireHostedLogPage = self.json(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Workspace,
        )?;
        Ok(HostedPullResponse {
            scope: HostedScope {
                token: wire.scope.token,
                documents: wire
                    .scope
                    .documents
                    .into_iter()
                    .map(|document| HostedScopeDocument {
                        object_id: document.object_id,
                        path: document.path,
                    })
                    .collect(),
            },
            ops: workspace_envelopes(wire.ops, &req.workspace_id)?,
            next_cursor: wire.next_cursor,
            has_more: wire.has_more,
        })
    }

    fn push_hosted(&self, req: PushRequest) -> Result<PushResponse, RelayError> {
        self.push_log("/hosted/log", req)
    }

    fn lookup_log_coordinate(
        &self,
        req: LogCoordinateRequest,
    ) -> Result<LogCoordinateResponse, RelayError> {
        self.lookup_log_coordinate_with_cancellation(req, None)
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
                .post(&self.url("/sync/workspaces")?)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Claim,
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
        )?;
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
            &format!("{}/blobs/have", self.feed()),
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        )?;
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
            &format!("{}/blobs/{}", self.feed(), encode_segment(&req.sha256)),
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        )?;
        let _: WireOk = self.json(
            self.agent
                .put(&url)
                .header("authorization", &self.authorization())
                .send(req.bytes.as_slice()),
            RequestContext::Blob,
        )?;
        Ok(())
    }

    fn upload_blobs(&self, mut requests: Vec<BlobUploadRequest>) -> Result<(), RelayError> {
        if requests.is_empty() || requests.len() > dohc_engine_sync::MAX_BLOB_UPLOAD_BATCH {
            return Err(RelayError::InvalidResponse);
        }
        if requests.len() == 1 {
            return self.upload_blob(requests.remove(0));
        }
        std::thread::scope(|scope| {
            let jobs = requests
                .into_iter()
                .map(|request| scope.spawn(move || self.upload_blob(request)))
                .collect::<Vec<_>>();
            // Join every owned PUT before returning an error or allowing append.
            let results = jobs
                .into_iter()
                .map(|job| job.join().unwrap_or(Err(RelayError::InvalidResponse)))
                .collect::<Vec<_>>();
            results.into_iter().collect()
        })
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
        )?;
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
        )?;
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
        let has_origin = !req.origin_id.is_empty();
        let page = self.read_share_log(
            &req.share_id,
            req.cursor,
            MAX_PULL_OPS,
            &[
                ("channelWireId", req.channel_wire_id),
                ("originId", req.origin_id),
            ],
        )?;
        if has_origin && page.own_origin_id.as_ref().is_none_or(String::is_empty) {
            return Err(RelayError::InvalidResponse);
        }
        Ok(SharedChannelResponse {
            own_origin_id: page.own_origin_id,
            ops: page
                .ops
                .into_iter()
                .map(WireLogRow::into_share_envelope)
                .collect(),
            next_cursor: page.next_cursor,
            has_more: page.has_more,
            push: None,
        })
    }

    fn share_log_push(&self, req: ShareLogPushRequest) -> Result<PushResponse, RelayError> {
        let url = self.share_url(&req.share_id, "/log", &[])?;
        validate_outbound_payloads(req.ops.iter().map(|op| &op.payload))?;
        let body = WireSharePushRequest {
            origin_id: &req.origin_id,
            ops: req.ops.iter().map(WireShareLogInput::from).collect(),
        };
        let wire: WirePushResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Share,
        )?;
        Ok(PushResponse {
            settlement_refusals: wire.settlement_refusals,
            hosted_refusals: wire.hosted_refusals,
            redundant_recoveries: wire.redundant_recoveries,
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
            ops: page
                .ops
                .into_iter()
                .map(WireLogRow::into_share_envelope)
                .collect(),
            next_cursor: page.next_cursor,
            has_more: page.has_more,
        })
    }

    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError> {
        let url = self.share_url(
            &req.share_id,
            &format!("/blobs/{}", encode_segment(&req.sha256)),
            &[],
        )?;
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
        )?;
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
        let url = self.share_url(&req.share_id, "/proposals", &[])?;
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
        let url = self.share_url(&req.share_id, "/collection-writes", &[])?;
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
    fn push_log(&self, suffix: &str, req: PushRequest) -> Result<PushResponse, RelayError> {
        let url = self.workspace_url(
            &req.workspace_id,
            suffix,
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        )?;
        validate_outbound_payloads(req.ops.iter().map(|op| &op.payload))?;
        let body = WirePushRequest {
            replication_epoch: &req.replication_epoch,
            stream_identity: &req.stream_identity,
            origin_id: &req.origin_id,
            ops: req.ops.iter().map(WireLogInput::from).collect(),
        };
        let wire: WirePushResponse = self.json(
            self.agent
                .post(&url)
                .header("authorization", &self.authorization())
                .send_json(body),
            RequestContext::Workspace,
        )?;
        Ok(PushResponse {
            settlement_refusals: wire.settlement_refusals,
            hosted_refusals: wire.hosted_refusals,
            redundant_recoveries: wire.redundant_recoveries,
            accepted: wire.accepted,
            inserted: wire.inserted,
            skipped: wire.skipped,
            current_max_origin_seq: wire.current_max_origin_seq,
        })
    }

    fn read_share_log(
        &self,
        share_id: &str,
        cursor: i64,
        limit: usize,
        extra_query: &[(&str, String)],
    ) -> Result<WireLogPage, RelayError> {
        let mut query = vec![("since", cursor.to_string()), ("limit", limit.to_string())];
        query.extend_from_slice(extra_query);
        let url = self.share_url(share_id, "/log", &query)?;
        let wire: WireLogPage = self.json(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Share,
        )?;
        Ok(wire)
    }
}

#[derive(Debug, Clone, Copy)]
enum RequestContext {
    Claim,
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

#[cfg(debug_assertions)]
fn names_ip_loopback(base_url: &str) -> bool {
    let Ok(uri) = base_url.parse::<Uri>() else {
        return false;
    };
    let host = uri.host().unwrap_or_default().trim_matches(['[', ']']);
    host.parse().is_ok_and(|ip: IpAddr| ip.is_loopback())
}

/// A workspace log page's rows, each of `workspace_id` and at a relay position.
fn workspace_envelopes(
    rows: Vec<WireLogRow>,
    workspace_id: &str,
) -> Result<Vec<ReplicationEnvelope>, RelayError> {
    rows.into_iter()
        .map(|mut row| {
            let row_workspace_id = row.workspace_id.take().ok_or(RelayError::InvalidResponse)?;
            if row_workspace_id != workspace_id {
                return Err(RelayError::InvalidResponse);
            }
            let envelope = row.into_workspace_envelope(row_workspace_id);
            if envelope.relay_seq.is_none_or(|relay_seq| {
                !(0..=dohc_engine_sync::MAX_WIRE_INTEGER).contains(&relay_seq)
            }) {
                return Err(RelayError::InvalidResponse);
            }
            Ok(envelope)
        })
        .collect()
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
        // No connection reached the server. ureq reports a failed name lookup
        // as `Io`, and a lookup that found no address as `HostNotFound`.
        ureq::Error::Io(_)
        | ureq::Error::Timeout(_)
        | ureq::Error::ConnectionFailed
        | ureq::Error::HostNotFound
        | ureq::Error::Other(_) => RelayError::Partitioned,
        ureq::Error::StatusCode(status) => RelayError::HttpStatus(status),
        ureq::Error::BadUri(_)
        | ureq::Error::Http(_)
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
    classify_http_error(status, code.as_deref(), context)
}

fn classify_http_error(status: u16, code: Option<&str>, context: RequestContext) -> RelayError {
    if let Some(code) = code {
        return map_server_code(code, context);
    }
    match status {
        300..=399 => RelayError::BadRequest,
        403 => RelayError::Forbidden,
        404 if matches!(context, RequestContext::Claim) => RelayError::HttpStatus(404),
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
    "api_version_too_new" => |_| RelayError::ApiVersionTooNew,
    "api_version_too_old" => |_| RelayError::ApiVersionTooOld,
    "authorship_mismatch" => |_| RelayError::AuthorshipMismatch,
    "automation_host_rate_limited" => |_| RelayError::HttpStatus(429),
    "automation_press_rate_limited" => |_| RelayError::HttpStatus(429),
    "bad_request" => |_| RelayError::BadRequest,
    "blob_missing" => |_| RelayError::BlobReferenceMissing,
    "blob_not_found" => |_| RelayError::BlobMissing,
    "collection_write_rate_limited" => |_| RelayError::HttpStatus(429),
    "conflict" => |_| RelayError::Conflict,
    "restore-in-progress" => |_| RelayError::Conflict,
    "edits-pending" => |_| RelayError::Conflict,
    "host-diverged" => |_| RelayError::Conflict,
    "host-paused" => |_| RelayError::Conflict,
    "host-no-edit-grant" => |_| RelayError::Conflict,
    "host-moved" => |_| RelayError::Conflict,
    "host-start-failed" => |_| RelayError::Conflict,
    "host-not-loaded" => |_| RelayError::Conflict,
    "dependents_changed" => |_| RelayError::Conflict,
    "discussion_limit_reached" => |_| RelayError::QuotaExceeded,
    "discussion_rate_limited" => |_| RelayError::DiscussionRateLimited,
    "empty_selector" => |_| RelayError::BadRequest,
    "epoch_superseded" => |_| RelayError::EpochSuperseded,
    "held_read_busy" => |_| RelayError::HttpStatus(429),
    "identity_not_recognized" => |_| RelayError::IdentityNotRecognized,
    "identity_required" => |_| RelayError::IdentityRequired,
    "settlement_proof_budget" => |_| RelayError::SettlementProofBudget,
    "internal_error" => |_| RelayError::ServerInternal,
    "invalid_access" => |_| RelayError::BadRequest,
    "invalid_chat" => |_| RelayError::InvalidChannel,
    "invalid_path" => |_| RelayError::BadRequest,
    "invalid_version" => |_| RelayError::BadRequest,
    "key_envelope_not_found" => |_| RelayError::KeyEnvelopeMissing,
    "link_discussion_blocked" => |_| RelayError::Forbidden,
    "link_discussion_paused" => |_| RelayError::Forbidden,
    "link_name_already_set" => |_| RelayError::Conflict,
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
    "share_access_rate_limited" => |_| RelayError::ShareAccessRateLimited,
    "share_access_removed" => unavailable,
    "stale" => |_| RelayError::Conflict,
    "stream_identity_mismatch" => |_| RelayError::StreamIdentityMismatch,
    "too_many_paths" => |_| RelayError::BadRequest,
    "unknown_chat_op" => |_| RelayError::UnknownChatOperation,
}

fn unavailable(context: RequestContext) -> RelayError {
    match context {
        RequestContext::Share => RelayError::ShareUnavailable,
        RequestContext::Blob
        | RequestContext::Key
        | RequestContext::Workspace
        | RequestContext::Claim => RelayError::WorkspaceUnavailable,
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
    #[serde(default)]
    settlement_refusals: Vec<dohc_engine_sync::SettlementPublicationRefusal>,
    /// Only the hosted log refuses ops one at a time. Sync validates which push may carry them.
    #[serde(default, rename = "refusals")]
    hosted_refusals: Vec<dohc_engine_sync::HostedPushRefusal>,
    /// Only the owner's log names copies another device published first.
    #[serde(default)]
    redundant_recoveries: Vec<dohc_engine_sync::RedundantRecovery>,
    accepted: usize,
    inserted: usize,
    skipped: usize,
    current_max_origin_seq: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireLogPage {
    own_origin_id: Option<String>,
    ops: Vec<WireLogRow>,
    next_cursor: i64,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireHostedLogPage {
    scope: WireHostedScope,
    ops: Vec<WireLogRow>,
    next_cursor: i64,
    has_more: bool,
}

#[derive(Deserialize)]
struct WireHostedScope {
    token: String,
    documents: Vec<WireHostedScopeDocument>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireHostedScopeDocument {
    object_id: String,
    path: String,
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
    #[serde(default)]
    settlement_admission: Option<dohc_engine_sync::SettlementAdmission>,
    #[serde(default)]
    admitted_author_snapshot: Option<serde_json::Value>,
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
            settlement_admission: self.settlement_admission,
            admitted_author_snapshot: self.admitted_author_snapshot,
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

    thread_local! {
        static BODY_READ_PROGRESS: std::cell::RefCell<Option<std::sync::mpsc::Sender<()>>> =
            const { std::cell::RefCell::new(None) };
    }

    pub(super) fn signal_body_read_progress() {
        BODY_READ_PROGRESS.with_borrow_mut(|signal| {
            if let Some(signal) = signal.take() {
                let _ = signal.send(());
            }
        });
    }

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
    fn relay_api_version_matches_the_typescript_contract() {
        let contract = include_str!("../../../packages/workspace-contracts/src/relayValues.ts");
        assert!(contract.contains(&format!(
            "export const RELAY_API_VERSION_HEADER = \"{RELAY_API_VERSION_HEADER}\";"
        )));
        assert!(contract.contains(&format!(
            "export const RELAY_API_VERSION = {RELAY_API_VERSION};"
        )));
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
    fn answer_once(status: u16, body: impl Into<String>) -> (String, thread::JoinHandle<String>) {
        let body = body.into();
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

    #[test]
    fn cancellable_error_reads_preserve_codes_statuses_and_the_error_body_bound() {
        let cases = [
            (
                401,
                r#"{"code":"blob_not_found"}"#.to_owned(),
                RelayError::Unauthorized,
            ),
            (403, "not JSON".to_owned(), RelayError::Forbidden),
            (404, "{}".to_owned(), RelayError::WorkspaceUnavailable),
            (500, "{}".to_owned(), RelayError::ServerInternal),
            (
                500,
                r#"{"code":"blob_not_found"}"#.to_owned(),
                RelayError::BlobMissing,
            ),
            (
                500,
                r#"{"code":"future_code"}"#.to_owned(),
                RelayError::UnknownServerCode("future_code".to_owned()),
            ),
            (
                500,
                format!(
                    r#"{{"code":"blob_not_found","padding":"{}"}}"#,
                    "x".repeat(MAX_ERROR_RESPONSE_BYTES as usize)
                ),
                RelayError::ServerInternal,
            ),
        ];
        for (status, body, expected) in cases {
            let (base, server) = answer_once(status, body);
            let transport = HttpRelayTransport::new_insecure_loopback_for_tests(base, "token")
                .expect("loopback transport");
            let outcome = transport
                .download_blobs_cancellable(
                    BlobDownloadBatchRequest {
                        workspace_id: "workspace".to_owned(),
                        replication_epoch: "epoch".to_owned(),
                        stream_identity: "stream".to_owned(),
                        blobs: vec![dohc_engine_sync::BlobDownloadSpec {
                            sha256: "blob".to_owned(),
                            limit_bytes: 8,
                        }],
                    },
                    || false,
                )
                .expect("download batch");
            server.join().expect("server");
            assert_eq!(outcome.results, vec![Err(expected)], "status {status}");
        }
    }

    #[test]
    fn settlement_carriers_survive_pull_and_coordinate_lookup_without_changing_payloads() {
        for (admission, authors, payload) in [
            (
                serde_json::json!({"status":"accepted","settlementId":"settlement"}),
                Some(
                    serde_json::json!([{"kind":"human","humanId":"contributor","humanName":"Alex"}]),
                ),
                serde_json::json!({"momentId":"moment","settlementReference":{"record":{"settlementId":"settlement"}}}),
            ),
            (
                serde_json::json!({"status":"refused","settlementId":"unavailable","reason":"authorship-mismatch"}),
                None,
                serde_json::json!({"momentId":null,"settlementReference":"malformed","payloadAfterBlobSha256":"phantom"}),
            ),
        ] {
            let row = serde_json::json!({"workspaceId":"ws","originId":"origin","originSeq":0,"relaySeq":1,
                "opKind":"moment.append","recordedAtMs":7,"payload":payload,
                "settlementAdmission":admission,"admittedAuthorSnapshot":authors});
            let (base, server) = answer_once(
                200,
                serde_json::json!({"ops":[row.clone()],"nextCursor":1,"hasMore":false}).to_string(),
            );
            let transport =
                HttpRelayTransport::new_insecure_loopback_for_tests(base, "token").unwrap();
            let pulled = transport
                .pull(PullRequest {
                    workspace_id: "ws".into(),
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    cursor: 0,
                    limit: 10,
                })
                .unwrap();
            server.join().unwrap();
            let op = &pulled.ops[0];
            assert_eq!(
                serde_json::to_value(&op.settlement_admission).unwrap(),
                admission
            );
            assert_eq!(op.admitted_author_snapshot, authors);
            assert_eq!(op.payload, payload);
            let (base, server) = answer_once(
                200,
                serde_json::json!({"status":"presentBelowEpochFloor","op":row}).to_string(),
            );
            let transport =
                HttpRelayTransport::new_insecure_loopback_for_tests(base, "token").unwrap();
            let looked = transport
                .lookup_log_coordinate(LogCoordinateRequest {
                    workspace_id: "ws".into(),
                    replication_epoch: "epoch".into(),
                    stream_identity: "stream".into(),
                    origin_id: "origin".into(),
                    origin_seq: 0,
                })
                .unwrap();
            assert_eq!(
                looked,
                LogCoordinateResponse::PresentBelowEpochFloor(op.clone())
            );
            server.join().unwrap();
        }
    }

    #[test]
    fn settlement_push_sends_original_payload_without_server_metadata_and_reads_refusals() {
        let payload = serde_json::json!({"momentId":null,"settlementReference":"malformed"});
        let op = ReplicationEnvelope {
            workspace_id: "ws".into(),
            origin_id: "origin".into(),
            origin_seq: 0,
            relay_seq: Some(9),
            op_kind: "moment.append".into(),
            payload: payload.clone(),
            recorded_at_ms: 7,
            settlement_admission: Some(dohc_engine_sync::SettlementAdmission::Accepted {
                settlement_id: "forged".into(),
            }),
            admitted_author_snapshot: Some(
                serde_json::json!([{"kind":"human","humanId":"forged"}]),
            ),
        };
        let (base, server) = answer_once(
            200,
            r#"{"accepted":1,"inserted":1,"skipped":0,"currentMaxOriginSeq":0,"settlementRefusals":[{"originId":"origin","originSeq":0,"momentId":"unavailable","settlementId":"unavailable","reason":"authorship-mismatch"}]}"#,
        );
        let transport = HttpRelayTransport::new_insecure_loopback_for_tests(base, "token").unwrap();
        let response = transport
            .push(PushRequest {
                workspace_id: "ws".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "origin".into(),
                after_seq: -1,
                ops: vec![op],
            })
            .unwrap();
        assert_eq!(response.settlement_refusals.len(), 1);
        assert_eq!(response.settlement_refusals[0].moment_id, "unavailable");
        let sent = server.join().unwrap();
        let body: serde_json::Value =
            serde_json::from_str(&sent[sent.find('{').unwrap()..]).unwrap();
        assert_eq!(body["ops"][0]["payload"], payload);
        assert_eq!(
            body["ops"][0]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["originSeq", "opKind", "payload", "recordedAtMs"])
        );
    }

    #[test]
    fn hosted_push_reads_the_relays_refusal_of_each_op() {
        let op = ReplicationEnvelope {
            workspace_id: "ws".into(),
            origin_id: "service-host:host".into(),
            origin_seq: 3,
            relay_seq: None,
            op_kind: "ydoc.update".into(),
            payload: serde_json::json!({"objectId":"object"}),
            recorded_at_ms: 7,
            settlement_admission: None,
            admitted_author_snapshot: None,
        };
        let (base, server) = answer_once(
            200,
            r#"{"ok":true,"accepted":1,"inserted":1,"skipped":0,"currentMaxOriginSeq":3,"refusals":[{"originId":"service-host:host","originSeq":3,"opKind":"ydoc.update","reason":"outside-hosted-documents"}]}"#,
        );
        let transport = HttpRelayTransport::new_insecure_loopback_for_tests(base, "token")
            .unwrap()
            .hosted();
        let response = transport
            .push_hosted(PushRequest {
                workspace_id: "ws".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "service-host:host".into(),
                after_seq: 2,
                ops: vec![op],
            })
            .unwrap();
        assert_eq!(
            response.hosted_refusals,
            [dohc_engine_sync::HostedPushRefusal {
                origin_id: "service-host:host".into(),
                origin_seq: 3,
                op_kind: "ydoc.update".into(),
                reason: "outside-hosted-documents".into(),
            }]
        );
        assert!(server.join().unwrap().contains("/sync/ws/hosted/log"));
    }

    #[test]
    fn settlement_proof_budget_503_is_retryable() {
        let (base, server) = answer_once(
            503,
            r#"{"code":"settlement_proof_budget","error":"Publication proof exceeds this request's budget."}"#,
        );
        let transport = HttpRelayTransport::new_insecure_loopback_for_tests(base, "token").unwrap();
        assert_eq!(
            transport.push(PushRequest {
                workspace_id: "ws".into(),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "origin".into(),
                after_seq: -1,
                ops: vec![]
            }),
            Err(RelayError::SettlementProofBudget)
        );
        server.join().unwrap();
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
    fn native_settlement_authors_follow_the_service_credential_route() {
        for (token, native) in [
            ("dohc-service-v1.test", true),
            ("dohc-automation-v1.test", false),
            ("test:owner", false),
        ] {
            let transport = HttpRelayTransport::new("https://relay.example", token).unwrap();
            assert_eq!(transport.publishes_native_settlements(), native);
        }
    }

    #[test]
    fn plaintext_bearer_transport_requires_the_debug_loopback_opt_in() {
        assert_eq!(
            HttpRelayTransport::new("http://127.0.0.1:1", "token").err(),
            Some(RelayError::HttpsRequired),
            "accepting `http://` in the normal constructor makes the first two assertions expose a bearer token over plaintext."
        );
        assert_eq!(
            HttpRelayTransport::new("http://localhost:1", "token").err(),
            Some(RelayError::HttpsRequired)
        );
        assert_eq!(
            HttpRelayTransport::new("http://example.com", "token").err(),
            Some(RelayError::HttpsRequired)
        );
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
        assert_eq!(
            HttpRelayTransport::new("https://relay.example?tenant=a", "token").err(),
            Some(RelayError::InvalidResponse),
            "a malformed https address must not tell the person to use https"
        );
        assert_eq!(
            HttpRelayTransport::new("HTTPS://relay.example/#fragment", "token").err(),
            Some(RelayError::InvalidResponse)
        );
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
            hosted: false,
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
            hosted: false,
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
        assert_stalled_blob_body_cancels(200, "partdone");
    }

    #[test]
    fn cancelling_stalled_tls_blob_error_bodies_settles_before_body_release() {
        for status in [404, 500] {
            assert_stalled_blob_body_cancels(status, r#"{"code":"blob_not_found"}"#);
        }
    }

    fn assert_stalled_blob_body_cancels(status: u16, body: &'static str) {
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
        let (release_body_tx, release_body_rx) = mpsc::channel();
        let server_thread = thread::spawn(move || {
            let (stream, _) = listener.accept().expect("TLS accept");
            let connection = ServerConnection::new(server).expect("TLS connection");
            let mut stream = StreamOwned::new(connection, stream);
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request).expect("TLS request");
            let partial_response = format!(
                "HTTP/1.1 {status} Answer\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                &body[..4],
            );
            stream
                .write_all(partial_response.as_bytes())
                .expect("partial TLS blob response");
            stream.flush().expect("partial TLS blob flush");
            release_body_rx.recv().expect("release stalled body");
            let _ = stream.write_all(&body.as_bytes()[4..]);
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
            hosted: false,
        };
        let (mid_body_tx, mid_body_rx) = mpsc::channel();
        let (outcome_tx, outcome_rx) = mpsc::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let request_cancelled = Arc::clone(&cancelled);
        let request_thread = thread::spawn(move || {
            BODY_READ_PROGRESS.with_borrow_mut(|signal| *signal = Some(mid_body_tx));
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

        let partial_body_read = mid_body_rx.recv_timeout(Duration::from_secs(10));
        cancelled.store(true, Ordering::SeqCst);
        let outcome_before_release = outcome_rx.recv_timeout(Duration::from_secs(1));

        let _ = release_body_tx.send(());
        request_thread.join().expect("blob request thread");
        server_thread.join().expect("TLS server thread");

        partial_body_read.expect("client reads partial body before cancellation");
        let outcome = outcome_before_release
            .expect("cancellation must settle while the next body chunk is still stalled");
        assert!(
            matches!(&outcome, Err(RelayError::Local(reason)) if reason == "relay-io-cancelled"),
            "a cancelled body must not expose the bytes read before cancellation: {outcome:?}"
        );
    }

    #[test]
    fn loopback_opt_in_disables_https_only_but_still_refuses_redirects() {
        let transport =
            HttpRelayTransport::new_insecure_loopback_for_tests("http://127.0.0.1:1", "token")
                .expect("loopback transport");
        assert!(!transport.agent.config().https_only());
        assert_eq!(transport.agent.config().max_redirects(), 0);
    }

    /// The debug-only constructor that trusts one test CA, against a real TLS
    /// server. The synthetic fixtures come from
    /// services/share-web/src/testing/mintRelayTlsFixtures.ts; nothing outside
    /// these tests trusts their CA or uses their key.
    #[cfg(debug_assertions)]
    mod test_ca {
        use rustls::pki_types::pem::PemObject as _;

        use super::*;

        const CA: &str = include_str!("../tests/fixtures/tls/relay-test-ca.pem");
        const LEAF: &str = include_str!("../tests/fixtures/tls/relay-test-leaf.pem");
        const LEAF_KEY: &str = include_str!("../tests/fixtures/tls/relay-test-leaf-key.pem");
        /// Signed by the CA for relay.invalid and 127.0.0.2.
        const WRONG_HOST_LEAF: &str =
            include_str!("../tests/fixtures/tls/relay-test-wrong-host-leaf.pem");
        /// Signed by another key under the CA's name.
        const IMPOSTOR_LEAF: &str =
            include_str!("../tests/fixtures/tls/relay-test-impostor-leaf.pem");

        /// Serves one TLS connection and answers 401. Hands back the request
        /// it read, or `None` when the client refused the handshake.
        fn answer_once(leaf: &str) -> (u16, thread::JoinHandle<Option<String>>) {
            let leaf = CertificateDer::from_pem_slice(leaf.as_bytes()).expect("test leaf");
            let key = PrivateKeyDer::from_pem_slice(LEAF_KEY.as_bytes()).expect("test key");
            let server = ServerConfig::builder().with_no_client_auth();
            let server = Arc::new(server.with_single_cert(vec![leaf], key).unwrap());
            let listener = TcpListener::bind("127.0.0.1:0").expect("TLS listener");
            let port = listener.local_addr().expect("TLS address").port();
            let handle = thread::spawn(move || {
                let (stream, _) = listener.accept().expect("TLS accept");
                let connection = ServerConnection::new(server).expect("TLS connection");
                let mut stream = StreamOwned::new(connection, stream);
                let mut request = [0_u8; 4096];
                let read = stream.read(&mut request).ok().filter(|read| *read > 0)?;
                let answer = "HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n";
                stream.write_all(answer.as_bytes()).ok()?;
                stream.flush().ok()?;
                let request = String::from_utf8_lossy(&request[..read]);
                Some(request.to_ascii_lowercase())
            });
            (port, handle)
        }

        /// The request's outcome, and what the server read of it.
        type Probe = (Result<(), RelayError>, Option<String>);

        /// Probes a server presenting `leaf` through `connect`'s transport.
        fn probe(leaf: &str, connect: impl FnOnce(String) -> HttpRelayTransport) -> Probe {
            let (port, server) = answer_once(leaf);
            let transport = connect(format!("https://127.0.0.1:{port}"));
            let outcome = transport.probe(ProbeRequest {
                workspace_id: "ws".to_owned(),
                replication_epoch: "epoch".to_owned(),
                stream_identity: "stream".to_owned(),
            });
            let request = server.join().expect("TLS server thread");
            (outcome.map(drop), request)
        }

        fn trusting_the_test_ca(base_url: String) -> HttpRelayTransport {
            HttpRelayTransport::new_with_test_ca_for_tests(base_url, "token", CA.as_bytes())
                .expect("test CA transport")
        }

        /// A refusal is a failed request whose bearer never reached the
        /// server. Which error names it depends on the platform's TLS stack.
        fn assert_refused((outcome, request): Probe, case: &str) {
            assert!(outcome.is_err(), "{case} was accepted");
            assert_eq!(request, None, "{case} received the bearer");
        }

        #[test]
        fn trusts_the_test_ca_and_still_verifies_the_server() {
            let (outcome, request) = probe(LEAF, trusting_the_test_ca);
            assert_eq!(outcome, Err(RelayError::Unauthorized));
            let request = request.expect("the test CA's server was refused");
            assert!(request.contains("authorization: bearer token"));

            let wrong_host = probe(WRONG_HOST_LEAF, trusting_the_test_ca);
            assert_refused(wrong_host, "a leaf for another address");
            let impostor = probe(IMPOSTOR_LEAF, trusting_the_test_ca);
            assert_refused(impostor, "a leaf the CA did not sign");
        }

        #[test]
        fn the_production_constructor_refuses_the_test_ca() {
            let production = |base_url: String| HttpRelayTransport::new(base_url, "token").unwrap();
            assert_refused(probe(LEAF, production), "the test CA's leaf");
        }

        #[test]
        fn requires_loopback_https_one_certificate_and_no_redirects() {
            let ca_pem = CA.as_bytes();
            let transport =
                HttpRelayTransport::new_with_test_ca_for_tests("https://[::1]:1", "token", ca_pem)
                    .expect("IPv6 loopback");
            let config = transport.agent.config();
            assert!(config.https_only());
            assert_eq!(config.max_redirects(), 0);
            assert!(!config.tls_config().disable_verification());
            let roots = config.tls_config().root_certs();
            assert!(
                matches!(roots, ureq::tls::RootCerts::Specific(roots) if roots.len() == 1),
                "the transport must trust the test CA alone, not the WebPKI roots"
            );

            for (base_url, token) in [
                ("http://127.0.0.1:1", "token"),
                ("https://localhost:1", "token"),
                ("https://10.0.0.1:1", "token"),
                ("https://example.com", "token"),
                ("https://127.0.0.1:1", ""),
            ] {
                assert!(
                    HttpRelayTransport::new_with_test_ca_for_tests(base_url, token, ca_pem)
                        .is_err(),
                    "{base_url} with token {token:?} must not reach the test CA transport"
                );
            }

            let key_pem = LEAF_KEY.as_bytes();
            let base_url = "https://127.0.0.1:1";
            for malformed in [
                Vec::new(),
                b"not a certificate".to_vec(),
                key_pem.to_vec(),
                [ca_pem, key_pem].concat(),
                [ca_pem, ca_pem].concat(),
            ] {
                assert!(
                    HttpRelayTransport::new_with_test_ca_for_tests(base_url, "token", &malformed)
                        .is_err(),
                    "a CA file that is not exactly one certificate must be refused"
                );
            }
        }
    }

    // The desktop names a partition "Server unreachable". A lookup that found
    // no address read as a bad request, so it reached a person as an
    // unknown failure.
    #[test]
    fn failures_that_never_reach_the_server_are_partitions() {
        for error in [
            ureq::Error::ConnectionFailed,
            ureq::Error::HostNotFound,
            ureq::Error::Io(std::io::Error::from(std::io::ErrorKind::NotFound)),
        ] {
            assert_eq!(map_transport_error(error), RelayError::Partitioned);
        }
    }

    #[test]
    fn permanent_transport_failures_are_not_classified_as_partitions() {
        for error in [
            ureq::Error::BadUri("bad".to_owned()),
            ureq::Error::InvalidProxyUrl,
            ureq::Error::Tls("certificate"),
            ureq::Error::ConnectProxyFailed("proxy".to_owned()),
        ] {
            assert_eq!(map_transport_error(error), RelayError::BadRequest);
        }
    }
}
