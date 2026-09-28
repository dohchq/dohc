use crate::EngineService;
use crate::rpc::capture::MAX_DESKTOP_CAPTURE_TEXT_BYTES;
use crate::rpc::error::map_runtime;
use crate::rpc::history::moment_json;
use crate::rpc::reads::MAX_INBAND_CONTENT_BYTES;
use crate::rpc::reads::file_object_json;
use crate::rpc::reads::snapshot_json;
use crate::rpc::reads::snapshot_metadata_json;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::request::validate_metadata_fields;
use crate::rpc::request::validated_author;
use crate::rpc::request::validated_origin;
use crate::rpc::workspace::validate_workspace_param;
use base64::Engine as _;
use dohc_engine_domain::CompareTextFileVersions;
use dohc_engine_domain::ComparisonStatus;
use dohc_engine_domain::DeleteTextFile;
use dohc_engine_domain::MergeTextFileFromVersion;
use dohc_engine_domain::MergeTextFileResult;
use dohc_engine_domain::MergeUnchangedReason;
use dohc_engine_domain::MomentOp;
use dohc_engine_domain::RenameTextFile;
use dohc_engine_domain::RollbackTextFileMutation;
use dohc_engine_domain::WriteBinary;
use dohc_engine_domain::WriteText;
use dohc_engine_domain::validate_addressable_plaintext_path;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::Request;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::NoFaults;
use dohc_engine_runtime::PostCommitMaterializeOutcome;
use dohc_engine_runtime::RuntimeError;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextWriteParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    #[serde(default)]
    object_id: Option<String>,
    path: String,
    text: String,
    #[serde(default)]
    restore_before_moment_id: Option<String>,
    #[serde(default)]
    create_only: bool,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedBinaryWriteParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    #[serde(default)]
    object_id: Option<String>,
    path: String,
    #[serde(default)]
    bytes: Option<Vec<u8>>,
    #[serde(default)]
    bytes_base64: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedBinaryWriteBlobParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    #[serde(default)]
    object_id: Option<String>,
    path: String,
    sha256: String,
    #[serde(default)]
    bytes_base64: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    moment_id: Option<String>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextRenameParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    from_path: String,
    to_path: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextCheckMoveParams {
    version_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextDeleteParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    path: String,
    #[serde(default)]
    expected_object_id: Option<String>,
    /// Delete only if the path is still missing on disk when the engine
    /// applies the delete: the caller saw it missing, and a replace can empty
    /// the name for a moment.
    #[serde(default)]
    only_if_absent_on_disk: bool,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextRollbackParams {
    #[serde(default)]
    workspace_id: Option<String>,
    version_id: String,
    path: String,
    mutation_moment_id: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextCompareParams {
    #[serde(default)]
    workspace_id: Option<String>,
    path: String,
    source_version_id: String,
    target_version_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextMergeParams {
    #[serde(default)]
    workspace_id: Option<String>,
    path: String,
    source_version_id: String,
    target_version_id: String,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    correlation_id: Option<String>,
    #[serde(default)]
    author: Option<Value>,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    now_ms: Option<i64>,
}

/// One comparison side as a versioned read value. A binary side reports the
/// same shape `versionedText.read` gives a binary head: empty text, the binary
/// content address in both hash fields, and the blob's byte length.
fn comparison_side_json(side: &dohc_engine_domain::ComparisonSide) -> Value {
    if !side.binary {
        return snapshot_json(&side.snapshot);
    }
    json!({
        "workspaceId": side.snapshot.workspace_id,
        "versionId": side.snapshot.version_id,
        "objectId": side.snapshot.object_id,
        "path": side.snapshot.path,
        "text": "",
        "contentKind": "binary",
        "sha256": side.snapshot.blob_sha256,
        "byteLength": side.byte_length,
        "blobSha256": side.snapshot.blob_sha256,
        "updatedAtMs": side.snapshot.updated_at_ms,
        "latestMomentId": side.snapshot.latest_moment_id,
        "metadataOrigin": side.snapshot.metadata_origin,
        "metadataSummary": side.snapshot.metadata_summary,
        "metadataCorrelationId": side.snapshot.metadata_correlation_id
    })
}

fn comparison_json(comparison: &dohc_engine_domain::VersionedTextComparison) -> Value {
    json!({
        "workspaceId": comparison.workspace_id,
        "path": comparison.path,
        "targetVersionId": comparison.target_version_id,
        "sourceVersionId": comparison.source_version_id,
        "base": comparison.base.as_ref().map(comparison_side_json),
        "current": comparison.current.as_ref().map(comparison_side_json),
        "incoming": comparison.incoming.as_ref().map(comparison_side_json),
        "status": match comparison.status {
            ComparisonStatus::Same => "same",
            ComparisonStatus::IncomingChanged => "incoming-changed",
            ComparisonStatus::CurrentChanged => "current-changed",
            ComparisonStatus::Diverged => "diverged",
        },
    })
}

fn materialize_outcome_name(outcome: PostCommitMaterializeOutcome) -> &'static str {
    match outcome {
        PostCommitMaterializeOutcome::Applied => "applied",
        PostCommitMaterializeOutcome::Skipped => "skipped",
        PostCommitMaterializeOutcome::Conflict => "conflict",
        PostCommitMaterializeOutcome::Superseded => "superseded",
        PostCommitMaterializeOutcome::Error => "error",
    }
}

impl EngineService {
    pub(super) async fn versioned_text_write(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextWriteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = params.path.clone();
        let text = params.text;
        if text.len() > MAX_DESKTOP_CAPTURE_TEXT_BYTES {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "content-exceeds-inband-cap",
            ));
        }
        let origin = validated_origin(params.origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.write (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = params.object_id.unwrap_or_else(|| {
            self.generated_rpc_id("object", request.id, request_id.as_deref(), &path)
        });
        let moment_id = params.moment_id.unwrap_or_else(|| {
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path)
        });
        if params.create_only && params.restore_before_moment_id.is_some() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "create-only cannot restore history",
            ));
        }
        let input = WriteText {
            workspace_id: open.workspace_id.clone(),
            version_id: params.version_id,
            object_id,
            path,
            text,
            moment_id,
            request_id,
            metadata_origin: origin,
            metadata_summary: params.summary,
            metadata_correlation_id: params.correlation_id,
            author_json,
            now_ms: params.now_ms.unwrap_or(now_ms()?),
        };
        let result = if params.create_only {
            open.actor
                .versioned_text_create(
                    input,
                    open.root.clone(),
                    Arc::new(NoFaults),
                    cancellation.token(),
                )
                .await
        } else {
            open.actor
                .versioned_text_write_indexed_with_history(
                    input,
                    open.root.clone(),
                    params.restore_before_moment_id,
                    Arc::new(NoFaults),
                    cancellation.token(),
                )
                .await
        };
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
        crate::events::emit_automation_claimed(
            &self.events,
            &open.workspace_id,
            &result.automation_claims,
        );
        Ok(json!({
            "object": file_object_json(&result.object),
            "snapshot": snapshot_json(&result.snapshot),
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
        }))
    }

    pub(super) async fn versioned_binary_write(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedBinaryWriteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = params.path.clone();
        let bytes = match (params.bytes, params.bytes_base64) {
            (Some(bytes), None) => bytes,
            (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-input"))?,
            _ => return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input")),
        };
        if bytes.len() > MAX_INBAND_CONTENT_BYTES {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "content-exceeds-inband-cap",
            ));
        }
        let origin = validated_origin(params.origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedBinary.write (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = params.object_id.unwrap_or_else(|| {
            self.generated_rpc_id("object", request.id, request_id.as_deref(), &path)
        });
        let moment_id = params.moment_id.unwrap_or_else(|| {
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path)
        });
        let execution = open
            .actor
            .versioned_binary_write(
                WriteBinary {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    object_id,
                    path,
                    bytes,
                    moment_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let execution = execution.map_err(map_runtime)?;
        let result = execution.write;
        Ok(json!({
            "object": file_object_json(&result.object),
            "snapshot": {
                "objectId": result.object_id,
                "path": result.path,
                "contentKind": "binary",
                "text": "",
                "sha256": result.sha256,
                "byteLength": result.byte_length,
                "updatedAtMs": result.updated_at_ms,
                "latestMomentId": result.moment.moment_id,
            },
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
            "materializeEnqueued": result.materialize_enqueued,
            "materialized": execution.materialized,
            "materializeOutcome": materialize_outcome_name(execution.materialize_outcome),
        }))
    }

    pub(super) async fn versioned_binary_write_blob(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedBinaryWriteBlobParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        if params.sha256.len() != 64 || !params.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input"));
        }
        let sha256 = params.sha256.to_ascii_lowercase();
        let path = params.path.clone();
        let origin = validated_origin(params.origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let bytes = match params.bytes_base64 {
            Some(encoded) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-input"))?;
                if bytes.len() > dohc_engine_domain::MAX_CAPTURE_BINARY_FILE_BYTES {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "content-exceeds-capture-cap",
                    ));
                }
                let actual = dohc_engine_storage::hex_sha256(&bytes);
                if actual != sha256 {
                    return Err(WireError::new(ErrorCode::InvalidParams, "invalid-input"));
                }
                bytes
            }
            None => {
                let blob = Self::read_under_ctx(
                    &cancellation,
                    "versionedBinary.writeBlob",
                    open.actor
                        .read_binary_blob_for_egress(open.workspace_id.clone(), sha256),
                )
                .await?
                .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "file-not-found"))?;
                blob.bytes
                    .ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?
            }
        };
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedBinary.writeBlob (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = params.object_id.unwrap_or_else(|| {
            self.generated_rpc_id("object", request.id, request_id.as_deref(), &path)
        });
        let moment_id = params.moment_id.unwrap_or_else(|| {
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path)
        });
        let execution = open
            .actor
            .versioned_binary_write(
                WriteBinary {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    object_id,
                    path,
                    bytes,
                    moment_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let execution = execution.map_err(map_runtime)?;
        let result = execution.write;
        Ok(json!({
            "object": file_object_json(&result.object),
            "snapshot": {
                "objectId": result.object_id,
                "path": result.path,
                "contentKind": "binary",
                "text": "",
                "sha256": result.sha256,
                "byteLength": result.byte_length,
                "updatedAtMs": result.updated_at_ms,
                "latestMomentId": result.moment.moment_id,
            },
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
            "materializeEnqueued": result.materialize_enqueued,
            "materialized": execution.materialized,
            "materializeOutcome": materialize_outcome_name(execution.materialize_outcome),
        }))
    }

    pub(super) async fn versioned_text_check_move(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextCheckMoveParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "versionedText.checkMove",
            open.actor.ensure_no_adopted_owner_under_path(
                open.workspace_id.clone(),
                params.version_id,
                params.path,
            ),
        )
        .await?;
        Ok(json!({"allowed":true}))
    }

    pub(super) async fn versioned_text_rename(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextRenameParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let from_path = params.from_path.clone();
        let to_path = params.to_path.clone();
        let origin = validated_origin(params.origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.rename (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &from_path)
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &to_path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let moment_id =
            self.generated_rpc_id("moment", request.id, request_id.as_deref(), &to_path);
        let result = open
            .actor
            .versioned_text_rename(
                RenameTextFile {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    from_path,
                    to_path,
                    moment_id,
                    request_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
        Ok(json!({
            "object": file_object_json(&result.object),
            "before": snapshot_metadata_json(
                &result.before,
                &result.moment.before_content_kind,
                result.moment.before_binary_sha256.as_deref(),
                result.moment.before_byte_length,
            ),
            "after": snapshot_metadata_json(
                &result.after,
                &result.moment.after_content_kind,
                result.moment.after_binary_sha256.as_deref(),
                result.moment.after_byte_length,
            ),
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
        }))
    }

    pub(super) async fn versioned_text_delete(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextDeleteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = params.path.clone();
        let origin = validated_origin(params.origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.delete (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let moment_id = self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path);
        let result = open
            .actor
            .versioned_text_delete_expected_object(
                DeleteTextFile {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    path,
                    moment_id,
                    request_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                params.expected_object_id,
                params.only_if_absent_on_disk,
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
        Ok(json!({
            "object": file_object_json(&result.object),
            "before": snapshot_metadata_json(
                &result.before,
                &result.moment.before_content_kind,
                result.moment.before_binary_sha256.as_deref(),
                result.moment.before_byte_length,
            ),
            "moment": moment_json(&result.moment),
            "deduped": result.deduped,
        }))
    }

    pub(super) async fn versioned_text_rollback(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextRollbackParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = validate_addressable_plaintext_path(&params.path)
            .map_err(|error| map_runtime(RuntimeError::Domain(error)))?;
        let origin = validated_origin(params.origin.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versionedText.rollback (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.version_id, &path)
            .await?;
        let restore_path = open
            .actor
            .get_moment(open.workspace_id.clone(), params.mutation_moment_id.clone())
            .await
            .map_err(map_runtime)?
            .filter(|moment| {
                moment.version_id == params.version_id
                    && moment.path == path
                    && moment.operation == MomentOp::Rename
            });
        if let Some(before_moment_id) =
            restore_path.and_then(|moment| moment.before_latest_moment_id)
            && let Some(before) = open
                .actor
                .get_moment(open.workspace_id.clone(), before_moment_id)
                .await
                .map_err(map_runtime)?
            && before.path != path
        {
            self.ensure_path_not_leased(&open, &params.version_id, &before.path)
                .await?;
        }
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let result = open
            .actor
            .versioned_text_rollback(
                RollbackTextFileMutation {
                    workspace_id: open.workspace_id.clone(),
                    version_id: params.version_id,
                    path,
                    mutation_moment_id: params.mutation_moment_id,
                    request_id,
                    metadata_origin: origin,
                    author_json,
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let result = result.map_err(map_runtime)?;
        crate::events::emit_automation_claimed(
            &self.events,
            &open.workspace_id,
            &result.automation_claims,
        );
        Ok(json!({
            "rolledBack": true,
            "deduped": result.deduped,
            "materializeEnqueued": result.materialize_enqueued,
            "materialized": result.materialized,
            "materializeOutcome": materialize_outcome_name(result.materialize_outcome),
        }))
    }

    pub(super) async fn versioned_text_compare(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextCompareParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let comparison = Self::read_under_ctx(
            &cancellation,
            "versionedText.compare",
            open.actor.versioned_text_compare(CompareTextFileVersions {
                workspace_id: open.workspace_id.clone(),
                target_version_id: params.target_version_id,
                source_version_id: params.source_version_id,
                path: params.path.clone(),
            }),
        )
        .await?;
        Ok(comparison_json(&comparison))
    }

    pub(super) async fn versioned_text_merge(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextMergeParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        validate_workspace_param(params.workspace_id.as_deref(), &open.workspace_id)?;
        let path = params.path.clone();
        let origin = validated_origin(params.origin.as_deref())?;
        validate_metadata_fields(params.summary.as_deref(), params.correlation_id.as_deref())?;
        let author_json = validated_author(params.author.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(&open, &cancellation, "versions.merge (queued)")
            .await?;
        self.ensure_path_not_leased(&open, &params.target_version_id, &path)
            .await?;
        let request_id = params
            .request_id
            .or_else(|| request.idempotency_key.clone());
        let object_id = self.generated_rpc_id("object", request.id, request_id.as_deref(), &path);
        let moment_id = self.generated_rpc_id("moment", request.id, request_id.as_deref(), &path);
        let conflict_id =
            self.generated_rpc_id("conflict", request.id, request_id.as_deref(), &path);
        let result = open
            .actor
            .versioned_text_merge(
                MergeTextFileFromVersion {
                    workspace_id: open.workspace_id.clone(),
                    target_version_id: params.target_version_id,
                    source_version_id: params.source_version_id,
                    path,
                    object_id,
                    moment_id,
                    request_id,
                    conflict_id,
                    metadata_origin: origin,
                    metadata_summary: params.summary,
                    metadata_correlation_id: params.correlation_id,
                    author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                },
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await;
        drop(session_serial);
        let execution = result.map_err(map_runtime)?;
        let materialize_enqueued = execution.materialize_enqueued;
        let materialized = execution.materialized;
        let materialize_outcome = materialize_outcome_name(execution.materialize_outcome);
        Ok(match execution.merge {
            MergeTextFileResult::Unchanged {
                reason,
                comparison,
                deduped,
            } => json!({
                "status": "unchanged",
                "reason": match reason {
                    MergeUnchangedReason::AlreadySame => "already-same",
                    MergeUnchangedReason::SourceUnchanged => "source-unchanged",
                },
                "comparison": comparison_json(&comparison),
                "deduped": deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::Write { comparison, write } => json!({
                "status": "merged",
                "comparison": comparison_json(&comparison),
                "writeKind": "write",
                "object": file_object_json(&write.object),
                "snapshot": snapshot_metadata_json(&write.snapshot, "text", None, None),
                "moment": moment_json(&write.moment),
                "deduped": write.deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::BinaryWrite { comparison, write } => json!({
                "status": "merged",
                "comparison": comparison_json(&comparison),
                "writeKind": "binary-write",
                "object": file_object_json(&write.object),
                "snapshot": snapshot_metadata_json(
                    &write.head.snapshot,
                    "binary",
                    Some(&write.head.snapshot.blob_sha256),
                    Some(write.head.byte_length),
                ),
                "moment": moment_json(&write.moment),
                "deduped": write.deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::Delete { comparison, delete } => json!({
                "status": "merged",
                "comparison": comparison_json(&comparison),
                "writeKind": "delete",
                "object": file_object_json(&delete.object),
                "before": snapshot_metadata_json(&delete.before, "text", None, None),
                "moment": moment_json(&delete.moment),
                "deduped": delete.deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
            MergeTextFileResult::Conflict {
                comparison,
                conflict,
                deduped,
            } => json!({
                "status": "conflict",
                "conflictId": conflict.conflict_id,
                "comparison": comparison_json(&comparison),
                "deduped": deduped,
                "materializeEnqueued": materialize_enqueued,
                "materialized": materialized,
                "materializeOutcome": materialize_outcome,
            }),
        })
    }
}

#[cfg(test)]
mod tests {
    use crate::EngineService;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::Request;
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::json;

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn binary_write_records_suppression_in_the_root_scoped_registry() {
        let scratch = ScratchDir::new().expect("scratch");
        let service = EngineService::new();
        let workspace_id = "binary-root-scoped-suppression";
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");

        // Keep the assertion deterministic: no watcher remains to consume the
        // suppression identity between materialization and inspection.
        let open = service.open(Some(&handle)).expect("open workspace");
        let canonical_root = open.root.clone();
        open.shutdown_capture().await;

        let request = Request {
            id: 1,
            method: "versionedBinary.write".to_owned(),
            workspace: Some(handle.clone()),
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({
                "versionId": "main",
                "path": "scoped.bin",
                "bytes": [7, 8, 9],
                "origin": "api",
            }),
        };
        let result = service
            .versioned_binary_write(
                &RequestContext::unbounded(),
                &request,
                request.params.clone(),
            )
            .await
            .expect("binary write");
        let sha256 = result["snapshot"]["sha256"]
            .as_str()
            .expect("binary sha256");

        assert!(
            service.self_writes.scoped(&canonical_root).has_pending(
                workspace_id,
                "scoped.bin",
                sha256
            ),
            "binary materialization must register in the capture driver's root-scoped view"
        );
        assert!(
            !service
                .self_writes
                .has_pending(workspace_id, "scoped.bin", sha256),
            "the process-global unscoped namespace must remain empty"
        );

        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
    }
}
