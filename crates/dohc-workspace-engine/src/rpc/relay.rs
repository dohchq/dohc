use crate::EngineService;
use crate::events::emit_record_events;
use crate::lock;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::RelayConfiguration;
use dohc_engine_runtime::RelayOperation;
use dohc_engine_runtime::RelayOperationOutcome;
use dohc_engine_sync::RelayCursor;
use dohc_engine_sync::ShareCursor;
use dohc_engine_sync::SyncPassOutcome;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[derive(Clone)]
pub(super) enum IssuedCursor {
    Relay(RelayCursor),
    ShareView(ShareCursor),
}

#[derive(Clone)]
pub(crate) struct PendingCursor {
    pub(super) handle: WorkspaceHandle,
    pub(crate) workspace_id: String,
    pub(super) cursor: IssuedCursor,
    pub(super) materialization_paths: Vec<dohc_engine_sync::MomentMaterializationChange>,
    pub(super) materialized: bool,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelayOpenParams {
    base_url: String,
    bearer_token: String,
    #[cfg(debug_assertions)]
    #[serde(default)]
    allow_insecure_loopback_for_tests: bool,
}

impl RelayOpenParams {
    pub(super) fn configuration(&self) -> RelayConfiguration {
        RelayConfiguration {
            base_url: self.base_url.clone(),
            bearer_token: self.bearer_token.clone(),
            #[cfg(debug_assertions)]
            allow_insecure_loopback_for_tests: self.allow_insecure_loopback_for_tests,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RelayWorkspaceParams {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptJoinIdentityParams {
    workspace_id: String,
    replication_epoch: String,
    stream_identity: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommitCursorParams {
    workspace_id: String,
    pending_cursor: PendingCursorParams,
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum PendingCursorParams {
    Relay { token: String },
    ShareView { token: String },
}

#[derive(Clone, Copy)]
enum PendingCursorKind {
    Relay,
    ShareView,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyEnvelopeUploadParams {
    workspace_id: String,
    envelope_json: String,
    #[serde(default)]
    if_match: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SharedChannelParams {
    workspace_id: String,
    share_id: String,
    channel_wire_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareViewParams {
    workspace_id: String,
    share_id: String,
    /// The selector the relay stated for this share, pinned by the caller on
    /// first read. Required, and required as an object: absent and explicit
    /// `null` both parse as "no scope", which is the one pull nothing checks.
    /// Serde refuses either — a caller with no selector must resolve one
    /// before it pulls.
    granted_selector: GrantedSelectorParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareViewEnrollParams {
    workspace_id: String,
    /// Required, for the level it carries. Recording is a level decision, and
    /// a caller that cannot state the level must not record one.
    granted_selector: GrantedSelectorParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareProposalSubmitParams {
    workspace_id: String,
    share_id: String,
    /// Required, and required as an object, for the same reason the pull
    /// requires it: a submit with no scope offers everything this replica
    /// wrote, and the level inside it is what the client refuses below `edit`
    /// on.
    granted_selector: GrantedSelectorParams,
    /// The idempotency key for one submit. No default: a generated-per-attempt
    /// id would open a second proposal on every retry of the same intent.
    submit_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareDirectPushParams {
    workspace_id: String,
    share_id: String,
    /// Required, for the same reason the submit requires it: the grant scopes
    /// what this replica may write, and its level decides whether it may.
    granted_selector: GrantedSelectorParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantedSelectorParams {
    paths: Vec<String>,
    #[serde(default)]
    version_id: Option<String>,
    // Required (#646 PR1): the level the caller pinned from the relay's own
    // selector. No default here — a grant whose level cannot be read is not
    // a narrower grant, it is an unreadable one, and `share_view_pull` below
    // refuses it rather than substituting a default.
    access: String,
}

fn direct_write_json(write: &dohc_engine_sync::DirectWriteReport) -> Value {
    match &write.result {
        dohc_engine_sync::DirectWriteResult::Written => json!({
            "paths": write.paths,
            "result": "written",
        }),
        dohc_engine_sync::DirectWriteResult::Stale {
            path,
            current_blob_sha256,
        } => json!({
            "paths": write.paths,
            "result": "stale",
            "stalePath": path,
            "currentBlobSha256": current_blob_sha256,
        }),
        dohc_engine_sync::DirectWriteResult::Refused { reason } => json!({
            "paths": write.paths,
            "result": "refused",
            "reason": reason,
        }),
    }
}

fn relay_cursor_json(cursor: &RelayCursor) -> Value {
    json!({
        "kind": "relay",
        "cursor": cursor.cursor,
        "replicationEpoch": cursor.replication_epoch,
        "streamIdentity": cursor.stream_identity,
    })
}

fn sync_outcome_json(outcome: SyncPassOutcome) -> Value {
    match outcome {
        SyncPassOutcome::Complete {
            owner_admission_pending,
            pushed,
            fetched,
            has_more,
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor,
            changed_paths,
            refusals,
            sharing_declined,
            // Record facts ride the engine event channel, not the wire result.
            record_facts: _,
        } => json!({
            "status": "complete",
            "ownerAdmissionPending":owner_admission_pending,
            "pushed": pushed,
            "fetched": fetched,
            "hasMore": has_more,
            "applied": applied,
            "refused": refused,
            "skipped": skipped,
            "conflictsOpened": conflicts_opened,
            "nextCursor": pending_cursor.as_ref().map(|cursor| cursor.cursor),
            "pendingCursor": pending_cursor.as_ref().map(relay_cursor_json),
            "changedPaths": changed_paths.iter().map(|change| json!({
                "versionId": change.version_id,
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })).collect::<Vec<_>>(),
            "refusals": refusals.into_iter().map(|refusal| json!({
                "workspaceId": refusal.workspace_id,
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.reason.code(),
                "reason": refusal.reason.message(),
            })).collect::<Vec<_>>(),
            "sharingDeclined": sharing_declined_json(sharing_declined),
        }),
        SyncPassOutcome::CrashedAfterRemoteCommit => {
            json!({ "status": "crashedAfterRemoteCommit" })
        }
        SyncPassOutcome::CrashedAfterApply {
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor,
            changed_paths,
            refusals,
            sharing_declined,
            record_facts: _,
        } => json!({
            "status": "crashedAfterApply",
            "applied": applied,
            "refused": refused,
            "skipped": skipped,
            "conflictsOpened": conflicts_opened,
            "nextCursor": pending_cursor.cursor,
            "pendingCursor": relay_cursor_json(&pending_cursor),
            "changedPaths": changed_paths.iter().map(|change| json!({
                "versionId": change.version_id,
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })).collect::<Vec<_>>(),
            "refusals": refusals.into_iter().map(|refusal| json!({
                "workspaceId": refusal.workspace_id,
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.reason.code(),
                "reason": refusal.reason.message(),
            })).collect::<Vec<_>>(),
            "sharingDeclined": sharing_declined_json(sharing_declined),
        }),
    }
}

pub(super) fn sharing_declined_json(
    declines: Vec<dohc_engine_sync::SharingDeclined>,
) -> Vec<Value> {
    declines
        .into_iter()
        .map(|declined| {
            json!({
                "path": declined.path,
                "constraint": declined.constraint,
                "limitBytes": declined.limit_bytes,
                "observedBytes": declined.observed_bytes,
            })
        })
        .collect()
}

fn relay_outcome_json(outcome: RelayOperationOutcome) -> Result<Value, WireError> {
    Ok(match outcome {
        RelayOperationOutcome::Sync(outcome) => sync_outcome_json(outcome),
        RelayOperationOutcome::CursorCommitted { sharing_declined } => json!({
            "committed": true,
            "sharingDeclined": sharing_declined_json(sharing_declined),
        }),
        RelayOperationOutcome::Probe(has_content) => json!({ "hasContent": has_content }),
        RelayOperationOutcome::Claimed => json!({ "claimed": true }),
        RelayOperationOutcome::JoinIdentityAdopted => json!({ "adopted": true }),
        RelayOperationOutcome::Recovered(outcome) => json!({
            "oldOriginId": outcome.old_origin_id,
            "newOriginId": outcome.new_origin_id,
            "sharedPrefixLength": outcome.shared_prefix_length,
            "preservedOps": outcome.preserved_ops,
        }),
        RelayOperationOutcome::KeyEnvelopeUploaded { etag } => json!({ "etag": etag }),
        RelayOperationOutcome::KeyEnvelopeDownloaded {
            envelope_json,
            etag,
        } => json!({
            "envelopeJson": envelope_json,
            "etag": etag,
        }),
        RelayOperationOutcome::SharedChannelPulled(outcome) => json!({
            "fetched": outcome.fetched,
            "hasMore": outcome.has_more,
            "applied": outcome.applied,
            "refused": outcome.refused,
            "rejections": outcome.rejections.iter().map(|rejection| json!({
                "originId": rejection.origin_id,
                "originSeq": rejection.origin_seq,
                "opKind": rejection.op_kind,
                "reason": rejection.reason,
            })).collect::<Vec<_>>(),
            "skipped": outcome.skipped,
            "nextCursor": outcome.next_cursor,
        }),
        RelayOperationOutcome::SharedChannelPushed(outcome) => {
            json!({ "pushed": outcome.pushed })
        }
        RelayOperationOutcome::ShareViewIdentity(record) => json!({
            "identity": match record {
                dohc_engine_runtime::ShareViewIdentityRecord::Recorded => "recorded",
                dohc_engine_runtime::ShareViewIdentityRecord::AlreadyRecorded => {
                    "already-recorded"
                }
                // View and Comment send no workspace replication ops, so they
                // are given no identity. Saying "already recorded" would
                // claim a row that does not exist.
                dohc_engine_runtime::ShareViewIdentityRecord::NotRequired => "not-required",
            },
        }),
        RelayOperationOutcome::ShareProposalSubmitted(outcome) => json!({
            "submitted": outcome.submitted,
            // `null` is not "failed": it is "nothing was offered" — a share
            // below edit level, or a scan that found no change. The caller
            // reads `submitted` for the count and this for the review row.
            "proposalId": outcome.proposal_id,
            // Files the scan dropped because they are not part of this share:
            // one of their local ops named a path outside the shared paths.
            // Silence here is what leaves a recipient believing it sent work
            // it never sent.
            "skippedOutsideShare": outcome.skipped_outside_share,
            // One submit carries a bounded batch. This says another press has
            // more to offer; the engine did not count what is left.
            "morePending": outcome.more_pending,
        }),
        // Each direct write and how it ended. A stale or refused write is an
        // answer, not a failure: the recipient shows it and can send the
        // change as a proposal.
        RelayOperationOutcome::DirectWritesPushed(outcome) => json!({
            "writes": outcome.writes.iter().map(direct_write_json).collect::<Vec<_>>(),
            "morePending": outcome.more_pending,
        }),
        RelayOperationOutcome::ShareViewPulled(outcome) => json!({
            "fetched": outcome.fetched,
            "hasMore": outcome.has_more,
            "applied": outcome.applied,
            "skipped": outcome.skipped,
            // Why each skipped op was skipped. A skip is silent otherwise, and
            // a share that quietly stops carrying a granter's edits is exactly
            // the state a recipient cannot diagnose without this.
            "refusals": outcome.refusals.iter().map(|refusal| json!({
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.code,
                "detail": refusal.detail,
            })).collect::<Vec<_>>(),
            "nextCursor": outcome.pending_cursor.cursor,
            "changedPaths": outcome.changed_paths.into_iter().map(|change| json!({
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })).collect::<Vec<_>>(),
            "pendingCursor": {
                "kind": "shareView",
                "shareId": outcome.pending_cursor.share_id,
                "cursor": outcome.pending_cursor.cursor,
            },
        }),
    })
}

/// The selector the relay stated for this share, pinned by the caller on first
/// read, read into the grant every share RPC enforces.
///
/// Read before the relay round trip: a grant whose level this process cannot
/// read must never pin. The refusal names the accepted set, like the
/// relay's own — the caller is an agent reading this error, and "unknown share
/// access" told it nothing it could act on.
fn share_grant(selector: GrantedSelectorParams) -> Result<dohc_engine_sync::ShareGrant, WireError> {
    let access = dohc_engine_sync::ShareAccess::parse(&selector.access).ok_or_else(|| {
        WireError::new(
            ErrorCode::InvalidParams,
            r#"access must be "view", "comment", or "edit""#,
        )
    })?;
    Ok(dohc_engine_sync::ShareGrant {
        paths: selector.paths,
        version_id: selector.version_id,
        access,
    })
}

fn recovered_origin_id() -> Result<String, WireError> {
    sync_identifier("origin")
}

fn sync_identifier(prefix: &'static str) -> Result<String, WireError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy)
        .map_err(|_| WireError::new(ErrorCode::Internal, "sync-identity-generation-failed"))?;
    Ok(sync_identifier_from_entropy(prefix, entropy))
}

fn sync_identifier_from_entropy(prefix: &str, mut entropy: [u8; 16]) -> String {
    entropy[6] = (entropy[6] & 0x0f) | 0x40;
    entropy[8] = (entropy[8] & 0x3f) | 0x80;
    let hex = dohc_engine_storage::hex(&entropy);
    format!(
        "{prefix}_{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

impl EngineService {
    fn relay_open(
        &self,
        handle: Option<&WorkspaceHandle>,
        workspace_id: &str,
    ) -> Result<(Arc<OpenWorkspace>, RelayConfiguration), WireError> {
        let open = self.open(handle)?;
        validate_workspace_param(Some(workspace_id), &open.workspace_id)?;
        let configuration = open
            .relay
            .clone()
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "relay-not-configured"))?;
        Ok((open, configuration))
    }

    fn issue_pending_cursor(
        &self,
        handle: &WorkspaceHandle,
        workspace_id: &str,
        cursor: IssuedCursor,
    ) -> Result<Value, WireError> {
        for _ in 0..4 {
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|_| WireError::new(ErrorCode::Internal, "pending-cursor-token-failed"))?;
            let token = dohc_engine_storage::hex(&bytes);
            let (kind, wire_kind) = match &cursor {
                IssuedCursor::Relay(_) => (PendingCursorKind::Relay, "relay"),
                IssuedCursor::ShareView(_) => (PendingCursorKind::ShareView, "shareView"),
            };
            let mut pending = lock(&self.pending_cursors);
            if pending.contains_key(&token) {
                continue;
            }
            pending.retain(|_, issued| {
                issued.handle != *handle
                    || issued.workspace_id != workspace_id
                    || !matches!(
                        (&issued.cursor, kind),
                        (IssuedCursor::Relay(_), PendingCursorKind::Relay)
                            | (IssuedCursor::ShareView(_), PendingCursorKind::ShareView)
                    )
            });
            pending.insert(
                token.clone(),
                PendingCursor {
                    handle: handle.clone(),
                    workspace_id: workspace_id.to_owned(),
                    cursor,
                    materialization_paths: Vec::new(),
                    materialized: false,
                },
            );
            return Ok(json!({ "kind": wire_kind, "token": token }));
        }
        Err(WireError::new(
            ErrorCode::Internal,
            "pending-cursor-token-collision",
        ))
    }

    fn consume_pending_cursor(
        &self,
        handle: &WorkspaceHandle,
        workspace_id: &str,
        kind: PendingCursorKind,
        token: &str,
    ) -> Result<IssuedCursor, WireError> {
        let mut pending = lock(&self.pending_cursors);
        let valid = pending.get(token).is_some_and(|issued| {
            issued.handle == *handle
                && issued.workspace_id == workspace_id
                && matches!(
                    (&issued.cursor, kind),
                    (IssuedCursor::Relay(_), PendingCursorKind::Relay)
                        | (IssuedCursor::ShareView(_), PendingCursorKind::ShareView)
                )
        });
        if !valid {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-pending-cursor",
            ));
        }
        pending
            .remove(token)
            .map(|issued| issued.cursor)
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-pending-cursor"))
    }

    async fn relay_execute(
        &self,
        ctx: &RequestContext,
        open: &OpenWorkspace,
        configuration: RelayConfiguration,
        operation: RelayOperation,
        label: &str,
    ) -> Result<RelayOperationOutcome, WireError> {
        let reservation = if matches!(
            operation,
            RelayOperation::Push { .. }
                | RelayOperation::SubmitShareProposal { .. }
                | RelayOperation::PushDirectWrites { .. }
        ) {
            self.relay_sync_admission()
                .map(|(_, admission)| admission.reserve())
                .transpose()?
        } else {
            None
        };
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            label,
            open.actor.relay(
                configuration,
                operation,
                self.leases.scoped(&open.root),
                cancellation.token(),
                reservation,
            ),
        )
        .await
    }

    pub(super) async fn sync_push(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Push {
                    workspace_id: open.workspace_id.clone(),
                    now_ms: now_ms()?,
                    max_read_bytes: self
                        .relay_sync_admission()
                        .map_or(0, |(policy, _)| policy.max_read_bytes),
                },
                "sync.push",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn sync_pull(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Pull {
                    workspace_id: open.workspace_id.clone(),
                    now_ms: now_ms()?,
                },
                "sync.pull",
            )
            .await?;
        // Reconcile only after the terminal pull page. A relation target may
        // be on a later page, and dangling-link cleanup must not observe the
        // pull's partial state. The bounded outcome does not expose whether an
        // earlier page applied a collection change, so the terminal page
        // queues one reconciliation even when that page itself was empty.
        if matches!(
            &outcome,
            RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                has_more: false,
                ..
            })
        ) {
            open.request_collection_reconcile();
        }
        // Post-commit: every applied envelope's record changes are durable,
        // even on a crash after apply (the cursor retries; the durable layer
        // dedupes, so a replay derives no second fact set).
        if let RelayOperationOutcome::Sync(
            SyncPassOutcome::Complete { record_facts, .. }
            | SyncPassOutcome::CrashedAfterApply { record_facts, .. },
        ) = &outcome
        {
            for facts in record_facts {
                emit_record_events(&self.events, &open.workspace_id, facts);
            }
        }
        let pending = match &outcome {
            RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                pending_cursor: Some(cursor),
                ..
            })
            | RelayOperationOutcome::Sync(SyncPassOutcome::CrashedAfterApply {
                pending_cursor: cursor,
                ..
            }) => Some(IssuedCursor::Relay(cursor.clone())),
            _ => None,
        };
        let materialization_paths = match &outcome {
            RelayOperationOutcome::Sync(
                SyncPassOutcome::Complete { changed_paths, .. }
                | SyncPassOutcome::CrashedAfterApply { changed_paths, .. },
            ) => changed_paths.clone(),
            _ => Vec::new(),
        };
        let mut result = relay_outcome_json(outcome)?;
        if let Some(cursor) = pending {
            let issued = self.issue_pending_cursor(bound_handle, &open.workspace_id, cursor)?;
            let token = issued["token"]
                .as_str()
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "invalid issued cursor"))?;
            lock(&self.pending_cursors)
                .get_mut(token)
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "issued cursor disappeared"))?
                .materialization_paths = materialization_paths;
            result["pendingCursor"] = issued;
        }
        Ok(result)
    }

    pub(super) async fn sync_materialize_pending_cursor(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CommitCursorParams = parse(params)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, _) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let PendingCursorParams::Relay { token } = params.pending_cursor else {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ordinary materialization requires relay cursor",
            ));
        };
        let paths = {
            let mut pending = lock(&self.pending_cursors);
            let issued = pending
                .get_mut(&token)
                .filter(|issued| {
                    issued.handle == *bound_handle
                        && issued.workspace_id == open.workspace_id
                        && matches!(issued.cursor, IssuedCursor::Relay(_))
                })
                .ok_or_else(|| {
                    WireError::new(ErrorCode::InvalidParams, "invalid-pending-cursor")
                })?;
            issued.materialized = false;
            issued.materialization_paths.clone()
        };
        let cancellation = OperationCancellation::new(ctx);
        let _apply = tokio::select! {
            biased;
            () = cancellation.token.cancelled() => return Err(cancellation.interruption("sync.materializePendingCursor")),
            guard = Arc::clone(&open.capture_apply_gate).lock_owned() => guard,
        };
        open.actor
            .materialize_relay_page(
                open.workspace_id.clone(),
                open.root.clone(),
                paths,
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
                cancellation.token(),
            )
            .await
            .map_err(crate::rpc::error::map_runtime)?;
        if cancellation.token.is_cancelled() {
            return Err(cancellation.interruption("sync.materializePendingCursor"));
        }
        if !Arc::ptr_eq(&open, &self.open(Some(bound_handle))?) {
            return Err(workspace_unavailable());
        }
        let mut pending = lock(&self.pending_cursors);
        let issued = pending
            .get_mut(&token)
            .filter(|issued| {
                issued.handle == *bound_handle && issued.workspace_id == open.workspace_id
            })
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-pending-cursor"))?;
        issued.materialized = true;
        Ok(json!({"materialized": true}))
    }

    pub(super) async fn sync_commit_cursor(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: CommitCursorParams = parse(params)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let (kind, token) = match params.pending_cursor {
            PendingCursorParams::Relay { token } => (PendingCursorKind::Relay, token),
            PendingCursorParams::ShareView { token } => (PendingCursorKind::ShareView, token),
        };
        if self.configured_live_host.get().is_some()
            && !lock(&self.pending_cursors)
                .get(&token)
                .is_some_and(|issued| {
                    issued.handle == *bound_handle
                        && issued.workspace_id == open.workspace_id
                        && issued.materialized
                })
        {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "ordinary cursor materialization is incomplete",
            ));
        }
        let issued = self.consume_pending_cursor(bound_handle, &open.workspace_id, kind, &token)?;
        let operation = match issued {
            IssuedCursor::Relay(cursor) => RelayOperation::CommitCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
                now_ms: now_ms()?,
            },
            IssuedCursor::ShareView(cursor) => RelayOperation::CommitShareViewCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
            },
        };
        let outcome = self
            .relay_execute(ctx, &open, configuration, operation, "sync.commitCursor")
            .await?;
        relay_outcome_json(outcome)
    }

    /// `sync.remoteChanges`: how many changes that did not originate on
    /// this computer the engine has applied to the workspace. A caller
    /// records the count with a decision and compares it for equality later:
    /// an unchanged count proves no one else's change arrived in between.
    /// Restoring a backup can lower it, so it is never compared for order.
    /// It needs no relay configuration and no finished initial capture.
    pub(super) async fn sync_remote_changes(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let applied = Self::read_under_ctx(
            &cancellation,
            "sync.remoteChanges",
            open.actor.remote_changes_applied(open.workspace_id.clone()),
        )
        .await?;
        Ok(json!({ "applied": applied }))
    }

    pub(super) async fn sync_probe(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Probe {
                    workspace_id: open.workspace_id.clone(),
                },
                "sync.probe",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn sync_claim(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::Claim {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id: sync_identifier("origin")?,
                    new_replication_epoch: sync_identifier("epoch")?,
                    new_stream_identity: sync_identifier("stream")?,
                    created_at_ms: now_ms()?,
                },
                "sync.claim",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn sync_adopt_join_identity(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: AdoptJoinIdentityParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::AdoptJoinIdentity {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id: recovered_origin_id()?,
                    replication_epoch: params.replication_epoch,
                    stream_identity: params.stream_identity,
                    created_at_ms: now_ms()?,
                },
                "sync.adoptJoinIdentity",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn sync_recover_origin(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let new_origin_id = recovered_origin_id()?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::RecoverOrigin {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id,
                },
                "sync.recoverOrigin",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn keys_upload(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: KeyEnvelopeUploadParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::UploadKeyEnvelope {
                    workspace_id: open.workspace_id.clone(),
                    envelope_json: params.envelope_json,
                    if_match: params.if_match,
                },
                "keys.upload",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn keys_download(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::DownloadKeyEnvelope {
                    workspace_id: open.workspace_id.clone(),
                },
                "keys.download",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn share_channel_pull(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SharedChannelParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PullSharedChannel {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    channel_wire_id: params.channel_wire_id,
                },
                "share.channel.pull",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn share_channel_push(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: SharedChannelParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PushSharedChannel {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    channel_wire_id: params.channel_wire_id,
                },
                "share.channel.push",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn share_view_pull(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareViewParams = parse(params)?;
        let granted = share_grant(params.granted_selector)?;
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PullShareView {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    granted,
                },
                "share.view.pull",
            )
            .await?;
        let pending = match &outcome {
            RelayOperationOutcome::ShareViewPulled(outcome) => {
                Some(IssuedCursor::ShareView(outcome.pending_cursor.clone()))
            }
            _ => None,
        };
        let mut result = relay_outcome_json(outcome)?;
        if let Some(cursor) = pending {
            result["pendingCursor"] =
                self.issue_pending_cursor(bound_handle, &open.workspace_id, cursor)?;
        }
        Ok(result)
    }

    /// Record this share view's own replica identity. Run at
    /// open and again at every refresh; the engine writes the row once and
    /// later calls answer `already-recorded`.
    ///
    /// Takes no `shareId`: `sync_identity` is per WORKSPACE, and a share view
    /// mirrors exactly one share. It takes the pinned selector because the
    /// LEVEL decides — only an `edit` share can send file changes, so View
    /// and Comment record nothing — and refuses an unreadable level the same
    /// way the pull does.
    ///
    /// The three identity components are minted here, not by the caller, for
    /// the same reason `sync.claim` mints its own: the durable row is the
    /// record, so a refresh cannot re-mint an origin and split this replica's
    /// log in two. The origin is a REPLICA id — the relay namespaces this
    /// recipient's ops as `share:<shareId>:<originId>` — so it must never be
    /// a user id, which two devices would share.
    pub(super) async fn share_view_record_identity(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareViewEnrollParams = parse(params)?;
        let granted = share_grant(params.granted_selector)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                // The RPC still parses the whole selector above, because a
                // caller that sends a malformed one must be refused here. The
                // operation carries only the access: the level is the entire
                // decision it makes, and handing it paths would suggest they
                // matter to it.
                RelayOperation::RecordShareViewIdentity {
                    workspace_id: open.workspace_id.clone(),
                    access: granted.access,
                    origin_id: sync_identifier("origin")?,
                    replication_epoch: sync_identifier("epoch")?,
                    stream_identity: sync_identifier("stream")?,
                    created_at_ms: now_ms()?,
                },
                "share.view.recordIdentity",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    /// Offer this replica's own edits of a received file share to the granter.
    ///
    /// Takes the same pinned selector the pull takes and refuses an unreadable
    /// level the same way. The client refuses again below `edit` — the caller
    /// states the level it pinned, and a level this process cannot read is not
    /// a narrower grant.
    pub(super) async fn share_proposal_submit(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareProposalSubmitParams = parse(params)?;
        let granted = share_grant(params.granted_selector)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::SubmitShareProposal {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    granted,
                    submit_id: params.submit_id,
                    max_read_bytes: self
                        .relay_sync_admission()
                        .map_or(0, |(policy, _)| policy.max_read_bytes),
                },
                "share.proposal.submit",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    /// Write this replica's changes to a Collection's own files directly into
    /// the granter's workspace (ADR 0013). Takes the same pinned selector the
    /// submit takes; the client writes nothing below `edit` or on a version
    /// share.
    pub(super) async fn share_direct_push(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareDirectPushParams = parse(params)?;
        let granted = share_grant(params.granted_selector)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PushDirectWrites {
                    workspace_id: open.workspace_id.clone(),
                    share_id: params.share_id,
                    granted,
                    max_read_bytes: self
                        .relay_sync_admission()
                        .map_or(0, |(policy, _)| policy.max_read_bytes),
                },
                "share.direct.push",
            )
            .await?;
        relay_outcome_json(outcome)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_runtime::RelayOperationOutcome;
    use dohc_engine_sync::ShareCursor;
    use dohc_engine_sync::SyncPassOutcome;
    use serde_json::json;

    #[tokio::test]
    async fn relay_access_shares_the_open_binding_and_preserves_scope_refusals() {
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let supervisor: &'static dohc_engine_runtime::WorkspaceSupervisor =
            Box::leak(Box::new(dohc_engine_runtime::WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let params = json!({
            "rootDir": scratch.path().to_string_lossy(),
            "workspaceId": "shared-relay-access",
            "captureMode": "none",
            "relay": { "baseUrl": "https://relay.example", "bearerToken": "test-token" },
        });
        let opened = service
            .workspace_open(&RequestContext::unbounded(), params)
            .await
            .expect("workspace open");
        let handle: WorkspaceHandle =
            serde_json::from_value(opened["workspace"].clone()).expect("handle");
        let retained = service.open(Some(&handle)).expect("retained access");
        let (open, configuration) = service
            .relay_open(Some(&handle), "shared-relay-access")
            .expect("relay access");
        assert!(Arc::ptr_eq(&retained, &open));
        assert_eq!(open.relay.as_ref(), Some(&configuration));
        let refused = service.relay_open(Some(&handle), "another-workspace");
        assert!(matches!(
            refused,
            Err(WireError {
                code: ErrorCode::InvalidParams,
                ..
            })
        ));
        service
            .workspace_close(Some(handle.clone()))
            .await
            .expect("close");
        let refused = service.relay_open(Some(&handle), "shared-relay-access");
        assert!(matches!(
            refused,
            Err(WireError {
                code: ErrorCode::WorkspaceUnavailable,
                ..
            })
        ));
    }

    #[test]
    fn recovered_origins_use_random_uuid_identity_coordinates() {
        let first = sync_identifier_from_entropy("origin", [0; 16]);
        let second = sync_identifier_from_entropy("origin", [1; 16]);
        assert_eq!(first, "origin_00000000-0000-4000-8000-000000000000");
        assert_eq!(second, "origin_01010101-0101-4101-8101-010101010101");
        assert_ne!(
            first, second,
            "cross-device entropy must participate in the recovered coordinate"
        );
    }

    #[test]
    fn sync_outcome_json_surfaces_an_undrained_complete_pass() {
        let value = sync_outcome_json(SyncPassOutcome::Complete {
            owner_admission_pending: Vec::new(),
            pushed: 0,
            fetched: 500,
            has_more: true,
            applied: 500,
            refused: 0,
            skipped: 0,
            conflicts_opened: 0,
            pending_cursor: None,
            changed_paths: Vec::new(),
            refusals: Vec::new(),
            sharing_declined: vec![dohc_engine_sync::SharingDeclined {
                path: "notes/oversized.md".to_owned(),
                constraint: "MAX_YDOC_UPDATE_BYTES",
                limit_bytes: 20,
                observed_bytes: 21,
            }],
            record_facts: Vec::new(),
        });

        assert_eq!(value["status"], "complete");
        assert_eq!(
            value["hasMore"], true,
            "omitting hasMore makes a bounded prefix indistinguishable from a drained relay"
        );
        assert_eq!(
            value["sharingDeclined"],
            json!([{
                "path": "notes/oversized.md",
                "constraint": "MAX_YDOC_UPDATE_BYTES",
                "limitBytes": 20,
                "observedBytes": 21,
            }]),
            "enrollment refusals must reach the workspace RPC result"
        );
    }

    #[test]
    fn share_view_outcome_json_surfaces_has_more_and_every_refusal() {
        let value = relay_outcome_json(RelayOperationOutcome::ShareViewPulled(
            dohc_engine_sync::ShareViewPullOutcome {
                fetched: 2,
                has_more: true,
                applied: 0,
                skipped: 1,
                refusals: vec![dohc_engine_sync::ShareViewRefusal {
                    origin_id: "granter".to_owned(),
                    origin_seq: 4,
                    op_kind: "moment.append".to_owned(),
                    code: "share-boundary-violation",
                    detail: "the share granted version main, the relay offered version other"
                        .to_owned(),
                }],
                changed_paths: Vec::new(),
                pending_cursor: ShareCursor {
                    kind: dohc_engine_sync::CursorKind::ShareView,
                    share_id: "share".to_owned(),
                    cursor: 1,
                },
            },
        ))
        .expect("serialize share view outcome");
        assert_eq!(
            value["hasMore"], true,
            "omitting hasMore hides that the pending cursor is only a bounded prefix"
        );
        assert_eq!(
            value["refusals"][0]["detail"],
            "the share granted version main, the relay offered version other",
            "serializing a bare count leaves the client nothing to tell the user"
        );
        assert_eq!(value["refusals"][0]["originSeq"], 4);
        assert_eq!(value["refusals"][0]["code"], "share-boundary-violation");
    }

    #[test]
    fn direct_push_outcome_json_states_each_write_and_how_it_ended() {
        let value = relay_outcome_json(RelayOperationOutcome::DirectWritesPushed(
            dohc_engine_sync::DirectWritePushOutcome {
                writes: vec![
                    dohc_engine_sync::DirectWriteReport {
                        paths: vec!["trip/packing/collection.yaml".to_owned()],
                        result: dohc_engine_sync::DirectWriteResult::Written,
                    },
                    dohc_engine_sync::DirectWriteReport {
                        paths: vec!["trip/ideas/collection.yaml".to_owned()],
                        result: dohc_engine_sync::DirectWriteResult::Stale {
                            path: "trip/ideas".to_owned(),
                            current_blob_sha256: None,
                        },
                    },
                    dohc_engine_sync::DirectWriteReport {
                        paths: vec!["trip/packing/automations.yaml".to_owned()],
                        result: dohc_engine_sync::DirectWriteResult::Refused {
                            reason: "changes an automation with a personal step".to_owned(),
                        },
                    },
                ],
                more_pending: true,
            },
        ))
        .expect("serialize direct push outcome");
        assert_eq!(
            value,
            json!({
                "writes": [
                    {"paths": ["trip/packing/collection.yaml"], "result": "written"},
                    {
                        "paths": ["trip/ideas/collection.yaml"],
                        "result": "stale",
                        "stalePath": "trip/ideas",
                        "currentBlobSha256": null,
                    },
                    {
                        "paths": ["trip/packing/automations.yaml"],
                        "result": "refused",
                        "reason": "changes an automation with a personal step",
                    },
                ],
                "morePending": true,
            }),
        );
    }

    #[test]
    fn share_proposal_outcome_json_states_an_empty_submit_as_a_null_proposal() {
        let offered = relay_outcome_json(RelayOperationOutcome::ShareProposalSubmitted(
            dohc_engine_sync::ShareProposalSubmitOutcome {
                submitted: 2,
                proposal_id: Some("proposal-1".to_owned()),
                skipped_outside_share: 0,
                more_pending: false,
            },
        ))
        .expect("serialize share proposal outcome");
        assert_eq!(offered["submitted"], 2);
        assert_eq!(offered["proposalId"], "proposal-1");

        let nothing = relay_outcome_json(RelayOperationOutcome::ShareProposalSubmitted(
            dohc_engine_sync::ShareProposalSubmitOutcome::default(),
        ))
        .expect("serialize empty share proposal outcome");
        assert_eq!(nothing["submitted"], 0);
        assert!(
            nothing["proposalId"].is_null(),
            "an omitted proposalId reads as a missing field, and the client \
             cannot tell 'nothing was offered' from 'the engine did not answer'"
        );
    }

    /// A submit that dropped work, or left work behind, has to say so. Both
    /// facts are silent otherwise, and a recipient reading only `submitted`
    /// believes the whole edit reached the granter.
    #[test]
    fn share_proposal_outcome_json_reports_dropped_and_pending_changes() {
        let value = relay_outcome_json(RelayOperationOutcome::ShareProposalSubmitted(
            dohc_engine_sync::ShareProposalSubmitOutcome {
                submitted: 500,
                proposal_id: Some("proposal-1".to_owned()),
                skipped_outside_share: 3,
                more_pending: true,
            },
        ))
        .expect("serialize share proposal outcome");
        assert_eq!(
            value["skippedOutsideShare"], 3,
            "a change dropped for landing outside the share must be counted to the caller"
        );
        assert_eq!(
            value["morePending"], true,
            "without this the recipient cannot know a further submit has more to offer"
        );

        let complete = relay_outcome_json(RelayOperationOutcome::ShareProposalSubmitted(
            dohc_engine_sync::ShareProposalSubmitOutcome::default(),
        ))
        .expect("serialize share proposal outcome");
        assert_eq!(complete["skippedOutsideShare"], 0);
        assert_eq!(complete["morePending"], false);
    }

    #[test]
    fn share_proposal_params_require_a_submit_id_and_a_readable_level() {
        let complete: Result<ShareProposalSubmitParams, _> = serde_json::from_value(json!({
            "workspaceId": "workspace",
            "shareId": "share",
            "grantedSelector": { "paths": ["docs"], "versionId": null, "access": "edit" },
            "submitId": "submit-1",
        }));
        assert!(complete.is_ok());

        let no_submit_id: Result<ShareProposalSubmitParams, _> = serde_json::from_value(json!({
            "workspaceId": "workspace",
            "shareId": "share",
            "grantedSelector": { "paths": ["docs"], "versionId": null, "access": "edit" },
        }));
        assert!(
            no_submit_id.is_err(),
            "defaulting the submit id opens a second proposal per retry"
        );

        let no_access: Result<ShareProposalSubmitParams, _> = serde_json::from_value(json!({
            "workspaceId": "workspace",
            "shareId": "share",
            "grantedSelector": { "paths": ["docs"], "versionId": null },
            "submitId": "submit-1",
        }));
        assert!(
            no_access.is_err(),
            "defaulting the level submits through a grant nobody read"
        );
    }
}
