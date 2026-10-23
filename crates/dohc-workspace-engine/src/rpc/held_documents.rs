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
use dohc_engine_collab::live_update_application::ContributionLocator;
use dohc_engine_collab::live_update_application::Preservation;
use dohc_engine_collab::live_update_application::PreservationFinding;
use dohc_engine_collab::live_update_application::RetainedContribution;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::BlobEgress;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::transport::ServiceResponse;
use dohc_engine_protocol::wire::Response;
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
    /// Stream preserved Markdown above the in-band limit. Only a caller that
    /// reads the text asks.
    #[serde(default)]
    stream_markdown: bool,
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
    /// length. With `streamMarkdown`, which needs a connection that
    /// negotiated blobs, it streams as a blob under the request's ID. The
    /// answer is withheld once the workspace's live host retires.
    pub(super) async fn sync_held_document(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<ServiceResponse, WireError> {
        let params: HeldDocumentParams = parse(params)?;
        object_id(&params.object_id)?;
        if params.stream_markdown && !ctx.has_capability("blobs") {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "held document Markdown streams only as a blob",
            ));
        }
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let guard = self.live_host_output_guard(ctx, &handle)?;
        let answer = |result: Value, blob_egress: Option<BlobEgress>| ServiceResponse {
            response: Response {
                id: request_id,
                result,
            },
            blob_egress,
            output_guard: Some(Arc::clone(&guard)),
        };
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
            return Ok(answer(Value::Null, None));
        };
        let markdown = inspected
            .preservation
            .as_ref()
            .and_then(|preservation| preservation.preserved.as_ref())
            .map(|preserved| preserved.markdown.as_bytes());
        let outside = markdown.is_some_and(|bytes| bytes.len() > MAX_INBAND_CONTENT_BYTES);
        let result = inspection_json(&inspected, !outside);
        let Some(bytes) = markdown.filter(|_| outside && params.stream_markdown) else {
            return Ok(answer(result, None));
        };
        let blob = self
            .held_markdown_egress(
                ctx,
                &handle,
                &params.workspace_id,
                &cancellation,
                bytes,
                request_id,
            )
            .await?;
        Ok(answer(result, Some(blob)))
    }

    /// `bytes` as the blob of request `request_id`, once the egress budget
    /// holds them and the caller may still have them: the configured host's
    /// connection can end, or the workspace detach, while the budget waits.
    async fn held_markdown_egress(
        &self,
        ctx: &RequestContext,
        handle: &WorkspaceHandle,
        workspace_id: &str,
        cancellation: &OperationCancellation,
        bytes: &[u8],
        request_id: u64,
    ) -> Result<BlobEgress, WireError> {
        let byte_permit = self
            .blob_egress_budget
            .reserve(bytes.len() as i64, cancellation, "sync.heldDocument")
            .await?;
        self.held_documents_open(ctx, handle, workspace_id)?;
        Ok(BlobEgress {
            stream_id: request_id,
            sha256: dohc_engine_storage::hex_sha256(bytes),
            bytes: bytes.to_vec(),
            cancel: ctx.cancel.clone(),
            deadline: ctx.deadline,
            byte_permit: Some(byte_permit),
        })
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
        "coveredContributions": preservation
            .covered
            .iter()
            .map(|(namespace, contributions)| json!({
                "namespace": namespace,
                "contributions": contributions
                    .iter()
                    .map(RetainedContribution::to_json)
                    .collect::<Vec<_>>(),
            }))
            .collect::<Vec<_>>(),
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
        "contribution": found.contribution.as_ref().map(ContributionLocator::to_json),
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
        let inspected = |result: Result<ServiceResponse, WireError>| {
            result.map(|answer| answer.response.result).unwrap_err().code
        };

        // The host's own connection reaches the store: this one is no hosted
        // replica, so nothing is held there.
        let reached = service
            .sync_held_documents(&ctx, Some(attached_handle.clone()), list("attached"))
            .await
            .unwrap_err();
        assert_eq!((reached.code, reached.message.as_str()), (ErrorCode::InvalidParams, "workspace is not a hosted replica"));
        let nothing = service
            .sync_held_document(&ctx, Some(attached_handle.clone()), one("attached"), 2)
            .await
            .unwrap();
        assert!(nothing.response.result.is_null() && nothing.blob_egress.is_none(), "{nothing:?}");
        // Its answer lapses with the host, as each queued output does.
        let answered = nothing.output_guard.expect("the live host guards its answer");
        assert!(answered.is_current());
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
        assert!(!answered.is_current(), "a retired host's answer is withheld");
        assert_eq!(
            code(service.sync_held_documents(&ctx, Some(attached_handle.clone()), list("attached")).await),
            ErrorCode::SessionExpired
        );
        service.workspace_close(Some(attached_handle)).await.unwrap();
        service.workspace_close(Some(private_handle)).await.unwrap();
    }

    /// A configured host with one attached ordinary workspace, its handle,
    /// and a request context on the host's own connection.
    async fn attached_host(
        root: &dohc_engine_testkit::ScratchDir,
    ) -> (
        Arc<EngineService>,
        (ConnectionOwner, crate::live_application_ingress::LiveApplicationIngress),
        RequestContext,
        WorkspaceHandle,
    ) {
        let config = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "relay",
            "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
            "workspaces": [{"root": root.path(), "workspaceId": "attached", "maxRegistrations": 4,
                "relay": {"baseUrl": "https://relay.example", "bearerToken": "actual-owner-credential"}}],
            "ingress": {"aggregateBytes": 512 * 1024 * 1024, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
                "maxUploads": 2, "uploadDeadlineMs": 30_000}
        }))
        .unwrap();
        let (service, owner, ingress) = EngineService::configured_live_host(config).await.unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let discovery = service
            .configured_live_hosts(&ctx, &host_request("liveApplication.hosts", None))
            .unwrap();
        let handle =
            serde_json::from_value(discovery["workspaces"][0]["workspaceHandle"].clone()).unwrap();
        (service, (owner, ingress), ctx, handle)
    }

    fn host_request(
        method: &str,
        workspace: Option<WorkspaceHandle>,
    ) -> dohc_engine_protocol::wire::Request {
        dohc_engine_protocol::wire::Request {
            id: 1,
            method: method.into(),
            workspace,
            deadline_ms: None,
            idempotency_key: None,
            progress: false,
            params: json!({}),
        }
    }

    /// Sol's r2a finding 4: Markdown waiting for the egress budget is
    /// released only to a caller that may still have it. With the budget
    /// exhausted, the host's connection retires, or its workspace detaches,
    /// during the wait; once the budget frees, the read refuses instead of
    /// answering with the blob.
    #[tokio::test]
    async fn markdown_waiting_for_egress_rechecks_authority_once_the_budget_frees() {
        for detach in [false, true] {
            let root = dohc_engine_testkit::ScratchDir::new().unwrap();
            let (service, (owner, _ingress), ctx, handle) = attached_host(&root).await;
            let cancellation = OperationCancellation::new(&ctx);
            let exhausted = service
                .blob_egress_budget
                .reserve(
                    crate::rpc::reads::BLOB_EGRESS_BYTE_BUDGET as i64,
                    &cancellation,
                    "test.exhaust",
                )
                .await
                .unwrap();
            let mut waiting = std::pin::pin!(service.held_markdown_egress(
                &ctx,
                &handle,
                "attached",
                &cancellation,
                b"# Preserved\n",
                9,
            ));
            let mut context = std::task::Context::from_waker(std::task::Waker::noop());
            assert!(
                std::future::Future::poll(waiting.as_mut(), &mut context).is_pending(),
                "the blob waits for the exhausted budget"
            );
            let refused = if detach {
                service
                    .configured_detach_workspace(
                        &ctx,
                        host_request("liveApplication.detachWorkspace", Some(handle.clone())),
                    )
                    .await
                    .unwrap();
                ErrorCode::WorkspaceUnavailable
            } else {
                owner.retire();
                ErrorCode::SessionExpired
            };
            drop(exhausted);
            assert_eq!(waiting.await.unwrap_err().code, refused, "detach: {detach}");
            if !detach {
                service.workspace_close(Some(handle)).await.unwrap();
            }
        }
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
        // Streamed Markdown needs a connection that reads blobs.
        for params in [
            json!({"workspaceId": "w", "objectId": ""}),
            json!({"workspaceId": "w", "objectId": "o", "streamMarkdown": true}),
        ] {
            let refused = service
                .sync_held_document(&ctx, None, params.clone(), 1)
                .await
                .map(|answer| answer.response.result)
                .unwrap_err();
            assert_eq!(refused.code, ErrorCode::InvalidParams, "{params}");
        }
    }
}
