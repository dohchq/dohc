use std::collections::{BTreeMap, BTreeSet};

use dohc_engine_domain::{DeleteTextFile, DomainError, VersionedTextStore, WriteBinary, WriteText};
use dohc_engine_storage::{EngineStore, FaultInjector, FaultPoint, TxnOutcome, hex_sha256};
use rusqlite::{OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::apply::apply_chat_lww_projection_tx;
use crate::cursor::{
    RelayCursor, commit_relay_cursor, read_pushed_seq, rewind_pushed_seq, write_pushed_seq,
};
use crate::journal::{crashes, list_replication_ops, read_sync_identity};
use crate::{
    ApplyOutcome, BlobContent, BlobHydration, RelayError, ReplicationEnvelope, SyncError,
    hydrate_blob_content,
};

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
    pub accepted: usize,
    pub inserted: usize,
    pub skipped: usize,
    pub current_max_origin_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub cursor: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullResponse {
    pub ops: Vec<ReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
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
pub struct EpochRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EpochResponse {
    pub rotated: bool,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobHaveRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256s: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobHaveResponse {
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobUploadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownloadResponse {
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
    pub envelope_json: String,
    pub if_match: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeResponse {
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeDownloadRequest {
    pub workspace_id: String,
    pub replication_epoch: String,
    pub stream_identity: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyEnvelopeDownloadResponse {
    pub envelope_json: String,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareReplicationEnvelope {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub payload: serde_json::Value,
    pub recorded_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelRequest {
    pub share_id: String,
    pub channel_wire_id: String,
    pub origin_id: String,
    pub cursor: i64,
    pub ops: Vec<ShareReplicationEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelResponse {
    pub ops: Vec<ShareReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
    pub push: Option<PushResponse>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewRequest {
    pub share_id: String,
    pub cursor: i64,
    pub limit: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewResponse {
    pub ops: Vec<ShareReplicationEnvelope>,
    pub next_cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareBlobRequest {
    pub share_id: String,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoverResponse {
    pub old_origin_id: String,
    pub new_origin_id: String,
    pub shared_prefix_length: i64,
    pub preserved_ops: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelRejection {
    pub origin_id: String,
    pub origin_seq: i64,
    pub op_kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelPullOutcome {
    pub fetched: usize,
    pub has_more: bool,
    pub applied: usize,
    pub refused: usize,
    pub rejections: Vec<SharedChannelRejection>,
    pub skipped: usize,
    pub next_cursor: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedChannelPushOutcome {
    pub pushed: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewChangedPath {
    pub path: String,
    pub operation: &'static str,
    pub content_kind: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareViewPullOutcome {
    pub fetched: usize,
    pub has_more: bool,
    pub applied: usize,
    pub skipped: usize,
    pub changed_paths: Vec<ShareViewChangedPath>,
    pub pending_cursor: crate::ShareCursor,
}

/// Runtime-owned relay seam. The core crate contains no HTTP or async runtime
/// dependency; production adapters live in separate crates.
pub trait RelayTransport {
    fn push(&self, req: PushRequest) -> Result<PushResponse, RelayError>;
    fn pull(&self, req: PullRequest) -> Result<PullResponse, RelayError>;
    fn probe(&self, req: ProbeRequest) -> Result<ProbeResponse, RelayError>;
    fn claim_workspace(&self, req: ClaimRequest) -> Result<ClaimResponse, RelayError>;
    fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError>;
    fn blobs_have(&self, req: BlobHaveRequest) -> Result<BlobHaveResponse, RelayError>;
    fn upload_blob(&self, req: BlobUploadRequest) -> Result<(), RelayError>;
    fn download_blob(&self, req: BlobDownloadRequest) -> Result<BlobDownloadResponse, RelayError>;
    fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError>;
    fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError>;
    fn shared_channel_pull(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError>;
    fn shared_channel_push(
        &self,
        req: SharedChannelRequest,
    ) -> Result<SharedChannelResponse, RelayError>;
    fn share_view_pull(&self, req: ShareViewRequest) -> Result<ShareViewResponse, RelayError>;
    fn share_blob(&self, req: ShareBlobRequest) -> Result<BlobDownloadResponse, RelayError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncPassOutcome {
    Complete {
        pushed: usize,
        fetched: usize,
        has_more: bool,
        applied: usize,
        refused: usize,
        skipped: usize,
        conflicts_opened: i64,
        pending_cursor: Option<RelayCursor>,
        changed_paths: Vec<crate::MomentMaterializationChange>,
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
        changed_paths: Vec<crate::MomentMaterializationChange>,
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
        let origins = list_workspace_origins(store, workspace_id).map_err(local)?;
        let mut pushed = 0_usize;

        for origin_id in origins {
            let local_max = local_max_origin_seq(store, workspace_id, &origin_id).map_err(local)?;
            let mut cursor = read_pushed_seq(store, workspace_id, &origin_id).map_err(local)?;
            let mut attempt = 0_u8;

            loop {
                let ops = list_replication_ops(
                    store,
                    workspace_id,
                    &origin_id,
                    cursor,
                    crate::MAX_PULL_OPS,
                )
                .map_err(local)?;
                if ops.is_empty() {
                    break;
                }
                self.upload_missing_blobs(store, workspace_id, &identity, &ops)?;

                let mut conflict = false;
                for batch in ops.chunks(crate::MAX_PUSH_OPS_PER_BATCH) {
                    let response = match self.transport.push(PushRequest {
                        workspace_id: workspace_id.to_owned(),
                        replication_epoch: identity.replication_epoch.clone(),
                        stream_identity: identity.stream_identity.clone(),
                        origin_id: origin_id.clone(),
                        after_seq: cursor,
                        ops: batch.to_vec(),
                    }) {
                        Ok(response) => response,
                        Err(RelayError::Conflict) if attempt == 0 => {
                            conflict = true;
                            break;
                        }
                        Err(error) => return Err(error),
                    };
                    validate_push_response(&response, batch, local_max)?;
                    if response.current_max_origin_seq > local_max {
                        return Err(RelayError::OriginDiverged);
                    }
                    if crashes(faults, FaultPoint::SyncAfterPushBeforeCursorPersist) {
                        return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                    }
                    match write_pushed_seq(
                        store,
                        workspace_id,
                        &origin_id,
                        response.current_max_origin_seq,
                        faults,
                    )
                    .map_err(local)?
                    {
                        TxnOutcome::Committed(()) => {}
                        TxnOutcome::Crashed { .. } => {
                            return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                        }
                    }
                    pushed = pushed
                        .checked_add(response.inserted)
                        .ok_or(RelayError::InvalidResponse)?;
                    cursor = response.current_max_origin_seq;
                }
                if !conflict {
                    continue;
                }

                let probe = self.transport.push(PushRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    origin_id: origin_id.clone(),
                    after_seq: cursor,
                    ops: Vec::new(),
                })?;
                validate_probe_response(&probe)?;
                if probe.current_max_origin_seq > local_max
                    || probe.current_max_origin_seq >= cursor
                {
                    return Err(RelayError::OriginDiverged);
                }
                match rewind_pushed_seq(
                    store,
                    workspace_id,
                    &origin_id,
                    probe.current_max_origin_seq,
                    faults,
                )
                .map_err(local)?
                {
                    TxnOutcome::Committed(()) => {}
                    TxnOutcome::Crashed { .. } => {
                        return Ok(SyncPassOutcome::CrashedAfterRemoteCommit);
                    }
                }
                cursor = probe.current_max_origin_seq;
                attempt = attempt.saturating_add(1);
            }
        }

        Ok(SyncPassOutcome::Complete {
            pushed,
            fetched: 0,
            has_more: false,
            applied: 0,
            refused: 0,
            skipped: 0,
            conflicts_opened: 0,
            pending_cursor: None,
            changed_paths: Vec::new(),
            pending_resolves: Vec::new(),
            refusals: Vec::new(),
        })
    }

    /// Pull and apply replicated operations. The returned cursor remains
    /// pending until the caller completes disk materialization and commits it.
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
        let mut cursor = current.map_or(0, |value| value.cursor);
        let mut fetched = 0_usize;
        let mut pages = 0_usize;
        let mut ops = Vec::new();
        let has_more = loop {
            let remaining = crate::model::MAX_PULL_OPS_PER_PASS
                .checked_sub(fetched)
                .ok_or(RelayError::InvalidResponse)?;
            let limit = remaining.min(crate::MAX_PULL_OPS);
            let response = self.transport.pull(PullRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                cursor,
                limit,
            })?;
            validate_pull_page(&response, workspace_id, cursor)?;
            if response.ops.len() > limit {
                return Err(RelayError::InvalidResponse);
            }
            fetched = fetched
                .checked_add(response.ops.len())
                .ok_or(RelayError::InvalidResponse)?;
            ops.extend(response.ops);
            cursor = response.next_cursor;
            let has_more = response.has_more;
            pages = pages.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            if !has_more
                || fetched >= crate::model::MAX_PULL_OPS_PER_PASS
                || pages >= crate::model::MAX_PULL_PAGES_PER_PASS
            {
                break has_more;
            }
        };

        preflight_collisions(store, workspace_id, &identity.origin_id, &ops)?;
        self.hydrate_missing_blobs(store, workspace_id, &identity, &ops, faults)?;
        let ordered = merge_by_origin(ops);
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut skipped = 0_usize;
        let mut conflicts_opened = 0_i64;
        let mut pending_resolves = Vec::new();
        let mut refusals = Vec::new();
        let mut changed_paths = BTreeMap::new();
        let mut retryable = Vec::new();
        for op in &ordered {
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
                    &mut changed_paths,
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
                            &mut changed_paths,
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

        let mut pulled_foreign_max = BTreeMap::<String, i64>::new();
        for op in &ordered {
            if op.origin_id != identity.origin_id {
                pulled_foreign_max
                    .entry(op.origin_id.clone())
                    .and_modify(|seq| *seq = (*seq).max(op.origin_seq))
                    .or_insert(op.origin_seq);
            }
        }
        for (origin_id, max_seq) in pulled_foreign_max {
            if max_seq > read_pushed_seq(store, workspace_id, &origin_id).map_err(local)? {
                match write_pushed_seq(store, workspace_id, &origin_id, max_seq, faults)
                    .map_err(local)?
                {
                    TxnOutcome::Committed(()) => {}
                    TxnOutcome::Crashed { .. } => {
                        return Err(RelayError::Local("injected-crash".to_owned()));
                    }
                }
            }
        }

        let pending_cursor = RelayCursor {
            cursor,
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
                changed_paths: changed_paths.into_values().collect(),
                pending_resolves,
                refusals,
            });
        }
        Ok(SyncPassOutcome::Complete {
            pushed: 0,
            fetched,
            has_more,
            applied,
            refused,
            skipped,
            conflicts_opened,
            pending_cursor: Some(pending_cursor),
            changed_paths: changed_paths.into_values().collect(),
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

    pub fn rotate_epoch(&self, req: EpochRequest) -> Result<EpochResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        self.transport.rotate_epoch(req)
    }

    pub fn upload_key_envelope(
        &self,
        req: KeyEnvelopeRequest,
    ) -> Result<KeyEnvelopeResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        if req.envelope_json.is_empty() || req.envelope_json.len() > 16 * 1024 {
            return Err(RelayError::InvalidResponse);
        }
        let response = self.transport.upload_key_envelope(req)?;
        if response.etag.is_empty() {
            return Err(RelayError::InvalidResponse);
        }
        Ok(response)
    }

    pub fn download_key_envelope(
        &self,
        req: KeyEnvelopeDownloadRequest,
    ) -> Result<KeyEnvelopeDownloadResponse, RelayError> {
        validate_identity_request(
            &req.workspace_id,
            &req.replication_epoch,
            &req.stream_identity,
        )?;
        let response = self.transport.download_key_envelope(req)?;
        if response.envelope_json.is_empty()
            || response.envelope_json.len() > 16 * 1024
            || response.etag.is_empty()
        {
            return Err(RelayError::InvalidResponse);
        }
        Ok(response)
    }

    pub fn recover_origin(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        new_origin_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<RecoverResponse, RelayError> {
        crate::model::bounded(new_origin_id, "origin_id must be non-empty and bounded")
            .map_err(local)?;
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let mut shared_prefix_length = 0_i64;
        let mut cursor = 0;
        'pages: loop {
            let page = self.transport.pull(PullRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                cursor,
                limit: crate::MAX_PULL_OPS,
            })?;
            validate_pull_page(&page, workspace_id, cursor)?;
            for op in page.ops {
                if op.origin_id != identity.origin_id || op.origin_seq < shared_prefix_length {
                    continue;
                }
                if op.origin_seq != shared_prefix_length {
                    break 'pages;
                }
                let local_op = list_replication_ops(
                    store,
                    workspace_id,
                    &identity.origin_id,
                    shared_prefix_length - 1,
                    1,
                )
                .map_err(local)?
                .into_iter()
                .next();
                let Some(local_op) = local_op else {
                    break 'pages;
                };
                if local_op.origin_seq != shared_prefix_length
                    || local_op.op_kind != op.op_kind
                    || local_op.recorded_at_ms != op.recorded_at_ms
                    || canonical_json_bytes(&local_op.payload).map_err(local)?
                        != canonical_json_bytes(&op.payload).map_err(local)?
                {
                    break 'pages;
                }
                shared_prefix_length = shared_prefix_length
                    .checked_add(1)
                    .ok_or(RelayError::InvalidResponse)?;
            }
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }

        let old_origin_id = identity.origin_id;
        let result = store
            .write_with(faults, |tx| {
                let collision: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM replication_log \
                         WHERE workspace_id=?1 AND origin_id=?2)",
                        params![workspace_id, new_origin_id],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                if collision {
                    return Err(SyncError::CoordinateDiverged);
                }
                let preserved_ops: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM replication_log \
                         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3",
                        params![workspace_id, old_origin_id, shared_prefix_length],
                        |row| row.get(0),
                    )
                    .map_err(SyncError::corrupt)?;
                tx.execute(
                    "INSERT INTO replication_log \
                     (workspace_id,origin_id,origin_seq,op_kind,payload_json,recorded_at_ms,imported) \
                     SELECT workspace_id,?1,origin_seq-?2,op_kind,payload_json,recorded_at_ms,0 \
                     FROM replication_log \
                     WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq>=?2 \
                     ORDER BY origin_seq",
                    params![
                        new_origin_id,
                        shared_prefix_length,
                        workspace_id,
                        old_origin_id
                    ],
                )
                .map_err(SyncError::persist)?;
                let affected_chat_lww_cells = rebase_chat_projection_suffix(
                    tx,
                    workspace_id,
                    &old_origin_id,
                    shared_prefix_length,
                    new_origin_id,
                )?;
                tx.execute(
                    "DELETE FROM replication_log \
                     WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3",
                    params![workspace_id, old_origin_id, shared_prefix_length],
                )
                .map_err(SyncError::persist)?;
                recompute_chat_projection_winners(
                    tx,
                    workspace_id,
                    new_origin_id,
                    &affected_chat_lww_cells,
                )?;
                tx.execute(
                    "UPDATE sync_identity SET origin_id=?1 WHERE workspace_id=?2",
                    params![new_origin_id, workspace_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "INSERT INTO sync_relay_push_state (workspace_id,origin_id,pushed_seq) \
                     VALUES (?1,?2,?3) ON CONFLICT(workspace_id,origin_id) DO UPDATE SET \
                     pushed_seq=excluded.pushed_seq",
                    params![workspace_id, old_origin_id, shared_prefix_length - 1],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "UPDATE replication_peers SET acked_seq=?1 \
                     WHERE workspace_id=?2 AND origin_id=?3 AND acked_seq>?1",
                    params![shared_prefix_length - 1, workspace_id, old_origin_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM sync_relay_push_state WHERE workspace_id=?1 AND origin_id=?2",
                    params![workspace_id, new_origin_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM sync_relay_cursors WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                tx.execute(
                    "DELETE FROM shared_channel_push_state WHERE workspace_id=?1",
                    [workspace_id],
                )
                .map_err(SyncError::persist)?;
                usize::try_from(preserved_ops).map_err(|_| SyncError::CoordinateDiverged)
            })
            .map_err(local)?;
        let preserved_ops = match result {
            TxnOutcome::Committed(preserved_ops) => preserved_ops,
            TxnOutcome::Crashed { .. } => {
                return Err(RelayError::Local("injected-crash".to_owned()));
            }
        };
        Ok(RecoverResponse {
            old_origin_id,
            new_origin_id: new_origin_id.to_owned(),
            shared_prefix_length,
            preserved_ops,
        })
    }

    pub fn pull_shared_channel(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        channel_wire_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<SharedChannelPullOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id).map_err(local)?;
        let own_echo = identity
            .as_ref()
            .map(|value| format!("share:{share_id}:{}", value.origin_id));
        let mut cursor = crate::read_share_cursor(
            store,
            workspace_id,
            share_id,
            crate::CursorKind::SharedChannel,
        )
        .map_err(local)?;
        let page = self.transport.shared_channel_pull(SharedChannelRequest {
            share_id: share_id.to_owned(),
            channel_wire_id: channel_wire_id.to_owned(),
            origin_id: identity
                .as_ref()
                .map_or_else(String::new, |value| value.origin_id.clone()),
            cursor,
            ops: Vec::new(),
        })?;
        validate_share_page(&page.ops, page.next_cursor, page.has_more, cursor)?;
        let fetched = page.ops.len();
        let ops = page.ops;
        cursor = page.next_cursor;

        let boundary = crate::ShareBoundary {
            share_id: share_id.to_owned(),
            surface: crate::ShareSurface::SharedChannel,
            channel_wire_id: Some(channel_wire_id.to_owned()),
            path_prefix: None,
        };
        let mut applied = 0_usize;
        let mut refused = 0_usize;
        let mut rejections = Vec::new();
        let mut skipped = 0_usize;
        for op in ops {
            if own_echo.as_deref() == Some(op.origin_id.as_str()) {
                skipped += 1;
                continue;
            }
            let envelope = match share_envelope(workspace_id, op) {
                Ok(envelope) => envelope,
                Err(RelayError::InvalidResponse) => {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(outcome) => {
                    let (primary, nested_refusals) = outcome.into_primary_and_refusals();
                    for refusal in nested_refusals {
                        push_shared_channel_rejection(&mut refused, &mut rejections, refusal)?;
                    }
                    match primary {
                        ApplyOutcome::Applied(_) => applied += 1,
                        ApplyOutcome::Refused(refusal) => {
                            push_shared_channel_rejection(&mut refused, &mut rejections, refusal)?;
                        }
                        ApplyOutcome::Skipped => skipped += 1,
                        ApplyOutcome::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                        ApplyOutcome::WithRefusals { .. } => {
                            unreachable!("refusals were flattened")
                        }
                    }
                }
                Err(SyncError::ShareBoundaryViolation) => {
                    refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
                    rejections.push(SharedChannelRejection {
                        origin_id: envelope.origin_id,
                        origin_seq: envelope.origin_seq,
                        op_kind: envelope.op_kind,
                        reason: "share-boundary-violation".to_owned(),
                    });
                }
                Err(SyncError::InvalidInput { .. }) => {
                    skipped += 1;
                }
                Err(error) => return Err(local(error)),
            }
        }
        let committed = crate::commit_share_cursor(
            store,
            workspace_id,
            &crate::ShareCursor {
                kind: crate::CursorKind::SharedChannel,
                share_id: share_id.to_owned(),
                cursor,
            },
            faults,
        )
        .map_err(local)?;
        if matches!(committed, TxnOutcome::Crashed { .. }) {
            return Err(RelayError::Local("injected-crash".to_owned()));
        }
        Ok(SharedChannelPullOutcome {
            fetched,
            has_more: page.has_more,
            applied,
            refused,
            rejections,
            skipped,
            next_cursor: cursor,
        })
    }

    pub fn push_shared_channel(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        channel_wire_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<SharedChannelPushOutcome, RelayError> {
        let identity = read_sync_identity(store, workspace_id)
            .map_err(local)?
            .ok_or(RelayError::InvalidResponse)?;
        let state = read_shared_push_state(store, workspace_id, share_id)?;
        let scanned = state.scanned_seq;
        let mut dense_seq = match state.dense_seq {
            Some(dense_seq) => dense_seq,
            None => {
                let dense_seq = shared_dense_seq_through(
                    store,
                    workspace_id,
                    &identity.origin_id,
                    channel_wire_id,
                    scanned,
                )?;
                write_shared_push_state(store, workspace_id, share_id, scanned, dense_seq, faults)?;
                dense_seq
            }
        };
        let mut pending = Vec::with_capacity(crate::MAX_PUSH_OPS_PER_BATCH);
        let mut last_scanned = scanned;
        let mut pushed = 0_usize;
        let push_batch = |batch: &[(i64, ShareReplicationEnvelope)]| {
            let response = self.transport.shared_channel_push(SharedChannelRequest {
                share_id: share_id.to_owned(),
                channel_wire_id: channel_wire_id.to_owned(),
                origin_id: identity.origin_id.clone(),
                cursor: 0,
                ops: batch.iter().map(|(_, op)| op.clone()).collect(),
            })?;
            let push = response.push.ok_or(RelayError::InvalidResponse)?;
            if push.accepted != batch.len()
                || push.inserted.checked_add(push.skipped) != Some(push.accepted)
            {
                return Err(RelayError::InvalidResponse);
            }
            Ok(push.inserted)
        };
        let mut after = scanned;
        loop {
            let page = list_replication_ops(
                store,
                workspace_id,
                &identity.origin_id,
                after,
                crate::MAX_PULL_OPS,
            )
            .map_err(local)?;
            let Some(page_last) = page.last().map(|op| op.origin_seq) else {
                break;
            };
            for op in page {
                let eligible =
                    shared_channel_op_allowed(store, workspace_id, channel_wire_id, &op)?;
                if eligible {
                    dense_seq = dense_seq
                        .checked_add(1)
                        .ok_or(RelayError::InvalidResponse)?;
                }
                if op.origin_seq <= scanned {
                    continue;
                }
                last_scanned = op.origin_seq;
                if eligible {
                    pending.push((
                        op.origin_seq,
                        ShareReplicationEnvelope {
                            origin_id: identity.origin_id.clone(),
                            origin_seq: dense_seq,
                            op_kind: op.op_kind,
                            payload: op.payload,
                            recorded_at_ms: op.recorded_at_ms,
                        },
                    ));
                }
                if pending.len() == crate::MAX_PUSH_OPS_PER_BATCH {
                    pushed = pushed
                        .checked_add(push_batch(&pending)?)
                        .ok_or(RelayError::InvalidResponse)?;
                    write_shared_push_state(
                        store,
                        workspace_id,
                        share_id,
                        pending.last().ok_or(RelayError::InvalidResponse)?.0,
                        dense_seq,
                        faults,
                    )?;
                    pending.clear();
                }
            }
            after = page_last;
        }
        if !pending.is_empty() {
            pushed = pushed
                .checked_add(push_batch(&pending)?)
                .ok_or(RelayError::InvalidResponse)?;
            write_shared_push_state(
                store,
                workspace_id,
                share_id,
                pending.last().ok_or(RelayError::InvalidResponse)?.0,
                dense_seq,
                faults,
            )?;
        }
        write_shared_push_state(
            store,
            workspace_id,
            share_id,
            last_scanned,
            dense_seq,
            faults,
        )?;
        Ok(SharedChannelPushOutcome { pushed })
    }

    pub fn pull_share_view(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        share_id: &str,
        faults: &dyn FaultInjector,
    ) -> Result<ShareViewPullOutcome, RelayError> {
        let mut cursor =
            crate::read_share_cursor(store, workspace_id, share_id, crate::CursorKind::ShareView)
                .map_err(local)?;
        let page = self.transport.share_view_pull(ShareViewRequest {
            share_id: share_id.to_owned(),
            cursor,
            limit: crate::model::MAX_PULL_OPS_PER_PASS,
        })?;
        validate_share_page(&page.ops, page.next_cursor, page.has_more, cursor)?;
        let fetched = page.ops.len();
        let ops = page.ops;
        cursor = page.next_cursor;
        let boundary = crate::ShareBoundary {
            share_id: share_id.to_owned(),
            surface: crate::ShareSurface::ShareView,
            channel_wire_id: None,
            path_prefix: None,
        };
        let mut applied = 0_usize;
        let mut skipped = 0_usize;
        let mut changed = BTreeMap::<String, ShareViewChangedPath>::new();
        for op in ops {
            let envelope = match share_envelope(workspace_id, op) {
                Ok(envelope) => envelope,
                Err(RelayError::InvalidResponse) => {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match crate::apply_shared_envelope(store, &boundary, &envelope, faults) {
                Ok(outcome) => {
                    let (primary, nested_refusals) = outcome.into_primary_and_refusals();
                    debug_assert!(
                        nested_refusals.is_empty(),
                        "share-view boundary application does not mutate chat dependencies"
                    );
                    match primary {
                        ApplyOutcome::Applied(_) => {}
                        ApplyOutcome::Refused(_) | ApplyOutcome::Skipped => {
                            skipped += 1;
                            continue;
                        }
                        ApplyOutcome::Crashed { .. } => {
                            return Err(RelayError::Local("injected-crash".to_owned()));
                        }
                        ApplyOutcome::WithRefusals { .. } => {
                            unreachable!("refusals were flattened")
                        }
                    }
                }
                Err(SyncError::ShareBoundaryViolation | SyncError::InvalidInput { .. }) => {
                    skipped += 1;
                    continue;
                }
                Err(error) => return Err(local(error)),
            }
            let mut replay = ShareViewReplayContext {
                transport: &self.transport,
                store,
                workspace_id,
                share_id,
                faults,
                applied: &mut applied,
                changed: &mut changed,
            };
            replay_share_view_op(&mut replay, &envelope)?;
        }
        Ok(ShareViewPullOutcome {
            fetched,
            has_more: page.has_more,
            applied,
            skipped,
            changed_paths: changed.into_values().collect(),
            pending_cursor: crate::ShareCursor {
                kind: crate::CursorKind::ShareView,
                share_id: share_id.to_owned(),
                cursor,
            },
        })
    }

    pub fn commit_share_view_cursor(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        cursor: &crate::ShareCursor,
        faults: &dyn FaultInjector,
    ) -> Result<TxnOutcome<()>, RelayError> {
        if cursor.kind != crate::CursorKind::ShareView {
            return Err(RelayError::InvalidResponse);
        }
        crate::commit_share_cursor(store, workspace_id, cursor, faults).map_err(local)
    }

    fn upload_missing_blobs(
        &self,
        store: &EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        ops: &[ReplicationEnvelope],
    ) -> Result<(), RelayError> {
        let refs = collect_blob_refs(ops)?;
        let all = refs.keys().cloned().collect::<Vec<_>>();
        for sha_chunk in all.chunks(crate::MAX_BLOB_HAVE_BATCH) {
            let response = self.transport.blobs_have(BlobHaveRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                sha256s: sha_chunk.to_vec(),
            })?;
            let requested = sha_chunk.iter().collect::<BTreeSet<_>>();
            let mut seen = BTreeSet::new();
            for sha256 in response.missing {
                if !requested.contains(&sha256) || !seen.insert(sha256.clone()) {
                    return Err(RelayError::InvalidResponse);
                }
                let kinds = refs.get(&sha256).ok_or(RelayError::InvalidResponse)?;
                let mut bytes = None;
                for kind in kinds {
                    if let Some(local) = local_blob_bytes(store, &sha256, *kind)? {
                        bytes = Some(local);
                        break;
                    }
                }
                let bytes = bytes.ok_or(RelayError::BlobInvalid)?;
                self.transport.upload_blob(BlobUploadRequest {
                    workspace_id: workspace_id.to_owned(),
                    replication_epoch: identity.replication_epoch.clone(),
                    stream_identity: identity.stream_identity.clone(),
                    sha256,
                    bytes,
                })?;
            }
        }
        Ok(())
    }

    fn hydrate_missing_blobs(
        &self,
        store: &mut EngineStore,
        workspace_id: &str,
        identity: &crate::SyncIdentity,
        ops: &[ReplicationEnvelope],
        faults: &dyn FaultInjector,
    ) -> Result<(), RelayError> {
        for (sha256, kinds) in collect_blob_refs(ops)? {
            let mut missing = Vec::new();
            for kind in kinds {
                if !local_blob_present(store, &sha256, kind)? {
                    missing.push(kind);
                }
            }
            if missing.is_empty() {
                continue;
            }
            let response = self.transport.download_blob(BlobDownloadRequest {
                workspace_id: workspace_id.to_owned(),
                replication_epoch: identity.replication_epoch.clone(),
                stream_identity: identity.stream_identity.clone(),
                sha256: sha256.clone(),
            })?;
            if hex_sha256(&response.bytes) != sha256 {
                return Err(RelayError::BlobInvalid);
            }
            for kind in missing {
                let content = match kind {
                    BlobKind::Text => String::from_utf8(response.bytes.clone())
                        .map(BlobContent::Text)
                        .map_err(|_| RelayError::BlobInvalid)?,
                    BlobKind::Binary => BlobContent::Binary(response.bytes.clone()),
                };
                match hydrate_blob_content(
                    store,
                    &BlobHydration {
                        sha256: sha256.clone(),
                        content,
                    },
                    faults,
                )
                .map_err(|error| {
                    if matches!(error, SyncError::BlobInvalid) {
                        RelayError::BlobInvalid
                    } else {
                        local(error)
                    }
                })? {
                    TxnOutcome::Committed(()) => {}
                    TxnOutcome::Crashed { .. } => {
                        return Err(RelayError::Local("injected-crash".to_owned()));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum BlobKind {
    Text,
    Binary,
}

fn collect_blob_refs(
    ops: &[ReplicationEnvelope],
) -> Result<BTreeMap<String, BTreeSet<BlobKind>>, RelayError> {
    let mut refs = BTreeMap::new();
    for op in ops {
        match op.op_kind.as_str() {
            "moment.append" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("payloadBeforeBlobSha256"),
                    content_kind(op.payload.get("payloadBeforeContentKind")),
                )?;
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("payloadAfterBlobSha256"),
                    content_kind(op.payload.get("payloadAfterContentKind")),
                )?;
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("beforeBlobSha256"),
                    content_kind(op.payload.get("beforeContentKind")),
                )?;
            }
            "conflict.open" => {
                for name in ["base", "current", "incoming"] {
                    let Some(state) = op.payload.get(name) else {
                        continue;
                    };
                    if state.get("exists").and_then(serde_json::Value::as_bool) == Some(true)
                        && content_kind(state.get("contentKind")) == BlobKind::Binary
                    {
                        insert_optional_ref(&mut refs, state.get("sha256"), BlobKind::Binary)?;
                    }
                }
            }
            "version.create" => {
                for snapshot in op
                    .payload
                    .get("forkSnapshots")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    insert_optional_ref(
                        &mut refs,
                        snapshot.get("blobSha256"),
                        content_kind(snapshot.get("contentKind")),
                    )?;
                }
            }
            "ydoc.update" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("updateBlobSha256"),
                    BlobKind::Binary,
                )?;
            }
            "secret.file.put" => {
                insert_optional_ref(
                    &mut refs,
                    op.payload.get("ciphertextSha256"),
                    BlobKind::Binary,
                )?;
            }
            "secret.version.fork" => {
                for row in op
                    .payload
                    .get("rows")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    insert_optional_ref(&mut refs, row.get("ciphertextSha256"), BlobKind::Binary)?;
                }
            }
            _ => {}
        }
    }
    Ok(refs)
}

fn content_kind(value: Option<&serde_json::Value>) -> BlobKind {
    if value.and_then(serde_json::Value::as_str) == Some("binary") {
        BlobKind::Binary
    } else {
        BlobKind::Text
    }
}

fn insert_optional_ref(
    refs: &mut BTreeMap<String, BTreeSet<BlobKind>>,
    value: Option<&serde_json::Value>,
    kind: BlobKind,
) -> Result<(), RelayError> {
    let Some(sha256) = value.and_then(serde_json::Value::as_str) else {
        return Ok(());
    };
    if sha256.is_empty() {
        return Ok(());
    }
    if !valid_sha256(sha256) {
        return Err(RelayError::BlobInvalid);
    }
    refs.entry(sha256.to_owned()).or_default().insert(kind);
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn local_blob_bytes(
    store: &EngineStore,
    sha256: &str,
    kind: BlobKind,
) -> Result<Option<Vec<u8>>, RelayError> {
    #[cfg(test)]
    LOCAL_BLOB_BYTES_CALLS.with(|calls| calls.set(calls.get() + 1));
    store
        .read_with(|conn| match kind {
            BlobKind::Text => {
                let row = conn
                    .query_row(
                        "SELECT byte_length,text FROM blobs WHERE sha256=?1",
                        [sha256],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let Some((byte_length, text)) = row else {
                    return Ok(None);
                };
                let bytes = text.into_bytes();
                if usize::try_from(byte_length).ok() != Some(bytes.len())
                    || hex_sha256(&bytes) != sha256
                {
                    return Err(SyncError::BlobInvalid);
                }
                Ok(Some(bytes))
            }
            BlobKind::Binary => {
                let row = conn
                    .query_row(
                        "SELECT byte_length,bytes FROM binary_blobs WHERE sha256=?1",
                        [sha256],
                        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let Some((byte_length, bytes)) = row else {
                    return Ok(None);
                };
                if usize::try_from(byte_length).ok() != Some(bytes.len())
                    || bytes.len() > 5 * 1024 * 1024
                    || hex_sha256(&bytes) != sha256
                {
                    return Err(SyncError::BlobInvalid);
                }
                Ok(Some(bytes))
            }
        })
        .map_err(|error| {
            if matches!(error, SyncError::BlobInvalid) {
                RelayError::BlobInvalid
            } else {
                local(error)
            }
        })
}

#[cfg(test)]
thread_local! {
    static LOCAL_BLOB_BYTES_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_local_blob_bytes_call_count() -> usize {
    LOCAL_BLOB_BYTES_CALLS.with(|calls| {
        let count = calls.get();
        calls.set(0);
        count
    })
}

fn local_blob_present(
    store: &EngineStore,
    sha256: &str,
    kind: BlobKind,
) -> Result<bool, RelayError> {
    store
        .read_with(|conn| {
            let table = match kind {
                BlobKind::Text => "blobs",
                BlobKind::Binary => "binary_blobs",
            };
            conn.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE sha256=?1)"),
                [sha256],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ChatLwwCell {
    Reaction {
        message_id: String,
        emoji: String,
        author_id: String,
    },
    Decision {
        message_id: String,
    },
    Follow {
        owner_user_id: String,
        target_kind: String,
        target_id: String,
    },
    FeedRead {
        owner_user_id: String,
    },
}

fn chat_lww_cell(op_kind: &str, payload: &serde_json::Value) -> Option<ChatLwwCell> {
    let field = |name| payload.get(name)?.as_str().map(str::to_owned);
    match op_kind {
        "chat.reaction.set" => Some(ChatLwwCell::Reaction {
            message_id: field("messageId")?,
            emoji: field("emoji")?,
            author_id: field("authorId")?,
        }),
        "chat.decision.set" => Some(ChatLwwCell::Decision {
            message_id: field("messageId")?,
        }),
        "chat.follow.set" => Some(ChatLwwCell::Follow {
            owner_user_id: field("ownerUserId")?,
            target_kind: field("targetKind")?,
            target_id: field("targetId")?,
        }),
        "chat.feed.read.set" => Some(ChatLwwCell::FeedRead {
            owner_user_id: field("ownerUserId")?,
        }),
        _ => None,
    }
}

fn rebase_chat_projection_suffix(
    tx: &Transaction<'_>,
    workspace_id: &str,
    old_origin_id: &str,
    first_old_origin_seq: i64,
    new_origin_id: &str,
) -> Result<BTreeSet<ChatLwwCell>, SyncError> {
    let suffix_ops = {
        let mut statement = tx
            .prepare(
                "SELECT origin_seq,op_kind,payload_json FROM replication_log \
                 WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq>=?3 \
                   AND op_kind IN ('chat.reaction.set','chat.decision.set', \
                                   'chat.follow.set','chat.feed.read.set') \
                 ORDER BY origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map(
                params![workspace_id, old_origin_id, first_old_origin_seq],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    let mut affected = BTreeSet::new();
    for (old_origin_seq, op_kind, payload_json) in suffix_ops {
        let payload: serde_json::Value =
            serde_json::from_str(&payload_json).map_err(SyncError::corrupt)?;
        let cell = chat_lww_cell(&op_kind, &payload).ok_or(SyncError::CoordinateDiverged)?;
        let new_origin_seq = old_origin_seq
            .checked_sub(first_old_origin_seq)
            .ok_or(SyncError::CoordinateDiverged)?;
        rebase_current_chat_projection(
            tx,
            workspace_id,
            old_origin_id,
            old_origin_seq,
            new_origin_id,
            new_origin_seq,
            &cell,
        )?;
        affected.insert(cell);
    }
    Ok(affected)
}

#[allow(clippy::too_many_arguments)]
fn rebase_current_chat_projection(
    tx: &Transaction<'_>,
    workspace_id: &str,
    old_origin_id: &str,
    old_origin_seq: i64,
    new_origin_id: &str,
    new_origin_seq: i64,
    cell: &ChatLwwCell,
) -> Result<(), SyncError> {
    match cell {
        ChatLwwCell::Reaction {
            message_id,
            emoji,
            author_id,
        } => tx.execute(
            "UPDATE chat_reactions SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 \
               AND message_id=?6 AND emoji=?7 AND author_id=?8",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                message_id,
                emoji,
                author_id
            ],
        ),
        ChatLwwCell::Decision { message_id } => tx.execute(
            "UPDATE chat_decisions SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 AND message_id=?6",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                message_id
            ],
        ),
        ChatLwwCell::Follow {
            owner_user_id,
            target_kind,
            target_id,
        } => tx.execute(
            "UPDATE chat_follows SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 \
               AND owner_user_id=?6 AND target_kind=?7 AND target_id=?8",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                owner_user_id,
                target_kind,
                target_id
            ],
        ),
        ChatLwwCell::FeedRead { owner_user_id } => tx.execute(
            "UPDATE chat_feed_read_state SET origin_id=?1,origin_seq=?2 \
             WHERE workspace_id=?3 AND origin_id=?4 AND origin_seq=?5 AND owner_user_id=?6",
            params![
                new_origin_id,
                new_origin_seq,
                workspace_id,
                old_origin_id,
                old_origin_seq,
                owner_user_id
            ],
        ),
    }
    .map_err(SyncError::persist)?;
    Ok(())
}

fn recompute_chat_projection_winners(
    tx: &Transaction<'_>,
    workspace_id: &str,
    new_origin_id: &str,
    affected: &BTreeSet<ChatLwwCell>,
) -> Result<(), SyncError> {
    if affected.is_empty() {
        return Ok(());
    }
    let raw_candidates = {
        let mut statement = tx
            .prepare(
                "SELECT origin_id,origin_seq,op_kind,payload_json,recorded_at_ms \
                 FROM replication_log WHERE workspace_id=?1 \
                   AND op_kind IN ('chat.reaction.set','chat.decision.set', \
                                   'chat.follow.set','chat.feed.read.set') \
                 ORDER BY origin_id,origin_seq",
            )
            .map_err(SyncError::corrupt)?;
        statement
            .query_map([workspace_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(SyncError::corrupt)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)?
    };
    for (origin_id, origin_seq, op_kind, payload_json, recorded_at_ms) in raw_candidates {
        let payload: serde_json::Value =
            serde_json::from_str(&payload_json).map_err(SyncError::corrupt)?;
        let Some(cell) = chat_lww_cell(&op_kind, &payload) else {
            continue;
        };
        if !affected.contains(&cell) {
            continue;
        }
        let operation = ReplicationEnvelope {
            workspace_id: workspace_id.to_owned(),
            origin_id,
            origin_seq,
            op_kind,
            payload,
            recorded_at_ms,
        };
        tx.execute_batch("SAVEPOINT dohc_recover_chat_lww")
            .map_err(SyncError::persist)?;
        match apply_chat_lww_projection_tx(tx, &operation) {
            Ok(()) => tx
                .execute_batch("RELEASE dohc_recover_chat_lww")
                .map_err(SyncError::persist)?,
            Err(error) => {
                tx.execute_batch(
                    "ROLLBACK TO dohc_recover_chat_lww; RELEASE dohc_recover_chat_lww",
                )
                .map_err(SyncError::persist)?;
                match error {
                    SyncError::InvalidInput { .. } if operation.origin_id != new_origin_id => {
                        continue;
                    }
                    SyncError::InvalidInput { .. } => {
                        return Err(SyncError::CoordinateDiverged);
                    }
                    error => return Err(error),
                }
            }
        }
    }
    Ok(())
}

fn preflight_collisions(
    store: &EngineStore,
    workspace_id: &str,
    local_origin_id: &str,
    ops: &[ReplicationEnvelope],
) -> Result<(), RelayError> {
    let diverged_is_local = store
        .read_with(|conn| {
            for op in ops {
                let existing = conn
                    .query_row(
                        "SELECT op_kind,payload_json,recorded_at_ms FROM replication_log \
                         WHERE workspace_id=?1 AND origin_id=?2 AND origin_seq=?3",
                        params![workspace_id, op.origin_id, op.origin_seq],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, i64>(2)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(SyncError::corrupt)?;
                let Some((op_kind, payload_json, recorded_at_ms)) = existing else {
                    continue;
                };
                let local_payload: serde_json::Value = match serde_json::from_str(&payload_json) {
                    Ok(payload) => payload,
                    Err(_) => return Ok(Some(op.origin_id == local_origin_id)),
                };
                if op_kind != op.op_kind
                    || recorded_at_ms != op.recorded_at_ms
                    || canonical_json_bytes(&local_payload)? != canonical_json_bytes(&op.payload)?
                {
                    return Ok(Some(op.origin_id == local_origin_id));
                }
            }
            Ok(None)
        })
        .map_err(local)?;
    match diverged_is_local {
        Some(true) => Err(RelayError::OriginDiverged),
        // Recovering the local origin cannot repair a conflicting imported
        // coordinate. Fail closed without rotating the unrelated local log.
        Some(false) => Err(RelayError::InvalidResponse),
        None => Ok(()),
    }
}

pub(crate) fn canonical_json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, SyncError> {
    #[cfg(test)]
    CANONICAL_JSON_CALLS.with(|calls| calls.set(calls.get() + 1));
    fn write_canonical(value: &serde_json::Value, output: &mut String) -> Result<(), SyncError> {
        match value {
            serde_json::Value::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    write_canonical(value, output)?;
                }
                output.push(']');
            }
            serde_json::Value::Object(object) => {
                let mut entries = object.iter().collect::<Vec<_>>();
                entries.sort_by_key(|(key, _)| *key);
                output.push('{');
                for (index, (key, value)) in entries.into_iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(
                        &serde_json::to_string(key).map_err(|_| SyncError::CoordinateDiverged)?,
                    );
                    output.push(':');
                    write_canonical(value, output)?;
                }
                output.push('}');
            }
            serde_json::Value::Number(number) => {
                output.push_str(&javascript_number(number)?);
            }
            scalar => {
                output.push_str(
                    &serde_json::to_string(scalar).map_err(|_| SyncError::CoordinateDiverged)?,
                );
            }
        }
        Ok(())
    }

    let mut output = String::new();
    write_canonical(value, &mut output)?;
    Ok(output.into_bytes())
}

#[cfg(test)]
thread_local! {
    static CANONICAL_JSON_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub(crate) fn take_canonical_json_call_count() -> usize {
    CANONICAL_JSON_CALLS.with(|calls| {
        let count = calls.get();
        calls.set(0);
        count
    })
}

fn javascript_number(number: &serde_json::Number) -> Result<String, SyncError> {
    let value = number.as_f64().ok_or(SyncError::CoordinateDiverged)?;
    if !value.is_finite() {
        return Err(SyncError::CoordinateDiverged);
    }
    if value == 0.0 {
        return Ok("0".to_owned());
    }

    let negative = value.is_sign_negative();
    let fixed = value.abs().to_string();
    let (integer, fractional) = fixed.split_once('.').unwrap_or((&fixed, ""));
    let mut raw = String::with_capacity(integer.len() + fractional.len());
    raw.push_str(integer);
    raw.push_str(fractional);
    let leading = raw.bytes().take_while(|byte| *byte == b'0').count();
    let decimal_position =
        i32::try_from(integer.len()).map_err(|_| SyncError::CoordinateDiverged)?;
    let leading = i32::try_from(leading).map_err(|_| SyncError::CoordinateDiverged)?;
    let exponent_position = decimal_position
        .checked_sub(leading)
        .ok_or(SyncError::CoordinateDiverged)?;
    let digits = raw[usize::try_from(leading).map_err(|_| SyncError::CoordinateDiverged)?..]
        .trim_end_matches('0');
    if digits.is_empty() {
        return Ok("0".to_owned());
    }

    let mut output = String::new();
    if negative {
        output.push('-');
    }
    if exponent_position > 0 && exponent_position <= 21 {
        let split =
            usize::try_from(exponent_position).map_err(|_| SyncError::CoordinateDiverged)?;
        if split >= digits.len() {
            output.push_str(digits);
            output.extend(std::iter::repeat_n('0', split - digits.len()));
        } else {
            output.push_str(&digits[..split]);
            output.push('.');
            output.push_str(&digits[split..]);
        }
    } else if exponent_position <= 0 && exponent_position > -6 {
        output.push_str("0.");
        let zeros =
            usize::try_from(-exponent_position).map_err(|_| SyncError::CoordinateDiverged)?;
        output.extend(std::iter::repeat_n('0', zeros));
        output.push_str(digits);
    } else {
        output.push(char::from(digits.as_bytes()[0]));
        if digits.len() > 1 {
            output.push('.');
            output.push_str(&digits[1..]);
        }
        let exponent = exponent_position
            .checked_sub(1)
            .ok_or(SyncError::CoordinateDiverged)?;
        output.push('e');
        if exponent >= 0 {
            output.push('+');
        }
        output.push_str(&exponent.to_string());
    }
    Ok(output)
}

fn merge_by_origin(ops: Vec<ReplicationEnvelope>) -> Vec<ReplicationEnvelope> {
    let mut queues = BTreeMap::<String, Vec<ReplicationEnvelope>>::new();
    for op in ops {
        queues.entry(op.origin_id.clone()).or_default().push(op);
    }
    for queue in queues.values_mut() {
        queue.sort_by_key(|op| op.origin_seq);
        queue.reverse();
    }
    let mut merged = Vec::new();
    loop {
        let best = queues
            .iter()
            .filter_map(|(origin, queue)| queue.last().map(|op| (origin.clone(), op)))
            .min_by(|(_, left), (_, right)| {
                (left.recorded_at_ms, &left.origin_id, left.origin_seq).cmp(&(
                    right.recorded_at_ms,
                    &right.origin_id,
                    right.origin_seq,
                ))
            })
            .map(|(origin, _)| origin);
        let Some(origin) = best else {
            break;
        };
        if let Some(op) = queues.get_mut(&origin).and_then(Vec::pop) {
            merged.push(op);
        }
    }
    merged
}

fn list_workspace_origins(
    store: &EngineStore,
    workspace_id: &str,
) -> Result<Vec<String>, SyncError> {
    store.read_with(|conn| {
        let mut statement = conn
            .prepare(
                "SELECT DISTINCT origin_id FROM replication_log \
                 WHERE workspace_id=?1 AND imported=0 ORDER BY origin_id",
            )
            .map_err(SyncError::corrupt)?;
        let rows = statement
            .query_map([workspace_id], |row| row.get(0))
            .map_err(SyncError::corrupt)?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SyncError::corrupt)
    })
}

fn local_max_origin_seq(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
) -> Result<i64, SyncError> {
    store.read_with(|conn| {
        conn.query_row(
            "SELECT COALESCE(MAX(origin_seq),-1) FROM replication_log \
             WHERE workspace_id=?1 AND origin_id=?2",
            params![workspace_id, origin_id],
            |row| row.get(0),
        )
        .map_err(SyncError::corrupt)
    })
}

fn validate_push_response(
    response: &PushResponse,
    batch: &[ReplicationEnvelope],
    local_max: i64,
) -> Result<(), RelayError> {
    let last = batch
        .last()
        .map(|op| op.origin_seq)
        .ok_or(RelayError::InvalidResponse)?;
    if response.accepted != batch.len()
        || response
            .inserted
            .checked_add(response.skipped)
            .is_none_or(|total| total != response.accepted)
        || !(-1..=crate::MAX_WIRE_INTEGER).contains(&response.current_max_origin_seq)
        || response.current_max_origin_seq < last
    {
        return Err(RelayError::InvalidResponse);
    }
    if response.current_max_origin_seq > local_max {
        return Err(RelayError::OriginDiverged);
    }
    Ok(())
}

fn validate_probe_response(response: &PushResponse) -> Result<(), RelayError> {
    if response.accepted != 0
        || response.inserted != 0
        || response.skipped != 0
        || !(-1..=crate::MAX_WIRE_INTEGER).contains(&response.current_max_origin_seq)
    {
        return Err(RelayError::InvalidResponse);
    }
    Ok(())
}

fn validate_pull_page(
    response: &PullResponse,
    workspace_id: &str,
    cursor: i64,
) -> Result<(), RelayError> {
    if response.ops.len() > crate::MAX_PULL_OPS
        || !(0..=crate::MAX_WIRE_INTEGER).contains(&response.next_cursor)
        || (!response.has_more && response.next_cursor < cursor)
    {
        return Err(RelayError::InvalidResponse);
    }
    if response.has_more && response.next_cursor <= cursor {
        return Err(RelayError::NoProgress);
    }
    for op in &response.ops {
        if op.workspace_id != workspace_id || op.validate().is_err() {
            return Err(RelayError::InvalidResponse);
        }
    }
    Ok(())
}

fn validate_share_page(
    ops: &[ShareReplicationEnvelope],
    next_cursor: i64,
    has_more: bool,
    cursor: i64,
) -> Result<(), RelayError> {
    if ops.len() > crate::MAX_PULL_OPS
        || !(0..=crate::MAX_WIRE_INTEGER).contains(&next_cursor)
        || next_cursor < cursor
        || (has_more && next_cursor <= cursor)
    {
        return Err(RelayError::InvalidResponse);
    }
    Ok(())
}

fn share_envelope(
    workspace_id: &str,
    op: ShareReplicationEnvelope,
) -> Result<ReplicationEnvelope, RelayError> {
    let envelope = ReplicationEnvelope {
        workspace_id: workspace_id.to_owned(),
        origin_id: op.origin_id,
        origin_seq: op.origin_seq,
        op_kind: op.op_kind,
        payload: op.payload,
        recorded_at_ms: op.recorded_at_ms,
    };
    envelope
        .validate()
        .map_err(|_| RelayError::InvalidResponse)?;
    Ok(envelope)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SharedPushState {
    scanned_seq: i64,
    dense_seq: Option<i64>,
}

fn read_shared_push_state(
    store: &EngineStore,
    workspace_id: &str,
    share_id: &str,
) -> Result<SharedPushState, RelayError> {
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT pushed_seq,dense_seq FROM shared_channel_push_state \
                 WHERE workspace_id=?1 AND share_id=?2",
                params![workspace_id, share_id],
                |row| {
                    Ok(SharedPushState {
                        scanned_seq: row.get(0)?,
                        dense_seq: row.get(1)?,
                    })
                },
            )
            .optional()
            .map(|value| {
                value.unwrap_or(SharedPushState {
                    scanned_seq: -1,
                    dense_seq: Some(-1),
                })
            })
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn write_shared_push_state(
    store: &mut EngineStore,
    workspace_id: &str,
    share_id: &str,
    scanned_seq: i64,
    dense_seq: i64,
    faults: &dyn FaultInjector,
) -> Result<(), RelayError> {
    if !(-1..=crate::MAX_WIRE_INTEGER).contains(&scanned_seq)
        || !(-1..=crate::MAX_WIRE_INTEGER).contains(&dense_seq)
    {
        return Err(RelayError::InvalidResponse);
    }
    let outcome = store
        .write_with(faults, |tx| {
            tx.execute(
                "INSERT INTO shared_channel_push_state \
                 (workspace_id,share_id,pushed_seq,dense_seq) VALUES (?1,?2,?3,?4) \
                 ON CONFLICT(workspace_id,share_id) DO UPDATE SET \
                 pushed_seq=excluded.pushed_seq,dense_seq=excluded.dense_seq",
                params![workspace_id, share_id, scanned_seq, dense_seq],
            )
            .map_err(SyncError::persist)?;
            Ok::<(), SyncError>(())
        })
        .map_err(local)?;
    if matches!(outcome, TxnOutcome::Crashed { .. }) {
        return Err(RelayError::Local("injected-crash".to_owned()));
    }
    Ok(())
}

fn shared_dense_seq_through(
    store: &EngineStore,
    workspace_id: &str,
    origin_id: &str,
    channel_wire_id: &str,
    scanned_seq: i64,
) -> Result<i64, RelayError> {
    let mut dense_seq = -1_i64;
    let mut after = -1_i64;
    while after < scanned_seq {
        let page = list_replication_ops(store, workspace_id, origin_id, after, crate::MAX_PULL_OPS)
            .map_err(local)?;
        let Some(page_last) = page.last().map(|op| op.origin_seq) else {
            break;
        };
        for op in page {
            if op.origin_seq > scanned_seq {
                return Ok(dense_seq);
            }
            if shared_channel_op_allowed(store, workspace_id, channel_wire_id, &op)? {
                dense_seq = dense_seq
                    .checked_add(1)
                    .ok_or(RelayError::InvalidResponse)?;
            }
        }
        after = page_last;
    }
    Ok(dense_seq)
}

fn shared_channel_op_allowed(
    store: &EngineStore,
    workspace_id: &str,
    channel_wire_id: &str,
    op: &ReplicationEnvelope,
) -> Result<bool, RelayError> {
    if op.op_kind == "chat.channel.create" {
        return Ok(
            op.payload.get("wireId").and_then(serde_json::Value::as_str) == Some(channel_wire_id)
        );
    }
    if op.op_kind == "chat.thread.create" {
        return Ok(op
            .payload
            .get("channelWireId")
            .and_then(serde_json::Value::as_str)
            == Some(channel_wire_id));
    }
    if !matches!(
        op.op_kind.as_str(),
        "chat.message.append" | "chat.decision.set" | "chat.attachment.add" | "chat.reaction.set"
    ) {
        return Ok(false);
    }
    let Some(thread_id) = op
        .payload
        .get("threadId")
        .and_then(serde_json::Value::as_str)
    else {
        return Ok(false);
    };
    store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_threads t \
                 JOIN chat_channel_wire_ids w \
                   ON w.workspace_id=t.workspace_id AND w.channel_id=t.channel_id \
                 WHERE t.workspace_id=?1 AND t.thread_id=?2 AND w.wire_id=?3)",
                params![workspace_id, thread_id, channel_wire_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .map_err(local)
}

fn replay_id(share_id: &str, envelope: &ReplicationEnvelope, action: &str, path: &str) -> String {
    let mut hash = Sha256::new();
    for value in [
        share_id.as_bytes(),
        envelope.origin_id.as_bytes(),
        envelope.origin_seq.to_string().as_bytes(),
        action.as_bytes(),
        path.as_bytes(),
    ] {
        hash.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_le_bytes());
        hash.update(value);
    }
    hex_sha256(&hash.finalize())
}

struct ShareViewReplayContext<'a, T> {
    transport: &'a T,
    store: &'a mut EngineStore,
    workspace_id: &'a str,
    share_id: &'a str,
    faults: &'a dyn FaultInjector,
    applied: &'a mut usize,
    changed: &'a mut BTreeMap<String, ShareViewChangedPath>,
}

fn replay_share_view_op<T: RelayTransport>(
    context: &mut ShareViewReplayContext<'_, T>,
    envelope: &ReplicationEnvelope,
) -> Result<(), RelayError> {
    let main_version_id = {
        let mut versioned = VersionedTextStore::new(&mut *context.store);
        versioned
            .ensure_main_version(
                context.workspace_id,
                "main",
                envelope.recorded_at_ms,
                context.faults,
            )
            .map_err(domain)?
            .version_id
    };
    if envelope.op_kind == "moment.append" {
        let operation = string_field(&envelope.payload, "operation");
        let path = string_field(&envelope.payload, "path");
        match operation {
            Some("delete") => {
                if let Some(path) = path {
                    replay_share_delete(
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        path,
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                    )?;
                }
            }
            Some("rename") => {
                let before = string_field(&envelope.payload, "payloadBeforePath");
                let after = string_field(&envelope.payload, "payloadAfterPath").or(path);
                let sha = string_field(&envelope.payload, "payloadAfterBlobSha256");
                if let (Some(before), Some(after), Some(sha)) = (before, after, sha) {
                    replay_share_write(
                        context.transport,
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        after,
                        sha,
                        content_kind_name(envelope.payload.get("payloadAfterContentKind")),
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                    )?;
                    if before != after {
                        replay_share_delete(
                            &mut *context.store,
                            context.workspace_id,
                            &main_version_id,
                            context.share_id,
                            envelope,
                            before,
                            context.faults,
                            &mut *context.applied,
                            &mut *context.changed,
                        )?;
                    }
                }
            }
            Some("write") => {
                let after = string_field(&envelope.payload, "payloadAfterPath").or(path);
                let sha = string_field(&envelope.payload, "payloadAfterBlobSha256");
                if let (Some(after), Some(sha)) = (after, sha) {
                    replay_share_write(
                        context.transport,
                        &mut *context.store,
                        context.workspace_id,
                        &main_version_id,
                        context.share_id,
                        envelope,
                        after,
                        sha,
                        content_kind_name(envelope.payload.get("payloadAfterContentKind")),
                        context.faults,
                        &mut *context.applied,
                        &mut *context.changed,
                    )?;
                }
            }
            _ => {}
        }
    } else if envelope.op_kind == "version.create" {
        for snapshot in envelope
            .payload
            .get("forkSnapshots")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
        {
            let path = string_field(snapshot, "path");
            let sha = string_field(snapshot, "blobSha256");
            if let (Some(path), Some(sha)) = (path, sha) {
                replay_share_write(
                    context.transport,
                    &mut *context.store,
                    context.workspace_id,
                    &main_version_id,
                    context.share_id,
                    envelope,
                    path,
                    sha,
                    content_kind_name(snapshot.get("contentKind")),
                    context.faults,
                    &mut *context.applied,
                    &mut *context.changed,
                )?;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn replay_share_write<T: RelayTransport>(
    transport: &T,
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    share_id: &str,
    envelope: &ReplicationEnvelope,
    path: &str,
    sha256: &str,
    content_kind: &'static str,
    faults: &dyn FaultInjector,
    applied: &mut usize,
    changed: &mut BTreeMap<String, ShareViewChangedPath>,
) -> Result<(), RelayError> {
    if !valid_sha256(sha256) {
        return Err(RelayError::BlobInvalid);
    }
    let key = replay_id(share_id, envelope, "write", path);
    let request_id = format!("share-view:{key}");
    let already_applied = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM engine_requests WHERE request_id=?1)",
                [&request_id],
                |row| row.get(0),
            )
            .map_err(SyncError::corrupt)
        })
        .map_err(local)?;
    if already_applied {
        changed.insert(
            path.to_owned(),
            ShareViewChangedPath {
                path: path.to_owned(),
                operation: "write",
                content_kind,
            },
        );
        return Ok(());
    }
    let bytes = transport
        .share_blob(ShareBlobRequest {
            share_id: share_id.to_owned(),
            sha256: sha256.to_owned(),
        })?
        .bytes;
    if hex_sha256(&bytes) != sha256 {
        return Err(RelayError::BlobInvalid);
    }
    let deduped = {
        let mut versioned = VersionedTextStore::new(store);
        if content_kind == "binary" {
            versioned
                .write_binary(
                    &WriteBinary {
                        workspace_id: workspace_id.to_owned(),
                        version_id: version_id.to_owned(),
                        object_id: format!("object-share-{key}"),
                        path: path.to_owned(),
                        bytes,
                        moment_id: format!("moment-share-{key}"),
                        metadata_origin: "sync".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: envelope.recorded_at_ms,
                        request_id: Some(request_id.clone()),
                    },
                    faults,
                )
                .map_err(domain)?
                .deduped
        } else {
            let text = String::from_utf8(bytes).map_err(|_| RelayError::BlobInvalid)?;
            versioned
                .write_text(
                    &WriteText {
                        workspace_id: workspace_id.to_owned(),
                        version_id: version_id.to_owned(),
                        object_id: format!("object-share-{key}"),
                        path: path.to_owned(),
                        text,
                        moment_id: format!("moment-share-{key}"),
                        metadata_origin: "sync".to_owned(),
                        metadata_summary: None,
                        metadata_correlation_id: None,
                        author_json: None,
                        now_ms: envelope.recorded_at_ms,
                        request_id: Some(request_id),
                    },
                    faults,
                )
                .map_err(domain)?
                .deduped
        }
    };
    if !deduped {
        *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
    }
    changed.insert(
        path.to_owned(),
        ShareViewChangedPath {
            path: path.to_owned(),
            operation: "write",
            content_kind,
        },
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn replay_share_delete(
    store: &mut EngineStore,
    workspace_id: &str,
    version_id: &str,
    share_id: &str,
    envelope: &ReplicationEnvelope,
    path: &str,
    faults: &dyn FaultInjector,
    applied: &mut usize,
    changed: &mut BTreeMap<String, ShareViewChangedPath>,
) -> Result<(), RelayError> {
    let existing_kind = store
        .read_with(|conn| {
            conn.query_row(
                "SELECT s.content_kind FROM path_aliases a \
                 JOIN snapshots s ON s.workspace_id=a.workspace_id \
                   AND s.version_id=a.version_id AND s.object_id=a.object_id \
                 WHERE a.workspace_id=?1 AND a.version_id=?2 AND a.path=?3",
                params![workspace_id, version_id, path],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(SyncError::corrupt)
        })
        .map_err(local)?
        .flatten();
    let Some(existing_kind) = existing_kind else {
        changed.insert(
            path.to_owned(),
            ShareViewChangedPath {
                path: path.to_owned(),
                operation: "delete",
                content_kind: "text",
            },
        );
        return Ok(());
    };
    let key = replay_id(share_id, envelope, "delete", path);
    let result = {
        let mut versioned = VersionedTextStore::new(store);
        versioned.delete_text_file(
            &DeleteTextFile {
                workspace_id: workspace_id.to_owned(),
                version_id: version_id.to_owned(),
                path: path.to_owned(),
                moment_id: format!("moment-share-{key}"),
                request_id: Some(format!("share-view:{key}")),
                metadata_origin: "sync".to_owned(),
                metadata_summary: None,
                metadata_correlation_id: None,
                author_json: None,
                now_ms: envelope.recorded_at_ms,
            },
            faults,
        )
    };
    match result {
        Ok(value) => {
            if !value.deduped {
                *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            }
        }
        Err(DomainError::FileNotFound) => {}
        Err(error) => return Err(domain(error)),
    }
    changed.insert(
        path.to_owned(),
        ShareViewChangedPath {
            path: path.to_owned(),
            operation: "delete",
            content_kind: if existing_kind == "binary" {
                "binary"
            } else {
                "text"
            },
        },
    );
    Ok(())
}

fn string_field<'a>(value: &'a serde_json::Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(serde_json::Value::as_str)
}

fn content_kind_name(value: Option<&serde_json::Value>) -> &'static str {
    if value.and_then(serde_json::Value::as_str) == Some("binary") {
        "binary"
    } else {
        "text"
    }
}

fn domain(error: DomainError) -> RelayError {
    RelayError::Local(error.code().to_owned())
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
    changed_paths: &mut BTreeMap<String, crate::MomentMaterializationChange>,
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
            for change in routed.materialization_changes {
                changed_paths.insert(change.path.clone(), change);
            }
            for change in
                crate::router::redelivered_materialization_changes(store, op).map_err(local)?
            {
                changed_paths.insert(change.path.clone(), change);
            }
            *applied = applied.checked_add(1).ok_or(RelayError::InvalidResponse)?;
        }
        ApplyOutcome::Refused(refusal) => {
            *refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
            push_refusal_once(refusals, refusal);
        }
        ApplyOutcome::Skipped => {
            *conflicts_opened = conflicts_opened
                .checked_add(crate::router::redelivered_conflicts_opened(store, op).map_err(local)?)
                .ok_or(RelayError::InvalidResponse)?;
            if let Some(refusal) = crate::apply::read_replayed_refusal(store, op).map_err(local)? {
                push_refusal_once(refusals, refusal);
            }
            if let Some(pending) =
                crate::conflict_apply::read_replayed_pending_resolve(store, op).map_err(local)?
            {
                pending_resolves.push(pending);
            }
            for change in
                crate::router::redelivered_materialization_changes(store, op).map_err(local)?
            {
                changed_paths.insert(change.path.clone(), change);
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

fn push_shared_channel_rejection(
    refused: &mut usize,
    rejections: &mut Vec<SharedChannelRejection>,
    refusal: crate::ReplicationRefusal,
) -> Result<(), RelayError> {
    *refused = refused.checked_add(1).ok_or(RelayError::InvalidResponse)?;
    rejections.push(SharedChannelRejection {
        origin_id: refusal.origin_id,
        origin_seq: refusal.origin_seq,
        op_kind: refusal.op_kind,
        reason: refusal.reason.message().to_owned(),
    });
    Ok(())
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
