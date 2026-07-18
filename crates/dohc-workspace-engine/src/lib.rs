//! Shadow-only composition host for the Rust workspace engine.

#![forbid(unsafe_code)]

pub mod cutover_rehearse;
pub mod shadow_fence;

use base64::Engine as _;
use dohc_engine_collab::{CollabError, ContentKind, DocKey};
use dohc_engine_domain::{
    ConflictChoice, ConflictContentKind, ConflictFileState, ConflictMetadata, ConflictResolution,
    ConflictStatus, DomainError, ResolveConflictKind, ResolveTextConflict, TextConflict,
    TextSnapshot, WriteText,
};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::{EngineService as ProtocolEngineService, RequestContext},
    wire::{Request, Response, WorkspaceHandle},
};
use dohc_engine_runtime::{
    ActorHandle, ApplyOutcome, CancellationToken, ConflictApplyResult, NoFaults, RuntimeError,
    SearchError, SearchSurface, WorkspaceSupervisor,
};
use dohc_engine_sync::{ReplicationEnvelope, SyncError};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_OPEN_HANDLES: usize = 64;

#[derive(Clone)]
struct OpenWorkspace {
    root: PathBuf,
    db_path: PathBuf,
    workspace_id: String,
    actor: ActorHandle,
}

/// Protocol service composing domain operations on the runtime actor's sole
/// writable `EngineStore` connection.
pub struct EngineService {
    supervisor: &'static WorkspaceSupervisor,
    handles: Mutex<HashMap<WorkspaceHandle, OpenWorkspace>>,
    open_lock: tokio::sync::Mutex<()>,
    next_handle: std::sync::atomic::AtomicU64,
}

impl Default for EngineService {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineService {
    pub fn new() -> Self {
        EngineService {
            supervisor: WorkspaceSupervisor::global(),
            handles: Mutex::new(HashMap::new()),
            open_lock: tokio::sync::Mutex::new(()),
            next_handle: std::sync::atomic::AtomicU64::new(1),
        }
    }

    async fn dispatch(&self, ctx: RequestContext, request: Request) -> Result<Response, WireError> {
        let id = request.id;
        let result = match request.method.as_str() {
            "workspace.open" => self.workspace_open(&ctx, request.params).await?,
            "workspace.close" => self.workspace_close(request.workspace).await?,
            "versionedText.write" => {
                self.versioned_text_write(&ctx, &request, request.params.clone())
                    .await?
            }
            "versionedText.read" => {
                self.versioned_text_read(&ctx, request.workspace, request.params)
                    .await?
            }
            "ydoc.apply" => {
                self.ydoc_apply(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.list" => {
                self.conflicts_list(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.open" => {
                self.conflicts_open(&ctx, request.workspace, request.params)
                    .await?
            }
            "conflicts.resolve" => {
                self.conflicts_resolve(
                    &ctx,
                    request.workspace,
                    request.params,
                    request.idempotency_key,
                )
                .await?
            }
            "search.query" => {
                self.search_query(&ctx, request.workspace, request.params)
                    .await?
            }
            _ => return Err(wire(ErrorCode::MethodNotFound, "unknown method")),
        };
        Ok(Response { id, result })
    }

    async fn workspace_open(
        &self,
        ctx: &RequestContext,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: WorkspaceOpenParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(wire(ErrorCode::Cancelled, "workspace open cancelled while queued"));
            }
            serial = self.open_lock.lock() => serial,
        };
        let validated =
            shadow_fence::validate_shadow_root(PathBuf::from(&params.root_dir).as_path())
                .map_err(map_shadow_fence)?;
        let root = validated.root;
        if let Some((handle, open)) = lock(&self.handles)
            .iter()
            .find(|(_, open)| open.root == root)
        {
            if open.workspace_id == params.workspace_id {
                return Ok(json!({ "workspace": handle }));
            }
            return Err(wire(
                ErrorCode::InvalidParams,
                "workspace root is already bound to another workspace",
            ));
        }
        if lock(&self.handles).len() >= MAX_OPEN_HANDLES {
            return Err(wire(
                ErrorCode::Overloaded,
                "workspace handle limit reached",
            ));
        }
        let db_path = root.join(".dohc").join("engine").join("engine.db");
        let supervisor = self.supervisor;
        let actor_path = db_path.clone();
        let now_ms = now_ms()?;
        let actor = tokio::task::spawn_blocking(move || supervisor.open(&actor_path, now_ms))
            .await
            .map_err(|_| wire(ErrorCode::Internal, "workspace open task failed"))?
            .map_err(map_runtime)?;
        let binding = actor.bind_shadow_clone(validated.token).await;
        let binding_error = match binding {
            Ok(true) => None,
            Ok(false) => Some(map_shadow_fence(
                shadow_fence::ShadowFenceError::DatabaseTokenMismatch,
            )),
            Err(error) => Some(map_runtime(error)),
        };
        if let Some(error) = binding_error {
            let supervisor = self.supervisor;
            let rejected_path = db_path.clone();
            let _ = tokio::task::spawn_blocking(move || supervisor.close(&rejected_path)).await;
            return Err(error);
        }
        let sequence = self
            .next_handle
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let handle = WorkspaceHandle(format!("ws-{sequence:016x}"));
        lock(&self.handles).insert(
            handle.clone(),
            OpenWorkspace {
                root,
                db_path,
                workspace_id: params.workspace_id,
                actor,
            },
        );
        Ok(json!({ "workspace": handle }))
    }

    async fn workspace_close(&self, handle: Option<WorkspaceHandle>) -> Result<Value, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = lock(&self.handles)
            .remove(&handle)
            .ok_or_else(workspace_unavailable)?;
        let supervisor = self.supervisor;
        let db_path = open.db_path;
        let closed = tokio::task::spawn_blocking(move || supervisor.close(&db_path))
            .await
            .map_err(|_| wire(ErrorCode::Internal, "workspace close task failed"))?
            .map_err(map_runtime)?;
        Ok(json!({ "closed": closed }))
    }

    async fn versioned_text_write(
        &self,
        ctx: &RequestContext,
        request: &Request,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextWriteParams = parse(params)?;
        let open = self.open(request.workspace.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let result = open
            .actor
            .versioned_text_write(
                WriteText {
                    workspace_id: open.workspace_id,
                    version_id: params.version_id,
                    object_id: params.object_id,
                    path: params.path,
                    text: params.text,
                    moment_id: params.moment_id,
                    metadata_origin: params.metadata_origin,
                    author_json: params.author_json,
                    now_ms: params.now_ms.unwrap_or(now_ms()?),
                    request_id: request.idempotency_key.clone(),
                },
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "snapshot": snapshot_json(&result.snapshot), "deduped": result.deduped }))
    }

    async fn versioned_text_read(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: VersionedTextReadParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let snapshot = open
            .actor
            .versioned_text_read(
                open.workspace_id,
                params.version_id,
                params.path,
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(match snapshot {
            Some(snapshot) => snapshot_json(&snapshot),
            None => Value::Null,
        })
    }

    async fn ydoc_apply(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocApplyParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let update = base64::engine::general_purpose::STANDARD
            .decode(params.update_base64)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid update encoding"))?;
        let key = DocKey::new(open.workspace_id, params.version_id, params.object_id)
            .map_err(|_| wire(ErrorCode::InvalidParams, "invalid document coordinates"))?;
        let cancellation = OperationCancellation::new(ctx);
        let content_kind = match params.content_kind.as_str() {
            "plaintext" => ContentKind::Plaintext,
            "richdoc" => ContentKind::Richdoc,
            _ => return Err(wire(ErrorCode::InvalidParams, "unknown Y.Doc content kind")),
        };
        let outcome = open
            .actor
            .ydoc_apply(
                key,
                content_kind,
                update,
                params.now_ms.unwrap_or(now_ms()?),
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({
            "seq": outcome.seq,
            "deduped": outcome.deduped,
            "emitOutbound": outcome.emit_outbound
        }))
    }

    async fn conflicts_list(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ConflictListParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let conflicts = open
            .actor
            .conflict_list(open.workspace_id, params.status, cancellation.token())
            .await
            .map_err(map_runtime)?;
        Ok(Value::Array(conflicts.iter().map(conflict_json).collect()))
    }

    async fn conflicts_open(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ConflictOpenParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        if let Some(envelope) = params.envelope {
            enforce_workspace(&open, &envelope.workspace_id)?;
            let result = open
                .actor
                .conflict_apply_replicated(envelope, Arc::new(NoFaults), cancellation.token())
                .await
                .map_err(map_runtime)?;
            return Ok(replicated_conflict_json(result));
        }
        let conflict = params
            .conflict
            .ok_or_else(|| wire(ErrorCode::InvalidParams, "missing conflict or envelope"))?
            .into_domain()?;
        enforce_workspace(&open, &conflict.workspace_id)?;
        let inserted = open
            .actor
            .conflict_open(conflict, Arc::new(NoFaults), cancellation.token())
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "inserted": inserted }))
    }

    async fn conflicts_resolve(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: Option<String>,
    ) -> Result<Value, WireError> {
        let params: ConflictResolveParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        if let Some(envelope) = params.envelope {
            enforce_workspace(&open, &envelope.workspace_id)?;
            let result = open
                .actor
                .conflict_apply_replicated(envelope, Arc::new(NoFaults), cancellation.token())
                .await
                .map_err(map_runtime)?;
            return Ok(replicated_conflict_json(result));
        }
        let local = params.local.ok_or_else(|| {
            wire(
                ErrorCode::InvalidParams,
                "missing local resolve or envelope",
            )
        })?;
        let resolution = match local.resolution.as_str() {
            "keep-current" => ResolveConflictKind::KeepCurrent,
            "apply-incoming" => ResolveConflictKind::ApplyIncoming,
            "apply-merged" => ResolveConflictKind::ApplyMerged {
                text: local
                    .merged_text
                    .ok_or_else(|| wire(ErrorCode::InvalidParams, "missing merged text"))?,
            },
            _ => {
                return Err(wire(
                    ErrorCode::InvalidParams,
                    "unknown conflict resolution",
                ));
            }
        };
        let result = open
            .actor
            .conflict_resolve(
                ResolveTextConflict {
                    workspace_id: open.workspace_id,
                    conflict_id: local.conflict_id,
                    resolution,
                    object_id: local.object_id,
                    write_moment_id: local.write_moment_id,
                    delete_moment_id: local.delete_moment_id,
                    metadata_origin: local.metadata_origin,
                    author_json: local.author_json,
                    now_ms: local.now_ms.unwrap_or(now_ms()?),
                    request_id,
                },
                Arc::new(NoFaults),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({ "conflict": conflict_json(&result.conflict) }))
    }

    async fn search_query(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SearchParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let results = open
            .actor
            .search(
                open.root,
                open.workspace_id,
                params.version_id,
                params.query,
                params.limit,
                params.now_ms.unwrap_or(now_ms()?),
                cancellation.token(),
            )
            .await
            .map_err(map_runtime)?;
        Ok(Value::Array(
            results
                .into_iter()
                .map(|result| {
                    json!({
                        "surface": match result.surface { SearchSurface::File => "file", SearchSurface::Chat => "chat" },
                        "path": result.path,
                        "title": result.title,
                        "line": result.line,
                        "preview": result.preview,
                        "matchStart": result.match_start,
                        "matchEnd": result.match_end,
                        "threadId": result.thread_id,
                        "objectId": result.object_id
                    })
                })
                .collect(),
        ))
    }

    fn open(&self, handle: Option<&WorkspaceHandle>) -> Result<OpenWorkspace, WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        lock(&self.handles)
            .get(handle)
            .cloned()
            .ok_or_else(workspace_unavailable)
    }
}

impl ProtocolEngineService for EngineService {
    async fn call(&self, ctx: RequestContext, request: Request) -> Result<Response, WireError> {
        self.dispatch(ctx, request).await
    }
}

struct OperationCancellation {
    token: CancellationToken,
    bridge: tokio::task::JoinHandle<()>,
}

impl OperationCancellation {
    fn new(ctx: &RequestContext) -> Self {
        let token = CancellationToken::new();
        if ctx.cancel.is_cancelled() {
            token.cancel();
        }
        let signal = ctx.cancel.clone();
        let child = token.clone();
        let bridge = tokio::spawn(async move {
            signal.cancelled().await;
            child.cancel();
        });
        OperationCancellation { token, bridge }
    }

    fn token(&self) -> CancellationToken {
        self.token.clone()
    }
}

impl Drop for OperationCancellation {
    fn drop(&mut self) {
        self.token.cancel();
        self.bridge.abort();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceOpenParams {
    root_dir: String,
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextWriteParams {
    version_id: String,
    object_id: String,
    path: String,
    text: String,
    moment_id: String,
    metadata_origin: String,
    author_json: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VersionedTextReadParams {
    version_id: String,
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocApplyParams {
    version_id: String,
    object_id: String,
    content_kind: String,
    update_base64: String,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictListParams {
    status: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictOpenParams {
    conflict: Option<ConflictDto>,
    envelope: Option<ReplicationEnvelope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictResolveParams {
    local: Option<LocalResolveDto>,
    envelope: Option<ReplicationEnvelope>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalResolveDto {
    conflict_id: String,
    resolution: String,
    merged_text: Option<String>,
    object_id: String,
    write_moment_id: String,
    delete_moment_id: String,
    metadata_origin: String,
    author_json: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchParams {
    version_id: String,
    query: String,
    limit: Option<i64>,
    now_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictDto {
    id: String,
    workspace_id: String,
    path: String,
    target_version_id: String,
    source_version_id: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    status: String,
    chosen_from: String,
    resolution: Option<String>,
    metadata: ConflictMetadataDto,
    base: ConflictStateDto,
    current: ConflictStateDto,
    incoming: ConflictStateDto,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictMetadataDto {
    origin: String,
    summary: Option<String>,
    correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConflictStateDto {
    path: String,
    content_kind: String,
    snapshot: Option<SnapshotDto>,
    metadata_summary: Option<String>,
    metadata_correlation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SnapshotDto {
    workspace_id: String,
    version_id: String,
    object_id: String,
    path: String,
    text: String,
    blob_sha256: String,
    updated_at_ms: i64,
    latest_moment_id: String,
    metadata_origin: String,
}

impl ConflictDto {
    fn into_domain(self) -> Result<TextConflict, WireError> {
        Ok(TextConflict {
            conflict_id: self.id,
            workspace_id: self.workspace_id,
            path: self.path,
            target_version_id: self.target_version_id,
            source_version_id: self.source_version_id,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            status: parse_status(&self.status)?,
            chosen_from: parse_choice(&self.chosen_from)?,
            resolution: self
                .resolution
                .as_deref()
                .map(parse_resolution)
                .transpose()?,
            metadata: ConflictMetadata {
                origin: self.metadata.origin,
                summary: self.metadata.summary,
                correlation_id: self.metadata.correlation_id,
            },
            base: self.base.into_domain()?,
            current: self.current.into_domain()?,
            incoming: self.incoming.into_domain()?,
        })
    }
}

impl ConflictStateDto {
    fn into_domain(self) -> Result<ConflictFileState, WireError> {
        let content_kind = match self.content_kind.as_str() {
            "text" => ConflictContentKind::Text,
            "binary" => ConflictContentKind::Binary,
            _ => {
                return Err(wire(
                    ErrorCode::InvalidParams,
                    "unknown conflict content kind",
                ));
            }
        };
        Ok(ConflictFileState {
            path: self.path,
            snapshot: self.snapshot.map(SnapshotDto::into_domain).transpose()?,
            // This wire DTO carries no binary payload yet; a `content_kind:
            // "binary"` side arriving here has no blob reference and fails
            // closed downstream (`insert_text_conflict_if_absent`). Wiring an
            // actual binary payload through this RPC surface is out of scope
            // for BINCONFLICT (schema + persistence only).
            binary_sha256: None,
            content_kind,
            metadata_summary: self.metadata_summary,
            metadata_correlation_id: self.metadata_correlation_id,
        })
    }
}

impl SnapshotDto {
    fn into_domain(self) -> Result<TextSnapshot, WireError> {
        let actual = dohc_engine_storage::hex_sha256(self.text.as_bytes());
        if self.blob_sha256 != actual {
            return Err(wire(
                ErrorCode::InvalidParams,
                "snapshot hash does not match text",
            ));
        }
        Ok(TextSnapshot {
            workspace_id: self.workspace_id,
            version_id: self.version_id,
            object_id: self.object_id,
            path: self.path,
            text: self.text,
            blob_sha256: self.blob_sha256,
            updated_at_ms: self.updated_at_ms,
            latest_moment_id: self.latest_moment_id,
            metadata_origin: self.metadata_origin,
        })
    }
}

fn parse_status(raw: &str) -> Result<ConflictStatus, WireError> {
    match raw {
        "open" => Ok(ConflictStatus::Open),
        "resolved" => Ok(ConflictStatus::Resolved),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown conflict status")),
    }
}

fn parse_choice(raw: &str) -> Result<ConflictChoice, WireError> {
    match raw {
        "current" => Ok(ConflictChoice::Current),
        "incoming" => Ok(ConflictChoice::Incoming),
        "merged" => Ok(ConflictChoice::Merged),
        _ => Err(wire(ErrorCode::InvalidParams, "unknown conflict choice")),
    }
}

fn parse_resolution(raw: &str) -> Result<ConflictResolution, WireError> {
    match raw {
        "kept-current" => Ok(ConflictResolution::KeptCurrent),
        "applied-incoming" => Ok(ConflictResolution::AppliedIncoming),
        "applied-merged" => Ok(ConflictResolution::AppliedMerged),
        _ => Err(wire(
            ErrorCode::InvalidParams,
            "unknown conflict resolution",
        )),
    }
}

fn snapshot_json(snapshot: &TextSnapshot) -> Value {
    json!({
        "workspaceId": snapshot.workspace_id,
        "versionId": snapshot.version_id,
        "objectId": snapshot.object_id,
        "path": snapshot.path,
        "text": snapshot.text,
        "blobSha256": snapshot.blob_sha256,
        "updatedAtMs": snapshot.updated_at_ms,
        "latestMomentId": snapshot.latest_moment_id,
        "metadataOrigin": snapshot.metadata_origin
    })
}

fn conflict_json(conflict: &TextConflict) -> Value {
    json!({
        "id": conflict.conflict_id,
        "workspaceId": conflict.workspace_id,
        "path": conflict.path,
        "targetVersionId": conflict.target_version_id,
        "sourceVersionId": conflict.source_version_id,
        "createdAtMs": conflict.created_at_ms,
        "updatedAtMs": conflict.updated_at_ms,
        "status": format!("{:?}", conflict.status).to_lowercase(),
        "chosenFrom": format!("{:?}", conflict.chosen_from).to_lowercase(),
        "resolution": conflict.resolution.map(|value| match value {
            ConflictResolution::KeptCurrent => "kept-current",
            ConflictResolution::AppliedIncoming => "applied-incoming",
            ConflictResolution::AppliedMerged => "applied-merged",
        }),
        "metadata": {
            "origin": conflict.metadata.origin,
            "summary": conflict.metadata.summary,
            "correlationId": conflict.metadata.correlation_id
        },
        "base": conflict_state_json(&conflict.base),
        "current": conflict_state_json(&conflict.current),
        "incoming": conflict_state_json(&conflict.incoming)
    })
}

fn conflict_state_json(state: &ConflictFileState) -> Value {
    json!({
        "path": state.path,
        "contentKind": match state.content_kind {
            ConflictContentKind::Text => "text",
            ConflictContentKind::Binary => "binary",
        },
        "snapshot": state.snapshot.as_ref().map(snapshot_json),
        "metadataSummary": state.metadata_summary,
        "metadataCorrelationId": state.metadata_correlation_id
    })
}

fn replicated_conflict_json(outcome: ApplyOutcome<ConflictApplyResult>) -> Value {
    match outcome {
        ApplyOutcome::Applied(result) => json!({
            "replicated": true,
            "status": "applied",
            "conflictId": result.conflict_id,
            "inserted": result.inserted,
            "matched": result.matched,
            "deferred": result.deferred
        }),
        ApplyOutcome::Skipped => json!({ "replicated": true, "status": "skipped" }),
        ApplyOutcome::Crashed { committed } => json!({
            "replicated": true,
            "status": "crashed",
            "committed": committed
        }),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, WireError> {
    serde_json::from_value(value).map_err(|_| wire(ErrorCode::InvalidParams, "invalid parameters"))
}

fn enforce_workspace(open: &OpenWorkspace, workspace_id: &str) -> Result<(), WireError> {
    if open.workspace_id == workspace_id {
        Ok(())
    } else {
        Err(wire(ErrorCode::InvalidParams, "workspace scope mismatch"))
    }
}

fn now_ms() -> Result<i64, WireError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| wire(ErrorCode::Internal, "system clock unavailable"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| wire(ErrorCode::Internal, "system clock unavailable"))
}

fn map_runtime(error: RuntimeError) -> WireError {
    if matches!(
        &error,
        RuntimeError::Collab(CollabError::ReplayParityViolation { .. })
    ) {
        return wire(ErrorCode::InvalidParams, "Y.Doc replay parity violation");
    }
    let code = match error {
        RuntimeError::Overloaded => ErrorCode::Overloaded,
        RuntimeError::Cancelled => ErrorCode::Cancelled,
        RuntimeError::DeadlineExceeded => ErrorCode::DeadlineExceeded,
        RuntimeError::ActorUnavailable | RuntimeError::WorkerPanicked => {
            ErrorCode::WorkspaceUnavailable
        }
        RuntimeError::Domain(error) => map_domain_code(error),
        RuntimeError::Collab(error) => map_collab_code(error),
        RuntimeError::Sync(error) => map_sync_code(error),
        RuntimeError::Search(error) => map_search_code(error),
        _ => ErrorCode::Internal,
    };
    wire(code, "workspace operation failed")
}

fn map_domain_code(error: DomainError) -> ErrorCode {
    match error {
        DomainError::Storage(_) | DomainError::StateCorrupt { .. } => ErrorCode::Internal,
        DomainError::Crypto(error) => match error {
            dohc_engine_crypto::CryptoError::InvalidIvLength
            | dohc_engine_crypto::CryptoError::InvalidTagLength
            | dohc_engine_crypto::CryptoError::PlaintextTooLarge
            | dohc_engine_crypto::CryptoError::PlaintextNotUtf8
            | dohc_engine_crypto::CryptoError::InvalidBase64 => ErrorCode::InvalidParams,
            dohc_engine_crypto::CryptoError::DecryptFailed
            | dohc_engine_crypto::CryptoError::InvalidKeyLength
            | dohc_engine_crypto::CryptoError::KeyFileMalformed
            | dohc_engine_crypto::CryptoError::EnvelopeUnwrapFailed => ErrorCode::Internal,
        },
        DomainError::WorkspaceNotFound
        | DomainError::VersionNotFound
        | DomainError::WorkspaceMismatch
        | DomainError::VersionNameConflict
        | DomainError::DuplicateMomentId
        | DomainError::FileNotFound
        | DomainError::TargetPathExists
        | DomainError::ForkBaseNotFound
        | DomainError::ConflictNotFound
        | DomainError::ConflictStaleTarget
        | DomainError::InvalidText { .. }
        | DomainError::InvalidPath { .. }
        | DomainError::NotSecretPath
        | DomainError::InvalidInput { .. }
        | DomainError::IdempotencyKeyReuseMismatch
        | DomainError::SecretMomentNotFound
        | DomainError::Chat { .. } => ErrorCode::InvalidParams,
        _ => ErrorCode::Internal,
    }
}

fn map_collab_code(error: CollabError) -> ErrorCode {
    match error {
        CollabError::Corrupt { .. } | CollabError::Storage(_) => ErrorCode::Internal,
        CollabError::MalformedUpdate { .. }
        | CollabError::ReplayParityViolation { .. }
        | CollabError::EmptyUpdate
        | CollabError::UpdateTooLarge { .. }
        | CollabError::InvalidIdentifier { .. }
        | CollabError::ContentKindMismatch
        | CollabError::BaseAlreadyClaimed
        | CollabError::LeaseHeld
        | CollabError::NoMarker
        | CollabError::UnsettledClose => ErrorCode::InvalidParams,
    }
}

fn map_sync_code(error: SyncError) -> ErrorCode {
    match error {
        SyncError::Storage(_)
        | SyncError::SequenceGap
        | SyncError::CoordinateDiverged
        | SyncError::FaultCrash => ErrorCode::Internal,
        SyncError::InvalidInput { .. }
        | SyncError::UnsupportedOperation
        | SyncError::ShareBoundaryViolation
        | SyncError::BlobInvalid => ErrorCode::InvalidParams,
    }
}

fn map_search_code(error: SearchError) -> ErrorCode {
    match error {
        SearchError::Bounds(_) => ErrorCode::InvalidParams,
        SearchError::Storage(_) | SearchError::Store(_) | SearchError::Corrupt(_) => {
            ErrorCode::Internal
        }
    }
}

fn map_shadow_fence(_error: shadow_fence::ShadowFenceError) -> WireError {
    wire(ErrorCode::InvalidParams, "shadow workspace refused")
}

fn workspace_unavailable() -> WireError {
    wire(
        ErrorCode::WorkspaceUnavailable,
        "workspace handle is unavailable",
    )
}

fn wire(code: ErrorCode, message: &'static str) -> WireError {
    WireError::new(code, message)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn runtime_error_mapping_separates_corruption_from_bad_input() {
        let corrupt = map_runtime(RuntimeError::Collab(CollabError::Corrupt {
            reason: "test corrupt lineage".to_owned(),
        }));
        assert_eq!(corrupt.code, ErrorCode::Internal);

        let storage =
            dohc_engine_storage::StorageError::persist_public(rusqlite::Error::InvalidQuery);
        let persisted = map_runtime(RuntimeError::Sync(SyncError::Storage(storage)));
        assert_eq!(persisted.code, ErrorCode::Internal);

        let invalid = map_runtime(RuntimeError::Domain(DomainError::InvalidInput {
            reason: "test invalid input",
        }));
        assert_eq!(invalid.code, ErrorCode::InvalidParams);
    }

    #[tokio::test]
    async fn cancelled_workspace_open_does_not_wait_for_open_lock() {
        let service = Arc::new(EngineService::new());
        let held = service.open_lock.lock().await;
        let ctx = RequestContext::unbounded();
        let cancel = ctx.cancel.clone();
        let queued_service = Arc::clone(&service);
        let queued = tokio::spawn(async move {
            queued_service
                .workspace_open(
                    &ctx,
                    json!({
                        "rootDir": std::env::temp_dir().join("dohc-r14-cancelled-open"),
                        "workspaceId": "cancelled-open"
                    }),
                )
                .await
        });

        tokio::task::yield_now().await;
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_millis(250), queued)
            .await
            .expect("cancelled open resolved promptly")
            .expect("queued task completed")
            .expect_err("cancelled queued open must fail");
        assert_eq!(result.code, ErrorCode::Cancelled);
        drop(held);
    }
}
