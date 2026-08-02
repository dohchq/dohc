//! Blocking HTTP implementation of the dependency-free relay transport seam.

#![forbid(unsafe_code)]

use std::net::IpAddr;
use std::time::Duration;

use dohc_engine_sync::{
    BlobDownloadRequest, BlobDownloadResponse, BlobHaveRequest, BlobHaveResponse,
    BlobUploadRequest, ClaimRequest, ClaimResponse, EpochRequest, EpochResponse,
    KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse, KeyEnvelopeRequest,
    KeyEnvelopeResponse, MAX_INGEST_BLOB_BYTES, MAX_PAYLOAD_JSON_BYTES, MAX_PULL_OPS, ProbeRequest,
    ProbeResponse, PullRequest, PullResponse, PushRequest, PushResponse, RelayError,
    RelayTransport, ReplicationEnvelope, ShareBlobRequest, ShareReplicationEnvelope,
    ShareViewRequest, ShareViewResponse, SharedChannelRequest, SharedChannelResponse,
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
/// The largest blob body a response may carry: the loosest ingest ceiling plus
/// the one byte that lets ingest observe an overage and refuse it by name.
const MAX_BLOB_BODY_BYTES: usize = MAX_INGEST_BLOB_BYTES + 1;
/// `ureq` refuses a body once a read reaches its limit, so the limit sits one
/// byte past the largest body this transport accepts.
const BLOB_BODY_READ_LIMIT_BYTES: usize = MAX_BLOB_BODY_BYTES + 1;

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
        Self::with_timeout(base_url, token, Duration::from_secs(30))
    }

    pub fn with_timeout(
        base_url: impl Into<String>,
        token: impl Into<String>,
        timeout: Duration,
    ) -> Result<Self, RelayError> {
        Self::build(base_url, token, timeout, false)
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
        Self::build(base_url, token, Duration::from_secs(30), true)
    }

    fn build(
        base_url: impl Into<String>,
        token: impl Into<String>,
        timeout: Duration,
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
            agent: configured_agent(timeout, allow_insecure_loopback, None),
        })
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
    ) -> Result<(Vec<u8>, Option<String>), RelayError> {
        let mut response = response.map_err(map_transport_error)?;
        if !response.status().is_success() {
            return Err(map_http_error(&mut response, context));
        }
        let etag = response
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .and_then(parse_etag);
        let bytes = response
            .body_mut()
            .with_config()
            .limit(read_limit_bytes as u64)
            .read_to_vec()
            .map_err(|_| RelayError::InvalidResponse)?;
        Ok((bytes, etag))
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
            ops.push(row.into_workspace_envelope(workspace_id));
        }
        Ok(PullResponse {
            ops,
            next_cursor: wire.next_cursor,
            has_more: wire.has_more,
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

    fn download_blob(&self, req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError> {
        let url = self.workspace_url(
            &req.workspace_id,
            &format!("/blobs/{}", encode_segment(&req.sha256)),
            &req.replication_epoch,
            &req.stream_identity,
            &[],
        );
        let (bytes, _) = self.bytes(
            self.agent
                .get(&url)
                .header("authorization", &self.authorization())
                .call(),
            RequestContext::Blob,
            BLOB_BODY_READ_LIMIT_BYTES,
        )?;
        Ok(BlobDownloadResponse { bytes })
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

    fn shared_channel_push(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError> {
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
        Ok(SharedChannelResponse {
            ops: Vec::new(),
            next_cursor: req.cursor,
            has_more: false,
            push: Some(PushResponse {
                accepted: wire.accepted,
                inserted: wire.inserted,
                skipped: wire.skipped,
                current_max_origin_seq: wire.current_max_origin_seq,
            }),
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
        )?;
        Ok(BlobDownloadResponse { bytes })
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
    "conflict" => |_| RelayError::Conflict,
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
    "method_not_allowed" => |_| RelayError::MethodNotAllowed,
    "not_found" => unavailable,
    "payload_too_large" => |_| RelayError::PayloadTooLarge,
    "presence_capacity" => |_| RelayError::PresenceCapacity,
    "quota_exceeded" => |_| RelayError::QuotaExceeded,
    "secret_path" => |_| RelayError::BadRequest,
    "self_share" => |_| RelayError::SelfShare,
    "share_op_rejected" => |_| RelayError::ShareOperationRejected,
    "share_read_only" => |_| RelayError::ShareReadOnly,
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
#[serde(rename_all = "camelCase")]
struct WireLogRow {
    #[serde(rename = "relaySeq", default)]
    _relay_seq: Option<i64>,
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

    #[test]
    fn response_budget_covers_a_full_maximal_relay_page() {
        // MUTATION: restoring the old 11 MiB budget fails this against the
        // relay's 500 × 256 KiB legal page.
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
        // MUTATION: accepting `http://` in the normal constructor makes the
        // first two assertions expose a bearer token over plaintext.
        assert!(HttpRelayTransport::new("http://127.0.0.1:1", "token").is_err());
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
            "MUTATION: disabling https_only permits an HTTPS base to downgrade on redirect"
        );
        assert_eq!(
            transport.agent.config().max_redirects(),
            0,
            "MUTATION: restoring ureq's redirect default reaches unvalidated destinations"
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
            "MUTATION: restoring redirects follows the HTTPS-to-HTTP downgrade"
        );
        thread.join().expect("TLS server thread");
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
