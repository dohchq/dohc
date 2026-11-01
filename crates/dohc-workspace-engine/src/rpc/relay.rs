use crate::EngineService;
use crate::events::emit_record_events;
use crate::lock;
use crate::rpc::error::map_runtime;
use crate::rpc::error::workspace_unavailable;
use crate::rpc::held_documents::HELD_RESPONSE_BYTE_BUDGET;
use crate::rpc::reads::json_string_encoded_len;
use crate::rpc::reads::response_encoded_bytes;
use crate::rpc::request::OperationCancellation;
use crate::rpc::request::landed_wait_until;
use crate::rpc::request::now_ms;
use crate::rpc::request::parse;
use crate::rpc::workspace::OpenWorkspace;
use crate::rpc::workspace::validate_workspace_param;
use dohc_engine_collab::DocKey;
use dohc_engine_protocol::error::ErrorCode;
use dohc_engine_protocol::error::WireError;
use dohc_engine_protocol::transport::RequestContext;
use dohc_engine_protocol::wire::WorkspaceHandle;
use dohc_engine_runtime::RelayConfiguration;
use dohc_engine_runtime::RelayOperation;
use dohc_engine_runtime::RelayOperationOutcome;
use dohc_engine_sync::HostedCursor;
use dohc_engine_sync::HostedPassOutcome;
use dohc_engine_sync::RelayCursor;
use dohc_engine_sync::ShareCursor;
use dohc_engine_sync::SyncPassOutcome;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::collections::btree_map;
use std::iter::Peekable;
use std::ops::Bound;
use std::sync::Arc;
use std::sync::atomic::Ordering;

#[derive(Clone)]
pub(super) enum IssuedCursor {
    Relay(RelayCursor),
    ShareView(ShareCursor),
    Hosted(HostedCursor),
}

#[derive(Clone)]
pub(crate) struct PendingCursor {
    pub(super) handle: WorkspaceHandle,
    pub(crate) workspace_id: String,
    pub(super) cursor: IssuedCursor,
    pub(super) materialization_paths: Vec<dohc_engine_sync::MomentMaterializationChange>,
    pub(super) materialized: bool,
    /// The terminal page of a pull in a workspace that keeps its Collections
    /// itself: they reconcile once this cursor commits, after the page's files
    /// landed, as a capture pass reconciles after it applies what it scanned.
    pub(super) reconcile_collections: bool,
    /// A hosted pass's `departedAfter`, which its commit lists departed
    /// documents after too.
    pub(super) departed_after: Option<String>,
    /// Its place in its handle's `cursors_issued` count for its kind.
    pub(super) issue: u64,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RelayOpenParams {
    #[serde(default)]
    base_url: String,
    socket_path: Option<std::path::PathBuf>,
    bearer_token: String,
    #[cfg(debug_assertions)]
    #[serde(default)]
    allow_insecure_loopback_for_tests: bool,
}

impl RelayOpenParams {
    pub(super) fn validate_transport(&self, replica: bool) -> Result<(), WireError> {
        if self.socket_path.is_some() && !replica {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "relay.socketPath requires replica mode",
            ));
        }
        if self.socket_path.is_none() && self.base_url.is_empty() {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "relay.baseUrl is required",
            ));
        }
        Ok(())
    }

    pub(super) fn configuration(&self) -> RelayConfiguration {
        RelayConfiguration {
            base_url: self.base_url.clone(),
            socket_path: self.socket_path.clone(),
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
struct PullHostedParams {
    workspace_id: String,
    /// The answer lists the documents the pass holds after this object ID;
    /// from the first without it.
    #[serde(default)]
    held_after: Option<String>,
    /// The answer and its commit list the departed documents after this
    /// object ID; from the first without it.
    #[serde(default)]
    departed_after: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DismissRefusalParams {
    workspace_id: String,
    notice_id: String,
    refusal_coordinates: Vec<dohc_engine_sync::RefusalCoordinate>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClaimParams {
    workspace_id: String,
    account_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdoptJoinIdentityParams {
    workspace_id: String,
    replication_epoch: String,
    stream_identity: String,
}

/// The coordinate the hosted feed's bootstrap names.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostedReplicaParams {
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
    Hosted { token: String },
}

#[derive(Clone, Copy)]
enum PendingCursorKind {
    Relay,
    ShareView,
    Hosted,
}

fn issued_as(cursor: &IssuedCursor, kind: PendingCursorKind) -> bool {
    matches!(
        (cursor, kind),
        (IssuedCursor::Relay(_), PendingCursorKind::Relay)
            | (IssuedCursor::ShareView(_), PendingCursorKind::ShareView)
            | (IssuedCursor::Hosted(_), PendingCursorKind::Hosted)
    )
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
struct ShareDirectStatusParams {
    workspace_id: String,
    share_id: String,
    path: String,
    granted_selector: GrantedSelectorParams,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ShareFileStatusesParams {
    workspace_id: String,
    share_id: String,
    paths: Vec<String>,
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
            "recoveredDraftPath": write.recovered_draft_path,
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

fn changed_paths_json(changes: &[dohc_engine_sync::MomentMaterializationChange]) -> Vec<Value> {
    changes
        .iter()
        .map(|change| {
            json!({
                "versionId": change.version_id,
                "path": change.path,
                "operation": change.operation,
                "contentKind": change.content_kind,
            })
        })
        .collect()
}

fn refusals_json(refusals: Vec<dohc_engine_sync::ReplicationRefusal>) -> Vec<Value> {
    refusals
        .into_iter()
        .map(|refusal| {
            json!({
                "workspaceId": refusal.workspace_id,
                "originId": refusal.origin_id,
                "originSeq": refusal.origin_seq,
                "opKind": refusal.op_kind,
                "code": refusal.reason.code(),
                "reason": refusal.reason.message(),
            })
        })
        .collect()
}

/// How much of a hosted pull's answer its held list, then its departed list,
/// take before the rest of the answer fills, so however much else a pass
/// reports, both lists page on.
const HELD_PROGRESS_BYTES: usize = 64 * 1024;
const DEPARTED_PROGRESS_BYTES: usize = 16 * 1024;

fn encoded_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// The leading `values` that keep the answer within `limit` bytes, counted
/// into `size`, and how many it leaves out.
fn fit(values: Vec<Value>, size: &mut usize, limit: usize) -> (Vec<Value>, usize) {
    let total = values.len();
    let mut listed = Vec::new();
    for value in values {
        // A comma separates each entry from the one before it.
        let next = size
            .saturating_add(encoded_len(&value))
            .saturating_add(usize::from(!listed.is_empty()));
        if next > limit {
            break;
        }
        *size = next;
        listed.push(value);
    }
    let omitted = total.saturating_sub(listed.len());
    (listed, omitted)
}

/// Lists held documents from `entries` while each keeps the answer within
/// `limit` bytes with its ID as `heldThrough`, and the first always. `stop`
/// keeps what the last one's ID adds past `null`.
fn list_held(
    entries: &mut Peekable<btree_map::Range<'_, String, dohc_engine_sync::HostedHold>>,
    paths: &BTreeMap<String, String>,
    held: &mut Vec<Value>,
    size: &mut usize,
    stop: &mut usize,
    limit: usize,
) -> Result<(), WireError> {
    while let Some(&(object_id, hold)) = entries.peek() {
        let summary = hosted_hold_json(object_id, hold, paths.get(object_id).map(String::as_str))?;
        let next = size
            .saturating_add(encoded_len(&summary))
            .saturating_add(usize::from(!held.is_empty()));
        let through = json_string_encoded_len(object_id).saturating_sub("null".len());
        if !held.is_empty() && next.saturating_add(through) > limit {
            break;
        }
        *size = next;
        *stop = through;
        held.push(summary);
        entries.next();
    }
    Ok(())
}

/// The departed documents after `after`, from the first without it.
fn departed_from<'a>(
    departed: &'a [String],
    after: Option<&str>,
) -> Peekable<std::slice::Iter<'a, String>> {
    let start = departed.partition_point(|id| after.is_some_and(|after| id.as_str() <= after));
    departed[start..].iter().peekable()
}

/// Lists departed documents from `ids` as [`list_held`] lists held ones.
fn list_departed(
    ids: &mut Peekable<std::slice::Iter<'_, String>>,
    departed: &mut Vec<Value>,
    size: &mut usize,
    stop: &mut usize,
    limit: usize,
) {
    while let Some(&object_id) = ids.peek() {
        let next = size
            .saturating_add(json_string_encoded_len(object_id))
            .saturating_add(usize::from(!departed.is_empty()));
        let through = json_string_encoded_len(object_id).saturating_sub("null".len());
        if !departed.is_empty() && next.saturating_add(through) > limit {
            break;
        }
        *size = next;
        *stop = through;
        departed.push(Value::String(object_id.clone()));
        ids.next();
    }
}

/// A held document as `newlyHeld` names it: only what the relay needs to hold it.
fn newly_held_json(object_id: &str, hold: &dohc_engine_sync::HostedHold) -> Value {
    let mut held = json!({"objectId": object_id, "reason": hold.reason()});
    if let dohc_engine_sync::HostedHold::ReleasedLineageUnsettled { binding, .. } = hold {
        held["bindingDigest"] = json!(binding.digest());
    }
    held
}

/// A hosted pass answering request `request_id`, with its cursor issued as
/// `pending_cursor`, in at most `budget` bytes of serialized response. Each
/// list takes its entries in order while they fit:
/// - `held` names the documents the pass leaves held after `held_after`, in
///   object ID order, and the first always, so paging moves on. It fills
///   [`HELD_PROGRESS_BYTES`] before the other lists and the rest after them.
///   `heldThrough` is null once the list reaches the last of them, or else
///   the last one listed, after which the next pull asks. Between
///   `held_after` and there, a document not listed is not held; past there,
///   the answer says nothing.
/// - `departed` pages the same way after `departed_after`, through
///   `departedThrough`: the documents that left the scope and are not gone
///   yet. It fills [`DEPARTED_PROGRESS_BYTES`] after the held list's share.
/// - `newlyHeld` names held documents the pass moved from ready, wherever
///   they fall. With `newlyHeldOmitted` above zero, some are left out.
/// - `refusals`, `sharingDeclined` and `changedPaths` report what the engine
///   keeps itself; each count says how many of them do not fit.
fn hosted_pass_json(
    request_id: u64,
    pass: HostedPassOutcome,
    departed: Vec<String>,
    pending_cursor: Value,
    held_after: Option<&str>,
    departed_after: Option<&str>,
    budget: usize,
) -> Result<Value, WireError> {
    // Each count is measured at its widest.
    let mut result = json!({
        "fetched": pass.fetched,
        "hasMore": pass.has_more,
        "applied": pass.applied,
        "refused": pass.refused,
        "skipped": pass.skipped,
        "conflictsOpened": pass.conflicts_opened,
        "changedPaths": [],
        "changedPathsOmitted": u64::MAX,
        "refusals": [],
        "refusalsOmitted": u64::MAX,
        "sharingDeclined": [],
        "sharingDeclinedOmitted": u64::MAX,
        "held": [],
        "heldThrough": null,
        "newlyHeld": [],
        "newlyHeldOmitted": u64::MAX,
        "departed": [],
        "departedThrough": null,
        "pendingCursor": pending_cursor,
    });
    let mut size = response_encoded_bytes(request_id, &result);
    let after = held_after.map_or(Bound::Unbounded, Bound::Excluded);
    let mut entries = pass
        .held
        .range::<str, _>((after, Bound::Unbounded))
        .peekable();
    let mut held = Vec::new();
    let mut held_stop = 0;
    let share = size.saturating_add(HELD_PROGRESS_BYTES).min(budget);
    list_held(
        &mut entries,
        &pass.held_paths,
        &mut held,
        &mut size,
        &mut held_stop,
        share,
    )?;
    let mut ids = departed_from(&departed, departed_after);
    let mut listed = Vec::new();
    let mut departed_stop = 0;
    let share = size
        .saturating_add(DEPARTED_PROGRESS_BYTES)
        .min(budget.saturating_sub(held_stop));
    list_departed(&mut ids, &mut listed, &mut size, &mut departed_stop, share);
    let room = budget
        .saturating_sub(held_stop)
        .saturating_sub(departed_stop);
    let newly_held = pass
        .newly_held
        .iter()
        .filter_map(|object_id| Some(newly_held_json(object_id, pass.held.get(object_id)?)))
        .collect();
    let (newly_held, newly_held_omitted) = fit(newly_held, &mut size, room);
    let (refusals, refusals_omitted) = fit(refusals_json(pass.refusals), &mut size, room);
    let (sharing_declined, sharing_declined_omitted) = fit(
        sharing_declined_json(pass.sharing_declined),
        &mut size,
        room,
    );
    let (changed_paths, changed_paths_omitted) =
        fit(changed_paths_json(&pass.changed_paths), &mut size, room);
    list_held(
        &mut entries,
        &pass.held_paths,
        &mut held,
        &mut size,
        &mut held_stop,
        budget.saturating_sub(departed_stop),
    )?;
    list_departed(
        &mut ids,
        &mut listed,
        &mut size,
        &mut departed_stop,
        budget.saturating_sub(held_stop),
    );
    if entries.peek().is_some() {
        result["heldThrough"] = held
            .last()
            .map_or(Value::Null, |hold| hold["objectId"].clone());
    }
    if ids.peek().is_some() {
        result["departedThrough"] = listed.last().cloned().unwrap_or(Value::Null);
    }
    result["held"] = Value::Array(held);
    result["newlyHeld"] = Value::Array(newly_held);
    result["newlyHeldOmitted"] = json!(newly_held_omitted);
    result["departed"] = Value::Array(listed);
    result["refusals"] = Value::Array(refusals);
    result["refusalsOmitted"] = json!(refusals_omitted);
    result["sharingDeclined"] = Value::Array(sharing_declined);
    result["sharingDeclinedOmitted"] = json!(sharing_declined_omitted);
    result["changedPaths"] = Value::Array(changed_paths);
    result["changedPathsOmitted"] = json!(changed_paths_omitted);
    if response_encoded_bytes(request_id, &result) > budget {
        return Err(WireError::new(ErrorCode::Internal, "state-corrupt"));
    }
    Ok(result)
}

/// A hosted commit in at most `budget` bytes of serialized response, measured
/// under the widest request ID. `departed` pages as its pass's list does,
/// after the same `departed_after`, or is null when unread.
fn hosted_commit_json(
    commit: dohc_engine_sync::HostedCommit,
    retirement: Result<bool, dohc_engine_runtime::RuntimeError>,
    unready: Result<Vec<String>, dohc_engine_runtime::RuntimeError>,
    departed: Result<Vec<String>, dohc_engine_runtime::RuntimeError>,
    departed_after: Option<&str>,
    budget: usize,
) -> Result<Value, WireError> {
    let has_more =
        commit.has_more || matches!(retirement, Ok(true)) || unready.is_err() || departed.is_err();
    let mut result = json!({
        "committed": commit.committed,
        "hasMore": has_more,
        "retirement": retirement.err().map(map_runtime),
        "departed": null,
        "departedThrough": null,
        "sharingDeclined": [],
    });
    let mut size = response_encoded_bytes(u64::MAX, &result);
    if let Ok(departed) = departed {
        // Measured as `null`, which is longer than `[]`.
        let mut ids = departed_from(&departed, departed_after);
        let mut listed = Vec::new();
        let mut stop = 0;
        list_departed(&mut ids, &mut listed, &mut size, &mut stop, budget);
        if ids.peek().is_some() {
            result["departedThrough"] = listed.last().cloned().unwrap_or(Value::Null);
        }
        result["departed"] = Value::Array(listed);
    }
    if response_encoded_bytes(u64::MAX, &result) > budget {
        return Err(WireError::new(ErrorCode::Internal, "state-corrupt"));
    }
    Ok(result)
}

/// A held document, which the relay must not open for live editing. A
/// released-lineage hold is named by its summary, at `path`, and its binding
/// only by its digest; one without its path answers an internal error.
fn hosted_hold_json(
    object_id: &str,
    hold: &dohc_engine_sync::HostedHold,
    path: Option<&str>,
) -> Result<Value, WireError> {
    use dohc_engine_sync::HostedHold;
    let mut held = json!({"objectId": object_id, "reason": hold.reason()});
    match hold {
        HostedHold::PathHeld { path, held_by } => {
            held["path"] = json!(path);
            held["heldBy"] = json!(held_by);
        }
        HostedHold::ConflictParentWithheld { conflict_id } => {
            held["conflictId"] = json!(conflict_id);
        }
        HostedHold::WorkWaiting | HostedHold::LiveEditUnadmitted => {}
        HostedHold::ScopePathMismatch {
            scope_path,
            head_path,
        } => {
            held["scopePath"] = json!(scope_path);
            held["headPath"] = json!(head_path);
        }
        HostedHold::ReleasedLineageUnsettled {
            binding,
            continuation,
            binding_stale,
        } => {
            let path = path.ok_or_else(|| WireError::new(ErrorCode::Internal, "state-corrupt"))?;
            held["path"] = json!(path);
            held["bindingDigest"] = json!(binding.digest());
            held["continuation"] = json!(continuation.as_str());
            held["bindingStale"] = json!(binding_stale);
        }
    }
    Ok(held)
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
            "changedPaths": changed_paths_json(&changed_paths),
            "refusals": refusals_json(refusals),
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
            "changedPaths": changed_paths_json(&changed_paths),
            "refusals": refusals_json(refusals),
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
            (
                (declined.version_id.clone(), declined.object_id.clone()),
                declined,
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>()
        .into_values()
        .map(|declined| {
            json!({
                "objectId": declined.object_id,
                "versionId": declined.version_id,
                "lineagePruned": declined.lineage_pruned,
                "headBlobSha256": declined.head_blob_sha256,
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
        RelayOperationOutcome::CursorCommitted {
            sharing_declined, ..
        } => json!({
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
        RelayOperationOutcome::HostedReplicaCreated => json!({ "hosted": true }),
        // Only `sync.pullHosted` answers a pass, and `sync.commitCursor` a
        // hosted commit, each fit to its budget.
        RelayOperationOutcome::HostedPass { .. }
        | RelayOperationOutcome::HostedCursorCommitted { .. } => {
            return Err(WireError::new(
                ErrorCode::Internal,
                "unexpected hosted pass outcome",
            ));
        }
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

/// A pull counted in `OpenWorkspace::pulls_in_flight`, uncounted on drop.
struct PullInFlight<'a>(&'a std::sync::atomic::AtomicUsize);

impl Drop for PullInFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
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
        open: &OpenWorkspace,
        cursor: IssuedCursor,
    ) -> Result<Value, WireError> {
        let workspace_id = open.workspace_id.as_str();
        for _ in 0..4 {
            let mut bytes = [0_u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|_| WireError::new(ErrorCode::Internal, "pending-cursor-token-failed"))?;
            let token = dohc_engine_storage::hex(&bytes);
            let (kind, wire_kind) = match &cursor {
                IssuedCursor::Relay(_) => (PendingCursorKind::Relay, "relay"),
                IssuedCursor::ShareView(_) => (PendingCursorKind::ShareView, "shareView"),
                IssuedCursor::Hosted(_) => (PendingCursorKind::Hosted, "hosted"),
            };
            let mut pending = lock(&self.pending_cursors);
            if pending.contains_key(&token) {
                continue;
            }
            pending.retain(|_, issued| {
                issued.handle != *handle
                    || issued.workspace_id != workspace_id
                    || !issued_as(&issued.cursor, kind)
            });
            let issue = open.cursors_issued[kind as usize].fetch_add(1, Ordering::Relaxed) + 1;
            pending.insert(
                token.clone(),
                PendingCursor {
                    handle: handle.clone(),
                    workspace_id: workspace_id.to_owned(),
                    cursor,
                    materialization_paths: Vec::new(),
                    materialized: false,
                    reconcile_collections: false,
                    departed_after: None,
                    issue,
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
    ) -> Result<PendingCursor, WireError> {
        let mut pending = lock(&self.pending_cursors);
        let valid = pending.get(token).is_some_and(|issued| {
            issued.handle == *handle
                && issued.workspace_id == workspace_id
                && issued_as(&issued.cursor, kind)
        });
        if !valid {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid-pending-cursor",
            ));
        }
        pending
            .remove(token)
            .ok_or_else(|| WireError::new(ErrorCode::InvalidParams, "invalid-pending-cursor"))
    }

    /// A commit answered CANCELLED or DEADLINE_EXCEEDED did not land, so its
    /// token stays usable for the retry. A closed workspace, or a cursor of
    /// the same kind issued since, even one already committed, leaves
    /// nothing to restore.
    fn restore_pending_cursor(
        &self,
        open: &Arc<OpenWorkspace>,
        kind: PendingCursorKind,
        token: String,
        cursor: PendingCursor,
    ) {
        let handles = lock(&self.handles);
        if !handles
            .get(&cursor.handle)
            .is_some_and(|bound| Arc::ptr_eq(bound, open))
        {
            return;
        }
        let mut pending = lock(&self.pending_cursors);
        if open.cursors_issued[kind as usize].load(Ordering::Relaxed) == cursor.issue {
            pending.insert(token, cursor);
        }
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

    /// Run a relay step that can abandon an unfinished ordinary pull: a final
    /// claim refusal, which the step saves and then answers with, or a
    /// replication identity change. Once the pull's token is gone, the
    /// Collections update it held back runs, whatever the step answered.
    async fn wake_after_abandoned_pull<T>(
        &self,
        ctx: &RequestContext,
        open: &OpenWorkspace,
        step: impl std::future::Future<Output = Result<T, WireError>>,
    ) -> Result<T, WireError> {
        let unfinished = || {
            open.actor
                .ordinary_pull_unfinished(open.workspace_id.clone())
        };
        // A token that cannot be read counts as set: the read after decides.
        let held = unfinished().await.unwrap_or(true);
        let answer = step.await;
        if held && matches!(unfinished().await, Ok(false)) {
            self.collections_changed(ctx, open).await;
        }
        answer
    }

    pub(super) async fn sync_push(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let push = || -> Result<RelayOperation, WireError> {
            Ok(RelayOperation::Push {
                workspace_id: open.workspace_id.clone(),
                now_ms: now_ms()?,
                max_read_bytes: self
                    .relay_sync_admission()
                    .map_or(0, |(policy, _)| policy.max_read_bytes),
            })
        };
        let mut outcome = self
            .relay_execute(ctx, &open, configuration, push()?, "sync.push")
            .await?;
        // A push can be what makes enrollment ready. The sweep inside it left
        // each open document to its session. Claim those now, then request a
        // fresh push budget for the newly queued bytes.
        let (claimed, declined) = self
            .originate_live_sessions(&open, landed_wait_until(ctx))
            .await;
        if claimed > 0
            && let RelayOperationOutcome::Sync(SyncPassOutcome::Complete { has_more, .. }) =
                &mut outcome
        {
            *has_more = true;
        }
        if let RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
            sharing_declined, ..
        }) = &mut outcome
        {
            sharing_declined.extend(declined);
        }
        self.settle_owed_collections(ctx, &open).await;
        relay_outcome_json(outcome)
    }

    /// Claim the unclaimed lineage of every live editor session in `open`
    /// for the relay, once enrollment is ready, and hand each session its
    /// claim. The session lock is held from before the claims are read until
    /// every claim is handed over, so no write of these sessions can expect
    /// the old claim. The work runs in its own task: a caller dropped on
    /// cancellation or deadline cannot release the lock between a committed
    /// claim and its handover. Each editor is then told to resync, which is
    /// how its client learns the claim. Returns how many lineages were
    /// claimed, and any declined as too large to share.
    ///
    /// It follows a landed push or commit, which answers with what landed,
    /// so it ignores the request's cancellation and waits for the session
    /// lock only until `until`. A failure, or a lock still held then, leaves
    /// the rest unclaimed, and the next push or commit claims them, as it
    /// retries enrollment.
    async fn originate_live_sessions(
        &self,
        open: &Arc<OpenWorkspace>,
        until: tokio::time::Instant,
    ) -> (usize, Vec<dohc_engine_sync::SharingDeclined>) {
        if open.mode == super::workspace::WorkspaceOpenMode::Passive {
            return (0, Vec::new());
        }
        let Ok(serial) =
            tokio::time::timeout_at(until, Arc::clone(&open.session_ops).lock_owned()).await
        else {
            return (0, Vec::new());
        };
        let handles: Vec<WorkspaceHandle> = lock(&self.handles)
            .iter()
            .filter(|(_, candidate)| Arc::ptr_eq(candidate, open))
            .map(|(handle, _)| handle.clone())
            .collect();
        let unclaimed: Vec<(String, DocKey)> = lock(&self.sessions)
            .iter()
            .filter(|(_, session)| {
                handles.contains(&session.workspace)
                    && session.lineage_claim_id.is_none()
                    && session.owner_draft.is_none()
                    && session.restore_generation.is_none()
            })
            .map(|(session_id, session)| (session_id.clone(), session.key.clone()))
            .collect();
        if unclaimed.is_empty() {
            return (0, Vec::new());
        }
        let sessions = Arc::clone(&self.sessions);
        let events = self.events.clone();
        let actor = open.actor.clone();
        let Ok(now) = now_ms() else {
            eprintln!("engine: live origination deferred: system clock unavailable");
            return (0, Vec::new());
        };
        let task = tokio::spawn(async move {
            let _serial = serial;
            let mut claimed = 0;
            let mut declined = Vec::new();
            let originated = async {
                for (session_id, key) in unclaimed {
                    let (claim, decline) = actor
                        .ydoc_originate_live_lineage(
                            key,
                            now,
                            dohc_engine_runtime::CancellationToken::new(),
                        )
                        .await?;
                    declined.extend(decline);
                    let Some(claim) = claim else { continue };
                    let handed = match lock(&sessions).get_mut(&session_id) {
                        Some(session) => {
                            session
                                .set_lineage_claim(Some(claim))
                                .map_err(dohc_engine_runtime::RuntimeError::Collab)?;
                            true
                        }
                        None => false,
                    };
                    if handed {
                        claimed += 1;
                        events.emit(
                            "ydoc.remoteUpdate",
                            json!({ "sessionId": session_id, "resyncRequired": true }),
                        );
                    }
                }
                Ok::<_, dohc_engine_runtime::RuntimeError>(())
            }
            .await;
            (claimed, declined, originated)
        });
        match task.await {
            Ok((claimed, declined, originated)) => {
                if let Err(error) = originated {
                    eprintln!("engine: live origination deferred: {error}");
                }
                (claimed, declined)
            }
            Err(error) => {
                eprintln!("engine: live origination task failed: {error}");
                (0, Vec::new())
            }
        }
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
        // A Collections update already admitted under the gate runs before
        // this pull places a page, and none is admitted until the pull is
        // between pages or done. The gate is not held across the relay's I/O.
        let pulling = if self.reconciles_collections_itself(&open) {
            let cancellation = OperationCancellation::new(ctx);
            let _apply = tokio::select! {
                biased;
                () = cancellation.token.cancelled() => return Err(cancellation.interruption("sync.pull")),
                guard = open.capture_apply_gate.lock() => guard,
            };
            open.pulls_in_flight.fetch_add(1, Ordering::SeqCst);
            Some(PullInFlight(&open.pulls_in_flight))
        } else {
            None
        };
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
        let passive = open.mode == super::workspace::WorkspaceOpenMode::Passive;
        // Reconcile only once the terminal page's cursor commits, which ends
        // the pull's token. A relation target may be on a later page, and
        // dangling-link cleanup must not observe the pull's partial state. The
        // bounded outcome does not expose whether an earlier page applied a
        // collection change, so the terminal page queues one reconciliation
        // even when that page itself was empty.
        let reconcile_at_commit = !passive
            && matches!(
                &outcome,
                RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                    has_more: false,
                    ..
                })
            );
        drop(pulling);
        // Post-commit: every applied envelope's record changes are durable,
        // even on a crash after apply (the cursor retries; the durable layer
        // dedupes, so a replay derives no second fact set).
        if !passive
            && let RelayOperationOutcome::Sync(
                SyncPassOutcome::Complete { record_facts, .. }
                | SyncPassOutcome::CrashedAfterApply { record_facts, .. },
            ) = &outcome
        {
            for facts in record_facts {
                emit_record_events(&self.events, &open.workspace_id, facts);
            }
        }
        // Every terminal page asks, whether or not it applied anything: an
        // earlier request may have been dropped, and the parked updates are the
        // debt, which only the editor's resync clears.
        if !passive
            && matches!(
                &outcome,
                RelayOperationOutcome::Sync(SyncPassOutcome::Complete {
                    has_more: false,
                    ..
                })
            )
        {
            self.notify_editors_behind(ctx, &open).await;
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
            let issued = self.issue_pending_cursor(bound_handle, &open, cursor)?;
            let token = issued["token"]
                .as_str()
                .ok_or_else(|| WireError::new(ErrorCode::Internal, "invalid issued cursor"))?;
            {
                let mut pending = lock(&self.pending_cursors);
                let entry = pending.get_mut(token).ok_or_else(|| {
                    WireError::new(ErrorCode::Internal, "issued cursor disappeared")
                })?;
                entry.materialization_paths = materialization_paths;
                entry.reconcile_collections = reconcile_at_commit;
            }
            result["pendingCursor"] = issued;
        } else if reconcile_at_commit {
            // Nothing to materialize or commit: the page's changes are in place.
            self.collections_changed(ctx, &open).await;
        }
        Ok(result)
    }

    /// A pull parks every Y.Doc update for a document an editor holds open,
    /// and only that editor's resync, settle, or close drains it. Ask each open
    /// editor of this workspace with parked updates it can take to resync, so
    /// an idle editor shows another device's edits. The request is advisory
    /// like every event, and the event queue drops it when full. The parked
    /// updates stay durable until the resync drains them, so the next pull asks
    /// again, including a pull that applies nothing. A failed check therefore
    /// does not fail the committed pull.
    async fn notify_editors_behind(&self, ctx: &RequestContext, open: &Arc<OpenWorkspace>) {
        let handles: Vec<WorkspaceHandle> = lock(&self.handles)
            .iter()
            .filter(|(_, candidate)| Arc::ptr_eq(candidate, open))
            .map(|(handle, _)| handle.clone())
            .collect();
        let (session_ids, sessions): (Vec<String>, Vec<(DocKey, String)>) = lock(&self.sessions)
            .iter()
            .filter(|(_, session)| {
                handles.contains(&session.workspace)
                    && session.owner_draft.is_none()
                    && session.restore_generation.is_none()
            })
            .filter_map(|(session_id, session)| {
                let lineage_claim_id = session.lineage_claim_id.clone()?;
                Some((session_id.clone(), (session.key.clone(), lineage_claim_id)))
            })
            .unzip();
        if sessions.is_empty() {
            return;
        }
        let cancellation = OperationCancellation::new(ctx);
        match open
            .actor
            .ydoc_sessions_behind(sessions, cancellation.token())
            .await
        {
            Ok(behind) => {
                for (session_id, _) in session_ids.iter().zip(behind).filter(|(_, is)| *is) {
                    self.events.emit(
                        "ydoc.remoteUpdate",
                        json!({ "sessionId": session_id, "resyncRequired": true }),
                    );
                }
            }
            Err(dohc_engine_runtime::RuntimeError::Cancelled) => {}
            Err(error) => eprintln!("engine: open editor resync check failed: {error}"),
        }
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
        let (kind, token) = match params.pending_cursor {
            PendingCursorParams::Relay { token } => (PendingCursorKind::Relay, token),
            PendingCursorParams::Hosted { token } => (PendingCursorKind::Hosted, token),
            PendingCursorParams::ShareView { .. } => {
                return Err(WireError::new(
                    ErrorCode::InvalidParams,
                    "ordinary materialization requires relay cursor",
                ));
            }
        };
        let paths = {
            let mut pending = lock(&self.pending_cursors);
            let issued = pending
                .get_mut(&token)
                .filter(|issued| {
                    issued.handle == *bound_handle
                        && issued.workspace_id == open.workspace_id
                        && issued_as(&issued.cursor, kind)
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
        // The page stops for cancellation only before it changes anything.
        Self::read_under_ctx(
            &cancellation,
            "sync.materializePendingCursor",
            open.actor.materialize_relay_page(
                open.workspace_id.clone(),
                open.root.clone(),
                paths,
                Arc::new(self.self_writes.scoped(&open.root)),
                now_ms()?,
                cancellation.token(),
            ),
        )
        .await?;
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
            PendingCursorParams::Hosted { token } => (PendingCursorKind::Hosted, token),
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
        let consumed =
            self.consume_pending_cursor(bound_handle, &open.workspace_id, kind, &token)?;
        let reconcile_collections = consumed.reconcile_collections;
        let departed_after = consumed.departed_after.clone();
        let share_view = matches!(&consumed.cursor, IssuedCursor::ShareView(_));
        let hosted = matches!(&consumed.cursor, IssuedCursor::Hosted(_));
        let operation = match consumed.cursor.clone() {
            IssuedCursor::Relay(cursor) => RelayOperation::CommitCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
                now_ms: now_ms()?,
            },
            IssuedCursor::ShareView(cursor) => RelayOperation::CommitShareViewCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
            },
            IssuedCursor::Hosted(cursor) => RelayOperation::CommitHostedCursor {
                workspace_id: open.workspace_id.clone(),
                cursor,
                root: open.root.clone(),
                now_ms: now_ms()?,
            },
        };
        let executed = if hosted {
            self.hosted_execute(ctx, &open, configuration, operation, "sync.commitCursor")
                .await
        } else {
            self.relay_execute(ctx, &open, configuration, operation, "sync.commitCursor")
                .await
        };
        let mut outcome = match executed {
            Err(error)
                if matches!(
                    error.code,
                    ErrorCode::Cancelled | ErrorCode::DeadlineExceeded
                ) =>
            {
                self.restore_pending_cursor(&open, kind, token, consumed);
                return Err(error);
            }
            executed => executed?,
        };
        // A hosted replica takes no part in enrollment. A pass fetched under
        // a scope that has since moved commits nothing. A commit that kept a
        // document held for the pass that writes its files has more to pull,
        // as does one that parked a departed document: work that waited for
        // its path. Parking that failed is reported as the error it would
        // have been, beside the commit that stands. A commit that could not
        // read what it left unready, or what departed documents remain, has
        // more to pull, whose pass releases or reports them, or says why it
        // cannot. `departed` is null when unread.
        if hosted {
            let RelayOperationOutcome::HostedCursorCommitted {
                commit,
                retirement,
                unready,
                departed,
            } = outcome
            else {
                return Err(WireError::new(
                    ErrorCode::Internal,
                    "unexpected hosted commit outcome",
                ));
            };
            return hosted_commit_json(
                commit,
                retirement,
                unready,
                departed,
                departed_after.as_deref(),
                HELD_RESPONSE_BYTE_BUDGET,
            );
        }
        if share_view && reconcile_collections {
            open.request_collection_reconcile();
        }
        // Only a terminal page's commit may reconcile: an earlier page can
        // hold a relation whose target is on a later one. An older pass's
        // terminal commit asks too, and the store keeps the update waiting
        // while a newer pass's token stands.
        let terminal_commit = reconcile_collections
            && !share_view
            && matches!(outcome, RelayOperationOutcome::CursorCommitted { .. });
        if terminal_commit {
            self.collections_landed(&open);
        }
        // A cursor commit can be what makes enrollment ready, as a push can.
        let (_, declined) = self
            .originate_live_sessions(&open, landed_wait_until(ctx))
            .await;
        if let RelayOperationOutcome::CursorCommitted {
            sharing_declined, ..
        } = &mut outcome
        {
            sharing_declined.extend(declined);
        }
        if terminal_commit {
            self.settle_owed_collections(ctx, &open).await;
        }
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

    /// `sync.collectionsWaiting`: whether Collections updates wait for an
    /// ordinary pull to commit its terminal page. A paused workspace still
    /// answers, so it needs no relay configuration and no finished initial
    /// capture.
    pub(super) async fn sync_collections_waiting(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
    ) -> Result<Value, WireError> {
        let open = self.open(handle.as_ref())?;
        let cancellation = OperationCancellation::new(ctx);
        let waiting = Self::read_under_ctx(
            &cancellation,
            "sync.collectionsWaiting",
            open.actor
                .ordinary_pull_unfinished(open.workspace_id.clone()),
        )
        .await?;
        Ok(json!({ "waiting": waiting }))
    }

    pub(super) async fn sync_refusal_notices(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let notices = Self::read_under_ctx(
            &cancellation,
            "sync.refusalNotices",
            open.actor.sync_refusal_notices(open.workspace_id.clone()),
        )
        .await?;
        Ok(json!({"notices": notices}))
    }

    pub(super) async fn sync_dismiss_refusal(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: DismissRefusalParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        if params.notice_id.len() != 77 || !params.notice_id.starts_with("sync-refusal-") {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "invalid refusal notice id",
            ));
        }
        if ctx.cancel.is_cancelled() {
            return Err(WireError::new(
                ErrorCode::Cancelled,
                "refusal dismissal cancelled",
            ));
        }
        open.actor
            .dismiss_sync_refusal(
                open.workspace_id.clone(),
                params.notice_id,
                params.refusal_coordinates,
            )
            .await
            .map_err(map_runtime)?;
        Ok(json!({}))
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
        let params: ClaimParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let claim = RelayOperation::Claim {
            workspace_id: open.workspace_id.clone(),
            account_id: params.account_id,
            new_origin_id: sync_identifier("origin")?,
            new_replication_epoch: sync_identifier("epoch")?,
            new_stream_identity: sync_identifier("stream")?,
            created_at_ms: now_ms()?,
        };
        let outcome = self
            .wake_after_abandoned_pull(
                ctx,
                &open,
                self.relay_execute(ctx, &open, configuration, claim, "sync.claim"),
            )
            .await?;
        relay_outcome_json(outcome)
    }

    pub(super) async fn sync_reset_claim_refusal(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ClaimParams = parse(params)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        Self::read_under_ctx(
            &cancellation,
            "sync.resetClaimRefusal",
            open.actor
                .reset_claim_refusal(open.workspace_id.clone(), params.account_id),
        )
        .await?;
        Ok(json!({ "reset": true }))
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

    /// `sync.createHostedReplica`: make this pristine workspace the session
    /// host's hosted replica under the coordinate the hosted feed's bootstrap
    /// names, with its main version. The daemon mints the `service-host:`
    /// origin. Call it before any other write: that write would give the
    /// workspace an ordinary identity, and a replica never changes between
    /// the two. Repeating it under the same coordinate answers the same.
    ///
    /// Each attach calls it before any other hosted call, and each call asks
    /// the relay for the highest position at the replica's origin. Above what
    /// the replica numbered, the store lost commits it pushed, and the call
    /// answers `relay-origin-diverged` before anything pulls or captures.
    pub(super) async fn sync_create_hosted_replica(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: HostedReplicaParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .relay_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::CreateHostedReplica {
                    workspace_id: open.workspace_id.clone(),
                    new_origin_id: format!(
                        "{}{}",
                        dohc_engine_sync::SERVICE_HOST_ORIGIN_PREFIX,
                        sync_identifier("host")?
                    ),
                    replication_epoch: params.replication_epoch,
                    stream_identity: params.stream_identity,
                    created_at_ms: now_ms()?,
                },
                "sync.createHostedReplica",
            )
            .await?;
        relay_outcome_json(outcome)
    }

    /// The namespace of the feed a hosted pull reads: the configured live
    /// host's, or none, which refuses the pull.
    fn hosted_feed_namespace(&self) -> Option<String> {
        #[cfg(feature = "harness")]
        if let Some(namespace) = &self.hosted_feed_for_harness {
            return Some(namespace.clone());
        }
        self.configured_relay_namespace()
    }

    /// `sync.pullHosted`: one pass of the hosted feed. A pass that adopted a
    /// new scope applies nothing and has no `pendingCursor`: pull again.
    /// Otherwise materialize its `pendingCursor` with
    /// `sync.materializePendingCursor`, then commit it with
    /// `sync.commitCursor`, and pull again while the pass or the commit
    /// answers `hasMore`. Adopting a scope and committing also park the
    /// documents that left the scope. The pass's held documents are listed
    /// after `heldAfter`, as many as fit; the next pull asks after its
    /// `heldThrough`, and from the first again once that is null. Departed
    /// documents page the same way, after `departedAfter` through
    /// `departedThrough`, in the pass and in its commit.
    pub(super) async fn sync_pull_hosted(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
        request_id: u64,
    ) -> Result<Value, WireError> {
        let params: PullHostedParams = parse(params)?;
        for after in [&params.held_after, &params.departed_after]
            .into_iter()
            .flatten()
        {
            super::held_documents::object_id(after)?;
        }
        let bound_handle = handle.as_ref().ok_or_else(workspace_unavailable)?;
        // The feed's namespace comes only from the configured host, and a
        // hosted pass records it with everything it keeps. Without one the
        // pull is refused before it reads or changes anything.
        let relay_namespace = self
            .hosted_feed_namespace()
            .ok_or_else(|| WireError::new(ErrorCode::Forbidden, "live host is not configured"))?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let outcome = self
            .hosted_execute(
                ctx,
                &open,
                configuration,
                RelayOperation::PullHosted {
                    workspace_id: open.workspace_id.clone(),
                    root: open.root.clone(),
                    relay_namespace,
                    now_ms: now_ms()?,
                },
                "sync.pullHosted",
            )
            .await?;
        let RelayOperationOutcome::HostedPass {
            mut pass, departed, ..
        } = outcome
        else {
            return Err(WireError::new(
                ErrorCode::Internal,
                "unexpected hosted pass outcome",
            ));
        };
        for facts in std::mem::take(&mut pass.record_facts) {
            emit_record_events(&self.events, &open.workspace_id, &facts);
        }
        if !pass.has_more {
            self.notify_editors_behind(ctx, &open).await;
        }
        let pending_cursor = match pass.pending_cursor.take() {
            Some(cursor) => {
                let issued =
                    self.issue_pending_cursor(bound_handle, &open, IssuedCursor::Hosted(cursor))?;
                let token = issued["token"]
                    .as_str()
                    .ok_or_else(|| WireError::new(ErrorCode::Internal, "invalid issued cursor"))?;
                let mut pending = lock(&self.pending_cursors);
                let entry = pending.get_mut(token).ok_or_else(|| {
                    WireError::new(ErrorCode::Internal, "issued cursor disappeared")
                })?;
                entry.materialization_paths = pass.changed_paths.clone();
                entry.departed_after = params.departed_after.clone();
                drop(pending);
                issued
            }
            None => Value::Null,
        };
        hosted_pass_json(
            request_id,
            pass,
            departed,
            pending_cursor,
            params.held_after.as_deref(),
            params.departed_after.as_deref(),
            HELD_RESPONSE_BYTE_BUDGET,
        )
    }

    pub(super) async fn sync_recover_origin(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: RelayWorkspaceParams = parse(params)?;
        let (open, configuration) = self.relay_open(handle.as_ref(), &params.workspace_id)?;
        let recover = RelayOperation::RecoverOrigin {
            workspace_id: open.workspace_id.clone(),
            new_origin_id: recovered_origin_id()?,
        };
        let outcome = self
            .wake_after_abandoned_pull(
                ctx,
                &open,
                self.relay_execute(ctx, &open, configuration, recover, "sync.recoverOrigin"),
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
            RelayOperationOutcome::ShareViewPulled(outcome) => Some((
                IssuedCursor::ShareView(outcome.pending_cursor.clone()),
                // A replay after a crash can dedupe every write but still
                // complete the first cursor and make projection safe.
                outcome.applied > 0 || !outcome.changed_paths.is_empty(),
            )),
            _ => None,
        };
        let mut result = relay_outcome_json(outcome)?;
        if let Some((cursor, applied)) = pending {
            let issued = self.issue_pending_cursor(bound_handle, &open, cursor)?;
            if let Some(token) = issued["token"].as_str()
                && let Some(entry) = lock(&self.pending_cursors).get_mut(token)
            {
                entry.reconcile_collections = applied;
            }
            result["pendingCursor"] = issued;
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
    /// recipient's ops by share, authenticated member, and replica — so it must never be
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

    pub(super) async fn share_direct_status(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareDirectStatusParams = parse(params)?;
        let granted = share_grant(params.granted_selector)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let status = Self::read_under_ctx(
            &cancellation,
            "share.direct.status",
            open.actor.share_direct_status(
                open.workspace_id.clone(),
                params.share_id,
                params.path,
                granted,
            ),
        )
        .await?;
        serde_json::to_value(status).map_err(|_| {
            WireError::new(
                ErrorCode::Internal,
                "direct-write-status-serialization-failed",
            )
        })
    }

    pub(super) async fn share_direct_statuses(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareFileStatusesParams = parse(params)?;
        if params.paths.len() > 256 {
            return Err(WireError::new(
                ErrorCode::InvalidParams,
                "too-many-share-status-paths",
            ));
        }
        let granted = share_grant(params.granted_selector)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let mut statuses = serde_json::Map::new();
        for path in params.paths {
            let status = Self::read_under_ctx(
                &cancellation,
                "share.direct.statuses",
                open.actor.share_direct_status(
                    open.workspace_id.clone(),
                    params.share_id.clone(),
                    path.clone(),
                    granted.clone(),
                ),
            )
            .await?;
            statuses.insert(
                path,
                serde_json::to_value(status).map_err(|_| {
                    WireError::new(
                        ErrorCode::Internal,
                        "direct-write-status-serialization-failed",
                    )
                })?,
            );
        }
        Ok(Value::Object(statuses))
    }

    pub(super) async fn share_record_creation_statuses(
        &self,
        ctx: &RequestContext,
        handle: Option<WorkspaceHandle>,
        params: Value,
    ) -> Result<Value, WireError> {
        let params: ShareFileStatusesParams = parse(params)?;
        let granted = share_grant(params.granted_selector)?;
        let open = self.open(handle.as_ref())?;
        validate_workspace_param(Some(&params.workspace_id), &open.workspace_id)?;
        let cancellation = OperationCancellation::new(ctx);
        let statuses = Self::read_under_ctx(
            &cancellation,
            "share.records.status",
            open.actor.share_record_creation_statuses(
                open.workspace_id.clone(),
                params.share_id,
                params.paths,
                granted,
            ),
        )
        .await?;
        serde_json::to_value(statuses).map_err(|_| {
            WireError::new(
                ErrorCode::Internal,
                "record-creation-status-serialization-failed",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dohc_engine_runtime::RelayOperationOutcome;
    use dohc_engine_sync::ShareCursor;
    use dohc_engine_sync::SyncPassOutcome;
    use serde_json::json;

    fn released_binding() -> dohc_engine_collab::live_update_application::ReleasedLineageBinding {
        use dohc_engine_collab::live_update_application::{
            IncomingCoordinate, ProtectedTails, ReleasedLineageBinding,
        };
        ReleasedLineageBinding {
            workspace_id: "workspace".into(),
            main_version_id: "main".into(),
            object_id: "object".into(),
            lineage_claim_id: "a".repeat(64),
            current_path: Some("notes/plan.md".into()),
            restore_generation: Some(0),
            incoming: IncomingCoordinate {
                relay_namespace: Some("relay".into()),
                replication_epoch: "epoch".into(),
                stream_identity: "stream".into(),
                origin_id: "desktop".into(),
                origin_seq: 3,
                relay_seq: 9,
            },
            head_digest: "b".repeat(64),
            tails: std::sync::Arc::new(ProtectedTails::Invalid),
        }
    }

    fn released_hold() -> dohc_engine_sync::HostedHold {
        dohc_engine_sync::HostedHold::ReleasedLineageUnsettled {
            binding: Box::new(released_binding()),
            continuation: dohc_engine_sync::ReleasedHoldContinuation::Frozen,
            binding_stale: false,
        }
    }

    /// A released-lineage hold reaches the relay as the summary discovery
    /// lists: its path, its binding's digest, continuation and staleness,
    /// never the binding, whose tails are unbounded.
    #[test]
    fn a_released_lineage_hold_reaches_the_wire_as_its_summary() {
        let held =
            hosted_hold_json("object", &released_hold(), Some("notes/plan.md")).expect("summary");
        assert_eq!(
            held,
            json!({
                "objectId": "object", "reason": "released-lineage-unsettled",
                "path": "notes/plan.md", "bindingDigest": released_binding().digest(),
                "continuation": "frozen", "bindingStale": false,
            })
        );
        assert!(held.get("binding").is_none(), "{held}");
    }

    /// Opus's review: a released-lineage hold whose path the pass did not
    /// record reached the wire as a null path, which the relay refuses on
    /// every pull. The answer is an internal error instead.
    #[test]
    fn a_held_document_with_no_recorded_path_answers_an_internal_error() {
        let pass = HostedPassOutcome {
            held: BTreeMap::from([("object".to_owned(), released_hold())]),
            ..HostedPassOutcome::default()
        };
        let error = hosted_pass_json(
            7,
            pass,
            Vec::new(),
            Value::Null,
            None,
            None,
            HELD_RESPONSE_BYTE_BUDGET,
        )
        .expect_err("a hold without its path");
        assert_eq!(error.code, ErrorCode::Internal);
    }

    /// `count` documents held for work waiting, of about 110 bytes each.
    fn waiting(count: usize) -> BTreeMap<String, dohc_engine_sync::HostedHold> {
        (0..count)
            .map(|index| {
                (
                    format!("doc-{index:05}-{}", "x".repeat(100)),
                    dohc_engine_sync::HostedHold::WorkWaiting,
                )
            })
            .collect()
    }

    /// A 300-byte identifier that sorts by `index`.
    fn long_id(index: usize) -> String {
        format!("{index:05}-{}", "x".repeat(294))
    }

    /// The object IDs a list names, in its order.
    fn object_ids(list: &Value) -> Vec<String> {
        list.as_array()
            .expect("list")
            .iter()
            .map(|entry| {
                let id = entry.get("objectId").unwrap_or(entry);
                id.as_str().expect("object ID").to_owned()
            })
            .collect()
    }

    /// Every answer to the pulls that page through the pass's held and
    /// departed lists from the first, each asking after where the last
    /// answer's lists stopped and within the budget, until both reached
    /// their last.
    fn pages(pass: &HostedPassOutcome, departed: &[String]) -> Vec<Value> {
        let pending = json!({"kind": "hosted", "token": "a".repeat(64)});
        let mut pages = Vec::new();
        let (mut held_after, mut departed_after) = (None::<String>, None::<String>);
        let (mut held_done, mut departed_done) = (false, false);
        loop {
            let value = hosted_pass_json(
                7,
                pass.clone(),
                departed.to_vec(),
                pending.clone(),
                held_after.as_deref(),
                departed_after.as_deref(),
                HELD_RESPONSE_BYTE_BUDGET,
            )
            .expect("answer");
            assert!(response_encoded_bytes(7, &value) <= HELD_RESPONSE_BYTE_BUDGET);
            assert_eq!(value["pendingCursor"], pending);
            held_after = value["heldThrough"].as_str().map(str::to_owned);
            departed_after = value["departedThrough"].as_str().map(str::to_owned);
            assert!(
                held_after.is_none() || object_ids(&value["held"]).last() == held_after.as_ref()
            );
            assert!(
                departed_after.is_none()
                    || object_ids(&value["departed"]).last() == departed_after.as_ref()
            );
            held_done |= held_after.is_none();
            departed_done |= departed_after.is_none();
            pages.push(value);
            if held_done && departed_done {
                return pages;
            }
        }
    }

    /// What `list` names across `pages`, through the first page that
    /// reached its last.
    fn paged(pages: &[Value], list: &str) -> Vec<String> {
        let through = format!("{list}Through");
        let end = pages
            .iter()
            .position(|page| page[through.as_str()].is_null())
            .expect("a last page");
        pages[..=end]
            .iter()
            .flat_map(|page| object_ids(&page[list]))
            .collect()
    }

    /// A pass that holds more documents than one answer fits lists them in
    /// object ID order within the budget and says where its list stops. The
    /// pulls that ask after there list the rest, each document once, and
    /// the last says its list is complete.
    #[test]
    fn a_pass_holding_more_than_fits_pages_its_held_list_within_budget() {
        let pass = HostedPassOutcome {
            held: waiting(2_000),
            ..HostedPassOutcome::default()
        };
        let pages = pages(&pass, &["gone".to_owned()]);
        assert!(
            pages.len() > 1,
            "2,000 holds of about 160 bytes pass 240 KiB"
        );
        assert!(
            paged(&pages, "held")
                .into_iter()
                .eq(pass.held.keys().cloned())
        );
        let gone = |page: &Value| page["departed"] == json!(["gone"]);
        assert!(
            pages
                .iter()
                .all(|page| gone(page) && page["departedThrough"].is_null())
        );
    }

    /// Sol's review: departed documents the engine cannot park, more than
    /// fit, filled every answer's departed list from the first, so one after
    /// them was never named and its host never learned it parked. The list
    /// now pages after where the pull asks, like the held list, and keeps a
    /// share however much else the pass reports: every departed document is
    /// listed within a few pulls, each once, and a parked one, listed by
    /// none, is known gone.
    #[test]
    fn a_stuck_departed_prefix_larger_than_fits_still_pages_to_the_documents_after_it() {
        let pass = HostedPassOutcome {
            held: waiting(2_000),
            ..HostedPassOutcome::default()
        };
        // A removed folder of 1,000 documents nothing parks: about 300 KiB
        // of IDs alone. The parked document after them is in none.
        let departed = (0..1_000).map(long_id).collect::<Vec<_>>();
        let pages = pages(&pass, &departed);
        assert!(!object_ids(&pages[0]["departed"]).is_empty());
        assert!(pages[0]["departedThrough"].is_string());
        assert_eq!(paged(&pages, "departed"), departed);
        assert!(
            paged(&pages, "held")
                .into_iter()
                .eq(pass.held.keys().cloned())
        );
    }

    /// Sol's and Opus's review: changed paths, refusals and declined shares
    /// went out whole, so they alone could pass the budget. Each list now
    /// stops where it no longer fits and counts what it leaves out. The held
    /// and departed lists keep their shares and page on, and a document the
    /// pass moved from ready to held is named, only by what the relay needs,
    /// though the page stops before it.
    #[test]
    fn a_pass_reporting_more_than_fits_cuts_each_list_and_counts_what_it_leaves_out() {
        let held = waiting(2_000);
        let last = held.keys().next_back().expect("held").clone();
        let pass = HostedPassOutcome {
            newly_held: [last.clone()].into(),
            changed_paths: (0..2_000)
                .map(|index| dohc_engine_sync::MomentMaterializationChange {
                    version_id: "main".to_owned(),
                    path: format!("docs/{}.md", long_id(index)),
                    operation: "write",
                    content_kind: "text",
                })
                .collect(),
            refusals: (0..2_000)
                .map(|index| dohc_engine_sync::ReplicationRefusal {
                    workspace_id: "workspace".to_owned(),
                    origin_id: "peer".to_owned(),
                    origin_seq: i64::try_from(index).expect("sequence"),
                    op_kind: "text.write".to_owned(),
                    reason: dohc_engine_sync::RefusalReason::InvalidInput {
                        reason: long_id(index),
                    },
                })
                .collect(),
            sharing_declined: (0..2_000)
                .map(|index| dohc_engine_sync::SharingDeclined {
                    object_id: long_id(index),
                    version_id: "main".to_owned(),
                    lineage_pruned: false,
                    head_blob_sha256: None,
                    path: format!("docs/{}.md", long_id(index)),
                    constraint: "MAX_YDOC_UPDATE_BYTES",
                    limit_bytes: 1,
                    observed_bytes: 2,
                })
                .collect(),
            held,
            ..HostedPassOutcome::default()
        };
        // A removed folder of 1,000 documents: about 300 KiB of IDs alone.
        let departed = (0..1_000).map(long_id).collect::<Vec<_>>();
        let pages = pages(&pass, &departed);
        let first = &pages[0];
        for list in ["refusals", "sharingDeclined", "changedPaths"] {
            let listed = first[list].as_array().expect("list").len() as u64;
            let omitted = first[format!("{list}Omitted")].as_u64().expect("count");
            assert!(omitted > 0, "{list} is cut");
            assert_eq!(listed + omitted, 2_000, "{list}");
        }
        let held = object_ids(&first["held"]);
        assert!(
            held.len() > 300,
            "the held list keeps its share: {}",
            held.len()
        );
        assert!(!held.contains(&last));
        assert!(object_ids(&first["departed"]).len() > 40, "{first}");
        assert_eq!(
            (&first["newlyHeld"], &first["newlyHeldOmitted"]),
            (
                &json!([{"objectId": last, "reason": "hosted-backfill-work-waiting"}]),
                &json!(0)
            )
        );
        assert!(
            paged(&pages, "held")
                .into_iter()
                .eq(pass.held.keys().cloned())
        );
        assert_eq!(paged(&pages, "departed"), departed);
    }

    /// Sol's review: a pass moving more documents from ready to held than
    /// fit cut `newlyHeld` without saying so, so the relay could keep a
    /// held document open. Each entry is now only what the relay needs, a
    /// cut list counts what it leaves out, and the answer stays in budget.
    #[test]
    fn a_pass_holding_more_documents_newly_than_fit_counts_what_it_leaves_out() {
        let mut held = (0..2_000)
            .map(|index| (long_id(index), dohc_engine_sync::HostedHold::WorkWaiting))
            .collect::<BTreeMap<_, _>>();
        held.insert(long_id(2_000), released_hold());
        let pass = HostedPassOutcome {
            newly_held: held.keys().cloned().collect(),
            held_paths: BTreeMap::from([(long_id(2_000), "notes/plan.md".to_owned())]),
            held,
            ..HostedPassOutcome::default()
        };
        let cut = pages(&pass, &[]);
        let first = &cut[0];
        let listed = object_ids(&first["newlyHeld"]);
        let omitted = first["newlyHeldOmitted"].as_u64().expect("count");
        assert!(listed.len() > 300 && omitted > 0, "{} listed", listed.len());
        assert_eq!(listed.len() as u64 + omitted, 2_001);
        assert_eq!(
            first["newlyHeld"][0],
            json!({"objectId": long_id(0), "reason": "hosted-backfill-work-waiting"})
        );
        let whole = pages(
            &HostedPassOutcome {
                newly_held: [long_id(2_000)].into(),
                ..pass.clone()
            },
            &[],
        );
        assert_eq!(
            whole[0]["newlyHeld"],
            json!([{
                "objectId": long_id(2_000), "reason": "released-lineage-unsettled",
                "bindingDigest": released_binding().digest(),
            }])
        );
        assert_eq!(whole[0]["newlyHeldOmitted"], 0);
    }

    /// Sol's review, for the commit: its departed list pages after where
    /// its pass's list started, so the commit after a pull that asked past
    /// a stuck prefix lists the documents after it. An unread list is null.
    #[test]
    fn a_hosted_commit_lists_departed_documents_after_where_its_pass_asked() {
        let departed = (0..1_000).map(long_id).collect::<Vec<_>>();
        let commit = |after: Option<&str>, departed| {
            let value = hosted_commit_json(
                COMMITTED,
                Ok(false),
                Ok(Vec::new()),
                departed,
                after,
                HELD_RESPONSE_BYTE_BUDGET,
            )
            .expect("commit JSON");
            assert!(response_encoded_bytes(u64::MAX, &value) <= HELD_RESPONSE_BYTE_BUDGET);
            value
        };
        let first = commit(None, Ok(departed.clone()));
        let listed = object_ids(&first["departed"]);
        assert!(!listed.is_empty() && listed.len() < 1_000);
        assert_eq!(listed, departed[..listed.len()]);
        assert_eq!(first["departedThrough"], json!(listed.last()));
        let next = commit(first["departedThrough"].as_str(), Ok(departed.clone()));
        let after = object_ids(&next["departed"]);
        assert_eq!(after.first(), departed.get(listed.len()));
        let last = commit(Some(departed[998].as_str()), Ok(departed.clone()));
        assert_eq!(
            (&last["departed"], &last["departedThrough"]),
            (&json!([departed[999]]), &Value::Null)
        );
        let unread = commit(
            None,
            Err(dohc_engine_runtime::RuntimeError::ActorUnavailable),
        );
        assert_eq!(
            (
                &unread["departed"],
                &unread["departedThrough"],
                &unread["hasMore"]
            ),
            (&Value::Null, &Value::Null, &json!(true))
        );
    }

    #[tokio::test]
    async fn direct_status_reads_offline_and_preserves_workspace_and_path_fences() {
        let scratch = dohc_engine_testkit::ScratchDir::new().expect("scratch");
        let supervisor: &'static dohc_engine_runtime::WorkspaceSupervisor =
            Box::leak(Box::new(dohc_engine_runtime::WorkspaceSupervisor::new()));
        let service = EngineService::with_supervisor(supervisor);
        let opened = service
            .workspace_open(
                &RequestContext::unbounded(),
                json!({
                    "rootDir": scratch.path().to_string_lossy(), "workspaceId": "offline-share",
                    "captureMode": "none",
                }),
            )
            .await
            .expect("open without relay");
        let handle: WorkspaceHandle = serde_json::from_value(opened["workspace"].clone()).unwrap();
        let params = json!({
            "workspaceId": "offline-share", "shareId": "share", "path": "data/automations.yaml",
            "grantedSelector": {"paths": ["data"], "access": "edit"},
        });
        assert_eq!(
            service
                .share_direct_status(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    params.clone()
                )
                .await
                .expect("offline status"),
            json!({"contentHash": null, "state": "accepted", "canDiscard": false})
        );
        let batch = json!({
            "workspaceId": "offline-share", "shareId": "share",
            "paths": ["data/automations.yaml", "data/draft.md"],
            "grantedSelector": {"paths": ["data"], "access": "edit"},
        });
        let statuses = service
            .share_direct_statuses(
                &RequestContext::unbounded(),
                Some(handle.clone()),
                batch.clone(),
            )
            .await
            .expect("offline batch");
        assert_eq!(statuses["data/automations.yaml"]["state"], "accepted");
        assert_eq!(statuses["data/draft.md"]["state"], "accepted");
        let mut bad_batch = batch.clone();
        bad_batch["workspaceId"] = json!("other");
        assert!(
            service
                .share_direct_statuses(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    bad_batch
                )
                .await
                .is_err()
        );
        let mut bad_batch = batch.clone();
        bad_batch["paths"] = json!(["data/automations.yaml", "private/file.md"]);
        assert!(
            service
                .share_direct_statuses(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    bad_batch
                )
                .await
                .is_err()
        );
        let mut bad_batch = batch;
        bad_batch["paths"] = json!(vec!["data/file.md"; 257]);
        assert!(
            service
                .share_direct_statuses(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    bad_batch
                )
                .await
                .is_err()
        );
        let mut wrong_workspace = params.clone();
        wrong_workspace["workspaceId"] = json!("other");
        assert!(matches!(
            service
                .share_direct_status(
                    &RequestContext::unbounded(),
                    Some(handle.clone()),
                    wrong_workspace
                )
                .await,
            Err(WireError {
                code: ErrorCode::InvalidParams,
                ..
            })
        ));
        let mut outside = params.clone();
        outside["path"] = json!("private/automations.yaml");
        assert!(
            service
                .share_direct_status(&RequestContext::unbounded(), Some(handle.clone()), outside)
                .await
                .is_err()
        );
        service
            .workspace_close(Some(handle.clone()))
            .await
            .expect("close");
        assert!(matches!(
            service
                .share_direct_status(&RequestContext::unbounded(), Some(handle), params)
                .await,
            Err(WireError {
                code: ErrorCode::WorkspaceUnavailable,
                ..
            })
        ));
    }

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

    /// A relay workspace with no capture driver and a fake relay address, for
    /// RPCs that only touch the local store.
    struct CursorFixture {
        scratch: dohc_engine_testkit::ScratchDir,
        workspaces: &'static dohc_engine_runtime::WorkspaceSupervisor,
        service: Arc<EngineService>,
        handle: WorkspaceHandle,
        open: Arc<OpenWorkspace>,
        workspace_id: &'static str,
        reconcile_collections: bool,
        relay: Value,
    }

    const SOURCE: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TARGET: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
    const RELATION_SCHEMA: &str =
        "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n";

    /// A Collection record's Markdown, related to `related` when named.
    fn record(id: &str, related: Option<&str>) -> String {
        match related {
            Some(related) => format!("---\nid: {id}\nrelated: {related}\n---\n\nRecord\n"),
            None => format!("---\nid: {id}\n---\n\nRecord\n"),
        }
    }

    impl CursorFixture {
        async fn new(workspace_id: &'static str, reconcile_collections: bool) -> Self {
            Self::with_relay(
                workspace_id,
                reconcile_collections,
                json!({ "baseUrl": "https://relay.example", "bearerToken": "test-token" }),
            )
            .await
        }

        async fn with_relay(
            workspace_id: &'static str,
            reconcile_collections: bool,
            relay: Value,
        ) -> Self {
            let workspaces: &'static dohc_engine_runtime::WorkspaceSupervisor =
                Box::leak(Box::new(dohc_engine_runtime::WorkspaceSupervisor::new()));
            Self::open_at(
                dohc_engine_testkit::ScratchDir::new().expect("scratch"),
                workspaces,
                workspace_id,
                reconcile_collections,
                relay,
            )
            .await
        }

        fn open_params(
            scratch: &dohc_engine_testkit::ScratchDir,
            workspace_id: &str,
            reconcile_collections: bool,
            relay: &Value,
        ) -> Value {
            json!({
                "rootDir": scratch.path().to_string_lossy(),
                "workspaceId": workspace_id,
                "captureMode": "none",
                "reconcileCollections": reconcile_collections,
                "relay": relay,
            })
        }

        async fn open_at(
            scratch: dohc_engine_testkit::ScratchDir,
            workspaces: &'static dohc_engine_runtime::WorkspaceSupervisor,
            workspace_id: &'static str,
            reconcile_collections: bool,
            relay: Value,
        ) -> Self {
            let params = Self::open_params(&scratch, workspace_id, reconcile_collections, &relay);
            Self::open_with(
                scratch,
                workspaces,
                workspace_id,
                reconcile_collections,
                relay,
                params,
            )
            .await
        }

        async fn open_with(
            scratch: dohc_engine_testkit::ScratchDir,
            workspaces: &'static dohc_engine_runtime::WorkspaceSupervisor,
            workspace_id: &'static str,
            reconcile_collections: bool,
            relay: Value,
            params: Value,
        ) -> Self {
            let service = Arc::new(EngineService::with_supervisor(workspaces));
            let opened = service
                .workspace_open(&RequestContext::unbounded(), params)
                .await
                .expect("workspace open");
            let handle: WorkspaceHandle =
                serde_json::from_value(opened["workspace"].clone()).expect("handle");
            let open = service.open(Some(&handle)).expect("open");
            CursorFixture {
                scratch,
                workspaces,
                service,
                handle,
                open,
                workspace_id,
                reconcile_collections,
                relay,
            }
        }

        /// Stop this daemon and open the workspace in a new one.
        async fn restart(self) -> Self {
            let CursorFixture {
                scratch,
                workspaces,
                service,
                handle,
                workspace_id,
                reconcile_collections,
                relay,
                ..
            } = self;
            service.workspace_close(Some(handle)).await.expect("close");
            drop(service);
            Self::open_at(
                scratch,
                workspaces,
                workspace_id,
                reconcile_collections,
                relay,
            )
            .await
        }

        /// Stop this daemon, then open the workspace locally, as desktop does
        /// once sync is paused: no relay, and the unfinished pull abandoned.
        async fn reopen_paused(self) -> Self {
            let CursorFixture {
                scratch,
                workspaces,
                service,
                handle,
                workspace_id,
                reconcile_collections,
                ..
            } = self;
            service.workspace_close(Some(handle)).await.expect("close");
            drop(service);
            let mut params =
                Self::open_params(&scratch, workspace_id, reconcile_collections, &Value::Null);
            params["abandonOrdinaryPull"] = json!(true);
            Self::open_with(
                scratch,
                workspaces,
                workspace_id,
                reconcile_collections,
                Value::Null,
                params,
            )
            .await
        }

        /// The main version, and the local sync identity a chat change gives
        /// the workspace, which a cursor commit needs once it holds files.
        async fn prepare(&self) {
            self.open
                .actor
                .ensure_main_version(
                    self.workspace_id.into(),
                    1,
                    Arc::new(dohc_engine_storage::NoFaults),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .expect("main");
            self.service
                .chats_channels_create(
                    &RequestContext::unbounded(),
                    Some(self.handle.clone()),
                    json!({ "channelId": "identity", "name": "Identity", "kind": "channel", "nowMs": 1 }),
                )
                .await
                .expect("local identity");
        }

        /// Place a file as a pulled page does, in the store and on disk,
        /// without updating Collections.
        async fn pulled(&self, object: &str, path: &str, text: &str) {
            self.open
                .actor
                .versioned_text_write(
                    dohc_engine_domain::WriteText {
                        workspace_id: self.workspace_id.into(),
                        version_id: "main".into(),
                        object_id: object.into(),
                        path: path.into(),
                        text: text.into(),
                        moment_id: format!(
                            "{object}-{}",
                            dohc_engine_storage::hex_sha256(text.as_bytes())
                        ),
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 2,
                        request_id: None,
                    },
                    Arc::new(dohc_engine_storage::NoFaults),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .expect("pulled file");
            let file = self.open.root.join(path);
            std::fs::create_dir_all(file.parent().expect("folder")).expect("folder");
            std::fs::write(file, text).expect("pulled file on disk");
        }

        /// Remove a file as a pulled page does, without updating Collections.
        async fn pulled_removal(&self, path: &str) {
            self.open
                .actor
                .versioned_text_delete(
                    dohc_engine_domain::DeleteTextFile {
                        workspace_id: self.workspace_id.into(),
                        version_id: "main".into(),
                        path: path.into(),
                        moment_id: format!("delete-{path}"),
                        request_id: None,
                        metadata_origin: "sync".into(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: 5,
                    },
                    self.open.root.clone(),
                    Arc::new(self.service.self_writes.scoped(&self.open.root)),
                    Arc::new(dohc_engine_storage::NoFaults),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .expect("pulled removal");
        }

        /// Record `tasks/source.md`'s rich document as an editor's session
        /// does, which a Collections relation cleanup edits through.
        async fn source_lineage(&self, markdown: &str) {
            let state = self
                .open
                .actor
                .ydoc_open_state(
                    self.workspace_id.into(),
                    3,
                    false,
                    None,
                    "main".into(),
                    "tasks/source.md".into(),
                    Some(dohc_engine_collab::ContentKind::Richdoc),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .expect("source state");
            let doc = dohc_engine_collab::Ydoc::wire();
            doc.apply(&state.initial_update).expect("apply");
            doc.rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, markdown)
                .expect("rewrite");
            self.open
                .actor
                .ydoc_record_update(
                    state.key,
                    "tasks/source.md".into(),
                    dohc_engine_collab::ContentKind::Richdoc,
                    state.regime,
                    doc.encode_full_state(),
                    None,
                    None,
                    state.lineage_claim_id,
                    true,
                    state.owner_seed_source,
                    None,
                    4,
                    Arc::new(dohc_engine_storage::NoFaults),
                    dohc_engine_runtime::CancellationToken::new(),
                    None,
                )
                .await
                .expect("source lineage");
        }

        /// Commit a pulled page's cursor. Only a terminal page's commit may
        /// reconcile Collections.
        async fn commit(&self, cursor: i64, terminal: bool) -> Result<Value, WireError> {
            let token = self.issue(cursor);
            lock(&self.service.pending_cursors)
                .get_mut(&token)
                .expect("issued")
                .reconcile_collections = terminal;
            let request = self.request(0, "sync.commitCursor", &token);
            self.service
                .sync_commit_cursor(
                    &RequestContext::unbounded(),
                    request.workspace,
                    request.params,
                )
                .await
        }

        /// A text write through `versionedText.write`.
        async fn write(&self, path: &str, text: &str) -> Result<Value, WireError> {
            self.service
                .versioned_text_write(
                    &RequestContext::unbounded(),
                    dohc_engine_protocol::wire::Request {
                        id: 0,
                        method: "versionedText.write".into(),
                        workspace: Some(self.handle.clone()),
                        deadline_ms: None,
                        idempotency_key: None,
                        progress: false,
                        params: json!({
                            "workspaceId": self.workspace_id, "versionId": "main", "path": path,
                            "text": text, "origin": "api", "publish": true,
                        }),
                    },
                )
                .await
        }

        /// How many relations the workspace's Collections hold.
        fn edges(&self) -> i64 {
            rusqlite::Connection::open_with_flags(
                self.open.actor.database_path(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .expect("engine db")
            .query_row(
                "SELECT COUNT(*) FROM collection_relation_edges",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("read edges")
        }

        fn owed(&self) -> bool {
            self.open.collections_owed.load(Ordering::SeqCst)
        }

        fn engine_db(&self) -> rusqlite::Connection {
            let conn =
                rusqlite::Connection::open(self.open.actor.database_path()).expect("engine db");
            conn.busy_timeout(std::time::Duration::from_secs(5))
                .expect("busy timeout");
            conn
        }

        /// Start an ordinary pull pass as the store does before its first
        /// page-dependent write, and return its token.
        fn begin_pass(&self, token: &str) -> String {
            self.engine_db()
                .execute(
                    "UPDATE sync_identity SET ordinary_pull_token=?2 WHERE workspace_id=?1",
                    [self.workspace_id, token],
                )
                .expect("begin pass");
            token.to_owned()
        }

        fn pull_token(&self) -> Option<String> {
            self.engine_db()
                .query_row(
                    "SELECT ordinary_pull_token FROM sync_identity WHERE workspace_id=?1",
                    [self.workspace_id],
                    |row| row.get(0),
                )
                .expect("read pull token")
        }

        /// What `sync.collectionsWaiting` answers.
        async fn collections_waiting(&self) -> bool {
            let waiting = self
                .service
                .sync_collections_waiting(&RequestContext::unbounded(), Some(self.handle.clone()))
                .await
                .expect("collections waiting");
            waiting["waiting"].as_bool().expect("waiting")
        }

        /// Commit a page of the pass `token` began, under the workspace's
        /// identity, as that pass's own cursor.
        async fn commit_pass(
            &self,
            cursor: i64,
            token: &str,
            terminal: bool,
        ) -> Result<Value, WireError> {
            let (replication_epoch, stream_identity) = self
                .engine_db()
                .query_row(
                    "SELECT replication_epoch, stream_identity FROM sync_identity \
                     WHERE workspace_id=?1",
                    [self.workspace_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("identity");
            let issued = self
                .service
                .issue_pending_cursor(
                    &self.handle,
                    &self.open,
                    IssuedCursor::Relay(RelayCursor {
                        cursor,
                        replication_epoch,
                        stream_identity,
                        bootstrap_complete: true,
                        settlement_report_id: None,
                        ordinary_pull: Some(dohc_engine_sync::OrdinaryPullCompletion {
                            token: token.to_owned(),
                            terminal,
                        }),
                    }),
                )
                .expect("issue a cursor");
            let issued = issued["token"].as_str().expect("token").to_owned();
            lock(&self.service.pending_cursors)
                .get_mut(&issued)
                .expect("issued")
                .reconcile_collections = terminal;
            let request = self.request(0, "sync.commitCursor", &issued);
            self.service
                .sync_commit_cursor(
                    &RequestContext::unbounded(),
                    request.workspace,
                    request.params,
                )
                .await
        }

        /// What reconciliation can change: bindings, relations, derived
        /// fields and automation claims.
        fn collections_state(&self) -> Vec<i64> {
            let conn = self.engine_db();
            [
                "SELECT COUNT(*) FROM collection_records",
                "SELECT COUNT(*) FROM collection_relation_edges",
                "SELECT COUNT(*) FROM collection_record_fields",
                "SELECT COUNT(*) FROM automation_claims",
            ]
            .iter()
            .map(|query| conn.query_row(query, [], |row| row.get(0)).expect(query))
            .collect()
        }

        fn source_relates_to_target(&self) -> bool {
            std::fs::read_to_string(self.open.root.join("tasks/source.md"))
                .expect("source")
                .contains(&format!("related: {TARGET}"))
        }

        /// Issue a relay cursor as a pull does, and return its token.
        fn issue(&self, cursor: i64) -> String {
            let issued = self
                .service
                .issue_pending_cursor(
                    &self.handle,
                    &self.open,
                    IssuedCursor::Relay(RelayCursor {
                        cursor,
                        replication_epoch: "epoch".to_owned(),
                        stream_identity: "stream".to_owned(),
                        bootstrap_complete: true,
                        settlement_report_id: None,
                        ordinary_pull: None,
                    }),
                )
                .expect("issue a cursor");
            issued["token"].as_str().expect("token").to_owned()
        }

        fn stored_cursor(&self) -> Option<String> {
            use rusqlite::OptionalExtension;
            rusqlite::Connection::open_with_flags(
                self.open.actor.database_path(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .expect("engine db")
            .query_row(
                "SELECT cursor FROM sync_relay_cursors WHERE workspace_id=?1",
                [self.workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .expect("read relay cursor")
        }

        fn request(
            &self,
            id: u64,
            method: &str,
            token: &str,
        ) -> dohc_engine_protocol::wire::Request {
            dohc_engine_protocol::wire::Request {
                id,
                method: method.into(),
                workspace: Some(self.handle.clone()),
                deadline_ms: Some(60_000),
                idempotency_key: None,
                progress: false,
                params: json!({
                    "workspaceId": self.workspace_id,
                    "pendingCursor": { "kind": "relay", "token": token },
                }),
            }
        }

        async fn close(self) {
            self.service
                .workspace_close(Some(self.handle))
                .await
                .expect("close");
        }
    }

    /// Stop a commit through the real supervisor while it waits for the actor,
    /// before its cursor lands. It changed nothing, so its token commits on
    /// retry; once that lands, the token is spent.
    async fn commit_stopped_before_landing_keeps_its_token(expire: bool) {
        use dohc_engine_protocol::supervisor::{Supervisor, SupervisorConfig};
        let f = CursorFixture::new("commit-before-landing", false).await;
        let (service, handle) = (&f.service, &f.handle);
        let token = f.issue(7);
        let stored_cursor = || f.stored_cursor();
        let commit = |id| f.request(id, "sync.commitCursor", &token);
        let supervisor = Supervisor::new(SupervisorConfig::default(), Arc::clone(service));
        let hold = service.hold_actor(handle).await;
        let answer = supervisor.try_submit(commit(1)).expect("admitted");
        while lock(&service.pending_cursors).contains_key(&token) {
            tokio::task::yield_now().await;
        }
        if expire {
            tokio::time::pause();
            tokio::time::advance(std::time::Duration::from_secs(61)).await;
        } else {
            assert!(supervisor.cancel(1));
            // Let the request's cancellation reach its operation token.
            tokio::task::yield_now().await;
        }
        drop(hold);
        let refused = answer
            .await
            .expect("answered")
            .expect_err("a commit stopped before it lands is refused");
        if expire {
            tokio::time::resume();
        }
        assert_eq!(
            refused.code,
            if expire {
                ErrorCode::DeadlineExceeded
            } else {
                ErrorCode::Cancelled
            }
        );
        assert_eq!(stored_cursor(), None);

        let committed = supervisor
            .try_submit(commit(2))
            .expect("admitted")
            .await
            .expect("answered")
            .expect("the retry commits with the same token");
        assert_eq!(committed.response.result["committed"], json!(true));
        assert_eq!(stored_cursor().as_deref(), Some("7"));
        let spent = supervisor
            .try_submit(commit(3))
            .expect("admitted")
            .await
            .expect("answered")
            .expect_err("a landed commit spends its token");
        assert_eq!(spent.message, "invalid-pending-cursor");
        drop(supervisor);
        f.close().await;
    }

    /// Commit A is stopped before it lands while a pull issues B and another
    /// commit spends B. A's token is obsolete, so it is not restored.
    #[tokio::test]
    async fn a_commit_stopped_before_it_lands_does_not_restore_a_superseded_token() {
        use dohc_engine_protocol::supervisor::{Supervisor, SupervisorConfig};
        let f = CursorFixture::new("commit-superseded", false).await;
        let older = f.issue(7);
        let supervisor = Supervisor::new(SupervisorConfig::default(), Arc::clone(&f.service));
        let hold = f.service.hold_actor(&f.handle).await;
        let answer = supervisor
            .try_submit(f.request(1, "sync.commitCursor", &older))
            .expect("admitted");
        while lock(&f.service.pending_cursors).contains_key(&older) {
            tokio::task::yield_now().await;
        }
        let newer = f.issue(8);
        f.service
            .consume_pending_cursor(&f.handle, f.workspace_id, PendingCursorKind::Relay, &newer)
            .expect("another commit takes the newer token");
        assert!(supervisor.cancel(1));
        tokio::task::yield_now().await;
        drop(hold);
        let refused = answer
            .await
            .expect("answered")
            .expect_err("a commit stopped before it lands is refused");
        assert_eq!(refused.code, ErrorCode::Cancelled);
        let retry = supervisor
            .try_submit(f.request(2, "sync.commitCursor", &older))
            .expect("admitted")
            .await
            .expect("answered")
            .expect_err("a superseded token is not restored");
        assert_eq!(retry.message, "invalid-pending-cursor");
        assert_eq!(f.stored_cursor(), None);
        drop(supervisor);
        f.close().await;
    }

    /// Materialization is stopped after its page placed its file, so it
    /// answers that it materialized.
    #[tokio::test]
    async fn a_materialization_cancelled_after_its_page_lands_answers_materialized() {
        let f = CursorFixture::new("materialize-cancelled", false).await;
        let ctx = RequestContext::unbounded();
        f.open
            .actor
            .ensure_main_version(
                f.workspace_id.into(),
                1,
                Arc::new(dohc_engine_storage::NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("main");
        f.open
            .actor
            .versioned_text_write(
                dohc_engine_domain::WriteText {
                    workspace_id: f.workspace_id.into(),
                    version_id: "main".into(),
                    object_id: "pulled".into(),
                    path: "pulled.md".into(),
                    text: "pulled".into(),
                    moment_id: "pulled".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                Arc::new(dohc_engine_storage::NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("pulled head");
        let token = f.issue(7);
        lock(&f.service.pending_cursors)
            .get_mut(&token)
            .expect("issued")
            .materialization_paths = vec![dohc_engine_sync::MomentMaterializationChange {
            version_id: "main".into(),
            path: "pulled.md".into(),
            operation: "write",
            content_kind: "text",
        }];
        let request = f.request(1, "sync.materializePendingCursor", &token);
        let mut materializing = Box::pin(f.service.sync_materialize_pending_cursor(
            &ctx,
            request.workspace,
            request.params,
        ));
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(materializing.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        // The page reached the actor first, so it has landed once the hold
        // enters.
        let hold = f.service.hold_actor(&f.handle).await;
        ctx.cancel.cancel();
        tokio::task::yield_now().await;
        drop(hold);
        let materialized = materializing
            .await
            .expect("a page that landed answers materialized");
        assert_eq!(materialized, json!({ "materialized": true }));
        assert_eq!(
            std::fs::read_to_string(f.open.root.join("pulled.md")).expect("pulled file"),
            "pulled"
        );
        f.close().await;
    }

    /// A landed commit whose Collections update cannot run answers committed,
    /// and the next terminal page's commit runs the update. A held capture
    /// gate keeps it from starting; a held record lease stops it partway.
    async fn landed_commit_keeps_its_collections_update(lease: bool) {
        let f = CursorFixture::new(
            if lease {
                "owed-collections-lease"
            } else {
                "owed-collections-gate"
            },
            true,
        )
        .await;
        f.prepare().await;
        // A source record relates to a target, and an editor's session holds
        // the source, as in the replica's lease-deferred cleanup.
        let markdown = record(SOURCE, Some(TARGET));
        f.pulled("schema", "tasks/collection.yaml", RELATION_SCHEMA)
            .await;
        f.pulled("source", "tasks/source.md", &markdown).await;
        f.pulled("target", "tasks/target.md", &record(TARGET, None))
            .await;
        f.source_lineage(&markdown).await;
        f.commit(7, true).await.expect("the first commit");
        assert_eq!(f.edges(), 1, "the first commit reconciles the relation");
        assert!(!f.owed());

        let gate = (!lease).then(|| f.open.capture_apply_gate.try_lock().expect("free gate"));
        let leased = lease.then(|| {
            f.service
                .leases
                .scoped(&f.open.root)
                .acquire(&DocKey::new(f.workspace_id, "main", "source").expect("key"))
                .expect("source lease")
        });
        // A pulled page deletes the target, so the relation must be cleaned.
        f.pulled_removal("tasks/target.md").await;
        let committed = tokio::time::timeout(std::time::Duration::from_secs(30), f.commit(8, true))
            .await
            .expect("a landed commit answers")
            .expect("a landed commit answers committed");
        assert_eq!(committed["committed"], json!(true));
        assert_eq!(f.stored_cursor().as_deref(), Some("8"));
        assert!(f.owed());
        assert_eq!(f.edges(), 1, "the cleanup has not run");
        drop(gate);
        drop(leased);
        f.commit(9, true).await.expect("the next commit");
        assert!(!f.owed());
        assert_eq!(f.edges(), 0, "the next commit runs the owed cleanup");
        f.close().await;
    }

    /// Another step holds the session lock that claiming open editors'
    /// lineages needs. A landed commit stops waiting for it at its bound and
    /// answers committed; the next push or commit makes the claims.
    #[tokio::test]
    async fn a_landed_commit_stops_waiting_for_the_session_lock_at_its_bound() {
        let f = CursorFixture::new("origination-bounded", false).await;
        f.prepare().await;
        let held = Arc::clone(&f.open.session_ops).lock_owned().await;
        let committed =
            tokio::time::timeout(std::time::Duration::from_secs(30), f.commit(7, false))
                .await
                .expect("a landed commit answers")
                .expect("a landed commit answers committed");
        assert_eq!(committed["committed"], json!(true));
        assert_eq!(f.stored_cursor().as_deref(), Some("7"));
        drop(held);
        f.close().await;
    }

    /// A relation whose target a two-page pull moves: page one removes it
    /// from its old path, and page two supplies it at its new one.
    async fn moving_pull_fixture(workspace_id: &'static str) -> (CursorFixture, String) {
        let f = CursorFixture::new(workspace_id, true).await;
        f.prepare().await;
        let markdown = record(SOURCE, Some(TARGET));
        f.pulled("schema", "tasks/collection.yaml", RELATION_SCHEMA)
            .await;
        f.pulled("source", "tasks/source.md", &markdown).await;
        f.pulled("target", "tasks/target.md", &record(TARGET, None))
            .await;
        f.source_lineage(&markdown).await;
        f.commit(7, true).await.expect("the earlier pull");
        assert_eq!(f.edges(), 1);
        let token = f.begin_pass("moving-pull");
        f.pulled_removal("tasks/target.md").await;
        f.commit_pass(8, &token, false).await.expect("page one");
        assert_eq!(f.pull_token(), Some(token.clone()));
        (f, token)
    }

    /// A record written inside the Collection while the pull is unfinished,
    /// related to the target the pull moves.
    async fn write_inside_the_collection(f: &CursorFixture) {
        const WRITTEN: &str = "rec_cccccccccccccccccccccccccc";
        let before = f.collections_state();
        f.write("tasks/written.md", &record(WRITTEN, Some(TARGET)))
            .await
            .expect("a write inside the Collection completes");
        assert!(f.open.root.join("tasks/written.md").exists());
        assert!(f.owed(), "the update waits for the pull");
        assert!(f.collections_waiting().await, "and says so");
        assert_eq!(
            f.collections_state(),
            before,
            "no binding, cleanup, derived field or claim"
        );
        assert!(f.source_relates_to_target());
    }

    /// Page two supplies the target and commits terminally, and the
    /// Collections reconcile against the whole pull.
    async fn finish_moving_pull(f: CursorFixture, token: &str) {
        f.pulled("moved", "tasks/moved.md", &record(TARGET, None))
            .await;
        f.commit_pass(9, token, true).await.expect("page two");
        assert_eq!(f.pull_token(), None);
        assert!(!f.collections_waiting().await);
        assert!(!f.owed());
        assert_eq!(f.edges(), 2, "both records relate to the moved target");
        assert!(
            f.source_relates_to_target(),
            "the relation stays in the source file"
        );
        f.close().await;
    }

    /// Page one's commit, and a write inside the Collection between the
    /// pages, leave the Collections alone, so page two's commit reconciles
    /// with the relation intact.
    #[tokio::test]
    async fn owed_collections_work_waits_for_the_terminal_page() {
        let (f, token) = moving_pull_fixture("owed-partial-pull").await;
        write_inside_the_collection(&f).await;
        finish_moving_pull(f, &token).await;
    }

    /// The daemon stops between the pages. After the restart a write inside
    /// the Collection still waits, because the store kept the pull's token.
    #[tokio::test]
    async fn a_restart_between_pages_keeps_collections_waiting_for_the_pull() {
        let (f, token) = moving_pull_fixture("owed-restart-mid-pull").await;
        let f = f.restart().await;
        assert!(!f.owed(), "a workspace opens with nothing owed");
        assert_eq!(f.pull_token(), Some(token.clone()));
        write_inside_the_collection(&f).await;
        finish_moving_pull(f, &token).await;
    }

    /// An older pass's terminal cursor commits after a newer pass began. The
    /// newer pass's token stands, so the Collections keep waiting.
    #[tokio::test]
    async fn an_older_terminal_commit_leaves_a_newer_pull_waiting() {
        let (f, token) = moving_pull_fixture("owed-older-terminal").await;
        let newer = f.begin_pass("newer-pull");
        f.commit_pass(9, &token, true)
            .await
            .expect("the older pass's terminal commit");
        assert_eq!(f.pull_token(), Some(newer.clone()));
        write_inside_the_collection(&f).await;
        finish_moving_pull(f, &newer).await;
    }

    /// What page one applied is local truth once the pull is abandoned: the
    /// target is gone, so the waiting update cleans the source's relation.
    async fn assert_abandoned_pull_reconciled(f: &CursorFixture) {
        assert_eq!(f.pull_token(), None);
        assert!(!f.collections_waiting().await);
        assert!(!f.owed(), "the waiting update ran");
        let source_edges: i64 = f
            .engine_db()
            .query_row(
                "SELECT COUNT(*) FROM collection_relation_edges WHERE source_record_id=?1",
                [SOURCE],
                |row| row.get(0),
            )
            .expect("source edges");
        assert_eq!(source_edges, 0);
        assert!(!f.source_relates_to_target());
    }

    /// Sync pauses with the pull unfinished, or the daemon stopped after the
    /// pause was saved and before the workspace reopened. The next local open
    /// abandons the pull before anything reconciles, then runs the waiting
    /// update with no relay.
    #[tokio::test]
    async fn a_local_reopen_abandons_the_pull_and_runs_the_waiting_update() {
        let (f, _token) = moving_pull_fixture("abandon-on-reopen").await;
        write_inside_the_collection(&f).await;
        let f = f.reopen_paused().await;
        assert_abandoned_pull_reconciled(&f).await;
        f.close().await;
    }

    /// The owner binding is already open without relay when an open abandons
    /// the pull. The waiting update runs on that binding.
    #[tokio::test]
    async fn abandoning_on_an_open_binding_runs_the_waiting_update() {
        let f = CursorFixture::with_relay("abandon-open-binding", true, Value::Null).await;
        f.prepare().await;
        let markdown = record(SOURCE, Some(TARGET));
        f.pulled("schema", "tasks/collection.yaml", RELATION_SCHEMA)
            .await;
        f.pulled("source", "tasks/source.md", &markdown).await;
        f.pulled("target", "tasks/target.md", &record(TARGET, None))
            .await;
        f.source_lineage(&markdown).await;
        let ctx = RequestContext::unbounded();
        f.service.collections_changed(&ctx, &f.open).await;
        assert_eq!(f.edges(), 1);
        f.begin_pass("left-by-a-relay");
        f.pulled_removal("tasks/target.md").await;
        write_inside_the_collection(&f).await;

        let mut params = CursorFixture::open_params(&f.scratch, f.workspace_id, true, &Value::Null);
        params["abandonOrdinaryPull"] = json!(true);
        let opened = f
            .service
            .workspace_open(&ctx, params)
            .await
            .expect("reopen the open binding");
        assert_eq!(opened["workspace"], json!(f.handle));
        assert_abandoned_pull_reconciled(&f).await;
        f.close().await;
    }

    /// A claimed workspace on a loopback relay. An unfinished pull removed a
    /// relation's target, and a write inside the Collection waits for it.
    async fn abandonable_pull_fixture(workspace_id: &'static str) -> (PagedRelay, CursorFixture) {
        let ctx = RequestContext::unbounded();
        let relay = PagedRelay::start(Default::default());
        relay.release();
        let f = CursorFixture::with_relay(workspace_id, true, relay.configuration()).await;
        f.prepare().await;
        f.service
            .sync_claim(
                &ctx,
                Some(f.handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("claim");
        let markdown = record(SOURCE, Some(TARGET));
        f.pulled("schema", "tasks/collection.yaml", RELATION_SCHEMA)
            .await;
        f.pulled("source", "tasks/source.md", &markdown).await;
        f.pulled("target", "tasks/target.md", &record(TARGET, None))
            .await;
        f.source_lineage(&markdown).await;
        f.service.collections_changed(&ctx, &f.open).await;
        assert_eq!(f.edges(), 1);
        f.begin_pass("left-unfinished");
        f.pulled_removal("tasks/target.md").await;
        write_inside_the_collection(&f).await;
        (relay, f)
    }

    /// The relay refuses a claim for good. The saved refusal stops this
    /// replica's sync and abandons the pull, so the waiting update runs even
    /// though the claim answers with the refusal.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_final_claim_refusal_runs_the_update_the_pull_held_back() {
        let (relay, f) = abandonable_pull_fixture("abandon-claim-refused").await;
        relay.refuse_claims.store(true, Ordering::SeqCst);
        let refused = f
            .service
            .sync_claim(
                &RequestContext::unbounded(),
                Some(f.handle.clone()),
                json!({ "workspaceId": f.workspace_id }),
            )
            .await;
        assert!(refused.is_err(), "the claim answers with its refusal");
        let claim_state: Option<String> = f
            .engine_db()
            .query_row(
                "SELECT claim_state FROM sync_identity WHERE workspace_id=?1",
                [f.workspace_id],
                |row| row.get(0),
            )
            .expect("claim state");
        assert_eq!(claim_state.as_deref(), Some("stream-identity-mismatch"));
        assert_abandoned_pull_reconciled(&f).await;
        f.close().await;
    }

    /// Recovering the origin changes the replication identity, which
    /// abandons the pull, and the waiting update runs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_origin_recovery_runs_the_update_the_pull_held_back() {
        let (_relay, f) = abandonable_pull_fixture("abandon-origin-recovered").await;
        f.service
            .sync_recover_origin(
                &RequestContext::unbounded(),
                Some(f.handle.clone()),
                json!({ "workspaceId": f.workspace_id }),
            )
            .await
            .expect("recover origin");
        assert_abandoned_pull_reconciled(&f).await;
        f.close().await;
    }

    /// A loopback relay serving a workspace log. Its first log request sets
    /// `started`, then waits for `release`. While `refuse_claims` is set it
    /// refuses every claim for good.
    struct PagedRelay {
        base_url: String,
        ops: Arc<std::sync::Mutex<Vec<Value>>>,
        started: Arc<std::sync::atomic::AtomicBool>,
        refuse_claims: Arc<std::sync::atomic::AtomicBool>,
        release: Option<std::sync::mpsc::Sender<()>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl PagedRelay {
        fn start(blobs: std::collections::HashMap<String, String>) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind relay");
            let base_url = format!("http://{}", listener.local_addr().expect("relay address"));
            let ops = Arc::new(std::sync::Mutex::new(Vec::new()));
            let started = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let refuse_claims = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (release, released) = std::sync::mpsc::channel();
            let thread = std::thread::spawn({
                let (ops, started, refuse_claims, stop) = (
                    Arc::clone(&ops),
                    Arc::clone(&started),
                    Arc::clone(&refuse_claims),
                    Arc::clone(&stop),
                );
                move || {
                    let mut released = Some(released);
                    for stream in listener.incoming() {
                        if stop.load(Ordering::SeqCst) {
                            break;
                        }
                        let Ok(stream) = stream else { continue };
                        let _ = serve_paged_relay(
                            stream,
                            &ops,
                            &blobs,
                            &started,
                            &refuse_claims,
                            &mut released,
                        );
                    }
                }
            });
            PagedRelay {
                base_url,
                ops,
                started,
                refuse_claims,
                release: Some(release),
                stop,
                thread: Some(thread),
            }
        }

        fn configuration(&self) -> Value {
            json!({
                "baseUrl": self.base_url,
                "bearerToken": "test-token",
                "allowInsecureLoopbackForTests": true,
            })
        }

        fn release(&self) {
            if let Some(release) = &self.release {
                release.send(()).expect("the first page waits");
            }
        }

        fn row(workspace_id: &str, origin_seq: i64, op_kind: &str, payload: Value) -> Value {
            json!({
                "relaySeq": origin_seq + 1,
                "workspaceId": workspace_id,
                "originId": "peer",
                "originSeq": origin_seq,
                "opKind": op_kind,
                "payload": payload,
                "recordedAtMs": 1_000 + origin_seq,
            })
        }
    }

    impl Drop for PagedRelay {
        fn drop(&mut self) {
            self.release.take();
            self.stop.store(true, Ordering::SeqCst);
            let _ = std::net::TcpStream::connect(self.base_url.trim_start_matches("http://"));
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }

    fn serve_paged_relay(
        mut stream: std::net::TcpStream,
        ops: &std::sync::Mutex<Vec<Value>>,
        blobs: &std::collections::HashMap<String, String>,
        started: &std::sync::atomic::AtomicBool,
        refuse_claims: &std::sync::atomic::AtomicBool,
        released: &mut Option<std::sync::mpsc::Receiver<()>>,
    ) -> std::io::Result<()> {
        use std::io::{BufRead, Read, Write};
        let mut reader = std::io::BufReader::new(stream.try_clone()?);
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let mut request_line = line.split_whitespace();
        let method = request_line.next().unwrap_or_default().to_owned();
        let target = request_line.next().unwrap_or_default().to_owned();
        let mut length = 0;
        loop {
            line.clear();
            reader.read_line(&mut line)?;
            match line.trim_end().split_once(':') {
                Some((name, value)) if name.eq_ignore_ascii_case("content-length") => {
                    length = value.trim().parse().unwrap_or(0);
                }
                Some(_) => {}
                None => break,
            }
        }
        reader.read_exact(&mut vec![0; length])?;
        let (path, query) = target.split_once('?').unwrap_or((&target, ""));
        let parameter = |name: &str| {
            query
                .split('&')
                .filter_map(|part| part.split_once('='))
                .find(|(key, _)| *key == name)
                .and_then(|(_, value)| value.parse::<i64>().ok())
        };
        let since = parameter("since").unwrap_or(0);
        let limit = parameter("limit")
            .and_then(|limit| usize::try_from(limit).ok())
            .unwrap_or(usize::MAX);
        let body = if method == "POST" && path == "/sync/workspaces" {
            Some(json!({ "ok": true }).to_string())
        } else if path.ends_with("/blobs/have") {
            Some(json!({ "missing": [] }).to_string())
        } else if let Some((_, sha256)) = path.rsplit_once("/blobs/") {
            blobs.get(sha256).cloned()
        } else if method == "GET" && path.ends_with("/log") {
            if since == 0
                && let Some(released) = released.take()
            {
                started.store(true, Ordering::SeqCst);
                let _ = released.recv();
            }
            let ops = lock(ops);
            let after: Vec<&Value> = ops
                .iter()
                .filter(|row| row["relaySeq"].as_i64() > Some(since))
                .collect();
            let rows = &after[..after.len().min(limit)];
            Some(
                json!({
                    "ops": rows,
                    "nextCursor": rows.last().and_then(|row| row["relaySeq"].as_i64()).unwrap_or(since),
                    "hasMore": after.len() > rows.len(),
                })
                .to_string(),
            )
        } else {
            None
        };
        let claim = method == "POST" && path == "/sync/workspaces";
        let (status, body) = match body {
            _ if claim && refuse_claims.load(Ordering::SeqCst) => (
                "409 Conflict",
                json!({ "code": "stream_identity_mismatch" }).to_string(),
            ),
            Some(body) => ("200 OK", body),
            None => ("404 Not Found", String::new()),
        };
        write!(
            stream,
            "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        )?;
        stream.flush()
    }

    /// A relay workspace that keeps its Collections itself and owes an
    /// update. The source record relates to the target, and the Collections
    /// hold that relation when `reconciled`. Page one of the relay's log
    /// removes the target and fills a pass; page two writes it at a new path.
    async fn half_pull_fixture(
        workspace_id: &'static str,
        reconciled: bool,
    ) -> (PagedRelay, CursorFixture) {
        let ctx = RequestContext::unbounded();
        let markdown = record(SOURCE, Some(TARGET));
        let target = record(TARGET, None);
        let target_sha = dohc_engine_storage::hex_sha256(target.as_bytes());
        let relay = PagedRelay::start([(target_sha.clone(), target.clone())].into());
        let f = CursorFixture::with_relay(workspace_id, true, relay.configuration()).await;
        f.prepare().await;
        f.service
            .sync_claim(
                &ctx,
                Some(f.handle.clone()),
                json!({ "workspaceId": workspace_id }),
            )
            .await
            .expect("claim");
        f.pulled("schema", "tasks/collection.yaml", RELATION_SCHEMA)
            .await;
        f.pulled("source", "tasks/source.md", &markdown).await;
        f.pulled("target", "tasks/target.md", &target).await;
        f.source_lineage(&markdown).await;
        if reconciled {
            f.service.collections_changed(&ctx, &f.open).await;
        }
        assert_eq!(f.edges(), i64::from(reconciled));

        let head = f
            .open
            .actor
            .versioned_text_read(
                workspace_id.into(),
                "main".into(),
                "tasks/target.md".into(),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("read target")
            .expect("target head");
        // Page one deletes the target and fills the pass; page two writes the
        // target at a new path.
        let pass = i64::try_from(dohc_engine_sync::MAX_PULL_OPS).expect("pass size");
        let mut ops = vec![PagedRelay::row(
            workspace_id,
            0,
            "moment.append",
            json!({
                "momentId": "peer-delete", "versionId": "main", "objectId": head.object_id,
                "objectCreatedAtMs": 2, "path": head.path, "recordedAtMs": 20,
                "operation": "delete",
                "payloadBeforeBlobSha256": head.blob_sha256, "payloadBeforePath": head.path,
                "payloadBeforeContentKind": "text", "payloadBeforeByteLength": head.text.len(),
                "payloadAfterBlobSha256": head.blob_sha256, "payloadAfterPath": head.path,
                "payloadAfterContentKind": "text", "payloadAfterByteLength": head.text.len(),
                "metadata": { "origin": "sync", "summary": null, "correlationId": null },
                "beforePresent": "present", "beforeObjectId": head.object_id,
                "beforeVersionId": "main", "beforePath": head.path,
                "beforeBlobSha256": head.blob_sha256, "beforeContentKind": "text",
                "beforeByteLength": head.text.len(), "beforeUpdatedAtMs": head.updated_at_ms,
                "beforeLatestMomentId": head.latest_moment_id,
                "beforeMetadata": {
                    "origin": head.metadata_origin, "summary": head.metadata_summary,
                    "correlationId": head.metadata_correlation_id,
                },
            }),
        )];
        ops.extend(
            (1..pass).map(|seq| PagedRelay::row(workspace_id, seq, "workspace.init", json!({}))),
        );
        ops.push(PagedRelay::row(
            workspace_id,
            pass,
            "moment.append",
            json!({
                "momentId": "peer-moved", "versionId": "main", "objectId": "moved",
                "objectCreatedAtMs": 21, "path": "tasks/moved.md", "recordedAtMs": 21,
                "operation": "write",
                "payloadBeforeBlobSha256": null, "payloadBeforePath": null,
                "payloadAfterBlobSha256": target_sha, "payloadAfterPath": "tasks/moved.md",
                "payloadAfterContentKind": "text", "payloadAfterByteLength": target.len(),
                "metadata": { "origin": "sync" },
                "beforePresent": "absent",
            }),
        ));
        lock(&relay.ops).extend(ops);
        f.open.collections_owed.store(true, Ordering::SeqCst);
        (relay, f)
    }

    /// A `sync.pull` that owns what it needs, so a test can poll or spawn it.
    fn pull(
        f: &CursorFixture,
    ) -> impl std::future::Future<Output = Result<Value, WireError>> + Send + 'static {
        let (service, handle, workspace_id) =
            (Arc::clone(&f.service), f.handle.clone(), f.workspace_id);
        async move {
            service
                .sync_pull(
                    &RequestContext::unbounded(),
                    Some(handle),
                    json!({ "workspaceId": workspace_id }),
                )
                .await
        }
    }

    /// Poll `future` once and report whether it finished.
    async fn poll_once<F: std::future::Future + ?Sized>(mut future: std::pin::Pin<&mut F>) -> bool {
        std::future::poll_fn(|cx| {
            std::task::Poll::Ready(std::future::Future::poll(future.as_mut(), cx).is_ready())
        })
        .await
    }

    /// Commit page one, then pull and commit page two, whose terminal commit
    /// pays the owed update with the relation intact.
    async fn finish_half_pull(f: CursorFixture, page_one: Value) {
        let ctx = RequestContext::unbounded();
        let commit = |page: Value| {
            let token = page["pendingCursor"]["token"]
                .as_str()
                .expect("pending cursor")
                .to_owned();
            let request = f.request(0, "sync.commitCursor", &token);
            f.service
                .sync_commit_cursor(&ctx, request.workspace, request.params)
        };
        commit(page_one).await.expect("commit page one");
        let page_two = pull(&f).await.expect("page two lands");
        assert_eq!(page_two["hasMore"], json!(false));
        commit(page_two).await.expect("commit page two");
        assert!(!f.owed());
        assert_eq!(f.edges(), 1, "the source still relates to the target");
        f.close().await;
    }

    /// A Collections update is admitted under the capture gate while a pull
    /// waits for its first page, which removes a relation's target that the
    /// second page brings back. The page must not land between the update's
    /// admission and its run, so the update never sees half the pull.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_admitted_collections_update_never_sees_half_a_pull() {
        let ctx = RequestContext::unbounded();
        let (relay, f) = half_pull_fixture("owed-admitted-mid-pull", true).await;
        let page_one = tokio::spawn(pull(&f));
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !relay.started.load(Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the pull asks for its first page");
        // The update is admitted and its first step answered; its next step
        // waits until this test polls it again.
        let hold = f.service.hold_actor(&f.handle).await;
        let mut update = Box::pin(f.service.settle_owed_collections(&ctx, &f.open));
        let ran = poll_once(update.as_mut()).await;
        drop(hold);
        relay.release();
        let page_one = page_one.await.expect("join").expect("page one lands");
        assert_eq!(page_one["hasMore"], json!(true));
        if !ran {
            update.as_mut().await;
        }
        drop(update);
        assert_eq!(f.edges(), 1, "the update did not see page one alone");
        assert!(f.owed(), "the update waits for the terminal page");
        finish_half_pull(f, page_one).await;
    }

    /// A Collections update is admitted under the capture gate before a pull
    /// starts. The pull registers only once the update lets the gate go, so
    /// the update reconciles the relation before page one removes its
    /// target, and the page leaves that relation alone.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn a_pull_waits_for_an_admitted_collections_update() {
        let ctx = RequestContext::unbounded();
        let (relay, f) = half_pull_fixture("owed-admitted-before-pull", false).await;
        // The update takes the gate, and its first actor step waits.
        let hold = f.service.hold_actor(&f.handle).await;
        let mut update = Box::pin(f.service.settle_owed_collections(&ctx, &f.open));
        assert!(!poll_once(update.as_mut()).await);
        assert!(
            f.open.capture_apply_gate.try_lock().is_err(),
            "the update holds the gate"
        );
        let mut page_one = Box::pin(pull(&f));
        assert!(!poll_once(page_one.as_mut()).await);
        assert_eq!(
            f.open.pulls_in_flight.load(Ordering::SeqCst),
            0,
            "the pull waits for the gate before it registers"
        );
        let page_one = tokio::spawn(page_one);
        relay.release();
        drop(hold);
        update.await;
        assert!(!f.owed(), "the update ran");
        let page_one = page_one.await.expect("join").expect("page one lands");
        assert_eq!(page_one["hasMore"], json!(true));
        assert_eq!(f.edges(), 1, "the update reconciled before page one landed");
        assert!(
            f.open
                .actor
                .versioned_text_read(
                    f.workspace_id.into(),
                    "main".into(),
                    "tasks/target.md".into(),
                    dohc_engine_runtime::CancellationToken::new(),
                )
                .await
                .expect("read target")
                .is_none(),
            "page one's removal stands"
        );
        assert!(
            std::fs::read_to_string(f.open.root.join("tasks/source.md"))
                .expect("source")
                .contains(&format!("related: {TARGET}")),
            "no cleanup removed the relation"
        );
        finish_half_pull(f, page_one).await;
    }

    /// A Collections update finds no pull, then waits for the capture gate
    /// behind a pull, which registers under the gate and lets it go. The
    /// update's check under the gate sees the pull and leaves its work owed.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn an_update_leaves_its_work_to_a_pull_that_registered_while_it_waited() {
        let ctx = RequestContext::unbounded();
        let (relay, f) = half_pull_fixture("owed-checked-before-pull", false).await;
        // The gate serves its waiters in order: the pull, then the update.
        let gate = Arc::clone(&f.open.capture_apply_gate).lock_owned().await;
        let mut page_one = Box::pin(pull(&f));
        assert!(!poll_once(page_one.as_mut()).await, "the pull waits");
        let mut update = Box::pin(f.service.settle_owed_collections(&ctx, &f.open));
        assert!(
            !poll_once(update.as_mut()).await,
            "the update finds no pull and waits"
        );
        let page_one = tokio::spawn(page_one);
        drop(gate);
        update.await;
        assert_eq!(
            f.open.pulls_in_flight.load(Ordering::SeqCst),
            1,
            "the pull registered and waits for its first page"
        );
        assert!(f.owed(), "the update leaves its work owed");
        assert_eq!(f.edges(), 0, "and the Collections alone");
        relay.release();
        let page_one = page_one.await.expect("join").expect("page one lands");
        assert_eq!(page_one["hasMore"], json!(true));
        finish_half_pull(f, page_one).await;
    }

    /// A pulled page left its Collections update owed. A later write that
    /// cannot move Collections itself, an edit to an existing record or to a
    /// file outside every Collection, still runs it, and the update
    /// reconciles the whole workspace.
    async fn a_later_write_runs_an_owed_update(workspace_id: &'static str, path: &str) {
        let f = CursorFixture::new(workspace_id, true).await;
        f.prepare().await;
        f.pulled("schema", "tasks/collection.yaml", RELATION_SCHEMA)
            .await;
        f.pulled("target", "tasks/target.md", &record(TARGET, None))
            .await;
        f.pulled("source", "tasks/source.md", &record(SOURCE, Some(TARGET)))
            .await;
        f.service.collections_landed(&f.open);
        assert_eq!(f.edges(), 0);
        f.write(path, "Edited\n").await.expect("the write");
        assert!(!f.owed());
        assert_eq!(f.edges(), 1, "the write runs the owed update");
        f.close().await;
    }

    #[tokio::test]
    async fn an_edit_to_an_existing_record_runs_an_owed_update() {
        a_later_write_runs_an_owed_update("owed-record-edit", "tasks/target.md").await;
    }

    #[tokio::test]
    async fn a_write_outside_every_collection_runs_an_owed_update() {
        a_later_write_runs_an_owed_update("owed-unrelated-write", "notes.txt").await;
    }

    #[tokio::test]
    async fn a_landed_commit_leaves_its_collections_update_when_the_gate_stays_held() {
        landed_commit_keeps_its_collections_update(false).await;
    }

    #[tokio::test]
    async fn a_landed_commit_keeps_its_collections_update_when_a_lease_stops_it() {
        landed_commit_keeps_its_collections_update(true).await;
    }

    /// A write in a workspace that keeps its Collections itself is cancelled
    /// after it landed, while the capture gate is held. It answers with the
    /// write, and its Collections update runs once the gate frees.
    #[tokio::test]
    async fn a_write_cancelled_after_it_lands_answers_and_updates_its_collections() {
        use dohc_engine_protocol::supervisor::{Supervisor, SupervisorConfig};
        const SOURCE: &str = "rec_aaaaaaaaaaaaaaaaaaaaaaaaaa";
        const TARGET: &str = "rec_bbbbbbbbbbbbbbbbbbbbbbbbbb";
        let f = CursorFixture::new("write-cancelled-collections", true).await;
        let ctx = RequestContext::unbounded();
        f.open
            .actor
            .ensure_main_version(
                f.workspace_id.into(),
                1,
                Arc::new(dohc_engine_storage::NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("main");
        let write = |id: u64, path: &str, text: &str| dohc_engine_protocol::wire::Request {
            id,
            method: "versionedText.write".into(),
            workspace: Some(f.handle.clone()),
            deadline_ms: Some(60_000),
            idempotency_key: None,
            progress: false,
            params: json!({
                "workspaceId": f.workspace_id, "versionId": "main", "path": path,
                "text": text, "origin": "api", "publish": true,
            }),
        };
        for (id, path, text) in [
            (
                1,
                "tasks/collection.yaml",
                "fields:\n  related:\n    type: relation\n    collection: tasks\n    many: false\n"
                    .to_owned(),
            ),
            (
                2,
                "tasks/target.md",
                format!("---\nid: {TARGET}\n---\n\nTarget\n"),
            ),
        ] {
            f.service
                .versioned_text_write(&ctx, write(id, path, &text))
                .await
                .expect("write");
        }
        let edges = || {
            rusqlite::Connection::open_with_flags(
                f.open.actor.database_path(),
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .expect("engine db")
            .query_row(
                "SELECT COUNT(*) FROM collection_relation_edges",
                [],
                |row| row.get::<_, i64>(0),
            )
            .expect("read edges")
        };
        assert_eq!(edges(), 0);
        let supervisor = Supervisor::new(SupervisorConfig::default(), Arc::clone(&f.service));
        let gate = f.open.capture_apply_gate.try_lock().expect("free gate");
        let answer = supervisor
            .try_submit(write(
                3,
                "tasks/source.md",
                &format!("---\nid: {SOURCE}\nrelated: {TARGET}\n---\n\nSource\n"),
            ))
            .expect("admitted");
        let source = f.open.root.join("tasks/source.md");
        let waiting = std::time::Instant::now();
        while !source.exists() {
            assert!(
                waiting.elapsed() < std::time::Duration::from_secs(10),
                "the write never landed"
            );
            tokio::task::yield_now().await;
        }
        assert!(supervisor.cancel(3));
        // Let the cancellation reach the write's token before the gate frees.
        tokio::task::yield_now().await;
        drop(gate);
        let written = answer
            .await
            .expect("answered")
            .expect("a write that landed answers with it");
        assert_eq!(
            written.response.result["snapshot"]["path"],
            json!("tasks/source.md")
        );
        assert!(!f.open.collections_owed.load(Ordering::SeqCst));
        assert_eq!(edges(), 1, "the write's Collections update ran");
        drop(supervisor);
        f.close().await;
    }

    /// A commit lands, then claiming an open editor's lineage fails. The
    /// commit answers committed; the session stays unclaimed for the next
    /// push or commit.
    #[tokio::test]
    async fn a_landed_commit_answers_committed_when_origination_fails() {
        let f = CursorFixture::new("origination-deferred", false).await;
        let ctx = RequestContext::unbounded();
        f.open
            .actor
            .ensure_main_version(
                f.workspace_id.into(),
                1,
                Arc::new(dohc_engine_storage::NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("main");
        // A chat change gives the workspace its local sync identity, which a
        // cursor commit needs once the workspace holds files.
        f.service
            .chats_channels_create(
                &ctx,
                Some(f.handle.clone()),
                json!({ "channelId": "identity", "name": "Identity", "kind": "channel", "nowMs": 1 }),
            )
            .await
            .expect("local identity");
        f.open
            .actor
            .versioned_text_write(
                dohc_engine_domain::WriteText {
                    workspace_id: f.workspace_id.into(),
                    version_id: "main".into(),
                    object_id: "notes".into(),
                    path: "notes.md".into(),
                    text: "Notes\n".into(),
                    moment_id: "notes".into(),
                    metadata_origin: "sync".into(),
                    metadata_summary: None,
                    metadata_correlation_id: None,
                    author_json: None,
                    now_ms: 2,
                    request_id: None,
                },
                Arc::new(dohc_engine_storage::NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("notes");
        std::fs::write(f.open.root.join("notes.md"), "Notes\n").expect("notes file");
        let state = f
            .open
            .actor
            .ydoc_open_state(
                f.workspace_id.into(),
                3,
                false,
                None,
                "main".into(),
                "notes.md".into(),
                Some(dohc_engine_collab::ContentKind::Richdoc),
                dohc_engine_runtime::CancellationToken::new(),
            )
            .await
            .expect("notes state");
        let doc = dohc_engine_collab::Ydoc::wire();
        doc.apply(&state.initial_update).expect("apply");
        doc.rewrite_content_to_markdown(dohc_engine_collab::ContentKind::Richdoc, "Notes\n")
            .expect("rewrite");
        f.open
            .actor
            .ydoc_record_update(
                state.key,
                "notes.md".into(),
                dohc_engine_collab::ContentKind::Richdoc,
                state.regime,
                doc.encode_full_state(),
                None,
                None,
                state.lineage_claim_id,
                true,
                state.owner_seed_source,
                None,
                4,
                Arc::new(dohc_engine_storage::NoFaults),
                dohc_engine_runtime::CancellationToken::new(),
                None,
            )
            .await
            .expect("notes lineage");
        let (opened, egress) = f
            .service
            .ydoc_open(
                &ctx,
                Some(f.handle.clone()),
                json!({ "versionId": "main", "path": "notes.md", "contentKind": "richdoc" }),
                1,
            )
            .await
            .expect("an editor opens the notes");
        drop(egress);
        assert_eq!(
            opened["lineageClaimId"],
            Value::Null,
            "an unclaimed lineage"
        );
        // A marker the store cannot read fails the claim.
        let export_lane = |lane: i64| {
            let db = rusqlite::Connection::open(f.open.actor.database_path()).expect("engine db");
            db.pragma_update(None, "ignore_check_constraints", true)
                .expect("pragma");
            db.execute(
                "UPDATE ydoc_docs SET file_export_lane=?1 WHERE workspace_id=?2 AND object_id='notes'",
                rusqlite::params![lane, f.workspace_id],
            )
            .expect("set the export lane")
        };
        assert_eq!(export_lane(9), 1);
        let token = f.issue(7);
        let request = f.request(0, "sync.commitCursor", &token);
        let committed = f
            .service
            .sync_commit_cursor(&ctx, request.workspace, request.params)
            .await
            .expect("a landed commit answers committed");
        assert_eq!(committed["committed"], json!(true));
        assert_eq!(f.stored_cursor().as_deref(), Some("7"));
        assert_eq!(export_lane(0), 1);
        f.service
            .ydoc_evict(
                &ctx,
                Some(f.handle.clone()),
                json!({ "sessionId": opened["sessionId"] }),
            )
            .await
            .expect("evict the session");
        f.close().await;
    }

    #[tokio::test]
    async fn a_commit_cancelled_before_it_lands_keeps_its_token() {
        commit_stopped_before_landing_keeps_its_token(false).await;
    }

    #[tokio::test]
    async fn a_commit_expired_before_it_lands_keeps_its_token() {
        commit_stopped_before_landing_keeps_its_token(true).await;
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
    fn sharing_declined_json_keeps_distinct_versions_of_an_object() {
        let main = dohc_engine_sync::SharingDeclined {
            object_id: "object-1".to_owned(),
            version_id: "main".to_owned(),
            lineage_pruned: false,
            head_blob_sha256: None,
            path: "notes/large.md".to_owned(),
            constraint: "MAX_YDOC_UPDATE_BYTES",
            limit_bytes: 20,
            observed_bytes: 21,
        };
        let draft = dohc_engine_sync::SharingDeclined {
            version_id: "draft".to_owned(),
            ..main.clone()
        };
        let renamed_draft = dohc_engine_sync::SharingDeclined {
            path: "notes/renamed.md".to_owned(),
            ..draft.clone()
        };
        let values = super::sharing_declined_json(vec![main, draft, renamed_draft]);
        assert_eq!(values.len(), 2);
        assert_eq!(values[0]["versionId"], "draft");
        assert_eq!(values[0]["path"], "notes/renamed.md");
        assert_eq!(values[1]["versionId"], "main");
        assert_eq!(values[1]["path"], "notes/large.md");
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
                object_id: "notes/oversized.md".to_owned(),
                version_id: "main".to_owned(),
                lineage_pruned: false,
                head_blob_sha256: None,
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
                "objectId": "notes/oversized.md",
                "versionId": "main",
                "lineagePruned": false,
                "headBlobSha256": null,
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
    fn a_hosted_commit_that_could_not_read_its_unready_documents_stands_and_pulls_again() {
        let value = hosted_commit_json(
            COMMITTED,
            Ok(false),
            Err(dohc_engine_runtime::RuntimeError::ActorUnavailable),
            Ok(vec!["doc-b".to_owned()]),
            None,
            HELD_RESPONSE_BYTE_BUDGET,
        )
        .expect("commit JSON");
        assert_eq!(
            (
                &value["committed"],
                &value["hasMore"],
                &value["retirement"],
                &value["departed"]
            ),
            (&json!(true), &json!(true), &Value::Null, &json!(["doc-b"]))
        );
    }

    /// Slice 3: a commit that could not read its departed documents does not
    /// answer an empty list, which would let the host release them.
    #[test]
    fn a_hosted_commit_that_could_not_read_its_departed_documents_says_so_and_pulls_again() {
        let value = hosted_commit_json(
            COMMITTED,
            Ok(false),
            Ok(Vec::new()),
            Err(dohc_engine_runtime::RuntimeError::ActorUnavailable),
            None,
            HELD_RESPONSE_BYTE_BUDGET,
        )
        .expect("commit JSON");
        assert_eq!(
            (
                &value["committed"],
                &value["hasMore"],
                &value["retirement"],
                &value["departed"]
            ),
            (&json!(true), &json!(true), &Value::Null, &Value::Null)
        );
    }

    /// Opus's park review: a commit that kept a document held for the pass
    /// that writes its files said nothing, so nothing pulled again for it.
    #[test]
    fn a_hosted_commit_that_kept_a_document_held_for_its_files_pulls_again() {
        let answer = |has_more| {
            hosted_commit_json(
                dohc_engine_sync::HostedCommit {
                    committed: true,
                    has_more,
                },
                Ok(false),
                Ok(Vec::new()),
                Ok(Vec::new()),
                None,
                HELD_RESPONSE_BYTE_BUDGET,
            )
            .expect("commit JSON")["hasMore"]
                .clone()
        };
        assert_eq!((answer(true), answer(false)), (json!(true), json!(false)));
    }

    const COMMITTED: dohc_engine_sync::HostedCommit = dohc_engine_sync::HostedCommit {
        committed: true,
        has_more: false,
    };

    #[test]
    fn direct_push_outcome_json_states_each_write_and_how_it_ended() {
        let value = relay_outcome_json(RelayOperationOutcome::DirectWritesPushed(
            dohc_engine_sync::DirectWritePushOutcome {
                writes: vec![
                    dohc_engine_sync::DirectWriteReport {
                        recovered_draft_path: None,
                        paths: vec!["trip/packing/collection.yaml".to_owned()],
                        result: dohc_engine_sync::DirectWriteResult::Written,
                    },
                    dohc_engine_sync::DirectWriteReport {
                        recovered_draft_path: None,
                        paths: vec!["trip/ideas/collection.yaml".to_owned()],
                        result: dohc_engine_sync::DirectWriteResult::Stale {
                            path: "trip/ideas".to_owned(),
                            current_blob_sha256: None,
                        },
                    },
                    dohc_engine_sync::DirectWriteReport {
                        recovered_draft_path: None,
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
                        "recoveredDraftPath": null,
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
