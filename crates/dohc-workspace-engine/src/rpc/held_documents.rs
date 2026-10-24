//! `sync.heldDocuments` and `sync.heldDocument`: the documents a hosted
//! replica holds for retained work a released chain left, read for the relay,
//! which answers the workspace's owner. Only the configured host's own
//! connection may ask, for a workspace it attached, and both checks hold again
//! once the read returns. Nothing here writes. Each answer fits
//! [`HELD_RESPONSE_BYTE_BUDGET`] however much a hold covers: discovery pages
//! by bytes, findings list a few examples per reason, and the binding with
//! every covered contribution streams as the contribution artifact.
use crate::EngineService;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::reads::BLOB_EGRESS_BYTE_BUDGET;
use crate::rpc::reads::MAX_INBAND_CONTENT_BYTES;
use crate::rpc::reads::json_string_encoded_len;
use crate::rpc::reads::response_encoded_bytes;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_collab::live_update_application::ContributionLocator;
use dohc_engine_collab::live_update_application::Preservation;
use dohc_engine_collab::live_update_application::PreservationFinding;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::BlobEgress;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::transport::ServiceResponse;
use dohc_engine_protocol::wire::Response;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_sync::HeldContributions;
use dohc_engine_sync::HeldDocument;
use dohc_engine_sync::HeldDocumentInspection;
use dohc_engine_sync::HeldDocumentsPage;
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
    /// What streams as a blob under the request's ID. Only a caller that
    /// reads it asks.
    #[serde(default)]
    stream: Option<HeldStream>,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum HeldStream {
    /// Preserved Markdown the answer leaves out.
    Markdown,
    /// The contribution artifact.
    Contributions,
}

/// The longest object ID a request names.
const MAX_OBJECT_ID_BYTES: usize = 512;

/// The most a serialized held-document answer holds, below the relay's
/// 256 KiB metadata limit, and a hosted pull or commit.
pub(super) const HELD_RESPONSE_BYTE_BUDGET: usize = 240 * 1024;

/// The most findings an answer lists for one reason; its total counts all.
const MAX_REASON_EXAMPLES: usize = 8;

fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// Bytes stored state cannot hold within its bounds.
fn over_budget() -> WireError {
    WireError::new(ErrorCode::Internal, "state-corrupt")
}

pub(super) fn object_id(value: &str) -> Result<(), WireError> {
    if value.is_empty() || value.len() > MAX_OBJECT_ID_BYTES {
        return Err(WireError::new(
            ErrorCode::InvalidParams,
            "invalid object ID",
        ));
    }
    Ok(())
}

fn not_hosted() -> WireError {
    WireError::new(
        ErrorCode::InvalidParams,
        "workspace is not a hosted replica",
    )
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

    /// `sync.heldDocuments`: summaries of up to `limit` held documents in
    /// object ID order after `afterObjectId`, from durable state alone, as
    /// many as fit the response budget. The next page starts after the last
    /// one listed.
    pub(super) async fn sync_held_documents(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
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
        discovery_page(request_id, &page, HELD_RESPONSE_BYTE_BUDGET)
    }

    /// `sync.heldDocument`: one held document, whether its binding still
    /// stands, and what that binding preserves; null when the replica holds
    /// no such document for retained work. Preserved Markdown above the
    /// in-band limit is left out of the result, which keeps its digest and
    /// length; the binding and the covered and merged contributions are
    /// named only by the contribution artifact's digest and length. With
    /// `stream`, which needs a connection that negotiated blobs, the left-out
    /// Markdown or the artifact streams as a blob under the request's ID. An
    /// artifact past what one blob streams has none: the answer says so, and
    /// nothing streams for it. The answer is withheld once the workspace's
    /// live host retires.
    pub(super) async fn sync_held_document(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<ServiceResponse, WireError> {
        let params: HeldDocumentParams = parse(params)?;
        object_id(&params.object_id)?;
        if params.stream.is_some() && !ctx.has_capability("blobs") {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "held document details stream only as a blob",
            ));
        }
        let handle = handle.ok_or_else(workspace_unavailable)?;
        let open = self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let guard = self.live_host_read_guard(ctx, &handle)?;
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
            open.actor.held_document(
                open.workspace_id.clone(),
                params.object_id.clone(),
                cancellation.token(),
            ),
        )
        .await?;
        self.held_documents_open(ctx, &handle, &params.workspace_id)?;
        let Some(inspected) = inspected else {
            return Ok(answer(Value::Null, None));
        };
        let (result, outside) =
            inspection_answer(request_id, &inspected, HELD_RESPONSE_BYTE_BUDGET)?;
        let Some(bytes) = streamed(&inspected, params.stream, outside) else {
            return Ok(answer(result, None));
        };
        let blob = self
            .held_blob_egress(
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

    /// A copy of `bytes` as the blob of request `request_id`, made once the
    /// egress budget holds it and the caller may still have it: the
    /// configured host's connection can end, or the workspace detach, while
    /// the budget waits. Until then the bytes stay the shared inspection's.
    async fn held_blob_egress(
        &self,
        ctx: &RequestContext,
        handle: &WorkspaceHandle,
        workspace_id: &str,
        cancellation: &OperationCancellation,
        bytes: &[u8],
        request_id: u64,
    ) -> Result<BlobEgress, WireError> {
        if bytes.len() > BLOB_EGRESS_BYTE_BUDGET {
            return Err(WireError::new(
                ErrorCode::PayloadTooLarge,
                "held document details exceed the blob limit",
            ));
        }
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

/// What `stream` streams of `inspected`: Markdown its answer leaves out,
/// `outside`, or its contribution artifact. Nothing for an inspection with
/// neither; an artifact too large to stream has none, and the answer says so.
fn streamed(
    inspected: &HeldDocumentInspection,
    stream: Option<HeldStream>,
    outside: bool,
) -> Option<&[u8]> {
    match stream {
        Some(HeldStream::Markdown) if outside => inspected
            .preservation
            .as_ref()
            .and_then(|preservation| preservation.preserved.as_ref())
            .map(|preserved| preserved.markdown.as_bytes()),
        Some(HeldStream::Contributions) => inspected
            .contributions
            .as_ref()
            .and_then(HeldContributions::artifact)
            .map(|artifact| artifact.bytes.as_slice()),
        _ => None,
    }
}

/// A held document as discovery lists it: where it is and which binding
/// holds it, without the binding itself.
fn held_json(document: &HeldDocument) -> Value {
    json!({
        "objectId": document.object_id,
        "path": document.path,
        "bindingDigest": document.binding_digest,
        "continuation": document.continuation.as_str(),
        "bindingStale": document.binding_stale,
    })
}

/// The discovery answer to request `request_id`: the summaries of `page`
/// that fit `budget` bytes of serialized response, in order. A summary that
/// does not fit ends the page and leads the next, where it comes first; its
/// fields are bounded far below the budget, so one that fits no page is
/// corrupt state, never an empty page that claims more.
fn discovery_page(
    request_id: u64,
    page: &HeldDocumentsPage,
    budget: usize,
) -> Result<Value, WireError> {
    // `false` is the longer of the two, so the answer only shrinks.
    let mut size = response_encoded_bytes(request_id, &json!({"documents": [], "hasMore": false}));
    let mut documents = Vec::new();
    for document in &page.documents {
        let summary = held_json(document);
        let comma = usize::from(!documents.is_empty());
        let added = serialized_len(&summary).saturating_add(comma);
        if size.saturating_add(added) > budget {
            break;
        }
        size += added;
        documents.push(summary);
    }
    if documents.is_empty() && !page.documents.is_empty() {
        return Err(over_budget());
    }
    let has_more = page.has_more || documents.len() < page.documents.len();
    Ok(json!({"documents": documents, "hasMore": has_more}))
}

/// The inspection's answer to request `request_id` within `budget` bytes of
/// serialized response, and whether it leaves the preserved Markdown out.
/// Every reason is listed with its exact total; its examples follow in
/// namespace and contribution order, at most [`MAX_REASON_EXAMPLES`] each,
/// while they fit, and the rest are counted as omitted. The status is the
/// preservation's own, taken over every finding.
fn inspection_answer(
    request_id: u64,
    inspected: &HeldDocumentInspection,
    budget: usize,
) -> Result<(Value, bool), WireError> {
    let (mut result, outside) = inspection_outline(inspected);
    let mut size = response_encoded_bytes(request_id, &result);
    if size > budget {
        return Err(over_budget());
    }
    let Some(preservation) = &inspected.preservation else {
        return Ok((result, outside));
    };
    let mut found: Vec<&PreservationFinding> = preservation.findings.iter().collect();
    found.sort_by(|a, b| {
        (a.reason, &a.namespace, &a.contribution).cmp(&(b.reason, &b.namespace, &b.contribution))
    });
    let reasons = result["preservation"]["reasons"]
        .as_array_mut()
        .expect("the outline lists reasons");
    'examples: for (entry, group) in reasons
        .iter_mut()
        .zip(found.chunk_by(|a, b| a.reason == b.reason))
    {
        for (listed, example) in group.iter().take(MAX_REASON_EXAMPLES).enumerate() {
            let example = example_json(example);
            let comma = usize::from(listed > 0);
            let added = serialized_len(&example).saturating_add(comma);
            // A smaller omitted count only shortens the answer.
            if size.saturating_add(added) > budget {
                break 'examples;
            }
            size += added;
            entry["examples"]
                .as_array_mut()
                .expect("the outline lists examples")
                .push(example);
            entry["omitted"] = json!(group.len() - listed - 1);
        }
    }
    Ok((result, outside))
}

/// The inspection with every reason's total and no examples yet, and
/// whether its preserved Markdown is left out: in band only while JSON
/// encodes it within the in-band limit, so it never crowds the budget.
fn inspection_outline(inspected: &HeldDocumentInspection) -> (Value, bool) {
    let mut result = held_json(&inspected.document);
    result["status"] = json!(inspected.status.as_str());
    let (preservation, outside) = match (&inspected.preservation, &inspected.contributions) {
        (Some(preservation), Some(contributions)) => {
            let markdown = preservation
                .preserved
                .as_ref()
                .map(|preserved| preserved.markdown.as_str());
            let outside = markdown.map_or(0, json_string_encoded_len) > MAX_INBAND_CONTENT_BYTES;
            (
                preservation_outline(preservation, contributions, !outside),
                outside,
            )
        }
        _ => (Value::Null, false),
    };
    result["preservation"] = preservation;
    // Resolution is not recorded yet; the round that adds it fills this.
    result["resolution"] = Value::Null;
    (result, outside)
}

/// `preservation`'s outline, naming its merged list by its commitment and
/// its contribution artifact by its digest and length; with no artifact,
/// too large to stream, it names neither of those two and says so.
fn preservation_outline(
    preservation: &Preservation,
    contributions: &HeldContributions,
    inband: bool,
) -> Value {
    let preserved = preservation.preserved.as_ref();
    let (artifact, merged) = (contributions.artifact(), contributions.merged());
    let mut reasons: Vec<_> = preservation
        .findings
        .iter()
        .map(|found| found.reason)
        .collect();
    reasons.sort();
    json!({
        "status": preservation.status.as_str(),
        "reasons": reasons
            .chunk_by(|a, b| a == b)
            .map(|group| json!({
                "reason": group[0].as_str(),
                "status": group[0].status().as_str(),
                "total": group.len(),
                "omitted": group.len(),
                "examples": [],
            }))
            .collect::<Vec<_>>(),
        "mergedContributions": {"count": merged.count, "digest": merged.digest},
        "contributionsSha256": artifact.map(|artifact| artifact.sha256.as_str()),
        "contributionsByteLength": artifact.map(|artifact| artifact.bytes.len()),
        "contributionsTooLarge": artifact.is_none(),
        "markdown": preserved.filter(|_| inband).map(|preserved| preserved.markdown.as_str()),
        "markdownSha256": preserved
            .map(|preserved| dohc_engine_storage::hex_sha256(preserved.markdown.as_bytes())),
        "markdownByteLength": preserved.map(|preserved| preserved.markdown.len()),
        "inbandLimitBytes": MAX_INBAND_CONTENT_BYTES,
    })
}

/// Where one finding is: its tail and contribution, when it has them.
fn example_json(found: &PreservationFinding) -> Value {
    json!({
        "namespace": found.namespace,
        "contribution": found.contribution.as_ref().map(ContributionLocator::to_json),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_collab::live_update_application::ContributionArtifact;
    use dohc_engine_collab::live_update_application::IncomingCoordinate;
    use dohc_engine_collab::live_update_application::PreservationReason;
    use dohc_engine_collab::live_update_application::PreservationStatus;
    use dohc_engine_collab::live_update_application::PreservedState;
    use dohc_engine_collab::live_update_application::ProtectedTail;
    use dohc_engine_collab::live_update_application::ProtectedTails;
    use dohc_engine_collab::live_update_application::ReleasedLineageBinding;
    use dohc_engine_collab::live_update_application::RetainedAuthors;
    use dohc_engine_collab::live_update_application::RetainedContribution;
    use dohc_engine_collab::live_update_application::RetainedCoverage;
    use dohc_engine_collab::live_update_application::Stop;
    use dohc_engine_collab::live_update_application::UnprovenCommitment;
    use dohc_engine_protocol::transport::ConnectionOwner;
    use dohc_engine_sync::HeldBindingStatus;
    use dohc_engine_sync::ReleasedHoldContinuation;

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
            result
                .map(|answer| answer.response.result)
                .unwrap_err()
                .code
        };

        // The host's own connection reaches the store: this one is no hosted
        // replica, so nothing is held there.
        let reached = service
            .sync_held_documents(&ctx, Some(attached_handle.clone()), list("attached"), 1)
            .await
            .unwrap_err();
        assert_eq!(
            (reached.code, reached.message.as_str()),
            (
                ErrorCode::InvalidParams,
                "workspace is not a hosted replica"
            )
        );
        let nothing = service
            .sync_held_document(&ctx, Some(attached_handle.clone()), one("attached"), 2)
            .await
            .unwrap();
        assert!(
            nothing.response.result.is_null() && nothing.blob_egress.is_none(),
            "{nothing:?}"
        );
        // Nothing held streams nothing, whichever stream is asked for.
        let mut reader = RequestContext::unbounded();
        reader.connection = Some(owner.handle());
        reader.capabilities = Arc::from(vec!["blobs".to_owned()]);
        for stream in ["markdown", "contributions"] {
            let params = json!({"workspaceId": "attached", "objectId": "object", "stream": stream});
            let streamed = service
                .sync_held_document(&reader, Some(attached_handle.clone()), params, 2)
                .await
                .unwrap();
            assert!(
                streamed.response.result.is_null() && streamed.blob_egress.is_none(),
                "{stream}"
            );
        }
        // Its answer lapses with the host, as each queued output does.
        let answered = nothing
            .output_guard
            .expect("the live host guards its answer");
        assert!(answered.is_current());
        // Another workspace's ID, a workspace the host did not attach, and a
        // handle that names nothing.
        assert_eq!(
            code(
                service
                    .sync_held_documents(&ctx, Some(attached_handle.clone()), list("private"), 1)
                    .await
            ),
            ErrorCode::InvalidParams
        );
        for foreign in [private_handle.clone(), WorkspaceHandle("foreign".into())] {
            assert_eq!(
                code(
                    service
                        .sync_held_documents(&ctx, Some(foreign.clone()), list("private"), 1)
                        .await
                ),
                ErrorCode::WorkspaceUnavailable
            );
            assert_eq!(
                inspected(
                    service
                        .sync_held_document(&ctx, Some(foreign), one("private"), 3)
                        .await
                ),
                ErrorCode::WorkspaceUnavailable
            );
        }
        // Any other connection, then the host's own once it retired.
        let other = ConnectionOwner::authenticated();
        let mut stranger = RequestContext::unbounded();
        stranger.connection = Some(other.handle());
        assert_eq!(
            code(
                service
                    .sync_held_documents(
                        &stranger,
                        Some(attached_handle.clone()),
                        list("attached"),
                        1
                    )
                    .await
            ),
            ErrorCode::SessionExpired
        );
        assert_eq!(
            inspected(
                service
                    .sync_held_document(
                        &stranger,
                        Some(attached_handle.clone()),
                        one("attached"),
                        4
                    )
                    .await
            ),
            ErrorCode::SessionExpired
        );
        assert_eq!(
            code(
                service
                    .sync_held_documents(
                        &RequestContext::unbounded(),
                        Some(attached_handle.clone()),
                        list("attached"),
                        1
                    )
                    .await
            ),
            ErrorCode::SessionExpired
        );
        owner.retire();
        assert!(
            !answered.is_current(),
            "a retired host's answer is withheld"
        );
        assert_eq!(
            code(
                service
                    .sync_held_documents(&ctx, Some(attached_handle.clone()), list("attached"), 1)
                    .await
            ),
            ErrorCode::SessionExpired
        );
        service
            .workspace_close(Some(attached_handle))
            .await
            .unwrap();
        service.workspace_close(Some(private_handle)).await.unwrap();
    }

    /// A configured host with one attached ordinary workspace, its handle,
    /// and a request context on the host's own connection.
    async fn attached_host(
        root: &dohc_engine_testkit::ScratchDir,
    ) -> (
        Arc<EngineService>,
        (
            ConnectionOwner,
            crate::live_application_ingress::LiveApplicationIngress,
        ),
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
            let mut waiting = std::pin::pin!(service.held_blob_egress(
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
                service.workspace_close(Some(handle.clone())).await.unwrap();
            }
        }
    }

    /// Sol's ruling B, item 4: an inspection's proof runs off the workspace's
    /// actor. While one holds at its snapshot, the host's discovery RPC, which
    /// reads on that actor, completes; the inspection answers once its proof
    /// goes on.
    #[tokio::test]
    async fn host_rpcs_complete_while_an_inspection_proof_holds() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, (_owner, _ingress), ctx, handle) = attached_host(&root).await;
        let proofs = service.open(Some(&handle)).unwrap().actor.held_proofs();
        proofs.pause_proofs();
        let one = json!({"workspaceId": "attached", "objectId": "object"});
        let mut inspecting =
            std::pin::pin!(service.sync_held_document(&ctx, Some(handle.clone()), one, 2));
        tokio::select! {
            () = proofs.paused_proof() => {}
            answered = &mut inspecting => {
                proofs.resume_proofs();
                panic!("the inspection answered before its proof held: {:?}", answered.map(|answer| answer.response.result));
            }
        }
        let listed = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            service.sync_held_documents(
                &ctx,
                Some(handle.clone()),
                json!({"workspaceId": "attached", "limit": 8}),
                3,
            ),
        )
        .await;
        proofs.resume_proofs();
        let refused = listed
            .expect("discovery answers while the proof holds")
            .unwrap_err();
        assert_eq!(
            refused.message, "workspace is not a hosted replica",
            "it reached the actor"
        );
        let answered = inspecting.await.unwrap();
        assert!(
            answered.response.result.is_null(),
            "nothing is held: {answered:?}"
        );
        service.workspace_close(Some(handle)).await.unwrap();
    }

    /// Sol's ruling B, item 6: each caller's own deadline ends only its own
    /// wait. Two callers share a proof held at its snapshot; the one whose
    /// deadline passes answers that, and the other answers once the proof
    /// goes on.
    #[tokio::test]
    async fn each_callers_deadline_ends_only_its_wait() {
        let root = dohc_engine_testkit::ScratchDir::new().unwrap();
        let (service, (_owner, _ingress), ctx, handle) = attached_host(&root).await;
        let proofs = service.open(Some(&handle)).unwrap().actor.held_proofs();
        proofs.pause_proofs();
        let one = json!({"workspaceId": "attached", "objectId": "object"});
        let mut waiting =
            std::pin::pin!(service.sync_held_document(&ctx, Some(handle.clone()), one.clone(), 2));
        tokio::select! {
            () = proofs.paused_proof() => {}
            answered = &mut waiting => {
                proofs.resume_proofs();
                panic!("the inspection answered before its proof held: {:?}", answered.map(|answer| answer.response.result));
            }
        }
        let mut bounded = ctx.clone();
        bounded.deadline = Some(std::time::Instant::now() + std::time::Duration::from_secs(2));
        let mut expiring =
            std::pin::pin!(service.sync_held_document(&bounded, Some(handle.clone()), one, 3));
        tokio::select! {
            () = proofs.callers("attached", 2) => {}
            answered = &mut expiring => {
                proofs.resume_proofs();
                panic!("the second caller answered before it joined: {:?}", answered.map(|answer| answer.response.result));
            }
        }
        let expired = expiring
            .await
            .map(|answer| answer.response.result)
            .unwrap_err();
        assert_eq!(expired.code, ErrorCode::DeadlineExceeded, "{expired:?}");
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(
            std::future::Future::poll(waiting.as_mut(), &mut context).is_pending(),
            "the other caller still waits"
        );
        proofs.resume_proofs();
        let answered = waiting.await.unwrap();
        assert!(
            answered.response.result.is_null(),
            "nothing is held: {answered:?}"
        );
        service.workspace_close(Some(handle)).await.unwrap();
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
            let refused = service
                .sync_held_documents(&ctx, None, params.clone(), 1)
                .await
                .unwrap_err();
            assert_eq!(refused.code, ErrorCode::InvalidParams, "{params}");
        }
        // Either stream needs a connection that reads blobs, and nothing else
        // streams.
        for params in [
            json!({"workspaceId": "w", "objectId": ""}),
            json!({"workspaceId": "w", "objectId": "o", "stream": "markdown"}),
            json!({"workspaceId": "w", "objectId": "o", "stream": "contributions"}),
            json!({"workspaceId": "w", "objectId": "o", "stream": "binding"}),
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

    fn binding(object_id: &str, path: &str, tails: ProtectedTails) -> ReleasedLineageBinding {
        ReleasedLineageBinding {
            workspace_id: "attached".into(),
            main_version_id: "main".into(),
            object_id: object_id.into(),
            lineage_claim_id: "a".repeat(64),
            current_path: Some(path.into()),
            restore_generation: Some(0),
            incoming: IncomingCoordinate {
                relay_namespace: Some("relay".into()),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "desktop".into(),
                origin_seq: 1,
                relay_seq: 3,
            },
            head_digest: "b".repeat(64),
            tails: Arc::new(tails),
        }
    }

    /// The hold of `binding`'s document, as its row names it.
    fn held_by(binding: &ReleasedLineageBinding) -> HeldDocument {
        HeldDocument {
            object_id: binding.object_id.clone(),
            path: binding.current_path.clone().unwrap(),
            binding_digest: binding.digest(),
            continuation: ReleasedHoldContinuation::Frozen,
            binding_stale: false,
        }
    }

    fn held(object_id: &str, path: &str, tails: ProtectedTails) -> HeldDocument {
        held_by(&binding(object_id, path, tails))
    }

    /// The `index`th contribution of a large hold, its identities as long as
    /// the engine mints them, made by an agent for the owner or by nobody.
    fn contribution(index: usize) -> RetainedContribution {
        let agent = dohc_engine_domain::ChangeAttribution {
            actor_kind: dohc_engine_domain::ChangeActorKind::Agent,
            on_behalf_of: Some("owner".into()),
            depth: 1,
            run: None,
        };
        let actor = format!("agent-{index}");
        let authors = if index % 2 == 0 {
            RetainedAuthors::credited(Some(actor.as_str()), Some(&agent))
        } else {
            RetainedAuthors::credited(None, None)
        };
        let digest = dohc_engine_storage::hex_sha256(index.to_string().as_bytes());
        RetainedContribution::Outbox {
            outbox_id: format!("owner-outbox-{}", "f".repeat(64)),
            sequence: index as i64 + 1,
            delivery_id: format!("owner-delivery-{digest}"),
            update_digest: digest,
            authors: authors.unwrap(),
        }
    }

    fn inspection(
        binding: &ReleasedLineageBinding,
        preservation: Preservation,
    ) -> HeldDocumentInspection {
        let contributions = ContributionArtifact::of(binding, &preservation, Stop::NEVER)
            .unwrap()
            .expect("within its cap");
        HeldDocumentInspection {
            document: held_by(binding),
            status: HeldBindingStatus::Current,
            preservation: Some(preservation),
            contributions: Some(HeldContributions::Artifact(contributions)),
        }
    }

    /// Sol's ruling B, item 1: discovery lists summaries, never bindings, as
    /// many as fit the budget, and claims more only with one listed. Reading
    /// on after the last one listed reaches every held document once, a
    /// summary that fits only a page of its own included; one that fits no
    /// page is corrupt state, not an empty page that claims more.
    #[test]
    fn discovery_pages_by_bytes_and_always_progresses() {
        let mut all: Vec<_> = (0..40)
            .map(|index| {
                held(
                    &format!("object-{index:02}"),
                    &format!("docs/{index}.md"),
                    ProtectedTails::Invalid,
                )
            })
            .collect();
        // Escaping multiplies this path sixfold.
        all[17].path = "\u{1}".repeat(500);
        let alone = response_encoded_bytes(
            7,
            &json!({"documents": [held_json(&all[17])], "hasMore": false}),
        );
        let one = serialized_len(&held_json(&all[0]));
        // Room for that summary alone, and not beside any other.
        let budget = alone + one / 2;
        let (mut listed, mut after, mut pages) = (Vec::new(), None::<String>, Vec::new());
        loop {
            // What the store answers: up to its largest page after the cursor.
            let rest: Vec<_> = all
                .iter()
                .filter(|document| {
                    after
                        .as_deref()
                        .is_none_or(|after| document.object_id.as_str() > after)
                })
                .cloned()
                .collect();
            let page = HeldDocumentsPage {
                has_more: rest.len() > MAX_HELD_DOCUMENTS_PAGE,
                documents: rest.into_iter().take(MAX_HELD_DOCUMENTS_PAGE).collect(),
            };
            let answer = discovery_page(7, &page, budget).unwrap();
            assert!(response_encoded_bytes(7, &answer) <= budget, "{answer}");
            let documents: Vec<String> = answer["documents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|summary| {
                    assert!(summary.get("binding").is_none(), "{summary}");
                    summary["objectId"].as_str().unwrap().to_owned()
                })
                .collect();
            if answer["hasMore"] == false {
                listed.extend(documents.iter().cloned());
                pages.push(documents);
                break;
            }
            assert!(
                !documents.is_empty(),
                "a page that claims more lists something"
            );
            after = documents.last().cloned();
            listed.extend(documents.iter().cloned());
            pages.push(documents);
        }
        let ids: Vec<_> = all
            .iter()
            .map(|document| document.object_id.clone())
            .collect();
        assert_eq!(listed, ids);
        assert!(pages.contains(&vec!["object-17".to_owned()]), "{pages:?}");
        assert!(pages.len() > 3, "the budget ended pages: {pages:?}");

        let lone = HeldDocumentsPage {
            documents: vec![all[17].clone()],
            has_more: true,
        };
        assert_eq!(
            discovery_page(7, &lone, alone - 1).unwrap_err().message,
            "state-corrupt"
        );
    }

    /// Sol's ruling B, item 3: however many findings there are, each reason
    /// lists its exact total and at most eight of them, in namespace and
    /// contribution order, while they fit; the status is the worst over every
    /// finding, a reason the budget left without an example included.
    #[test]
    fn findings_list_a_few_examples_per_reason_with_exact_totals_and_the_worst_status() {
        let located = |reason, namespace: Option<&str>, index: Option<usize>| PreservationFinding {
            reason,
            namespace: namespace.map(str::to_owned),
            contribution: index.map(|index| contribution(index).locator()),
        };
        // Found out of order: the answer orders them.
        let mut findings: Vec<_> = (0..50_000)
            .rev()
            .map(|index| {
                let namespace = if index % 2 == 0 { "relay-b" } else { "relay-a" };
                located(
                    PreservationReason::SourceMissing,
                    Some(namespace),
                    Some(index),
                )
            })
            .collect();
        findings.push(located(
            PreservationReason::MalformedAuthorship,
            Some("relay-c"),
            Some(1),
        ));
        findings.push(located(
            PreservationReason::PendingContributionDependencies,
            None,
            None,
        ));
        let inspected = inspection(
            &binding("object", "docs/object.md", ProtectedTails::Invalid),
            Preservation {
                status: PreservationStatus::InvalidEvidence,
                findings,
                covered: Vec::new(),
                merged: Vec::new(),
                preserved: None,
            },
        );
        let summary = |answer: &Value| -> Vec<(String, String, u64, u64, usize)> {
            answer["preservation"]["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .map(|reason| {
                    (
                        reason["reason"].as_str().unwrap().to_owned(),
                        reason["status"].as_str().unwrap().to_owned(),
                        reason["total"].as_u64().unwrap(),
                        reason["omitted"].as_u64().unwrap(),
                        reason["examples"].as_array().unwrap().len(),
                    )
                })
                .collect()
        };
        let row = |reason: &str, status: &str, total: u64, omitted: u64, examples: usize| {
            (
                reason.to_owned(),
                status.to_owned(),
                total,
                omitted,
                examples,
            )
        };

        let (answer, outside) =
            inspection_answer(7, &inspected, HELD_RESPONSE_BYTE_BUDGET).unwrap();
        assert!(!outside);
        assert!(response_encoded_bytes(7, &answer) <= HELD_RESPONSE_BYTE_BUDGET);
        assert_eq!(answer["preservation"]["status"], "invalid-evidence");
        assert_eq!(
            summary(&answer),
            [
                row("source-missing", "missing-evidence", 50_000, 49_992, 8),
                row(
                    "pending-contribution-dependencies",
                    "pending-dependencies",
                    1,
                    0,
                    1
                ),
                row("malformed-authorship", "invalid-evidence", 1, 0, 1),
            ]
        );
        // relay-a's work sorts first, by sequence.
        let expected: Vec<_> = (0..8)
            .map(|nth| json!({"namespace": "relay-a", "contribution": contribution(2 * nth + 1).locator().to_json()}))
            .collect();
        assert_eq!(
            answer["preservation"]["reasons"][0]["examples"],
            json!(expected)
        );

        // Room for the totals and two examples: the first reason's, and the
        // worst reason keeps its total, its status and the preservation's.
        let (outline, _) = inspection_outline(&inspected);
        let two = serialized_len(&expected[0]) + 1 + serialized_len(&expected[1]);
        let budget = response_encoded_bytes(7, &outline) + two;
        let (answer, _) = inspection_answer(7, &inspected, budget).unwrap();
        assert!(response_encoded_bytes(7, &answer) <= budget);
        assert_eq!(answer["preservation"]["status"], "invalid-evidence");
        assert_eq!(
            summary(&answer),
            [
                row("source-missing", "missing-evidence", 50_000, 49_998, 2),
                row(
                    "pending-contribution-dependencies",
                    "pending-dependencies",
                    1,
                    1,
                    0
                ),
                row("malformed-authorship", "invalid-evidence", 1, 1, 0),
            ]
        );
        // Room for the totals alone lists no example.
        let (answer, _) =
            inspection_answer(7, &inspected, response_encoded_bytes(7, &outline)).unwrap();
        assert_eq!(answer, outline);
        assert_eq!(answer["preservation"]["status"], "invalid-evidence");
        assert_eq!(
            inspection_answer(7, &inspected, response_encoded_bytes(7, &outline) - 1)
                .unwrap_err()
                .message,
            "state-corrupt"
        );
    }

    /// Sol's ruling B: a hold covering 50,000 contributions, every one
    /// merged, answers within the response budget, and its contribution
    /// artifact names every one with its authors, none left out.
    #[test]
    fn a_large_hold_answers_within_budget_and_its_artifact_keeps_every_contribution() {
        let covered: Vec<_> = (0..50_000).map(contribution).collect();
        let committed = UnprovenCommitment::of(covered.clone()).unwrap();
        let tail = ProtectedTail {
            namespace: "relay".into(),
            activation_id: "activation".into(),
            release: None,
            coverage: RetainedCoverage::Unproven(committed.clone()),
        };
        let bound = binding(
            "object",
            "docs/object.md",
            ProtectedTails::Listed(vec![tail]),
        );
        let inspected = inspection(
            &bound,
            Preservation {
                status: PreservationStatus::Complete,
                findings: Vec::new(),
                covered: vec![("relay".into(), covered.clone())],
                merged: covered.clone(),
                preserved: Some(PreservedState {
                    markdown: "# Plan\n".repeat(10_000),
                    full_state: Vec::new(),
                }),
            },
        );
        let (answer, outside) =
            inspection_answer(7, &inspected, HELD_RESPONSE_BYTE_BUDGET).unwrap();
        assert!(response_encoded_bytes(7, &answer) <= HELD_RESPONSE_BYTE_BUDGET);
        assert!(outside, "the text streams");
        let artifact = inspected
            .contributions
            .as_ref()
            .and_then(HeldContributions::artifact)
            .unwrap();
        let preservation = &answer["preservation"];
        assert_eq!(preservation["markdown"], Value::Null);
        assert_eq!(
            preservation["contributionsSha256"],
            dohc_engine_storage::hex_sha256(&artifact.bytes)
        );
        assert_eq!(
            preservation["contributionsByteLength"],
            artifact.bytes.len()
        );
        // Every contribution merged: the merged list commits as the tail does.
        assert_eq!(
            preservation["mergedContributions"],
            json!({"count": 50_000, "digest": committed.digest})
        );
        assert!(
            artifact.bytes.len() <= BLOB_EGRESS_BYTE_BUDGET,
            "{} bytes stream",
            artifact.bytes.len()
        );

        let listed: Value = serde_json::from_slice(&artifact.bytes).unwrap();
        let every: Vec<_> = covered.iter().map(RetainedContribution::to_json).collect();
        assert_eq!(listed["version"], 1);
        assert_eq!(listed["binding"], bound.to_json());
        assert_eq!(
            listed["coveredContributions"],
            json!([{"namespace": "relay", "contributions": every}])
        );
        let read: Vec<_> = listed["mergedContributionIds"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| RetainedContribution::from_json(value).unwrap())
            .collect();
        assert_eq!(read, covered, "every identity, with its authors");
        assert_eq!(
            ReleasedLineageBinding::from_json(&listed["binding"])
                .unwrap()
                .digest(),
            answer["bindingDigest"]
        );
    }

    /// The merged list's digest is the commitment encoding's, the empty
    /// list's included, and never the artifact's own SHA-256.
    #[test]
    fn the_merged_list_commits_even_when_empty() {
        let inspected = inspection(
            &binding("object", "docs/object.md", ProtectedTails::Invalid),
            Preservation {
                status: PreservationStatus::InvalidEvidence,
                findings: vec![PreservationFinding {
                    reason: PreservationReason::ContradictoryEvidence,
                    namespace: None,
                    contribution: None,
                }],
                covered: Vec::new(),
                merged: Vec::new(),
                preserved: None,
            },
        );
        let (answer, _) = inspection_answer(7, &inspected, HELD_RESPONSE_BYTE_BUDGET).unwrap();
        let mut empty = b"dohc:released-tail-contributions:v2\0".to_vec();
        empty.extend_from_slice(b"[]");
        let merged = &answer["preservation"]["mergedContributions"];
        assert_eq!(
            *merged,
            json!({"count": 0, "digest": dohc_engine_storage::hex_sha256(&empty)})
        );
        assert_ne!(
            merged["digest"],
            answer["preservation"]["contributionsSha256"]
        );
        let artifact = inspected
            .contributions
            .as_ref()
            .and_then(HeldContributions::artifact)
            .unwrap();
        let listed: Value = serde_json::from_slice(&artifact.bytes).unwrap();
        assert_eq!(listed["coveredContributions"], json!([]));
        assert_eq!(listed["mergedContributionIds"], json!([]));
        assert_eq!(answer["preservation"]["contributionsTooLarge"], false);
    }

    /// Opus's r2c-3c-6 finding 1: an inspection whose artifact would pass
    /// what one blob streams still answers its preservation, outline and
    /// Markdown alike, and names no artifact, saying it is too large. Its
    /// Markdown streams; its contributions stream nothing. Opus's r2c-3c-8
    /// finding 4: its merged list's commitment still answers.
    #[test]
    fn an_artifact_too_large_to_stream_leaves_the_preservation_answering() {
        let markdown = "# Plan\n".repeat(10_000);
        let merged: Vec<_> = (0..3).map(contribution).collect();
        let committed = UnprovenCommitment::of_listed(&merged);
        let bound = binding("object", "docs/object.md", ProtectedTails::Invalid);
        let inspected = HeldDocumentInspection {
            document: held_by(&bound),
            status: HeldBindingStatus::Current,
            preservation: Some(Preservation {
                status: PreservationStatus::Complete,
                findings: Vec::new(),
                covered: Vec::new(),
                merged,
                preserved: Some(PreservedState {
                    markdown: markdown.clone(),
                    full_state: Vec::new(),
                }),
            }),
            contributions: Some(HeldContributions::TooLarge {
                merged: committed.clone(),
            }),
        };
        let (answer, outside) =
            inspection_answer(7, &inspected, HELD_RESPONSE_BYTE_BUDGET).unwrap();
        assert!(outside, "the text streams");
        let preservation = &answer["preservation"];
        assert_eq!(answer["status"], "current");
        assert_eq!(preservation["status"], "complete");
        assert_eq!(preservation["contributionsTooLarge"], true);
        assert_eq!(
            preservation["mergedContributions"],
            json!({"count": 3, "digest": committed.digest})
        );
        for absent in ["contributionsSha256", "contributionsByteLength"] {
            assert_eq!(preservation[absent], Value::Null, "{absent}");
        }
        assert_eq!(
            preservation["markdownSha256"],
            dohc_engine_storage::hex_sha256(markdown.as_bytes())
        );
        assert_eq!(preservation["markdownByteLength"], markdown.len());
        assert_eq!(
            streamed(&inspected, Some(HeldStream::Markdown), outside),
            Some(markdown.as_bytes())
        );
        assert_eq!(
            streamed(&inspected, Some(HeldStream::Contributions), outside),
            None
        );
    }
}
