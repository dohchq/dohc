//! Blocking HTTP implementation of the dependency-free relay transport seam.

#![forbid(unsafe_code)]

use std::net::IpAddr;
use std::time::Duration;

use dohc_engine_sync::{
    BlobDownloadRequest, BlobDownloadResponse, BlobHaveRequest, BlobHaveResponse,
    BlobUploadRequest, ClaimRequest, ClaimResponse, EpochRequest, EpochResponse,
    KeyEnvelopeDownloadRequest, KeyEnvelopeDownloadResponse, KeyEnvelopeRequest,
    KeyEnvelopeResponse, MAX_PAYLOAD_JSON_BYTES, MAX_PULL_OPS, ProbeRequest, ProbeResponse,
    PullRequest, PullResponse, PushRequest, PushResponse, RelayError, RelayTransport,
    ReplicationEnvelope, ShareBlobRequest, ShareReplicationEnvelope, ShareViewRequest,
    ShareViewResponse, SharedChannelRequest, SharedChannelResponse,
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
const MAX_BLOB_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

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

    /// Explicit debug/test-only opt-in for authenticated loopback HTTP.
    ///
    /// This constructor is absent from release builds, so production code
    /// cannot enable plaintext bearer transport through runtime configuration.
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
        let config = Agent::config_builder()
            .timeout_global(Some(timeout))
            .http_status_as_error(false)
            .build();
        Ok(Self {
            base_url,
            token,
            agent: config.into(),
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
        limit: usize,
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
            .limit(limit as u64)
            .read_to_vec()
            .map_err(|_| RelayError::InvalidResponse)?;
        Ok((bytes, etag))
    }
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
            MAX_BLOB_RESPONSE_BYTES,
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
            .limit(MAX_JSON_RESPONSE_BYTES)
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
            500,
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
        let page = self.read_share_log(&req.share_id, req.cursor, req.limit, &[])?;
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
            MAX_BLOB_RESPONSE_BYTES,
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
    let Ok(uri) = base_url.parse::<Uri>() else {
        return false;
    };
    let Some(host) = uri.host() else {
        return false;
    };
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
        403 => RelayError::Forbidden,
        404 => unavailable(context),
        409 => RelayError::Conflict,
        413 => RelayError::PayloadTooLarge,
        500..=599 => RelayError::ServerInternal,
        other => RelayError::HttpStatus(other),
    }
}

fn map_server_code(code: &str, context: RequestContext) -> RelayError {
    match code {
        "bad_request" => RelayError::BadRequest,
        "conflict" => RelayError::Conflict,
        "epoch_superseded" => RelayError::EpochSuperseded,
        "identity_not_recognized" => RelayError::IdentityNotRecognized,
        "identity_required" => RelayError::IdentityRequired,
        "stream_identity_mismatch" => RelayError::StreamIdentityMismatch,
        "authorship_mismatch" => RelayError::AuthorshipMismatch,
        "unknown_chat_op" => RelayError::UnknownChatOperation,
        "share_read_only" => RelayError::ShareReadOnly,
        "share_op_rejected" => RelayError::ShareOperationRejected,
        "payload_too_large" => RelayError::PayloadTooLarge,
        "presence_capacity" => RelayError::PresenceCapacity,
        "quota_exceeded" => RelayError::QuotaExceeded,
        "blob_missing" => RelayError::BlobReferenceMissing,
        "blob_not_found" => RelayError::BlobMissing,
        "key_envelope_not_found" => RelayError::KeyEnvelopeMissing,
        "self_share" => RelayError::SelfShare,
        "ambiguous_selector" => RelayError::AmbiguousSelector,
        "invalid_channel" => RelayError::InvalidChannel,
        "method_not_allowed" => RelayError::MethodNotAllowed,
        "internal_error" => RelayError::ServerInternal,
        "not_found" => unavailable(context),
        unknown => RelayError::UnknownServerCode(unknown.to_owned()),
    }
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
    use super::*;

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
