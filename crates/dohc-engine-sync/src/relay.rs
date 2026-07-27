use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome};

use crate::cursor::{RelayCursor, commit_relay_cursor, read_pushed_seq, write_pushed_seq};
use crate::journal::{crashes, list_replication_ops, read_sync_identity};
use crate::{ApplyOutcome, RelayError, ReplicationEnvelope, SyncError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub origin_id: String,
    pub after_seq: i64,
    pub ops: Vec<ReplicationEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushResponse {
    pub accepted_through_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub cursor: Option<String>,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullResponse {
    pub ops: Vec<ReplicationEnvelope>,
    pub next_cursor: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub origin_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverResponse {
    pub old_origin_id: String,
    pub new_origin_id: String,
    pub shared_prefix_length: i64,
    pub preserved_ops: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbeResponse {
    pub has_content: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaimResponse;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeRequest {
    pub workspace_id: String,
    pub envelope_json: String,
    pub if_match: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeResponse {
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelRequest {
    pub share_id: String,
    pub cursor: Option<String>,
    pub ops: Vec<ReplicationEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelResponse {
    pub ops: Vec<ReplicationEnvelope>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewRequest {
    pub share_id: String,
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewResponse {
    pub ops: Vec<ReplicationEnvelope>,
    pub next_cursor: String,
}

/// Runtime-owned relay seam. Implementations retain no connection object by
/// contract; an HTTP adapter may open/close per call. The core crate contains
/// no HTTP or async runtime dependency.
pub trait RelayTransport {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError>;
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError>;
    fn recover_origin(&self, req: RecoverRequest) -> Result<RecoverResponse, RelayError>;
    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError>;
    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError>;
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError>;
    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError>;
    fn shared_channel_push(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError>;
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPassOutcome {
    Complete {
        pushed: usize,
        fetched: usize,
        applied: usize,
        refused: usize,
        skipped: usize,
        conflicts_opened: i64,
        pending_cursor: Option<RelayCursor>,
        /// Replicated resolutions acked in this pass that the receiver
        /// deliberately did not apply. The cursor advances past them, so they
        /// only exist here — a caller that drops this loses them.
        pending_resolves: Vec<crate::PendingResolve>,
        /// Per-operation validation failures that were journaled and acked.
        /// The rejected mutations were rolled back before those coordinates
        /// were retired.
        refusals: Vec<crate::ReplicationRefusal>,
    },
    CrashedAfterRemoteCommit,
    CrashedAfterApply {
        applied: usize,
        refused: usize,
        skipped: usize,
        conflicts_opened: i64,
        pending_cursor: RelayCursor,
        pending_resolves: Vec<crate::PendingResolve>,
        refusals: Vec<crate::ReplicationRefusal>,
    },
}

pub struct RelaySyncClient<T> {
    transport: T,
}

impl<T: RelayTransport> RelaySyncClient<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }

    pub fn push_workspace(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<SyncPassOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let mut cursor =
            read_pushed_seq(store, workspace_id, &identity.origin_id).map_err(local)?;
        let mut pushed = 0_usize;
        loop {
            let ops = list_replication_ops(
                store,
                workspace_id,
                &identity.origin_id,
                cursor,
                crate::MAX_PUSH_OPS_PER_BATCH,
            )
            .map_err(local)?;
            if ops.is_empty() {
                break;
            }
            let last = ops
                .last()
                .map(|op| op.origin_seq)
                .ok_or(RelayError::InvalidResponse)?;
            let response = self.transport.push(PushRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                origin_id: identity.origin_id.clone(),
                after_seq: cursor,
                ops,
            })?;
            if response.accepted_through_seq != last
                || response.accepted_through_seq < 0
                || response.accepted_through_seq > crate::MAX_WIRE_INTEGER
            {
                return Err(RelayError::InvalidResponse);
            }
            if crashes(faults, FaultPoint::SyncAfterPushBeforeCursorPersist) {
                return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
            }
            match write_pushed_seq(
                store,
                workspace_id,
                &identity.origin_id,
                response.accepted_through_seq,
                faults,
            )
            .map_err(local)?
            {
                TxnOutcome::Committed(()) => {}
                TxnOutcome::Crashed { .. } => return Ok(SyncPassOutcome::CrashedAfterRemoteCommit),
            }
            pushed = pushed
                .checked_add(
                    usize::try_from(
                        response
                            .accepted_through_seq
                            .checked_sub(cursor)
                            .ok_or(RelayError::InvalidResponse)?,
                    )
                    .map_err(|_| RelayError::InvalidResponse)?,
                )
                .ok_or(RelayError::InvalidResponse)?;
            cursor = response.accepted_through_seq;
        }
        Ok(SyncPassOutcome::Complete {
            pushed,
            fetched: 0,
            applied: 0,
            refused: 0,
            skipped: 0,
            conflicts_opened: 0,
            pending_cursor: None,
            pending_resolves: Vec::new(),
            refusals: Vec::new(),
        })
    }

    /// Pull and apply replicated operations,
    /// returning a cursor token the caller must commit only after
    /// filesystem/materialization work succeeds. `leases` defers ydoc
    /// envelopes targeting live-leased docs.
    pub fn pull_chat_workspace(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        faults: &dyn FaultInjector,
        leases: &dyn crate::LeaseProbe,
    ) -> Result<SyncPassOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let current = crate::read_relay_cursor(store, workspace_id).map_err(local)?;
        if let Some(cursor) = &current {
            if cursor.replication_epoch != identity.replication_epoch
                || cursor.stream_identity != identity.stream_identity
            {
                return Err(RelayError::InvalidResponse);
            }
        }
        let response = self.transport.pull(PullRequest {
            workspace_id: workspace_id.to_owned(),
            replication_epoch: identity.replication_epoch.clone(),
            stream_identity: identity.stream_identity.clone(),
            cursor: current.map(|value| value.cursor),
            limit: crate::MAX_PULL_OPS,
        })?;
        if response.ops.len() > crate::MAX_PULL_OPS || response.next_cursor.is_empty() {
            return Err(RelayError::InvalidResponse);
        }
        let fetched = response.ops.len();
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut skipped = 0_usize;
        let mut conflicts_opened = 0_i64;
        let mut pending_resolves = Vec::new();
        let mut refusals = Vec::new();
        let mut retryable = Vec::new();
        for op in &response.ops {
            // Workspace scoping: a buggy/compromised transport must never make a
            // pull for workspace A apply an op targeting workspace B (which would
            // mutate B and then advance A's cursor). Fail closed before applying;
            // the cursor is not persisted, so the pass is safely retryable.
            if op.workspace_id != workspace_id {
                return Err(RelayError::InvalidResponse);
            }
            match crate::apply_replication_envelope(store, op, faults, leases) {
                Err(SyncError::RetryableState { .. }) => retryable.push(op),
                Err(error) => return Err(local(error)),
                Ok(outcome) => accumulate_pull_outcome(
                    store,
                    op,
                    outcome,
                    &mut applied,
                    &mut refused,
                    &mut skipped,
                    &mut conflicts_opened,
                    &mut pending_resolves,
                    &mut refusals,
                )?,
            }
        }
        while !retryable.is_empty() {
            let mut still_retryable = Vec::new();
            let mut made_progress = false;
            for op in retryable {
                match crate::apply_replication_envelope(store, op, faults, leases) {
                    Err(SyncError::RetryableState { .. }) => still_retryable.push(op),
                    Err(error) => return Err(local(error)),
                    Ok(outcome) => {
                        made_progress = true;
                        accumulate_pull_outcome(
                            store,
                            op,
                            outcome,
                            &mut applied,
                            &mut refused,
                            &mut skipped,
                            &mut conflicts_opened,
                            &mut pending_resolves,
                            &mut refusals,
                        )?;
                    }
                }
            }
            if still_retryable.is_empty() {
                break;
            }
            if !made_progress {
                return Err(RelayError::Local("retryable-state".to_owned()));
            }
            retryable = still_retryable;
        }
        // A drain refusal can commit before a later envelope fails hard, or
        // outside a pull during open/resync/close. Claim every relay-owned
        // pending sidecar under a unique local report token and return it here.
        // Direct-RPC retry rows retain their sentinel. Cursor commit clears only
        // the claimed token; a later drain remains unowned, while a newer pull
        // retags relay rows so a stale cursor cannot destroy an unread refusal.
        let (pending_refusals, refusal_report_id) =
            crate::apply::claim_pending_refusals(store, workspace_id, faults).map_err(local)?;
        for refusal in pending_refusals {
            push_refusal_once(&mut refusals, refusal);
        }
        let pending_cursor = RelayCursor {
            cursor: response.next_cursor,
            replication_epoch: identity.replication_epoch,
            stream_identity: identity.stream_identity,
            refusal_report_id,
        };
        if crashes(faults, FaultPoint::SyncBetweenApplyAndCursorCommit) {
            return Ok(SyncPassOutcome::CrashedAfterApply {
                applied,
                refused,
                skipped,
                conflicts_opened,
                pending_cursor,
                pending_resolves,
                refusals,
            });
        }
        Ok(SyncPassOutcome::Complete {
            pushed: 0,
            fetched,
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor: Some(pending_cursor),
            pending_resolves,
            refusals,
        })
    }

    pub fn commit_pull_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &RelayCursor,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<()>, RelayError> {
        commit_relay_cursor(store, workspace_id, cursor, faults).map_err(local)
    }

    pub fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.probe(req)
    }

    pub fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.claim_workspace(req)
    }

    pub fn recover_origin(&self, req: RecoverRequest) -> Result<RecoverResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.recover_origin(req)
    }

    pub fn upload_key_envelope(
        &self,
        mut req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        if req.envelope_json.is_empty() || req.envelope_json.len() > crate::model::MAX_PAYLOAD_BYTES
        {
            return Err(RelayError::InvalidResponse);
        }
        for _ in 0..3 {
            match self.transport.upload_key_envelope(req.clone()) {
                Ok(response) if !response.etag.is_empty() => return Ok(response),
                Ok(_) => return Err(RelayError::InvalidResponse),
                Err(RelayError::Conflict) => {
                    req.if_match = Some("retry-current-etag".to_owned());
                }
                Err(err) => return Err(err),
            }
        }
        Err(RelayError::Conflict)
    }
}

#[allow(clippy::too_many_arguments)]
fn accumulate_pull_outcome(
    store: &EngineStore,
    op: &ReplicationEnvelope,
    outcome: ApplyOutcome<crate::RoutedApply>,
    applied: &mut usize,
    refused: &mut usize,
    skipped: &mut usize,
    conflicts_opened: &mut i64,
    pending_resolves: &mut Vec<crate::PendingResolve>,
    refusals: &mut Vec<crate::ReplicationRefusal>,
) -> Result<(), RelayError> {
    let (primary, drain_refusals) = outcome.into_primary_and_refusals();
    for refusal in drain_refusals {
        push_refusal_once(refusals, refusal);
    }
    match primary {
        ApplyOutcome::Applied(routed) => {
            if let Some(pending) = routed.pending_resolve() {
                pending_resolves.push(pending.clone());
            }
            *conflicts_opened = conflicts_opened
                .checked_add(routed.conflicts_opened)
                .ok_or(RelayError::InvalidResponse)?;
            *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
        }
        ApplyOutcome::Refused(refusal) => {
            *refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            push_refusal_once(refusals, refusal);
        }
        ApplyOutcome::Skipped => {
            if let Some(refusal) = crate::apply::read_replayed_refusal(store, op).map_err(local)? {
                push_refusal_once(refusals, refusal);
            }
            if let Some(pending) =
                crate::conflict_apply::read_replayed_pending_resolve(store, op).map_err(local)?
            {
                pending_resolves.push(pending);
            }
            *skipped = skipped.checked_add(1).ok_or(RelayError::InvalidResponse)?;
        }
        ApplyOutcome::Crashed { .. } => {
            return Err(RelayError::Local("injected-crash".to_owned()));
        }
        ApplyOutcome::WithRefusals { .. } => unreachable!("refusals were flattened"),
    }
    Ok(())
}

fn push_refusal_once(
    refusals: &mut Vec<crate::ReplicationRefusal>,
    refusal: crate::ReplicationRefusal,
) {
    if !refusals.iter().any(|existing| {
        existing.workspace_id == refusal.workspace_id
            && existing.origin_id == refusal.origin_id
            && existing.origin_seq == refusal.origin_seq
    }) {
        refusals.push(refusal);
    }
}

fn validate_identity_request(workspace: &str, epoch: &str, stream: &str) -> Result<(), RelayError> {
    crate::model::bounded(workspace, "workspace_id must be non-empty and bounded")
        .map_err(local)?;
    crate::model::bounded(epoch, "replication_epoch must be non-empty and bounded")
        .map_err(local)?;
    crate::model::bounded(stream, "stream_identity must be non-empty and bounded").map_err(local)
}

fn local(error: SyncError) -> RelayError {
    RelayError::Local(error.code().to_owned())
}
