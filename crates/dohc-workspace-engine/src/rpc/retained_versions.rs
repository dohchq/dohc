//! `documents.keepRetainedVersion`: keep the version a hosted replica holds
//! for a released chain as an ordinary file of this workspace. Any trusted
//! connection to the workspace may ask, an agent's included. It creates local
//! work and publishes it like any other file; it grants no authority over
//! the hosted document, which only the host's resolution changes.
use crate::EngineService;
use crate::rpc::error::map_runtime;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::workspace::validate_workspace_param;
use base64::Engine as _;
use dohc_engine_collab::live_update_application::ReleasedLineageBinding;
use dohc_engine_collab::live_update_application::RetainedContribution;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_sync::KeepRetainedVersion;
use dohc_engine_sync::KeptRetainedVersion;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

/// What a held document's inspection said, as the owner passes it on. The
/// Markdown travels as base64 so a copy past the in-band limit fits a
/// request as `versionedText.writeBlob`'s body does.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeepRetainedVersionParams {
    workspace_id: String,
    binding: Value,
    markdown_base64: String,
    projection_sha256: String,
    projection_byte_length: usize,
    preservation: String,
    covered_contributions: Vec<CoveredParams>,
    merged_contribution_ids: Vec<Value>,
}

/// One tail's covered work, as inspection reported it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CoveredParams {
    namespace: String,
    contributions: Vec<Value>,
}

fn invalid(message: &'static str) -> WireError {
    WireError::new(ErrorCode::InvalidParams, message)
}

fn contributions(values: &[Value]) -> Option<Vec<RetainedContribution>> {
    values.iter().map(RetainedContribution::from_json).collect()
}

/// The request's copy, checked against itself before anything opens.
fn keep_request(
    params: KeepRetainedVersionParams,
) -> Result<(String, KeepRetainedVersion), WireError> {
    let binding = ReleasedLineageBinding::from_json(&params.binding)
        .ok_or_else(|| invalid("invalid binding"))?;
    // Only a complete preservation carries text to keep.
    if params.preservation != "complete" {
        return Err(invalid("preservation is not complete"));
    }
    let merged_contribution_ids = contributions(&params.merged_contribution_ids)
        .ok_or_else(|| invalid("invalid merged contribution"))?;
    if !merged_contribution_ids
        .windows(2)
        .all(|pair| pair[0] < pair[1])
    {
        return Err(invalid("merged contributions are not in canonical order"));
    }
    // The store checks them against the binding's commitments.
    let covered_contributions = params
        .covered_contributions
        .iter()
        .map(|covered| {
            Some((
                covered.namespace.clone(),
                contributions(&covered.contributions)?,
            ))
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| invalid("invalid covered contribution"))?;
    if params.projection_byte_length > dohc_engine_domain::MAX_TEXT_BYTES
        || params.markdown_base64.len() > params.projection_byte_length.div_ceil(3) * 4
    {
        return Err(invalid("content-exceeds-capture-cap"));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&params.markdown_base64)
        .map_err(|_| invalid("invalid-input"))?;
    if bytes.len() != params.projection_byte_length
        || dohc_engine_storage::hex_sha256(&bytes) != params.projection_sha256
    {
        return Err(invalid("markdown does not match its digest"));
    }
    let markdown = String::from_utf8(bytes).map_err(|_| invalid("invalid-utf8"))?;
    Ok((
        params.workspace_id,
        KeepRetainedVersion {
            binding,
            markdown,
            projection_sha256: params.projection_sha256,
            covered_contributions,
            merged_contribution_ids,
            now_ms: now_ms()?,
        },
    ))
}

impl EngineService {
    pub(super) async fn documents_keep_retained_version(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let (workspace_id, input) = keep_request(parse(params)?)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&workspace_id), &open.workspace_id)?;
        if input.binding.workspace_id != open.workspace_id {
            return Err(invalid("the binding names another workspace"));
        }
        let cancellation = OperationCancellation::new(ctx);
        let session_serial = self
            .mutation_session_guard(
                &open,
                &cancellation,
                "documents.keepRetainedVersion (queued)",
            )
            .await?;
        let kept = open
            .actor
            .keep_retained_version(
                open.workspace_id.clone(),
                input,
                open.root.clone(),
                Arc::new(self.self_writes.scoped(&open.root)),
            )
            .await
            .map_err(map_runtime);
        drop(session_serial);
        Ok(kept_json(&kept?))
    }
}

fn kept_json(kept: &KeptRetainedVersion) -> Value {
    let publication = &kept.publication;
    json!({
        "bindingDigest": kept.binding_digest,
        "attempt": kept.attempt,
        "recoveryObjectId": kept.recovery_object_id,
        "recoveryMomentId": kept.recovery_moment_id,
        "recoveredPath": kept.recovered_path,
        "created": kept.created,
        "publication": {
            "state": publication.state.as_str(),
            "originId": publication.origin_id,
            "originSeq": publication.origin_seq,
            "relaySeq": publication.relay_seq,
        },
        "mergedContributionIds": kept
            .merged_contribution_ids
            .iter()
            .map(RetainedContribution::to_json)
            .collect::<Vec<_>>(),
        "authors": serde_json::from_str::<Value>(&kept.recovery_author_json)
            .unwrap_or(Value::Null),
        "resolution": kept.resolution.map(|(outcome, at_ms)| json!({
            "outcome": outcome.as_str(),
            "atMs": at_ms,
        })),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding() -> Value {
        json!({
            "version": 3, "workspaceId": "ws", "mainVersionId": "main", "objectId": "object",
            "lineageClaimId": "a".repeat(64), "currentPath": "notes/plan.md", "restoreGeneration": 0,
            "incoming": {"relayNamespace": "relay", "replicationEpoch": "epoch", "streamIdentity": "stream",
                "originId": "desktop", "originSeq": 1, "relaySeq": 3},
            "headDigest": "b".repeat(64),
            "tails": [{"namespace": "relay", "activationId": "activation",
                "release": {"path": "notes/plan.md", "restoreGeneration": 0},
                "unproven": {"count": 1, "digest": "c".repeat(64)}}],
        })
    }

    fn outbox(sequence: i64) -> Value {
        json!({"kind": "outbox", "outboxId": "outbox", "sequence": sequence,
            "deliveryId": format!("delivery-{sequence}"), "updateDigest": "d".repeat(64),
            "authors": [{"kind": "agent", "agentId": "trip-agent", "onBehalfOf": "owner", "depth": 1}]})
    }

    fn params(markdown: &[u8]) -> Value {
        json!({
            "workspaceId": "ws",
            "binding": binding(),
            "markdownBase64": base64::engine::general_purpose::STANDARD.encode(markdown),
            "projectionSha256": dohc_engine_storage::hex_sha256(markdown),
            "projectionByteLength": markdown.len(),
            "preservation": "complete",
            "coveredContributions": [{"namespace": "relay", "contributions": [outbox(1), outbox(2), outbox(3)]}],
            "mergedContributionIds": [outbox(1), outbox(2)],
        })
    }

    fn refused(value: Value) -> String {
        let parsed: KeepRetainedVersionParams = match parse(value) {
            Ok(parsed) => parsed,
            Err(error) => return error.message,
        };
        keep_request(parsed).map(|_| ()).unwrap_err().message
    }

    /// Plan r3, copy creation: text past the in-band limit arrives whole,
    /// with the binding, digest and contributions it was inspected with.
    #[test]
    fn a_copy_past_the_inband_limit_arrives_whole() {
        let markdown = "# Plan\n\n".to_owned() + &"Kept paragraph.\n\n".repeat(8 * 1024);
        assert!(markdown.len() > 96 * 1024);
        let (workspace_id, input) =
            keep_request(parse(params(markdown.as_bytes())).unwrap()).unwrap();
        assert_eq!(workspace_id, "ws");
        assert_eq!(input.markdown, markdown);
        assert_eq!(
            input.projection_sha256,
            dohc_engine_storage::hex_sha256(markdown.as_bytes())
        );
        assert_eq!(input.binding.to_json(), binding());
        assert_eq!(
            input
                .merged_contribution_ids
                .iter()
                .map(RetainedContribution::to_json)
                .collect::<Vec<_>>(),
            vec![outbox(1), outbox(2)]
        );
        let [(namespace, covered)] = input.covered_contributions.as_slice() else {
            panic!("one tail: {:?}", input.covered_contributions);
        };
        assert_eq!(namespace, "relay");
        assert_eq!(
            covered
                .iter()
                .map(RetainedContribution::to_json)
                .collect::<Vec<_>>(),
            vec![outbox(1), outbox(2), outbox(3)],
            "with their authors"
        );
    }

    /// Each part of the request must agree with the rest before the store is
    /// asked: the text with its digest and length, the binding with its
    /// contract, the preservation with a complete one, and the contributions
    /// with canonical order.
    #[test]
    fn a_copy_that_disagrees_with_itself_is_refused() {
        let text = b"# Plan\n";
        let with = |edit: &dyn Fn(&mut Value)| {
            let mut value = params(text);
            edit(&mut value);
            refused(value)
        };
        assert_eq!(
            with(&|value| value["projectionSha256"] = json!("e".repeat(64))),
            "markdown does not match its digest"
        );
        assert_eq!(
            with(&|value| value["projectionByteLength"] = json!(text.len() + 1)),
            "markdown does not match its digest"
        );
        assert_eq!(
            with(&|value| value["markdownBase64"] = json!("not base64!")),
            "invalid-input"
        );
        assert_eq!(
            with(&|value| value["preservation"] = json!("missing-evidence")),
            "preservation is not complete"
        );
        assert_eq!(
            with(&|value| value["binding"]["version"] = json!(1)),
            "invalid binding"
        );
        assert_eq!(
            with(&|value| value["binding"]["extra"] = json!(true)),
            "invalid binding"
        );
        assert_eq!(
            with(&|value| value["mergedContributionIds"] = json!([outbox(2), outbox(1)])),
            "merged contributions are not in canonical order"
        );
        assert_eq!(
            with(&|value| value["mergedContributionIds"] = json!([outbox(1), outbox(1)])),
            "merged contributions are not in canonical order"
        );
        assert_eq!(
            with(&|value| value["mergedContributionIds"] = json!([{"kind": "outbox"}])),
            "invalid merged contribution"
        );
        assert_eq!(
            with(&|value| {
                value["mergedContributionIds"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("authors");
            }),
            "invalid merged contribution"
        );
        assert_eq!(
            with(
                &|value| value["coveredContributions"][0]["contributions"][0]["sequence"] =
                    json!(0)
            ),
            "invalid covered contribution"
        );
        assert_eq!(
            with(
                &|value| value["coveredContributions"][0]["contributions"][1]["authors"] =
                    json!([])
            ),
            "invalid covered contribution"
        );
        assert_eq!(
            with(&|value| {
                value
                    .as_object_mut()
                    .unwrap()
                    .remove("coveredContributions");
            }),
            "invalid parameters"
        );
        assert_eq!(
            with(&|value| value["projectionByteLength"] =
                json!(dohc_engine_domain::MAX_TEXT_BYTES + 1)),
            "content-exceeds-capture-cap"
        );
        assert_eq!(
            with(&|value| value["markdown"] = json!("# Plan\n")),
            "invalid parameters"
        );
        let invalid_utf8 = [0xff_u8, 0xfe];
        assert_eq!(refused(params(&invalid_utf8)), "invalid-utf8");
    }

    /// Keeping a copy creates owner work on the owner's own store. A session
    /// host holds the hosted document and must not create the copy itself,
    /// for any workspace it attached, even through its own connection.
    #[tokio::test]
    async fn a_session_host_cannot_keep_a_copy() {
        let attached = dohc_engine_testkit::ScratchDir::new().unwrap();
        let config = serde_json::from_value(json!({
            "version": 1, "relayNamespace": "relay",
            "host": {"hostId": "host", "hostEpoch": 1, "instanceId": "instance", "connectionId": "connection"},
            "workspaces": [
                {"root": attached.path(), "workspaceId": "ws", "maxRegistrations": 4,
                    "relay": {"baseUrl": "https://relay.example", "bearerToken": "actual-owner-credential"}}
            ],
            "ingress": {"aggregateBytes": 512 * 1024 * 1024, "applicationWorkingReserveBytes": 8 * 1024 * 1024,
                "maxUploads": 2, "uploadDeadlineMs": 30_000}
        }))
        .unwrap();
        let (service, owner, _ingress) = EngineService::configured_live_host(config).await.unwrap();
        let mut ctx = RequestContext::unbounded();
        ctx.connection = Some(owner.handle());
        let request = |method: &str, workspace: Option<WorkspaceHandle>, params: Value| {
            dohc_engine_protocol::wire::Request {
                id: 1,
                method: method.into(),
                workspace,
                deadline_ms: None,
                idempotency_key: None,
                progress: false,
                params,
            }
        };
        let discovery = service
            .configured_live_hosts(&ctx, &request("liveApplication.hosts", None, json!({})))
            .unwrap();
        let handle: WorkspaceHandle =
            serde_json::from_value(discovery["workspaces"][0]["workspaceHandle"].clone()).unwrap();
        let refused = service
            .dispatch(
                ctx,
                request(
                    "documents.keepRetainedVersion",
                    Some(handle.clone()),
                    params(b"# Plan\n"),
                ),
            )
            .await
            .expect_err("refused");
        assert_eq!(
            (refused.code, refused.message.as_str()),
            (
                ErrorCode::Forbidden,
                "configured host method is unavailable"
            )
        );
        service.workspace_close(Some(handle)).await.unwrap();
    }
}
