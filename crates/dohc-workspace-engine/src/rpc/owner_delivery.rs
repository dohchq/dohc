//! Trusted desktop-main owner delivery. This does not grant canonical-host authority.
use super::{
    error::{map_owner_outbox, map_runtime, workspace_unavailable},
    request::{OperationCancellation, now_ms},
};
use crate::EngineService;
use dohc_engine_collab::{LiveObjectBinding, OwnerDeliveryReceipt};
use dohc_engine_protocol::{
    error::{ErrorCode, WireError},
    transport::{BlobEgress, ConnectionHandle, OutputGuard, RequestContext, ServiceResponse},
    wire::{Request, Response, WorkspaceHandle},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::Arc, time::Instant};

const MAX: usize = dohc_engine_collab::limits::MAX_YDOC_UPDATE_BYTES;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnerDraftUploadParams {
    binding: LiveObjectBinding,
    expected_revision: i64,
    append_key: String,
    stream_id: u64,
    byte_length: usize,
    digest: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnerEnrollmentUploadParams {
    binding: LiveObjectBinding,
    relay_database_namespace: String,
    captured: dohc_engine_collab::owner_outbox::enrollment::OwnerEnrollmentCapture,
    journal_cursor: i64,
    host_vector_byte_length: usize,
    stream_id: u64,
    byte_length: usize,
    digest: String,
}

#[derive(Clone)]
pub(crate) enum OwnerUpload {
    Accepted(OwnerUploadParams),
    Draft(OwnerDraftUploadParams),
    Enrollment(OwnerEnrollmentUploadParams),
}

impl OwnerUpload {
    pub(crate) fn parse(method: &str, value: Value) -> Result<Self, WireError> {
        if method == "ydoc.ownerDelivery.enroll" {
            let params: OwnerEnrollmentUploadParams =
                serde_json::from_value(value).map_err(|_| invalid())?;
            if !(1..=MAX).contains(&params.host_vector_byte_length)
                || params.byte_length < params.host_vector_byte_length + 2
                || params.byte_length - params.host_vector_byte_length > MAX
            {
                return Err(invalid());
            }
            params.binding.validate_canonical().map_err(|_| invalid())?;
            Ok(Self::Enrollment(params))
        } else if method == "ydoc.ownerDelivery.appendDraft" {
            let params: OwnerDraftUploadParams =
                serde_json::from_value(value).map_err(|_| invalid())?;
            if !(2..=MAX).contains(&params.byte_length)
                || params.append_key.is_empty()
                || params.append_key.len() > 256
            {
                return Err(invalid());
            }
            params.binding.validate_canonical().map_err(|_| invalid())?;
            Ok(Self::Draft(params))
        } else {
            let params: OwnerUploadParams = serde_json::from_value(value).map_err(|_| invalid())?;
            params.validate(method)?;
            Ok(Self::Accepted(params))
        }
    }
    pub(crate) fn stream(&self) -> (u64, usize, String) {
        match self {
            Self::Accepted(p) => (p.stream_id, p.byte_length, p.digest.clone()),
            Self::Draft(p) => (p.stream_id, p.byte_length, p.digest.clone()),
            Self::Enrollment(p) => (p.stream_id, p.byte_length, p.digest.clone()),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OwnerUploadParams {
    pub binding: LiveObjectBinding,
    pub relay_database_namespace: String,
    pub expected_revision: i64,
    pub expected_native_head_sequence: i64,
    pub previous_accepted_cursor: i64,
    pub journal_cursor: i64,
    pub stream_id: u64,
    pub byte_length: usize,
    pub digest: String,
    pub host_vector_byte_length: Option<usize>,
}

impl OwnerUploadParams {
    pub(crate) fn validate(&self, method: &str) -> Result<(), WireError> {
        let vector_len = match (method, self.host_vector_byte_length) {
            ("ydoc.ownerDelivery.applyInitialSync", Some(n)) if (1..=MAX).contains(&n) => n,
            ("ydoc.ownerDelivery.applyAcceptedFrame", None) => 0,
            _ => return Err(invalid()),
        };
        if self.byte_length < vector_len + 2 || self.byte_length - vector_len > MAX {
            return Err(invalid());
        }
        self.binding.validate_canonical().map_err(|_| invalid())
    }
}

#[derive(Clone)]
pub struct OwnerInput {
    pub(crate) params: OwnerUpload,
    pub(crate) bytes: Vec<u8>,
    pub(crate) reservation: Arc<dyn Send + Sync>,
}

struct OwnerOutputGuard {
    service: std::sync::Weak<EngineService>,
    workspace: WorkspaceHandle,
    open: Arc<super::workspace::OpenWorkspace>,
    connection: ConnectionHandle,
    cancel: dohc_engine_protocol::cancel::CancelSignal,
    deadline: Option<Instant>,
    reservation: Arc<dyn Send + Sync>,
}
impl std::fmt::Debug for OwnerOutputGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnerOutputGuard").finish_non_exhaustive()
    }
}
impl OutputGuard for OwnerOutputGuard {
    fn with_current(&self, action: &mut dyn FnMut()) -> bool {
        let Some(service) = self.service.upgrade() else {
            return false;
        };
        let handles = crate::lock(&service.handles);
        if !self.connection.is_current()
            || self.cancel.is_cancelled()
            || self.deadline.is_some_and(|d| Instant::now() >= d)
            || !handles
                .get(&self.workspace)
                .is_some_and(|open| Arc::ptr_eq(open, &self.open))
        {
            return false;
        }
        action();
        true
    }
    fn cancel_signal(&self) -> dohc_engine_protocol::cancel::CancelSignal {
        self.cancel.clone()
    }
    fn retirement_signal(&self) -> dohc_engine_protocol::cancel::CancelSignal {
        self.connection.cancel_signal()
    }
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }
    fn is_current(&self) -> bool {
        self.connection.is_current()
            && !self.cancel.is_cancelled()
            && self.deadline.is_none_or(|d| Instant::now() < d)
            && self.service.upgrade().is_some_and(|service| {
                service
                    .open(Some(&self.workspace))
                    .is_ok_and(|open| Arc::ptr_eq(&open, &self.open))
            })
    }
}

fn invalid() -> WireError {
    WireError::new(ErrorCode::InvalidParams, "invalid owner delivery request")
}

impl EngineService {
    fn notify_owner_sessions(&self, workspace: &WorkspaceHandle, binding: &LiveObjectBinding) {
        let sessions = crate::lock(&self.sessions);
        for (session_id, session) in sessions.iter() {
            if &session.workspace == workspace
                && session.key.workspace_id == binding.workspace_id
                && session.key.version_id == binding.main_version_id
                && session.key.object_id == binding.object_id
                && session.path == binding.current_path
                && session.lineage_claim_id.as_deref() == Some(binding.lineage_claim_id.as_str())
            {
                self.events.emit(
                    "ydoc.remoteUpdate",
                    json!({"sessionId":session_id,"resyncRequired":true}),
                );
            }
        }
    }

    pub(super) fn reserve_owner_delivery(&self) -> Result<Arc<dyn Send + Sync>, WireError> {
        self.ordinary_live_host
            .get()
            .and_then(|host| host.owner_delivery_admission.as_ref())
            .ok_or_else(|| WireError::new(ErrorCode::Overloaded, "owner delivery capacity"))?
            .reserve()
    }

    async fn owner_delivery_append_draft(
        &self,
        ctx: RequestContext,
        request: Request,
        params: OwnerDraftUploadParams,
        bytes: Vec<u8>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<ServiceResponse, WireError> {
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            Some(&params.binding),
            reservation,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let _serial = self
            .mutation_session_guard(&guard.open, &cancellation, "owner draft (queued)")
            .await?;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let binding = params.binding.clone();
        let result = guard
            .open
            .actor
            .owner_ydoc_append_draft(
                guard.open.workspace_id.clone(),
                dohc_engine_collab::owner_outbox::draft::OwnerDraftAppendInput {
                    binding: params.binding,
                    expected_revision: params.expected_revision,
                    append_key: params.append_key,
                    update: bytes,
                    now_ms: now_ms()?,
                },
                cancellation.token(),
                guard.reservation.clone(),
            )
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        self.notify_owner_sessions(&guard.workspace, &binding);
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({
                    "outboxId":result.outbox_id,"sequence":result.sequence,"deliveryId":result.delivery_id,"updateDigest":result.update_digest,"pendingBytes":result.pending_bytes,"oldestEntryAtMs":result.oldest_entry_at_ms,"state":result.state.as_str(),
                }),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    pub(crate) async fn owner_delivery_open_draft(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            binding: LiveObjectBinding,
            expected_revision: i64,
        }
        let params: Params = serde_json::from_value(request.params).map_err(|_| invalid())?;
        if !ctx.capabilities.iter().any(|c| c == "blobs") {
            return Err(invalid());
        }
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            Some(&params.binding),
            self.reserve_owner_delivery()?,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let state = guard
            .open
            .actor
            .owner_ydoc_open_draft(
                params.binding,
                params.expected_revision,
                cancellation.token(),
                guard.reservation.clone(),
            )
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let digest = dohc_engine_storage::hex_sha256(&state.initial_update);
        let result = json!({"status":"draft","draft":state.descriptor,"streamId":request.id,"byteLength":state.initial_update.len(),"digest":digest});
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result,
            },
            blob_egress: Some(BlobEgress {
                stream_id: request.id,
                sha256: digest,
                bytes: state.initial_update,
                cancel: ctx.cancel,
                deadline: ctx.deadline,
                byte_permit: None,
            }),
            output_guard: Some(guard),
        })
    }

    pub(crate) async fn owner_delivery_list_drafts(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        use dohc_engine_collab::owner_outbox::draft::OwnerDraftCursor;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            after: Option<OwnerDraftCursor>,
            limit: usize,
        }
        let params: Params = serde_json::from_value(request.params).map_err(|_| invalid())?;
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            None,
            self.reserve_owner_delivery()?,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let rows = guard
            .open
            .actor
            .owner_ydoc_list_drafts(
                guard.open.workspace_id.clone(),
                params.after,
                params.limit,
                cancellation.token(),
                guard.reservation.clone(),
            )
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        let fetched = rows.len();
        let mut drafts = Vec::new();
        let mut next = None;
        let mut byte_length = 256usize;
        let mut truncated = false;
        for row in rows {
            let bytes = serde_json::to_vec(&row).map_err(|_| invalid())?.len();
            let cursor = OwnerDraftCursor {
                main_version_id: row.binding.main_version_id.clone(),
                object_id: row.binding.object_id.clone(),
                lineage_claim_id: row.binding.lineage_claim_id.clone(),
            };
            let cursor_bytes = serde_json::to_vec(&cursor).map_err(|_| invalid())?.len();
            if byte_length
                .saturating_add(bytes)
                .saturating_add(cursor_bytes)
                > ctx.max_frame_bytes as usize
            {
                truncated = true;
                break;
            }
            byte_length += bytes + 1;
            next = Some(cursor);
            drafts.push(row);
        }
        if truncated && drafts.is_empty() {
            return Err(WireError::new(
                ErrorCode::LimitExceeded,
                "owner draft descriptor exceeds frame limit",
            ));
        }
        if !truncated && fetched < params.limit {
            next = None;
        }
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"drafts":drafts,"next":next}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    pub(crate) fn owner_delivery_connection(
        &self,
        connection: &ConnectionHandle,
        workspace: Option<&WorkspaceHandle>,
    ) -> Result<(), WireError> {
        let host = self
            .ordinary_live_host
            .get()
            .ok_or_else(workspace_unavailable)?;
        if !host.connection.same_connection(connection) || !connection.is_current() {
            return Err(workspace_unavailable());
        }
        self.open(workspace)?;
        Ok(())
    }

    fn owner_delivery_guard(
        &self,
        ctx: &RequestContext,
        workspace: Option<&WorkspaceHandle>,
        binding: Option<&LiveObjectBinding>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<Arc<OwnerOutputGuard>, WireError> {
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        self.owner_delivery_connection(connection, workspace)?;
        let open = self.open(workspace)?;
        if let Some(binding) = binding {
            binding.validate_canonical().map_err(|_| invalid())?;
            if open.workspace_id != binding.workspace_id {
                return Err(workspace_unavailable());
            }
        }
        let guard = Arc::new(OwnerOutputGuard {
            service: self
                .ordinary_live_host
                .get()
                .ok_or_else(workspace_unavailable)?
                .service
                .clone(),
            workspace: workspace.cloned().ok_or_else(workspace_unavailable)?,
            open,
            connection: connection.clone(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            reservation,
        });
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(guard)
    }

    pub(crate) async fn owner_delivery_apply(
        &self,
        ctx: RequestContext,
        request: Request,
        input: OwnerInput,
    ) -> Result<ServiceResponse, WireError> {
        let (_, length, digest) = input.params.stream();
        if input.bytes.len() != length || dohc_engine_storage::hex_sha256(&input.bytes) != digest {
            return Err(invalid());
        }
        let params = match input.params {
            OwnerUpload::Draft(params) => {
                if request.method != "ydoc.ownerDelivery.appendDraft" {
                    return Err(invalid());
                }
                return self
                    .owner_delivery_append_draft(
                        ctx,
                        request,
                        params,
                        input.bytes,
                        input.reservation,
                    )
                    .await;
            }
            OwnerUpload::Enrollment(params) => {
                if request.method != "ydoc.ownerDelivery.enroll" {
                    return Err(invalid());
                }
                return self
                    .owner_delivery_enroll(ctx, request, params, input.bytes, input.reservation)
                    .await;
            }
            OwnerUpload::Accepted(params) => params,
        };
        params.validate(&request.method)?;
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            Some(&params.binding),
            input.reservation,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let _serial = self
            .mutation_session_guard(&guard.open, &cancellation, "owner delivery (queued)")
            .await?;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let p = params;
        let mut bytes = input.bytes;
        let vector = if let Some(n) = p.host_vector_byte_length {
            let update = bytes.split_off(n);
            Some(std::mem::replace(&mut bytes, update))
        } else {
            None
        };
        let binding = p.binding.clone();
        let applied = dohc_engine_collab::owner_outbox::accepted::OwnerAcceptedFrameInput {
            binding: p.binding,
            relay_database_namespace: p.relay_database_namespace,
            expected_revision: p.expected_revision,
            expected_native_head_sequence: p.expected_native_head_sequence,
            previous_accepted_cursor: p.previous_accepted_cursor,
            journal_cursor: p.journal_cursor,
            update_bytes: bytes,
        };
        let result = if let Some(vector) = vector {
            guard
                .open
                .actor
                .owner_ydoc_apply_initial_sync(
                    guard.open.workspace_id.clone(),
                    applied,
                    vector,
                    now_ms()?,
                    cancellation.token(),
                    guard.reservation.clone(),
                )
                .await
        } else {
            guard
                .open
                .actor
                .owner_ydoc_apply_accepted(
                    guard.open.workspace_id.clone(),
                    applied,
                    now_ms()?,
                    cancellation.token(),
                    guard.reservation.clone(),
                )
                .await
        }
        .map_err(map_runtime)?
        .map_err(map_owner_outbox)?;
        self.notify_owner_sessions(&guard.workspace, &binding);
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"revision":result.revision,"acceptedCursor":result.accepted_cursor,"nativeHeadSequence":result.native_head_sequence}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    async fn owner_delivery_enroll(
        &self,
        ctx: RequestContext,
        request: Request,
        params: OwnerEnrollmentUploadParams,
        mut bytes: Vec<u8>,
        reservation: Arc<dyn Send + Sync>,
    ) -> Result<ServiceResponse, WireError> {
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            Some(&params.binding),
            reservation,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let _serial = self
            .mutation_session_guard(&guard.open, &cancellation, "owner enrollment (queued)")
            .await?;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        let checkpoint = bytes.split_off(params.host_vector_byte_length);
        let limits = self
            .ordinary_live_host
            .get()
            .ok_or_else(workspace_unavailable)?
            .owner_outbox
            .clone();
        let draft = guard
            .open
            .actor
            .owner_ydoc_enroll(
                guard.open.workspace_id.clone(),
                dohc_engine_collab::owner_outbox::enrollment::OwnerEnrollmentInput {
                    binding: params.binding,
                    relay_database_namespace: params.relay_database_namespace,
                    captured: params.captured,
                    journal_cursor: params.journal_cursor,
                    checkpoint,
                    host_vector: bytes,
                },
                limits,
                now_ms()?,
                cancellation.token(),
                guard.reservation.clone(),
            )
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        // The workspace mutation serial prevents a pre-enrollment editor write
        // from being routed through ordinary publication after this commit.
        for session in crate::lock(&self.sessions).values_mut() {
            if session.workspace == guard.workspace
                && session.key.workspace_id == draft.binding.workspace_id
                && session.key.version_id == draft.binding.main_version_id
                && session.key.object_id == draft.binding.object_id
                && session.path == draft.binding.current_path
                && session.lineage_claim_id.as_deref()
                    == Some(draft.binding.lineage_claim_id.as_str())
            {
                session.owner_draft = Some(draft.clone());
            }
        }
        self.notify_owner_sessions(&guard.workspace, &draft.binding);
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!({"draft": draft}),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    pub(crate) async fn owner_delivery_prepare_enrollment(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            binding: LiveObjectBinding,
            relay_database_namespace: String,
        }
        let params: Params = serde_json::from_value(request.params).map_err(|_| invalid())?;
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        self.owner_delivery_connection(connection, request.workspace.as_ref())?;
        let reservation = self.reserve_owner_delivery()?;
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            Some(&params.binding),
            reservation,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let result = guard
            .open
            .actor
            .owner_ydoc_prepare_enrollment(
                params.binding,
                params.relay_database_namespace,
                cancellation.token(),
                guard.reservation.clone(),
            )
            .await
            .map_err(map_runtime)?
            .map_err(map_owner_outbox)?;
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result: json!(result),
            },
            blob_egress: None,
            output_guard: Some(guard),
        })
    }

    pub(crate) async fn owner_delivery_read(
        &self,
        ctx: RequestContext,
        request: Request,
    ) -> Result<ServiceResponse, WireError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Params {
            binding: LiveObjectBinding,
            relay_database_namespace: String,
            receipt: Option<OwnerDeliveryReceipt>,
        }
        let p: Params = serde_json::from_value(request.params).map_err(|_| invalid())?;
        if (request.method == "ydoc.ownerDelivery.isReceiptApplied") != p.receipt.is_some() {
            return Err(invalid());
        }
        if p.receipt.is_none() && !ctx.capabilities.iter().any(|c| c == "blobs") {
            return Err(invalid());
        }
        let connection = ctx.connection.as_ref().ok_or_else(workspace_unavailable)?;
        self.owner_delivery_connection(connection, request.workspace.as_ref())?;
        let reservation = self.reserve_owner_delivery()?;
        let guard = self.owner_delivery_guard(
            &ctx,
            request.workspace.as_ref(),
            Some(&p.binding),
            reservation,
        )?;
        let cancellation = OperationCancellation::new(&ctx);
        let (result, blob_egress) = if let Some(receipt) = p.receipt {
            let applied = guard
                .open
                .actor
                .owner_ydoc_is_receipt_applied(
                    p.binding,
                    p.relay_database_namespace,
                    receipt,
                    cancellation.token(),
                    guard.reservation.clone(),
                )
                .await
                .map_err(map_runtime)?
                .map_err(map_owner_outbox)?;
            (json!({"applied":applied}), None)
        } else {
            let state = guard
                .open
                .actor
                .owner_ydoc_accepted_state(
                    p.binding,
                    p.relay_database_namespace,
                    cancellation.token(),
                    guard.reservation.clone(),
                )
                .await
                .map_err(map_runtime)?
                .map_err(map_owner_outbox)?;
            let digest = dohc_engine_storage::hex_sha256(&state.state_vector);
            let result = json!({"status":"state","revision":state.revision,"acceptedCursor":state.accepted_cursor,"nativeHeadSequence":state.native_head_sequence,"streamId":request.id,"byteLength":state.state_vector.len(),"digest":digest});
            (
                result,
                Some(BlobEgress {
                    stream_id: request.id,
                    sha256: digest,
                    bytes: state.state_vector,
                    cancel: ctx.cancel.clone(),
                    deadline: ctx.deadline,
                    byte_permit: None,
                }),
            )
        };
        if !guard.is_current() {
            return Err(workspace_unavailable());
        }
        Ok(ServiceResponse {
            response: Response {
                id: request.id,
                result,
            },
            blob_egress,
            output_guard: Some(guard),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upload_metadata_keeps_frame_and_sync_shapes_separate() {
        let binding = LiveObjectBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: "ab".repeat(32),
            current_path: "a.md".into(),
            selector_paths: vec!["a.md".into()],
            restore_fence_generation: 0,
        };
        let mut p = OwnerUploadParams {
            binding,
            relay_database_namespace: "relay".into(),
            expected_revision: 1,
            expected_native_head_sequence: 0,
            previous_accepted_cursor: 0,
            journal_cursor: 1,
            stream_id: 1,
            byte_length: MAX,
            digest: "cd".repeat(32),
            host_vector_byte_length: None,
        };
        assert!(p.validate("ydoc.ownerDelivery.applyAcceptedFrame").is_ok());
        assert!(p.validate("ydoc.ownerDelivery.applyInitialSync").is_err());
        p.host_vector_byte_length = Some(MAX);
        p.byte_length = MAX * 2;
        assert!(p.validate("ydoc.ownerDelivery.applyInitialSync").is_ok());
        assert!(p.validate("ydoc.ownerDelivery.applyAcceptedFrame").is_err());
        p.byte_length += 1;
        assert!(p.validate("ydoc.ownerDelivery.applyInitialSync").is_err());
    }

    #[test]
    fn ordinary_daemon_does_not_enable_owner_transport_implicitly() {
        let service = EngineService::new();
        let owner = dohc_engine_protocol::transport::ConnectionOwner::authenticated();
        assert!(
            service
                .owner_delivery_connection(&owner.handle(), None)
                .is_err()
        );
    }
}
