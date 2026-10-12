use crate::EngineService;
use crate::rpc::capture::MAX_DESKTOP_CAPTURE_TEXT_BYTES;
use crate::rpc::error::map_runtime;
use crate::rpc::history::MOMENTS_PAGE_BYTE_BUDGET;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::parse;
use crate::rpc::workspace::validate_workspace_param;
use base64::Engine as _;
use dohc_engine_domain::DomainError;
use dohc_engine_domain::TextSnapshot;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::BlobEgress;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::RuntimeError;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

/// In-band content (binary bytes, secret plaintext) uses the capture contract's
/// smaller request cap. Larger binary blobs use the full-range write endpoint
/// or raw blob-chunk egress.
pub(super) const MAX_INBAND_CONTENT_BYTES: usize = dohc_engine_domain::INBAND_CONTENT_CAP_BYTES;

/// Aggregate hydrated blob bytes allowed to wait for or flow through framed
/// egress. A single stored blob may be this large, so exact-byte reservations
/// allow one maximum-sized response or multiple smaller responses up to the
/// same fixed resident-memory ceiling.
pub(crate) const BLOB_EGRESS_BYTE_BUDGET: usize = dohc_engine_storage::MAX_BLOB_BYTES;

/// How many bytes a string occupies once JSON-encoded, quotes included.
///
/// `check_string` bounds the DECODED length, so only the frame limit catches
/// escaping — and escaping is not a rounding error: every newline, quote and
/// backslash doubles, and every other control byte becomes six. A caller
/// measured against raw bytes would be told a body fits when the encoded
/// request cannot cross the wire at all.
pub(super) fn json_string_encoded_len(text: &str) -> usize {
    text.bytes().fold(2, |len, byte| {
        len + match byte {
            b'"' | b'\\' | 0x08 | 0x09 | 0x0a | 0x0c | 0x0d => 2,
            0x00..=0x1f => 6,
            _ => 1,
        }
    })
}

/// The encoded size of the response envelope that will carry this result —
/// what the control frame actually holds. The mirror of
/// `resolve_request_encoded_bytes`, and measured the same way: through the
/// encoder the transport itself uses, with the result slot filled by an empty
/// object and its two bytes taken back. Nothing is reserved and nothing is
/// estimated, so a result one byte inside the frame still crosses.
pub(super) fn response_encoded_bytes(id: u64, result: &Value) -> usize {
    let envelope =
        dohc_engine_protocol::wire::Envelope::Response(dohc_engine_protocol::wire::Response {
            id,
            result: json!({}),
        });
    let envelope_bytes = serde_json::to_vec(&envelope).map_or(usize::MAX, |bytes| bytes.len());
    let result_bytes = serde_json::to_vec(result).map_or(usize::MAX, |bytes| bytes.len());
    // `- 2` drops the empty object measured in the result slot.
    envelope_bytes
        .saturating_sub(2)
        .saturating_add(result_bytes)
}

/// How many leading serialized rows fit a byte budget (at least one always
/// ships — every string is wire-capped, so a single row fits). Measured on
/// the serialized JSON, not estimated from raw lengths: escaping can expand
/// a control-character-heavy string up to 6x, and an estimate that ignores
/// that can pass the budget while the encoded frame exceeds the limit.
pub(super) fn byte_budget_cut_serialized(rows: &[Value], budget: usize) -> usize {
    byte_budget_cut_serialized_with_row_cap(rows, budget, SINGLE_ROW_HARD_CAP_BYTES)
}

pub(super) fn byte_budget_cut_serialized_with_row_cap(
    rows: &[Value],
    budget: usize,
    single_row_hard_cap_bytes: usize,
) -> usize {
    let mut included = 0usize;
    let mut remaining = budget as i64;
    for row in rows {
        let size = serde_json::to_string(row).map_or(0, |s| s.len());
        // A first row may exceed the PAGE budget (progress guarantee) but
        // never the hard single-row bound — beyond that it cannot ship
        // in a frame at all, and the caller must surface the refusal
        // rather than emit an over-frame response.
        if included == 0 && size > single_row_hard_cap_bytes {
            break;
        }
        remaining -= size as i64;
        if included > 0 && remaining < 0 {
            break;
        }
        included += 1;
    }
    included
}

#[derive(Clone)]
pub(crate) struct BlobEgressBudget {
    permits: Arc<tokio::sync::Semaphore>,
}

impl BlobEgressBudget {
    pub(crate) fn new(byte_budget: usize) -> Self {
        BlobEgressBudget {
            permits: Arc::new(tokio::sync::Semaphore::new(byte_budget)),
        }
    }

    pub(super) async fn reserve(
        &self,
        byte_length: i64,
        cancellation: &OperationCancellation,
        operation: &str,
    ) -> Result<tokio::sync::OwnedSemaphorePermit, WireError> {
        let bytes = usize::try_from(byte_length)
            .ok()
            .filter(|bytes| *bytes <= BLOB_EGRESS_BYTE_BUDGET)
            .and_then(|bytes| u32::try_from(bytes).ok())
            .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption(&format!("{operation} (egress budget)")))
            }
            permit = Arc::clone(&self.permits).acquire_many_owned(bytes) => {
                permit.map_err(|_| WireError::new(ErrorCode::Internal, "blob egress budget unavailable"))
            }
        }
    }
}

/// The most one serialized row may occupy: safely under the 1 MiB frame
/// limit with envelope headroom.
pub(super) const SINGLE_ROW_HARD_CAP_BYTES: usize = 700 * 1024;

/// What one whole RESPONSE is bounded by: the control frame that has to carry
/// it. A per-row or per-body cap cannot stand in for this — a response serves
/// more than its largest part (`conflicts.list` appends the continuation after
/// its rows; `conflicts.resolve` answers a conflict, a write and a delete),
/// and the daemon's writer treats an over-frame answer as fatal rather than
/// answering it.
// Authored blob requests need a larger transport frame; response pagination
// and blob egress retain their existing in-band budget.
pub(super) const RESPONSE_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextReadParams {
    version_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextListParams {
    version_id: String,
    #[serde(default)]
    after_path: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceCaptureParams {
    version_id: String,
    paths: Vec<String>,
    bounds: dohc_engine_domain::store::SourceCaptureBounds,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct VersionPathParams {
    pub(super) version_id: String,
    pub(super) path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedBinaryReadBlobParams {
    workspace_id: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextReadBlobParams {
    workspace_id: String,
    sha256: String,
}

/// How a snapshot projection carries its text body.
#[derive(Clone, Copy)]
pub(super) enum TextBody {
    /// The whole body, whatever its size.
    Full,
    /// The body up to the in-band cap, withheld past it.
    Capped,
    /// Withheld, whatever its size.
    Withheld,
}

/// One head as a versioned read value. A withheld text body goes out as a null
/// `text` beside `inbandLimitBytes`; `byteLength` and the digests stay, so the
/// caller can size the hydration and ask `versionedText.readBlob` for it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotWire<'a> {
    workspace_id: &'a str,
    version_id: &'a str,
    object_id: &'a str,
    path: &'a str,
    content_kind: &'a str,
    text: Option<&'a str>,
    byte_length: i64,
    blob_sha256: &'a str,
    sha256: &'a str,
    updated_at_ms: i64,
    latest_moment_id: &'a str,
    metadata_origin: &'a str,
    metadata_summary: Option<&'a str>,
    metadata_correlation_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inband_limit_bytes: Option<usize>,
}

pub(super) fn snapshot_json(snapshot: &TextSnapshot, body: TextBody) -> Value {
    let withheld = match body {
        TextBody::Full => false,
        TextBody::Capped => snapshot.text.len() > MAX_DESKTOP_CAPTURE_TEXT_BYTES,
        TextBody::Withheld => true,
    };
    json!(SnapshotWire {
        workspace_id: &snapshot.workspace_id,
        version_id: &snapshot.version_id,
        object_id: &snapshot.object_id,
        path: &snapshot.path,
        content_kind: "text",
        text: (!withheld).then_some(snapshot.text.as_str()),
        byte_length: snapshot.text.len() as i64,
        blob_sha256: &snapshot.blob_sha256,
        sha256: &snapshot.blob_sha256,
        updated_at_ms: snapshot.updated_at_ms,
        latest_moment_id: &snapshot.latest_moment_id,
        metadata_origin: &snapshot.metadata_origin,
        metadata_summary: snapshot.metadata_summary.as_deref(),
        metadata_correlation_id: snapshot.metadata_correlation_id.as_deref(),
        inband_limit_bytes: withheld.then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES),
    })
}

pub(super) fn file_object_json(object: &dohc_engine_domain::FileObjectRecord) -> Value {
    json!({
        "id": object.object_id,
        "workspaceId": object.workspace_id,
        "createdAtMs": object.created_at_ms,
    })
}

pub(super) fn snapshot_metadata_json(
    snapshot: &TextSnapshot,
    content_kind: &str,
    binary_sha256: Option<&str>,
    binary_byte_length: Option<i64>,
) -> Value {
    let (sha256, byte_length) = if content_kind == "binary" {
        (
            binary_sha256.unwrap_or(&snapshot.blob_sha256),
            binary_byte_length.unwrap_or_default().max(0) as usize,
        )
    } else {
        (snapshot.blob_sha256.as_str(), snapshot.text.len())
    };
    json!({
        "workspaceId": snapshot.workspace_id,
        "versionId": snapshot.version_id,
        "objectId": snapshot.object_id,
        "path": snapshot.path,
        "contentKind": content_kind,
        "sha256": sha256,
        "byteLength": byte_length,
        "updatedAtMs": snapshot.updated_at_ms,
        "latestMomentId": snapshot.latest_moment_id,
        "metadataOrigin": snapshot.metadata_origin,
        "metadataSummary": snapshot.metadata_summary,
        "metadataCorrelationId": snapshot.metadata_correlation_id,
    })
}

impl EngineService {
    pub(super) async fn versioned_text_capture_sources(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SourceCaptureParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        if !open.is_local_owner() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "source capture requires the local owning workspace handle",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        let capture = Self::read_under_ctx(
            &cancellation,
            "versionedText.captureSources",
            open.actor.capture_sources(
                open.workspace_id.clone(),
                params.version_id,
                params.paths,
                params.bounds,
            ),
        )
        .await?;
        let value = serde_json::to_value(capture)
            .map_err(|_| WireError::new(ErrorCode::Internal, "source capture encoding failed"))?;
        if serde_json::to_vec(&value)
            .map_err(|_| WireError::new(ErrorCode::Internal, "source capture encoding failed"))?
            .len()
            > SINGLE_ROW_HARD_CAP_BYTES
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "source capture metadata exceeds response budget",
            ));
        }
        Ok(value)
    }

    pub(super) async fn versioned_text_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextReadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // One actor turn decides the in-band cap: an over-cap body never
        // leaves SQLite, and no concurrent write can grow the body between
        // a size probe and the load (there is no probe).
        let snapshot = Self::read_under_ctx(
            &cancellation,
            "versionedText.read",
            open.actor.read_text_inband(
                open.workspace_id.clone(),
                params.version_id,
                params.path,
                MAX_DESKTOP_CAPTURE_TEXT_BYTES,
            ),
        )
        .await?;
        Ok(match snapshot {
            None => Value::Null,
            Some(snapshot) => {
                let over_cap = snapshot.content_kind == "text" && snapshot.text.is_none();
                json!(SnapshotWire {
                    workspace_id: &snapshot.workspace_id,
                    version_id: &snapshot.version_id,
                    object_id: &snapshot.object_id,
                    path: &snapshot.path,
                    content_kind: &snapshot.content_kind,
                    text: snapshot.text.as_deref(),
                    byte_length: snapshot.byte_length,
                    blob_sha256: &snapshot.blob_sha256,
                    sha256: &snapshot.blob_sha256,
                    updated_at_ms: snapshot.updated_at_ms,
                    latest_moment_id: &snapshot.latest_moment_id,
                    metadata_origin: &snapshot.metadata_origin,
                    metadata_summary: snapshot.metadata_summary.as_deref(),
                    metadata_correlation_id: snapshot.metadata_correlation_id.as_deref(),
                    inband_limit_bytes: over_cap.then_some(MAX_DESKTOP_CAPTURE_TEXT_BYTES),
                })
            }
        })
    }

    pub(super) async fn versioned_text_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // METADATA ONLY, paged: bodies come one path at a time via
        // versionedText.read (aggregated bodies trivially exceed the 1 MiB
        // frame limit), and even metadata rows are paged so a large
        // workspace cannot exceed it either. The +1 row probes for more.
        let limit = params.limit.unwrap_or(200).clamp(1, 500);
        let mut rows = Self::read_under_ctx(
            &cancellation,
            "versionedText.list",
            open.actor.list_snapshot_metadata(
                open.workspace_id.clone(),
                params.version_id.clone(),
                params.after_path.clone(),
                limit + 1,
            ),
        )
        .await?;
        // An unknown version must refuse, never read as empty — on every
        // page: a stale cursor plus a typo'd version would otherwise read
        // as "exhausted". A legitimately-empty tail page for a real
        // version pays one extra membership read; correctness wins.
        if rows.is_empty() {
            let versions = Self::read_under_ctx(
                &cancellation,
                "versionedText.list",
                open.actor.list_versions(open.workspace_id.clone()),
            )
            .await?;
            if !versions
                .iter()
                .any(|version| version.version_id == params.version_id)
            {
                // The domain code, like every other refusal (`map_runtime`).
                // Spelling this one as prose gave the same refusal two wire
                // messages depending on which method the caller reached it
                // through, and a client that keys on the code saw neither.
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "version-not-found",
                ));
            }
        }
        let has_more = rows.len() > limit;
        rows.truncate(limit);
        // Metadata rows can still be string-heavy (paths/origins are
        // wire-legal up to 64 KiB): the byte budget cuts the page under
        // the frame limit; the cursor resumes at the cut.
        let row_values: Vec<Value> = rows
            .iter()
            .map(|row| {
                json!({
                    "path": row.path,
                    "objectId": row.object_id,
                    "contentKind": row.content_kind,
                    "sha256": row.sha256,
                    "byteLength": row.byte_length,
                    "binarySha256": row.binary_sha256,
                    "updatedAtMs": row.updated_at_ms,
                    "latestMomentId": row.latest_moment_id,
                    "metadataOrigin": row.metadata_origin,
                    "metadataSummary": row.metadata_summary,
                    "metadataCorrelationId": row.metadata_correlation_id,
                    "hasYdocMarker": row.has_ydoc_marker,
                })
            })
            .collect();
        let byte_cut = byte_budget_cut_serialized(&row_values, MOMENTS_PAGE_BYTE_BUDGET);
        if byte_cut == 0 && !row_values.is_empty() {
            return Err(WireError::new(
                ErrorCode::Internal,
                "a listing row exceeds the response frame budget",
            ));
        }
        let byte_truncated = byte_cut < rows.len();
        let next_after_path = (has_more || byte_truncated)
            .then(|| rows[..byte_cut].last().map(|row| row.path.clone()))
            .flatten();
        Ok(json!({
            "files": row_values[..byte_cut].to_vec(),
            "nextAfterPath": next_after_path,
        }))
    }

    pub(super) async fn versioned_binary_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionPathParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        // One actor turn: the cap is decided in the query, so a replaced
        // head can never smuggle an over-cap blob into memory, and the
        // recorded length is integrity-checked against the stored bytes.
        let head = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("versionedBinary.read"));
            }
            result = open.actor.read_binary_inband(
                open.workspace_id.clone(),
                params.version_id,
                params.path,
                MAX_INBAND_CONTENT_BYTES,
            ) => match result {
                Ok(head) => head,
                Err(RuntimeError::Domain(DomainError::TextHeadNotBinary)) => return Ok(Value::Null),
                Err(error) => return Err(map_runtime(error)),
            },
        };
        Ok(match head {
            None => Value::Null,
            Some(head) => match head.bytes {
                Some(bytes) => json!({
                    "objectId": head.object_id,
                    "sha256": head.sha256,
                    "byteLength": head.byte_length,
                    "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
                }),
                None => json!({
                    "objectId": head.object_id,
                    "sha256": head.sha256,
                    "byteLength": head.byte_length,
                    "bytesBase64": Value::Null,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
            },
        })
    }

    pub(super) async fn versioned_binary_read_blob(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: VersionedBinaryReadBlobParams = parse(params)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input"));
        }
        // Stored digests are canonical lowercase hex; an uppercase spelling of
        // a referenced digest must find it, not miss the exact-match lookup.
        let sha256 = params.sha256.to_ascii_lowercase();
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let read = Self::read_under_ctx(
            &cancellation,
            "versionedBinary.readBlob",
            open.actor
                .read_binary_blob(open.workspace_id.clone(), sha256.clone()),
        )
        .await?
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "file-not-found"))?;
        let Some(bytes) = read.bytes else {
            if !ctx.has_capability("blobs") {
                return Ok((
                    json!({
                        "bytesBase64": Value::Null,
                        "byteLength": read.byte_length,
                        "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                    }),
                    None,
                ));
            }
            let byte_permit = self
                .blob_egress_budget
                .reserve(read.byte_length, &cancellation, "versionedBinary.readBlob")
                .await?;
            let hydrated = Self::read_under_ctx(
                &cancellation,
                "versionedBinary.readBlob",
                open.actor
                    .read_binary_blob_for_egress(open.workspace_id.clone(), sha256.clone()),
            )
            .await?
            .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            if hydrated.byte_length != read.byte_length {
                return Err(WireError::new(ErrorCode::Internal, "state-corrupt"));
            }
            let bytes = hydrated
                .bytes
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            return Ok((
                json!({
                    "bytesBase64": Value::Null,
                    "byteLength": read.byte_length,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
                Some(BlobEgress {
                    stream_id: request_id,
                    sha256,
                    bytes,
                    cancel: ctx.cancel.clone(),
                    deadline: ctx.deadline,
                    byte_permit: Some(byte_permit),
                }),
            ));
        };
        Ok((
            json!({
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }),
            None,
        ))
    }

    pub(super) async fn versioned_text_read_blob(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: VersionedTextReadBlobParams = parse(params)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input"));
        }
        let sha256 = params.sha256.to_ascii_lowercase();
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let read = Self::read_under_ctx(
            &cancellation,
            "versionedText.readBlob",
            open.actor
                .read_text_blob(open.workspace_id.clone(), sha256.clone()),
        )
        .await?
        .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "file-not-found"))?;
        let Some(text) = read.text else {
            if !ctx.has_capability("blobs") {
                return Ok((
                    json!({
                        "bytesBase64": Value::Null,
                        "byteLength": read.byte_length,
                        "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                    }),
                    None,
                ));
            }
            let byte_permit = self
                .blob_egress_budget
                .reserve(read.byte_length, &cancellation, "versionedText.readBlob")
                .await?;
            let hydrated = Self::read_under_ctx(
                &cancellation,
                "versionedText.readBlob",
                open.actor
                    .read_text_blob_for_egress(open.workspace_id.clone(), sha256.clone()),
            )
            .await?
            .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            if hydrated.byte_length != read.byte_length {
                return Err(WireError::new(ErrorCode::Internal, "state-corrupt"));
            }
            let bytes = hydrated
                .text
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?
                .into_bytes();
            if bytes.len() as i64 != read.byte_length
                || dohc_engine_storage::hex_sha256(&bytes) != sha256
            {
                return Err(WireError::new(ErrorCode::Internal, "state-corrupt"));
            }
            return Ok((
                json!({
                    "bytesBase64": Value::Null,
                    "byteLength": read.byte_length,
                    "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
                }),
                Some(BlobEgress {
                    stream_id: request_id,
                    sha256,
                    bytes,
                    cancel: ctx.cancel.clone(),
                    deadline: ctx.deadline,
                    byte_permit: Some(byte_permit),
                }),
            ));
        };
        let bytes = text.into_bytes();
        if bytes.len() as i64 != read.byte_length
            || dohc_engine_storage::hex_sha256(&bytes) != sha256
        {
            return Err(WireError::new(ErrorCode::Internal, "state-corrupt"));
        }
        Ok((
            json!({
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            }),
            None,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::request::OperationCancellation;
    use dohc_engine_protocol::transport::RequestContext;
    use std::time::Duration;

    fn snapshot(text: &str) -> TextSnapshot {
        TextSnapshot {
            workspace_id: "ws".to_owned(),
            version_id: "main".to_owned(),
            object_id: "object".to_owned(),
            path: "notes/a.md".to_owned(),
            text: text.to_owned(),
            blob_sha256: "digest".to_owned(),
            updated_at_ms: 7,
            latest_moment_id: "moment".to_owned(),
            metadata_origin: "api".to_owned(),
            metadata_summary: Some("summary".to_owned()),
            metadata_correlation_id: None,
        }
    }

    #[test]
    fn a_snapshot_names_the_in_band_limit_only_beside_a_withheld_body() {
        let carried = json!({
            "workspaceId": "ws",
            "versionId": "main",
            "objectId": "object",
            "path": "notes/a.md",
            "contentKind": "text",
            "text": "body",
            "byteLength": 4,
            "blobSha256": "digest",
            "sha256": "digest",
            "updatedAtMs": 7,
            "latestMomentId": "moment",
            "metadataOrigin": "api",
            "metadataSummary": "summary",
            "metadataCorrelationId": null,
        });
        let mut withheld = carried.clone();
        withheld["text"] = Value::Null;
        withheld["inbandLimitBytes"] = json!(128 * 1024);
        for (body, expected) in [
            (TextBody::Full, &carried),
            (TextBody::Capped, &carried),
            (TextBody::Withheld, &withheld),
        ] {
            assert_eq!(&snapshot_json(&snapshot("body"), body), expected);
        }
        // An empty body is still a body: forced withholding names the limit.
        let empty = snapshot_json(&snapshot(""), TextBody::Withheld);
        assert_eq!(
            (
                &empty["text"],
                &empty["inbandLimitBytes"],
                &empty["byteLength"]
            ),
            (&Value::Null, &json!(128 * 1024), &json!(0))
        );
    }

    #[test]
    fn a_capped_snapshot_withholds_only_past_the_in_band_cap() {
        let at_cap = "a".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES);
        let past_cap = "a".repeat(MAX_DESKTOP_CAPTURE_TEXT_BYTES + 1);
        let carried = snapshot_json(&snapshot(&at_cap), TextBody::Capped);
        assert_eq!(carried["text"], json!(at_cap));
        assert_eq!(carried.get("inbandLimitBytes"), None);
        let withheld = snapshot_json(&snapshot(&past_cap), TextBody::Capped);
        assert_eq!(withheld["text"], Value::Null);
        assert_eq!(withheld["inbandLimitBytes"], json!(128 * 1024));
        assert_eq!(withheld["byteLength"], json!(past_cap.len()));
        let full = snapshot_json(&snapshot(&past_cap), TextBody::Full);
        assert_eq!(full["text"], json!(past_cap));
        assert_eq!(full.get("inbandLimitBytes"), None);
    }

    #[test]
    fn snapshot_metadata_carries_no_body_and_falls_back_for_a_binary_head() {
        let head = snapshot("body");
        let expected = |content_kind: &str, sha256: &str, byte_length: i64| {
            json!({
                "workspaceId": "ws",
                "versionId": "main",
                "objectId": "object",
                "path": "notes/a.md",
                "contentKind": content_kind,
                "sha256": sha256,
                "byteLength": byte_length,
                "updatedAtMs": 7,
                "latestMomentId": "moment",
                "metadataOrigin": "api",
                "metadataSummary": "summary",
                "metadataCorrelationId": null,
            })
        };
        assert_eq!(
            snapshot_metadata_json(&head, "text", Some("ignored"), Some(99)),
            expected("text", "digest", 4)
        );
        assert_eq!(
            snapshot_metadata_json(&head, "binary", Some("binary-digest"), Some(99)),
            expected("binary", "binary-digest", 99)
        );
        for missing_or_negative in [None, Some(-1)] {
            assert_eq!(
                snapshot_metadata_json(&head, "binary", None, missing_or_negative),
                expected("binary", "digest", 0)
            );
        }
    }

    #[tokio::test]
    async fn blob_egress_budget_blocks_when_aggregate_bytes_are_exhausted() {
        let budget = BlobEgressBudget::new(8);
        let first_ctx = RequestContext::unbounded();
        let first_cancellation = OperationCancellation::new(&first_ctx);
        let first = budget
            .reserve(5, &first_cancellation, "test.first")
            .await
            .expect("reserve first five bytes");
        assert_eq!(
            budget.permits.available_permits(),
            3,
            "remove the exact-byte reservation before blob hydration -> the second over-budget egress proceeds while the first is retained."
        );

        let waiting_budget = budget.clone();
        let mut waiting = tokio::spawn(async move {
            let ctx = RequestContext::unbounded();
            let cancellation = OperationCancellation::new(&ctx);
            waiting_budget
                .reserve(5, &cancellation, "test.waiting")
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut waiting)
                .await
                .is_err(),
            "an aggregate reservation beyond the byte budget must wait"
        );

        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("second reservation unblocked")
            .expect("reservation task")
            .expect("reserve second five bytes");
        assert_eq!(budget.permits.available_permits(), 3);
        drop(second);
        assert_eq!(budget.permits.available_permits(), 8);
    }
}
