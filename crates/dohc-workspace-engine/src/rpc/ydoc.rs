use crate::EngineService;
use crate::capture_driver;
use crate::events::emit_automation_claimed;
use crate::events::emit_record_events;
use crate::lock;
use crate::rpc::collections::collection_in_band_cap;
use crate::rpc::error::initial_capture_updating;
use crate::rpc::error::map_owner_outbox;
use crate::rpc::error::map_runtime;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::reads::MAX_INBAND_CONTENT_BYTES;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use base64::Engine as _;
use dohc_engine_collab::CollabError;
use dohc_engine_collab::ContentKind;
use dohc_engine_collab::DocKey;
use dohc_engine_collab::Lease;
use dohc_engine_collab::Regime;
use dohc_engine_collab::owner_outbox::draft::{OwnerDraftDescriptor, OwnerDraftSnapshot};
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::BlobEgress;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::Response;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::CancellationToken;
use dohc_engine_runtime::NoFaults;
use dohc_engine_runtime::RuntimeError;
use dohc_engine_runtime::actor::YdocSeedMaterialization;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

const AUTHOR_SETTLEMENT_RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Default)]
struct AuthorSettlementQueue {
    queued: bool,
    retry_after: Option<Instant>,
}

impl AuthorSettlementQueue {
    fn try_queue(&mut self, now: Instant) -> bool {
        if self.queued
            || self
                .retry_after
                .is_some_and(|retry_after| now < retry_after)
        {
            return false;
        }
        self.queued = true;
        true
    }

    fn finish(&mut self, failed: bool, now: Instant) {
        self.queued = false;
        self.retry_after = failed.then(|| now + AUTHOR_SETTLEMENT_RETRY_DELAY);
    }
}

type EditorDraftRead = (Option<OwnerDraftSnapshot>, Option<Arc<dyn Send + Sync>>);

pub(crate) struct YdocSession {
    pub(super) owner_draft: Option<OwnerDraftDescriptor>,
    pub(super) workspace: WorkspaceHandle,
    pub(super) key: DocKey,
    pub(super) path: String,
    pub(super) content_kind: ContentKind,
    pub(super) regime: Regime,
    pub(super) lineage_claim_id: Option<String>,
    pub(super) restore_generation: Option<i64>,
    pub(super) lineage_absent: bool,
    pub(super) first_update_pending: bool,
    author_settlement: AuthorSettlementQueue,
    pub(super) last_settled_sha: Option<String>,
    /// The head sha observed at open — the settle preimage expectation
    /// until the session's first settle replaces it.
    pub(super) open_head_sha: Option<String>,
    pub(super) owner_seed_source: Option<dohc_engine_collab::owner_base_source::OwnerSeedSource>,
    _lease: Lease,
}

impl YdocSession {
    pub(super) fn imported_owner(
        workspace: WorkspaceHandle,
        key: DocKey,
        captured: &dohc_engine_collab::live_update_application::ImportedOwnerActivation,
        lease: Lease,
    ) -> Self {
        Self {
            owner_draft: None,
            workspace,
            key,
            path: captured.source.current_path.clone(),
            content_kind: ContentKind::Richdoc,
            regime: Regime::Replicated,
            lineage_claim_id: Some(captured.source.lineage_claim_id.clone()),
            restore_generation: captured.restore_generation,
            lineage_absent: false,
            first_update_pending: false,
            author_settlement: AuthorSettlementQueue::default(),
            last_settled_sha: None,
            open_head_sha: Some(captured.source.source_digest.clone()),
            owner_seed_source: None,
            _lease: lease,
        }
    }
}

#[derive(Clone)]
pub(super) struct YdocSessionView {
    pub(super) owner_draft: Option<OwnerDraftDescriptor>,
    pub(super) key: DocKey,
    pub(super) path: String,
    pub(super) content_kind: ContentKind,
    pub(super) regime: Regime,
    pub(super) lineage_claim_id: Option<String>,
    pub(super) restore_generation: Option<i64>,
    pub(super) lineage_absent: bool,
    pub(super) first_update_pending: bool,
    pub(super) last_settled_sha: Option<String>,
    pub(super) open_head_sha: Option<String>,
    pub(super) owner_seed_source: Option<dohc_engine_collab::owner_base_source::OwnerSeedSource>,
}

fn map_ydoc_open_runtime(error: RuntimeError) -> WireError {
    match error {
        RuntimeError::YdocOpenConflict { .. } => {
            WireError::new(ErrorCode::InvalidParams, "ydoc-conflict-open")
        }
        RuntimeError::YdocArtifactAssetsPending => {
            WireError::new(ErrorCode::Overloaded, "ydoc-artifact-assets-pending")
        }
        RuntimeError::YdocArtifactAssetsInvalid => {
            WireError::new(ErrorCode::Internal, "ydoc-artifact-assets-invalid")
        }
        error @ RuntimeError::Storage(dohc_engine_storage::StorageError::FileLocked) => {
            map_runtime(error)
        }
        RuntimeError::Storage(_) => WireError::new(ErrorCode::Internal, "ydoc-open-storage-failed"),
        RuntimeError::OperationCrashed => {
            WireError::new(ErrorCode::Internal, "ydoc-open-operation-crashed")
        }
        other => map_runtime(other),
    }
}

fn scene_seed_materialization_error(materialization: YdocSeedMaterialization) -> WireError {
    const REFUSAL_DETAIL_DELIMITER: &str = ": ";
    let (code, message) = if materialization.invalid_jobs > 0 {
        (ErrorCode::Internal, "ydoc-artifact-assets-invalid")
    } else {
        (ErrorCode::Overloaded, "ydoc-artifact-assets-pending")
    };
    WireError::new(
        code,
        format!(
            "{message}{REFUSAL_DETAIL_DELIMITER}invalid_jobs={}, incomplete_jobs={}",
            materialization.invalid_jobs, materialization.incomplete_jobs
        ),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerYDocOutboxLimitsParams {
    max_pending_bytes: i64,
    max_pending_age_ms: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerYDocOutboxAppendParams {
    binding: dohc_engine_collab::LiveObjectBinding,
    base_update_base64: String,
    append_key: String,
    update_base64: String,
    limits: OwnerYDocOutboxLimitsParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerYDocOutboxIdParams {
    outbox_id: String,
    cursor: Option<dohc_engine_collab::OwnerOutboxReadCursor>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerYDocDeliveryReceiptParams {
    delivery_id: String,
    update_digest: String,
    journal_cursor: i64,
    accepting_host_epoch: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerYDocOutboxAcknowledgeParams {
    outbox_id: String,
    receipts: Vec<OwnerYDocDeliveryReceiptParams>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerYDocOutboxQuarantineParams {
    outbox_id: String,
    reason: String,
    #[serde(default)]
    observed_binding: Option<dohc_engine_collab::LiveObjectBinding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocOpenParams {
    version_id: String,
    path: String,
    #[serde(default)]
    expected_object_id: Option<String>,
    #[serde(default)]
    content_kind: Option<String>,
    #[serde(default)]
    seed_from_artifact: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocOpenResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_draft: Option<OwnerDraftDescriptor>,
    session_id: String,
    object_id: String,
    path: String,
    content_kind: &'static str,
    lineage: &'static str,
    /// The resumed lineage holds updates its workspace file may not: the client
    /// settles it before it reports the document saved.
    unsettled: bool,
    lineage_claim_id: Option<String>,
    /// Whether this device claimed the lineage from its own unclaimed
    /// history. A client that opened the lineage unclaimed keeps its document
    /// under such a claim; any other new claim replaces it.
    lineage_originated_here: bool,
    /// Whether the ENTERED VERSION has a committed snapshot for this path.
    /// "absent" means the daemon bound an empty doc over a path the version
    /// does not contain — legitimate only while the caller is creating the
    /// file. The consumer owns that decision; the contract it applies is
    /// stated on `WorkspaceEngineCapture.openYDocSession`
    /// (apps/desktop/src/workspaces/workspaceEngineCapture.ts).
    head: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    seed_content: Option<String>,
    /// The Yjs client the client must seed `seed_content` under, so every
    /// device seeding the same head originates the same base.
    #[serde(skip_serializing_if = "Option::is_none")]
    seed_client_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artifact_assets: Option<Vec<ArtifactAssetDescriptorResult>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactAssetDescriptorResult {
    id: String,
    mime_type: String,
    created: u64,
    r#ref: String,
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_retrieved: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocRecordUpdateParams {
    session_id: String,
    update_base64: String,
    #[serde(default)]
    actor_origin_id: Option<String>,
    /// Declared write provenance: actor kind, `onBehalfOf` principal, and
    /// automation-chain depth. Optional; recorded beside the author origin on
    /// the update row and every history row the apply derives.
    #[serde(default)]
    attribution: Option<dohc_engine_domain::ChangeAttribution>,
    /// The client declares this update as the SEED: a faithful import of the
    /// `seedContent` the open returned, built before any user input could
    /// reach the session. Only the adapter's seed path sends it; a
    /// crash-replay of prior state must not. The engine accepts it only for
    /// the first update of a lineage-absent session, and records the open
    /// head as the lineage's seed source.
    #[serde(default)]
    seed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocRecordUpdateResult {
    /// Durable per-lineage head sequence (not a session-local counter).
    seq: i64,
    deduped: bool,
    lineage_claim_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocSettleParams {
    session_id: String,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocProjectionProvenance {
    content_kind: &'static str,
    source_state_vector_sha256: String,
    destructive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocSettleResult {
    moment_id: String,
    path: String,
    /// `null` once the settled content is past the in-band cap. The settle
    /// still committed and the daemon wrote the file — the client reads it
    /// from disk rather than echoing it back over the wire.
    content: Option<String>,
    sha256: String,
    /// `false` when the settle committed but materialization was blocked by
    /// containment: the file on disk is still the old artifact and the write
    /// is pending a retry. Nothing may report the document as saved on this.
    materialized: bool,
    projection: YdocProjectionProvenance,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocCloseParams {
    session_id: String,
    #[serde(default)]
    settle: Option<bool>,
    #[serde(default)]
    summary: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocCloseResult {
    closed: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocEvictParams {
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocEvictResult {
    evicted: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct YdocResyncParams {
    session_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YdocResyncResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    owner_draft: Option<OwnerDraftDescriptor>,
    lineage_claim_id: Option<String>,
    lineage_originated_here: bool,
    recovered_paths: Vec<String>,
    artifact_assets: Vec<ArtifactAssetDescriptorResult>,
}

fn validate_owner_outbox_wire_binding(
    binding: &dohc_engine_collab::LiveObjectBinding,
) -> Result<(), WireError> {
    if binding.restore_fence_generation < 0
        || binding.restore_fence_generation > dohc_engine_protocol::MAX_WIRE_INTEGER as i64
    {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "invalid-owner-outbox-binding",
        ));
    }
    Ok(())
}

fn validate_owner_outbox_limit(value: i64) -> Result<(), WireError> {
    if value <= 0 || value > dohc_engine_protocol::MAX_WIRE_INTEGER as i64 {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "invalid-owner-outbox-limit",
        ));
    }
    Ok(())
}

fn decode_owner_outbox_base64(value: &str) -> Result<Vec<u8>, WireError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid-owner-outbox-base64"))?;
    if base64::engine::general_purpose::STANDARD.encode(&bytes) != value {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "invalid-owner-outbox-base64",
        ));
    }
    Ok(bytes)
}

fn parse_ydoc_content_kind(raw: &str) -> Result<ContentKind, WireError> {
    match raw {
        "plaintext" => Ok(ContentKind::Plaintext),
        "richdoc" => Ok(ContentKind::Richdoc),
        "scene" => Ok(ContentKind::Scene),
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "unknown Y.Doc content kind",
        )),
    }
}

fn ydoc_content_kind_name(kind: ContentKind) -> &'static str {
    match kind {
        ContentKind::Plaintext => "plaintext",
        ContentKind::Richdoc => "richdoc",
        ContentKind::Scene => "scene",
    }
}

fn validate_ydoc_path(path: &str) -> Result<(), WireError> {
    match dohc_engine_files::classify_engine_file_path_normalized(path) {
        (dohc_engine_files::PathClassification::Tracked, Some(normalized))
            if normalized == path =>
        {
            Ok(())
        }
        _ => Err(WireError::new(
            ErrorCode::InvalidParams,
            "invalid Y.Doc path",
        )),
    }
}

impl EngineService {
    async fn ydoc_editor_draft(
        &self,
        open: &Arc<OpenWorkspace>,
        key: &DocKey,
        cancellation: &OperationCancellation,
    ) -> Result<EditorDraftRead, WireError> {
        let descriptor = open
            .actor
            .owner_ydoc_draft_for_key(key.clone(), cancellation.token())
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        let Some(descriptor) = descriptor else {
            return Ok((None, None));
        };
        let reservation = self.reserve_owner_delivery()?;
        let draft = open
            .actor
            .owner_ydoc_open_draft(
                descriptor.binding,
                descriptor.revision,
                cancellation.token(),
                Arc::clone(&reservation),
            )
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        Ok((Some(draft), Some(reservation)))
    }

    /// Keep scene-open exclusion owned by the detached completion. The
    /// protocol supervisor can stop waiting on cancellation or deadline, but
    /// a queued actor command still runs after its reply receiver is dropped.
    async fn complete_scene_seed_materialization(
        cancellation: &OperationCancellation,
        materialization: impl std::future::Future<
            Output = Result<YdocSeedMaterialization, RuntimeError>,
        > + Send
        + 'static,
        serial: tokio::sync::OwnedMutexGuard<()>,
        lease: Lease,
    ) -> Result<
        (
            YdocSeedMaterialization,
            tokio::sync::OwnedMutexGuard<()>,
            Lease,
        ),
        WireError,
    > {
        let completion = tokio::spawn(async move {
            let materialization = materialization.await;
            (materialization, serial, lease)
        });
        tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                Err(cancellation.interruption("ydoc.open (scene asset materialization)"))
            }
            completed = completion => {
                let (materialization, serial, lease) = completed
                    .map_err(|_| WireError::new(ErrorCode::Internal, "ydoc scene asset materialization task failed"))?;
                Ok((materialization.map_err(map_runtime)?, serial, lease))
            }
        }
    }

    pub(super) async fn owner_ydoc_outbox_append(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: OwnerYDocOutboxAppendParams = parse(params)?;
        validate_owner_outbox_wire_binding(&params.binding)?;
        validate_owner_outbox_limit(params.limits.max_pending_bytes)?;
        validate_owner_outbox_limit(params.limits.max_pending_age_ms)?;
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        #[cfg(test)]
        if let Some((reached, release, armed)) = &self.owner_outbox_append_probe
            && armed.swap(false, std::sync::atomic::Ordering::AcqRel)
        {
            reached.notify_one();
            release.notified().await;
        }
        let base_update = decode_owner_outbox_base64(&params.base_update_base64)?;
        let update = decode_owner_outbox_base64(&params.update_base64)?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = self
            .mutation_session_guard(&open, &cancellation, "ydoc.ownerOutbox.append (queued)")
            .await?;
        let open = self.open(Some(&handle))?;
        let result = open
            .actor
            .owner_ydoc_outbox_append(
                open.workspace_id.clone(),
                dohc_engine_collab::OwnerOutboxAppendInput {
                    binding: params.binding,
                    base_update,
                    append_key: params.append_key,
                    update,
                    limits: dohc_engine_collab::OwnerOutboxLimits {
                        max_pending_bytes: params.limits.max_pending_bytes,
                        max_pending_age_ms: params.limits.max_pending_age_ms,
                    },
                    created_at_ms: now_ms()?,
                },
                cancellation.token(),
            )
            .await
            .map_err(|error| match error {
                RuntimeError::Cancelled => cancellation.interruption("ydoc.ownerOutbox.append"),
                error => map_runtime(error),
            })?
            .map_err(map_owner_outbox)?;
        Ok(json!({
            "outboxId": result.outbox_id,
            "sequence": result.sequence,
            "deliveryId": result.delivery_id,
            "updateDigest": result.update_digest,
            "pendingBytes": result.pending_bytes,
            "oldestEntryAtMs": result.oldest_entry_at_ms,
            "state": result.state.as_str(),
        }))
    }

    pub(super) async fn owner_ydoc_outbox_read_pending(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<Value, WireError> {
        let params: OwnerYDocOutboxIdParams = parse(params)?;
        // Base64 consumes four bytes per three input bytes. The existing
        // collection cap reserves envelope space; the final check below uses
        // the actual response envelope and this request's negotiated limit.
        let max_bytes = collection_in_band_cap(ctx) / 4 * 3;
        if max_bytes == 0 {
            return Err(WireError::new(
                ErrorCode::LimitExceeded,
                "owner-outbox-page-exceeds-wire-limit",
            ));
        }
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let read = async move {
            tokio::task::spawn_blocking(move || {
                let store = dohc_engine_storage::EngineStore::open_read_only(&open.db_path)?;
                dohc_engine_collab::read_pending_owner_outbox_page(
                    &store,
                    &open.workspace_id,
                    &params.outbox_id,
                    params.cursor,
                    max_bytes,
                )
            })
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "owner-outbox-worker-failed"))?
            .map_err(map_owner_outbox)
        };
        let pending = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.ownerOutbox.readPending"));
            }
            result = read => result?,
        };
        let result = match pending {
            dohc_engine_collab::OwnerOutboxPageResult::ReadChanged => {
                json!({ "kind": "readChanged" })
            }
            dohc_engine_collab::OwnerOutboxPageResult::Page(page) => json!({
                "kind": "page",
                "snapshot": page.cursor.snapshot,
                "part": page.cursor.part,
                "sequence": page.cursor.sequence,
                "offset": page.cursor.offset,
                "totalBytes": page.total_bytes,
                "digest": page.digest,
                "bytesBase64": base64::engine::general_purpose::STANDARD.encode(page.bytes),
                "nextCursor": page.next_cursor,
            }),
        };
        let envelope = dohc_engine_protocol::wire::Envelope::Response(Response {
            id: request_id,
            result,
        });
        if serde_json::to_vec(&envelope)
            .map_err(|_| WireError::new(ErrorCode::Internal, "owner-outbox-state-corrupt"))?
            .len()
            > ctx.max_frame_bytes as usize
        {
            return Err(WireError::new(
                ErrorCode::LimitExceeded,
                "owner-outbox-page-exceeds-wire-limit",
            ));
        }
        let dohc_engine_protocol::wire::Envelope::Response(response) = envelope else {
            unreachable!()
        };
        Ok(response.result)
    }

    pub(super) async fn owner_ydoc_outbox_acknowledge(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: OwnerYDocOutboxAcknowledgeParams = parse(params)?;
        for receipt in &params.receipts {
            if receipt.accepting_host_epoch < 1
                || receipt.accepting_host_epoch > dohc_engine_protocol::MAX_WIRE_INTEGER as i64
                || receipt.journal_cursor < 1
                || receipt.journal_cursor > dohc_engine_protocol::MAX_WIRE_INTEGER as i64
            {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "invalid-owner-outbox-receipt",
                ));
            }
        }
        let receipts = params
            .receipts
            .into_iter()
            .map(|receipt| dohc_engine_collab::OwnerDeliveryReceipt {
                delivery_id: receipt.delivery_id,
                update_digest: receipt.update_digest,
                journal_cursor: receipt.journal_cursor,
                accepting_host_epoch: receipt.accepting_host_epoch,
            })
            .collect::<Vec<_>>();
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = self
            .mutation_session_guard(
                &open,
                &cancellation,
                "ydoc.ownerOutbox.acknowledge (queued)",
            )
            .await?;
        let open = self.open(Some(&handle))?;
        let result = open
            .actor
            .owner_ydoc_outbox_acknowledge(
                open.workspace_id.clone(),
                params.outbox_id,
                receipts,
                cancellation.token(),
            )
            .await
            .map_err(|error| match error {
                RuntimeError::Cancelled => {
                    cancellation.interruption("ydoc.ownerOutbox.acknowledge")
                }
                error => map_runtime(error),
            })?
            .map_err(map_owner_outbox)?;
        Ok(json!({
            "acknowledged": result.acknowledged,
            "pendingBytes": result.pending_bytes,
            "oldestEntryAtMs": result.oldest_entry_at_ms,
        }))
    }

    pub(super) async fn owner_ydoc_outbox_quarantine(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: OwnerYDocOutboxQuarantineParams = parse(params)?;
        if let Some(binding) = &params.observed_binding {
            validate_owner_outbox_wire_binding(binding)?;
        }
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        let cancellation = OperationCancellation::new(ctx);
        let _serial = self
            .mutation_session_guard(&open, &cancellation, "ydoc.ownerOutbox.quarantine (queued)")
            .await?;
        let open = self.open(Some(&handle))?;
        open.actor
            .owner_ydoc_outbox_quarantine(
                open.workspace_id.clone(),
                dohc_engine_collab::OwnerOutboxQuarantineInput {
                    outbox_id: params.outbox_id,
                    reason: params.reason,
                    observed_binding: params.observed_binding,
                },
                cancellation.token(),
            )
            .await
            .map_err(|error| match error {
                RuntimeError::Cancelled => cancellation.interruption("ydoc.ownerOutbox.quarantine"),
                error => map_runtime(error),
            })?
            .map_err(map_owner_outbox)?;
        Ok(json!({ "quarantined": true }))
    }

    pub(super) async fn ydoc_open(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, BlobEgress), WireError> {
        let params: YdocOpenParams = parse(params)?;
        validate_ydoc_path(&params.path)?;
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(&handle))?;
        let requested_kind = params
            .content_kind
            .as_deref()
            .map(parse_ydoc_content_kind)
            .transpose()?;
        if params.seed_from_artifact && requested_kind != Some(ContentKind::Scene) {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "seedFromArtifact requires contentKind scene",
            ));
        }
        let cancellation = OperationCancellation::new(ctx);
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.open (queued)"));
            }
            serial = Arc::clone(&open.session_ops).lock_owned() => serial,
        };
        // The first read only derives the key (head resolution can't happen
        // without it). The lease is then taken on that key and the state is
        // RE-READ under it, so the second read is authoritative for the
        // acquired session.
        let probe = open
            .actor
            .ydoc_open_state(
                open.workspace_id.clone(),
                now_ms()?,
                false,
                None,
                params.version_id.clone(),
                params.path.clone(),
                requested_kind,
                cancellation.token(),
            )
            .await
            .map_err(map_ydoc_open_runtime)?;
        if params
            .expected_object_id
            .as_deref()
            .is_some_and(|expected| expected != probe.key.object_id.as_str())
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ydoc-object-changed",
            ));
        }
        let capture_phase = lock(&open.capture)
            .as_ref()
            .map(|driver| driver.status().snapshot().phase)
            .unwrap_or(capture_driver::CapturePhase::Ready);
        if probe.head_blob_sha256.is_none() && capture_phase != capture_driver::CapturePhase::Ready
        {
            let artifact_path = open.root.join(&params.path);
            let artifact_probe = tokio::task::spawn_blocking(move || {
                matches!(
                    std::fs::symlink_metadata(artifact_path),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound
                )
            });
            let artifact_is_proven_absent = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => {
                    return Err(cancellation.interruption("ydoc.open (artifact probe)"));
                }
                probed = artifact_probe => {
                    probed.map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?
                }
            };
            if !artifact_is_proven_absent {
                // The initial scan has seen this artifact but has not installed
                // its head yet. Refuse before lease acquisition; otherwise a new
                // absent-lineage session can block capture and turn disk bytes
                // into a misleading uncaptured-artifact failure.
                return Err(initial_capture_updating());
            }
        }
        let lease =
            self.leases
                .scoped(&open.root)
                .acquire(&probe.key)
                .map_err(|error| match error {
                    CollabError::LeaseHeld => {
                        WireError::new(ErrorCode::InvalidParams, "ydoc-session-busy")
                    }
                    other => map_runtime(RuntimeError::Collab(other)),
                })?;
        let mut state = open
            .actor
            .ydoc_open_state_with_artifact_seed(
                open.workspace_id.clone(),
                now_ms()?,
                true,
                Some(probe.key.clone()),
                params.version_id,
                params.path.clone(),
                requested_kind,
                params.seed_from_artifact,
                cancellation.token(),
            )
            .await
            .map_err(|error| {
                if let RuntimeError::YdocOpenConflict { record_facts } = &error {
                    for facts in record_facts {
                        emit_record_events(&self.events, &open.workspace_id, facts);
                    }
                }
                map_ydoc_open_runtime(error)
            })?;
        if state.key != probe.key {
            // The path's owner changed between the probe and the lease: the
            // held lease guards the wrong key. Refuse; the client retries.
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ydoc-session-busy",
            ));
        }
        // Post-commit: the open's drain committed these history rows, and no
        // other path fires a parked update's events. Never claims —
        // drained updates are synced, and only the origin device claims its
        // automation triggers (ADR 0008).
        for facts in &state.record_facts {
            emit_record_events(&self.events, &open.workspace_id, facts);
        }
        let (serial, lease) = if state.seed_materialization_jobs.is_empty() {
            (serial, lease)
        } else {
            let actor = open.actor.clone();
            let root = open.root.clone();
            let workspace_id = open.workspace_id.clone();
            let job_ids = state.seed_materialization_jobs.clone();
            let self_writes = Arc::new(self.self_writes.scoped(&open.root));
            let materialization_now_ms = now_ms()?;
            let materialization = async move {
                actor
                    .ydoc_materialize_scene_seed_assets(
                        root,
                        workspace_id,
                        job_ids,
                        self_writes,
                        materialization_now_ms,
                    )
                    .await
            };
            let (materialization, serial, lease) = Self::complete_scene_seed_materialization(
                &cancellation,
                materialization,
                serial,
                lease,
            )
            .await?;
            if !materialization.materialized {
                return Err(scene_seed_materialization_error(materialization));
            }
            (serial, lease)
        };
        let sequence = self
            .next_session
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let session_id = format!("ydoc-{}-{sequence:016x}", self.session_epoch);
        let (draft, _draft_reservation) = self
            .ydoc_editor_draft(&open, &state.key, &cancellation)
            .await?;
        if draft.as_ref().is_some_and(|draft| {
            draft.descriptor.binding.current_path != params.path
                || Some(&draft.descriptor.binding.lineage_claim_id)
                    != state.lineage_claim_id.as_ref()
                || state.content_kind != ContentKind::Richdoc
                || state.restore_generation.is_some()
        }) {
            return Err(map_owner_outbox(
                dohc_engine_collab::OwnerOutboxError::ParentMismatch,
            ));
        }
        let owner_draft = draft.map(|draft| {
            state.initial_update = draft.initial_update;
            draft.descriptor
        });
        let initial_update = state.initial_update;
        let byte_permit = self
            .blob_egress_budget
            .reserve(
                i64::try_from(initial_update.len())
                    .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?,
                &cancellation,
                "ydoc.open",
            )
            .await?;
        let initial_update_sha256 = dohc_engine_storage::hex_sha256(&initial_update);
        let result = YdocOpenResult {
            owner_draft: owner_draft.clone(),
            session_id: session_id.clone(),
            object_id: state.key.object_id.clone(),
            path: params.path.clone(),
            content_kind: ydoc_content_kind_name(state.content_kind),
            lineage: if state.lineage_existing {
                "existing"
            } else {
                "absent"
            },
            unsettled: state.unsettled,
            lineage_claim_id: state.lineage_claim_id.clone(),
            lineage_originated_here: state.lineage_originated_here,
            head: if state.head_blob_sha256.is_some() {
                "present"
            } else {
                "absent"
            },
            seed_content: {
                // A seed past the in-band cap cannot cross the wire as one
                // string, and a client that can't seed can't edit: refuse the
                // open outright (blob streaming for large bodies is RPC-D).
                if state
                    .seed_content
                    .as_ref()
                    .is_some_and(|seed| seed.len() > MAX_INBAND_CONTENT_BYTES)
                {
                    return Err(WireError::new(
                        ErrorCode::InvalidParams,
                        "ydoc-seed-exceeds-inband-cap",
                    ));
                }
                state.seed_content
            },
            seed_client_id: state.seed_client_id,
            artifact_assets: (!state.artifact_assets.is_empty()).then(|| {
                state
                    .artifact_assets
                    .into_iter()
                    .map(|asset| ArtifactAssetDescriptorResult {
                        id: asset.id,
                        mime_type: asset.mime_type,
                        created: asset.created,
                        r#ref: asset.path,
                        sha256: asset.sha256,
                        last_retrieved: asset.last_retrieved,
                        version: asset.version,
                    })
                    .collect()
            }),
        };
        lock(&self.sessions).insert(
            session_id,
            YdocSession {
                owner_draft,
                workspace: handle,
                key: state.key,
                path: params.path,
                content_kind: state.content_kind,
                regime: state.regime,
                lineage_claim_id: state.lineage_claim_id,
                restore_generation: state.restore_generation,
                lineage_absent: !state.lineage_existing,
                first_update_pending: !state.lineage_existing,
                author_settlement: AuthorSettlementQueue::default(),
                last_settled_sha: None,
                open_head_sha: state.head_blob_sha256,
                owner_seed_source: state.owner_seed_source,
                _lease: lease,
            },
        );
        drop(serial);
        let result = serde_json::to_value(result)
            .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))?;
        Ok((
            result,
            BlobEgress {
                stream_id: request_id,
                sha256: initial_update_sha256,
                bytes: initial_update,
                cancel: ctx.cancel.clone(),
                deadline: ctx.deadline,
                byte_permit: Some(byte_permit),
            },
        ))
    }

    pub(super) async fn ydoc_record_update(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        idempotency_key: Option<String>,
        params: Value,
    ) -> Result<Value, WireError> {
        let mut params: YdocRecordUpdateParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let open = self.open(handle.as_ref())?;
        // An owned guard: it moves INTO the spawned task below, so a dropped
        // RPC future cannot release the session serial while the record (and
        // its first_update_pending transition) is still running — a second
        // recordUpdate would otherwise read the stale flag and refuse
        // seed-onto-existing-lineage after the first write committed.
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.recordUpdate (queued)"));
            }
            serial = Arc::clone(&open.session_ops).lock_owned() => serial,
        };
        let (open, session) = self.ydoc_session(handle.as_ref(), &params.session_id)?;
        let update = base64::engine::general_purpose::STANDARD
            .decode(params.update_base64)
            .map_err(|_| WireError::new(ErrorCode::InvalidParams, "invalid update encoding"))?;
        if let Some(attribution) = &params.attribution
            && let Err(reason) = attribution.validate()
        {
            return Err(WireError::new(ErrorCode::InvalidParams, reason));
        }
        let require_empty = session.lineage_absent && session.first_update_pending;
        // A declared seed on anything but the first update of a
        // lineage-absent session is a client bug: accepting it would record a
        // false seed source and let a later settle skip a write that carried
        // real edits. Refuse instead — a seed can only be the first update.
        if params.seed && !require_empty {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "seed-not-first-update",
            ));
        }
        if params.seed {
            params.actor_origin_id = None;
            params.attribution = None;
        }
        let seed_source = params
            .seed
            .then(|| session.owner_seed_source.clone())
            .flatten();
        if let Some(draft) = &session.owner_draft {
            if draft.binding.current_path != session.path
                || Some(&draft.binding.lineage_claim_id) != session.lineage_claim_id.as_ref()
                || params.seed
                || require_empty
                || session.restore_generation.is_some()
            {
                return Err(map_owner_outbox(
                    dohc_engine_collab::OwnerOutboxError::ParentMismatch,
                ));
            }
            let append_key = idempotency_key.ok_or_else(|| {
                WireError::new(
                    ErrorCode::InvalidParams,
                    "owner-draft-requires-idempotency-key",
                )
            })?;
            let input = dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                binding: draft.binding.clone(),
                expected_revision: draft.revision,
                append_key,
                update,
                now_ms: now_ms()?,
            };
            let actor = open.actor.clone();
            let workspace = open.workspace_id.clone();
            let token = cancellation.token();
            let reservation = self.reserve_owner_delivery()?;
            let append = tokio::spawn(async move {
                let _serial = serial;
                actor
                    .owner_ydoc_append_draft(workspace, input, token, reservation)
                    .await
            })
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "ydoc record task failed"))?
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
            return Ok(json!({
                "lineageClaimId": session.lineage_claim_id,
                "ownerDraft": {
                    "outboxId": append.outbox_id,
                    "sequence": append.sequence,
                    "deliveryId": append.delivery_id,
                    "updateDigest": append.update_digest,
                    "pendingBytes": append.pending_bytes,
                    "state": append.state.as_str()
                }
            }));
        }
        // The record and the first-seed flag transition run in a spawned
        // task: if the seed commits but a deadline/cancel drops this future
        // before the post-await assignment, the session would keep
        // `first_update_pending` and send its next distinct edit with
        // `require_empty_lineage = true` — a spurious
        // seed-onto-existing-lineage quarantine for a healthy session. The
        // spawned task runs to completion regardless of this future.
        let outcome = {
            let sessions = Arc::clone(&self.sessions);
            let session_id = params.session_id.clone();
            let actor = open.actor.clone();
            let now = now_ms()?;
            let token = cancellation.token();
            let settle_open = Arc::clone(&open);
            let settle_writes = Arc::new(self.self_writes.scoped(&open.root));
            let settle_events = self.events.clone();
            let record_task = tokio::spawn(async move {
                let _serial = serial;
                let outcome = actor
                    .ydoc_record_update(
                        session.key,
                        session.path,
                        session.content_kind,
                        session.regime,
                        update,
                        params.actor_origin_id,
                        params.attribution,
                        session.lineage_claim_id,
                        require_empty,
                        seed_source,
                        idempotency_key,
                        now,
                        Arc::new(NoFaults),
                        token,
                        session.restore_generation,
                    )
                    .await;
                if let Ok(append) = &outcome
                    && let Some(session) = lock(&sessions).get_mut(&session_id)
                {
                    session.first_update_pending = false;
                    session.lineage_claim_id = append.lineage_claim_id.clone();
                }
                let queue_settlement = outcome
                    .as_ref()
                    .is_ok_and(|append| append.settlement_requested)
                    && lock(&sessions)
                        .get_mut(&session_id)
                        .is_some_and(|session| session.author_settlement.try_queue(Instant::now()));
                if queue_settlement {
                    tokio::spawn(async move {
                        let _serial = settle_open.session_ops.lock().await;
                        let pending = lock(&sessions).get(&session_id).map(|session| {
                            (
                                session.key.clone(),
                                session.path.clone(),
                                session.content_kind,
                                session.lineage_claim_id.clone(),
                                session.open_head_sha.clone(),
                                session.restore_generation,
                            )
                        });
                        let Some((key, path, kind, lineage, head, restore)) = pending else {
                            return;
                        };
                        let settle_now = match now_ms() {
                            Ok(now) => now,
                            Err(error) => {
                                eprintln!(
                                    "engine: queued author coverage settlement clock failed: {error}"
                                );
                                if let Some(session) = lock(&sessions).get_mut(&session_id) {
                                    session.author_settlement.finish(true, Instant::now());
                                }
                                return;
                            }
                        };
                        let failed = match settle_open
                            .actor
                            .ydoc_settle_queued(
                                settle_open.root.clone(),
                                key,
                                path,
                                kind,
                                lineage,
                                head,
                                session_id.clone(),
                                settle_writes,
                                settle_now,
                                Arc::new(NoFaults),
                                CancellationToken::new(),
                                restore,
                            )
                            .await
                        {
                            Ok(dohc_engine_runtime::YdocSettleOutcome::Settled(settled)) => {
                                if settled.collection_reconcile_required {
                                    settle_open.request_collection_reconcile();
                                }
                                if let Some(session) = lock(&sessions).get_mut(&session_id) {
                                    session.last_settled_sha = Some(settled.sha256.clone());
                                }
                                false
                            }
                            Ok(dohc_engine_runtime::YdocSettleOutcome::RemoteUpdatesPending {
                                record_facts,
                            }) => {
                                for facts in &record_facts {
                                    emit_record_events(
                                        &settle_events,
                                        &settle_open.workspace_id,
                                        facts,
                                    );
                                }
                                true
                            }
                            Err(error) => {
                                eprintln!(
                                    "engine: queued author coverage settlement failed: {error}"
                                );
                                true
                            }
                        };
                        if let Some(session) = lock(&sessions).get_mut(&session_id) {
                            session.author_settlement.finish(failed, Instant::now());
                        }
                    });
                }
                outcome
            });
            record_task
                .await
                .map_err(|_| WireError::new(ErrorCode::Internal, "ydoc record task failed"))?
                .map_err(|error| {
                    if matches!(
                        error,
                        RuntimeError::Collab(CollabError::SeedOntoExistingLineage)
                    ) {
                        WireError::new(ErrorCode::InvalidParams, "seed-onto-existing-lineage")
                    } else {
                        map_runtime(error)
                    }
                })?
        };
        // A lineage that could have started sharing and did not is the one
        // origination outcome a person can act on, so it does not pass in
        // silence. The wire result reports the append; stderr keeps the
        // server-side trail, the same split the post-commit materialize path
        // uses. The per-document sharing surface that will show this to the
        // user arrives with #356 — until a workspace can replicate at all,
        // there is nothing for it to sit beside.
        if let Some(declined) = &outcome.sharing_declined {
            eprintln!("engine: {declined}");
        }
        let lineage_claim_id = outcome.lineage_claim_id;
        let automation_claims = outcome.automation_claims;
        let outcome = outcome.outcome;
        // Post-commit: the append transaction already holds the history rows
        // these facts mirror — and the automation claims it inserted
        // (pending, or failed `chain-stopped` at the depth cap).
        if let Some(facts) = &outcome.record_facts {
            emit_record_events(&self.events, &open.workspace_id, facts);
        }
        emit_automation_claimed(&self.events, &open.workspace_id, &automation_claims);
        serde_json::to_value(YdocRecordUpdateResult {
            seq: outcome.seq,
            deduped: outcome.deduped,
            lineage_claim_id,
        })
        .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))
    }

    pub(super) async fn ydoc_settle(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocSettleParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.settle (queued)"));
            }
            serial = open.session_ops.lock() => serial,
        };
        self.ydoc_settle_inner(
            &cancellation,
            handle.as_ref(),
            &params.session_id,
            params.summary.as_deref(),
        )
        .await
    }

    async fn ydoc_settle_inner(
        &self,
        cancellation: &OperationCancellation,
        handle: Option<&WorkspaceHandle>,
        session_id: &str,
        _summary: Option<&str>,
    ) -> Result<Value, WireError> {
        let (open, session) = self.ydoc_session(handle, session_id)?;
        let settled = open
            .actor
            .ydoc_settle(
                open.root.clone(),
                session.key,
                session.path.clone(),
                session.content_kind,
                session.lineage_claim_id.clone(),
                session.open_head_sha.clone(),
                session_id.to_owned(),
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
                Arc::new(NoFaults),
                cancellation.token(),
                session.restore_generation,
            )
            .await
            .map_err(map_runtime)?;
        let settled = match settled {
            dohc_engine_runtime::YdocSettleOutcome::Settled(settlement) => *settlement,
            // A distinct wire message the client acts on: remote edits
            // drained under this session's lease mean the client's doc is
            // behind — it must resync (which returns the full drained
            // state) and settle again. The drained updates' record facts
            // ride the refusal and fire here, post-commit.
            dohc_engine_runtime::YdocSettleOutcome::RemoteUpdatesPending { record_facts } => {
                for facts in &record_facts {
                    emit_record_events(&self.events, &open.workspace_id, facts);
                }
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "ydoc-remote-updates-pending",
                ));
            }
        };
        if settled.collection_reconcile_required {
            open.request_collection_reconcile();
        }
        if let Some(session) = lock(&self.sessions).get_mut(session_id) {
            session.last_settled_sha = Some(settled.sha256.clone());
        }
        serde_json::to_value(YdocSettleResult {
            moment_id: settled.moment_id,
            path: settled.path,
            content: settled.content,
            sha256: settled.sha256,
            materialized: settled.materialized,
            projection: YdocProjectionProvenance {
                content_kind: ydoc_content_kind_name(settled.projection.content_kind),
                source_state_vector_sha256: settled.projection.source_state_vector_sha256,
                destructive: settled.projection.destructive,
            },
        })
        .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))
    }

    pub(super) async fn ydoc_close(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocCloseParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let open = self.open(handle.as_ref())?;
        let serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.close (queued)"));
            }
            serial = Arc::clone(&open.session_ops).lock_owned() => serial,
        };
        self.ydoc_close_inner(&cancellation, handle.as_ref(), params, serial)
            .await
    }

    /// Keep session serialization through close, including a refused close's reinsert.
    async fn ydoc_close_inner(
        &self,
        cancellation: &OperationCancellation,
        handle: Option<&WorkspaceHandle>,
        params: YdocCloseParams,
        serial: tokio::sync::OwnedMutexGuard<()>,
    ) -> Result<Value, WireError> {
        // Missing `settle` means settle — the TS driver treats close() as
        // settle-unless-explicitly-false, and defaulting to false here would
        // fail dirty local-only closes (UnsettledClose) and let a replicated
        // close compact while the artifact projection is stale.
        let default_settle = {
            let (_open, session) = self.ydoc_session(handle, &params.session_id)?;
            // An untouched absent-lineage session (opened, never seeded) has
            // nothing to settle: defaulting to settle there would refuse
            // NoMarker and strand the session/lease.
            !(session.lineage_absent && session.first_update_pending)
        };
        if params.settle.unwrap_or(default_settle) {
            let settled = self
                .ydoc_settle_inner(
                    cancellation,
                    handle,
                    &params.session_id,
                    params.summary.as_deref(),
                )
                .await;
            match settled {
                Ok(_) => {}
                // The refusal fires after the deferred rows drained: for the
                // explicit settle RPC the client must resync (it keeps
                // editing), but a close is final — the session ends, so the
                // converged doc (local + drained remote) IS the artifact.
                // Retry once; the drain has emptied the queue, so the second
                // settle projects the merged state. Without this, a routine
                // close refuses and strands the session/lease until the
                // caller manually resyncs or closes the workspace.
                Err(error) if error.message == "ydoc-remote-updates-pending" => {
                    self.ydoc_settle_inner(
                        cancellation,
                        handle,
                        &params.session_id,
                        params.summary.as_deref(),
                    )
                    .await?;
                }
                Err(error) => return Err(error),
            }
        }
        let (open, session) = self.ydoc_session(handle, &params.session_id)?;
        // The close command carries a fresh token: once the settle above has
        // materialized, honoring a caller cancel here would leave the
        // session/lease held, and the retried close would re-settle over the
        // already-settled content (the fingerprint's previous-moment input
        // changed) — duplicate moments for one close.
        //
        // The session entry (and with it the lease guard) is taken before
        // the await: if a deadline drops this future while the actor still
        // compacts/prunes, dropping the entry releases the lease — the doc
        // can't stay ydoc-session-busy forever. A close refusal (e.g.
        // UnsettledClose on a dirty prune-close) reinserts the entry.
        //
        // The take→close→reinsert sequence runs in a spawned task, not this
        // RPC future: the protocol supervisor can drop this future on a
        // caller cancel/deadline, and a drop between the take and the
        // actor's refusal would skip the reinsert — the session and lease
        // would vanish over a still-dirty lineage with the refusal never
        // observable. A spawned task runs to completion regardless of what
        // happens to this future (dropping a JoinHandle does not cancel).
        let now = now_ms()?;
        let sessions = Arc::clone(&self.sessions);
        let actor = open.actor.clone();
        let session_id = params.session_id.clone();
        let session_key = session.key.clone();
        let close_root = open.root.clone();
        let close_self_writes = Arc::new(self.self_writes.scoped(&open.root));
        let taken = lock(&self.sessions).remove(&params.session_id);
        let close_events = self.events.clone();
        let close_workspace_id = open.workspace_id.clone();
        let close_task = tokio::spawn(async move {
            let _serial = serial;
            let close_result = actor
                .ydoc_close_session_materialized(
                    close_root,
                    session_key,
                    close_self_writes,
                    now,
                    Arc::new(NoFaults),
                    CancellationToken::new(),
                )
                .await;
            // Post-commit, inside the spawned task — it runs to completion
            // even when the RPC future is dropped, and the close's drain
            // committed these history rows.
            if let Ok(closed) = &close_result {
                for facts in &closed.record_facts {
                    emit_record_events(&close_events, &close_workspace_id, facts);
                }
            }
            // Reinsert only on a genuine close refusal (UnsettledClose and
            // friends) — an ActorUnavailable/WorkerPanicked error means the
            // workspace was torn down while this task ran, and resurrecting
            // the entry would keep its embedded lease alive past the
            // eviction, leaving the doc ydoc-session-busy for the next
            // workspace open.
            if matches!(
                close_result,
                Err(RuntimeError::Collab(_)) | Err(RuntimeError::Domain(_))
            ) && let Some(entry) = taken
            {
                lock(&sessions).insert(session_id, entry);
            }
            close_result
        });
        let close_result = close_task
            .await
            .map_err(|_| WireError::new(ErrorCode::Internal, "ydoc close task failed"))?;
        if let Err(error) = close_result {
            return Err(map_runtime(error));
        }
        serde_json::to_value(YdocCloseResult { closed: true })
            .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))
    }

    /// End one session without settling and without pruning: the entry — and
    /// with it the lease — is dropped, and the durable lineage is left exactly
    /// as it stands. This is the per-session form of what `workspace.close`
    /// does to every session, and it is the only exit for a session that can
    /// neither settle (nothing may write this artifact) nor prune (the guard
    /// refuses while no artifact holds the CRDT's bytes). Nothing is discarded,
    /// so the next open resurrects the lineage with its edits.
    pub(super) async fn ydoc_evict(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: YdocEvictParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.evict (queued)"));
            }
            serial = open.session_ops.lock() => serial,
        };
        // Refuse an unknown id for the same reason `ydoc.close` does: a caller
        // holding a session the daemon does not have must learn that, not read
        // a success. The removal below is the whole operation — no await, no
        // actor round trip — so no cancellation can land between the two.
        self.ydoc_session(handle.as_ref(), &params.session_id)?;
        lock(&self.sessions).remove(&params.session_id);
        serde_json::to_value(YdocEvictResult { evicted: true })
            .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))
    }

    pub(super) async fn ydoc_resync(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, BlobEgress), WireError> {
        let params: YdocResyncParams = parse(params)?;
        let cancellation = OperationCancellation::new(ctx);
        let open = self.open(handle.as_ref())?;
        let _serial = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => {
                return Err(cancellation.interruption("ydoc.resync (queued)"));
            }
            serial = open.session_ops.lock() => serial,
        };
        let (open, session) = self.ydoc_session(handle.as_ref(), &params.session_id)?;
        let (draft, _draft_reservation) = self
            .ydoc_editor_draft(&open, &session.key, &cancellation)
            .await?;
        if draft.as_ref().is_some_and(|draft| {
            draft.descriptor.binding.current_path != session.path
                || session.restore_generation.is_some()
                || session.owner_draft.as_ref().is_some_and(|previous| {
                    previous.binding != draft.descriptor.binding
                        || previous.relay_database_namespace
                            != draft.descriptor.relay_database_namespace
                })
        }) {
            return Err(map_owner_outbox(
                dohc_engine_collab::OwnerOutboxError::ParentMismatch,
            ));
        }
        let (state, owner_draft) = match draft {
            Some(draft) => (
                dohc_engine_runtime::actor::YdocResyncState {
                    initial_update: draft.initial_update,
                    lineage_claim_id: Some(draft.descriptor.binding.lineage_claim_id.clone()),
                    lineage_originated_here: false,
                    recovered_paths: Vec::new(),
                    artifact_assets: Vec::new(),
                },
                Some(draft.descriptor),
            ),
            None if session.owner_draft.is_some() => {
                return Err(map_owner_outbox(
                    dohc_engine_collab::OwnerOutboxError::Frozen,
                ));
            }
            None => (
                open.actor
                    .ydoc_resync(
                        session.key,
                        session.lineage_claim_id,
                        cancellation.token(),
                        session.restore_generation,
                    )
                    .await
                    .map_err(map_runtime)?,
                None,
            ),
        };
        if let Some(session) = lock(&self.sessions).get_mut(&params.session_id) {
            session.lineage_claim_id = state.lineage_claim_id.clone();
            session.owner_draft = owner_draft.clone();
        }
        let initial_update = state.initial_update;
        let byte_permit = self
            .blob_egress_budget
            .reserve(
                i64::try_from(initial_update.len())
                    .map_err(|_| WireError::new(ErrorCode::Internal, "state-corrupt"))?,
                &cancellation,
                "ydoc.resync",
            )
            .await?;
        let initial_update_sha256 = dohc_engine_storage::hex_sha256(&initial_update);
        let result = serde_json::to_value(YdocResyncResult {
            owner_draft,
            lineage_claim_id: state.lineage_claim_id,
            lineage_originated_here: state.lineage_originated_here,
            recovered_paths: state.recovered_paths,
            artifact_assets: state
                .artifact_assets
                .into_iter()
                .map(|asset| ArtifactAssetDescriptorResult {
                    id: asset.id,
                    mime_type: asset.mime_type,
                    created: asset.created,
                    r#ref: asset.path,
                    sha256: asset.sha256,
                    last_retrieved: asset.last_retrieved,
                    version: asset.version,
                })
                .collect(),
        })
        .map_err(|_| WireError::new(ErrorCode::Internal, "response encode failed"))?;
        Ok((
            result,
            BlobEgress {
                stream_id: request_id,
                sha256: initial_update_sha256,
                bytes: initial_update,
                cancel: ctx.cancel.clone(),
                deadline: ctx.deadline,
                byte_permit: Some(byte_permit),
            },
        ))
    }

    pub(super) fn ydoc_session(
        &self,
        handle: Option<&WorkspaceHandle>,
        session_id: &str,
    ) -> Result<(Arc<OpenWorkspace>, YdocSessionView), WireError> {
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.open(Some(handle))?;
        let sessions = lock(&self.sessions);
        let session = sessions
            .get(session_id)
            .filter(|session| &session.workspace == handle)
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "ydoc-session-not-found"))?;
        Ok((
            open,
            YdocSessionView {
                owner_draft: session.owner_draft.clone(),
                key: session.key.clone(),
                path: session.path.clone(),
                content_kind: session.content_kind,
                regime: session.regime,
                lineage_claim_id: session.lineage_claim_id.clone(),
                restore_generation: session.restore_generation,
                lineage_absent: session.lineage_absent,
                first_update_pending: session.first_update_pending,
                last_settled_sha: session.last_settled_sha.clone(),
                open_head_sha: session.open_head_sha.clone(),
                owner_seed_source: session.owner_seed_source.clone(),
            },
        ))
    }

    /// Observe the actor-local writer cache without adding a product RPC.
    #[cfg(feature = "harness")]
    #[doc(hidden)]
    pub async fn ydoc_cache_stats_for_harness(
        &self,
        handle: &WorkspaceHandle,
    ) -> Result<dohc_engine_collab::CacheStats, RuntimeError> {
        let open = lock(&self.handles)
            .get(handle)
            .cloned()
            .ok_or(RuntimeError::ActorUnavailable)?;
        open.actor.ydoc_cache_stats_for_test().await
    }

    /// Evict every actor-local document so the next consumer proves its cold
    /// fallback on the same durable state.
    #[cfg(feature = "harness")]
    #[doc(hidden)]
    pub async fn ydoc_cache_clear_for_harness(
        &self,
        handle: &WorkspaceHandle,
    ) -> Result<dohc_engine_collab::CacheStats, RuntimeError> {
        let open = lock(&self.handles)
            .get(handle)
            .cloned()
            .ok_or(RuntimeError::ActorUnavailable)?;
        open.actor.ydoc_cache_clear_for_test().await
    }
}

#[cfg(test)]
#[path = "owner_draft_editor_tests.rs"]
mod owner_draft_editor_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::EngineService;
    use crate::rpc::error::map_owner_outbox;
    use crate::rpc::request::OperationCancellation;
    use dohc_engine_collab::DocKey;
    use dohc_engine_collab::LeaseRegistry;
    use dohc_engine_collab::OwnerOutboxError;
    use dohc_engine_protocol::error::ErrorCode;
    use dohc_engine_protocol::error::WireError;
    use dohc_engine_protocol::transport::RequestContext;
    use dohc_engine_protocol::wire::Response;
    use dohc_engine_protocol::wire::WorkspaceHandle;
    use dohc_engine_runtime::RuntimeError;
    use dohc_engine_runtime::WorkspaceSupervisor;
    use dohc_engine_runtime::actor::YdocSeedMaterialization;
    use dohc_engine_testkit::ScratchDir;
    use serde_json::Value;
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn failed_author_settlement_waits_before_retrying() {
        let mut queue = AuthorSettlementQueue::default();
        let now = Instant::now();
        assert!(queue.try_queue(now));
        assert!(
            !queue.try_queue(now),
            "overlapping attempts stay suppressed"
        );
        queue.finish(true, now);
        for offset in [
            Duration::ZERO,
            Duration::from_millis(1),
            Duration::from_secs(4),
        ] {
            assert!(
                !queue.try_queue(now + offset),
                "later appends respect backoff"
            );
        }
        assert!(queue.try_queue(now + AUTHOR_SETTLEMENT_RETRY_DELAY));
        queue.finish(false, now + AUTHOR_SETTLEMENT_RETRY_DELAY);
        assert!(
            queue.try_queue(now + AUTHOR_SETTLEMENT_RETRY_DELAY),
            "success clears backoff"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_close_retains_serialization_until_refused_session_is_reinserted() {
        use dohc_engine_storage::{FaultAction, FaultInjector, FaultPoint};
        struct Pause {
            started: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
            release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
        }
        impl FaultInjector for Pause {
            fn poll(&self, point: FaultPoint) -> FaultAction {
                if point == FaultPoint::StorageBeforePersist
                    && let Some(started) = self.started.lock().unwrap().take()
                {
                    started.send(()).unwrap();
                    self.release
                        .lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(10))
                        .unwrap();
                }
                FaultAction::Continue
            }
        }
        let scratch = ScratchDir::new().unwrap();
        std::fs::write(scratch.path().join("note.md"), "before").unwrap();
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let opened = service.workspace_open(&RequestContext::unbounded(), json!({
            "rootDir":scratch.path().to_string_lossy(),"workspaceId":"close-cancel","captureMode":"none"
        })).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let open = service.open(Some(&handle)).unwrap();
        let capture = |path: &str| dohc_engine_runtime::CaptureIngest {
            workspace_id: "close-cancel".into(),
            version_id: "main".into(),
            path: path.into(),
            text: "before".into(),
            metadata_origin: "capture".into(),
            metadata_summary: None,
            metadata_correlation_id: None,
            author_json: None,
            now_ms: 1,
            request_id: Some(path.into()),
            claim_foreign_head: true,
        };
        open.actor
            .capture_ingest(
                capture("note.md"),
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let (session, egress) = service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"versionId":"main","path":"note.md","contentKind":"plaintext"}),
                1,
            )
            .await
            .unwrap();
        drop(egress);
        let id = session["sessionId"].as_str().unwrap().to_owned();
        let doc = dohc_engine_collab::Ydoc::wire();
        let seed = doc.plaintext_insert(0, "before");
        let edit = doc.plaintext_insert(6, " dirty");
        for (seed_flag, bytes, request) in [(true, seed, "seed"), (false, edit, "edit")] {
            service.ydoc_record_update(&RequestContext::unbounded(),Some(handle.clone()),Some(request.into()),json!({
                "sessionId":id,"updateBase64":base64::engine::general_purpose::STANDARD.encode(bytes),"seed":seed_flag
            })).await.unwrap();
        }
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let actor = open.actor.clone();
        let blocking_capture = capture("block.md");
        let blocker = tokio::spawn(async move {
            actor
                .capture_ingest(
                    blocking_capture,
                    LeaseRegistry::new(),
                    Arc::new(Pause {
                        started: std::sync::Mutex::new(Some(started_tx)),
                        release: std::sync::Mutex::new(release_rx),
                    }),
                    CancellationToken::new(),
                )
                .await
        });
        started_rx.await.unwrap();
        let caller_service = Arc::clone(&service);
        let caller_handle = handle.clone();
        let caller_id = id.clone();
        let caller = tokio::spawn(async move {
            caller_service
                .ydoc_close(
                    &RequestContext::unbounded(),
                    Some(caller_handle),
                    json!({"sessionId":caller_id,"settle":false}),
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(5), async {
            while lock(&service.sessions).contains_key(&id) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert!(
            open.session_ops.try_lock().is_err(),
            "a cancelled caller must not release the detached close's serialization"
        );
        release_tx.send(()).unwrap();
        blocker.await.unwrap().unwrap();
        let serial = tokio::time::timeout(
            Duration::from_secs(5),
            Arc::clone(&open.session_ops).lock_owned(),
        )
        .await
        .unwrap();
        assert!(
            lock(&service.sessions).contains_key(&id),
            "the dirty session is restored before the serial is released"
        );
        drop(serial);
        service
            .ydoc_evict(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"sessionId":id}),
            )
            .await
            .unwrap();
        service.workspace_close(Some(handle)).await.unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn captured_owner_seed_retains_exact_original_source_moment() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../dohc-engine-collab/tests/owner-source/owner-source-seed.json"
        ))
        .unwrap();
        let markdown = vector["markdown"].as_str().unwrap().to_owned();
        let bytes: Vec<u8> = serde_json::from_value(vector["bytes"].clone()).unwrap();
        let scratch = ScratchDir::new().unwrap();
        std::fs::create_dir(scratch.path().join("notes")).unwrap();
        std::fs::write(scratch.path().join("notes/owner.md"), &markdown).unwrap();
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service.workspace_open(&RequestContext::unbounded(), json!({
            "rootDir":scratch.path().to_string_lossy(),"workspaceId":"owner-source","captureMode":"none"
        })).await.unwrap();
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let actor = service.open(Some(&handle)).unwrap().actor.clone();
        let captured = actor
            .capture_ingest(
                dohc_engine_runtime::CaptureIngest {
                    workspace_id: "owner-source".into(),
                    version_id: "main".into(),
                    path: "notes/owner.md".into(),
                    text: markdown.clone(),
                    metadata_origin: "capture".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 1,
                    request_id: Some("owner-source-capture".into()),
                    claim_foreign_head: true,
                },
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let source_moment = captured.snapshot.latest_moment_id.clone();
        let object_id = captured.snapshot.object_id.clone();
        service.workspace_close(Some(handle)).await.unwrap();
        drop(actor);
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        {
            let mut store = dohc_engine_storage::EngineStore::open(&db_path, 2).unwrap();
            store.write_with(&NoFaults,|tx| {
                tx.execute("INSERT INTO sync_identity (workspace_id,origin_id,replication_epoch,stream_identity,created_at_ms) VALUES ('owner-source','origin','epoch','stream',1)",[]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                tx.execute("INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) VALUES ('owner-source','origin',0)",[]).map_err(dohc_engine_storage::StorageError::persist_public)?;
                Ok::<_,dohc_engine_storage::StorageError>(())
            }).unwrap();
        }
        let reopened_workspace = service.workspace_open(&RequestContext::unbounded(), json!({
            "rootDir":scratch.path().to_string_lossy(),"workspaceId":"owner-source","captureMode":"none"
        })).await.unwrap();
        let mut handle: WorkspaceHandle =
            serde_json::from_value(reopened_workspace["workspace"].clone()).unwrap();
        let (mut session, egress) = service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"versionId":"main","path":"notes/owner.md","contentKind":"richdoc"}),
                1,
            )
            .await
            .unwrap();
        drop(egress);
        assert_eq!(session["seedContent"], markdown);
        service.ydoc_record_update(&RequestContext::unbounded(),Some(handle.clone()),Some("owner-source-seed".into()),json!({
            "sessionId":session["sessionId"],"updateBase64":base64::engine::general_purpose::STANDARD.encode(&bytes),"seed":true
        })).await.unwrap();
        let (baseline, lineage, sequence) = {
            let db = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            db.query_row("SELECT b.bytes,d.lineage_claim_id,d.head_update_seq FROM ydoc_docs d JOIN ydoc_snapshots s USING(workspace_id,version_id,object_id) JOIN binary_blobs b ON b.sha256=s.snapshot_blob_sha256 WHERE d.object_id=?1 AND s.up_to_seq=0",[&object_id],|r|Ok((r.get::<_,Vec<u8>>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).unwrap()
        };
        let connection = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(connection.handle());
        service
            .provision_live_application(
                connection.handle(),
                crate::rpc::live_application::LiveApplicationHostConfig {
                    workspace: handle.clone(),
                    namespace: "owner-source-relay".into(),
                    coordinate:
                        dohc_engine_collab::live_update_application::ApplicationHostCoordinate {
                            host_id: "host".into(),
                            host_epoch: 1,
                            instance_id: "instance".into(),
                            connection_id: "connection".into(),
                        },
                    max_registrations: 1,
                },
            )
            .await
            .unwrap();
        let binding = dohc_engine_collab::LiveObjectBinding {
            workspace_id: "owner-source".into(),
            main_version_id: "main".into(),
            object_id: object_id.clone(),
            lineage_claim_id: lineage,
            current_path: "notes/owner.md".into(),
            selector_paths: vec!["notes/owner.md".into()],
            restore_fence_generation: 0,
        };
        let registration = service
            .live_application_register(&ctx, Some(handle.clone()), json!({"binding":binding}))
            .await
            .unwrap();
        let cut = dohc_engine_collab::live_update_application::OwnerAdoptionCut {
            relay_database_namespace: "owner-source-relay".into(),
            adoption_id: "actual-owner".into(),
            outbox_limits: dohc_engine_collab::OwnerOutboxLimits {
                max_pending_bytes: 10,
                max_pending_age_ms: 100_000,
            },
            source_moment_id: source_moment.clone(),
            source_digest: dohc_engine_storage::hex_sha256(markdown.as_bytes()),
            source_byte_length: markdown.len() as i64,
            baseline_moment_relay_sequence: 1,
            baseline_registered_at_ms: 3,
            baseline_bytes: baseline,
            expected_local_sequence: sequence,
            events: vec![],
            terminal_receipt: None,
        };
        for replay in [false, true] {
            let mut ctx = RequestContext::unbounded();
            ctx.connection = Some(connection.handle());
            let adopted = service
                .adopt_live_application_owner(
                    ctx,
                    7,
                    handle.clone(),
                    registration["registrationId"].as_u64().unwrap(),
                    session["sessionId"].as_str().unwrap().into(),
                    cut.clone(),
                    1_000_000,
                    100,
                    Arc::new(()),
                )
                .await
                .unwrap();
            assert_eq!(
                adopted.response.result["adoption"]["adoptionReplayed"],
                replay
            );
            assert_eq!(
                adopted.response.result["adoption"]["localYDocSequence"],
                sequence
            );
            assert!(adopted.output_guard.unwrap().is_current());
        }
        session = assert_adopted_owner_move_refused(
            &service,
            &mut handle,
            session,
            scratch.path(),
            &db_path,
        )
        .await;
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("notes/owner.md")).unwrap(),
            markdown
        );
        let edited = dohc_engine_collab::Ydoc::wire();
        edited.apply(&cut.baseline_bytes).unwrap();
        edited
            .rewrite_content_to_markdown(ContentKind::Richdoc, "Later canonical edit")
            .unwrap();
        let queued_bytes = edited.encode_full_state();
        let edit_params = json!({
            "sessionId":session["sessionId"],"updateBase64":base64::engine::general_purpose::STANDARD.encode(&queued_bytes)
        });
        for _ in 0..2 {
            service
                .ydoc_record_update(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    Some("after-adoption".into()),
                    edit_params.clone(),
                )
                .await
                .unwrap();
        }
        session = assert_adopted_owner_move_refused(
            &service,
            &mut handle,
            session,
            scratch.path(),
            &db_path,
        )
        .await;
        edited
            .rewrite_content_to_markdown(ContentKind::Richdoc, "Must not commit without delivery")
            .unwrap();
        let refused_bytes = edited.encode_full_state();
        let refusal = service.ydoc_record_update(&RequestContext::unbounded(),Some(handle.clone()),Some("after-seal".into()),json!({
            "sessionId":session["sessionId"],"updateBase64":base64::engine::general_purpose::STANDARD.encode(&refused_bytes)
        })).await.unwrap_err();
        assert_eq!(refusal.message, "owner-outbox-frozen");
        let refused_settlement = service
            .ydoc_settle(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"sessionId":session["sessionId"]}),
            )
            .await
            .unwrap_err();
        assert_eq!(refused_settlement.message, "owner-outbox-frozen");
        assert_eq!(
            std::fs::read_to_string(scratch.path().join("notes/owner.md")).unwrap(),
            markdown
        );
        service.workspace_close(Some(handle)).await.unwrap();
        {
            let store = dohc_engine_storage::EngineStore::open(&db_path, 3).unwrap();
            let row:(String,String,String,i64,i64) = store.read_with(|conn|conn.query_row(
                "SELECT b.source_moment_id,b.source_blob_sha256,b.lineage_claim_id,d.head_update_seq,(SELECT COUNT(*) FROM moments WHERE workspace_id='owner-source') FROM ydoc_owner_base_sources b JOIN ydoc_docs d USING(workspace_id,version_id,object_id) WHERE b.object_id=?1",
                [&object_id],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))
            )).unwrap();
            assert_eq!(row.0, source_moment);
            assert_eq!(row.1, dohc_engine_storage::hex_sha256(markdown.as_bytes()));
            assert_eq!(row.3, 2);
            assert_eq!(
                row.4, 1,
                "refused settlements and moves preserve the original source moment"
            );
            let original: String = store.read_with(|conn|conn.query_row("SELECT snapshot_blob_sha256 FROM ydoc_snapshots WHERE object_id=?1 AND up_to_seq=0",[&object_id],|r|r.get(0))).unwrap();
            assert_eq!(row.2, original);
            assert_eq!(store.table_row_count("live_owner_adoptions").unwrap(), 1);
            assert_eq!(
                store.table_row_count("owner_ydoc_outbox_entries").unwrap(),
                1,
                "request replay creates no duplicate delivery"
            );
            let queued: (String,i64,Vec<u8>) = store.read_with(|conn|conn.query_row(
                "SELECT o.state,o.pending_bytes,b.bytes FROM owner_ydoc_outboxes o JOIN owner_ydoc_outbox_entries e USING(outbox_id) JOIN binary_blobs b ON b.sha256=e.update_blob_digest",
                [],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))).unwrap();
            assert_eq!(
                queued,
                ("sealed".into(), queued_bytes.len() as i64, queued_bytes)
            );
            let refused_blob: bool = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT EXISTS(SELECT 1 FROM binary_blobs WHERE sha256=?1)",
                        [dohc_engine_storage::hex_sha256(&refused_bytes)],
                        |r| r.get(0),
                    )
                })
                .unwrap();
            assert!(
                !refused_blob,
                "outbox refusal rolls back the local append and blob"
            );
        }
        for (bytes, age) in [(9, 100_000), (10, 99_999), (10, 100_000), (20, 200_000)] {
            let config = serde_json::from_value(json!({
                "ingress":{"aggregateBytes":400_000_000,"applicationWorkingReserveBytes":1_000_000,"maxUploads":2,"uploadDeadlineMs":30_000},
                "maxRegistrations":8,"maxAdoptionBytes":1_000_000,"maxAdoptionEvents":100,"maxApplicationsPerSettlement":100,
                "ownerOutbox":{"maxPendingBytes":bytes,"maxPendingAgeMs":age}
            })).unwrap();
            let (restarted, _owner, _ingress) = EngineService::ordinary_live_host(config).unwrap();
            let params = json!({"rootDir":scratch.path().to_string_lossy(),"workspaceId":"owner-source","captureMode":"none"});
            let opened = restarted
                .workspace_open(&RequestContext::unbounded(), params.clone())
                .await;
            if bytes < 10 || age < 100_000 {
                assert_eq!(
                    opened.unwrap_err().message,
                    "owner-outbox-configured-budget-mismatch"
                );
                assert!(crate::lock(&restarted.handles).is_empty());
                let mut read_params = params;
                read_params["skipStartupMaintenance"] = json!(true);
                let opened = restarted
                    .workspace_open(&RequestContext::unbounded(), read_params)
                    .await
                    .unwrap();
                let handle: WorkspaceHandle =
                    serde_json::from_value(opened["workspace"].clone()).unwrap();
                assert!(matches!(
                    restarted.open(Some(&handle)).unwrap().mode,
                    super::super::workspace::WorkspaceOpenMode::ReadOnly
                ));
                restarted.workspace_close(Some(handle)).await.unwrap();
            } else {
                let handle: WorkspaceHandle =
                    serde_json::from_value(opened.unwrap()["workspace"].clone()).unwrap();
                restarted.workspace_close(Some(handle)).await.unwrap();
            }
            let store = dohc_engine_storage::EngineStore::open_read_only(&db_path).unwrap();
            let limits: (i64, i64) = store
                .read_with(|conn| {
                    conn.query_row(
                        "SELECT max_pending_bytes,max_pending_age_ms FROM live_owner_adoptions",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                })
                .unwrap();
            assert_eq!(limits, (10, 100_000));
        }
    }

    async fn assert_adopted_owner_move_refused(
        service: &EngineService,
        handle: &mut WorkspaceHandle,
        session: Value,
        root: &std::path::Path,
        db_path: &std::path::Path,
    ) -> Value {
        let refused_close = service
            .ydoc_close(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"sessionId":session["sessionId"],"settle":true}),
            )
            .await
            .unwrap_err();
        assert_eq!(refused_close.message, "owner-outbox-frozen");
        service
            .ydoc_evict(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"sessionId":session["sessionId"]}),
            )
            .await
            .unwrap();
        service.workspace_close(Some(handle.clone())).await.unwrap();
        let reopened = service.workspace_open(&RequestContext::unbounded(),json!({
            "rootDir":root.to_string_lossy(),"workspaceId":"owner-source","captureMode":"none"
        })).await.unwrap();
        *handle = serde_json::from_value(reopened["workspace"].clone()).unwrap();
        let snapshot = || {
            let db = rusqlite::Connection::open_with_flags(
                db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            db.query_row("SELECT (SELECT COUNT(*) FROM moments), (SELECT COUNT(*) FROM binary_blobs), (SELECT COUNT(*) FROM owner_ydoc_outbox_entries), (SELECT path FROM ydoc_docs LIMIT 1), (SELECT binding_json FROM live_owner_adoptions LIMIT 1)",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?))).unwrap()
        };
        let before = snapshot();
        for path in ["notes/owner.md", "notes", "note"] {
            let request = serde_json::from_value(
                json!({"id":90,"method":"versionedText.checkMove","workspace":handle,
                "params":{"versionId":"main","path":path}}),
            )
            .unwrap();
            let checked = service
                .versioned_text_check_move(
                    &RequestContext::unbounded(),
                    &request,
                    request.params.clone(),
                )
                .await;
            if path == "note" {
                assert!(checked.is_ok(), "a sibling prefix remains movable");
            } else {
                assert_eq!(checked.unwrap_err().message, "live-document-binding-active");
            }
        }
        let request = serde_json::from_value(json!({"id":91,"method":"versionedText.rename","workspace":handle,
            "params":{"versionId":"main","fromPath":"notes/owner.md","toPath":"moved.md","origin":"local-file"}})).unwrap();
        assert_eq!(
            service
                .versioned_text_rename(
                    &RequestContext::unbounded(),
                    &request,
                    request.params.clone()
                )
                .await
                .unwrap_err()
                .message,
            "live-document-binding-active"
        );
        assert_eq!(
            snapshot(),
            before,
            "native rename must roll back every mutation"
        );

        std::fs::rename(root.join("notes/owner.md"), root.join("moved.md")).unwrap();
        let actor = service.open(Some(handle)).unwrap().actor.clone();
        let retire = actor
            .capture_retire(
                dohc_engine_runtime::CaptureRetire {
                    workspace_id: "owner-source".into(),
                    version_id: "main".into(),
                    path: "notes/owner.md".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    now_ms: 10,
                    request_id: None,
                    only_if_text_head: true,
                    only_if_capture_origin: true,
                    allow_ydoc_origin: true,
                },
                LeaseRegistry::new(),
                Arc::new(NoFaults),
                CancellationToken::new(),
            )
            .await;
        assert_eq!(
            map_runtime(retire.unwrap_err()).message,
            "live-document-binding-active"
        );
        assert_eq!(
            snapshot(),
            before,
            "external moves retain the original lineage and pending delivery"
        );
        std::fs::rename(root.join("moved.md"), root.join("notes/owner.md")).unwrap();
        let (session, egress) = service
            .ydoc_open(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({"versionId":"main","path":"notes/owner.md","contentKind":"richdoc"}),
                92,
            )
            .await
            .unwrap();
        drop(egress);
        session
    }

    fn owner_outbox_append_params(workspace_id: &str, append_key: &str) -> Value {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../packages/live-session-contract/src/liveObjectBinding.vectors.json"
        ))
        .expect("shared LiveObjectBinding vectors");
        let mut binding = vectors["accepted"]
            .as_array()
            .expect("accepted binding vectors")
            .iter()
            .find(|row| row["name"] == "canonical-binding")
            .expect("canonical binding vector")["input"]
            .clone();
        binding["workspaceId"] = json!(workspace_id);
        json!({
            "binding": binding,
            "baseUpdateBase64": base64::engine::general_purpose::STANDARD.encode(b"base"),
            "appendKey": append_key,
            "updateBase64": base64::engine::general_purpose::STANDARD.encode(b"update"),
            "limits": {
                "maxPendingBytes": 1_000,
                "maxPendingAgeMs": 1_000
            }
        })
    }

    #[tokio::test]
    async fn owner_receipt_wire_bounds_precede_workspace_lookup() {
        async fn refusal(service: &EngineService, epoch: Value, cursor: Value) -> WireError {
            service
                .owner_ydoc_outbox_acknowledge(
                    &RequestContext::unbounded(),
                    None,
                    json!({
                        "outboxId": "missing-outbox",
                        "receipts": [{
                            "deliveryId": "delivery-1",
                            "updateDigest": "0".repeat(64),
                            "journalCursor": cursor,
                            "acceptingHostEpoch": epoch
                        }]
                    }),
                )
                .await
                .expect_err("missing workspace must refuse")
        }

        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);

        for (epoch, cursor) in [
            (json!("1"), json!(1)),
            (json!(1), json!("1")),
            (json!(1.5), json!(1)),
            (json!(1), json!(1.5)),
        ] {
            let error = refusal(&service, epoch, cursor).await;
            assert_eq!(error.code, ErrorCode::InvalidParams);
            assert_eq!(error.message, "invalid parameters");
        }

        for value in [1_i64, 9_007_199_254_740_991_i64] {
            let error = refusal(&service, json!(value), json!(value)).await;
            assert_eq!(error.code, ErrorCode::WorkspaceUnavailable, "{value}");
            assert_eq!(error.message, "workspace handle is unavailable", "{value}");
        }

        for value in [0_i64, -1_i64, 9_007_199_254_740_992_i64] {
            let epoch_error = refusal(&service, json!(value), json!(1)).await;
            assert_eq!(epoch_error.code, ErrorCode::InvalidParams, "epoch {value}");
            assert_eq!(
                epoch_error.message, "invalid-owner-outbox-receipt",
                "epoch {value}"
            );

            let cursor_error = refusal(&service, json!(1), json!(value)).await;
            assert_eq!(
                cursor_error.code,
                ErrorCode::InvalidParams,
                "cursor {value}"
            );
            assert_eq!(
                cursor_error.message, "invalid-owner-outbox-receipt",
                "cursor {value}"
            );
        }
    }

    #[test]
    fn owner_outbox_main_version_mismatch_has_a_distinct_wire_refusal() {
        let mapped = map_owner_outbox(OwnerOutboxError::MainVersionMismatch);
        assert_eq!(mapped.code, ErrorCode::InvalidParams);
        assert_eq!(mapped.message, "owner-outbox-main-version-mismatch");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn owner_outbox_main_version_mismatch_is_refused_over_the_wire() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let workspace_id = "owner-outbox-main-version-wire";
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                    "captureMode": "none"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("ensure durable main version");
        let mut params = owner_outbox_append_params(workspace_id, "main-version-mismatch");
        params["binding"]["mainVersionId"] = json!("other-main");

        let error = service
            .owner_ydoc_outbox_append(&RequestContext::unbounded(), Some(handle.clone()), params)
            .await
            .expect_err("mismatched main version");
        assert_eq!(error.code, ErrorCode::InvalidParams);
        assert_eq!(error.message, "owner-outbox-main-version-mismatch");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
    }

    async fn assert_scene_seed_interruption_retains_exclusion(
        ctx: RequestContext,
        expected_code: ErrorCode,
    ) {
        let signal = ctx.cancel.clone();
        let cancellation = OperationCancellation::new(&ctx);
        let session_ops = Arc::new(tokio::sync::Mutex::new(()));
        let serial = Arc::clone(&session_ops).lock_owned().await;
        let leases = LeaseRegistry::new();
        let key =
            DocKey::new("ws-seed-cancel", "main", "drawing-object").expect("valid document key");
        let lease = leases.acquire(&key).expect("initial lease");
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let waiting = tokio::spawn(async move {
            EngineService::complete_scene_seed_materialization(
                &cancellation,
                async move {
                    let _ = started_tx.send(());
                    release_rx.await.expect("release materialization");
                    Ok(YdocSeedMaterialization {
                        materialized: true,
                        incomplete_jobs: 0,
                        invalid_jobs: 0,
                    })
                },
                serial,
                lease,
            )
            .await
        });
        started_rx.await.expect("materialization started");
        if expected_code == ErrorCode::Cancelled {
            signal.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .expect("interrupted wait completed")
            .expect("completion task");
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("an interrupted wait must not return materialization"),
        };
        assert_eq!(error.code, expected_code);
        assert!(
            session_ops.try_lock().is_err(),
            "the session serial must stay held until actor completion"
        );
        assert!(
            leases.is_held(&key),
            "the document lease must stay held until actor completion"
        );

        release_tx.send(()).expect("release actor completion");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if session_ops.try_lock().is_ok() && !leases.is_held(&key) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("completion released serial and lease");
    }

    #[tokio::test]
    async fn scene_seed_cancellation_keeps_exclusion_until_actor_completion() {
        assert_scene_seed_interruption_retains_exclusion(
            RequestContext::unbounded(),
            ErrorCode::Cancelled,
        )
        .await;
    }

    #[tokio::test]
    async fn scene_seed_deadline_keeps_exclusion_until_actor_completion() {
        let mut ctx = RequestContext::unbounded();
        ctx.deadline = Some(std::time::Instant::now() + Duration::from_millis(100));
        assert_scene_seed_interruption_retains_exclusion(ctx, ErrorCode::DeadlineExceeded).await;
    }

    #[test]
    fn scene_seed_materialization_errors_report_exact_job_counts() {
        let invalid = scene_seed_materialization_error(YdocSeedMaterialization {
            materialized: false,
            incomplete_jobs: 3,
            invalid_jobs: 2,
        });
        assert_eq!(invalid.code, ErrorCode::Internal);
        assert_eq!(
            invalid.message,
            "ydoc-artifact-assets-invalid: invalid_jobs=2, incomplete_jobs=3"
        );

        let pending = scene_seed_materialization_error(YdocSeedMaterialization {
            materialized: false,
            incomplete_jobs: 4,
            invalid_jobs: 0,
        });
        assert_eq!(pending.code, ErrorCode::Overloaded);
        assert_eq!(
            pending.message,
            "ydoc-artifact-assets-pending: invalid_jobs=0, incomplete_jobs=4"
        );
    }

    #[test]
    fn ydoc_open_preserves_storage_and_crash_refusals() {
        let storage = map_ydoc_open_runtime(RuntimeError::Storage(
            dohc_engine_storage::StorageError::StateCorrupt { source: None },
        ));
        assert_eq!(storage.code, ErrorCode::Internal);
        assert_eq!(storage.message, "ydoc-open-storage-failed");

        let crashed = map_ydoc_open_runtime(RuntimeError::OperationCrashed);
        assert_eq!(crashed.code, ErrorCode::Internal);
        assert_eq!(crashed.message, "ydoc-open-operation-crashed");

        let busy = map_ydoc_open_runtime(RuntimeError::Storage(
            dohc_engine_storage::StorageError::FileLocked,
        ));
        assert_eq!(busy.code, ErrorCode::Overloaded);
        assert_eq!(busy.message, "engine-store-busy");
    }

    #[tokio::test]
    async fn owner_outbox_read_pages_fit_negotiated_frames_for_large_blobs_and_queues() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let workspace_id = "owner-outbox-paged-wire";
        let opened = service.workspace_open(&RequestContext::unbounded(), json!({
            "rootDir": scratch.path().to_string_lossy(), "workspaceId": workspace_id, "captureMode": "none",
        })).await.expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("handle");
        let result = async {
            service
                .versions_ensure_main(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    json!({ "workspaceId": workspace_id }),
                )
                .await?;
            let mut id = Value::Null;
            for index in 0..3 {
                let mut params = owner_outbox_append_params(workspace_id, &format!("page-{index}"));
                params["baseUpdateBase64"] =
                    json!(base64::engine::general_purpose::STANDARD.encode(vec![17; 1_200_000]));
                params["updateBase64"] = json!(
                    base64::engine::general_purpose::STANDARD.encode(vec![23 + index; 1_200_000])
                );
                params["limits"]["maxPendingBytes"] = json!(10_000_000);
                id = service
                    .owner_ydoc_outbox_append(
                        &RequestContext::unbounded(),
                        Some(handle.clone()),
                        params,
                    )
                    .await?["outboxId"]
                    .clone();
            }
            let ctx = RequestContext::unbounded().with_max_frame_bytes(1_048_576);
            let mut cursor = Value::Null;
            let mut pages = Vec::new();
            // Fixture-derived ceiling: four 1.2 MB blobs and four headers
            // need fewer than 32 pages at this negotiated frame size.
            for _ in 0..32 {
                let page = service
                    .owner_ydoc_outbox_read_pending(
                        &ctx,
                        Some(handle.clone()),
                        json!({ "outboxId": id, "cursor": cursor }),
                        dohc_engine_protocol::limits::MAX_WIRE_INTEGER,
                    )
                    .await?;
                cursor = page
                    .get("nextCursor")
                    .cloned()
                    .ok_or_else(|| WireError::new(ErrorCode::Internal, "missing-page-cursor"))?;
                pages.push(page);
                if cursor.is_null() {
                    return Ok::<_, WireError>(pages);
                }
            }
            Err(WireError::new(
                ErrorCode::Internal,
                "page-read-did-not-complete",
            ))
        }
        .await;
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
        let pages = result.expect("complete paged read");
        let mut total_wire_bytes = 0;
        let mut base_pages = 0;
        let mut update_pages = 0;
        for page in pages {
            if page["part"] == "base" {
                base_pages += 1;
            }
            if page["part"] == "update" {
                update_pages += 1;
            }
            let envelope = dohc_engine_protocol::wire::Envelope::Response(Response {
                id: dohc_engine_protocol::limits::MAX_WIRE_INTEGER,
                result: page,
            });
            let bytes = serde_json::to_vec(&envelope).expect("wire response");
            assert!(
                bytes.len() <= 1_048_576,
                "actual response envelope exceeds negotiated frame"
            );
            total_wire_bytes += bytes.len();
        }
        assert!(total_wire_bytes > 1_048_576);
        assert!(base_pages >= 2, "one base must span pages");
        assert!(update_pages >= 6, "each update must span pages");
    }

    #[tokio::test]
    async fn owner_outbox_queued_mutations_honor_embedded_cancellation_and_deadlines() {
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let workspace_id = "owner-outbox-cancelled-queue";
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": workspace_id,
                    "captureMode": "none"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("ensure durable main version");
        let open = service.open(Some(&handle)).expect("open workspace");
        let held = Arc::clone(&open.session_ops).lock_owned().await;
        let mut outcomes = Vec::new();
        for deadline in [false, true] {
            for method in ["append", "acknowledge", "quarantine"] {
                let mut ctx = RequestContext::unbounded();
                if deadline {
                    ctx.deadline = Some(std::time::Instant::now());
                }
                let pending = async {
                    match method {
                        "append" => {
                            service
                                .owner_ydoc_outbox_append(
                                    &ctx,
                                    Some(handle.clone()),
                                    owner_outbox_append_params(workspace_id, "cancelled-append"),
                                )
                                .await
                        }
                        "acknowledge" => {
                            service
                                .owner_ydoc_outbox_acknowledge(
                                    &ctx,
                                    Some(handle.clone()),
                                    json!({ "outboxId": "not-enqueued", "receipts": [{
                                        "deliveryId": "delivery-1", "updateDigest": "0".repeat(64),
                                        "journalCursor": 1, "acceptingHostEpoch": 1
                                    }] }),
                                )
                                .await
                        }
                        _ => {
                            service
                                .owner_ydoc_outbox_quarantine(
                                    &ctx,
                                    Some(handle.clone()),
                                    json!({ "outboxId": "not-enqueued", "reason": "test" }),
                                )
                                .await
                        }
                    }
                };
                tokio::pin!(pending);
                let was_pending = std::future::poll_fn(|cx| {
                    std::task::Poll::Ready(
                        std::future::Future::poll(pending.as_mut(), cx).is_pending(),
                    )
                })
                .await;
                if !deadline {
                    ctx.cancel.cancel();
                }
                let outcome = if was_pending {
                    Some(tokio::time::timeout(Duration::from_secs(10), pending).await)
                } else {
                    None
                };
                outcomes.push((method, deadline, outcome));
            }
        }
        let read_ctx = RequestContext::unbounded();
        read_ctx.cancel.cancel();
        let cancelled_read = service
            .owner_ydoc_outbox_read_pending(
                &read_ctx,
                Some(handle.clone()),
                json!({ "outboxId": "not-enqueued" }),
                1,
            )
            .await;
        drop(held);
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
        for (method, deadline, outcome) in outcomes {
            let error = outcome
                .expect("mutation must first wait behind the held session barrier")
                .expect("interruption must release the wait while the barrier remains held")
                .expect_err("queued mutation must not commit");
            assert_eq!(
                error.code,
                if deadline {
                    ErrorCode::DeadlineExceeded
                } else {
                    ErrorCode::Cancelled
                },
                "{method}, deadline={deadline}"
            );
        }
        assert_eq!(
            cancelled_read
                .expect_err("cancelled read must not start")
                .code,
            ErrorCode::Cancelled
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn owner_outbox_append_waits_for_the_workspace_session_barrier() {
        // MUTATION: remove the owner outbox session_ops acquisition -> the
        // append commits while this test still holds the lifecycle guard.
        let scratch = ScratchDir::new().expect("scratch");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let service = Arc::new(EngineService::with_supervisor(supervisor));
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "owner-outbox-session-barrier",
                    "captureMode": "none"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({ "workspaceId": "owner-outbox-session-barrier" }),
            )
            .await
            .expect("ensure durable main version");
        let open = service.open(Some(&handle)).expect("open workspace");
        let held = Arc::clone(&open.session_ops).lock_owned().await;

        let appending_service = Arc::clone(&service);
        let appending_handle = handle.clone();
        let mut appending = tokio::spawn(async move {
            appending_service
                .owner_ydoc_outbox_append(
                    &RequestContext::unbounded(),
                    Some(appending_handle),
                    owner_outbox_append_params("owner-outbox-session-barrier", "serialized-append"),
                )
                .await
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(100), &mut appending)
                .await
                .is_err(),
            "owner outbox append must wait behind session_ops"
        );

        drop(held);
        tokio::time::timeout(Duration::from_secs(10), appending)
            .await
            .expect("append completed after barrier release")
            .expect("append task")
            .expect("owner outbox append");
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn owner_outbox_append_cannot_commit_after_close_wins_the_session_barrier() {
        // MUTATION: bypass the actor with EngineStore::open after the session_ops
        // barrier -> the paused append reopens engine.db and commits after close.
        let scratch = ScratchDir::new().expect("scratch");
        let db_path = scratch.path().join(".dohc/engine/engine.db");
        let supervisor: &'static WorkspaceSupervisor =
            Box::leak(Box::new(WorkspaceSupervisor::new()));
        let reached = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut service = EngineService::with_supervisor(supervisor);
        service.owner_outbox_append_probe = Some((
            Arc::clone(&reached),
            Arc::clone(&release),
            Arc::new(std::sync::atomic::AtomicBool::new(true)),
        ));
        let service = Arc::new(service);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(),
                    "workspaceId": "owner-outbox-close-race",
                    "captureMode": "none"
                }),
            )
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("workspace handle");
        service
            .versions_ensure_main(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                json!({ "workspaceId": "owner-outbox-close-race" }),
            )
            .await
            .expect("ensure durable main version");

        let appending_service = Arc::clone(&service);
        let appending_handle = handle.clone();
        let appending = tokio::spawn(async move {
            appending_service
                .owner_ydoc_outbox_append(
                    &RequestContext::unbounded(),
                    Some(appending_handle),
                    owner_outbox_append_params("owner-outbox-close-race", "append-after-close"),
                )
                .await
        });
        reached.notified().await;
        service
            .workspace_close(Some(handle))
            .await
            .expect("workspace close");
        release.notify_one();

        let error = appending
            .await
            .expect("append task")
            .expect_err("a stale append must not survive workspace close");
        assert_eq!(error.code, ErrorCode::WorkspaceUnavailable);
        let store = dohc_engine_storage::EngineStore::open_read_only(&db_path)
            .expect("read closed workspace store");
        let entries = store
            .read_with(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM owner_ydoc_outbox_entries",
                    [],
                    |row| row.get::<_, i64>(0),
                )
            })
            .expect("outbox entry count");
        assert_eq!(entries, 0, "close must leave no post-teardown mutation");
    }
}
