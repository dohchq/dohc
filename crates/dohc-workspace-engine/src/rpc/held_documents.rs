//! `sync.heldDocuments` and `sync.heldDocument`: the documents a hosted
//! replica holds for retained work a released chain left, read for the relay,
//! which answers the workspace's owner. Only the configured host's own
//! connection may ask, for a workspace it attached, and both checks hold again
//! once the read returns. Nothing here writes.
use crate::EngineService;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::reads::MAX_INBAND_CONTENT_BYTES;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_collab::live_update_application::Preservation;
use dohc_engine_collab::live_update_application::PreservationFinding;
use dohc_engine_collab::live_update_application::RetainedContribution;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::BlobEgress;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_sync::HeldDocument;
use dohc_engine_sync::HeldDocumentInspection;
use dohc_engine_sync::MAX_HELD_DOCUMENTS_PAGE;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeldDocumentsParams {
    workspace_id: String,
    #[serde(default)]
    after_object_id: Option<String>,
    limit: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HeldDocumentParams {
    workspace_id: String,
    object_id: String,
}

/// The longest object ID a request names.
const MAX_OBJECT_ID_BYTES: usize = 512;

fn object_id(value: &str) -> Result<(), WireError> {
    if value.is_empty() || value.len() > MAX_OBJECT_ID_BYTES {
        return Err(WireError::new(ErrorCode::InvalidParams, "invalid object ID"));
    }
    Ok(())
}

fn not_hosted() -> WireError {
    WireError::new(ErrorCode::InvalidParams, "workspace is not a hosted replica")
}

impl EngineService {
    /// The workspace `handle` opens, while the configured host's own current
    /// connection asks and the workspace is one it attached.
    fn held_documents_open(
        &self,
        ctx: &RequestContext,
        handle: &WorkspaceHandle,
        workspace_id: &str,
    ) -> Result<Arc<OpenWorkspace>, WireError> {
        self.configured_ordinary_workspace(ctx, handle)?;
        let open = self.open(Some(handle))?;
        validate_workspace_param(Some(workspace_id), &open.workspace_id)?;
        Ok(open)
    }

    /// `sync.heldDocuments`: up to `limit` held documents in object ID order
    /// after `afterObjectId`, from durable state alone.
    pub(super) async fn sync_held_documents(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: HeldDocumentsParams = parse(params)?;
        if !(1..=MAX_HELD_DOCUMENTS_PAGE).contains(&params.limit) {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid held documents limit",
            ));
        }
        if let Some(after) = &params.after_object_id {
            object_id(after)?;
        }
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let page = Self::read_under_ctx(
            &cancellation,
            "sync.heldDocuments",
            open.actor.held_documents(
                open.workspace_id.clone(),
                params.after_object_id,
                params.limit,
            ),
        )
        .await?;
        self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let page = page.ok_or_else(not_hosted)?;
        Ok(json!({
            "documents": page.documents.iter().map(held_json).collect::<Vec<_>>(),
            "hasMore": page.has_more,
        }))
    }

    /// `sync.heldDocument`: one held document, whether its binding still
    /// stands, and what that binding preserves; null when the replica holds
    /// no such document for retained work. Preserved Markdown above the
    /// in-band limit is left out of the result, which keeps its digest and
    /// length, and streams as a blob under the request's ID to a connection
    /// that negotiated blobs.
    pub(super) async fn sync_held_document(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<(Value, Option<BlobEgress>), WireError> {
        let params: HeldDocumentParams = parse(params)?;
        object_id(&params.object_id)?;
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let inspected = Self::read_under_ctx(
            &cancellation,
            "sync.heldDocument",
            open.actor
                .held_document(open.workspace_id.clone(), params.object_id.clone()),
        )
        .await?;
        self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let Some(inspected) = inspected else {
            return Ok((Value::Null, None));
        };
        let markdown = inspected
            .preservation
            .as_ref()
            .and_then(|preservation| preservation.preserved.as_ref())
            .map(|preserved| preserved.markdown.as_bytes());
        let streamed = markdown.is_some_and(|bytes| bytes.len() > MAX_INBAND_CONTENT_BYTES);
        let result = inspection_json(&inspected, !streamed);
        let Some(bytes) = markdown.filter(|_| streamed && ctx.has_capability("blobs")) else {
            return Ok((result, None));
        };
        let byte_permit = self
            .blob_egress_budget
            .reserve(bytes.len() as i64, &cancellation, "sync.heldDocument")
            .await?;
        Ok((
            result,
            Some(BlobEgress {
                stream_id: request_id,
                sha256: dohc_engine_storage::hex_sha256(bytes),
                bytes: bytes.to_vec(),
                cancel: ctx.cancel.clone(),
                deadline: ctx.deadline,
                byte_permit: Some(byte_permit),
            }),
        ))
    }
}

fn held_json(document: &HeldDocument) -> Value {
    json!({
        "objectId": document.object_id,
        "path": document.path,
        "binding": document.binding.to_json(),
        "bindingDigest": document.binding.digest(),
        "continuation": document.continuation.as_str(),
        "bindingStale": document.binding_stale,
    })
}

/// The inspection on the wire, its preserved Markdown in band when `inband`.
fn inspection_json(inspected: &HeldDocumentInspection, inband: bool) -> Value {
    let mut result = held_json(&inspected.document);
    result["status"] = json!(inspected.status.as_str());
    result["preservation"] = inspected
        .preservation
        .as_ref()
        .map_or(Value::Null, |preservation| {
            preservation_json(preservation, inband)
        });
    // Resolution is not recorded yet; the round that adds it fills this.
    result["resolution"] = Value::Null;
    result
}

fn preservation_json(preservation: &Preservation, inband: bool) -> Value {
    let preserved = preservation.preserved.as_ref();
    json!({
        "status": preservation.status.as_str(),
        "reasons": preservation.findings.iter().map(finding_json).collect::<Vec<_>>(),
        "mergedContributionIds": preservation
            .merged
            .iter()
            .map(RetainedContribution::to_json)
            .collect::<Vec<_>>(),
        "markdown": preserved.filter(|_| inband).map(|preserved| preserved.markdown.as_str()),
        "markdownSha256": preserved
            .map(|preserved| dohc_engine_storage::hex_sha256(preserved.markdown.as_bytes())),
        "markdownByteLength": preserved.map(|preserved| preserved.markdown.len()),
        "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
    })
}

fn finding_json(found: &PreservationFinding) -> Value {
    json!({
        "reason": found.reason.as_str(),
        "status": found.reason.status().as_str(),
        "namespace": found.namespace,
        "contribution": found.contribution.as_ref().map(RetainedContribution::to_json),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_protocol::transport::ConnectionOwner;

    /// Plan r3, inspection authority: the handlers themselves require the
    /// configured host's own current connection and a workspace it attached,
    /// whatever let the request through, and refuse once either ends.
    #[tokio::test]
    async fn held_document_reads_answer_only_the_configured_host_for_its_workspaces() {
        let attached = dohc_engine_testkit::ScratchDir::new().unwrap();
        let private = dohc_engine_testkit::ScratchDir::new().unwrap();
        let config = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "relay",
            "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
            "workspaces": [
                {"root": attached.path(), "workspaceId": "attached", "maxRegistrations": 4,
                    "relay": {"baseUrl": "https://relay.example", "bearerToken": "actual-owner-credential"}},
                {"root": private.path(), "workspaceId": "private", "maxRegistrations": 4}
            ],
            "ingress": {"aggregateBytes": 512 * 1024 * 1024, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
                "maxUploads": 2, "uploadDeadlineMs": 30_000}
        }))
        .unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(config).await.unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let discovery = service
            .configured_live_hosts(
                &ctx,
                &dohc_engine_protocol::wire::Request {
                    id: 1,
                    method: "liveApplication.hosts".into(),
                    workspace: None,
                    deadline_ms: None,
                    idempotency_key: None,
                    progress: false,
                    params: json!({}),
                },
            )
            .unwrap();
        let handle = |index: usize| -> WorkspaceHandle {
            serde_json::from_value(discovery["workspaces"][index]["workspaceHandle"].clone())
                .unwrap()
        };
        let (attached_handle, private_handle) = (handle(0), handle(1));
        let list = |workspace_id: &str| json!({"workspaceId": workspace_id, "limit": 8});
        let one = |workspace_id: &str| json!({"workspaceId": workspace_id, "objectId": "object"});
        let code = |result: Result<Value, WireError>| result.unwrap_err().code;
        let inspected = |result: Result<(Value, Option<BlobEgress>), WireError>| {
            result.map(|(value, _)| value).unwrap_err().code
        };

        // The host's own connection reaches the store: this one is no hosted
        // replica, so nothing is held there.
        let reached = service
            .sync_held_documents(&ctx, Some(attached_handle.clone()), list("attached"))
            .await
            .unwrap_err();
        assert_eq!((reached.code, reached.message.as_str()), (ErrorCode::InvalidParams, "workspace is not a hosted replica"));
        let (nothing, blob) = service
            .sync_held_document(&ctx, Some(attached_handle.clone()), one("attached"), 2)
            .await
            .unwrap();
        assert!(nothing.is_null() && blob.is_none(), "{nothing}");
        // Another workspace's ID, a workspace the host did not attach, and a
        // handle that names nothing.
        assert_eq!(
            code(service.sync_held_documents(&ctx, Some(attached_handle.clone()), list("private")).await),
            ErrorCode::InvalidParams
        );
        for foreign in [private_handle.clone(), WorkspaceHandle("foreign".into())] {
            assert_eq!(
                code(service.sync_held_documents(&ctx, Some(foreign.clone()), list("private")).await),
                ErrorCode::WorkspaceUnavailable
            );
            assert_eq!(
                inspected(service.sync_held_document(&ctx, Some(foreign), one("private"), 3).await),
                ErrorCode::WorkspaceUnavailable
            );
        }
        // Any other connection, then the host's own once it retired.
        let other = ConnectionOwner::authenticated();
        let mut stranger = RequestContext::unbounded();
        stranger.connection = Some(other.handle());
        assert_eq!(
            code(service.sync_held_documents(&stranger, Some(attached_handle.clone()), list("attached")).await),
            ErrorCode::SessionExpired
        );
        assert_eq!(
            inspected(service.sync_held_document(&stranger, Some(attached_handle.clone()), one("attached"), 4).await),
            ErrorCode::SessionExpired
        );
        assert_eq!(
            code(service.sync_held_documents(&RequestContext::unbounded(), Some(attached_handle.clone()), list("attached")).await),
            ErrorCode::SessionExpired
        );
        owner.retire();
        assert_eq!(
            code(service.sync_held_documents(&ctx, Some(attached_handle.clone()), list("attached")).await),
            ErrorCode::SessionExpired
        );
        service.workspace_close(Some(attached_handle)).await.unwrap();
        service.workspace_close(Some(private_handle)).await.unwrap();
    }

    /// Out-of-range pages and object IDs are refused before anything reads.
    #[tokio::test]
    async fn held_document_requests_are_bounded() {
        let service = EngineService::new();
        let ctx = RequestContext::unbounded();
        for params in [
            json!({"workspaceId": "w", "limit": 0}),
            json!({"workspaceId": "w", "limit": MAX_HELD_DOCUMENTS_PAGE + 1}),
            json!({"workspaceId": "w", "limit": 1, "afterObjectId": ""}),
            json!({"workspaceId": "w", "limit": 1, "extra": true}),
        ] {
            let refused = service.sync_held_documents(&ctx, None, params.clone()).await.unwrap_err();
            assert_eq!(refused.code, ErrorCode::InvalidParams, "{params}");
        }
        let refused = service
            .sync_held_document(&ctx, None, json!({"workspaceId": "w", "objectId": ""}), 1)
            .await
            .map(|(value, _)| value)
            .unwrap_err();
        assert_eq!(refused.code, ErrorCode::InvalidParams);
    }
}
